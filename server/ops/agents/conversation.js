// Agent B - Voice & Conversation (server side). The browser does speech-to-text and text-to-speech
// (Web Speech API); this agent keeps multi-turn context and turns each utterance into an action:
// start a workflow, answer a clarification, approve/reject, or cancel.
import pool from '../../db.js';
import * as engine from '../engine.js';
import { applyContext, contextOf, createEmployeeIntent, fillEmployeeSlots } from './supervisor.js';

const conversations = new Map(); // conversationId -> { history, lastWorkflowId, owner }

const APPROVE = /^\s*(yes|yep|approve[sd]?|approved|go ahead|confirm(ed)?|proceed|do it|execute)\b/i;
const REJECT = /^\s*(no|reject(ed)?|deny|don'?t)\b/i;
const CANCEL = /^\s*(cancel|stop|abort|never ?mind)\b/i;
const ORDINALS = { first: 0, '1': 0, one: 0, second: 1, '2': 1, two: 1, third: 2, '3': 2, three: 2, fourth: 3, '4': 3 };

function state(id, principal) {
  let s = conversations.get(id);
  if (!s || s.owner !== principal.username) {
    s = { history: [], lastWorkflowId: null, workflowIds: [], context: null, owner: principal.username };
    conversations.set(id, s);
  }
  return s;
}

function pickOption(text, options) {
  const lower = text.toLowerCase();
  const byId = options.find(o => lower.includes(String(o.id).toLowerCase()));
  if (byId) return byId;
  const ord = lower.match(/\b(first|second|third|fourth|one|two|three|1|2|3|4)\b/);
  if (ord && options[ORDINALS[ord[1]]]) return options[ORDINALS[ord[1]]];
  // Match on a distinctive label word, e.g. "the Lenovo one".
  const hits = options.filter(o => o.label.toLowerCase().split(/[\s()-]+/).some(w => w.length > 3 && lower.includes(w) && !/assigned|available/.test(w)));
  return hits.length === 1 ? hits[0] : null;
}

export async function handleTurn({ conversationId, text, principal, token, strategy }) {
  const s = state(conversationId, principal);
  s.history.push({ role: 'user', text });
  const last = s.lastWorkflowId ? engine.getLive(s.lastWorkflowId) : null;
  const reply = (r) => { s.history.push({ role: 'assistant', text: r.reply }); return r; };
  const remember = id => { s.lastWorkflowId = id; s.workflowIds.push(id); };
  const lastCtx = contextOf(last);
  if (lastCtx) s.context = lastCtx;
  const waiting = [...s.workflowIds].reverse().map(id => engine.getLive(id)).find(w => w?.status === 'WAITING_FOR_APPROVAL');

  if (waiting && (APPROVE.test(text) || REJECT.test(text) || (CANCEL.test(text) && last === waiting))) {
    const last = waiting;
    if (APPROVE.test(text)) {
      await engine.approve(last.id, { principal, token, note: `voice/text: "${text.slice(0, 80)}"` });
      remember(last.id); // follow-ups now refer to this workflow (e.g. "it" = the newly issued device)
      return reply({ action: 'approved', workflow_id: last.id, reply: 'Approved. Executing and verifying now.' });
    }
    if (REJECT.test(text) || CANCEL.test(text)) {
      await engine.reject(last.id, { principal, token, note: `voice/text: "${text.slice(0, 80)}"` });
      return reply({ action: 'rejected', workflow_id: last.id, reply: 'Rejected. No records were changed and the reservation was released.' });
    }
  }
  if (!waiting && (APPROVE.test(text) || REJECT.test(text)) && text.trim().split(/\s+/).length <= 3) {
    return reply({ action: 'none', reply: 'There is nothing waiting for approval right now.' });
  }
  if (last && ['RUNNING', 'PENDING'].includes(last.status) && CANCEL.test(text)) {
    await engine.cancel(last.id, { principal, token });
    return reply({ action: 'cancelled', workflow_id: last.id, reply: 'Cancelling the running workflow.' });
  }

  // Step-by-step employee creation: treat the reply as the missing ID and/or name.
  if (last?.status === 'WAITING_FOR_INPUT' && last.intent?.intent === 'create_employee') {
    if (CANCEL.test(text) || REJECT.test(text)) {
      last.status = 'CANCELLED';
      await pool.query("UPDATE ops_workflows SET status = 'CANCELLED', error_message = 'Cancelled by user' WHERE id = ?", [last.id]);
      return reply({ action: 'cancelled', reply: 'Okay, not adding anyone.' });
    }
    const before = last.intent.new_employee || {};
    const filled = fillEmployeeSlots(before, text);
    if (filled.emp_id !== before.emp_id || filled.employee_name !== before.employee_name || filled.email !== before.email) {
      const intentOverride = createEmployeeIntent(filled);
      const wf = await engine.startWorkflow({ request: `add employee ${filled.emp_id || '?'} ${filled.employee_name || '?'}`, principal, token, conversationId, parentId: last.id, strategy, intentOverride });
      await pool.query("UPDATE ops_workflows SET status = 'CANCELLED', error_message = CONCAT('Superseded by ', ?) WHERE id = ? AND status = 'WAITING_FOR_INPUT'", [wf.id, last.id]);
      last.status = 'CANCELLED';
      remember(wf.id);
      const got = [filled.emp_id && `ID ${filled.emp_id}`, filled.employee_name && `name ${filled.employee_name}`].filter(Boolean).join(', ');
      return reply({ action: 'clarified', workflow_id: wf.id, reply: `Got it: ${got}.` });
    }
  }

  if (last?.status === 'WAITING_FOR_INPUT' && last.error?.details?.options) {
    const choice = pickOption(text, last.error.details.options);
    if (choice) {
      const intentOverride = { ...last.intent, [choice.kind === 'asset' ? 'asset_ref' : 'employee_ref']: choice.id };
      const wf = await engine.startWorkflow({ request: `${last.request} -> ${choice.label}`, principal, token, conversationId, parentId: last.id, strategy, intentOverride });
      await pool.query("UPDATE ops_workflows SET status = 'CANCELLED', error_message = CONCAT('Superseded by ', ?) WHERE id = ? AND status = 'WAITING_FOR_INPUT'", [wf.id, last.id]);
      last.status = 'CANCELLED';
      remember(wf.id);
      return reply({ action: 'clarified', workflow_id: wf.id, reply: `Got it: ${choice.label}. Continuing.` });
    }
  }

  // Follow-up questions reuse the employee/asset resolved in the previous turn.
  const intentOverride = applyContext(text, s.context) || undefined;
  const wf = await engine.startWorkflow({ request: text, principal, token, conversationId, strategy, history: s.history.slice(0, -1), intentOverride, parentId: intentOverride ? s.context.workflow_id : undefined });
  remember(wf.id);
  const i = wf.intent;
  const what = {
    replace_device: `Planning a replacement${i.employee_ref ? ` for ${i.employee_ref}` : ''}${i.device_type ? ` (${i.device_type.toLowerCase()})` : ''}.`,
    lookup_asset: `Looking up ${i.asset_ref}.`, lookup_employee: `Looking up ${i.employee_ref}.`,
    check_inventory: `Checking ${i.device_type} stock.`, diagnose: 'Running triage.',
    create_employee: i.new_employee?.emp_id && i.new_employee?.employee_name ? `Preparing to add employee ${i.new_employee.emp_id} - ${i.new_employee.employee_name}.` : 'Adding a new employee.',
    assign_asset: `Preparing assignment of ${i.asset_ref}.`, withdraw_asset: `Preparing withdrawal of ${i.asset_ref}.`,
  }[i.intent] || 'Let me check.';
  const ctxNote = intentOverride ? ` (about ${[intentOverride.employee_ref, intentOverride.asset_ref].filter(Boolean).join(' / ')} from earlier)` : '';
  return reply({ action: 'started', workflow_id: wf.id, reply: what + ctxNote });
}
