// Agent A - Supervisor / Orchestrator: intent -> dependency-aware plan -> final report.
// Routing is deterministic for recognised request shapes (no model call); Claude is the fallback.
import * as intel from './assetIntel.js';
import * as diag from './diagnostics.js';
import * as logi from './logistics.js';
import * as exec from './execution.js';
import * as verif from './verification.js';
import { llmEnabled, llmParseIntent } from '../llm.js';

const DEVICE_TYPES = [
  [/\blaptops?\b|\bnotebooks?\b/i, 'Laptop'],
  [/\bdesktops?\b|\bcpus?\b|\bpcs?\b/i, 'Desktop CPU'],
  [/\ball[- ]?in[- ]?ones?\b/i, 'AllINONE'],
  [/\bmonitors?\b/i, 'Monitor'],
  [/\bprinters?\b/i, 'Printer'],
  [/\bscanners?\b/i, 'Scanner'],
  [/\bplotters?\b/i, 'Plotter'],
  [/\bups\b/i, 'UPS'],
  [/\brouters?\b/i, 'Router'],
  [/\bswitch(es)?\b/i, 'Switch'],
  [/\bprojectors?\b/i, 'Projector'],
  [/\btablets?\b|\btabs?\b/i, 'Tab'],
  [/\bwebcams?\b/i, 'Webcam'],
  [/\bheadsets?\b/i, 'Headset'],
  [/\bkeyboards?\b/i, 'Keyboard'],
  [/\bmouse\b|\bmice\b/i, 'Mouse'],
  [/\bservers?\b/i, 'Server'],
  [/\bworkstations?\b/i, 'Workstation'],
];
const ASSET_REF = /\b((?:AAI|DEMO)-[A-Z0-9]+(?:-[A-Z0-9]+)*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,3}(?:\.\d{1,3}){3})\b/i;
const EMP_REF = /\b((?:EMP|E)-?\d{2,6}|T\d{3,6})\b/i; // T needs 3+ digits so "ThinkPad T14" is not an employee
const EMP_NAME = /\bemployee\s+(?:named\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/;
const SYMPTOM = /(malfunction\w*|broken|faulty|not working|stopped working|won'?t (?:boot|turn on|start|charge)|no power|dead|overheat\w*|slow|freez\w*|blue screen|crash\w*|flicker\w*|battery[^.,;]*|screen[^.,;]*|keyboard[^.,;]*|wi-?fi[^.,;]*|network[^.,;]*|damaged|cracked[^.,;]*)/i;

const CREATE_EMP = /\b(add|create|register|onboard|new)\b.*\b(user|employee|staff|member)\b/i;
const NEW_EMP_ID = /\bemp(?:loyee)?[\s_-]*(?:id|no\.?|number|code)?\s*[:#=]?\s*([A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)\b/i;
const NEW_EMP_NAME = /\bname[d]?\s*(?:is|:|=)?\s*([A-Za-z][A-Za-z .'-]*?)\s*(?=,|;|\bemp(?:loyee)?\b|\bemail\b|\bwith\b|$)/i;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const titleCase = s => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Builds a create_employee intent; when a field is missing it asks for exactly that field. */
export function createEmployeeIntent(ne) {
  const { emp_id, employee_name } = ne;
  const ask = !emp_id && !employee_name ? "Sure. What's the new employee's ID? (for example 1002)"
    : !emp_id ? `What's the employee ID for ${employee_name}?`
    : !employee_name ? `What's the full name for employee ${emp_id}?`
    : null;
  return {
    intent: 'create_employee', new_employee: { emp_id: emp_id || null, employee_name: employee_name || null, email: ne.email || null },
    employee_ref: null, asset_ref: null, device_type: null, issue: null, source: 'rules', confidence: ask ? 'none' : 'high',
    ...(ask ? { clarification: ask } : {}),
  };
}

/** Fills missing new-employee fields from a reply such as "1002", "Ravi Kumar" or "1002 Ravi Kumar". */
export function fillEmployeeSlots(ne, text) {
  const t = text.trim().replace(/[.!]+$/, '');
  const out = { ...ne };
  const labelled = { emp_id: t.match(NEW_EMP_ID)?.[1], employee_name: t.match(NEW_EMP_NAME)?.[1], email: t.match(EMAIL)?.[0] };
  if (labelled.email) out.email = labelled.email;
  if (labelled.emp_id && !out.emp_id) out.emp_id = labelled.emp_id;
  if (labelled.employee_name && !out.employee_name) out.employee_name = titleCase(labelled.employee_name);
  const bare = t.replace(EMAIL, '').replace(/^(it'?s|it is|the id is|id is|name is|his name is|her name is|their name is)\s+/i, '').trim();
  const [first, ...rest] = bare.split(/\s+/);
  if (!labelled.emp_id && !out.emp_id && /^[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$/.test(first || '')) {
    out.emp_id = first;
    if (!out.employee_name && /^[A-Za-z][A-Za-z .'-]+$/.test(rest.join(' '))) out.employee_name = titleCase(rest.join(' '));
  } else if (!labelled.employee_name && !out.employee_name && /^[A-Za-z][A-Za-z .'-]{1,99}$/.test(bare)) {
    out.employee_name = titleCase(bare);
  }
  return out;
}

function parseCreateEmployee(t) {
  const name = t.match(NEW_EMP_NAME)?.[1] || null;
  return createEmployeeIntent({ emp_id: t.match(NEW_EMP_ID)?.[1] || null, employee_name: name ? titleCase(name) : null, email: t.match(EMAIL)?.[0] || null });
}

export function parseIntentRules(text) {
  const t = text.trim();
  if (CREATE_EMP.test(t) && !ASSET_REF.test(t)) return parseCreateEmployee(t);
  const asset = t.match(ASSET_REF)?.[1] || null;
  const rest = asset ? t.replace(asset, ' ') : t;
  const emp = rest.match(EMP_REF)?.[1]?.toUpperCase().replace('-', '') || rest.match(EMP_NAME)?.[1] || null;
  const device = DEVICE_TYPES.find(([re]) => re.test(rest))?.[1] || null;
  const symptom = t.match(SYMPTOM)?.[0]?.trim() || null;

  let intent = null;
  if (/\b(replac\w*|swap|substitute)\b/i.test(t) || (symptom && /\b(new|another|spare)\b/i.test(t))) intent = 'replace_device';
  else if (/\b(assign|allocate|allot|hand over)\b/i.test(t) && asset && emp) intent = 'assign_asset';
  else if (/\b(withdraw|take back|collect|return)\b/i.test(t) && asset) intent = 'withdraw_asset';
  else if (symptom || /\b(diagnos\w*|troubleshoot\w*)\b/i.test(t)) intent = (emp || asset) ? 'diagnose' : null;
  else if (/\b(available|in stock|stock|inventory|spare)\b/i.test(t) && device && !emp && !asset) intent = 'check_inventory';
  else if (asset) intent = 'lookup_asset';
  else if (emp) intent = 'lookup_employee';

  if (intent === 'replace_device' && !emp && !asset) intent = null;
  return {
    intent: intent || 'unknown', employee_ref: emp, asset_ref: asset, device_type: device, issue: symptom,
    source: 'rules', confidence: intent ? 'high' : 'none',
  };
}

export async function parseIntent(text, { history = [], onLlmCall } = {}) {
  const rules = parseIntentRules(text);
  if (rules.intent !== 'unknown' || !llmEnabled()) return finalize(rules);
  try {
    const { intent, usage } = await llmParseIntent(text, { assetTypes: DEVICE_TYPES.map(d => d[1]), history });
    onLlmCall?.(usage);
    return finalize({ ...intent, source: 'llm', confidence: intent.intent === 'unknown' ? 'none' : 'medium' });
  } catch (e) {
    onLlmCall?.({ error: e.message });
    return finalize({ ...rules, llm_error: e.message });
  }
}

// ------------------------------------------------------------------ follow-up context
const PRONOUN = /\b(it|its|it's|this|that|same|her|his|their|them|she|he|the device|the laptop|the asset)\b/i;
const FOCUS = [
  ['warranty', /\bwarrant/i], ['network', /\b(ip|network|hostname|mac|vlan)\b/i], ['history', /\b(history|previous|past|before|who had)\b/i],
  ['software', /\b(software|apps?|installed|licen[cs]e)\b/i], ['specs', /\b(specs?|ram|memory|storage|processor|cpu|configuration)\b/i],
  ['status', /\b(status|where|location|assigned)\b/i],
];

/**
 * Fills a follow-up ("what's its warranty?", "replace it", "show her history") from the previous
 * workflow's resolved employee/asset. Returns null when the message is not a follow-up.
 */
export function applyContext(text, prev) {
  if (!prev) return null;
  const parsed = parseIntentRules(text);
  if (parsed.intent === 'create_employee' || parsed.employee_ref || parsed.asset_ref) return null;
  const focus = FOCUS.find(([, re]) => re.test(text))?.[0] || null;
  if (!PRONOUN.test(text) && !focus && parsed.intent === 'unknown') return null;
  if (!PRONOUN.test(text) && parsed.intent !== 'unknown' && !focus) return null;
  const base = { employee_ref: prev.employee_ref, asset_ref: prev.asset_ref, device_type: parsed.device_type || prev.device_type, issue: parsed.issue, source: 'context', confidence: 'medium', context_from: prev.workflow_id };
  let intent;
  if (parsed.intent === 'replace_device' || /\breplac/i.test(text)) intent = 'replace_device';
  // A question about an attribute ("what's its network?") is a lookup, not a fault report.
  else if ((parsed.intent === 'diagnose' || parsed.issue) && (!focus || /(not working|broken|slow|issue|problem|failw*|down|can'?t|won'?t|error|overheatw*|crashw*|dead|faulty)/i.test(text))) intent = 'diagnose';
  else if (/\b(withdraw|take back|collect)\b/i.test(text) && prev.asset_ref) intent = 'withdraw_asset';
  else if (/\b(other|all|else|assets|devices)\b/i.test(text) && prev.employee_ref) intent = 'lookup_employee';
  else if (prev.asset_ref) intent = 'lookup_asset';
  else if (prev.employee_ref) intent = focus === 'history' || !focus ? 'lookup_employee' : 'lookup_employee';
  else return null;
  if (intent === 'lookup_employee') base.asset_ref = null;
  if (intent === 'lookup_asset') base.employee_ref = null;
  return finalize({ ...base, intent, focus });
}

export function contextOf(snapshot) {
  if (!snapshot) return null;
  const r = snapshot.results || {};
  const emp = r.resolve_identity?.employee;
  const asset = r.asset_details;
  const ctx = {
    workflow_id: snapshot.id,
    employee_ref: emp?.emp_id || snapshot.intent?.employee_ref || null,
    asset_ref: asset?.asset_id || r.resolve_identity?.target_asset_id || snapshot.intent?.asset_ref || null,
    device_type: asset?.type || snapshot.intent?.device_type || null,
  };
  // After a replacement, "it" refers to the newly issued device.
  const done = r.execute_change?.executed?.[0];
  if (done?.tool === 'replace_asset') ctx.asset_ref = done.result.assigned.asset_id;
  return ctx.employee_ref || ctx.asset_ref ? ctx : null;
}

function finalize(i) {
  const out = { ...i };
  if (out.intent === 'replace_device' && !out.device_type && !out.asset_ref) out.device_type = null;
  out.needs_target = ['replace_device', 'diagnose'].includes(out.intent);
  return out;
}

// ------------------------------------------------------------------ plans

const T = (key, agent, title, deps, run, opts = {}) => ({ key, agent, title, deps, run, timeoutMs: 15000, retries: 2, ...opts });

export function buildPlan(intent, principal) {
  const admin = principal.role === 'admin';
  switch (intent.intent) {
    case 'replace_device': {
      const typeKnown = Boolean(intent.device_type);
      const tasks = [
        T('resolve_identity', 'asset_intel', 'Resolve employee and affected device', [], intel.resolveIdentity),
        T('asset_details', 'asset_intel', 'Fetch device record, specs, network, software', ['resolve_identity'], intel.assetDetails),
        T('assignment_history', 'asset_intel', 'Fetch assignment and maintenance history', ['resolve_identity'], intel.assignmentHistory),
        // With a known device type, stock is checked in parallel with identity resolution.
        T('inventory_scan', 'logistics', 'Scan available replacement stock', typeKnown ? [] : ['asset_details'], logi.inventoryScan),
        T('diagnostics', 'diagnostics', 'Triage reported issue against records', ['asset_details', 'assignment_history'], diag.diagnose, { optional: true }),
        T('select_replacement', 'logistics', 'Rank compatible replacements (compat@1)', ['asset_details', 'inventory_scan'], logi.selectReplacement),
      ];
      if (admin) {
        tasks.push(
          T('reserve_replacement', 'logistics', 'Reserve selected replacement (30 min hold)', ['select_replacement'], logi.reserveReplacement),
          T('prepare_change', 'execution', 'Dry-run change and request approval', ['reserve_replacement'], exec.prepareChange),
          T('execute_change', 'execution', 'Execute approved replacement (atomic)', ['prepare_change'], exec.executeChange, { gate: 'approval', retries: 3 }),
          T('verify', 'verification', 'Verify persisted records', ['execute_change'], verif.verify),
          T('handover_report', 'execution', 'Generate handover report', ['verify', 'diagnostics'], exec.handoverReport),
        );
      }
      return { planVersion: 'replace_device@1', tasks, note: admin ? null : 'Reservation and execution require an admin; this run stops at the recommendation.' };
    }
    case 'assign_asset':
    case 'withdraw_asset': {
      if (!admin) return { planVersion: `${intent.intent}@1`, tasks: [], forbidden: 'Changing assignments requires the admin role.' };
      return {
        planVersion: `${intent.intent}@1`,
        tasks: [
          T('resolve_identity', 'asset_intel', 'Resolve employee and asset', [], intel.resolveIdentity),
          T('asset_details', 'asset_intel', 'Fetch asset record', ['resolve_identity'], intel.assetDetails),
          T('prepare_change', 'execution', 'Dry-run change and request approval', ['asset_details'], exec.prepareChange),
          T('execute_change', 'execution', 'Execute approved change', ['prepare_change'], exec.executeChange, { gate: 'approval', retries: 3 }),
          T('verify', 'verification', 'Verify persisted records', ['execute_change'], verif.verify),
        ],
      };
    }
    case 'create_employee': {
      if (!admin) return { planVersion: 'create_employee@1', tasks: [], forbidden: 'Adding employees requires the admin role.' };
      const ne = intent.new_employee || {};
      if (!ne.emp_id || !ne.employee_name) return { planVersion: 'create_employee@1', tasks: [] }; // -> clarification
      return {
        planVersion: 'create_employee@1',
        tasks: [
          T('check_duplicate', 'asset_intel', `Check employee ID ${ne.emp_id} is unused`, [], intel.checkEmployeeIdFree),
          T('prepare_change', 'execution', 'Dry-run insert and request approval', ['check_duplicate'], exec.prepareChange),
          T('execute_change', 'execution', 'Create employee record', ['prepare_change'], exec.executeChange, { gate: 'approval', retries: 3 }),
          T('verify', 'verification', 'Verify persisted employee record', ['execute_change'], verif.verify),
        ],
      };
    }
    case 'diagnose':
      return {
        planVersion: 'diagnose@1',
        tasks: [
          T('resolve_identity', 'asset_intel', 'Resolve employee and device', [], intel.resolveIdentity),
          T('asset_details', 'asset_intel', 'Fetch device record', ['resolve_identity'], intel.assetDetails),
          T('assignment_history', 'asset_intel', 'Fetch history', ['resolve_identity'], intel.assignmentHistory),
          T('diagnostics', 'diagnostics', 'Triage reported issue', ['asset_details', 'assignment_history'], diag.diagnose),
        ],
      };
    case 'lookup_asset':
      return {
        planVersion: 'lookup_asset@1',
        tasks: [
          T('resolve_identity', 'asset_intel', 'Find asset and current holder', [], intel.resolveIdentity, { retries: 1 }),
          T('asset_details', 'asset_intel', 'Fetch asset record', ['resolve_identity'], intel.assetDetails),
          T('assignment_history', 'asset_intel', 'Fetch assignment history', ['resolve_identity'], intel.assignmentHistory),
        ],
      };
    case 'lookup_employee':
      return {
        planVersion: 'lookup_employee@1',
        tasks: [
          T('resolve_identity', 'asset_intel', 'Find employee and assigned assets', [], intel.resolveIdentity),
          T('assignment_history', 'asset_intel', 'Fetch employee assignment history', ['resolve_identity'], intel.assignmentHistory),
        ],
      };
    case 'check_inventory':
      return { planVersion: 'check_inventory@1', tasks: [T('inventory_scan', 'logistics', `Scan available ${intent.device_type} stock`, [], logi.inventoryScan)] };
    default:
      return { planVersion: 'unknown@1', tasks: [] };
  }
}

// ------------------------------------------------------------------ final report

export function summarize(wf) {
  const r = wf.results;
  const emp = r.resolve_identity?.employee;
  const lines = [];
  let headline, speech;
  const err = wf.error;

  if (wf.status === 'WAITING_FOR_INPUT') {
    headline = err.message;
    speech = `${err.message.replace(/.$/, '')}. ${err.details?.question || ''}`;
  } else if (wf.status === 'FAILED') {
    headline = `Could not complete: ${err?.message || 'unknown error'}`;
    speech = err?.message || 'The workflow failed.';
    if (err?.details?.suggestions?.length) lines.push(`Did you mean: ${err.details.suggestions.join(', ')}?`);
    if (err?.details?.recommendation) lines.push(err.details.recommendation);
    if (err?.code === 'VERIFICATION_FAILED') lines.push('Verification failed: the change is NOT confirmed. Review the checks before retrying.');
  } else if (wf.status === 'CANCELLED') {
    headline = 'Workflow cancelled'; speech = 'Cancelled. Any reservation was released.';
  } else if (wf.intent.intent === 'replace_device') {
    const cur = r.asset_details, sel = r.select_replacement?.selected;
    if (wf.status === 'WAITING_FOR_APPROVAL') {
      const reserved = r.reserve_replacement?.asset_id || sel?.asset_id;
      headline = `Ready for approval: replace ${cur.asset_id} with ${reserved} for ${emp.emp_id}`;
      speech = `I found ${emp.employee_name.replace('[DEMO] ', '')}'s ${cur.type.toLowerCase()} ${cur.asset_id} and reserved ${reserved} as the replacement. Approve to execute.`;
    } else if (wf.status === 'SUCCEEDED' && r.verify) {
      const done = r.prepare_change.actions[0].args;
      headline = `Done and verified: ${done.new_asset_id} assigned to ${emp.emp_id}; ${done.old_asset_id} moved to ${done.old_asset_status}`;
      speech = `Replacement complete and verified. ${done.new_asset_id} is now assigned, and the old device is in ${done.old_asset_status.toLowerCase()}. The handover report is ready.`;
    } else {
      headline = sel ? `Recommended replacement: ${sel.asset_id} (score ${sel.score})` : 'Analysis complete';
      speech = headline;
      if (wf.planNote) lines.push(wf.planNote);
    }
  } else if (wf.intent.intent === 'lookup_asset') {
    const a = r.asset_details;
    const h = r.assignment_history;
    const facts = {
      warranty: a.warranty_end_date ? `Warranty on record ends ${a.warranty_end_date} (${a.warranty_valid ? 'in warranty' : 'expired'}; not verified with vendor)` : 'No warranty end date recorded',
      network: a.network ? `Network: IP ${a.network.ip_address || 'none'}, hostname ${a.network.hostname || 'none'}, VLAN ${a.network.vlan || 'none'}` : 'No network details recorded',
      software: a.software?.length ? `Software: ${a.software.map(s => `${s.software_name} ${s.software_version || ''}`.trim()).join(', ')}` : 'No software installations recorded',
      specs: a.specs?.ram || a.specs?.processor ? `Specs: ${[a.specs.processor, a.specs.ram && `${a.specs.ram} RAM`, a.specs.storage, a.specs.os].filter(Boolean).join(', ')}` : 'No hardware specs recorded',
      status: `Status ${a.status} at ${a.location || 'unknown location'}${a.active_assignment ? `, assigned to ${a.active_assignment.emp_id} ${a.active_assignment.employee_name} since ${a.active_assignment.assigned_date}` : ', not assigned'}`,
      history: h ? `History: ${h.entries.length} entries; holders ${h.holders.join(', ') || 'none'}; ${h.maintenance_events} maintenance event(s)` : 'No history',
    };
    const focus = wf.intent.focus;
    headline = focus ? `${a.asset_id}: ${facts[focus]}` : `${a.asset_id}: ${[a.make, a.model].filter(Boolean).join(' ') || a.type}, ${a.status}${a.active_assignment ? `, assigned to ${a.active_assignment.emp_id}` : ''}`;
    speech = focus ? facts[focus] : headline;
    for (const [k, v] of Object.entries(facts)) if (k !== focus) lines.push(v);
  } else if (wf.intent.intent === 'lookup_employee') {
    headline = `${emp.emp_id} ${emp.employee_name}: ${emp.active_assets.length} assigned asset(s)`;
    speech = emp.active_assets.length ? `${headline}: ${emp.active_assets.map(a => `${a.type} ${a.asset_id}`).join(', ')}` : headline;
    for (const a of emp.active_assets) lines.push(`${a.asset_id} - ${a.type} ${[a.make, a.model].filter(Boolean).join(' ')} (${a.status})`);
    const h = r.assignment_history;
    if (h) lines.push(`History: ${h.entries.length} entries`);
  } else if (wf.intent.intent === 'check_inventory') {
    const inv = r.inventory_scan;
    headline = `${inv.available_count} ${inv.asset_type}(s) available`;
    speech = headline;
  } else if (wf.intent.intent === 'diagnose') {
    const d = r.diagnostics;
    headline = `Triage for ${r.asset_details.asset_id}: ${d.hypotheses.length} hypothesis(es), escalation ${d.escalation.recommended ? 'recommended' : 'not needed'}`;
    speech = headline;
  } else if (wf.intent.intent === 'create_employee') {
    const ne = wf.intent.new_employee;
    headline = wf.status === 'WAITING_FOR_APPROVAL'
      ? `Ready for approval: add employee ${ne.emp_id} - ${ne.employee_name}`
      : `Employee ${ne.emp_id} - ${ne.employee_name} created and verified`;
    speech = wf.status === 'WAITING_FOR_APPROVAL'
      ? `Employee ID ${ne.emp_id} is free. Approve to add ${ne.employee_name}.`
      : `${ne.employee_name} has been added as employee ${ne.emp_id} and verified in the database.`;
  } else if (['assign_asset', 'withdraw_asset'].includes(wf.intent.intent)) {
    headline = wf.status === 'WAITING_FOR_APPROVAL' ? 'Change prepared; waiting for approval' : 'Change executed and verified';
    speech = headline;
  } else {
    headline = 'Done'; speech = 'Done.';
  }
  for (const n of wf.notes) lines.push(n);
  return { headline, speech, lines, status: wf.status, suggestions: suggestionsFor(wf), options: err?.details?.options || null };
}

// Context-aware next steps shown as clickable chips. Every "say" text is something the
// conversation agent understands, so a click behaves exactly like typing or speaking it.
function suggestionsFor(wf) {
  const r = wf.results;
  const i = wf.intent;
  const s = [];
  const add = (label, say, kind = 'ask') => { if (s.length < 6 && !s.some(x => x.say === say)) s.push({ label, say, kind }); };
  const asset = r.asset_details;
  const emp = r.resolve_identity?.employee;
  const askAbout = focus => {
    const all = [['warranty', 'Warranty?', 'what is its warranty?'], ['specs', 'Specs', 'what are its specs?'], ['history', 'History', 'who had it before?'],
      ['network', 'Network / IP', 'what is its network?'], ['software', 'Software', 'what software is on it?']];
    for (const [k, label, say] of all) if (k !== focus) add(label, say);
  };

  if (wf.status === 'WAITING_FOR_APPROVAL') {
    add('Approve', 'approve', 'approve');
    add('Reject', 'reject', 'reject');
    if (asset) askAbout(null);
    return s;
  }
  if (wf.status === 'WAITING_FOR_INPUT') {
    if (i.intent === 'create_employee') add('Cancel', 'cancel', 'reject');
    else if (!wf.error?.details?.options) {
      add('Replace E102 laptop', "E102's laptop is broken, replace it", 'action');
      add('Laptop stock', 'how many laptops are available?');
      add('Add employee', 'add a new user', 'action');
      add('Look up E201', 'show me employee E201');
    }
    return s; // otherwise the options themselves are the choices
  }
  if (wf.status === 'FAILED') {
    const e = wf.error;
    for (const sug of e?.details?.suggestions || []) add(`Show ${sug.split(' ')[0]}`, `show details for asset ${sug.split(' ')[0]}`);
    if (e?.code === 'NO_COMPATIBLE_STOCK' && r.inventory_scan) add(`${r.inventory_scan.asset_type} stock`, `how many ${r.inventory_scan.asset_type.toLowerCase()}s are available?`);
    if (emp) add(`${emp.emp_id}'s assets`, `show me employee ${emp.emp_id}`);
    if (e?.code === 'DUPLICATE_EMPLOYEE' && i.new_employee) add(`Show ${i.new_employee.emp_id}`, `show me employee ${i.new_employee.emp_id}`);
    return s;
  }
  if (wf.status !== 'SUCCEEDED') return s;

  switch (i.intent) {
    case 'replace_device': {
      const done = r.execute_change?.executed?.[0]?.result;
      if (done) {
        add('Handover report', '__tab:report', 'ui');
        add('New device specs', 'what are its specs?');
        add(`${emp.emp_id}'s assets`, `show me employee ${emp.emp_id}`);
        add('Old device status', `show details for asset ${done.withdrawn.asset_id}`);
      }
      break;
    }
    case 'lookup_asset':
      askAbout(i.focus);
      if (asset?.active_assignment) add('Replace it', 'replace it', 'action');
      if (asset?.active_assignment) add(`${asset.active_assignment.emp_id}'s assets`, `show me employee ${asset.active_assignment.emp_id}`);
      break;
    case 'lookup_employee':
      for (const a of (emp?.active_assets || []).slice(0, 3)) add(`${a.type} ${a.asset_id}`, `show details for asset ${a.asset_id}`);
      for (const t of [...new Set((emp?.active_assets || []).map(a => a.type))].slice(0, 2)) add(`Replace ${t.toLowerCase()}`, `replace ${emp.emp_id}'s ${t.toLowerCase()}`, 'action');
      break;
    case 'check_inventory':
      for (const a of (r.inventory_scan?.items || []).slice(0, 4)) add(a.asset_id, `show details for asset ${a.asset_id}`);
      break;
    case 'diagnose':
      add('Replace it', 'replace it', 'action');
      askAbout(null);
      break;
    case 'create_employee':
      add(`Show ${i.new_employee.emp_id}`, `show me employee ${i.new_employee.emp_id}`);
      break;
    default:
  }
  return s;
}
