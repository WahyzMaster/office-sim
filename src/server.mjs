// 로컬 서버 (contract 6): 파일 탐색/꼬리 읽기 루프 + HTTP/SSE.
// 루프 셋 (poll / rescan / idle) 은 서로 겹치지 않는다: 이전 tick 이 돌고 있으면 이번 tick 은 건너뛴다.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { createHttp, validInterval, MIN_INTERVAL, MAX_INTERVAL } from './server-http.mjs';
import { Runner } from './server-runner.mjs';
import { newToken } from './server-guard.mjs';

export const DEFAULTS = Object.freeze({
  port: 4317, host: '127.0.0.1', intervalMs: 250, activeMinutes: 30, rescanMs: 3000,
  idleMs: 1000, pingMs: 15000, ringSize: 1000, auth: false, replay: null, speed: 1, loop: false,
  root: path.join(os.homedir(), '.claude', 'projects'),
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
});
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 다른 모듈은 계약(3.4-3.6) 이름 그대로 가져온다. 테스트는 deps 로 일부를 바꿔 끼울 수 있다.
async function loadDeps(over = {}) {
  const deps = { ...over };
  if (!deps.SessionState) deps.SessionState = (await import('./session.mjs')).SessionState;
  if (!deps.Tailer) deps.Tailer = (await import('./tailer.mjs')).Tailer;
  if (!deps.scan || !deps.readSubMeta || !deps.readJournalLabels) {
    const d = await import('./discover.mjs');
    deps.scan ??= d.scan;
    deps.readSubMeta ??= d.readSubMeta;
    deps.readJournalLabels ??= d.readJournalLabels;
  }
  return deps;
}

function pick(options) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

function validate(o) {
  if (!validInterval(o.intervalMs)) throw new RangeError(`intervalMs must be an integer ${MIN_INTERVAL}..${MAX_INTERVAL}`);
  if (!(Number.isFinite(o.activeMinutes) && o.activeMinutes > 0)) throw new RangeError('activeMinutes must be > 0');
  for (const k of ['rescanMs', 'idleMs', 'pingMs']) {
    if (!(Number.isInteger(o[k]) && o[k] >= 10)) throw new RangeError(`${k} must be an integer >= 10`);
  }
  if (!(Number.isInteger(o.port) && o.port >= 0 && o.port <= 65535)) throw new RangeError('port must be 0..65535');
  // 127.0.0.1 등 루프백에만 바인딩한다 (contract 0)
  if (!LOOPBACK_HOSTS.has(o.host)) throw new RangeError('host must be a loopback address (127.0.0.1, localhost, ::1)');
  if (typeof o.auth !== 'boolean') throw new RangeError('auth must be a boolean');
  if (o.replay !== null && (typeof o.replay !== 'string' || o.replay === '')) throw new RangeError('replay must be a file path');
  if (!(Number.isFinite(o.speed) && o.speed >= 0.1 && o.speed <= 1000)) throw new RangeError('speed must be 0.1..1000');
  if (typeof o.loop !== 'boolean') throw new RangeError('loop must be a boolean');
}

/**
 * @param {object} options port, host, root, intervalMs, activeMinutes, rescanMs, publicDir,
 *   pingMs (SSE heartbeat, default 15000), idleMs (idle() loop, default 1000), ringSize, log, deps (test hook),
 *   auth (opt-in per-run token: every route then needs the cookie that GET /?t=<token> sets),
 *   replay (a main transcript path: replay it instead of tailing --root), speed (replay factor), loop (replay again),
 *   replayTiming (test hook: { maxGapMs, holdMs, restartMs, statusMs })
 * @returns {Promise<{ url: string, token: string|null, port: number, store: Store, ready: Promise, close: () => Promise<void> }>}
 *   With auth, `url` is the one to open: http://<host>:<port>/?t=<token>.
 */
export async function start(options = {}) {
  const opts = pick(options);
  opts.root = path.resolve(expandHome(opts.root));
  opts.publicDir = path.resolve(expandHome(opts.publicDir));
  if (typeof opts.replay === 'string' && opts.replay !== '') opts.replay = path.resolve(expandHome(opts.replay));
  validate(opts);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const deps = await loadDeps(opts.deps);
  // seq 는 시각에서 시작한다: 서버를 다시 띄워도 예전 Last-Event-ID 가 새 링과 겹치지 않는다
  const store = new Store({ log, ringSize: opts.ringSize, seqStart: opts.seqStart ?? Date.now() });
  // 재생 모드(P3): tail 루프 대신 지난 세션 파일을 기록 시각대로 흘려보내는 Runner. 상태가 바뀌면 config 로 알린다.
  let httpLayer = null;
  const replay = opts.replay ? await import('./replay.mjs') : null;
  const runner = replay
    ? new replay.ReplayRunner({ opts, deps, store, log, onStatus: () => httpLayer?.broadcastConfig() })
    : new Runner({ opts, deps, store, log });
  const config = () => ({
    intervalMs: opts.intervalMs, activeMinutes: opts.activeMinutes, ...(replay ? { replay: runner.replayStatus() } : {}),
  });
  const token = opts.auth ? newToken() : null; // 프로세스 안에서만 만든다 (argv/env 는 다른 사용자에게 보인다)
  let port = opts.port;
  httpLayer = createHttp({
    store,
    publicDir: opts.publicDir,
    pingMs: opts.pingMs,
    getPort: () => port,
    getConfig: config,
    setConfig: ({ intervalMs }) => {
      runner.setInterval(intervalMs);
      return config();
    },
    stats: () => ({ files: runner.files.size, sessions: store.sessionCount }),
    authToken: token,
    log,
  });
  const server = http.createServer(httpLayer.handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  const urlHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const url = `http://${urlHost}:${port}/${token ? `?t=${token}` : ''}`;
  runner.startLoops();
  const ready = runner.rescan(); // 첫 탐색은 듣기 시작한 뒤 백그라운드로
  let closing = null;
  const close = () => {
    closing ??= (async () => {
      await runner.close();
      httpLayer.closeAll();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    })();
    return closing;
  };
  return { url, token, port, store, ready, close, stats: () => ({
    files: runner.files.size, badLines: runner.badLines, skippedLines: runner.tailer.skippedLines ?? 0, applyErrors: runner.applyErrors,
  }) };
}
