import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateToken } from '../middleware/auth.js';
import * as engine from './engine.js';
import * as store from './store.js';
import { handleTurn } from './agents/conversation.js';
import { mcpSession, listTools, mcpUrl } from './mcp/client.js';
import { llmEnabled, llmModel } from './llm.js';
import { OpsError } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
router.use(authenticateToken);

const ctx = req => ({
  principal: { username: req.user.username, role: req.user.role },
  token: req.headers.authorization.split(' ')[1],
});
const STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID_STATE: 409, CONFLICT: 409, VALIDATION_ERROR: 400 };
const wrap = fn => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    const code = e instanceof OpsError ? e.code : 'INTERNAL';
    if (code === 'INTERNAL') console.error('[ops]', e);
    res.status(STATUS[code] || 500).json({ error: e.message, code });
  }
};
const STRATEGIES = ['auto', 'parallel', 'sequential'];
const strategyOf = s => (STRATEGIES.includes(s) ? s : 'auto');

router.get('/health', wrap(async req => {
  const tools = await listTools(ctx(req).token);
  return { mcp_url: mcpUrl(), mcp_tools: tools.length, llm_enabled: llmEnabled(), llm_model: llmModel(), role: req.user.role };
}));

router.get('/tools', wrap(async req => (await listTools(ctx(req).token)).map(t => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations }))));

router.post('/converse', wrap(async req => {
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) throw new OpsError('VALIDATION_ERROR', 'text is required');
  const conversationId = String(req.body?.conversation_id || 'default').slice(0, 64);
  return handleTurn({ conversationId, text, ...ctx(req), strategy: strategyOf(req.body?.strategy) });
}));

router.post('/workflows', wrap(async req => {
  const request = String(req.body?.request || '').trim().slice(0, 1000);
  if (!request) throw new OpsError('VALIDATION_ERROR', 'request is required');
  const wf = await engine.startWorkflow({ request, ...ctx(req), strategy: strategyOf(req.body?.strategy) });
  return { workflow_id: wf.id, intent: wf.intent };
}));

router.get('/workflows', wrap(async req => store.listWorkflows({ includeBenchmark: req.query.benchmark === '1' })));

router.get('/workflows/:id', wrap(async req => {
  const live = engine.getLive(req.params.id);
  const persisted = await store.getWorkflowSnapshot(req.params.id);
  if (!live && !persisted) throw new OpsError('NOT_FOUND', 'Workflow not found');
  return { live: live ? live.snapshot() : null, persisted };
}));

// Server-sent events over a normal authenticated GET (the client reads it with fetch, so the
// token travels in the Authorization header rather than the URL).
router.get('/workflows/:id/stream', (req, res) => {
  const wf = engine.getLive(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (!wf) {
    send('gone', { id: req.params.id });
    return res.end();
  }
  send('snapshot', wf.snapshot());
  let pending = false;
  const unsubscribe = engine.subscribe(req.params.id, ev => {
    send('event', ev);
    // Coalesce snapshots: at most one per tick, so a burst of task events costs one serialisation.
    if (!pending) { pending = true; setImmediate(() => { pending = false; send('snapshot', wf.snapshot()); }); }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); unsubscribe?.(); });
});

router.post('/workflows/:id/approve', wrap(async req => engine.approve(req.params.id, { ...ctx(req), note: req.body?.note })));
router.post('/workflows/:id/reject', wrap(async req => engine.reject(req.params.id, { ...ctx(req), note: req.body?.note })));
router.post('/workflows/:id/cancel', wrap(async req => engine.cancel(req.params.id, ctx(req))));

router.post('/workflows/:id/feedback', wrap(async req => {
  const { token } = ctx(req);
  const mcp = mcpSession({ token, workflowId: req.params.id });
  return mcp.call('record_workflow_feedback', { workflow_id: req.params.id, rating: req.body?.rating, ...(req.body?.comment ? { comment: String(req.body.comment).slice(0, 1000) } : {}) });
}));

router.get('/metrics', wrap(async req => mcpSession({ token: ctx(req).token }).call('get_execution_metrics', { include_benchmark: req.query.benchmark !== '0' })));

router.get('/benchmark', wrap(async () => {
  const file = path.join(here, '..', 'bench', 'results', 'latest.json');
  if (!fs.existsSync(file)) return { available: false, hint: 'Run: npm run bench (in server/)' };
  return { available: true, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}));

export default router;
