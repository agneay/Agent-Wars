// Workflow engine: dependency-aware scheduling, bounded concurrency, timeouts, bounded retries with
// backoff, human approval gates, cancellation, persistence and resumption from the database.
import crypto from 'crypto';
import pool from '../db.js';
import { mcpSession } from './mcp/client.js';
import { buildPlan, parseIntent, summarize } from './agents/supervisor.js';
import { recommendStrategy } from './agents/feedback.js';
import { releaseReservation } from './agents/execution.js';
import * as store from './store.js';
import { OpsError, redact, sleep, toOpsError } from './util.js';

const MAX_CONCURRENCY = Number(process.env.OPS_MAX_CONCURRENCY || 6);
const FINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const live = new Map(); // workflowId -> Workflow

class Workflow {
  constructor(init) {
    Object.assign(this, init);
    this.tasks = new Map();
    this.results = {};
    this.notes = [];
    this.toolCalls = [];
    this.seq = 0;
    this.listeners = new Set();
    this.abort = new AbortController();
    this.t0 = performance.now();
    this.m = { llm_calls: 0, llm_input_tokens: 0, llm_output_tokens: 0, tool_calls: 0, db_queries: 0, retries: 0, approval_wait_ms: 0, prior_agent_ms: 0 };
  }

  rel() { return Math.round(performance.now() - this.t0); }

  emit(type, payload = {}) {
    const ev = { seq: ++this.seq, type, ts: Date.now(), t: this.rel(), payload };
    if (this.m.first_event_ms == null) this.m.first_event_ms = ev.t;
    store.appendEvent(this.id, ev);
    for (const fn of this.listeners) { try { fn(ev); } catch { /* listener errors never affect execution */ } }
    return ev;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    store.updateWorkflow(this.id, { status, ...extra });
    this.emit('workflow.status', { status });
  }

  metrics() {
    const toolMs = this.toolCalls.map(c => c.client_ms);
    const running = this.status === 'WAITING_FOR_APPROVAL' && this.waitStartedAt ? performance.now() - this.waitStartedAt : 0;
    const wall = this.endRel ?? this.rel(); // frozen once the workflow reaches a final state
    return {
      ...this.m,
      wall_ms: wall,
      // Primary metric: agent time to the current state, excluding time spent waiting for a human.
      agent_ms: Math.round(this.m.prior_agent_ms + wall - this.m.approval_wait_ms - running),
      tool_ms_total: Math.round(toolMs.reduce((a, b) => a + b, 0)),
      tasks: Object.fromEntries([...this.tasks.values()].map(t => [t.key, { agent: t.agent, status: t.status, ms: t.durationMs ?? null, attempts: t.attempts }])),
    };
  }

  snapshot() {
    return {
      id: this.id, status: this.status, request: this.request, intent: this.intent, strategy: this.strategy,
      strategy_reason: this.strategyReason, plan_version: this.planVersion, created_by: this.principal.username,
      conversation_id: this.conversationId, parent_id: this.parentId,
      tasks: [...this.tasks.values()].map(t => ({
        key: t.key, agent: t.agent, title: t.title, deps: t.deps, status: t.status, attempts: t.attempts,
        start_ms: t.startMs ?? null, end_ms: t.endMs ?? null, duration_ms: t.durationMs ?? null,
        error: t.error ? t.error.toJSON?.() || t.error : null, output: t.output ?? null, optional: Boolean(t.optional), gate: t.gate || null,
      })),
      approval: this.approval || null, summary: this.summary || null, error: this.error?.toJSON?.() || this.error || null,
      notes: this.notes, tool_calls: this.toolCalls, metrics: this.metrics(),
    };
  }
}

// ------------------------------------------------------------------ public API

