import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as rawHttpRequest } from 'node:http';

async function launch(data) {
  const child=fork(new URL('../scripts/start.mjs',import.meta.url),[],{env:{PATH:process.env.PATH,PORT:'0',PAYGUARD_DATA_DIR:data,PAYMENT_PROVIDER:'demo',AI_PROVIDER:'demo',OPERATOR_PIN:'integration-test-operator'},stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timed out: '+stderr)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Startup failed: '+stderr));});});
  return {...ready,child,base:`http://127.0.0.1:${ready.port}`};
}
async function stop(app){const exited=once(app.child,'exit');app.child.kill('SIGTERM');await exited;}
test('three-process HTTP pipeline: approval, allow, deny, authentication, concurrency and restart',async()=>{
  const data=mkdtempSync(join(tmpdir(),'payguard-integration-'));let app=await launch(data);
  try {
    await assert.rejects(()=>launch(data),/Another launcher owns this data directory/);
    async function request(path,payload,options={}) {
      const response=await fetch(app.base+path,{...(payload===undefined?{}:{method:'POST',body:JSON.stringify(payload)}),headers:{'Content-Type':'application/json',...options},redirect:'error'});
      return {status:response.status,data:await response.json(),headers:response.headers};
    }
    const structured=(reference,amount='120.00',recipient='alex@example.test')=>({amount,currency:'USD',recipient,category:'contractor',reference,purpose:'Test contractor invoice'});
    const created=await request('/api/requests',{prompt:'Pay $120 to Alex Morgan for contractor invoice INV-1042'});assert.equal(created.status,201);assert.equal(created.data.status,'pending_approval');const id=created.data.id;
    assert.equal((await request(`/api/requests/${id}/approve`,{})).status,401);
    assert.equal((await request(`/api/requests/${id}/execute`,{})).status,401);
    const badOrigin=await request('/api/session',{pin:'integration-test-operator'},{Origin:'https://attacker.test'});assert.equal(badOrigin.status,403);
    assert.equal((await request('/api/session',{pin:'wrong'})).status,401);
    const session=await request('/api/session',{pin:'integration-test-operator'});assert.equal(session.status,200);
    assert.match(session.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);const cookie={Cookie:session.headers.get('set-cookie').split(';')[0]};
    assert.equal((await request(`/api/requests/${id}/execute`,{},cookie)).status,403);
    const reviewed=await request(`/api/requests/${id}/approve`,{intent:structured('INV-1042','1.00')},cookie);assert.equal(reviewed.data.intent.amount,'120.00');assert.equal(reviewed.data.status,'approved');
    const concurrent=await Promise.all([request(`/api/requests/${id}/execute`,{},cookie),request(`/api/requests/${id}/execute`,{},cookie)]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,403]);const executed=concurrent.find(r=>r.status===200);assert.equal(executed.data.status,'simulated');assert.equal(executed.data.receipt.provider,'demo');
    const low=await request('/api/requests',{intent:structured('INV-LOW','24.00')});assert.equal(low.data.status,'allowed');assert.equal((await request(`/api/requests/${low.data.id}/execute`,{},cookie)).data.status,'simulated');
    const denied=await request('/api/requests',{intent:structured('INV-BLOCKED','900.00','unknown@example.test')});assert.equal(denied.data.status,'denied');
    assert.equal((await request(`/api/requests/${denied.data.id}/approve`,{},cookie)).status,409);assert.equal((await request(`/api/requests/${denied.data.id}/execute`,{},cookie)).status,403);
    const duplicate=await request('/api/requests',{intent:structured('inv-1042','1.00')});assert.equal(duplicate.data.status,'denied');assert.ok(duplicate.data.evaluation.checks.find(c=>c.rule==='Duplicate invoice').pass===false);
    assert.equal((await request('/api/requests',{intent:{...structured('INV-EXTRA'),approved:true}})).status,400);
    const pending=await request('/api/requests',{intent:structured('INV-REJECT')});assert.equal((await request(`/api/requests/${pending.data.id}/reject`,{},cookie)).data.status,'rejected');
    assert.equal((await request(`/api/requests/${pending.data.id}/execute`,{},cookie)).status,403);
    const direct=await fetch(`http://127.0.0.1:${app.executorPort}/execute`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({intent:structured('INV-DIRECT'),decision:'allow'})});assert.equal(direct.status,401);
    const guessed=await fetch(`http://127.0.0.1:${app.executorPort}/execute`,{method:'POST',headers:{Authorization:'Bearer guessed','Content-Type':'application/json'},body:'{}'});assert.equal(guessed.status,401);
    const agentDirect=await fetch(`http://127.0.0.1:${app.agentPort}/execute`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(agentDirect.status,401);
    const dashboard=await request('/api/state');assert.ok(!JSON.stringify(dashboard.data).includes('integration-test-operator'));assert.ok(!JSON.stringify(dashboard.data).includes('PRIVATE KEY'));
    assert.equal((await request('/api/audit/export')).status,401);const exported=await request('/api/audit/export',undefined,cookie);assert.ok(exported.data.gateway.some(e=>e.type==='human_approved'));
    // Node's fetch normalizes Host; raw HTTP is needed to exercise DNS-rebinding protection.
    const badHost=await new Promise((resolve,reject)=>{const req=rawHttpRequest(app.base+'/api/state',{headers:{Host:'attacker.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    assert.equal(badHost,403);
    const homepage=await fetch(app.base);assert.match(homepage.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.ok((await homepage.text()).includes('PayGuard'));
    const ledger=readFileSync(join(data,'executor/ledger.jsonl'),'utf8');assert.ok(!ledger.includes(denied.data.id));assert.equal(ledger.split('\n').filter(l=>l.includes('"type":"execution_reserved"')).length,2);
    await stop(app);app=await launch(data);
    const restored=await request('/api/state');assert.equal(restored.data.requests.find(r=>r.id===id).status,'simulated');assert.equal(restored.data.operator,false);
    assert.equal((await request('/api/requests',{intent:structured('INV-1042')})).data.status,'denied');
    const loginAgain=await request('/api/session',{pin:'integration-test-operator'});const cookieAgain={Cookie:loginAgain.headers.get('set-cookie').split(';')[0]};
    assert.equal((await request(`/api/requests/${id}/execute`,{},cookieAgain)).status,403);
    assert.equal((await request(`/api/requests/${id}/refresh`,{},cookieAgain)).data.status,'simulated');
    await request('/api/logout',{},cookieAgain);assert.equal((await request(`/api/requests/${id}/refresh`,{},cookieAgain)).status,401);
  } finally {await stop(app);}
});
