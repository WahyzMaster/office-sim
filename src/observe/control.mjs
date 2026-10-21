// 기록 관찰의 켜고 끄기 (observe-spec "Files", "Server and HTTP" 의 Status). ObserveControl 하나가 관찰 한 번씩을 맡는다:
// 시작하면 <dir>/observe-<YYYYMMDD-HHMMSS>.jsonl 을 새로 만들고 (폴더 0700, 파일 0600, 이미 있는 이름이면 -2, -3 ...),
// 기록이 생기는 대로 덧붙인다 (tick 마다 모아서 한 번; 쓰다 실패하면 다음 tick 에 쓰지 못한 바이트부터 이어 쓴다).
// 끝내면 summary 기록을 붙이고 파일을 닫는다. 멈춘 마운트에 걸린 단계도, 요약 쓰기와 닫기도 STOP_WAIT_MS 까지만 기다린다.
// 저절로도 끝난다 (먼저 오는 것): 체크리스트가 다 찬 뒤 READY_GRACE_MS, 시작 뒤 MAX_MS, 파일이 MAX_BYTES 에 닿음.
// 끝난 까닭(reason)은 요약과 status.last 에 남는다. 새 파일을 만든 뒤에는 가장 새 KEEP_FILES 개만 남긴다 (retention.mjs).
// 루프는 setTimeout 사슬 하나다: tick 마다 (rescanMs 가 지났으면) rescan, 그다음 poll, 그다음 쓰기. 다음 tick 은 단계보다
// 먼저 걸고, 앞 단계가 아직 돌면 그 tick 은 상한만 본다: 단계는 겹치지 않고, 멈춘 단계가 시간 상한을 붙잡지 않는다.
// start / stop / close 도 차례로 돈다. 상태(status)에는 개수와 출력 파일의 이름만 있다 (폴더 경로는 없다).
// 바뀐 상태는 onChange(status) 로 알린다: 시작과 끝은 바로, 도는 동안에는 바뀌었을 때 1초에 한 번까지.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Observer } from './observer.mjs';
import { Tally, progress } from './summary.mjs';
import { errorCode } from './records.mjs';
import { pruneOutputs } from './retention.mjs';

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
/** Auto-stop: this long after the checklist first became ready during the observation (10 minutes). */
export const READY_GRACE_MS = 600_000;
/** Auto-stop: this long after the start at most (4 hours). */
export const MAX_MS = 14_400_000;
/** Auto-stop: once the output file holds this many bytes (50 MB; the summary still goes in after). */
export const MAX_BYTES = 52_428_800;
/** Observation files kept in the output folder after a start, the new one included. */
export const KEEP_FILES = 20;
/** Why an observation ended (summary record and status.last `reason`). */
export const STOP_REASONS = Object.freeze(['user', 'ready', 'duration', 'bytes', 'close']);

const WRITE_FLAGS = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_APPEND | (FS.O_NOFOLLOW ?? 0);
const MAX_SUFFIX = 99;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Local 'YYYYMMDD-HHMMSS' of ms (the output file name stamp). */
export function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const dirOf = (v) => (typeof v === 'string' && v !== '' ? v : null);
const isoOf = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);

