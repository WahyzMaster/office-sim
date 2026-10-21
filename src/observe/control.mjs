// 기록 관찰의 켜고 끄기 (observe-spec "Files", "Server and HTTP" 의 Status). ObserveControl 하나가 관찰 한 번씩을 맡는다:
// 시작하면 <dir>/observe-<YYYYMMDD-HHMMSS>.jsonl 을 새로 만들고 (폴더 0700, 파일 0600, 이미 있는 이름이면 -2, -3 ...),
// 기록이 생기는 대로 덧붙인다 (tick 마다 모아서 한 번; 쓰다 실패하면 다음 tick 에 쓰지 못한 바이트부터 이어 쓴다).
// 끝내면 summary 기록을 붙이고 파일을 닫는다. 멈춘 마운트에 걸린 단계는 STOP_WAIT_MS 까지만 기다린다.
// 루프는 setTimeout 사슬 하나다: tick 마다 (rescanMs 가 지났으면) rescan, 그다음 poll, 그다음 쓰기. 그래서 겹치지 않는다.
// start / stop / close 도 차례로 돈다. 상태(status)에는 개수와 출력 파일의 이름만 있다 (폴더 경로는 없다).
// 바뀐 상태는 onChange(status) 로 알린다: 시작과 끝은 바로, 도는 동안에는 바뀌었을 때 1초에 한 번까지.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Observer } from './observer.mjs';
import { Tally, progress } from './summary.mjs';
import { errorCode } from './records.mjs';

/** Poll period (ms). */
export const POLL_MS = 100;
/** Rescan period (ms). */
export const RESCAN_MS = 2000;
/** onChange while running: at most once per this many ms. */
export const NOTIFY_MS = 1000;
/** Output folder and file modes. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
/** stop() / close() wait at most this long for a step still running (an fs call on a stalled mount cannot be aborted). */
export const STOP_WAIT_MS = 1500;
/** Records waiting behind a failing output write at most (past it the oldest waiting ones are dropped). */
export const MAX_PENDING = 20_000;

const WRITE_FLAGS = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_APPEND | (FS.O_NOFOLLOW ?? 0);
const MAX_SUFFIX = 99;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Local 'YYYYMMDD-HHMMSS' of ms (the output file name stamp). */
export function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const dirOf = (v) => (typeof v === 'string' && v !== '' ? v : null);

// fs 오류의 message 에는 경로가 들어 있다: 코드만 가진 새 오류로 바꾼다
function plainError(err) {
  const code = errorCode(err);
  const e = new Error(`observe output not writable (${code})`);
  e.code = code;
  return e;
}

/**
 * new ObserveControl({ roots, dir, now?, intervalMs?, rescanMs?, timers?, fsImpl?, onChange?, platform?, notifyMs?,
 *   stopWaitMs? })
 * - roots: { grok?: dir, codex?: dir } of the enabled adapters, or a function returning it (read at each start() and
 *   status()). Neither -> available false and start() is a no-op.
 * - dir: the output folder (created 0700 at the first start; a link or non-folder there refuses the start).
 * - timers: { setTimeout(fn, ms) -> handle, clearTimeout(handle) } (default the global ones; handles are unref-ed).
 * - fsImpl: node:fs/promises or a stand-in (lstat, readdir, open, mkdir, chmod), called at call time.
 * - onChange(status): also settable later as control.onChange.
 * status() -> the status object. start() / stop() -> Promise<status> (no-ops when running / stopped). start() rejects
 * with an Error whose only detail is `.code` when the output file cannot be made (nothing runs then). close() stops a
 * running observation (the summary is written) and refuses later starts. A step stuck in an fs call is waited for at
 * most stopWaitMs; the summary is then written from the in-memory tally and the late step's records are dropped.
 */
