import crypto from 'crypto';

export class OpsError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) };
  }
}

const RETRYABLE_DB = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT']);

export function toOpsError(e) {
  if (e instanceof OpsError) return e;
  if (e?.code && RETRYABLE_DB.has(e.code)) return new OpsError('DB_TRANSIENT', `Transient database error (${e.code})`, { retryable: true });
  if (e?.code === 'ER_DUP_ENTRY') return new OpsError('CONFLICT', 'Conflicting record already exists');
  if (e?.name === 'AbortError') return new OpsError('CANCELLED', 'Operation cancelled');
  return new OpsError('INTERNAL', e?.message || 'Unexpected error');
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const hashArgs = args => sha256(stableStringify(args));

// Licence keys and similar secrets must never reach logs, traces or model prompts.
const SECRET_KEYS = /(_key|password|token|secret|authorization)$/i;
export function redact(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => redact(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(val, depth + 1);
  return out;
}

// Wraps a mysql2 pool/connection so every query is counted (reported as db_queries in metrics).
export function counted(db, counter) {
  return {
    query: (...a) => { counter.n++; return db.query(...a); },
    raw: db,
  };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new OpsError('CANCELLED', 'Operation cancelled')); }, { once: true });
});

export function parseSizeGB(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)\s*(TB|GB|G|T)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /^t/i.test(m[2] || '') ? n * 1024 : n;
}
