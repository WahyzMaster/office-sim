// 로컬 서버 (contract 6): 파일 탐색/꼬리 읽기 루프 + HTTP/SSE.
// 루프 셋 (poll / rescan / idle) 은 서로 겹치지 않는다: 이전 tick 이 돌고 있으면 이번 tick 은 건너뛴다.
// 켜진 어댑터마다 Runner 하나, Store 와 HTTP 는 하나 (contract 4.0.1, RunnerGroup).
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { createHttp, validInterval, MIN_INTERVAL, MAX_INTERVAL } from './server-http.mjs';
import { Runner } from './server-runner.mjs';
import { newToken } from './server-guard.mjs';
import { ADAPTERS, KNOWN_AGENTS, checkAgents, isKnownAgent, probeRoot, probeWithin, selectAdapters } from './adapters/index.mjs';
import { ObserveControl } from './observe/control.mjs';

const CLAUDE = 'claude-code';
const OBSERVED = Object.freeze(['grok', 'codex']); // 기록 관찰이 보는 어댑터 (observe-spec)
/** D1 startup order: how long a Runner with a floor rule waits for the other Runners' first rescan at most. */
export const FIRST_PASS_WAIT_MS = 10_000;

export const DEFAULTS = Object.freeze({
  port: 4317, host: '127.0.0.1', intervalMs: 250, activeMinutes: 30, rescanMs: 3000,
  idleMs: 1000, pingMs: 15000, ringSize: 1000, auth: false, replay: null, speed: 1, loop: false,
  root: path.join(os.homedir(), '.claude', 'projects'),
  agents: null, roots: null, observeDir: null,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
});
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
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
  if (o.observeDir !== null && (typeof o.observeDir !== 'string' || o.observeDir === '')) throw new RangeError('observeDir must be a folder path');
  if (o.agents !== null) checkAgents(o.agents); // 모르는 id 는 RangeError
  if (o.roots !== null) {
    if (typeof o.roots !== 'object' || Array.isArray(o.roots)) throw new RangeError('roots must be an object { <agent id>: <dir> }');
    for (const [id, dir] of Object.entries(o.roots)) {
      // Claude Code 루트는 root 옵션 하나뿐이다 (--claude-root / --root)
      if (!isKnownAgent(id) || id === CLAUDE) throw new RangeError(`roots: no root option for "${String(id).slice(0, 40)}"`);
      if (typeof dir !== 'string' || dir === '') throw new RangeError(`roots.${id} must be a directory path`);
    }
  }
}

// KNOWN_AGENTS 안의 순서 (모르는 id 는 맨 뒤): 늦게 켜진 어댑터도 이 순서로 끼워 넣는다 (4.0.1 의 목록 순서).
const agentRank = (id) => {
  const i = KNOWN_AGENTS.indexOf(id);
  return i < 0 ? KNOWN_AGENTS.length : i;
};

/**
 * One Runner per enabled adapter (ADAPTERS.md 3.5), all sharing one Store and one HTTP layer. Forwards the loop
 * controls to every Runner and sums their counters. With no Runner it is an empty office.
 * `late` (F1, optional): { waiting: [{ id, root }], probe, probeTimeoutMs, rescanMs, activate(id, root) -> Runner, log,
 * onEnabled?(id) (called once the new Runner is in the group) }.
 * Every rescan period the waiting roots are checked again (same probe and time limit as at start); a root that can be
 * opened now gets its Runner, in KNOWN_AGENTS order, with the loops already running.
 */
export class RunnerGroup {
  constructor(entries = [], late = null) {
    this.entries = entries.map(({ id, runner }) => ({ id, runner })); // [{ id: agent id, runner }]
    this.late = late;
    this.waiting = (late?.waiting ?? []).map(({ id, root }) => ({ id, root, busy: false, failed: false }));
    this.started = false;
    this.firstRescanned = false; // D1: 첫 rescan 은 층 규칙이 있는 Runner 를 다른 Runner 뒤에 (rescan())
    this.firstPassWaitMs = FIRST_PASS_WAIT_MS; // 그래도 이보다 오래 기다리지는 않는다 (멈춘 마운트가 Grok 을 막지 않게)
    this.closed = false;
    this.timer = null;
    this.checking = null;
  }

