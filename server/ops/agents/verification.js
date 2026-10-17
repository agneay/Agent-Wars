// Agent G - Verification: re-reads persisted state after mutations. A tool's success message is
// never accepted as proof; the workflow only succeeds if every check below passes against the DB.
import { OpsError } from '../util.js';

export async function verify(ctx) {
  const { approval_id, actions } = ctx.results.prepare_change;
  const exec = ctx.results.execute_change.executed;
  const checks = [];
  const check = (name, pass, evidence) => checks.push({ name, pass: Boolean(pass), evidence });

  const assetIds = [...new Set(actions.flatMap(a => [a.args.asset_id, a.args.old_asset_id, a.args.new_asset_id].filter(Boolean)))];
  const [status, history] = assetIds.length ? await Promise.all([
    ctx.mcp.call('get_asset_status', { asset_ids: assetIds }),
    Promise.all(assetIds.map(id => ctx.mcp.call('get_assignment_history', { asset_id: id, limit: 10 }))),
  ]) : [[], []];
  const byId = Object.fromEntries(status.map(s => [s.asset_id, s]));
  const histById = Object.fromEntries(assetIds.map((id, i) => [id, history[i]]));
  const loggedForWorkflow = id => histById[id].some(h => (h.remarks || '').includes(ctx.workflowId));

  for (const [i, a] of actions.entries()) {
    const r = exec[i]?.result;
    check(`${a.tool} executed under approval`, r && r.approval_id === approval_id, { approval_id: r?.approval_id, approved_by: r?.approved_by });
    if (a.tool === 'replace_asset') {
      const oldS = byId[a.args.old_asset_id], newS = byId[a.args.new_asset_id];
      check('Replacement assigned to employee', newS.assigned_user_id === a.args.user_id, { asset_id: newS.asset_id, assigned_user_id: newS.assigned_user_id });
      check('Replacement status is Assigned', newS.status === 'Assigned', { status: newS.status });
      check('Replacement has exactly one active assignment', newS.active_assignment_count === 1, { count: newS.active_assignment_count });
      check('Reservation consumed (no active hold)', !newS.active_reservation_id, { active_reservation_id: newS.active_reservation_id });
      check('Old device no longer assigned', !oldS.assigned_user_id, { asset_id: oldS.asset_id, assigned_user_id: oldS.assigned_user_id });
      check(`Old device status is ${a.args.old_asset_status}`, oldS.status === a.args.old_asset_status, { status: oldS.status });
      check('Audit history written for both assets', loggedForWorkflow(a.args.old_asset_id) && loggedForWorkflow(a.args.new_asset_id), { workflow_id: ctx.workflowId });
    } else if (a.tool === 'create_employee') {
      const emp = await ctx.mcp.call('get_employee_details', { user_id: a.args.user_id }).catch(() => null);
      check('Employee record exists in database', Boolean(emp), { user_id: a.args.user_id });
      check('Employee ID matches', emp?.emp_id === a.args.emp_id, { emp_id: emp?.emp_id });
      check('Name matches', emp?.employee_name === a.args.employee_name, { employee_name: emp?.employee_name });
      check('Status is Active', emp?.status === 'Active', { status: emp?.status });
      const dupes = await ctx.mcp.call('search_employees', { query: a.args.emp_id, limit: 10 });
      check('Employee ID is unique', dupes.filter(d => d.emp_id.toLowerCase() === a.args.emp_id.toLowerCase()).length === 1, { matches: dupes.length });
    } else if (a.tool === 'assign_asset') {
      const s = byId[a.args.asset_id];
      check('Asset assigned to employee', s.assigned_user_id === a.args.user_id, s);
      check('Asset status is Assigned', s.status === 'Assigned', { status: s.status });
      check('Audit history written', loggedForWorkflow(a.args.asset_id), { workflow_id: ctx.workflowId });
    } else if (a.tool === 'withdraw_asset') {
      const s = byId[a.args.asset_id];
      check('Asset no longer assigned', !s.assigned_user_id, s);
      check(`Asset status is ${a.args.return_status}`, s.status === a.args.return_status, { status: s.status });
      check('Audit history written', loggedForWorkflow(a.args.asset_id), { workflow_id: ctx.workflowId });
    }
  }

  const failed = checks.filter(c => !c.pass);
  const result = { passed: !failed.length, checks, verified_at: new Date().toISOString() };
  if (failed.length) {
    throw new OpsError('VERIFICATION_FAILED', `${failed.length} verification check(s) failed: ${failed.map(f => f.name).join('; ')}`, { details: result });
  }
  return result;
}
