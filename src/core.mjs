import { createHash, sign, verify, randomUUID } from 'node:crypto';

export class Fault extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const POLICY_VERSION = 'payguard-v1';
export const TTL = 5 * 60 * 1000;
export function policyFor(email) {
  return Object.freeze({ version: POLICY_VERSION, currency: 'USD', maxCents: 50000, approvalCents: 5000,
    recipients: email ? [email.toLowerCase()] : ['alex@example.test', 'tools@example.test'], categories: ['contractor', 'software'], ttl: TTL });
}
export function validateIntent(value) {
  const fields = ['amount', 'currency', 'recipient', 'category', 'reference', 'purpose'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== fields.length || fields.some(k => typeof value[k] !== 'string'))
    throw new Fault(400, 'Intent must contain exactly amount, currency, recipient, category, reference and purpose as strings.');
  if (!/^(0|[1-9]\d{0,5})\.\d{2}$/.test(value.amount) || Number(value.amount) <= 0) throw new Fault(400, 'Amount must be positive, with exactly two decimal places.');
  if (!/^[A-Z]{3}$/.test(value.currency)) throw new Fault(400, 'Currency must be a three-letter uppercase code.');
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value.recipient) || value.recipient.length > 127) throw new Fault(400, 'A valid recipient email is required.');
  if (!/^[a-z]{2,24}$/.test(value.category)) throw new Fault(400, 'Category must contain lowercase letters.');
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(value.reference)) throw new Fault(400, 'Invoice reference must be 3–64 letters, numbers, underscores or dashes.');
  if (value.purpose.trim().length < 3 || value.purpose.length > 240 || /[\x00-\x1f]/.test(value.purpose)) throw new Fault(400, 'Purpose must be 3–240 readable characters.');
  return Object.freeze({ amount: value.amount, currency: value.currency, recipient: value.recipient.toLowerCase(), category: value.category,
    reference: value.reference.toUpperCase(), purpose: value.purpose.trim() });
}
export const cents = intent => Number(intent.amount.replace('.', ''));
// Invoice identity excludes amount and purpose: editing either cannot bypass duplicate detection.
export const fingerprint = intent => hash([intent.recipient, intent.reference]);
export function evaluate(intent, policy, duplicate = false) {
  const checks = [
    { rule: 'Currency', pass: intent.currency === policy.currency, detail: 'USD only' },
    { rule: 'Amount limit', pass: cents(intent) <= policy.maxCents, detail: 'Maximum $500.00 per action' },
    { rule: 'Recipient allowlist', pass: policy.recipients.includes(intent.recipient), detail: policy.recipients.includes(intent.recipient) ? 'Verified recipient' : 'Recipient is not approved' },
    { rule: 'Purpose category', pass: policy.categories.includes(intent.category), detail: 'Contractor or software payments' },
    { rule: 'Duplicate invoice', pass: !duplicate, detail: duplicate ? 'This recipient and invoice are already reserved' : 'No matching recipient and invoice' },
    { rule: 'Human review', pass: true, review: cents(intent) > policy.approvalCents, detail: cents(intent) > policy.approvalCents ? 'Above $50.00: explicit human approval required' : '$50.00 or less: policy allows payment' }
  ];
  const decision = checks.some(c => !c.pass) ? 'deny' : cents(intent) > policy.approvalCents ? 'require_approval' : 'allow';
  return { decision, checks, version: policy.version };
}
export function mintGrant(request, privateKey, now = Date.now()) {
  if (!['allowed', 'approved'].includes(request.status) || request.expiresAt <= now) throw new Fault(403, 'No current authorization for this request.');
  const grant = { audience: 'payguard-executor', environment: 'sandbox', policyVersion: POLICY_VERSION,
    requestId: request.id, jti: randomUUID(), issuedAt: now, expiresAt: Math.min(now + TTL, request.expiresAt),
    intentHash: hash(request.intent), humanApproved: request.status === 'approved', decision: request.evaluation.decision };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url') };
}
export function verifyGrant(envelope, intent, publicKey, policy, now = Date.now()) {
  try {
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' ||
      !verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error();
    const g = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString());
    const decision = evaluate(intent, policy).decision;
    if (g.audience !== 'payguard-executor' || g.environment !== 'sandbox' || g.policyVersion !== policy.version ||
      !/^[0-9a-f-]{36}$/.test(g.requestId) || !/^[0-9a-f-]{36}$/.test(g.jti) ||
      !Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt) || g.issuedAt > now || g.expiresAt <= now ||
      g.expiresAt <= g.issuedAt || g.expiresAt - g.issuedAt > TTL || g.intentHash !== hash(intent) ||
      g.decision !== decision || decision === 'deny' || (decision === 'require_approval' && g.humanApproved !== true)) throw new Error();
    return g;
  } catch { throw new Fault(403, 'Invalid, expired or mismatched authorization.'); }
}
