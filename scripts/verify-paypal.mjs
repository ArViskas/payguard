import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './start.mjs';
import { PayPalSandbox } from '../src/paypal.mjs';
import { Fault } from '../src/core.mjs';

// Authentication probe only. Payment creation remains exclusively in the executor.
const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig(root);
if (config.PAYMENT_PROVIDER !== 'paypal-sandbox' || !config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
  console.error('OAuth not attempted. Set PAYMENT_PROVIDER=paypal-sandbox and sandbox PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET in ignored local .env.');
  process.exitCode = 1;
} else {
  try {
    const adapter = new PayPalSandbox({ clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET });
    const evidence = await adapter.verifyOAuth();
    const directory = resolve(root, 'data/paypal-sandbox/evidence');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `oauth-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`Sanitized evidence saved: ${path}`);
    if (!evidence.payoutsScopePresent) {
      console.error('OAuth succeeded but the Payouts scope was not present. Review sandbox app access before executing.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Fault ? error.message : 'OAuth verification/evidence storage failed. No payout was attempted.');
    process.exitCode = 1;
  }
}