  get ids() { return this.entries.map((x) => x.id); }
  get runners() { return this.entries.map((x) => x.runner); }
  get fileCount() { return this.sum((r) => r.files.size); }

  sum(fn) {
    let n = 0;
    for (const { runner } of this.entries) n += fn(runner) || 0;
    return n;
  }

  startLoops() {
    this.started = true;
    for (const { runner } of this.entries) runner.startLoops();
    if (this.waiting.length && !this.timer && !this.closed) {
      this.timer = setInterval(() => { void this.recheck(); }, this.late.rescanMs);
      this.timer.unref?.();
    }
  }

  // D1 시작 순서 (CONTRACT 4.6 Floors): 첫 rescan 에서 층 규칙이 있는 Runner (Grok 의 도구 전용 워크트리는 이미 있는
  // 층을 라벨로 찾는다) 는 다른 Runner 의 첫 탐색(붙이기, 알리기)이 끝난 뒤에 탐색한다 (길어도 firstPassWaitMs 까지).
  // 그 Runner 의 rescan 주기도 이 약속을 기다리므로 시작 순서가 층을 정하지 않는다. 다른 Runner (Claude) 는 기다리지
  // 않고, 그 뒤의 rescan 은 모두 함께 돈다.
  rescan() {
    if (this.firstRescanned) return Promise.all(this.entries.map(({ runner }) => runner.rescan()));
    this.firstRescanned = true;
    const ruled = (runner) => runner.floorRule === true;
    const plain = this.entries.map(({ runner }) => (ruled(runner) ? null : runner.rescan()));
    const gate = new Promise((resolve) => {
      const timer = setTimeout(resolve, this.firstPassWaitMs);
      timer.unref?.();
      Promise.all(plain.filter((p) => p !== null)).then(resolve, resolve).finally(() => clearTimeout(timer));
    });
    return Promise.all(this.entries.map(({ runner }, i) => {
      if (!ruled(runner)) return plain[i];
      runner.gate = gate;
      return runner.rescan();
    }));
  }

  // F1: 시작할 때 루트가 없거나 읽을 수 없던 어댑터를 다시 확인한다. 겹치지 않는다 (돌고 있으면 그 약속을 돌려준다).
  // 돌려주는 값: 이번에 켜진 어댑터 id 목록.
  recheck() {
    if (this.checking) return this.checking;
    if (this.closed || !this.waiting.length) return Promise.resolve([]);
    this.checking = this.recheckOnce().finally(() => { this.checking = null; });
    return this.checking;
  }

  async recheckOnce() {
    const { probe, probeTimeoutMs, activate, log } = this.late;
    const on = [];
    for (const w of [...this.waiting]) {
      // 지난 확인이 아직 답하지 않았다 (멈춘 마운트): 새 확인을 쌓지 않는다 (opendir 마다 스레드 풀 하나를 붙잡는다)
      if (this.closed || w.busy) continue;
      w.busy = true;
      let code;
      try {
        code = await probeWithin(probe, w.root, w.id, probeTimeoutMs, { unref: true, onSettle: () => { w.busy = false; } });
      } catch {
        code = 'EUNKNOWN';
      }
      if (code || this.closed) continue;
      let runner;
      try {
        runner = await activate(w.id, w.root);
      } catch (err) {
        if (!w.failed) log(`${w.id}: adapter start failed (${typeof err?.code === 'string' ? err.code : 'error'})`);
        w.failed = true;
        continue;
      }
      if (this.closed) break; // 아직 루프를 시작하지 않은 Runner 라 버리면 된다
      this.waiting.splice(this.waiting.indexOf(w), 1);
      const at = this.entries.findIndex((x) => agentRank(x.id) > agentRank(w.id));
      this.entries.splice(at < 0 ? this.entries.length : at, 0, { id: w.id, runner });
      log(`${w.id}: root found, adapter on`); // 경로는 남기지 않는다
      if (this.started) {
        runner.startLoops();
        void runner.rescan();
      }
      try {
        this.late.onEnabled?.(w.id); // 기록 관찰: 볼 수 있는 루트가 늘었다
      } catch {
        // 알림 실패는 어댑터 켜기를 막지 않는다
      }
      on.push(w.id);
    }
    if (!this.waiting.length) this.stopRecheck();
    return on;
  }

