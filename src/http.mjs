import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Fault } from './core.mjs';

export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function bearer(req, token) {
  if (!equal(req.headers.authorization, `Bearer ${token}`)) throw new Fault(401, 'Service authentication required.');
}
export async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Fault(415, 'JSON content type required.');
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Fault(413, 'Request body too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Fault(400, 'Invalid JSON.'); }
}
export function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
export function listen(handler, port = 0, onReady) {
  const server = createServer(async (req, res) => {
    try { await handler(req, res); }
    catch (error) { if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal operation failed. Check local service health and preserved audit records.' }); else res.end(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1', () => { onReady?.(server.address().port); process.send?.({ ready: true, port: server.address().port }); });
  server.on('error', error => { console.error(`Service could not bind its loopback port (${error.code || 'UNKNOWN'}).`); process.exit(1); });
  return server;
}
export async function rpc(url, token, payload, method = 'POST') {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Fault(response.status, result.error || 'Internal service refused the request.');
  return result;
}
