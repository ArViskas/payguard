import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Journal } from './journal.mjs';
import { Fault, validateIntent, evaluate, fingerprint, mintGrant, policyFor, TTL } from './core.mjs';
import { body, send, listen, equal, rpc } from './http.mjs';

export class Gateway {
  constructor({ policy, journal, privateKey, execute, refresh }) {
    this.policy = policy; this.journal = journal; this.privateKey = privateKey; this.executeProvider = execute; this.refreshProvider = refresh;
    this.requests = new Map();
    for (const e of journal.events) if (e.data.request) this.requests.set(e.requestId, e.data.request);
    // A crash during I/O cannot release a reservation or silently retry a payment.
    for (const r of this.requests.values()) if (r.status === 'executing') this.record('execution_interrupted', 'gateway', { ...r, status: 'reconciliation_required', error: 'Interrupted execution. Refresh to recover a recorded receipt; do not resubmit.' });
  }
  record(type, actor, request) {
    this.journal.append(type, actor, request.id, { request });
    this.requests.set(request.id, request);
    return request;
  }
  submit(input, extraction = { provider: 'structured', model: 'Direct structured intent' }) {
    const intent = validateIntent(input), fp = fingerprint(intent);
    const duplicate = [...this.requests.values()].some(r => !['denied', 'rejected'].includes(r.status) && fingerprint(r.intent) === fp);
    const evaluation = evaluate(intent, this.policy, duplicate);
    const now = Date.now();
    const request = { id: randomUUID(), intent, evaluation, extraction, status: 'proposed', createdAt: new Date(now).toISOString(), expiresAt: now + TTL };
    this.record('intent_proposed', 'agent', request);
    return this.record('policy_evaluated', 'gateway', { ...request, status: { deny: 'denied', allow: 'allowed', require_approval: 'pending_approval' }[evaluation.decision] });
  }
  get(id) {
    const r = this.requests.get(id);
    if (!r) throw new Fault(404, 'Request not found.');
    return r;
  }
  review(id, approve) {
    const r = this.get(id);
    if (r.status !== 'pending_approval') throw new Fault(409, 'Only pending requests can be reviewed.');
    if (r.expiresAt <= Date.now()) throw new Fault(403, 'Request expired. Reject it and propose a new invoice if appropriate.');
    return this.record(approve ? 'human_approved' : 'human_rejected', 'human', { ...r, status: approve ? 'approved' : 'rejected', reviewedAt: new Date().toISOString() });
  }
  reject(id) {
    const r = this.get(id);
    if (r.status !== 'pending_approval') throw new Fault(409, 'Only pending requests can be rejected.');
    return this.record('human_rejected', 'human', { ...r, status: 'rejected', reviewedAt: new Date().toISOString() });
  }
  async execute(id) {
    const r = this.get(id);
    const authorization = mintGrant(r, this.privateKey);
    // Transition and fsync synchronously before first await to prevent double clicks.
    this.record('authorization_issued', 'gateway', { ...r, status: 'executing' });
    try {
      const result = await this.executeProvider({ intent: r.intent, authorization });
      return this.record('payment_result', 'executor', { ...this.get(id), status: result.state, receipt: result.receipt, error: result.error, senderBatchId: id });
    } catch (error) {
      return this.record('execution_uncertain', 'gateway', { ...this.get(id), status: 'reconciliation_required', senderBatchId: id,
        error: error instanceof Fault ? error.message : 'Executor connection interrupted. Refresh the recorded result; do not resubmit.' });
    }
  }
  async refresh(id) {
    const r = this.get(id);
    if (!['submitted', 'simulated', 'reconciliation_required'].includes(r.status)) throw new Fault(409, 'No execution to refresh.');
    const result = await this.refreshProvider(id);
    return this.record('payment_status_checked', 'executor', { ...this.get(id), status: result.state, receipt: result.receipt, error: result.error });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const config = process.env;
  const gateway = new Gateway({ policy: policyFor(config.RECIPIENT_EMAIL), journal: new Journal(`${config.GATEWAY_DATA_DIR}/audit.jsonl`),
    privateKey: config.GRANT_PRIVATE_KEY,
    execute: data => rpc(`${config.EXECUTOR_URL}/execute`, config.EXECUTOR_SERVICE_TOKEN, data),
    refresh: id => rpc(`${config.EXECUTOR_URL}/status/${id}`, config.EXECUTOR_SERVICE_TOKEN, null, 'GET') });
  const sessions = new Map(), limits = new Map();
  function rate(key, maximum) {
    const now = Date.now(), item = limits.get(key);
    const next = !item || item.until <= now ? { count: 0, until: now + 60000 } : item;
    next.count++; limits.set(key, next);
    if (next.count > maximum) throw new Fault(429, 'Too many requests. Wait one minute and try again.');
  }
  function authenticated(req) {
    const token = req.headers.cookie?.match(/(?:^|;\s*)pg_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const expiry = token && sessions.get(token);
    if (expiry && expiry > Date.now()) return true;
    if (token) sessions.delete(token);
    return false;
  }
  function operator(req) { if (!authenticated(req)) throw new Fault(401, 'Unlock human review with the operator passphrase.'); }
  let listeningPort;
  listen(async (req, res) => {
    const expectedHost = `127.0.0.1:${listeningPort}`;
    if (req.headers.host !== expectedHost) throw new Fault(403, 'Use the loopback URL printed at startup.');
    const url = new URL(req.url, `http://${expectedHost}`);
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${expectedHost}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new Fault(403, 'Cross-origin action refused.');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, {
      requests: [...gateway.requests.values()].reverse(), audit: gateway.journal.events.slice(-300).reverse(),
      auditCount: gateway.journal.events.length, auditDigest: gateway.journal.events.at(-1)?.digest || 'GENESIS', policy: gateway.policy,
      operator: authenticated(req), paymentProvider: config.PAYMENT_PROVIDER, aiProvider: config.AI_PROVIDER,
      model: config.AI_PROVIDER === 'ollama' ? config.OLLAMA_MODEL : 'Deterministic demo parser',
      boundary: { agent: 'Intent only · no payment credentials', gateway: 'Policy + private signing key', executor: 'Verification + sandbox credentials' }
    });
    if (req.method === 'GET' && url.pathname === '/api/audit/export') {
      operator(req);
      return send(res, 200, { format: 'payguard-audit-v1', gateway: gateway.journal.events }, { 'Content-Disposition': 'attachment; filename="payguard-audit.json"' });
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      rate('login', 5);
      const data = await body(req);
      if (!equal(data.pin, config.OPERATOR_PIN)) throw new Fault(401, 'Incorrect operator passphrase.');
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 30 * 60 * 1000);
      return send(res, 200, { authenticated: true }, { 'Set-Cookie': `pg_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800` });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = req.headers.cookie?.match(/pg_session=([a-f0-9]{64})/)?.[1];
      if (token) sessions.delete(token);
      return send(res, 200, { authenticated: false }, { 'Set-Cookie': 'pg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (req.method === 'POST' && url.pathname === '/api/requests') {
      rate('propose', 30);
      const data = await body(req);
      let extraction;
      if (typeof data.prompt === 'string') extraction = await rpc(`${config.AGENT_URL}/propose`, config.AGENT_SERVICE_TOKEN, { prompt: data.prompt });
      else if (data.intent) extraction = { intent: data.intent, provider: 'structured', model: 'Direct structured intent' };
      else throw new Fault(400, 'Provide a prompt or a structured intent.');
      return send(res, 201, gateway.submit(extraction.intent, { provider: extraction.provider, model: extraction.model }));
    }
    const action = url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})\/(approve|reject|execute|refresh)$/);
    if (req.method === 'POST' && action) {
      operator(req); await body(req); // Bodies never replace stored payment terms.
      const [, id, kind] = action;
      let result;
      if (kind === 'approve') result = gateway.review(id, true);
      if (kind === 'reject') result = gateway.reject(id);
      if (kind === 'execute') result = await gateway.execute(id);
      if (kind === 'refresh') result = await gateway.refresh(id);
      return send(res, 200, result);
    }
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/mark.svg': ['mark.svg', 'image/svg+xml'] };
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
    }
    throw new Fault(404, 'Route not found.');
  }, Number(config.PORT), port => { listeningPort = port; });
}
