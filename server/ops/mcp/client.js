// MCP client used by the agents. Every agent action that touches data goes through here,
// over the Streamable HTTP transport, to the MCP server - there is no direct DB path from agents.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OpsError } from '../util.js';

const pool = new Map(); // token -> { client: Promise<Client>, lastUsed }

export const mcpUrl = () => process.env.OPS_MCP_URL || `http://127.0.0.1:${process.env.PORT || 5000}/mcp`;

async function connect(token) {
  const client = new Client({ name: 'airportops-agents', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function getClient(token) {
  let entry = pool.get(token);
  if (!entry) {
    entry = { client: connect(token), lastUsed: Date.now() };
    pool.set(token, entry);
    entry.client.catch(() => pool.delete(token));
  }
  entry.lastUsed = Date.now();
  return entry.client;
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, e] of pool) if (e.lastUsed < cutoff) { e.client.then(c => c.close()).catch(() => {}); pool.delete(k); }
}, 60_000).unref();

/**
 * Returns a per-workflow MCP handle. Every call is recorded via onCall for the execution trace.
 */
export function mcpSession({ token, workflowId, onCall }) {
  return {
    async call(tool, args, { taskKey, signal, timeoutMs = 15000 } = {}) {
      const t0 = performance.now();
      let structured;
      try {
        const client = await getClient(token);
        const res = await client.callTool(
          { name: tool, arguments: args, _meta: { workflow_id: workflowId, task_key: taskKey } },
          undefined,
          { signal, timeout: timeoutMs },
        );
        const text = res.content?.[0]?.text || '';
        if (res.structuredContent) structured = res.structuredContent;
        else {
          // The SDK rejects schema-invalid arguments itself, with a plain-text error and no structured body.
          try { structured = JSON.parse(text); } catch { structured = { ok: false, error: { code: 'VALIDATION_ERROR', message: text.replace(/^MCP error -?\d+:\s*/, '').slice(0, 300), retryable: false } }; }
        }
      } catch (e) {
        if (signal?.aborted) throw new OpsError('CANCELLED', 'Workflow cancelled');
        // Transport-level failure: drop the pooled client so the next attempt reconnects.
        pool.delete(token);
        structured = { ok: false, error: { code: 'MCP_TRANSPORT', message: e.message, retryable: true } };
      }
      const client_ms = Math.round((performance.now() - t0) * 10) / 10;
      onCall?.({ tool, taskKey, args, ok: structured.ok, error: structured.error, meta: structured.meta, client_ms, data: structured.data });
      if (!structured.ok) {
        const err = structured.error || { code: 'UNKNOWN', message: 'Tool failed', retryable: false };
        throw new OpsError(err.code, err.message, { retryable: err.retryable, details: err.details });
      }
      return structured.data;
    },
  };
}

export async function listTools(token) {
  const client = await getClient(token);
  return (await client.listTools()).tools;
}