export async function startWorkflow({ request, principal, token, conversationId, parentId, strategy = 'auto', isBenchmark = false, autoApprove = false, history = [], intentOverride }) {
  const wf = new Workflow({ id: crypto.randomUUID(), request, principal, token, conversationId, parentId, isBenchmark, autoApprove, status: 'PENDING' });
  live.set(wf.id, wf);

  wf.intent = intentOverride || await parseIntent(request, {
    history,
    onLlmCall: u => { wf.m.llm_calls++; wf.m.llm_input_tokens += u.input_tokens || 0; wf.m.llm_output_tokens += u.output_tokens || 0; },
  });
  const plan = buildPlan(wf.intent, principal);
  wf.planVersion = plan.planVersion;
  wf.planNote = plan.note;
  if (strategy === 'auto') {
    const rec = await recommendStrategy(plan.planVersion);
    wf.strategy = rec.strategy; wf.strategyReason = `auto: ${rec.reason}`;
  } else {
    wf.strategy = strategy; wf.strategyReason = 'requested';
  }
  for (const def of plan.tasks) wf.tasks.set(def.key, { ...def, status: 'PENDING', attempts: 0 });

  await store.insertWorkflow(wf);
  wf.emit('workflow.created', { request, principal: principal.username });
  wf.emit('intent.parsed', wf.intent);
  store.insertTasks(wf.id, plan.tasks.map(t => ({ ...t, status: 'PENDING' })));
  wf.emit('plan.created', { plan_version: wf.planVersion, strategy: wf.strategy, strategy_reason: wf.strategyReason, tasks: plan.tasks.map(t => ({ key: t.key, agent: t.agent, title: t.title, deps: t.deps, gate: t.gate || null })) });
  store.updateWorkflow(wf.id, { intent: wf.intent });

  if (plan.forbidden) { finishEarly(wf, new OpsError('FORBIDDEN', plan.forbidden)); return wf; }
  if (!plan.tasks.length) {
    finishEarly(wf, new OpsError('NEEDS_INPUT', wf.intent.clarification || 'I could not tell what to do. Mention an employee ID (e.g. E102), an asset ID, or a device type.', {
      details: wf.intent.clarification ? {} : { question: 'What would you like me to do?' },
    }));
    return wf;
  }
  wf.mcp = makeMcp(wf);
  run(wf).catch(e => console.error('[engine] run crashed', e));
  return wf;
}

export const getLive = id => live.get(id);

export function subscribe(id, fn) {
  const wf = live.get(id);
  if (!wf) return null;
  wf.listeners.add(fn);
  return () => wf.listeners.delete(fn);
}

export async function approve(id, { principal, token, note }) {
  if (principal.role !== 'admin') throw new OpsError('FORBIDDEN', 'Only an admin can approve changes');
  const wf = live.get(id) || await rehydrate(id, token, principal);
  if (wf.status !== 'WAITING_FOR_APPROVAL' || !wf.approval) throw new OpsError('INVALID_STATE', `Workflow is ${wf.status}, not waiting for approval`);
  const [res] = await pool.query(
    "UPDATE ops_approvals SET status = 'APPROVED', decided_by = ?, decided_at = NOW(3), decision_note = ? WHERE id = ? AND workflow_id = ? AND status = 'PENDING'",
    [principal.username, note || null, wf.approval.approval_id, id]);
  if (res.affectedRows !== 1) throw new OpsError('CONFLICT', 'Approval was already decided');
  wf.approval = { ...wf.approval, status: 'APPROVED', decided_by: principal.username };
  wf.emit('approval.decided', { approval_id: wf.approval.approval_id, decision: 'APPROVED', by: principal.username });
  // Post-approval steps run under the approver's identity, so history records who executed them.
  wf.token = token; wf.execPrincipal = principal; wf.mcp = makeMcp(wf);
  if (wf.waitStartedAt) { wf.m.approval_wait_ms += performance.now() - wf.waitStartedAt; wf.waitStartedAt = null; }
  for (const t of wf.tasks.values()) if (t.status === 'WAITING_FOR_APPROVAL') setTask(wf, t, { status: 'PENDING' });
  run(wf).catch(e => console.error('[engine] run crashed', e));
  return wf.snapshot();
}

export async function reject(id, { principal, token, note }) {
  if (principal.role !== 'admin') throw new OpsError('FORBIDDEN', 'Only an admin can reject changes');
  const wf = live.get(id) || await rehydrate(id, token, principal);
  if (wf.status !== 'WAITING_FOR_APPROVAL') throw new OpsError('INVALID_STATE', `Workflow is ${wf.status}, not waiting for approval`);
  await pool.query(
    "UPDATE ops_approvals SET status = 'REJECTED', decided_by = ?, decided_at = NOW(3), decision_note = ? WHERE id = ? AND status = 'PENDING'",
    [principal.username, note || null, wf.approval.approval_id]);
  wf.approval = { ...wf.approval, status: 'REJECTED', decided_by: principal.username };
  wf.emit('approval.decided', { approval_id: wf.approval.approval_id, decision: 'REJECTED', by: principal.username });
  await cleanupAndCancel(wf, 'Rejected by approver');
  return wf.snapshot();
}

