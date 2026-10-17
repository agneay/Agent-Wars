// Typed MCP tool catalogue for AirportOps AI.
// access: 'read'          any authenticated principal
//         'write'         admin only (reversible preparation: reservations, approval requests, reports)
//         'consequential' admin + a human-APPROVED approval whose recorded action matches these exact
//                         arguments + an idempotency key. The approval check runs inside the same DB
//                         transaction as the mutation, so no caller (LLM or otherwise) can bypass it.
import crypto from 'crypto';
import { z } from 'zod';
import pool from '../../db.js';
import * as svc from '../services/assetService.js';
import { OpsError, counted, hashArgs, redact } from '../util.js';
import { getWorkflowSnapshot } from '../store.js';
import { executionStats } from '../agents/feedback.js';

const id = z.string().trim().min(1).max(64);
const assetId = id.describe('Asset ID, e.g. AAI-AST-001 or DEMO-LAP-0102');
const userId = id.describe('Internal user_id (from search_employees / get_employee_details)');
const wfId = z.string().uuid().describe('AirportOps workflow ID');
const idemKey = z.string().min(8).max(128).describe('Idempotency key; repeating a call with the same key returns the original result');
const approvalId = z.string().uuid().describe('ID of an APPROVED approval that lists this exact action');
const statusName = z.enum(['Available', 'Assigned', 'Maintenance', 'Expired']);
const remarks = z.string().max(300).optional();

const CONTROL_KEYS = ['approval_id', 'idempotency_key'];
export const actionArgs = args => Object.fromEntries(Object.entries(args).filter(([k]) => !CONTROL_KEYS.includes(k)));

// Consequential mutation schemas (without control fields). Shared by the tools and by prepare_asset_assignment.
export const ACTION_SCHEMAS = {
  replace_asset: z.object({
    workflow_id: wfId, user_id: userId, old_asset_id: assetId, new_asset_id: assetId,
    old_asset_status: statusName.default('Maintenance'), reservation_id: z.string().uuid().optional(), remarks,
  }).strict(),
  assign_asset: z.object({ workflow_id: wfId, asset_id: assetId, user_id: userId, reservation_id: z.string().uuid().optional(), remarks }).strict(),
  withdraw_asset: z.object({ workflow_id: wfId, asset_id: assetId, return_status: statusName.default('Available'), expected_user_id: userId.optional(), remarks }).strict(),
  transfer_asset: z.object({ workflow_id: wfId, asset_id: assetId, to_user_id: userId, remarks }).strict(),
  update_asset_status: z.object({ workflow_id: wfId, asset_id: assetId, status: statusName, expected_status: statusName.optional(), remarks }).strict(),
  create_employee: z.object({
    workflow_id: wfId, user_id: z.string().uuid(),
    emp_id: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, - or _ only'),
    employee_name: z.string().trim().min(2).max(100),
    email: z.string().email().max(100).optional(),
  }).strict(),
};
const ACTION_FN = {
  replace_asset: svc.replaceAsset, assign_asset: svc.assignAsset, withdraw_asset: svc.withdrawAsset,
  transfer_asset: svc.transferAsset, update_asset_status: svc.updateAssetStatus,
  create_employee: svc.createEmployee,
};

// ------------------------------------------------------------------ transaction helpers

