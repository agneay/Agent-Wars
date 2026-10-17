// Agent F - Execution: turns a validated plan into approved, idempotent MCP mutations.
import crypto from 'crypto';
import { OpsError } from '../util.js';

/** Builds the consequential action list for the workflow's intent. */
export function proposedActions(ctx) {
  const { intent, results, workflowId } = ctx;
  const emp = results.resolve_identity?.employee;
  switch (intent.intent) {
    case 'replace_device':
      return [{
        tool: 'replace_asset',
        args: {
          workflow_id: workflowId, user_id: emp.user_id,
          old_asset_id: results.asset_details.asset_id,
          new_asset_id: results.reserve_replacement.asset_id, // may differ from the top pick if it lost a reservation race
          old_asset_status: 'Maintenance',
          reservation_id: results.reserve_replacement.reservation_id,
          ...(intent.issue ? { remarks: intent.issue.slice(0, 200) } : {}),
        },
      }];
    case 'create_employee': {
      const ne = intent.new_employee;
      return [{ tool: 'create_employee', args: { workflow_id: workflowId, user_id: crypto.randomUUID(), emp_id: ne.emp_id, employee_name: ne.employee_name, ...(ne.email ? { email: ne.email } : {}) } }];
    }
    case 'assign_asset':
      return [{ tool: 'assign_asset', args: { workflow_id: workflowId, asset_id: results.asset_details.asset_id, user_id: emp.user_id } }];
    case 'withdraw_asset': {
      const a = results.asset_details;
      if (!a.active_assignment) throw new OpsError('NOT_ASSIGNED', `${a.asset_id} is not currently assigned`);
      return [{ tool: 'withdraw_asset', args: { workflow_id: workflowId, asset_id: a.asset_id, return_status: 'Available', expected_user_id: a.active_assignment.user_id } }];
    }
    default:
      throw new OpsError('VALIDATION_ERROR', `No executable actions for intent ${intent.intent}`);
  }
}

export async function prepareChange(ctx) {
  const actions = proposedActions(ctx);
  const res = await ctx.mcp.call('prepare_asset_assignment', { workflow_id: ctx.workflowId, actions });
  return { approval_id: res.approval_id, actions: res.actions, dry_run: res.dry_run };
}

export async function executeChange(ctx) {
  const { approval_id, actions } = ctx.results.prepare_change;
  const out = [];
  for (const [i, a] of actions.entries()) {
    // Deterministic key: a retry or resume after a crash replays the stored result instead of mutating twice.
    const data = await ctx.mcp.call(a.tool, { ...a.args, approval_id, idempotency_key: `${ctx.workflowId}:${i}:${a.tool}` });
    out.push({ tool: a.tool, result: data });
  }
  return { approval_id, executed: out };
}

export async function handoverReport(ctx) {
  const { results, workflowId, intent } = ctx;
  const exec = results.execute_change.executed[0];
  const args = results.prepare_change.actions[0].args;
  const d = results.diagnostics;
  const summary = d ? [d.reported_issue && `Reported: ${d.reported_issue}`, ...d.hypotheses.slice(0, 3).map(h => `Hypothesis (${h.confidence}): ${h.text}`), d.escalation.recommended && `Escalation: ${d.escalation.reason}`].filter(Boolean).join('\n') : undefined;
  return ctx.mcp.call('create_handover_report', {
    workflow_id: workflowId,
    user_id: args.user_id,
    new_asset_id: args.new_asset_id || args.asset_id,
    ...(args.old_asset_id ? { old_asset_id: args.old_asset_id } : {}),
    approval_id: exec.result.approval_id,
    ...(summary ? { diagnostics_summary: summary.slice(0, 1000) } : {}),
  }).then(r => ({ report_id: r.report_id, reused: r.reused, content: r.content, intent: intent.intent }));
}

export async function releaseReservation(mcp, reservationId) {
  if (!reservationId) return null;
  return mcp.call('release_reservation', { reservation_id: reservationId });
}
