// Agent C - Asset Intelligence: identity resolution, asset records, history. Reads only, via MCP.
import { OpsError } from '../util.js';

/**
 * Resolves who and what the request is about.
 * Output: { employee, target_asset_id, target_reason, candidates }
 */
export async function resolveIdentity(ctx) {
  const { intent, mcp } = ctx;
  let employee = null;

  if (intent.employee_ref) {
    const matches = await mcp.call('search_employees', { query: intent.employee_ref, limit: 5 });
    if (!matches.length) throw new OpsError('NOT_FOUND', `No employee matches "${intent.employee_ref}"`);
    const top = matches[0];
    const tied = matches.filter(m => m.score === top.score);
    if (tied.length > 1 || top.score < 60) {
      throw new OpsError('NEEDS_INPUT', `"${intent.employee_ref}" matches more than one employee`, {
        details: { question: 'Which employee did you mean?', options: matches.map(m => ({ kind: 'employee', id: m.emp_id, label: `${m.emp_id} - ${m.employee_name}`, match: m.match })) },
      });
    }
    employee = await mcp.call('get_employee_details', { user_id: top.user_id });
    employee.match = top.match;
    if (top.match !== 'exact_id' && top.match !== 'exact_name') {
      ctx.note(`Resolved "${intent.employee_ref}" to ${top.emp_id} by ${top.match.replace('_', ' ')} match`);
    }
  }

  // Explicit asset reference wins over device type.
  if (intent.asset_ref) {
    const asset = await getAssetOrSuggest(ctx, intent.asset_ref);
    if (!employee && asset.active_assignment) {
      employee = await mcp.call('get_employee_details', { user_id: asset.active_assignment.user_id });
    }
    if (employee && asset.active_assignment && asset.active_assignment.user_id !== employee.user_id) {
      throw new OpsError('ASSIGNMENT_MISMATCH', `${asset.asset_id} is assigned to ${asset.active_assignment.emp_id}, not ${employee.emp_id}`);
    }
    return { employee, target_asset_id: asset.asset_id, target_reason: 'asset named in request', asset_preview: asset };
  }

  if (!employee) return { employee: null, target_asset_id: null };
  if (!intent.needs_target) return { employee, target_asset_id: null };

  const owned = employee.active_assets || [];
  const ofType = intent.device_type ? owned.filter(a => a.type?.toLowerCase() === intent.device_type.toLowerCase()) : owned;
  if (ofType.length === 1) {
    return { employee, target_asset_id: ofType[0].asset_id, target_reason: `only ${intent.device_type || 'asset'} assigned to ${employee.emp_id}` };
  }
  if (!ofType.length) {
    throw new OpsError('NOT_FOUND', `${employee.emp_id} has no ${intent.device_type || 'asset'} currently assigned`, {
      details: { assigned: owned.map(a => `${a.asset_id} (${a.type})`) },
    });
  }
  throw new OpsError('NEEDS_INPUT', `${employee.emp_id} has ${ofType.length} ${intent.device_type || 'asset'}s assigned`, {
    details: {
      question: `Which ${intent.device_type || 'asset'} is affected?`,
      options: ofType.map(a => ({ kind: 'asset', id: a.asset_id, label: `${a.asset_id} - ${[a.make, a.model].filter(Boolean).join(' ')} (${a.status})` })),
    },
  });
}

async function getAssetOrSuggest(ctx, ref) {
  try {
    return await ctx.mcp.call('get_asset_details', { asset_id: ref });
  } catch (e) {
    if (e.code !== 'NOT_FOUND') throw e;
    // Maybe it was a serial, IP or hostname rather than an asset ID.
    const found = await ctx.mcp.call('search_assets', { query: ref, limit: 5 });
    if (found.length === 1) {
      ctx.note(`"${ref}" is not an asset ID; matched ${found[0].asset_id} by serial/IP/hostname`);
      return ctx.mcp.call('get_asset_details', { asset_id: found[0].asset_id });
    }
    throw new OpsError('NOT_FOUND', `Asset "${ref}" does not exist`, {
      details: { suggestions: found.map(a => `${a.asset_id} (${a.type})`) },
    });
  }
}

export async function checkEmployeeIdFree(ctx) {
  const { emp_id, employee_name } = ctx.intent.new_employee;
  const matches = await ctx.mcp.call('search_employees', { query: emp_id, limit: 5 });
  const exact = matches.find(m => m.emp_id.toLowerCase() === emp_id.toLowerCase());
  if (exact) throw new OpsError('DUPLICATE_EMPLOYEE', `Employee ID ${exact.emp_id} already belongs to ${exact.employee_name}`);
  const sameName = (await ctx.mcp.call('search_employees', { query: employee_name, limit: 5 })).filter(m => m.match === 'exact_name');
  if (sameName.length) ctx.note(`Note: an employee with the same name already exists (${sameName.map(m => m.emp_id).join(', ')})`);
  return { emp_id, available: true, same_name: sameName.map(m => m.emp_id) };
}

export async function assetDetails(ctx) {
  const target = ctx.results.resolve_identity?.target_asset_id || ctx.intent.asset_ref;
  if (!target) throw new OpsError('VALIDATION_ERROR', 'No asset to inspect');
  const preview = ctx.results.resolve_identity?.asset_preview;
  if (preview?.asset_id === target) return preview; // already fetched during resolution; no second round trip
  return getAssetOrSuggest(ctx, target);
}

export async function assignmentHistory(ctx) {
  const target = ctx.results.resolve_identity?.target_asset_id;
  const user = ctx.results.resolve_identity?.employee?.user_id;
  const rows = target
    ? await ctx.mcp.call('get_assignment_history', { asset_id: target, limit: 25 })
    : await ctx.mcp.call('get_assignment_history', { user_id: user, limit: 25 });
  return {
    subject: target || user,
    entries: rows,
    maintenance_events: rows.filter(r => /maint|repair|replac|fault/i.test(`${r.status} ${r.remarks}`)).length,
    holders: [...new Set(rows.filter(r => r.emp_id).map(r => r.emp_id))],
  };
}
