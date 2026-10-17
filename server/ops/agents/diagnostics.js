// Agent D - Diagnostics: evidence-based triage from the asset record and its history.
// It performs no physical tests and queries no external warranty system; every fact cites its source.

const KB = [
  { id: 'power', match: /(no power|won'?t (turn|power) on|dead|not booting|won'?t boot|doesn'?t start)/i,
    hypotheses: ['Failed battery or charger', 'Motherboard / power circuit fault'],
    steps: ['Try a known-good charger and check the charge LED', 'Hard reset: remove power, hold power button 30s', 'Boot with battery disconnected on AC only'] },
  { id: 'thermal', match: /(overheat|hot|fan|thermal|shut(s|ting)? down)/i,
    hypotheses: ['Blocked vents or failing fan', 'Dried thermal paste'],
    steps: ['Check fan spin and clear vents', 'Run vendor hardware diagnostics (fan test)', 'Review BIOS thermal event log'] },
  { id: 'battery', match: /(battery|charging|drain)/i,
    hypotheses: ['Battery wear beyond service threshold'],
    steps: ['Read battery health report (powercfg /batteryreport on Windows)', 'Replace battery if full-charge capacity < 60% of design'] },
  { id: 'performance', match: /(slow|lag|freez|hang|performance)/i,
    hypotheses: ['Insufficient RAM for current workload', 'Storage nearing capacity or failing'],
    steps: ['Check memory and disk usage in Task Manager', 'Run SMART / storage health check', 'Check for runaway startup processes'] },
  { id: 'display', match: /(screen|display|flicker|lines|blank)/i,
    hypotheses: ['Panel or display cable fault', 'Graphics driver issue'],
    steps: ['Test with an external monitor to isolate panel vs GPU', 'Roll back / update the graphics driver'] },
  { id: 'crash', match: /(blue screen|bsod|crash|restart(s|ing)?)/i,
    hypotheses: ['Driver or OS corruption', 'Failing RAM or storage'],
    steps: ['Collect minidump / event logs', 'Run memory diagnostic', 'Run storage health check'] },
  { id: 'network', match: /(wifi|wi-fi|network|internet|lan|vpn|connect)/i,
    hypotheses: ['Network adapter or driver fault', 'Mismatch with recorded network configuration'],
    steps: ['Compare current IP/hostname with the recorded network details', 'Reinstall adapter driver; test wired vs wireless'] },
  { id: 'input', match: /(keyboard|key|touchpad|trackpad|mouse)/i,
    hypotheses: ['Keyboard/touchpad hardware fault (often liquid damage)'],
    steps: ['Test with external keyboard/mouse', 'Inspect for liquid damage'] },
];

export async function diagnose(ctx) {
  const asset = ctx.results.asset_details;
  const history = ctx.results.assignment_history;
  const issue = ctx.intent.issue || '';
  const today = new Date().toISOString().slice(0, 10);
  const facts = [];
  const hypotheses = [];
  const steps = [];

  if (asset) {
    facts.push({ fact: `${asset.asset_id}: ${[asset.make, asset.model].filter(Boolean).join(' ') || asset.type}, status ${asset.status}`, source: 'assets' });
    if (asset.purchase_date) {
      const years = (Date.now() - new Date(asset.purchase_date).getTime()) / (365.25 * 864e5);
      facts.push({ fact: `Purchased ${asset.purchase_date} (${years.toFixed(1)} years old)`, source: 'assets.purchase_date' });
      if (years >= 4) hypotheses.push({ text: 'Device is at or beyond a typical 4-year refresh cycle', confidence: 'medium', basis: 'age' });
    }
    if (asset.warranty_end_date) {
      const valid = asset.warranty_end_date >= today;
      facts.push({ fact: `Warranty end date on record: ${asset.warranty_end_date} (${valid ? 'in warranty' : 'expired'})`, source: 'assets.warranty_end_date (not verified with vendor)' });
    } else {
      facts.push({ fact: 'No warranty end date recorded', source: 'assets.warranty_end_date' });
    }
    if (asset.specs?.ram) facts.push({ fact: `RAM ${asset.specs.ram}, storage ${asset.specs.storage || 'unknown'}, ${asset.specs.os || 'OS unknown'}`, source: `${asset.specs.source}_details` });
    if (asset.network?.ip_address) facts.push({ fact: `Recorded network: ${asset.network.ip_address} / ${asset.network.hostname || 'no hostname'}`, source: 'network_details' });
  }
  if (history) {
    const maint = history.entries.filter(r => /maint|repair|replac|fault/i.test(`${r.status} ${r.remarks}`));
    for (const m of maint.slice(0, 3)) facts.push({ fact: `Prior event ${m.assigned_date || m.returned_date || ''}: ${m.remarks}`, source: `asset_assignment_history #${m.history_id}` });
    if (maint.length >= 1) hypotheses.push({ text: `Recurring fault risk: ${maint.length} prior maintenance event(s) on record`, confidence: maint.length >= 2 ? 'medium' : 'low', basis: 'history' });
  }

  const matched = KB.filter(k => k.match.test(issue));
  for (const k of matched) {
    for (const h of k.hypotheses) hypotheses.push({ text: h, confidence: 'low', basis: `reported symptom (${k.id})` });
    steps.push(...k.steps);
  }
  if (!issue) steps.push('Collect a precise symptom description from the employee');
  else if (!matched.length) steps.push('Symptom not in the triage knowledge base; run full vendor hardware diagnostics');

  const warrantyExpired = asset?.warranty_end_date && asset.warranty_end_date < today;
  const escalate = !issue || !matched.length || warrantyExpired || (history?.maintenance_events || 0) >= 2;
  return {
    reported_issue: issue || null,
    facts,
    hypotheses,
    recommended_steps: [...new Set(steps)],
    escalation: {
      recommended: Boolean(escalate),
      reason: warrantyExpired ? 'Out of warranty per asset record: route to in-house hardware team / procurement'
        : !issue ? 'No symptom described' : !matched.length ? 'Symptom not covered by triage rules'
        : escalate ? 'Repeated faults on record' : null,
    },
    disclaimer: 'Facts come from AirportOps records only. No physical diagnostics or external warranty lookups were performed.',
  };
}
