import { fork } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, unlinkSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadConfig(root, environment = process.env) {
  const fileConfig = {};
  if (existsSync(`${root}/.env`)) for (const line of readFileSync(`${root}/.env`, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) fileConfig[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const config = { PAYMENT_PROVIDER: 'demo', AI_PROVIDER: 'demo', ...fileConfig };
  for (const k of ['PAYMENT_PROVIDER', 'AI_PROVIDER', 'PORT', 'OPERATOR_PIN', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'SANDBOX_RECIPIENT_EMAIL', 'OLLAMA_MODEL']) if (environment[k] !== undefined) config[k] = environment[k];
  return config;
}

export function serviceEnvironments(config, material, locations) {
  const common = { PATH: process.env.PATH || '', NODE_ENV: 'development' };
  const recipient = config.PAYMENT_PROVIDER === 'paypal-sandbox' ? config.SANDBOX_RECIPIENT_EMAIL : '';
  return {
    agent: { ...common, AI_PROVIDER: config.AI_PROVIDER, OLLAMA_MODEL: config.OLLAMA_MODEL || 'llama3.2',
      RECIPIENT_EMAIL: recipient, AGENT_SERVICE_TOKEN: material.agentToken },
    executor: { ...common, PAYMENT_PROVIDER: config.PAYMENT_PROVIDER, RECIPIENT_EMAIL: recipient,
      EXECUTOR_DATA_DIR: `${locations.data}/executor`, GRANT_PUBLIC_KEY: material.publicKey, EXECUTOR_SERVICE_TOKEN: material.executorToken,
      ...(config.PAYMENT_PROVIDER === 'paypal-sandbox' ? { PAYPAL_CLIENT_ID: config.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: config.PAYPAL_CLIENT_SECRET } : {}) },
    gateway: { ...common, PORT: config.PORT || '3000', PAYMENT_PROVIDER: config.PAYMENT_PROVIDER, AI_PROVIDER: config.AI_PROVIDER,
      OLLAMA_MODEL: config.OLLAMA_MODEL || 'llama3.2', RECIPIENT_EMAIL: recipient, OPERATOR_PIN: config.OPERATOR_PIN || 'payguard-demo',
      GATEWAY_DATA_DIR: `${locations.data}/gateway`, GRANT_PRIVATE_KEY: material.privateKey, EXECUTOR_SERVICE_TOKEN: material.executorToken, AGENT_SERVICE_TOKEN: material.agentToken }
  };
}
export function validateConfig(config) {
  if (!['demo', 'paypal-sandbox'].includes(config.PAYMENT_PROVIDER)) throw new Error('Only demo and paypal-sandbox payment providers are supported.');
  if (!['demo', 'ollama'].includes(config.AI_PROVIDER)) throw new Error('Only demo and ollama intent providers are supported.');
  if (config.PORT !== undefined && (!/^\d+$/.test(String(config.PORT)) || Number(config.PORT) > 65535)) throw new Error('PORT must be a valid integer port.');
  if (config.PAYMENT_PROVIDER === 'paypal-sandbox') {
    if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET || !config.SANDBOX_RECIPIENT_EMAIL) throw new Error('Sandbox mode requires sandbox client ID, secret and personal sandbox recipient email.');
    if (!config.OPERATOR_PIN || config.OPERATOR_PIN.length < 12 || config.OPERATOR_PIN === 'payguard-demo') throw new Error('Sandbox mode requires a private operator passphrase of at least 12 characters.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.SANDBOX_RECIPIENT_EMAIL) || config.SANDBOX_RECIPIENT_EMAIL.endsWith('.test')) throw new Error('Use an actual personal sandbox account email in sandbox mode.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = loadConfig(root);
  try { validateConfig(config); } catch (e) { console.error(e.message); process.exit(1); }
  // Modes have separate ledgers so a simulated reservation cannot stand in for sandbox evidence.
  const data = resolve(process.env.PAYGUARD_DATA_DIR || `${root}/data/${config.PAYMENT_PROVIDER}`);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const lock = `${data}/launcher.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) { console.error('Invalid launcher lock. Preserve and review the data directory.'); process.exit(1); }
    try { process.kill(pid, 0); console.error('Another launcher owns this data directory.'); process.exit(1); }
    catch (e) {
      if (e.code !== 'ESRCH') { console.error('Cannot verify launcher lock ownership.'); process.exit(1); }
      // A dead launcher does not prove its child services stopped. Never silently
      // release a stale lock while an orphan could still write the same ledger.
      console.error('Stale launcher lock. Verify all prior PayGuard processes stopped before manually removing the lock. Journals must be preserved.');
      process.exit(1);
    }
  }
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); } catch { console.error('Could not acquire exclusive data-directory lock.'); process.exit(1); }
  const keys = generateKeyPairSync('ed25519');
  const material = { privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    agentToken: randomBytes(32).toString('hex'), executorToken: randomBytes(32).toString('hex') };
  const envs = serviceEnvironments(config, material, { data }), children = [];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return; stopping = true;
    for (const child of children) child.kill('SIGTERM');
    Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolveDone => child.once('exit', resolveDone)))).then(() => {
      if (existsSync(lock)) unlinkSync(lock); process.exit(code);
    });
  }
  process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
  function launch(name, env) {
    return new Promise((ready, reject) => {
      const child = fork(`${root}/src/${name}.mjs`, [], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push(child);
      const timer = setTimeout(() => reject(new Error(`${name} startup timed out.`)), 10000);
      child.once('message', message => { clearTimeout(timer); if (message.ready) ready(message.port); else reject(new Error('Invalid service readiness.')); });
      child.on('error', () => { clearTimeout(timer); reject(new Error(`${name} could not start.`)); });
      child.once('exit', () => { clearTimeout(timer); if (!stopping) { reject(new Error(`${name} stopped unexpectedly.`)); console.error(`${name} stopped; shutting down PayGuard.`); stop(1); } });
    });
  }
  try {
    const agentPort = await launch('agent', envs.agent);
    const executorPort = await launch('executor', envs.executor);
    const port = await launch('gateway', { ...envs.gateway, AGENT_URL: `http://127.0.0.1:${agentPort}`, EXECUTOR_URL: `http://127.0.0.1:${executorPort}` });
    console.log(`PayGuard ready: http://127.0.0.1:${port}`);
    console.log(`Payments: ${config.PAYMENT_PROVIDER} | Intent provider: ${config.AI_PROVIDER} | Three isolated service environments`);
    if (config.PAYMENT_PROVIDER === 'demo' && !config.OPERATOR_PIN) console.log('Simulation review passphrase: payguard-demo');
    process.send?.({ ready: true, port, agentPort, executorPort });
  } catch (e) { console.error(e.message); stop(1); }
}