export async function cancel(id, { principal, token }) {
  const wf = live.get(id) || await rehydrate(id, token, principal);
  if (FINAL.has(wf.status)) throw new OpsError('INVALID_STATE', `Workflow already ${wf.status}`);
  if (wf.principal.username !== principal.username && principal.role !== 'admin') throw new OpsError('FORBIDDEN', 'Not your workflow');
  wf.abort.abort();
  if (wf.status === 'WAITING_FOR_APPROVAL' && wf.approval) {
    await pool.query("UPDATE ops_approvals SET status = 'CANCELLED', decided_by = ?, decided_at = NOW(3) WHERE id = ? AND status = 'PENDING'", [principal.username, wf.approval.approval_id]);
  }
  if (!wf.running) await cleanupAndCancel(wf, `Cancelled by ${principal.username}`);
  else wf.cancelReason = `Cancelled by ${principal.username}`; // run loop finishes the cleanup
  return wf.snapshot();
}

// ------------------------------------------------------------------ internals

function makeMcp(wf) {
  return mcpSession({
    token: wf.token, workflowId: wf.id,
    onCall: c => {
      wf.m.tool_calls++;
      wf.m.db_queries += c.meta?.db_queries || 0;
      if (c.ok && wf.m.first_action_ms == null) wf.m.first_action_ms = wf.rel();
      const rec = { tool: c.tool, task: c.taskKey, ok: c.ok, error_code: c.error?.code || null, client_ms: c.client_ms, server_ms: c.meta?.server_ms ?? null, db_queries: c.meta?.db_queries ?? 0, t: wf.rel(), args: redact(c.args) };
      wf.toolCalls.push(rec);
      wf.emit('tool.call', rec);
    },
  });
}

function setTask(wf, t, patch) {
  Object.assign(t, patch);
  store.updateTask(wf.id, t);
}

function depsSatisfied(wf, t) {
  return t.deps.every(d => {
    const dep = wf.tasks.get(d);
    return !dep || dep.status === 'SUCCEEDED' || (dep.optional && dep.status === 'FAILED');
  });
}
function depsBroken(wf, t) {
  return t.deps.some(d => {
    const dep = wf.tasks.get(d);
    return dep && ['SKIPPED', 'CANCELLED'].includes(dep.status) || (dep?.status === 'FAILED' && !dep.optional);
  });
}

async function run(wf) {
  if (wf.running) return;
  wf.running = true;
  if (wf.status !== 'RUNNING') wf.setStatus('RUNNING');
  const limit = wf.strategy === 'sequential' ? 1 : MAX_CONCURRENCY;
  const inflight = new Map();
  try {
    for (;;) {
      const halted = wf.abort.signal.aborted || Boolean(wf.error);
      for (const t of wf.tasks.values()) {
        if (t.status === 'PENDING' && depsBroken(wf, t)) {
          setTask(wf, t, { status: 'SKIPPED' });
          wf.emit('task.skipped', { key: t.key, reason: 'dependency did not succeed' });
        }
      }
      if (!halted) {
        for (const t of wf.tasks.values()) {
          if (inflight.size >= limit) break;
          if (t.status !== 'PENDING' || !depsSatisfied(wf, t)) continue;
          if (t.gate === 'approval' && wf.approval?.status !== 'APPROVED') {
            setTask(wf, t, { status: 'WAITING_FOR_APPROVAL' });
            continue;
          }
          inflight.set(t.key, runTask(wf, t).then(() => t.key));
        }
      }
      if (!inflight.size) break;
      inflight.delete(await Promise.race(inflight.values()));
    }
  } finally {
    wf.running = false;
  }
  await finalize(wf);
}

