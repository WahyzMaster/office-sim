// HTTP JSON/API route handlers and bounded request body parsing for server-http.mjs.
import { HOOK_MAX_BODY } from './hooks-bridge.mjs';
import { focusTerminalForSession } from './terminal-focus.mjs';
import { handleReplayRoute } from './replay-control.mjs';

export const MIN_INTERVAL = 50;
export const MAX_INTERVAL = 5000;
const MAX_BODY = 4096;
const DRAIN_LIMIT = 1024 * 1024;
const OBSERVE_ACTIONS = new Set(['start', 'stop']);
const ERROR_CODE_RE = /^E[A-Z0-9_]{1,31}$/;
const drainMax = (limit) => Math.max(DRAIN_LIMIT, 2 * limit);
const tooLarge = () => Object.assign(new Error('body too large'), { status: 413 });

export function validInterval(v) {
  return Number.isInteger(v) && v >= MIN_INTERVAL && v <= MAX_INTERVAL;
}

export function discardRest(req, already = 0, max = DRAIN_LIMIT) {
  let drained = already;
  req.on('data', (c) => {
    drained += c.length;
    if (drained > max) req.destroy();
  });
  req.resume();
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        req.off('data', onData);
        discardRest(req, size, drainMax(limit));
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return String(origin).toLowerCase() === `http://${String(req.headers.host ?? '').toLowerCase()}`;
}

export function createJsonBody({ sendJson, onCrossSiteBlock }) {
  return async function jsonBody(req, res, limit = MAX_BODY) {
    const refuse = (status, error) => {
      sendJson(res, status, { error });
      return null;
    };
    if (!sameOrigin(req)) {
      onCrossSiteBlock?.();
      return refuse(403, 'cross-origin request');
    }
    const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!ctype.startsWith('application/json')) return refuse(415, 'content-type must be application/json');
    if (Number(req.headers['content-length']) > limit) {
      discardRest(req, 0, drainMax(limit));
      return refuse(413, 'body too large');
    }
    try {
      return { body: JSON.parse(await readBody(req, limit)) };
    } catch (err) {
      return refuse(err?.status ?? 400, err?.status === 413 ? 'body too large' : 'invalid json');
    }
  };
}

async function postConfig(req, res, ctx) {
  const got = await ctx.jsonBody(req, res);
  if (!got) return;
  const v = got.body?.intervalMs;
  if (!validInterval(v)) {
    return ctx.sendJson(res, 400, { error: `intervalMs must be an integer ${MIN_INTERVAL}..${MAX_INTERVAL}` });
  }
  ctx.setConfig({ intervalMs: v });
  ctx.broadcastConfig();
  ctx.sendJson(res, 200, { type: 'config', ...ctx.currentConfig() });
}

async function postNotify(req, res, ctx) {
  const got = await ctx.jsonBody(req, res);
  if (!got) return;
  if (got.body?.enabled !== undefined && typeof got.body.enabled !== 'boolean') {
    return ctx.sendJson(res, 400, { error: 'enabled must be a boolean' });
  }
  try {
    ctx.notifier.configure({ enabled: got.body?.enabled, categories: got.body?.categories });
  } catch (err) {
    return ctx.sendJson(res, 400, { error: err?.message ?? 'invalid notify options' });
  }
  if (got.body?.test === true) await ctx.notifier.sendTestNotification();
  ctx.broadcastConfig();
  ctx.sendJson(res, 200, { ok: true, ...ctx.notifier.status() });
}

async function postFlywheel(req, res, ctx) {
  const got = await ctx.jsonBody(req, res);
  if (!got) return;
  const action = got.body?.action;
  if (action === 'scan') {
    const snap = await ctx.flywheel.scan({
      triggerSource: got.body?.triggerSource ?? 'on_demand',
      extraCandidates: Array.isArray(got.body?.extraCandidates) ? got.body.extraCandidates : [],
    });
    return ctx.sendJson(res, 200, { ok: true, type: 'flywheel', ...snap });
  }
  if (action === 'config') {
    const r = await ctx.flywheel.updateConfig(got.body?.config ?? got.body);
    if (!r.ok) return ctx.sendJson(res, 400, { ok: false, error: r.error });
    return ctx.sendJson(res, 200, { ok: true, type: 'flywheel', ...r.status });
  }
  if (action === 'approve') {
    const r = await ctx.flywheel.approveDryRun(got.body?.fingerprint, { approvedBy: got.body?.approvedBy });
    return ctx.sendJson(res, r.ok ? 200 : 400, r);
  }
  if (action === 'seed') {
    const r = await ctx.flywheel.seedContract(got.body?.fingerprint, {
      linearIssueIdentifier: got.body?.linearIssueIdentifier,
    });
    return ctx.sendJson(res, r.ok ? 200 : 400, r);
  }
  return ctx.sendJson(res, 400, { error: 'action must be "scan", "config", "approve", or "seed"' });
}

