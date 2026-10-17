// Agent E - Logistics & Resource Allocation: stock scan, rule-based compatibility, reservation.
import { OpsError, parseSizeGB } from '../util.js';

export const COMPAT_RULES_VERSION = 'compat@1';

export async function inventoryScan(ctx) {
  const type = ctx.intent.device_type || ctx.results.asset_details?.type;
  if (!type) throw new OpsError('VALIDATION_ERROR', 'Device type unknown; cannot scan inventory');
  const items = await ctx.mcp.call('get_available_inventory', { asset_type: type, limit: 50 });
  return { asset_type: type, available_count: items.length, items };
}

/**
 * Hard rules (reject): same type; Available and unassigned (guaranteed by the inventory query);
 *   RAM and storage not lower than the current device when both are known.
 * Soft score: same location +30, warranty valid +20 / expired -20, same OS +15, same make +10,
 *   newer purchase +10, more RAM +5.
 */
export function rankCandidates(current, items) {
  const today = new Date().toISOString().slice(0, 10);
  const curRam = parseSizeGB(current?.specs?.ram), curSto = parseSizeGB(current?.specs?.storage);
  const accepted = [], rejected = [];
  for (const c of items) {
    if (c.asset_id === current?.asset_id) continue;
    const ram = parseSizeGB(c.ram), sto = parseSizeGB(c.storage);
    const why = [];
    if (current?.type && c.type !== current.type) why.push(`type ${c.type} != ${current.type}`);
    if (curRam && ram && ram < curRam) why.push(`RAM ${c.ram} < current ${current.specs.ram}`);
    if (curSto && sto && sto < curSto) why.push(`storage ${c.storage} < current ${current.specs.storage}`);
    if (why.length) { rejected.push({ asset_id: c.asset_id, reasons: why }); continue; }
    let score = 0;
    const reasons = [];
    const add = (pts, r) => { score += pts; reasons.push(`${pts > 0 ? '+' : ''}${pts} ${r}`); };
    if (current?.location && c.location === current.location) add(30, 'same location');
    if (c.warranty_end_date) c.warranty_end_date >= today ? add(20, 'in warranty') : add(-20, 'warranty expired');
    if (current?.specs?.os && c.os === current.specs.os) add(15, 'same OS');
    if (current?.make && c.make === current.make) add(10, 'same make');
    if (current?.purchase_date && c.purchase_date && c.purchase_date > current.purchase_date) add(10, 'newer than current');
    if (curRam && ram && ram > curRam) add(5, 'more RAM');
    if (!curRam || !ram) reasons.push('RAM not comparable (missing spec)');
    accepted.push({ ...c, score, reasons });
  }
  accepted.sort((a, b) => b.score - a.score || a.asset_id.localeCompare(b.asset_id));
  return { accepted, rejected };
}

export async function selectReplacement(ctx) {
  const current = ctx.results.asset_details;
  const inv = ctx.results.inventory_scan;
  const { accepted, rejected } = rankCandidates(current, inv.items);
  if (!accepted.length) {
    throw new OpsError('NO_COMPATIBLE_STOCK', inv.items.length
      ? `${inv.items.length} ${inv.asset_type}(s) available but none meet the compatibility rules`
      : `No ${inv.asset_type} is available in inventory`, {
      details: { rejected, recommendation: `Raise a procurement request for a ${inv.asset_type} matching ${current?.specs?.ram || 'current'} RAM / ${current?.specs?.storage || 'current'} storage, or approve a loaner.` },
    });
  }
  return { rules: COMPAT_RULES_VERSION, selected: accepted[0], alternatives: accepted.slice(1, 4), rejected };
}

export async function reserveReplacement(ctx) {
  const sel = ctx.results.select_replacement.selected;
  const user = ctx.results.resolve_identity.employee;
  try {
    return await ctx.mcp.call('reserve_replacement_asset', { asset_id: sel.asset_id, workflow_id: ctx.workflowId, for_user_id: user.user_id, ttl_minutes: 30 });
  } catch (e) {
    // Lost a race to another workflow: take the next best alternative rather than failing.
    if (e.code !== 'RESERVED' && e.code !== 'ALREADY_ASSIGNED') throw e;
    for (const alt of ctx.results.select_replacement.alternatives) {
      try {
        const r = await ctx.mcp.call('reserve_replacement_asset', { asset_id: alt.asset_id, workflow_id: ctx.workflowId, for_user_id: user.user_id, ttl_minutes: 30 });
        ctx.note(`${sel.asset_id} was taken by another workflow; reserved alternative ${alt.asset_id}`);
        return { ...r, fallback_from: sel.asset_id };
      } catch (e2) {
        if (e2.code !== 'RESERVED' && e2.code !== 'ALREADY_ASSIGNED') throw e2;
      }
    }
    throw new OpsError('NO_COMPATIBLE_STOCK', 'All compatible candidates were reserved by other workflows');
  }
}
