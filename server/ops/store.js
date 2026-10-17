// Persistence for workflow state and the audit trail.
import pool from '../db.js';

const j = v => (v === undefined ? null : JSON.stringify(v));
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

// Writes are queued per workflow and applied in order without blocking the critical path.
// flush(id) awaits everything queued so far (called before a workflow reports a final state).
const queues = new Map();
function enqueue(workflowId, fn) {
  const prev = queues.get(workflowId) || Promise.resolve();
  const next = prev.then(fn).catch(e => console.error(`[ops-store] write failed for ${workflowId}:`, e.message));
  queues.set(workflowId, next);
  return next;
}
export const flush = workflowId => queues.get(workflowId) || Promise.resolve();

export async function insertWorkflow(wf) {
  await pool.query(
    `INSERT INTO ops_workflows (id, parent_id, conversation_id, request_text, intent, plan_version, strategy, strategy_reason, status,
       created_by, created_role, is_benchmark, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [wf.id, wf.parentId || null, wf.conversationId || null, wf.request, j(wf.intent), wf.planVersion, wf.strategy, wf.strategyReason,
      wf.status, wf.principal.username, wf.principal.role, wf.isBenchmark ? 1 : 0]);
}

export function insertTasks(workflowId, tasks) {
  if (!tasks.length) return Promise.resolve();
  return enqueue(workflowId, () => pool.query(
    `INSERT INTO ops_tasks (workflow_id, task_key, agent, title, depends_on, status) VALUES ${tasks.map(() => '(?, ?, ?, ?, ?, ?)').join(',')}
     ON DUPLICATE KEY UPDATE status = VALUES(status)`,
    tasks.flatMap(t => [workflowId, t.key, t.agent, t.title, j(t.deps), t.status])));
}

export function updateTask(workflowId, t) {
  return enqueue(workflowId, () => pool.query(
    `UPDATE ops_tasks SET status = ?, attempts = ?, output = ?, error_code = ?, error_message = ?,
       started_at = ?, completed_at = ?, duration_ms = ? WHERE workflow_id = ? AND task_key = ?`,
    [t.status, t.attempts, j(t.output), t.error?.code || null, t.error?.message || null,
      t.startedAt ? new Date(t.startedAt) : null, t.completedAt ? new Date(t.completedAt) : null,
      t.durationMs ?? null, workflowId, t.key]));
}

export function updateWorkflow(workflowId, fields) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = ?`);
    vals.push(['intent', 'summary', 'metrics'].includes(k) ? j(v) : v);
  }
  cols.push('row_version = row_version + 1');
  return enqueue(workflowId, () => pool.query(`UPDATE ops_workflows SET ${cols.join(', ')} WHERE id = ?`, [...vals, workflowId]));
}

export function appendEvent(workflowId, ev) {
  return enqueue(workflowId, () => pool.query(
    'INSERT INTO ops_events (workflow_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
    [workflowId, ev.seq, ev.type, j(ev.payload), new Date(ev.ts)]));
}

export async function loadWorkflowRow(id) {
  const [[wf]] = await pool.query('SELECT * FROM ops_workflows WHERE id = ?', [id]);
  if (!wf) return null;
  const [tasks] = await pool.query('SELECT * FROM ops_tasks WHERE workflow_id = ?', [id]);
  return { ...wf, intent: parse(wf.intent), summary: parse(wf.summary), metrics: parse(wf.metrics), tasks: tasks.map(t => ({ ...t, depends_on: parse(t.depends_on), output: parse(t.output) })) };
}

export async function getWorkflowSnapshot(id) {
  const wf = await loadWorkflowRow(id);
  if (!wf) return null;
  const [[approvals], [toolCalls], [reports], [feedback], [events]] = await Promise.all([
    pool.query('SELECT * FROM ops_approvals WHERE workflow_id = ? ORDER BY created_at', [id]),
    pool.query('SELECT id, task_key, tool, principal, args_redacted, result_summary, ok, error_code, server_ms, db_queries, created_at FROM ops_tool_calls WHERE workflow_id = ? ORDER BY id', [id]),
    pool.query('SELECT id, content, created_by, created_at FROM ops_handover_reports WHERE workflow_id = ?', [id]),
    pool.query('SELECT id, rating, comment, created_by, created_at FROM ops_feedback WHERE workflow_id = ? ORDER BY id', [id]),
    pool.query('SELECT seq, type, payload, ts FROM ops_events WHERE workflow_id = ? ORDER BY seq', [id]),
  ]);
  return {
    ...wf,
    approvals: approvals.map(a => ({ ...a, actions: parse(a.actions) })),
    tool_calls: toolCalls.map(t => ({ ...t, args_redacted: parse(t.args_redacted), result_summary: parse(t.result_summary) })),
    report: reports[0] ? { ...reports[0], content: parse(reports[0].content) } : null,
    feedback,
    events: events.map(e => ({ ...e, payload: parse(e.payload) })),
  };
}

export async function listWorkflows({ limit = 30, includeBenchmark = false } = {}) {
  const [rows] = await pool.query(
    `SELECT id, request_text, status, strategy, plan_version, created_by, is_benchmark, error_code, created_at, completed_at,
            JSON_EXTRACT(metrics, '$.agent_ms') AS agent_ms
     FROM ops_workflows ${includeBenchmark ? '' : 'WHERE is_benchmark = 0'} ORDER BY created_at DESC LIMIT ?`, [limit]);
  return rows;
}
