import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateIntent, evaluate, policyFor, mintGrant, verifyGrant, fingerprint, TTL } from '../src/core.mjs';
import { demoIntent, extractIntent } from '../src/agent.mjs';
import { Journal } from '../src/journal.mjs';
import { Executor } from '../src/executor.mjs';
import { Gateway } from '../src/gateway.mjs';
import { DemoPayments, PayPalSandbox, SANDBOX_ORIGIN, reconcileSandboxPayout } from '../src/paypal.mjs';
import { serviceEnvironments, validateConfig } from '../scripts/start.mjs';

const policy = policyFor();
const intent = overrides => validateIntent({ amount: '120.00', currency: 'USD', recipient: 'alex@example.test', category: 'contractor', reference: 'INV-1042', purpose: 'Contractor design work', ...overrides });
const keys = generateKeyPairSync('ed25519');
const makeJournal = () => new Journal(join(mkdtempSync(join(tmpdir(), 'payguard-unit-')), 'events.jsonl'));
function approved(overrides = {}) { return { id: '12345678-1234-1234-1234-123456789abc', status: 'approved', intent: intent(), evaluation: evaluate(intent(),policy), expiresAt: Date.now()+TTL, ...overrides }; }
function resigned(envelope, values) {
  const payload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(envelope.payload,'base64url').toString()), ...values })).toString('base64url');
  return { payload, signature: sign(null,Buffer.from(payload),keys.privateKey).toString('base64url') };
}
test('deterministic policy covers threshold boundaries, allow and deny precedence', () => {
  assert.equal(evaluate(intent({amount:'24.00'}),policy).decision,'allow');
  assert.equal(evaluate(intent({amount:'50.00'}),policy).decision,'allow');
  assert.equal(evaluate(intent({amount:'50.01'}),policy).decision,'require_approval');
  assert.equal(evaluate(intent({amount:'500.00'}),policy).decision,'require_approval');
  for (const changes of [{amount:'500.01'}, {recipient:'unknown@example.test'}, {category:'gambling'}, {currency:'EUR'}]) assert.equal(evaluate(intent(changes),policy).decision,'deny');
  assert.equal(evaluate(intent(),policy,true).decision,'deny');
});
test('intent validation rejects unknown fields, invalid precision and coercion', () => {
  for (const amount of ['0.00','-1.00','1e2','01.00','120','1.001',120,null]) assert.throws(()=>intent({amount}));
  assert.throws(()=>validateIntent({...intent(), approved:true}));
  assert.throws(()=>intent({purpose:'bad\ntext'}));
  assert.throws(()=>intent({reference:'../invoice'}));
  assert.throws(()=>intent({recipient:'not-an-email'}));
  assert.equal(intent({recipient:'ALEX@EXAMPLE.TEST',reference:'inv-1042'}).recipient,'alex@example.test');
});
test('duplicate identity survives amount/purpose/case changes', () => {
  assert.equal(fingerprint(intent()),fingerprint(intent({amount:'1.00',purpose:'Different purpose',reference:'inv-1042'})));
});
test('demo parser is explicit and rejects missing or ambiguous fields', () => {
  assert.equal(demoIntent('Pay $120 to Alex Morgan for contractor invoice INV-1042').amount,'120.00');
  assert.equal(demoIntent('Pay USD 24 to tools@example.test for software invoice SW-102').category,'software');
  for (const prompt of ['Pay Alex contractor invoice INV-1042', 'Pay $120 and $20 to Alex contractor INV-1042', 'Pay $120 to Alex contractor', 'Pay $120 to someone contractor INV-1042', 'Pay $120 to Alex INV-1042']) assert.throws(()=>demoIntent(prompt));
});
test('local AI contract extracts intent without accepting model authorization or silently falling back', async () => {
  let request;
  const fetcher = async (url,options) => { request={url,options}; return {ok:true,json:async()=>({message:{content:JSON.stringify(intent())}})}; };
  const result = await extractIntent('Pay the contractor $120 invoice INV-1042',{provider:'ollama',model:'test-local',recipient:'alex@example.test'},fetcher);
  assert.equal(result.provider,'ollama'); assert.equal(result.intent.amount,'120.00');
  assert.equal(request.url,'http://127.0.0.1:11434/api/chat');
  assert.equal(JSON.parse(request.options.body).stream,false);
  await assert.rejects(()=>extractIntent('Pay $120 invoice INV-1042',{provider:'ollama',model:'test'},async()=>{throw new Error('unavailable');}),/no demo fallback/);
  await assert.rejects(()=>extractIntent('Pay $120 invoice INV-1042',{provider:'ollama',model:'test'},async()=>({ok:true,json:async()=>({message:{content:JSON.stringify({...intent(),approved:true})}})})),/exactly/);
});
test('AI input ambiguity and explicit-term alteration cannot become payment intents', async () => {
  let calls=0;
  const config={provider:'ollama',model:'test',recipient:'alex@example.test'};
  const fake=overrides=>async()=>{calls++;return {ok:true,json:async()=>({message:{content:JSON.stringify(intent(overrides))}})};};
  for(const prompt of ['Pay $20 or $40 to alex@example.test invoice INV-1042','Pay $120 to alex@example.test or other@example.test invoice INV-1042','Pay $120 invoice INV-1042 or INV-1043','Pay $0.001 invoice INV-1042','Pay $-20 invoice INV-1042']) {
    await assert.rejects(()=>extractIntent(prompt,config,fake()),/Ambiguous|positive amount/);
  }
  assert.equal(calls,0);
  const prompt='Pay alex@example.test $120 for contractor invoice INV-1042';
  for(const changes of [{amount:'1.00'},{currency:'EUR'},{recipient:'other@example.test'},{reference:'INV-OTHER'}]) {
    await assert.rejects(()=>extractIntent(prompt,config,fake(changes)),/changed explicit payment terms/);
  }
  assert.equal((await extractIntent(prompt,config,fake())).intent.amount,'120.00');
});
test('signature binds intent and rejects unsigned, forged, expired, wrong audience and denied grants', () => {
  const envelope = mintGrant(approved(),keys.privateKey);
  assert.equal(verifyGrant(envelope,intent(),keys.publicKey,policy).humanApproved,true);
  for (const invalid of [null, {payload:envelope.payload,signature:'forged'}, resigned(envelope,{audience:'other'}), resigned(envelope,{environment:'live'}), resigned(envelope,{expiresAt:Date.now()-1}), resigned(envelope,{issuedAt:Date.now()+10000}), resigned(envelope,{humanApproved:false}), resigned(envelope,{decision:'allow'}), resigned(envelope,{policyVersion:'v0'})]) assert.throws(()=>verifyGrant(invalid,intent(),keys.publicKey,policy),/Invalid/);
  assert.throws(()=>verifyGrant(envelope,intent({amount:'1.00'}),keys.publicKey,policy));
  const denied = intent({amount:'900.00'});
  const g = mintGrant(approved({intent:denied,evaluation:evaluate(denied,policy)}),keys.privateKey);
  assert.throws(()=>verifyGrant(g,denied,keys.publicKey,policy));
  assert.throws(()=>mintGrant(approved({status:'pending_approval'}),keys.privateKey));
});
test('executor consumes authorization once and preserves reservation across restart', async () => {
  const journal = makeJournal(); let calls=0;
  const provider = {create:async(...args)=>{calls++;return new DemoPayments().create(...args);}};
  const executor = new Executor({journal,provider,publicKey:keys.publicKey,policy});
  const input={intent:intent(),authorization:mintGrant(approved(),keys.privateKey)};
  const results=await Promise.allSettled([executor.execute(input),executor.execute(input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(calls,1);
  const restarted = new Executor({journal:new Journal(journal.path),provider,publicKey:keys.publicKey,policy});
  await assert.rejects(()=>restarted.execute(input),/consumed/);
  const newRequest=approved({id:'12345678-1234-1234-1234-123456789abd'});
  await assert.rejects(()=>restarted.execute({intent:intent(),authorization:mintGrant(newRequest,keys.privateKey)}),/consumed/);
});
test('invalid authorization cannot invoke the payment provider', async () => {
  let calls=0;
  const executor=new Executor({journal:makeJournal(),provider:{create:async()=>{calls++;}},publicKey:keys.publicKey,policy});
  await assert.rejects(()=>executor.execute({intent:intent(),authorization:{payload:'x',signature:'x'}}));
  assert.equal(calls,0);
});
test('failed durable reservation blocks payment and uncertain payment never retries', async () => {
  let calls=0;
  const failJournal={events:[],append(){throw new Error('disk unavailable');}};
  const executor=new Executor({journal:failJournal,provider:{create:async()=>{calls++;}},publicKey:keys.publicKey,policy});
  const data={intent:intent(),authorization:mintGrant(approved(),keys.privateKey)};
  await assert.rejects(()=>executor.execute(data),/disk unavailable/); assert.equal(calls,0);
  const uncertain=new Executor({journal:makeJournal(),provider:{create:async()=>{calls++;throw new Error('timeout');}},publicKey:keys.publicKey,policy});
  assert.equal((await uncertain.execute(data)).state,'reconciliation_required');
  await assert.rejects(()=>uncertain.execute(data),/consumed/); assert.equal(calls,1);
});
test('gateway requires current decision and review, persists requests, and blocks duplicate changes', async () => {
  let calls=0; const journal=makeJournal();
  const make = j => new Gateway({journal:j,privateKey:keys.privateKey,policy,execute:async()=>{calls++;return{state:'simulated'};}});
  const gateway=make(journal), r=gateway.submit(intent());
  await assert.rejects(()=>gateway.execute(r.id)); assert.equal(calls,0);
  assert.equal(gateway.submit(intent({amount:'1.00'})).status,'denied');
  gateway.review(r.id,true); await gateway.execute(r.id); assert.equal(calls,1);
  await assert.rejects(()=>gateway.execute(r.id));
  const restarted=make(new Journal(journal.path)); assert.equal(restarted.get(r.id).status,'simulated');
  assert.equal(restarted.submit(intent()).status,'denied');
  const denied=restarted.submit(intent({reference:'INV-900',amount:'900.00'}));
  assert.throws(()=>restarted.review(denied.id,true)); await assert.rejects(()=>restarted.execute(denied.id));
});
test('gateway expiry, reject and interrupted execution fail closed', async () => {
  const journal=makeJournal(); const gateway=new Gateway({journal,privateKey:keys.privateKey,policy,execute:async()=>({state:'simulated'})});
  const r=gateway.submit(intent()); gateway.record('test_expired','test',{...r,expiresAt:Date.now()-1});
  assert.throws(()=>gateway.review(r.id,true),/expired/); gateway.reject(r.id);
  const fresh=gateway.submit(intent()); assert.equal(fresh.status,'pending_approval');
  gateway.record('authorization_issued','gateway',{...fresh,status:'executing'});
  const restored=new Gateway({journal:new Journal(journal.path),privateKey:keys.privateKey,policy});
  assert.equal(restored.get(fresh.id).status,'reconciliation_required'); await assert.rejects(()=>restored.execute(fresh.id));
});
test('journal detects modified, incomplete and disconnected event records', () => {
  const journal=makeJournal();journal.append('one','test','id',{value:1});journal.append('two','test','id',{value:2});
  const original=readFileSync(journal.path,'utf8');
  writeFileSync(journal.path,original.replace('"value":1','"value":9')); assert.throws(()=>new Journal(journal.path),/integrity/);
  writeFileSync(journal.path,original.slice(0,-1)); assert.throws(()=>new Journal(journal.path),/Incomplete/);
  writeFileSync(journal.path,original.split('\n')[1]+'\n'); assert.throws(()=>new Journal(journal.path),/integrity/);
});
test('launcher never passes PayPal secrets, signing key or operator credentials to agent', () => {
  const env=serviceEnvironments({PAYMENT_PROVIDER:'paypal-sandbox',AI_PROVIDER:'demo',PAYPAL_CLIENT_ID:'sentinel-id',PAYPAL_CLIENT_SECRET:'sentinel-secret',OPERATOR_PIN:'sentinel-operator',SANDBOX_RECIPIENT_EMAIL:'sandbox@example.com'},
    {privateKey:'private-sentinel',publicKey:'public',agentToken:'agent',executorToken:'executor'}, {data:'/tmp/data'});
  for (const secret of ['sentinel-id','sentinel-secret','sentinel-operator','private-sentinel','executor']) assert.ok(!Object.values(env.agent).includes(secret));
  assert.ok(!('PAYPAL_CLIENT_SECRET' in env.gateway)); assert.ok(!('GRANT_PRIVATE_KEY' in env.executor));
  assert.ok(!('OPERATOR_PIN' in env.executor));
});
test('unsupported providers and incomplete sandbox configuration fail before startup', () => {
  assert.throws(()=>validateConfig({PAYMENT_PROVIDER:'live',AI_PROVIDER:'demo'}));
  assert.throws(()=>validateConfig({PAYMENT_PROVIDER:'paypal-sandbox',AI_PROVIDER:'demo'}));
  assert.throws(()=>validateConfig({PAYMENT_PROVIDER:'paypal-sandbox',AI_PROVIDER:'demo',PAYPAL_CLIENT_ID:'id',PAYPAL_CLIENT_SECRET:'secret',SANDBOX_RECIPIENT_EMAIL:'sandbox@example.com',OPERATOR_PIN:'payguard-demo'}));
  assert.throws(()=>validateConfig({PAYMENT_PROVIDER:'demo',AI_PROVIDER:'unknown'}));
});
test('PayPal adapter uses fixed sandbox OAuth/Payouts, stable IDs and honest item statuses', async () => {
  const calls=[];
  const fake=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/token')?{access_token:'test-token',token_type:'Bearer',expires_in:3600}:{batch_header:{payout_batch_id:'BATCH123',batch_status:options.method==='GET'?'SUCCESS':'PENDING'},...(options.method==='GET'?{items:[{transaction_status:'UNCLAIMED'}]}:{})}};};
  const adapter=new PayPalSandbox({clientId:'fake-id',clientSecret:'fake-secret'},fake);
  const r=await adapter.create(intent(),'request-id'); assert.equal(r.batchStatus,'PENDING');assert.equal(r.itemStatus,'NOT_YET_REPORTED');
  const observed=await adapter.status('BATCH123','request-id');assert.equal(observed.batchStatus,'SUCCESS');assert.equal(observed.itemStatus,'UNCLAIMED');
  assert.ok(calls.every(c=>c.url.startsWith(SANDBOX_ORIGIN+'/')&&c.options.redirect==='error'));
  assert.equal(calls.length,3);const payload=JSON.parse(calls[1].options.body);
  assert.equal(payload.sender_batch_header.sender_batch_id,'request-id');assert.equal(payload.items[0].sender_item_id,'request-id');
  assert.equal(calls[1].options.headers['PayPal-Request-Id'],'request-id');assert.equal(payload.items[0].amount.value,'120.00');
  assert.equal(payload.items[0].recipient_type,'EMAIL');assert.equal(payload.items[0].receiver,'alex@example.test');
});
test('PayPal adapter redacts raw failures and never follows a provider URL', async () => {
  const adapter=new PayPalSandbox({clientId:'fake',clientSecret:'fake'},async()=>({ok:false,status:403,json:async()=>({name:'NOT_AUTHORIZED',message:'SECRET_MARKER',access_token:'SECRET_MARKER'})}));
  await assert.rejects(()=>adapter.create(intent(),'id'),error=>!error.message.includes('SECRET_MARKER')&&error.message.includes('NOT_AUTHORIZED'));
  await assert.rejects(()=>adapter.status('../redirect','id'),/Invalid batch/);
});

test('OAuth verification makes only a token call and exposes only sanitized evidence', async () => {
  const calls=[];
  const adapter=new PayPalSandbox({clientId:'PRIVATE_CLIENT_MARKER',clientSecret:'PRIVATE_SECRET_MARKER'},async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>({access_token:'PRIVATE_TOKEN_MARKER',token_type:'Bearer',expires_in:3600,
      scope:'openid https://uri.paypal.com/payments/payouts',app_id:'PRIVATE_APP_MARKER',nonce:'PRIVATE_NONCE_MARKER'})};
  });
  const evidence=await adapter.verifyOAuth();
  assert.equal(calls.length,1);assert.equal(calls[0].url,SANDBOX_ORIGIN+'/v1/oauth2/token');
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.body,'grant_type=client_credentials');
  assert.equal(evidence.authenticated,true);assert.equal(evidence.payoutAttempted,false);assert.equal(evidence.payoutsScopePresent,true);
  assert.equal(JSON.stringify(evidence).includes('PRIVATE_'),false);
  assert.deepEqual(Object.keys(evidence).sort(),['authenticated','expiresInSeconds','observedAt','origin','payoutAttempted','payoutsScopePresent','provider'].sort());
});