export class ObserveControl {
  constructor({ roots = {}, dir, now = Date.now, intervalMs = POLL_MS, rescanMs = RESCAN_MS, timers = null,
    fsImpl = fsp, onChange = null, platform = process.platform, notifyMs = NOTIFY_MS, stopWaitMs = STOP_WAIT_MS } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a folder path');
    this.roots = roots;
    this.dir = dir;
    this.now = now;
    this.intervalMs = intervalMs;
    this.rescanMs = rescanMs;
    this.timers = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
    this.fs = fsImpl;
    this.onChange = onChange;
    this.platform = typeof platform === 'string' ? platform : 'unknown';
    this.notifyMs = notifyMs;
    this.stopWaitMs = stopWaitMs;
    this.run = null; // 지금 관찰 (없으면 null)
    this.last = null; // 지난 관찰의 결과 (status.last)
    this.closed = false;
    this.ops = Promise.resolve();
    this.notified = { key: null, at: -Infinity };
  }

  get running() {
    return this.run !== null;
  }

  _roots() {
    let r;
    try {
      r = typeof this.roots === 'function' ? this.roots() : this.roots;
    } catch {
      r = null;
    }
    return { grok: dirOf(r?.grok), codex: dirOf(r?.codex) };
  }

  /** The status object (a fresh plain object each call). */
  status() {
    const run = this.run;
    const roots = this._roots();
    const agents = run ? { ...run.agents } : { grok: roots.grok !== null, codex: roots.codex !== null };
    const p = run ? run.tally.progress() : progress({}, agents);
    const last = this.last;
    return {
      available: run !== null || agents.grok || agents.codex,
      agents,
      running: run !== null,
      startedAt: run ? run.startedAt : null,
      elapsedMs: run ? Math.max(0, Math.round(this.now() - run.startMs)) : 0,
      checklist: p.checklist,
      ready: p.ready,
      totals: run ? run.tally.totals() : { files: 0, appends: 0 },
      last: last ? { ...last, checklist: last.checklist.map((i) => ({ ...i })), totals: { ...last.totals } } : null,
    };
  }

  start() {
    return this._op(() => this._start());
  }

  stop() {
    return this._op(() => this._stop());
  }

  async close() {
    await this._op(async () => {
      this.closed = true;
      await this._stop();
    });
  }

  _op(fn) {
    const run = this.ops.then(fn);
    this.ops = run.catch(() => {});
    return run;
  }

  async _start() {
    if (this.run || this.closed) return this.status();
    const roots = this._roots();
    const agents = { grok: roots.grok !== null, codex: roots.codex !== null };
    if (!agents.grok && !agents.codex) return this.status();
    const startMs = this.now();
    const { fh, file } = await this._openOutput(startMs);
    const startedAt = new Date(startMs).toISOString();
    const run = {
      file, fh, startMs, startedAt, agents, tally: new Tally(), pending: [], out: null, writing: Promise.resolve(),
      timer: null, busy: null, nextRescan: startMs, stopping: false, sealed: false, observer: null,
    };
    run.observer = new Observer({ roots, startMs, now: this.now, emit: (rec) => this._record(run, rec), fsImpl: this.fs });
    this._record(run, {
      type: 'start', v: 1, startedAt, intervalMs: this.intervalMs, rescanMs: this.rescanMs, platform: this.platform, agents: { ...agents },
    });
    await this._flush(run);
    this.run = run;
    this._schedule(run, 0);
    this._notify(true);
    return this.status();
  }

  async _openOutput(startMs) {
    try {
      await this.fs.mkdir(this.dir, { recursive: true, mode: DIR_MODE });
      const st = await this.fs.lstat(this.dir);
      if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
      await this.fs.chmod(this.dir, DIR_MODE);
      const base = `observe-${fileStamp(startMs)}`;
      for (let i = 1; i <= MAX_SUFFIX; i++) {
        const file = i === 1 ? `${base}.jsonl` : `${base}-${i}.jsonl`;
        let fh;
        try {
          fh = await this.fs.open(path.join(this.dir, file), WRITE_FLAGS, FILE_MODE);
        } catch (err) {
          if (err?.code === 'EEXIST') continue;
          throw err;
        }
        try {
          await fh.chmod(FILE_MODE); // umask 와 무관하게 0600
        } catch (err) {
          await fh.close().catch(() => {});
          throw err;
        }
        return { fh, file };
      }
      throw Object.assign(new Error('name taken'), { code: 'EEXIST' });
    } catch (err) {
      throw plainError(err);
    }
  }

  _record(run, rec) {
    if (run.sealed) return; // 요약을 쓴 뒤에 늦게 깨어난 단계의 기록은 버린다
    run.tally.add(rec);
    run.pending.push(`${JSON.stringify(rec)}\n`);
  }

