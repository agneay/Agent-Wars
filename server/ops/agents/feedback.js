// Agent H - Feedback & Learning: measures outcomes from the audit tables and recommends routing.
// It never edits prompts, rules or models. Its only effect on execution is the documented
// strategy choice for strategy="auto", which is recorded on each workflow with its reason.
import pool from '../../db.js';
import { percentile } from '../util.js';

const MIN_SAMPLES = 5;
const P95_MIN_SAMPLES = 20;

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
function dist(values) {
  const v = values.filter(x => typeof x === 'number');
  return { n: v.length, median: percentile(v, 50), p95: v.length >= P95_MIN_SAMPLES ? percentile(v, 95) : null, min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}
const groupBy = (rows, key) => rows.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {});

export async function recommendStrategy(planVersion) {
  const [rows] = await pool.query(
    `SELECT strategy, JSON_EXTRACT(metrics, '$.agent_ms') AS ms FROM ops_workflows
     WHERE plan_version = ? AND status = 'SUCCEEDED' AND metrics IS NOT NULL
     ORDER BY created_at DESC LIMIT 400`, [planVersion]);
  const by = groupBy(rows.map(r => ({ ...r, ms: Number(r.ms) })), 'strategy');
  const med = s => percentile((by[s] || []).map(r => r.ms), 50);
  const n = s => (by[s] || []).length;
  if (n('parallel') < MIN_SAMPLES || n('sequential') < MIN_SAMPLES) {
    return { strategy: 'parallel', reason: `default (need ${MIN_SAMPLES}+ samples per strategy for ${planVersion}; have parallel=${n('parallel')}, sequential=${n('sequential')})` };
  }
  const p = med('parallel'), s = med('sequential');
  const pick = p <= s ? 'parallel' : 'sequential';
  return { strategy: pick, reason: `historical median ${planVersion}: parallel ${p}ms vs sequential ${s}ms (n=${n('parallel')}/${n('sequential')})` };
}

export async function executionStats({ include_benchmark = true } = {}) {
  const wfFilter = include_benchmark ? '' : 'WHERE w.is_benchmark = 0';
  const [[wfs], [tasks], [tools], [fb]] = await Promise.all([
    pool.query(`SELECT w.id, w.status, w.strategy, w.plan_version, w.is_benchmark, w.error_code, w.metrics FROM ops_workflows w ${wfFilter} ORDER BY w.created_at DESC LIMIT 2000`),
    pool.query(`SELECT t.agent, t.task_key, t.status, t.attempts, t.duration_ms, t.error_code FROM ops_tasks t JOIN ops_workflows w ON w.id = t.workflow_id ${wfFilter} ORDER BY w.created_at DESC LIMIT 20000`),
    pool.query(`SELECT c.tool, c.ok, c.error_code, c.server_ms, c.db_queries FROM ops_tool_calls c LEFT JOIN ops_workflows w ON w.id = c.workflow_id ${include_benchmark ? '' : 'WHERE w.is_benchmark = 0 OR w.id IS NULL'} ORDER BY c.id DESC LIMIT 20000`),
    pool.query('SELECT rating, COUNT(*) AS n FROM ops_feedback GROUP BY rating'),
  ]);
  const metrics = wfs.map(w => ({ ...w, metrics: parse(w.metrics) || {} }));

  const byPlan = {};
  for (const [plan, rows] of Object.entries(groupBy(metrics, 'plan_version'))) {
    byPlan[plan] = {};
    for (const [strategy, rs] of Object.entries(groupBy(rows, 'strategy'))) {
      const done = rs.filter(r => r.status === 'SUCCEEDED');
      byPlan[plan][strategy] = {
        runs: rs.length,
        succeeded: done.length,
        verified_complete_ms: dist(done.map(r => r.metrics.agent_ms)),
        approval_ready_ms: dist(rs.map(r => r.metrics.approval_ready_ms).filter(Boolean)),
        first_action_ms: dist(rs.map(r => r.metrics.first_action_ms).filter(Boolean)),
        llm_calls_total: rs.reduce((s, r) => s + (r.metrics.llm_calls || 0), 0),
      };
    }
  }

  const agents = Object.fromEntries(Object.entries(groupBy(tasks, 'agent')).map(([agent, rs]) => [agent, {
    tasks: rs.length,
    failed: rs.filter(r => r.status === 'FAILED').length,
    duration_ms: dist(rs.filter(r => r.duration_ms != null).map(r => r.duration_ms)),
  }]));

  const toolStats = Object.fromEntries(Object.entries(groupBy(tools, 'tool')).map(([tool, rs]) => [tool, {
    calls: rs.length,
    errors: rs.filter(r => !r.ok).length,
    server_ms: dist(rs.map(r => r.server_ms)),
    avg_db_queries: Math.round((rs.reduce((s, r) => s + r.db_queries, 0) / rs.length) * 10) / 10,
  }]));

  const failureCodes = {};
  for (const r of tools.filter(t => !t.ok)) failureCodes[r.error_code] = (failureCodes[r.error_code] || 0) + 1;
  const workflowFailures = {};
  for (const r of metrics.filter(w => w.error_code)) workflowFailures[r.error_code] = (workflowFailures[r.error_code] || 0) + 1;

  const verifyTasks = tasks.filter(t => t.task_key === 'verify' && ['SUCCEEDED', 'FAILED'].includes(t.status));
  const ran = tasks.filter(t => t.attempts > 0);
  const bottleneck = Object.entries(agents).filter(([, a]) => a.duration_ms.median != null).sort((a, b) => b[1].duration_ms.median - a[1].duration_ms.median)[0];
  const recommendations = [];
  if (bottleneck) recommendations.push(`Slowest agent by median: ${bottleneck[0]} (${bottleneck[1].duration_ms.median}ms)`);
  const topFail = Object.entries(failureCodes).sort((a, b) => b[1] - a[1])[0];
  if (topFail) recommendations.push(`Most common tool error: ${topFail[0]} (${topFail[1]}x)`);

  return {
    generated_at: new Date().toISOString(),
    workflows: { total: metrics.length, by_status: Object.fromEntries(Object.entries(groupBy(metrics, 'status')).map(([k, v]) => [k, v.length])) },
    completion_rate: metrics.length ? metrics.filter(w => w.status === 'SUCCEEDED').length / metrics.length : null,
    verification_failure_rate: verifyTasks.length ? verifyTasks.filter(t => t.status === 'FAILED').length / verifyTasks.length : null,
    retry_rate: ran.length ? ran.filter(t => t.attempts > 1).length / ran.length : null,
    by_plan: byPlan,
    agents, tools: toolStats, tool_failure_codes: failureCodes, workflow_failure_codes: workflowFailures,
    feedback: Object.fromEntries(fb.map(r => [r.rating, Number(r.n)])),
    strategy_recommendation: await recommendStrategy('replace_device@1'),
    recommendations,
    notes: `p95 is reported only with >= ${P95_MIN_SAMPLES} samples.`,
  };
}
