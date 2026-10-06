import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, validateConfig } from './start.mjs';
import { Journal } from '../src/journal.mjs';
import { PayPalSandbox, reconcileSandboxPayout } from '../src/paypal.mjs';
import { Fault, hash } from '../src/core.mjs';

// Read-only provider reconciliation. There is deliberately no create/execute call.
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const config = loadConfig(root);
  validateConfig(config);
  if (config.PAYMENT_PROVIDER !== 'paypal-sandbox') throw new Error('Use sandbox configuration only.');
  const id = process.argv[2];
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id || '')) throw new Error('Provide the exact recorded PayGuard request UUID.');
  const directory = resolve(root, 'data/paypal-sandbox');
  const gatewayPath = `${directory}/gateway/audit.jsonl`, executorPath = `${directory}/executor/ledger.jsonl`;
  if (!existsSync(gatewayPath) || !existsSync(executorPath)) throw new Error('Both recorded sandbox journals are required.');
  const gateway = new Journal(gatewayPath), executor = new Journal(executorPath);
  const request = gateway.events.filter(e => e.requestId === id && e.data.request).at(-1)?.data.request;
  const reservation = executor.events.find(e => e.requestId === id && e.type === 'execution_reserved');
  const result = executor.events.filter(e => e.requestId === id && ['execution_result', 'execution_refreshed'].includes(e.type)).at(-1)?.data;
  if (!request || request.intent.recipient !== config.SANDBOX_RECIPIENT_EMAIL.toLowerCase() || !reservation || reservation.data.intentHash !== hash(request.intent) ||
      request.receipt?.provider !== 'paypal-sandbox' || result?.receipt?.batchId !== request.receipt.batchId ||
      !/^[A-Za-z0-9]{1,64}$/.test(request.receipt.batchId)) throw new Error('Recorded sandbox request/receipt/reservation does not match configured recipient and executor.');
  const adapter = new PayPalSandbox({ clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET });
  const token = await adapter.token();
  const raw = await adapter.call(`/v1/payments/payouts/${request.receipt.batchId}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  const evidence = { ...reconcileSandboxPayout(raw, request), executorReservationObserved: true,
    gatewayAuditDigest: gateway.events.at(-1).digest, executorAuditDigest: executor.events.at(-1).digest };
  mkdirSync(`${directory}/evidence`, { recursive: true, mode: 0o700 });
  const path = `${directory}/evidence/payout-${id}-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`Sanitized evidence saved: ${path}`);
  if (!evidence.settled) { console.error('Payment terms matched, but batch/item completion is not yet fully verified. Do not resend.'); process.exitCode = 2; }
} catch (error) {
  console.error(error instanceof Fault ? error.message : 'Sandbox reconciliation could not proceed. Check the exact recorded request, configuration and journal integrity; no payout was created.');
  process.exitCode = 1;
}