// 상한 값 검사: 양수 (keep 은 양의 정수)
function positive(v, name, integer = false) {
  const ok = integer ? Number.isSafeInteger(v) : Number.isFinite(v);
  if (!ok || v <= 0) throw new RangeError(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  return v;
}

// fs 오류의 message 에는 경로가 들어 있다: 코드만 가진 새 오류로 바꾼다
function plainError(err) {
  const code = errorCode(err);
  const e = new Error(`observe output not writable (${code})`);
  e.code = code;
  return e;
}

/**
 * new ObserveControl({ roots, dir, now?, intervalMs?, rescanMs?, timers?, fsImpl?, onChange?, platform?, notifyMs?,
 *   stopWaitMs?, readyGraceMs?, maxMs?, maxBytes?, keep? })
 * - roots: { grok?: dir, codex?: dir } of the enabled adapters, or a function returning it (read at each start() and
 *   status()). Neither -> available false and start() is a no-op.
 * - dir: the output folder (created 0700 at the first start; a link or non-folder there refuses the start).
 * - timers: { setTimeout(fn, ms) -> handle, clearTimeout(handle) } (default the global ones; handles are unref-ed).
 * - fsImpl: node:fs/promises or a stand-in (lstat, readdir, open, mkdir, chmod, unlink), called at call time.
 * - readyGraceMs / maxMs / maxBytes: the auto-stop limits (default READY_GRACE_MS, MAX_MS, MAX_BYTES); keep: the files
 *   kept after a start (default KEEP_FILES). A value that is not positive (keep: a positive integer) is a RangeError.
 * - onChange(status): also settable later as control.onChange.
 * status() -> the status object. start() / stop() -> Promise<status> (no-ops when running / stopped). start() rejects
 * with an Error whose only detail is `.code` when the output file cannot be made (nothing runs then). close() stops a
 * running observation (the summary is written) and refuses later starts. A step stuck in an fs call is waited for at
 * most stopWaitMs; the summary is then written from the in-memory tally and the late step's records are dropped. The
 * summary write and the close are waited for at most stopWaitMs too (a stalled one finishes when its mount answers).
 * A tick that finds a limit reached stops the observation exactly like stop() (reason 'ready', 'duration' or 'bytes');
 * a tick that comes while the previous step still runs checks the limits without starting a step.
 */
export class ObserveControl {
  constructor({ roots = {}, dir, now = Date.now, intervalMs = POLL_MS, rescanMs = RESCAN_MS, timers = null,
    fsImpl = fsp, onChange = null, platform = process.platform, notifyMs = NOTIFY_MS, stopWaitMs = STOP_WAIT_MS,
    readyGraceMs = READY_GRACE_MS, maxMs = MAX_MS, maxBytes = MAX_BYTES, keep = KEEP_FILES } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a folder path');
    this.limits = Object.freeze({
      readyGraceMs: positive(readyGraceMs, 'readyGraceMs'), maxMs: positive(maxMs, 'maxMs'),
      maxBytes: positive(maxBytes, 'maxBytes'), keep: positive(keep, 'keep', true),
    });
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
    this.pruned = { removed: 0, failed: 0 }; // 보관 규칙이 지운 파일과 건너뛴 오류 (디버그용, 상태에는 없다)
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
      bytes: run ? run.bytes : 0,
      endsAt: run ? isoOf(this._endsMs(run)) : null,
      limits: { ...this.limits },
    };
  }

  // 시간으로 끝나는 가장 이른 때: 시작 + maxMs, 다 찬 뒤로는 다 찬 때 + readyGraceMs 와 견줘 이른 쪽
  _endsMs(run) {
    const { maxMs, readyGraceMs } = this.limits;
    return Math.min(run.startMs + maxMs, run.readyMs === null ? Infinity : run.readyMs + readyGraceMs);
  }

  // tick 의 쓰기 뒤에, 그리고 앞 단계가 아직 도는 tick 에서도 본다. 같은 tick 에 둘 이상이면 시간 상한(먼저 온 쪽, 같으면
  // ready), 그다음 크기.
  _limitReason(run) {
    const now = this.now();
    if (now >= this._endsMs(run)) {
      const { maxMs, readyGraceMs } = this.limits;
      return run.readyMs !== null && run.readyMs + readyGraceMs <= run.startMs + maxMs ? 'ready' : 'duration';
    }
    return run.bytes >= this.limits.maxBytes ? 'bytes' : null;
  }

  start() {
    return this._op(() => this._start());
  }

  stop() {
    return this._op(() => this._stop('user'));
  }

  async close() {
    await this._op(async () => {
      this.closed = true;
      await this._stop('close');
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
      timer: null, busy: null, nextRescan: startMs, stopping: false, sealed: false, observer: null, bytes: 0, readyMs: null,
    };
    run.observer = new Observer({ roots, startMs, now: this.now, emit: (rec) => this._record(run, rec), fsImpl: this.fs });
    this._record(run, {
      type: 'start', v: 1, startedAt, intervalMs: this.intervalMs, rescanMs: this.rescanMs, platform: this.platform, agents: { ...agents },
    });
    await this._flush(run);
    this.run = run;
    await this._prune(file); // 첫 tick 전에: start() 의 답은 여전히 첫 rescan 전의 상태다
    this._schedule(run, 0);
    this._notify(true);
    return this.status();
  }

  // 새 파일을 만든 뒤에만 부른다 (시작이 실패하면 아무것도 지우지 않는다). 던지지 않고, 멈춘 마운트는 stopWaitMs 까지만 기다린다.
  // 기다림을 넘긴 단계는 그만두게 한다: 늦게 돌아온 목록에는 그다음 관찰이 쓰는 파일이 있을 수 있다 (그 뒤로는 지우지 않는다).
  async _prune(current) {
    const ac = new AbortController();
    const p = pruneOutputs({ dir: this.dir, current, keep: this.limits.keep, fsImpl: this.fs, signal: ac.signal })
      .then((r) => {
        this.pruned.removed += r.removed;
        this.pruned.failed += r.failed;
      }, () => {});
    if ((await this._settle(p.then(() => true))) !== true) ac.abort();
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
    // 다 찬 때는 체크리스트를 채운 기록을 받은 때다: 상태의 ready 와 endsAt 이 늘 함께 바뀐다
    if (run.readyMs === null && run.tally.progress().ready) run.readyMs = this.now();
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
      run.bytes += n;
      run.out = run.out.subarray(n);
    }
  }

  _schedule(run, ms) {
    run.timer = this.timers.setTimeout(() => this._tick(run), ms);
    run.timer?.unref?.();
  }

  // 다음 tick 은 단계보다 먼저 건다: 단계가 멈춘 마운트에 걸려도 다음 tick 이 와서 시간 상한을 본다. 앞 단계가 아직 돌면
  // 그 tick 은 새 단계를 시작하지 않고 (단계는 겹치지 않는다) 상한만 보고 다시 건다. 크기는 쓰기에서만 는다.
  async _tick(run) {
    run.timer = null;
    if (this.run !== run || run.stopping) return;
    if (run.busy) {
      const reason = this._limitReason(run);
      if (reason) this._end(run, reason); // 기다리지 않는다: 끝내기가 멈춘 단계를 stopWaitMs 까지만 기다린다
      else this._schedule(run, this.intervalMs);
      return;
    }
    this._schedule(run, this.intervalMs);
    run.busy = this._step(run);
    await run.busy;
    run.busy = null;
    if (this.run !== run || run.stopping) return;
    const reason = this._limitReason(run);
    if (reason) await this._end(run, reason);
    else this._notify(false);
  }

  // 상한에 닿았다: stop() 과 똑같이 끝낸다 (요약, 닫기, status.last, 바로 알림). 먼저 들어온 stop / close 가 있으면 그쪽이 끝낸다.
  _end(run, reason) {
    if (run.timer !== null) {
      this.timers.clearTimeout(run.timer);
      run.timer = null;
    }
    return this._op(() => (this.run === run ? this._stop(reason) : null)).catch(() => {});
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

  async _stop(reason) {
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
    run.pending.push(`${JSON.stringify(run.tally.summary({ t: elapsedMs, endedAt, reason }))}\n`);
    // 요약 쓰기와 닫기도 stopWaitMs 까지만 기다린다 (결과 폴더의 마운트가 멈추면: 요약은 그 마운트가 돌아올 때 들어가고
    // 그다음에 닫힌다; last.bytes 에는 그때까지 쓴 것만 있다). 닫기는 늘 쓰기 뒤다.
    await this._settle(this._flush(run).then(() => run.fh.close()).catch(() => {}));
    const { checklist, ready } = run.tally.progress();
    this.last = { file: run.file, endedAt, elapsedMs, checklist, ready, totals: run.tally.totals(), bytes: run.bytes, reason };
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