async function postObserve(req, res, ctx) {
  const got = await ctx.jsonBody(req, res);
  if (!got) return;
  const action = got.body?.action;
  if (!OBSERVE_ACTIONS.has(action)) return ctx.sendJson(res, 400, { error: 'action must be "start" or "stop"' });
  let status;
  try {
    status = action === 'start' ? await ctx.observe.start() : await ctx.observe.stop();
  } catch (err) {
    const code = typeof err?.code === 'string' && ERROR_CODE_RE.test(err.code) ? err.code : 'EUNKNOWN';
    return ctx.sendJson(res, 500, { error: `observe ${action} failed`, code });
  }
  ctx.sendJson(res, 200, { type: 'observe', ...status });
}

export async function handleApiRoute(req, res, { rawPath, raw, q, m, isGet }, ctx) {
  const { send, sendJson, jsonBody, store, observe, replayRunner, focusOpts, hooks, recapTracker, notifier, flywheel, currentConfig, broadcastConfig, broadcastReplay } = ctx;
  if (rawPath === '/api/flywheel') {
    if (m === 'POST') return postFlywheel(req, res, ctx);
    if (isGet) {
      const wantScan = q >= 0 && new URLSearchParams(raw.slice(q + 1)).get('scan') === '1';
      const snap = wantScan ? await flywheel.scan({ triggerSource: 'on_demand' }) : flywheel.status();
      return sendJson(res, 200, { type: 'flywheel', ...snap });
    }
    return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
  }
  if (rawPath === '/config') {
    if (m === 'POST') return postConfig(req, res, ctx);
    if (isGet) return sendJson(res, 200, { type: 'config', ...currentConfig() });
    return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
  }
  if (rawPath === '/api/replay') {
    return handleReplayRoute(req, res, { replayRunner, jsonBody, sendJson, send, broadcastConfig, broadcastReplay });
  }
  if (rawPath === '/api/notify') {
    if (m === 'POST') return postNotify(req, res, ctx);
    if (isGet) return sendJson(res, 200, { ok: true, ...notifier.status() });
    return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
  }
  if (observe && rawPath === '/observe') {
    if (m === 'POST') return postObserve(req, res, ctx);
    if (isGet) return sendJson(res, 200, { type: 'observe', ...observe.status() });
    return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
  }
  if (rawPath === '/api/hooks/claude') {
    if (m !== 'POST') return send(res, 405, 'method not allowed', undefined, { allow: 'POST' });
    const got = await jsonBody(req, res, HOOK_MAX_BODY);
    if (!got) return true;
    const out = hooks.handle(got.body);
    return sendJson(res, out.status, out.body);
  }
  if (rawPath === '/api/focus-terminal') {
    if (m !== 'POST') return send(res, 405, 'method not allowed', undefined, { allow: 'POST' });
    const got = await jsonBody(req, res);
    if (!got) return true;
    const result = await focusTerminalForSession(got.body?.sessionId, {
      store, ttyHint: got.body?.tty ?? null, ...(focusOpts ?? {}),
    });
    return sendJson(res, result.ok ? 200 : 404, result);
  }
  if (rawPath === '/api/recap') {
    if (!isGet) return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD' });
    const sid = q >= 0 ? new URLSearchParams(raw.slice(q + 1)).get('sessionId') : null;
    if (sid) {
      const recap = recapTracker.getRecap(sid);
      if (!recap) return sendJson(res, 404, { error: 'session not found' });
      return sendJson(res, 200, recap);
    }
    return sendJson(res, 200, { sessions: recapTracker.summaryList() });
  }
  if (rawPath === '/api/recap/review') {
    if (m !== 'POST') return send(res, 405, 'method not allowed', undefined, { allow: 'POST' });
    const got = await jsonBody(req, res);
    if (!got) return true;
    const ok = recapTracker.markReviewed(got.body?.sessionId);
    return sendJson(res, ok ? 200 : 404, { ok });
  }
  return false;
}