  stopRecheck() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // 각 Runner 는 자기 opts 복사본을 가진다: 같은 객체를 나눠 쓰면 첫 Runner 가 값을 바꾼 뒤 나머지는 "같은 값"으로 보고
  // 기다리는 poll 을 앞당기지 않는다.
  setInterval(ms) { for (const { runner } of this.entries) runner.setInterval(ms); }

  async close() {
    this.closed = true;
    this.stopRecheck();
    await Promise.allSettled(this.entries.map(({ runner }) => runner.close()));
  }

  stats() {
    return {
      files: this.fileCount,
      badLines: this.sum((r) => r.badLines),
      skippedLines: this.sum((r) => r.tailer?.skippedLines ?? 0),
      applyErrors: this.sum((r) => r.applyErrors),
    };
  }
}

// 어댑터 id -> 루트 (절대 경로). Claude Code 는 root 옵션, 나머지는 roots[id] 가 있을 때만: start() 는 다른 어댑터의 기본
// 루트(~/.grok ...)로 돌아가지 않는다. 기본 루트는 bin 이 채운다 (defaultRoots), 그래서 루트를 주지 않은 호출(테스트)은
// 실제 기록 폴더를 확인하지도 읽지도 않는다 (ADAPTERS 10).
function rootsFor(opts, adapters) {
  const out = {};
  for (const id of Object.keys(adapters)) {
    if (id === CLAUDE) out[id] = opts.root;
    else if (typeof opts.roots?.[id] === 'string' && opts.roots[id] !== '') out[id] = path.resolve(expandHome(opts.roots[id]));
  }
  return out;
}