test('OAuth authentication does not stand in for payout scope or settlement', async () => {
  const adapter=new PayPalSandbox({clientId:'fake',clientSecret:'fake'},async()=>({ok:true,json:async()=>({access_token:'fake-token',token_type:'Bearer',expires_in:3600,scope:'openid'})}));
  const evidence=await adapter.verifyOAuth();assert.equal(evidence.payoutsScopePresent,false);assert.equal(evidence.payoutAttempted,false);
  for(const invalid of [{access_token:'',token_type:'Bearer',expires_in:3600},{access_token:'token',token_type:'Basic',expires_in:3600},{access_token:'token',token_type:'Bearer',expires_in:'bad'}]) {
    const invalidAdapter=new PayPalSandbox({clientId:'fake',clientSecret:'fake'},async()=>({ok:true,json:async()=>invalid}));
    await assert.rejects(()=>invalidAdapter.verifyOAuth(),/invalid OAuth response/);
  }
});

test('OAuth credential rejection reports a known code without raw secret-bearing details', async () => {
  const adapter=new PayPalSandbox({clientId:'fake',clientSecret:'fake'},async()=>({ok:false,status:401,json:async()=>({error:'invalid_client',error_description:'PRIVATE_MARKER',access_token:'PRIVATE_MARKER'})}));
  await assert.rejects(()=>adapter.verifyOAuth(),error=>error.message.includes('invalid_client')&&!error.message.includes('PRIVATE_MARKER'));
});

