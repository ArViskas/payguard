import { Fault, hash } from './core.mjs';
export const SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';

export function reconcileSandboxPayout(data, request) {
  const header = data?.batch_header, item = data?.items?.[0], terms = item?.payout_item;
  const checks = {
    batchId: header?.payout_batch_id === request.receipt.batchId,
    senderBatchId: header?.sender_batch_header?.sender_batch_id === request.id,
    singleItem: Array.isArray(data?.items) && data.items.length === 1 && (data.total_items === undefined || data.total_items === 1),
    senderItemId: terms?.sender_item_id === request.id,
    recipient: typeof terms?.receiver === 'string' && terms.receiver.toLowerCase() === request.intent.recipient,
    recipientType: terms?.recipient_type === 'EMAIL',
    amount: terms?.amount?.value === request.intent.amount,
    currency: terms?.amount?.currency === request.intent.currency
  };
  if (Object.values(checks).some(pass => !pass)) throw new Fault(502, 'Independent sandbox payout reconciliation did not match the recorded payment terms. No retry is permitted.');
  if (!/^[A-Z_]{1,40}$/.test(header.batch_status) || !/^[A-Z_]{1,40}$/.test(item.transaction_status) ||
      !/^[A-Za-z0-9]{1,64}$/.test(item.payout_item_id)) throw new Fault(502, 'Independent sandbox payout status was invalid.');
  return { provider: 'paypal-sandbox', origin: SANDBOX_ORIGIN, requestId: request.id, reference: request.intent.reference,
    amount: request.intent.amount, currency: request.intent.currency, recipientHash: hash(request.intent.recipient),
    batchId: header.payout_batch_id, batchStatus: header.batch_status, itemId: item.payout_item_id,
    itemStatus: item.transaction_status, checks, settled: header.batch_status === 'SUCCESS' && item.transaction_status === 'SUCCESS',
    observedAt: new Date().toISOString(), independentApiRead: true };
}

export class PayPalSandbox {
  constructor({ clientId, clientSecret }, fetcher = fetch) { this.clientId = clientId; this.clientSecret = clientSecret; this.fetcher = fetcher; }
  async token() {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.token;
    const result = await this.call('/v1/oauth2/token', { method: 'POST', headers: {
      Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (typeof result.access_token !== 'string' || !result.access_token || result.token_type !== 'Bearer' ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Fault(502, 'PayPal sandbox returned an invalid OAuth response.');
    this.cached = { token: result.access_token, expires: Date.now() + Math.max(0, result.expires_in - 60) * 1000,
      expiresInSeconds: result.expires_in, payoutsScopePresent: typeof result.scope === 'string' && result.scope.split(/\s+/).includes('https://uri.paypal.com/payments/payouts') };
    return result.access_token;
  }
  async verifyOAuth() {
    await this.token();
    // Explicit allowlist: never persist the token, app ID, nonce or raw response.
    return { provider: 'paypal-sandbox', origin: SANDBOX_ORIGIN, authenticated: true,
      payoutsScopePresent: this.cached.payoutsScopePresent, expiresInSeconds: this.cached.expiresInSeconds,
      observedAt: new Date().toISOString(), payoutAttempted: false };
  }
  async call(path, options) {
    let response;
    try { response = await this.fetcher(SANDBOX_ORIGIN + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Fault(502, 'PayPal sandbox network result is uncertain. Do not resend; reconcile the preserved batch reference.'); }
    let data;
    try { data = await response.json(); } catch { throw new Fault(502, 'PayPal sandbox returned an unreadable response. Manual reconciliation required.'); }
    if (!response.ok) {
      const code = ['invalid_client', 'invalid_request', 'unsupported_grant_type'].includes(data.error) ? data.error :
        typeof data.name === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.name) ? data.name : 'API_ERROR';
      // Never return raw provider bodies, debug headers, OAuth tokens or credentials.
      throw new Fault(502, `PayPal sandbox refused the operation (${response.status}, ${code}). Review sandbox permissions, funding and the preserved batch reference.`);
    }
    return data;
  }
  async create(intent, requestId) {
    const token = await this.token();
    const data = await this.call('/v1/payments/payouts', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId },
      body: JSON.stringify({ sender_batch_header: { sender_batch_id: requestId, email_subject: 'Your PayGuard sandbox payout' }, items: [{
        recipient_type: 'EMAIL', amount: { value: intent.amount, currency: intent.currency }, receiver: intent.recipient,
        note: intent.purpose, sender_item_id: requestId
      }] }) });
    return this.receipt(data, requestId);
  }
  async status(batchId, requestId) {
    if (!/^[A-Za-z0-9]{1,64}$/.test(batchId)) throw new Fault(400, 'Invalid batch identifier.');
    return this.receipt(await this.call(`/v1/payments/payouts/${batchId}`, { method: 'GET', headers: { Authorization: `Bearer ${await this.token()}` } }), requestId);
  }
  receipt(data, requestId) {
    const h = data.batch_header;
    if (!h || !/^[A-Za-z0-9]{1,64}$/.test(h.payout_batch_id) || typeof h.batch_status !== 'string') throw new Fault(502, 'Invalid sandbox payout response. Preserve the batch reference for reconciliation.');
    return { provider: 'paypal-sandbox', environment: 'sandbox', batchId: h.payout_batch_id, batchStatus: h.batch_status.slice(0,40),
      itemStatus: data.items?.[0]?.transaction_status?.slice(0,40) || 'NOT_YET_REPORTED', senderBatchId: requestId,
      observedAt: new Date().toISOString() };
  }
}
export class DemoPayments {
  async create(intent, requestId) { return { provider: 'demo', environment: 'simulation', batchId: `SIM-${requestId.slice(0,8)}`,
    batchStatus: 'SIMULATED', itemStatus: 'SIMULATED', senderBatchId: requestId, observedAt: new Date().toISOString() }; }
}
