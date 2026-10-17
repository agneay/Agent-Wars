// Optional Claude integration. The deterministic router handles the common request shapes with
// zero model calls; Claude is used only when a request cannot be parsed deterministically.
// Enabled when ANTHROPIC_API_KEY is set and OPS_LLM_ENABLED is not "0".
import Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const MODEL = process.env.OPS_LLM_MODEL || 'claude-opus-5-5';
let client = null;

export const llmEnabled = () => process.env.OPS_LLM_ENABLED !== '0' && Boolean(process.env.ANTHROPIC_API_KEY);
export const llmModel = () => (llmEnabled() ? MODEL : null);

function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 1, timeout: 20_000 });
  return client;
}

const IntentSchema = z.object({
  intent: z.enum(['replace_device', 'lookup_employee', 'lookup_asset', 'check_inventory', 'diagnose', 'assign_asset', 'withdraw_asset', 'unknown']),
  employee_ref: z.string().nullable().describe('Employee ID or name exactly as the user said it'),
  asset_ref: z.string().nullable().describe('Asset ID, serial, IP or hostname exactly as said'),
  device_type: z.string().nullable().describe('Device type such as Laptop, Desktop CPU, Monitor, Printer'),
  issue: z.string().nullable().describe('Reported problem, if any'),
  clarification: z.string().nullable().describe('If the request cannot be acted on, one short question to ask the user'),
});

const SYSTEM = `You convert airport IT operations requests into a structured intent for an asset-management workflow engine.
Only extract what the user actually said. Never invent IDs. Use "unknown" with a clarification question when the request is not about IT assets or lacks the identifiers needed.
Known device types: {TYPES}.`;

export async function llmParseIntent(text, { assetTypes = [], history = [] } = {}) {
  const t0 = performance.now();
  const recent = history.slice(-4);
  while (recent[0]?.role === 'assistant') recent.shift(); // first message must be from the user
  const msg = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low', format: zodOutputFormat(IntentSchema) },
    system: SYSTEM.replace('{TYPES}', assetTypes.join(', ')),
    messages: [
      ...recent.map(h => ({ role: h.role, content: h.text })),
      { role: 'user', content: text },
    ],
  });
  if (msg.stop_reason === 'refusal') throw new Error('Model declined to parse this request');
  return {
    intent: msg.parsed_output,
    usage: { model: MODEL, input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, ms: Math.round(performance.now() - t0) },
  };
}
