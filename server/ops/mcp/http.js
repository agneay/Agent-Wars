// Streamable HTTP MCP endpoint (stateful sessions) mounted on the Express app at /mcp.
// Every request must carry the app's JWT as a bearer token; a session is bound to the user who opened it.
import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createOpsMcpServer } from './server.js';

const sessions = new Map(); // sessionId -> { transport, username, lastSeen }
const SESSION_IDLE_MS = 30 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [sid, s] of sessions) if (s.lastSeen < cutoff) { s.transport.close().catch(() => {}); sessions.delete(sid); }
}, 60_000).unref();

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

function authenticate(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    return { token, principal: { username: user.username, role: user.role } };
  } catch {
    return null;
  }
}

export function mcpRouter() {
  const router = express.Router();
  router.all('/', async (req, res) => {
    const auth = authenticate(req);
    if (!auth) return rpcError(res, 401, 'Unauthorized: bearer token required');
    req.auth = { token: auth.token, clientId: auth.principal.username, scopes: [auth.principal.role], extra: auth.principal };

    const sid = req.headers['mcp-session-id'];
    try {
      if (sid) {
        const s = sessions.get(sid);
        if (!s) return rpcError(res, 404, 'Unknown or expired MCP session');
        if (s.username !== auth.principal.username) return rpcError(res, 403, 'Session belongs to another user');
        s.lastSeen = Date.now();
        return await s.transport.handleRequest(req, res, req.body);
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) return rpcError(res, 400, 'Missing mcp-session-id (send initialize first)');

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true, // tool calls are short; plain JSON responses avoid SSE framing overhead
        onsessioninitialized: id => sessions.set(id, { transport, username: auth.principal.username, lastSeen: Date.now() }),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      const server = createOpsMcpServer(extra => extra?.authInfo?.extra || null);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed:', e);
      if (!res.headersSent) rpcError(res, 500, 'Internal MCP error');
    }
  });
  return router;
}