async function withTransaction(ctx, fn) {
  const conn = await pool.getConnection();
  const c = counted(conn, ctx.counter);
  try {
    await conn.query('SET SESSION innodb_lock_wait_timeout = 5');
    await conn.beginTransaction();
    const out = await fn(c);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

async function claimIdempotency(c, key, tool, requestHash) {
  try {
    await c.query('INSERT INTO ops_idempotency (idem_key, tool, request_hash) VALUES (?, ?, ?)', [key, tool, requestHash]);
    return null;
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const [[row]] = await c.query('SELECT tool, request_hash, result FROM ops_idempotency WHERE idem_key = ?', [key]);
    if (row.tool !== tool || row.request_hash !== requestHash) {
      throw new OpsError('IDEMPOTENCY_CONFLICT', `Idempotency key ${key} was already used for a different request`);
    }
    return { replay: typeof row.result === 'string' ? JSON.parse(row.result) : row.result };
  }
}

async function requireApproval(c, approval_id, tool, args) {
  const [[ap]] = await c.query('SELECT id, workflow_id, status, actions, decided_by FROM ops_approvals WHERE id = ? FOR UPDATE', [approval_id]);
  if (!ap) throw new OpsError('APPROVAL_REQUIRED', `Approval ${approval_id} does not exist`);
  if (ap.status !== 'APPROVED') throw new OpsError('APPROVAL_REQUIRED', `Approval ${approval_id} is ${ap.status}; a human must approve it first`);
  const actions = typeof ap.actions === 'string' ? JSON.parse(ap.actions) : ap.actions;
  const wanted = hashArgs(args);
  if (!actions.some(a => a.tool === tool && hashArgs(a.args) === wanted)) {
    throw new OpsError('APPROVAL_MISMATCH', `Approval ${approval_id} does not cover ${tool} with these arguments`);
  }
  if (args.workflow_id && ap.workflow_id !== args.workflow_id) throw new OpsError('APPROVAL_MISMATCH', 'Approval belongs to a different workflow');
  return ap;
}

async function runConsequential(ctx, tool, rawArgs) {
  const args = ACTION_SCHEMAS[tool].parse(actionArgs(rawArgs));
  const requestHash = hashArgs({ tool, args });
  return withTransaction(ctx, async c => {
    const claimed = await claimIdempotency(c, rawArgs.idempotency_key, tool, requestHash);
    if (claimed) return { ...claimed.replay, idempotent_replay: true };
    const ap = await requireApproval(c, rawArgs.approval_id, tool, args);
    const result = await ACTION_FN[tool](c, { ...args, actor: ctx.principal.username });
    const out = { ...result, approval_id: ap.id, approved_by: ap.decided_by };
    await c.query('UPDATE ops_idempotency SET result = ? WHERE idem_key = ?', [JSON.stringify(out), rawArgs.idempotency_key]);
    return out;
  });
}

// ------------------------------------------------------------------ catalogue

const consequential = (name, title, description) => ({
  name, title, access: 'consequential',
  description: `${description} CONSEQUENTIAL: requires admin role, an APPROVED approval_id covering these exact arguments, and an idempotency_key.`,
  input: { ...ACTION_SCHEMAS[name].shape, approval_id: approvalId, idempotency_key: idemKey },
  handler: (ctx, args) => runConsequential(ctx, name, args),
});

export const TOOLS = [
  // ---------------- read
  {
    name: 'search_employees', title: 'Search employees', access: 'read',
    description: 'Find employees by employee ID (e.g. E102, EMP102), name, email or user_id. Results are ranked with a match type so ambiguity is explicit.',
    input: { query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(20).default(5) },
    handler: (ctx, a) => svc.searchEmployees(ctx.db, a),
  },
  {
    name: 'search_assets', title: 'Search assets', access: 'read',
    description: 'Find assets by asset ID, serial number, model name, IP address or hostname. Optional type/status filters.',
    input: { query: z.string().trim().min(1).max(100), asset_type: z.string().max(50).optional(), status: statusName.optional(), limit: z.number().int().min(1).max(50).default(10) },
    handler: (ctx, a) => svc.searchAssets(ctx.db, a),
  },
  {
    name: 'get_employee_details', title: 'Employee details', access: 'read',
    description: 'Employee profile with department, designation, location and all currently assigned assets.',
    input: { user_id: userId },
    handler: (ctx, a) => svc.getEmployeeDetails(ctx.db, a),
  },
  {
    name: 'get_asset_details', title: 'Asset details', access: 'read',
    description: 'Full asset record: type, make/model, serial, warranty (from the asset record only), status, location, hardware specs, network, installed software, current assignment and any active reservation. Licence keys are never returned.',
    input: { asset_id: assetId },
    handler: (ctx, a) => svc.getAssetDetails(ctx.db, a),
  },
  {
    name: 'get_assignment_history', title: 'Assignment history', access: 'read',
    description: 'Assignment/return/maintenance history for an asset or an employee, newest first.',
    input: { asset_id: assetId.optional(), user_id: userId.optional(), limit: z.number().int().min(1).max(100).default(25) },
    handler: (ctx, a) => svc.getAssignmentHistory(ctx.db, a),
  },
  {
    name: 'get_available_inventory', title: 'Available inventory', access: 'read',
    description: 'Assets of a type that are Available, unassigned and not reserved, with specs for compatibility checks.',
    input: { asset_type: z.string().min(1).max(50), location: z.string().max(100).optional(), exclude_asset_ids: z.array(assetId).max(50).default([]), limit: z.number().int().min(1).max(100).default(25) },
    handler: (ctx, a) => svc.getAvailableInventory(ctx.db, a),
  },
  {
    name: 'get_network_details', title: 'Network details', access: 'read',
    description: 'IP address, hostname, VLAN and MAC addresses recorded for an asset.',
    input: { asset_id: assetId },
    handler: async (ctx, a) => (await svc.getNetworkDetails(ctx.db, a)) ?? { asset_id: a.asset_id, network: null },
  },
  {
    name: 'get_software_licenses', title: 'Installed software', access: 'read',
    description: 'Software installed on an asset (name, version, install date). The schema has no licence-entitlement table, so this reports installations only.',
    input: { asset_id: assetId },
    handler: (ctx, a) => svc.getSoftware(ctx.db, a),
  },
  {
    name: 'get_asset_status', title: 'Asset status (verification read)', access: 'read',
    description: 'Persisted status, active assignment and active reservation for up to 20 assets. Used to verify mutations.',
    input: { asset_ids: z.array(assetId).min(1).max(20) },
    handler: (ctx, a) => svc.getAssetStatus(ctx.db, a),
  },
  // ---------------- write (preparation)
  {
    name: 'reserve_replacement_asset', title: 'Reserve replacement', access: 'write',
    description: 'Place an expiring hold on an available asset for a workflow so no other workflow can allocate it. Re-reserving for the same workflow returns the existing hold.',
    input: { asset_id: assetId, workflow_id: wfId, for_user_id: userId.optional(), ttl_minutes: z.number().int().min(1).max(240).default(30) },
    handler: (ctx, a) => withTransaction(ctx, c => svc.reserveAsset(c, { ...a, actor: ctx.principal.username })),
  },
  {
    name: 'release_reservation', title: 'Release reservation', access: 'write',
    description: 'Release an active reservation (used on cancel/reject).',
    input: { reservation_id: z.string().uuid() },
    handler: (ctx, a) => withTransaction(ctx, c => svc.releaseReservation(c, a)),
  },
  {
    name: 'prepare_asset_assignment', title: 'Prepare change for approval', access: 'write',
    description: 'Validate a set of consequential actions by trial-running them in a transaction that is always rolled back, then record a PENDING approval request. Returns approval_id; nothing is changed until a human approves.',
    input: {
      workflow_id: wfId,
      actions: z.array(z.object({ tool: z.enum(Object.keys(ACTION_SCHEMAS)), args: z.record(z.any()) })).min(1).max(5),
    },
    handler: async (ctx, a) => {
      const actions = a.actions.map(x => {
        const args = ACTION_SCHEMAS[x.tool].parse(x.args);
        if (args.workflow_id !== a.workflow_id) throw new OpsError('VALIDATION_ERROR', 'Every action must carry the same workflow_id');
        return { tool: x.tool, args };
      });
      // Dry run: proves every precondition holds right now, then rolls back.
      const conn = await pool.getConnection();
      const c = counted(conn, ctx.counter);
      const preview = [];
      try {
        await conn.beginTransaction();
        for (const act of actions) preview.push({ tool: act.tool, result: await ACTION_FN[act.tool](c, { ...act.args, actor: ctx.principal.username }) });
      } finally {
        await conn.rollback().catch(() => {});
        conn.release();
      }
      const approval_id = crypto.randomUUID();
      await ctx.db.query(
        'INSERT INTO ops_approvals (id, workflow_id, actions, actions_hash, status, requested_by) VALUES (?, ?, ?, ?, \'PENDING\', ?)',
        [approval_id, a.workflow_id, JSON.stringify(actions), hashArgs(actions), ctx.principal.username]);
      return { approval_id, status: 'PENDING', actions, dry_run: preview, note: 'Dry run executed and rolled back; no records changed.' };
    },
  },
  {
    name: 'create_handover_report', title: 'Create handover report', access: 'write',
    description: 'Build and store a handover report for a workflow from persisted records (employee, assets, approval, history). Idempotent per workflow.',
    input: { workflow_id: wfId, user_id: userId, new_asset_id: assetId, old_asset_id: assetId.optional(), approval_id: approvalId.optional(), diagnostics_summary: z.string().max(1000).optional() },
    handler: async (ctx, a) => {
      const [[existing]] = await ctx.db.query('SELECT id, content FROM ops_handover_reports WHERE workflow_id = ?', [a.workflow_id]);
      if (existing) return { report_id: existing.id, content: typeof existing.content === 'string' ? JSON.parse(existing.content) : existing.content, reused: true };
      const [employee, newAsset, oldAsset, approval, history] = await Promise.all([
        svc.getEmployeeDetails(ctx.db, { user_id: a.user_id }),
        svc.getAssetDetails(ctx.db, { asset_id: a.new_asset_id }),
        a.old_asset_id ? svc.getAssetDetails(ctx.db, { asset_id: a.old_asset_id }) : null,
        a.approval_id ? ctx.db.query("SELECT id, status, requested_by, decided_by, DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at FROM ops_approvals WHERE id = ?", [a.approval_id]).then(([r]) => r[0]) : null,
        ctx.db.query("SELECT history_id, asset_id, assignment_status AS status, remarks, assigned_by FROM asset_assignment_history WHERE remarks LIKE ? ORDER BY history_id", [`%${a.workflow_id}%`]).then(([r]) => r),
      ]);
      const pick = x => x && { asset_id: x.asset_id, type: x.type, make: x.make, model: x.model, serial: x.serial, status: x.status, location: x.location, warranty_end_date: x.warranty_end_date, specs: x.specs };
      const content = {
        title: `Handover report - ${employee.emp_id} ${employee.employee_name}`,
        generated_at: new Date().toISOString(), workflow_id: a.workflow_id,
        employee: { user_id: employee.user_id, emp_id: employee.emp_id, name: employee.employee_name, department: employee.department, location: employee.location },
        issued_asset: pick(newAsset), returned_asset: pick(oldAsset), approval,
        history_entries: history, diagnostics_summary: a.diagnostics_summary || null,
        checklist: ['Employee data backed up from returned device', 'Accessories (charger, bag, mouse) accounted for', 'Issued device powered on and user signed in', 'Employee signature', 'IT officer signature'],
        synthetic: Boolean(employee.synthetic || newAsset.synthetic),
      };
      const report_id = crypto.randomUUID();
      await ctx.db.query('INSERT INTO ops_handover_reports (id, workflow_id, content, created_by) VALUES (?, ?, ?, ?)', [report_id, a.workflow_id, JSON.stringify(content), ctx.principal.username]);
      return { report_id, content, reused: false };
    },
  },
  // ---------------- consequential
  consequential('replace_asset', 'Replace asset (atomic)', 'Withdraw the employee\'s old asset (set to old_asset_status) and assign the replacement in one transaction, consuming the reservation.'),
  consequential('assign_asset', 'Assign asset', 'Assign an available asset to an active employee.'),
  consequential('withdraw_asset', 'Withdraw asset', 'Return an assigned asset to store with the given status.'),
  consequential('transfer_asset', 'Transfer asset', 'Move an assigned asset to another employee in one transaction.'),
  consequential('update_asset_status', 'Update asset status', 'Change an asset status with optimistic concurrency (expected_status).'),
  consequential('create_employee', 'Create employee', 'Add a new Active employee record; fails if the employee ID already exists.'),
  // ---------------- workflow
  {
    name: 'get_workflow_status', title: 'Workflow status', access: 'read',
    description: 'Current status, tasks, approvals and outcome of an AirportOps workflow.',
    input: { workflow_id: wfId },
    handler: async (ctx, a) => {
      const snap = await getWorkflowSnapshot(a.workflow_id);
      if (!snap) throw new OpsError('NOT_FOUND', `Workflow ${a.workflow_id} does not exist`);
      return snap;
    },
  },
  {
    name: 'record_workflow_feedback', title: 'Record feedback', access: 'read',
    description: 'Record whether a workflow result was correct, incomplete or incorrect.',
    input: { workflow_id: wfId, rating: z.enum(['correct', 'incomplete', 'incorrect']), comment: z.string().max(1000).optional() },
    handler: async (ctx, a) => {
      const [[wf]] = await ctx.db.query('SELECT id FROM ops_workflows WHERE id = ?', [a.workflow_id]);
      if (!wf) throw new OpsError('NOT_FOUND', `Workflow ${a.workflow_id} does not exist`);
      const [r] = await ctx.db.query('INSERT INTO ops_feedback (workflow_id, rating, comment, created_by) VALUES (?, ?, ?, ?)', [a.workflow_id, a.rating, a.comment || null, ctx.principal.username]);
      return { feedback_id: r.insertId, workflow_id: a.workflow_id, rating: a.rating };
    },
  },
  {
    name: 'get_execution_metrics', title: 'Execution metrics', access: 'read',
    description: 'Aggregated workflow latency (median/p95), per-agent and per-tool timings, failure codes, retry/verification rates, feedback and strategy recommendation.',
    input: { include_benchmark: z.boolean().default(true) },
    handler: (ctx, a) => executionStats(a),
  },
];

export const TOOL_ACCESS = Object.fromEntries(TOOLS.map(t => [t.name, t.access]));

// Summaries keep traces compact and free of secrets.
export function summarize(data) {
  if (Array.isArray(data)) return { count: data.length, first: data.slice(0, 3).map(x => redact(x?.asset_id || x?.emp_id || x?.history_id || x)) };
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    return redact(Object.fromEntries(keys.slice(0, 12).map(k => [k, typeof data[k] === 'object' && data[k] !== null ? (Array.isArray(data[k]) ? `[${data[k].length}]` : '{...}') : data[k]])));
  }
  return data;
}