async function runTask(wf, t) {
  const maxAttempts = 1 + (t.retries ?? 0);
  while (t.attempts < maxAttempts) {
    setTask(wf, t, { status: 'RUNNING', attempts: t.attempts + 1, startedAt: t.startedAt || Date.now(), startMs: t.startMs ?? wf.rel(), error: null });
    wf.emit('task.started', { key: t.key, agent: t.agent, attempt: t.attempts });
    const taskAbort = new AbortController();
    const onWfAbort = () => taskAbort.abort();
    wf.abort.signal.addEventListener('abort', onWfAbort, { once: true });
    const ctx = {
      workflowId: wf.id, intent: wf.intent, results: wf.results, principal: wf.execPrincipal || wf.principal, signal: taskAbort.signal,
      mcp: { call: (tool, args) => wf.mcp.call(tool, args, { taskKey: t.key, signal: taskAbort.signal, timeoutMs: t.timeoutMs }) },
      note: msg => { wf.notes.push(msg); wf.emit('note', { key: t.key, message: msg }); },
    };
    let timer;
    try {
      const output = await Promise.race([
        t.run(ctx),
        new Promise((_, rej) => { timer = setTimeout(() => { taskAbort.abort(); rej(new OpsError('TIMEOUT', `${t.title} exceeded ${t.timeoutMs}ms`, { retryable: true })); }, t.timeoutMs); }),
      ]);
      wf.results[t.key] = output;
      const endMs = wf.rel();
      setTask(wf, t, { status: 'SUCCEEDED', output, completedAt: Date.now(), endMs, durationMs: endMs - t.startMs });
      wf.emit('task.succeeded', { key: t.key, duration_ms: t.durationMs });
      if (t.key === 'prepare_change') await onApprovalRequested(wf, output);
      return;
    } catch (raw) {
      const e = wf.abort.signal.aborted ? new OpsError('CANCELLED', 'Workflow cancelled') : toOpsError(raw);
      const canRetry = e.retryable && t.attempts < maxAttempts && !wf.abort.signal.aborted;
      if (canRetry) {
        wf.m.retries++;
        const backoff = Math.min(2000, 100 * 2 ** (t.attempts - 1)) + Math.floor(Math.random() * 50);
        wf.emit('task.retry', { key: t.key, attempt: t.attempts, error: e.toJSON(), backoff_ms: backoff });
        try { await sleep(backoff, wf.abort.signal); } catch { /* cancelled during backoff */ }
        continue;
      }
      const endMs = wf.rel();
      setTask(wf, t, { status: e.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', error: e, completedAt: Date.now(), endMs, durationMs: endMs - t.startMs });
      wf.emit('task.failed', { key: t.key, error: e.toJSON(), optional: Boolean(t.optional) });
      if (!t.optional && e.code !== 'CANCELLED' && !wf.error) wf.error = e;
      return;
    } finally {
      clearTimeout(timer);
      wf.abort.signal.removeEventListener('abort', onWfAbort);
    }
  }
}

async function onApprovalRequested(wf, prep) {
  wf.approval = { approval_id: prep.approval_id, status: 'PENDING', actions: prep.actions, dry_run: prep.dry_run };
  wf.m.approval_ready_ms = wf.rel();
  wf.emit('approval.requested', wf.approval);
  if (wf.autoApprove) {
    // Benchmark runs only: an explicit, audited machine approval so full flows can be timed.
    await pool.query(
      "UPDATE ops_approvals SET status = 'APPROVED', decided_by = ?, decided_at = NOW(3), decision_note = 'benchmark auto-approval' WHERE id = ? AND status = 'PENDING'",
      [`benchmark:${wf.principal.username}`, prep.approval_id]);
    wf.approval.status = 'APPROVED';
    wf.approval.decided_by = `benchmark:${wf.principal.username}`;
    wf.emit('approval.decided', { approval_id: prep.approval_id, decision: 'APPROVED', by: wf.approval.decided_by, automatic: true });
  }
}

async function finalize(wf) {
  if (wf.abort.signal.aborted) return cleanupAndCancel(wf, wf.cancelReason || 'Cancelled');
  if (wf.error) {
    for (const t of wf.tasks.values()) {
      if (['PENDING', 'WAITING_FOR_APPROVAL'].includes(t.status)) setTask(wf, t, { status: 'SKIPPED' });
    }
  }
  const waiting = [...wf.tasks.values()].some(t => t.status === 'WAITING_FOR_APPROVAL');
  let status;
  if (wf.error) status = wf.error.code === 'NEEDS_INPUT' ? 'WAITING_FOR_INPUT' : 'FAILED';
  else if (waiting) status = 'WAITING_FOR_APPROVAL';
  else status = 'SUCCEEDED';
  if (status === 'FAILED' && wf.results.reserve_replacement?.reservation_id && !wf.results.execute_change) {
    await releaseReservation(wf.mcp, wf.results.reserve_replacement.reservation_id).catch(() => {});
    wf.notes.push('Reservation released because the workflow failed before execution');
  }
  if (status === 'WAITING_FOR_APPROVAL') wf.waitStartedAt = performance.now();
  else wf.endRel = wf.rel();
  wf.status = status;
  wf.summary = summarize(wf);
  const metrics = wf.metrics();
  store.updateWorkflow(wf.id, {
    status, summary: wf.summary, metrics,
    error_code: wf.error?.code || null, error_message: wf.error?.message || null,
    ...(FINAL.has(status) || status === 'WAITING_FOR_INPUT' ? { completed_at: new Date() } : {}),
  });
  wf.emit('workflow.summary', { summary: wf.summary, metrics, error: wf.error?.toJSON?.() || null });
  wf.emit('workflow.status', { status });
  await store.flush(wf.id);
  if (FINAL.has(status) || status === 'WAITING_FOR_INPUT') setTimeout(() => live.delete(wf.id), 60 * 60 * 1000).unref();
}

function finishEarly(wf, error) {
  wf.error = error;
  finalize(wf).catch(e => console.error('[engine] finalize failed', e));
}

async function cleanupAndCancel(wf, reason) {
  const resId = wf.results.reserve_replacement?.reservation_id;
  if (resId && !wf.results.execute_change) {
    const mcp = wf.mcp || makeMcp(wf);
    await releaseReservation(mcp, resId).then(() => wf.notes.push('Reservation released')).catch(e => wf.notes.push(`Reservation release failed: ${e.message}`));
  }
  for (const t of wf.tasks.values()) {
    if (['PENDING', 'WAITING_FOR_APPROVAL', 'RUNNING'].includes(t.status)) setTask(wf, t, { status: 'CANCELLED' });
  }
  wf.notes.push(reason);
  wf.endRel = wf.rel();
  wf.status = 'CANCELLED';
  wf.summary = summarize(wf);
  store.updateWorkflow(wf.id, { status: 'CANCELLED', summary: wf.summary, metrics: wf.metrics(), completed_at: new Date(), error_code: 'CANCELLED', error_message: reason });
  wf.emit('workflow.summary', { summary: wf.summary, metrics: wf.metrics() });
  wf.emit('workflow.status', { status: 'CANCELLED' });
  await store.flush(wf.id);
}

/** Rebuilds a workflow from the database (e.g. after a server restart) so it can be approved/resumed. */
async function rehydrate(id, token, principal) {
  const row = await store.loadWorkflowRow(id);
  if (!row) throw new OpsError('NOT_FOUND', `Workflow ${id} does not exist`);
  const owner = { username: row.created_by, role: row.created_role };
  const wf = new Workflow({
    id, request: row.request_text, principal: owner, token, conversationId: row.conversation_id, parentId: row.parent_id,
    isBenchmark: Boolean(row.is_benchmark), status: row.status, intent: row.intent, strategy: row.strategy, strategyReason: row.strategy_reason,
  });
  wf.seq = (await pool.query('SELECT COALESCE(MAX(seq), 0) AS s FROM ops_events WHERE workflow_id = ?', [id]))[0][0].s;
  const plan = buildPlan(row.intent, owner);
  wf.planVersion = plan.planVersion;
  const persisted = new Map(row.tasks.map(t => [t.task_key, t]));
  for (const def of plan.tasks) {
    const p = persisted.get(def.key);
    // A task interrupted mid-run is safe to re-run: reads are pure and mutations are idempotent.
    const status = !p ? 'PENDING' : p.status === 'RUNNING' ? 'PENDING' : p.status;
    wf.tasks.set(def.key, { ...def, status, attempts: p?.attempts || 0, output: p?.output, durationMs: p?.duration_ms });
    if (p?.status === 'SUCCEEDED') wf.results[def.key] = p.output;
  }
  wf.m.prior_agent_ms = row.metrics?.agent_ms || 0;
  wf.m.approval_wait_ms = 0;
  const [[ap]] = await pool.query("SELECT id, status, actions FROM ops_approvals WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1", [id]);
  if (ap) wf.approval = { approval_id: ap.id, status: ap.status, actions: typeof ap.actions === 'string' ? JSON.parse(ap.actions) : ap.actions };
  wf.mcp = makeMcp(wf);
  live.set(id, wf);
  wf.emit('workflow.resumed', { by: principal.username });
  return wf;
}