  // 쓰기는 하나씩 차례로 (tick 의 쓰기와 stop 의 쓰기가 겹치지 않게). 던지지 않는다.
  _flush(run) {
    const p = run.writing.then(() => this._write(run));
    run.writing = p.catch(() => {});
    return p;
  }

  // out (쓰기 시작한 덩어리의 남은 바이트) 을 먼저, 그다음 pending 을 쓴다. 실패하면 그 자리에서 멈추고 다음 tick (또는 stop)
  // 에 쓰지 못한 첫 바이트부터 이어 쓴다: 기록이 잘리거나 두 번 쓰이지 않는다. 상태와 요약은 메모리의 집계라 그대로 맞다.
  async _write(run) {
    for (;;) {
      if (!run.out?.length) {
        if (!run.pending.length) return;
        run.out = Buffer.from(run.pending.join(''));
        run.pending = [];
      }
      let n = 0;
      try {
        n = (await run.fh.write(run.out)).bytesWritten;
      } catch {
        n = 0;
      }
      if (!n) {
        if (run.pending.length > MAX_PENDING) run.pending.splice(0, run.pending.length - MAX_PENDING);
        return;
      }
      run.out = run.out.subarray(n);
    }
  }

  _schedule(run, ms) {
    run.timer = this.timers.setTimeout(() => this._tick(run), ms);
    run.timer?.unref?.();
  }

  async _tick(run) {
    run.timer = null;
    if (this.run !== run || run.stopping) return;
    run.busy = this._step(run);
    await run.busy;
    run.busy = null;
    if (this.run !== run || run.stopping) return;
    this._notify(false);
    this._schedule(run, this.intervalMs);
  }

  async _step(run) {
    try {
      if (this.now() >= run.nextRescan) {
        await run.observer.rescan();
        run.nextRescan = this.now() + this.rescanMs;
      }
      await run.observer.poll();
    } catch {
      // Observer 는 던지지 않는다; 그래도 루프는 계속 돈다
    }
    if (!run.stopping) await this._flush(run); // 끝내는 중이면 stop 이 요약과 함께 쓴다
  }

  // p 가 끝나거나 stopWaitMs 가 지나면 끝난다 (진행 중인 fs 호출은 멈출 수 없다: 멈춘 마운트가 stop 을 붙잡지 않게)
  _settle(p) {
    let timer = null;
    const late = new Promise((resolve) => { timer = this.timers.setTimeout(resolve, this.stopWaitMs); });
    return Promise.race([p, late]).finally(() => this.timers.clearTimeout(timer));
  }

  async _stop() {
    const run = this.run;
    if (!run) return this.status();
    run.stopping = true;
    if (run.timer !== null) {
      this.timers.clearTimeout(run.timer);
      run.timer = null;
    }
    run.observer.cancel();
    if (run.busy) await this._settle(run.busy);
    run.sealed = true;
    const endMs = this.now();
    const endedAt = new Date(endMs).toISOString();
    const elapsedMs = Math.max(0, Math.round(endMs - run.startMs));
    run.pending.push(`${JSON.stringify(run.tally.summary({ t: elapsedMs, endedAt }))}\n`);
    await this._flush(run);
    await run.fh.close().catch(() => {});
    const { checklist, ready } = run.tally.progress();
    this.last = { file: run.file, endedAt, elapsedMs, checklist, ready, totals: run.tally.totals() };
    this.run = null;
    this._notify(true);
    return this.status();
  }

  // 시작과 끝은 바로 (force), 그 밖에는 elapsedMs 말고 바뀐 것이 있고 지난 알림에서 notifyMs 가 지났을 때만
  _notify(force) {
    if (typeof this.onChange !== 'function') return;
    const s = this.status();
    const key = JSON.stringify({ ...s, elapsedMs: 0 });
    const now = this.now();
    if (!force && (key === this.notified.key || now - this.notified.at < this.notifyMs)) return;
    this.notified = { key, at: now };
    try {
      this.onChange(s);
    } catch {
      // 듣는 쪽의 오류는 관찰을 멈추지 않는다
    }
  }
}
