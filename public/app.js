const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = intent => `${intent.currency === 'USD' ? '$' : escape(intent.currency) + ' '}${escape(intent.amount)}`;
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortId = id => id.slice(0, 8).toUpperCase();
const labels = { pending_approval: 'Needs approval', allowed: 'Policy allowed', approved: 'Human approved', denied: 'Blocked', rejected: 'Human rejected', executing: 'Executing', submitted: 'Sandbox submitted', simulated: 'Simulated', reconciliation_required: 'Needs reconciliation', proposed: 'Proposed' };
const tone = status => ['denied', 'rejected', 'reconciliation_required'].includes(status) ? 'red' : status === 'pending_approval' ? 'amber' : 'green';
const badge = status => `<span class="badge ${tone(status)}"><i></i>${escape(labels[status] || status)}</span>`;
const eventLabels = { intent_proposed: 'Agent proposed payment', policy_evaluated: 'Policy evaluated', human_approved: 'Human approved exact terms', human_rejected: 'Human rejected payment', authorization_issued: 'Signed authorization issued', payment_result: 'Executor recorded result', payment_status_checked: 'Payment status checked', execution_interrupted: 'Interrupted execution preserved', execution_uncertain: 'Execution needs reconciliation' };
let state, busy = false, requestMode = 'language', pendingAction = null;
const main = $('#main');
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Request failed.'); error.status = response.status; throw error; }
  return result;
}
function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.className = `toast${error ? ' toast-error' : ''}`; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 5000);
}
async function refresh(renderPage = true) {
  state = await api('/api/state');
  $('#request-count').textContent = state.requests.length;
  $('#approval-count').textContent = state.requests.filter(r => r.status === 'pending_approval').length;
  $('#environment-label').textContent = state.paymentProvider === 'demo' ? 'SIMULATION · NO MONEY MOVES' : 'PAYPAL SANDBOX';
  $('#session-button').textContent = state.operator ? 'Review unlocked · Lock' : 'Unlock review';
  if (renderPage) render();
}
function heading(kicker, title, description, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
function providerNote() {
  return `<div class="provider-note"><span class="system-dot">${state.paymentProvider === 'demo' ? 'Offline demonstration' : 'PayPal sandbox connected mode'}</span><span>Intent provider: ${escape(state.model)}${state.aiProvider === 'demo' ? ' · AI simulation' : ' · Local AI'}</span></div>`;
}
function boundary(compact = false) {
  return `<section class="boundary ${compact ? 'compact' : ''}" aria-label="Payment security boundary"><div class="boundary-heading"><div><div class="eyebrow">THE AUTHORIZATION BOUNDARY</div><h2>Intent is not permission.</h2></div><span class="boundary-tag">3 separate server processes</span></div>
    <div class="boundary-flow"><div class="flow-node"><span class="node-index">01</span><div><strong>AI agent</strong><p>Proposes payment intent</p><span class="credential">No payment credentials</span></div><span class="flow-arrow" aria-hidden="true">→</span></div>
    <div class="flow-node gate"><span class="node-index">02</span><div><strong>PayGuard</strong><p>Checks policy + human approval</p><span class="credential">Signs a time-bound grant</span></div><span class="flow-arrow" aria-hidden="true">→</span></div>
    <div class="flow-node"><span class="node-index">03</span><div><strong>Payment executor</strong><p>Verifies before execution</p><span class="credential">Sandbox credentials live here</span></div></div></div>
    <div class="boundary-foot"><span>Denied request → no grant → no execution</span><span>Deterministic policies. Independent verification.</span></div></section>`;
}
function requestTable(requests, empty = 'No requests yet. Start with the contractor scenario.') {
  if (!requests.length) return `<div class="empty"><span class="empty-symbol">↗</span><h3>${escape(empty)}</h3><p>An agent proposes. PayGuard decides. You stay in control.</p><a class="text-link" href="#new">Propose a payment →</a></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Recipient / invoice</th><th>Amount</th><th>Decision</th><th>Requested</th><th><span class="sr-only">Open request</span></th></tr></thead><tbody>${requests.map(r => `<tr><td><a class="recipient-link" href="#request/${r.id}">${escape(r.intent.recipient)}</a><small>${escape(r.intent.reference)} <span>· ${escape(r.intent.category)}</span></small></td><td class="amount">${money(r.intent)}</td><td>${badge(r.status)}</td><td class="muted nowrap">${date(r.createdAt)}</td><td><a href="#request/${r.id}" class="row-link" aria-label="Review ${escape(r.intent.reference)}">↗</a></td></tr>`).join('')}</tbody></table></div>`;
}
function dashboard() {
  const pending = state.requests.filter(r => r.status === 'pending_approval');
  const blocked = state.requests.filter(r => r.status === 'denied');
  const executions = state.requests.filter(r => ['simulated', 'submitted'].includes(r.status));
  return `${heading('WORKSPACE / OVERVIEW', 'Payment control center', 'Review agent intent, authorize exact terms, and follow every action.', '<a class="primary" href="#new"><span>+</span> New request</a>')}
  ${providerNote()}<section class="metrics" aria-label="Workspace totals"><div><span>Agent requests</span><strong>${state.requests.length.toString().padStart(2, '0')}</strong><small>Structured intents received</small></div><div><span>Awaiting human review <i class="dot amber-dot"></i></span><strong>${pending.length.toString().padStart(2, '0')}</strong><small>Explicit approval required</small></div><div><span>Blocked by policy</span><strong>${blocked.length.toString().padStart(2, '0')}</strong><small>Never reached execution</small></div><div><span>${state.paymentProvider === 'demo' ? 'Simulated executions' : 'Sandbox submissions'}</span><strong>${executions.length.toString().padStart(2, '0')}</strong><small>${state.paymentProvider === 'demo' ? 'No PayPal API calls' : 'Acceptance is not settlement'}</small></div></section>
  ${boundary()}<div class="dashboard-lower"><section class="activity"><div class="section-heading"><h2>Recent agent requests</h2><a class="text-link" href="#requests">View all →</a></div>${requestTable(state.requests.slice(0, 5))}</section>
  <aside class="scenario"><div class="eyebrow">60-SECOND WALKTHROUGH</div><div class="scenario-icon">↗</div><h2>An agent wants to <br>pay a contractor.</h2><p>$120.00. An approved recipient.<br>One human decision before execution.</p><ol><li>Propose an intent</li><li>Review the policy decision</li><li>Approve, then execute</li></ol><a class="primary" href="#new">Try the scenario →</a><small>Also includes an allowed and a blocked request.</small></aside></div>
  <div class="audit-summary"><span class="system-dot">Audit chain verified on startup</span><a href="#audit">${state.auditCount} recorded events <span>→</span></a></div>`;
}
function newRequest() {
  const recipient = state.policy.recipients[0];
  return `${heading('AGENT / NEW REQUEST', 'Propose a payment', 'The agent produces intent. It receives no execution capability.')}
  <div class="compose-layout"><section class="compose"><div class="tabs" role="group" aria-label="Intent input method"><button class="${requestMode === 'language' ? 'active' : ''}" data-action="language">Natural language</button><button class="${requestMode === 'structured' ? 'active' : ''}" data-action="structured">Structured intent</button></div>
    <form id="request-form">${requestMode === 'language' ? '<label for="prompt">What should the agent propose?</label>' : '<h2>Payment terms</h2>'}<textarea id="prompt" name="prompt" rows="5" maxlength="1500" ${requestMode === 'structured' ? 'hidden' : ''}>${escape(`Pay $120 to ${recipient} for contractor invoice INV-${Date.now().toString().slice(-6)}.`)}</textarea>
    ${requestMode === 'language' ? `<div class="input-help">Include an amount, recipient, category, and invoice ID.</div><div class="sample-label">LOAD AN EXAMPLE</div><div class="samples"><button type="button" data-sample="review">$120 · Human review</button><button type="button" data-sample="allow">$24 · Policy allowed</button><button type="button" data-sample="deny">$900 · Blocked</button></div>` : `<div class="structured-grid"><div><label for="amount">Amount</label><input id="amount" name="amount" value="120.00" required pattern="[0-9]+\.[0-9]{2}"></div><div><label for="currency">Currency</label><select id="currency" name="currency"><option>USD</option><option>EUR</option></select></div><div class="full"><label for="recipient">Recipient email</label><input id="recipient" name="recipient" type="email" value="${escape(recipient)}" required></div><div><label for="category">Category</label><select id="category" name="category"><option value="contractor">Contractor</option><option value="software">Software</option></select></div><div><label for="reference">Invoice reference</label><input id="reference" name="reference" value="INV-${Date.now().toString().slice(-6)}" required></div><div class="full"><label for="purpose">Purpose</label><input id="purpose" name="purpose" value="Contractor design work" required maxlength="240"></div></div>`}
    <div class="form-provider"><span class="mini-mark">✧</span><div><strong>${requestMode === 'structured' ? 'Direct structured input' : escape(state.model)}</strong><small>${requestMode === 'structured' ? 'Still validated and evaluated by the gateway' : state.aiProvider === 'demo' ? 'Deterministic demo provider · no model inference' : 'Local model extracts intent · never decides authorization'}</small></div></div>
    <p id="form-error" class="error" role="alert"></p><div class="form-submit"><span>No payment is made at this step.</span><button class="primary" type="submit">Propose & evaluate →</button></div></form></section>
    <aside class="compose-context"><div class="eyebrow">ACTIVE POLICY / V1</div><h2>Permission comes <br>from policy.</h2><dl><div><dt>Payment ceiling</dt><dd>$500.00</dd></div><div><dt>Human review above</dt><dd>$50.00</dd></div><div><dt>Currency</dt><dd>USD</dd></div><div><dt>Grant lifetime</dt><dd>5 minutes</dd></div></dl><p>Only allowlisted recipients and approved categories can proceed. A denial cannot be overridden by the agent or operator.</p><a class="text-link" href="#policies">Inspect all rules →</a><div class="context-boundary"><span>AGENT CAPABILITY</span><strong>Propose intent</strong><small>Payment credentials: none<br>Signing key: none<br>Human session: none</small></div></aside></div>`;
}
function requestDetail(id) {
  const r = state.requests.find(r => r.id === id);
  if (!r) return heading('REQUEST', 'Request not found', 'Return to agent requests to select an existing record.', '<a href="#requests" class="primary">View requests</a>');
  const expired = r.expiresAt <= Date.now();
  const canExecute = ['allowed', 'approved'].includes(r.status) && !expired;
  const pending = r.status === 'pending_approval';
  const denied = ['denied', 'rejected'].includes(r.status);
  const events = state.audit.filter(e => e.requestId === r.id).reverse();
  const decisionTitle = r.status === 'pending_approval' ? 'A human decision is required.' : r.status === 'denied' ? 'This payment is blocked.' : r.status === 'approved' ? 'Approved. Ready for execution.' : r.status === 'allowed' ? 'Within policy. Ready for execution.' : r.status === 'simulated' ? 'Execution simulated.' : r.status === 'submitted' ? 'Submitted to PayPal sandbox.' : r.status === 'rejected' ? 'Rejected by the human operator.' : 'Review execution state.';
  return `${heading(`REQUEST / ${shortId(r.id)}`, 'Payment request', `${escape(r.intent.reference)} · Proposed ${date(r.createdAt)}`, '<a class="quiet" href="#requests">← All requests</a>')}
  <section class="decision-banner ${denied ? 'decision-denied' : ''}"><div><div class="eyebrow">PAYGUARD DECISION</div><h2>${decisionTitle}</h2><p>${denied ? 'No executable authorization exists for this request.' : r.evaluation.decision === 'require_approval' ? 'Payments above $50.00 require explicit human approval.' : 'The executor accepts only a valid signed authorization.'}</p></div>${badge(r.status)}</section>
  <div class="detail-layout"><section><div class="payment-summary"><div class="payment-total"><span>PROPOSED PAYMENT</span><strong>${money(r.intent)}</strong><small>${escape(r.intent.currency)} · ${escape(r.intent.category)}</small></div><dl><div><dt>Recipient</dt><dd>${escape(r.intent.recipient)}</dd></div><div><dt>Invoice</dt><dd>${escape(r.intent.reference)}</dd></div><div><dt>Purpose</dt><dd>${escape(r.intent.purpose)}</dd></div><div><dt>Intent provider</dt><dd>${escape(r.extraction.model)}</dd></div><div><dt>Authorization deadline</dt><dd>${expired ? 'Expired' : date(r.expiresAt)}</dd></div></dl></div>
    <div class="section-heading"><h2>Deterministic policy evaluation</h2><span class="small muted">${escape(r.evaluation.version)}</span></div><div class="rule-list">${r.evaluation.checks.map(c => `<div class="rule"><span class="rule-icon ${!c.pass ? 'fail' : c.review ? 'review' : ''}">${!c.pass ? '×' : c.review ? '!' : '✓'}</span><div><strong>${escape(c.rule)}</strong><small>${escape(c.detail)}</small></div><span class="rule-state">${!c.pass ? 'DENY' : c.review ? 'REVIEW' : 'PASS'}</span></div>`).join('')}</div>
    ${r.receipt ? `<section class="receipt"><div class="eyebrow">${r.receipt.provider === 'demo' ? 'OFFLINE SIMULATION RECEIPT' : 'PAYPAL SANDBOX RECEIPT'}</div><h2>${r.receipt.provider === 'demo' ? 'No money moved.' : 'Payout submitted. Track its status.'}</h2><dl><div><dt>Batch ID</dt><dd class="mono">${escape(r.receipt.batchId)}</dd></div><div><dt>Batch status</dt><dd>${escape(r.receipt.batchStatus)}</dd></div><div><dt>Item status</dt><dd>${escape(r.receipt.itemStatus)}</dd></div><div><dt>Sender batch reference</dt><dd class="mono small">${escape(r.receipt.senderBatchId)}</dd></div><div><dt>Observed</dt><dd>${date(r.receipt.observedAt)}</dd></div></dl><p>${r.receipt.provider === 'demo' ? 'This receipt was generated by the demo provider. No PayPal request was sent.' : 'API acceptance and batch completion do not prove the recipient item settled. Check the item status.'}</p><button class="quiet" data-action="refresh" data-id="${r.id}">Refresh recorded status ↻</button></section>` : ''}
    ${r.error ? `<section class="receipt receipt-error"><h2>Reconciliation required</h2><p>${escape(r.error)}</p><p class="mono small">Sender batch reference: ${escape(r.senderBatchId || r.id)}</p><button class="quiet" data-action="refresh" data-id="${r.id}">Recover recorded result ↻</button></section>` : ''}</section>
    <aside class="review-panel"><div class="eyebrow">HUMAN CONTROL</div><h2>${pending ? 'Review exact terms' : canExecute ? 'Execute authorized intent' : 'Authorization state'}</h2><p>${pending ? 'Confirm the recipient, amount and invoice. Approval applies only to these stored terms.' : canExecute ? 'PayGuard will issue a signed, expiring grant. The separate executor verifies it before payment.' : denied ? 'Blocked requests never receive a signed grant. There is no operator override.' : 'Every transition below is durably recorded.'}</p>
    ${pending ? `<button class="primary full-width" data-action="approve" data-id="${r.id}" ${expired ? 'disabled' : ''}>Approve ${money(r.intent)} →</button><button class="quiet full-width" data-action="reject" data-id="${r.id}">Reject request</button>` : `<button class="primary full-width" data-action="execute" data-id="${r.id}" ${canExecute ? '' : 'disabled'}>${canExecute ? state.paymentProvider === 'demo' ? 'Simulate authorized payment →' : 'Execute sandbox payment →' : denied ? 'Execution blocked' : expired && ['allowed', 'approved'].includes(r.status) ? 'Authorization expired' : 'Execution unavailable'}</button>`}
    <small class="review-hint">${state.operator ? 'Human operator authenticated' : 'Operator authentication required for approval and execution'}${state.paymentProvider === 'demo' ? ' · Simulation only' : ' · Sandbox only'}</small>
    <div class="timeline-heading">REQUEST LIFECYCLE</div><ol class="timeline">${events.map(e => `<li><span class="timeline-dot"></span><strong>${escape(eventLabels[e.type] || e.type)}</strong><small>${escape(e.actor)} · ${date(e.timestamp)}</small></li>`).join('')}</ol><a class="text-link" href="#audit">Inspect the audit trail →</a></aside></div>`;
}
function policies() {
  return `${heading('GATEWAY / POLICIES', 'Explicit rules. Predictable decisions.', 'Versioned server-side policies are independently checked by the executor.')}
  <section class="policy-intro"><span class="eyebrow">${escape(state.policy.version)} / READ ONLY</span><h2>Deny wins. Human approval<br>cannot bypass a failed rule.</h2><p>The AI provider extracts a proposal. These rules decide whether it may proceed.</p></section>
  <div class="policy-grid">${[
    ['01', 'Payment ceiling', '$500.00', 'Any amount above this ceiling is denied. All arithmetic uses integer cents.'],
    ['02', 'Human review threshold', '$50.00', 'Above this amount, an authenticated human must approve the exact stored terms.'],
    ['03', 'Approved currency', 'USD', 'Unsupported currencies are denied, even if the amount is otherwise allowed.'],
    ['04', 'Approved categories', 'Contractor / software', 'A valid schema does not imply an allowed business purpose.'],
    ['05', 'Invoice deduplication', 'Recipient + invoice', 'Reserved invoices cannot execute twice. Changing amount or purpose does not create a new invoice.'],
    ['06', 'Authorization expiry', '5 minutes', 'Expired grants cannot execute. Replays fail even before expiry.']
  ].map(([index,title,value,description]) => `<section class="policy-item"><span class="mono muted">${index}</span><h3>${title}</h3><strong>${value}</strong><p>${description}</p></section>`).join('')}</div>
  <section class="allowlist"><div class="section-heading"><h2>Recipient allowlist</h2><span class="small muted">${state.paymentProvider === 'demo' ? 'Synthetic demo identities' : 'Configured sandbox identity'}</span></div>${state.policy.recipients.map(recipient => `<div><span class="rule-icon">✓</span><strong>${escape(recipient)}</strong><span class="badge green">Approved</span></div>`).join('')}</section>${boundary(true)}`;
}
function audit() {
  return `${heading('EVIDENCE / AUDIT', 'Every stage, recorded.', 'Append-only events with linked SHA-256 digests. No edit or delete endpoints.', '<button class="quiet" data-action="export">Export audit JSON ↓</button>')}
  <div class="audit-integrity"><span class="system-dot">${state.auditCount} events · Chain verified on startup</span><span class="mono">${escape(state.auditDigest.slice(0, 24))}${state.auditDigest === 'GENESIS' ? '' : '…'}</span></div>
  <p class="small muted">Local file-owner rewrites or full-chain truncation need an independent checkpoint to detect. ${state.auditCount > 300 ? 'Showing the latest 300 events; export includes the full journal.' : ''}</p>
  ${state.audit.length ? `<div class="audit-table table-wrap"><table><thead><tr><th>Sequence / time</th><th>Event</th><th>Actor</th><th>Request</th><th>Event digest</th></tr></thead><tbody>${state.audit.map(e => `<tr><td><strong class="mono">${String(e.sequence).padStart(3,'0')}</strong><small>${date(e.timestamp)}</small></td><td>${escape(eventLabels[e.type] || e.type)}<small>${e.data.request ? `${money(e.data.request.intent)} · ${escape(e.data.request.intent.reference)}` : ''}</small></td><td><span class="actor">${escape(e.actor)}</span></td><td><a class="text-link mono" href="#request/${e.requestId}">${shortId(e.requestId)} ↗</a></td><td class="mono muted">${e.digest.slice(0,16)}…</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>No events yet.</h3><p>Propose a payment to create its first audit record.</p><a class="text-link" href="#new">New request →</a></div>'}`;
}
function render() {
  if (!state) return;
  const [view, id] = (location.hash.slice(1) || 'dashboard').split('/');
  const names = { dashboard: 'Overview', requests: 'Agent requests', approvals: 'Human review', policies: 'Policies', audit: 'Audit trail', new: 'New request', request: 'Payment request' };
  $('#page-name').textContent = names[view] || 'Overview';
  for (const link of document.querySelectorAll('[data-nav]')) {
    const selected = link.dataset.nav === view || link.dataset.nav === 'requests' && ['new','request'].includes(view);
    link.classList.toggle('active', selected); if (selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  }
  if (view === 'new') main.innerHTML = newRequest();
  else if (view === 'request') main.innerHTML = requestDetail(id);
  else if (view === 'policies') main.innerHTML = policies();
  else if (view === 'audit') main.innerHTML = audit();
  else if (view === 'requests' || view === 'approvals') {
    const pendingOnly = view === 'approvals';
    main.innerHTML = `${heading(pendingOnly ? 'OPERATOR / REVIEW QUEUE' : 'AGENT / REQUESTS', pendingOnly ? 'Human review' : 'Agent requests', pendingOnly ? 'Review immutable payment terms before granting permission.' : 'Every proposal, policy decision and execution state.', pendingOnly ? '' : '<a class="primary" href="#new">+ New request</a>')}${providerNote()}${requestTable(pendingOnly ? state.requests.filter(r => r.status === 'pending_approval') : state.requests, pendingOnly ? 'No requests awaiting review.' : undefined)}`;
  } else main.innerHTML = dashboard();
  main.classList.remove('arrive'); void main.offsetWidth; main.classList.add('arrive');
}
function login(action = null) {
  pendingAction = action; $('#login-error').textContent = ''; $('#pin').value = '';
  $('#login-hint').textContent = state.paymentProvider === 'demo' ? 'Default offline demo passphrase: payguard-demo. A custom passphrase may be configured.' : 'Use the private operator passphrase configured locally.';
  $('#login-dialog').showModal();
}
async function act(kind, id) {
  if (!state.operator) return login({ kind, id });
  if (busy) return; busy = true;
  const buttons = main.querySelectorAll('button[data-action]'); buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await api(`/api/requests/${id}/${kind}`, {});
    await refresh();
    toast(kind === 'approve' ? 'Human approval recorded. Execution is a separate step.' : kind === 'reject' ? 'Request rejected. No authorization issued.' : kind === 'execute' ? labels[result.status] : 'Recorded status refreshed.');
  } catch (error) { if (error.status === 401) { await refresh(); login({kind,id}); } else { toast(error.message, true); await refresh(); } }
  finally { busy = false; }
}
document.addEventListener('click', async event => {
  const sample = event.target.closest('[data-sample]');
  if (sample) {
    const code = Date.now().toString().slice(-6), kind = sample.dataset.sample;
    const value = kind === 'deny' ? `Pay $900 to unknown@example.test for contractor invoice INV-${code}.` : `Pay $${kind === 'allow' ? '24' : '120'} to ${state.policy.recipients[0]} for contractor invoice INV-${code}.`;
    $('#prompt').value = value; $('#prompt').focus(); return;
  }
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (['language','structured'].includes(action)) { requestMode = action; render(); }
  else if (action === 'export') {
    if (!state.operator) return login();
    try { const data = await api('/api/audit/export'); const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'payguard-audit.json'; link.click(); URL.revokeObjectURL(link.href); }
    catch (error) { toast(error.message, true); }
  } else await act(action, id);
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'request-form') return;
  event.preventDefault(); if (busy) return; busy = true;
  const form = event.target, button = form.querySelector('[type="submit"]'); button.disabled = true; button.textContent = 'Evaluating…'; $('#form-error').textContent = '';
  const data = new FormData(form);
  const payload = requestMode === 'language' ? { prompt: data.get('prompt') } : { intent: Object.fromEntries(['amount','currency','recipient','category','reference','purpose'].map(k => [k,data.get(k)])) };
  try { const r = await api('/api/requests',payload); await refresh(false); location.hash = `request/${r.id}`; }
  catch (error) { $('#form-error').textContent = error.message; }
  finally { busy = false; button.disabled = false; button.textContent = 'Propose & evaluate →'; }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api('/api/session', { pin: $('#pin').value }); $('#login-dialog').close(); await refresh();
    const next = pendingAction; pendingAction = null;
    if (next) toast('Review unlocked. Inspect the terms and click the action again to confirm.'); else toast('Human review unlocked for 30 minutes.');
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#close-login').addEventListener('click', () => { pendingAction = null; $('#login-dialog').close(); });
$('#session-button').addEventListener('click', async () => { if (state?.operator) { await api('/api/logout',{}); await refresh(); toast('Human review locked.'); } else login(); });
window.addEventListener('hashchange', () => { render(); window.scrollTo(0,0); });
window.addEventListener('focus', () => { if (!busy && !$('#login-dialog').open && !$('#request-form')) refresh().catch(error => toast(error.message,true)); });
refresh().catch(error => { main.innerHTML = heading('CONNECTION', 'Workspace unavailable', escape(error.message)); });
