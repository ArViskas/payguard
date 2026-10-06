import { pathToFileURL } from 'node:url';
import { Journal } from './journal.mjs';
import { Fault, validateIntent, verifyGrant, fingerprint, policyFor } from './core.mjs';
import { body, send, listen, bearer } from './http.mjs';
import { PayPalSandbox, DemoPayments } from './paypal.mjs';

export class Executor {
  constructor({ publicKey, policy, journal, provider }) {
    this.publicKey = publicKey; this.policy = policy; this.journal = journal; this.provider = provider;
    this.used = new Set(); this.invoices = new Set(); this.records = new Map();
    for (const e of journal.events) {
      if (e.type === 'execution_reserved') { this.used.add(e.requestId); this.used.add(e.data.jti); this.invoices.add(e.data.fingerprint); this.records.set(e.requestId, { state: 'reconciliation_required', senderBatchId: e.requestId }); }
      if (['execution_result', 'execution_refreshed', 'execution_error'].includes(e.type)) this.records.set(e.requestId, e.data);
    }
  }
  async execute(data) {
    const intent = validateIntent(data.intent);
    const grant = verifyGrant(data.authorization, intent, this.publicKey, this.policy);
    if (this.used.has(grant.requestId) || this.used.has(grant.jti) || this.invoices.has(fingerprint(intent))) throw new Fault(409, 'Authorization or invoice has already been consumed.');
    this.journal.append('execution_reserved', 'executor', grant.requestId, { jti: grant.jti, fingerprint: fingerprint(intent), intentHash: grant.intentHash });
    this.used.add(grant.requestId); this.used.add(grant.jti); this.invoices.add(fingerprint(intent));
    this.records.set(grant.requestId, { state: 'reconciliation_required', senderBatchId: grant.requestId });
    try {
      const receipt = await this.provider.create(intent, grant.requestId);
      const result = { state: receipt.provider === 'demo' ? 'simulated' : 'submitted', receipt };
      this.journal.append('execution_result', 'executor', grant.requestId, result);
      this.records.set(grant.requestId, result);
      return result;
    } catch (error) {
      const result = { state: 'reconciliation_required', senderBatchId: grant.requestId, error: error instanceof Fault ? error.message : 'Execution could not be recorded. Preserve records; do not resend.' };
      this.journal.append('execution_error', 'executor', grant.requestId, result);
      this.records.set(grant.requestId, result);
      return result;
    }
  }
  async refresh(requestId) {
    const known = this.records.get(requestId);
    if (!known) throw new Fault(404, 'Unknown execution.');
    if (known.receipt?.provider !== 'paypal-sandbox') return known;
    const result = { state: 'submitted', receipt: await this.provider.status(known.receipt.batchId, requestId) };
    this.journal.append('execution_refreshed', 'executor', requestId, result);
    this.records.set(requestId, result);
    return result;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const executor = new Executor({ publicKey: process.env.GRANT_PUBLIC_KEY, policy: policyFor(process.env.RECIPIENT_EMAIL),
    journal: new Journal(`${process.env.EXECUTOR_DATA_DIR}/ledger.jsonl`), provider: process.env.PAYMENT_PROVIDER === 'paypal-sandbox'
      ? new PayPalSandbox({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET }) : new DemoPayments() });
  listen(async (req, res) => {
    bearer(req, process.env.EXECUTOR_SERVICE_TOKEN);
    if (req.method === 'POST' && req.url === '/execute') return send(res, 200, await executor.execute(await body(req)));
    const match = req.url.match(/^\/status\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && match) return send(res, 200, await executor.refresh(match[1]));
    throw new Fault(404, 'Unknown executor route.');
  });
}