test('independent reconciliation binds provider batch/item/recipient/amount to recorded terms', () => {
  const request={id:'request-id',intent:intent({amount:'0.01'}),receipt:{batchId:'BATCH123'}};
  const data={total_items:1,batch_header:{payout_batch_id:'BATCH123',batch_status:'SUCCESS',sender_batch_header:{sender_batch_id:request.id}},
    items:[{payout_item_id:'ITEM123',transaction_status:'SUCCESS',payout_item:{recipient_type:'EMAIL',receiver:request.intent.recipient,
      amount:{value:'0.01',currency:'USD'},sender_item_id:request.id}}],access_token:'PRIVATE_MARKER',links:[{href:'https://untrusted.test'}]};
  const evidence=reconcileSandboxPayout(data,request);assert.equal(evidence.settled,true);assert.equal(evidence.independentApiRead,true);
  assert.ok(!JSON.stringify(evidence).includes(request.intent.recipient));assert.ok(!JSON.stringify(evidence).includes('PRIVATE_MARKER'));assert.ok(!JSON.stringify(evidence).includes('untrusted'));
  data.items[0].transaction_status='UNCLAIMED';assert.equal(reconcileSandboxPayout(data,request).settled,false);
  for (const field of ['receiver','recipient_type','sender_item_id']) {
    const wrong=structuredClone(data);wrong.items[0].payout_item[field]='wrong';assert.throws(()=>reconcileSandboxPayout(wrong,request),/did not match/);
  }
  const wrongAmount=structuredClone(data);wrongAmount.items[0].payout_item.amount.value='1.00';assert.throws(()=>reconcileSandboxPayout(wrongAmount,request),/did not match/);
  const wrongCurrency=structuredClone(data);wrongCurrency.items[0].payout_item.amount.currency='EUR';assert.throws(()=>reconcileSandboxPayout(wrongCurrency,request),/did not match/);
  const wrongBatch=structuredClone(data);wrongBatch.batch_header.sender_batch_header.sender_batch_id='wrong';assert.throws(()=>reconcileSandboxPayout(wrongBatch,request),/did not match/);
  const extraItem=structuredClone(data);extraItem.items.push(data.items[0]);assert.throws(()=>reconcileSandboxPayout(extraItem,request),/did not match/);
  const wrongCount=structuredClone(data);wrongCount.total_items=0;assert.throws(()=>reconcileSandboxPayout(wrongCount,request),/did not match/);
});