// 켤 어댑터를 고르고 (D3) Runner 를 만든다. 각 Runner 는 자기 루트와 자기 opts 복사본을 가진다.
async function createRunners({ opts, store, log, onStatus, onEnabled }) {
  const adapters = opts.adapters ?? ADAPTERS; // 테스트 훅: 등록표를 바꿔 끼운다
  if (opts.replay) {
    // 재생(6.1)은 Claude Code 만 (D12): 루트를 확인하지 않고 (--claude-root 는 재생에 쓰지 않는다) --agents 와 무관하다
    const claude = adapters[CLAUDE];
    const ReplayRunner = await claude.replayRunner();
    const runner = new ReplayRunner({ opts: { ...opts }, deps: await claude.deps(opts.deps), store, log, onStatus });
    // 라이브 모드(selectAdapters)와 같이 KNOWN_AGENTS 순서, 중복 없이
    const wanted = opts.agents == null ? [] : checkAgents(opts.agents);
    const notImplemented = KNOWN_AGENTS.filter((id) => wanted.includes(id) && !Object.hasOwn(adapters, id));
    return { group: new RunnerGroup([{ id: CLAUDE, runner }]), notImplemented };
  }
  // 테스트 훅: claude-code 에 가짜 scan 을 넣으면 탐색 자체가 가짜라 실제 폴더를 확인하지 않는다. probe 는 루트 확인 자체를 바꾼다.
  const probe = typeof opts.probe === 'function'
    ? opts.probe
    : (root, id) => (id === CLAUDE && typeof opts.deps?.scan === 'function' ? null : probeRoot(root));
  // 루트 확인은 listen 전에 돈다: 멈춘 마운트가 서버 시작을 막지 않게 제한 시간이 있다 (넘으면 ETIMEDOUT 으로 끈다)
  const roots = rootsFor(opts, adapters);
  const sel = await selectAdapters({ agents: opts.agents, roots, adapters, probe, probeTimeoutMs: opts.probeTimeoutMs });
  // 루트가 없거나 읽을 수 없는 어댑터는 조용히 끈다: 로그 한 줄 (경로는 남기지 않는다), 서버는 빈 사무실로도 뜬다.
  // 꺼진 어댑터는 rescan 주기마다 다시 확인해서, 루트가 생기면 그때 켠다 (F1, RunnerGroup.recheck).
  for (const { id, code } of sel.off) log(`${id}: root ${code === 'ENOENT' ? 'not found' : `not readable (${code})`}, adapter off`);
  // 늦게 켜지는 Runner 도 같은 방법으로 만든다: 그때의 opts 복사본 (POST /config 로 바뀐 간격 포함)
  const activate = async (id, root) => {
    const deps = await adapters[id].deps(id === CLAUDE ? opts.deps : undefined);
    return new Runner({ opts: { ...opts, root }, deps, store, log });
  };
  const entries = [];
  for (const { id, root } of sel.enabled) entries.push({ id, runner: await activate(id, root) });
  const late = {
    waiting: sel.off.map(({ id }) => ({ id, root: roots[id] })),
    probe, probeTimeoutMs: opts.probeTimeoutMs, rescanMs: opts.rescanMs, activate, log, onEnabled,
  };
  return { group: new RunnerGroup(entries, late), notImplemented: sel.notImplemented };
}

// 기록 관찰이 볼 루트: 지금 켜진 grok / codex Runner 의 루트 (Runner 가 쓰는 절대 경로, 늦게 켜진 어댑터 포함 F1).
// 재생 모드의 묶음은 Claude Code 뿐이라 비어 있다 (available false).
function observeRoots(group) {
  const out = {};
  for (const { id, runner } of group.entries) {
    if (OBSERVED.includes(id) && typeof runner?.opts?.root === 'string') out[id] = runner.opts.root;
  }
  return out;
}

// 시험 훅 observeTiming { intervalMs, rescanMs, notifyMs }: 숫자인 것만 ObserveControl 에 넘긴다
function observeTiming(t) {
  const out = {};
  for (const k of ['intervalMs', 'rescanMs', 'notifyMs']) if (Number.isFinite(t?.[k]) && t[k] > 0) out[k] = t[k];
  return out;
}

/**
 * @param {object} options port, host, root (Claude Code root), intervalMs, activeMinutes, rescanMs, publicDir,
 *   pingMs (SSE heartbeat, default 15000), idleMs (idle() loop, default 1000), ringSize, log,
 *   agents (adapter ids to enable, default: every implemented adapter whose root exists), roots ({ <agent id>: dir }
 *   for the non-Claude adapters; one without a root here is not started, the bin passes defaultRoots()), auth (opt-in
 *   per-run token: every route then needs the cookie that GET /?t=<token> sets), replay (a main transcript path: replay it instead of tailing --root), speed (replay factor), loop (replay
 *   again), observeDir (live log observation output folder: turns on GET/POST /observe and the `observe` SSE message;
 *   absent = feature off, nothing changes). Test hooks: deps (claude-code deps override; a fake scan also skips the
 *   root check), adapters (registry override), probe ((root, id) => error code | null, replaces the root check),
 *   probeTimeoutMs (root check time limit, default 2000), replayTiming ({ maxGapMs, holdMs, restartMs, statusMs }),
 *   observeTiming ({ intervalMs, rescanMs, notifyMs } of the observation loop).
 * @returns {Promise<{ url: string, token: string|null, port: number, store: Store, ready: Promise, close: () => Promise<void>,
 *   agents: string[], notImplemented: string[], stats: () => object }>}
 *   With auth, `url` is the one to open: http://<host>:<port>/?t=<token>. `agents`: the enabled adapter ids, read
 *   live (a getter: an adapter whose root shows up later is included from then on, F1). `stats()`: the summed Runner
 *   counters plus the Store's `rejectedRefs` (F2). `notImplemented`: requested ids (agents) that are known but not
 *   implemented yet.
 */
