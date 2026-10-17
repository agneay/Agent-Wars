import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pool from '../../db.js';
import { TOOLS, summarize } from './tools.js';
import { OpsError, counted, redact, toOpsError } from '../util.js';

const TOOL_TIMEOUT_MS = Number(process.env.OPS_TOOL_TIMEOUT_MS || 10000);

const outputSchema = {
  ok: z.boolean(),
  data: z.any().optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.any().optional() }).optional(),
  meta: z.object({ tool: z.string(), server_ms: z.number(), db_queries: z.number() }).optional(),
};

function logToolCall(row) {
  // Fire-and-forget: audit logging must never add latency to (or fail) the tool call itself.
  pool.query(
    `INSERT INTO ops_tool_calls (workflow_id, task_key, tool, principal, args_redacted, result_summary, ok, error_code, server_ms, db_queries)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.workflow_id, row.task_key, row.tool, row.principal, JSON.stringify(row.args), JSON.stringify(row.summary ?? null),
      row.ok ? 1 : 0, row.error_code, row.server_ms, row.db_queries],
  ).catch(e => console.error('[mcp] tool-call log failed:', e.message));
}

/**
 * Builds an MCP server exposing the AirportOps tools.
 * getPrincipal(extra) must return { username, role } for the caller, or null if unauthenticated.
 */
export function createOpsMcpServer(getPrincipal) {
  const server = new McpServer({ name: 'airportops-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      outputSchema,
      annotations: {
        readOnlyHint: tool.access === 'read',
        destructiveHint: tool.access === 'consequential',
        idempotentHint: true, // reads are pure; writes dedupe by workflow; mutations dedupe by idempotency_key
      },
    }, async (args, extra) => {
      const t0 = performance.now();
      const counter = { n: 0 };
      const principal = getPrincipal(extra);
      const meta = extra?._meta || {};
      const workflow_id = typeof meta.workflow_id === 'string' ? meta.workflow_id : (args.workflow_id || null);
      let result, error;
      try {
        if (!principal) throw new OpsError('UNAUTHENTICATED', 'A valid bearer token is required');
        if (tool.access !== 'read' && principal.role !== 'admin') {
          throw new OpsError('FORBIDDEN', `${tool.name} requires the admin role (caller is ${principal.role})`);
        }
        const ctx = { db: counted(pool, counter), principal, counter, workflow_id };
        let timer;
        result = await Promise.race([
          tool.handler(ctx, args),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new OpsError('TIMEOUT', `${tool.name} exceeded ${TOOL_TIMEOUT_MS}ms`, { retryable: true })), TOOL_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
      } catch (e) {
        error = e?.name === 'ZodError'
          ? new OpsError('VALIDATION_ERROR', e.errors.map(x => `${x.path.join('.')}: ${x.message}`).join('; '))
          : toOpsError(e);
      }
      const server_ms = Math.round((performance.now() - t0) * 10) / 10;
      const structured = error
        ? { ok: false, error: error.toJSON(), meta: { tool: tool.name, server_ms, db_queries: counter.n } }
        : { ok: true, data: result, meta: { tool: tool.name, server_ms, db_queries: counter.n } };
      logToolCall({
        workflow_id, task_key: typeof meta.task_key === 'string' ? meta.task_key : null, tool: tool.name,
        principal: principal?.username || 'anonymous', args: redact(args), summary: error ? null : summarize(result),
        ok: !error, error_code: error?.code || null, server_ms: Math.round(server_ms), db_queries: counter.n,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
        ...(error ? { isError: true } : {}),
      };
    });
  }
  return server;
}
