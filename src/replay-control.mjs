// HTTP control handler for interactive `--replay` timeline scrubbing (`GET/POST /api/replay`).
// Kept out of `src/server-http.mjs` so every server module stays well below 500 lines.

const ACTIONS = new Set(['pause', 'resume', 'toggle', 'seek', 'speed']);

/**
 * Handle `GET / HEAD / POST /api/replay`.
 * Returns `404` when the server was not started with `--replay <file>`.
 */
export async function handleReplayRoute(req, res, {
  replayRunner, jsonBody, sendJson, send, broadcastConfig, broadcastReplay,
}) {
  if (!replayRunner) {
    return sendJson(res, 404, { ok: false, active: false, error: 'replay mode is not active' });
  }
  const m = req.method;
  if (m === 'GET' || m === 'HEAD') {
    return sendJson(res, 200, { ok: true, active: true, type: 'replay', ...replayRunner.replayDetail() });
  }
  if (m !== 'POST') {
    return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
  }
  const got = await jsonBody(req, res);
  if (!got) return;
  const action = got.body?.action;
  if (!ACTIONS.has(action)) {
    return sendJson(res, 400, { ok: false, error: 'action must be "pause", "resume", "toggle", "seek", or "speed"' });
  }
  try {
    let detail;
    if (action === 'pause') detail = replayRunner.pause();
    else if (action === 'resume') detail = await replayRunner.resume();
    else if (action === 'toggle') detail = await replayRunner.togglePause();
    else if (action === 'speed') {
      if (typeof got.body?.speed !== 'number') {
        return sendJson(res, 400, { ok: false, error: 'speed must be a number' });
      }
      detail = replayRunner.setSpeed(got.body.speed);
    }
    else if (action === 'seek') {
      const hasCursor = got.body?.cursor !== undefined;
      const hasProgress = got.body?.progress !== undefined;
      if (!hasCursor && !hasProgress) {
        return sendJson(res, 400, { ok: false, error: 'seek requires cursor or progress' });
      }
      if (hasCursor && !Number.isInteger(got.body.cursor)) {
        return sendJson(res, 400, { ok: false, error: 'cursor must be an integer' });
      }
      if (hasProgress && !( typeof got.body.progress === 'number' && Number.isFinite(got.body.progress) && got.body.progress >= 0 && got.body.progress <= 1)) {
        return sendJson(res, 400, { ok: false, error: 'progress must be a number in 0..1' });
      }
      detail = await replayRunner.seek({
        cursor: hasCursor ? got.body.cursor : undefined,
        progress: hasProgress ? got.body.progress : undefined,
        paused: typeof got.body?.paused === 'boolean' ? got.body.paused : undefined,
      });
    }
    broadcastConfig?.();
    broadcastReplay?.(detail);
    return sendJson(res, 200, { ok: true, active: true, type: 'replay', ...detail });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: String(err?.message || 'invalid replay command') });
  }
}