export async function start(options = {}) {
  const opts = pick(options);
  opts.root = path.resolve(expandHome(opts.root));
  opts.publicDir = path.resolve(expandHome(opts.publicDir));
  if (typeof opts.replay === 'string' && opts.replay !== '') opts.replay = path.resolve(expandHome(opts.replay));
  if (typeof opts.observeDir === 'string' && opts.observeDir !== '') opts.observeDir = path.resolve(expandHome(opts.observeDir));
  validate(opts);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  // seq 는 시각에서 시작한다: 서버를 다시 띄워도 예전 Last-Event-ID 가 새 링과 겹치지 않는다
  const store = new Store({ log, ringSize: opts.ringSize, seqStart: opts.seqStart ?? Date.now() });
  // 재생 모드(P3): tail 루프 대신 지난 세션 파일을 기록 시각대로 흘려보내는 Runner. 상태가 바뀌면 config 로 알린다.
  let httpLayer = null;
  let observe = null;
  const { group, notImplemented } = await createRunners({
    opts, store, log, onStatus: () => httpLayer?.broadcastConfig(),
    // 늦게 켜진 grok / codex 루트는 관찰 상태(available, agents)를 바꾼다: 열린 페이지에 바로 알린다
    onEnabled: (id) => { if (observe && OBSERVED.includes(id)) httpLayer?.broadcastObserve(observe.status()); },
  });
  // 기록 관찰 (observe-spec): observeDir 이 있을 때만 켠다. 없으면 /observe 경로도 observe 메시지도 없다 (예전 그대로).
  if (opts.observeDir) {
    observe = new ObserveControl({ roots: () => observeRoots(group), dir: opts.observeDir, ...observeTiming(opts.observeTiming) });
  }
  const replayRunner = opts.replay ? group.runners[0] : null;
  const config = () => ({
    intervalMs: opts.intervalMs, activeMinutes: opts.activeMinutes, ...(replayRunner ? { replay: replayRunner.replayStatus() } : {}),
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
      opts.intervalMs = intervalMs;
      group.setInterval(intervalMs);
      return config();
    },
    stats: () => ({ files: group.fileCount, sessions: store.sessionCount, agents: group.ids }),
    authToken: token,
    observe,
    log,
  });
  // 시작, 끝, 진행(바뀌었을 때 1초에 한 번까지)을 SSE 로 알린다. config 처럼 제어 메시지라 Store 와 링에는 없다.
  if (observe) observe.onChange = (status) => httpLayer.broadcastObserve(status);
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
  group.startLoops();
  const ready = group.rescan(); // 첫 탐색은 듣기 시작한 뒤 백그라운드로
  let closing = null;
  const close = () => {
    closing ??= (async () => {
      // 관찰 중이면 요약을 쓰고 닫는다. 끝 상태는 아직 붙어 있는 페이지에 알린 뒤 SSE 를 닫는다.
      await Promise.all([observe ? observe.close().catch(() => {}) : null, group.close()]);
      httpLayer.closeAll();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    })();
    return closing;
  };
  return {
    url, token, port, store, ready, close, notImplemented,
    stats: () => ({ ...group.stats(), ...store.stats() }),
    get agents() { return group.ids; }, // 늦게 켜진 어댑터도 (F1)
  };
}
