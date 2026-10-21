// 기록 관찰의 파일 감시 (observe-spec "What is watched", "Output records"). 타이머는 없다: 부르는 쪽(control.mjs)이
// rescan() 과 poll() 을 돌린다. 두 호출은 안에서도 차례로 돈다 (겹치지 않는다).
//
// 보는 파일 (읽기만 하고 쓰지 않는다):
// - Grok: <grok>/sessions/<그룹>/<세션>/updates.jsonl, events.jsonl (세션 폴더 안은 목록을 읽지 않고 두 이름만 lstat 한다),
//   <grok>/active_sessions.json (모양만).
// - Codex: <codex>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl (오늘, 어제, 시작할 때 10분 안에 바뀐 파일이 있던 날 폴더, 그리고
//   30초마다의 전체 훑기에서 시작 뒤에 바뀐 파일이 보인 날 폴더, codex-walk.mjs),
//   <codex>/session_index.jsonl (줄 수와 길이만, 해석하지 않는다).
// 링크는 따라가지 않는다: 폴더는 Dirent/lstat 로 진짜 폴더만, 파일은 lstat 해서 일반 파일만, O_RDONLY | O_NOFOLLOW |
// O_NONBLOCK 로 열고 연 파일이 lstat 한 그 inode 의 일반 파일인지 다시 본다 (grok/events.mjs 와 같다). 그 둘은 마지막
// 이름만 지키므로, 읽기 전에 루트와 파일 사이의 폴더가 지금도 진짜 폴더인지 본다 (링크로 바뀌었으면 gone). 그 밖의 파일
// (auth, config, history, prompt_history, chat_history, sqlite, summary.json ...) 은 열지 않는다.
//
// 파일마다: 시작할 때 있던 파일은 그때 크기부터 (새로 붙는 것만), 관찰 중에 생긴 파일은 0 부터 (시작 훑기에서는 생성
// 시각이 시작보다 뒤의 밀리초인 파일; 생성 시각이 없으면 있던 파일로 친다). 시작보다 10분 넘게 전에
// 바뀐 파일은 잠들어 있다가, rescan 이 크기/mtime/inode 가 바뀐 것을 보면 그때 크기부터 본다 (그 사이의 덧붙이기를 한
// 덩어리로 세면 덧붙이기 단위가 흐려지므로 버린다). inode 가 바뀌거나 짧아지면 reset 기록을 남기고 새 파일의 0 부터.
// 남기는 기록은 records.mjs 의 범주 값과 숫자뿐이다. 경로와 이름은 이 객체 안에만 있고 기록에 들어가지 않는다.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { LineFrame, OBSERVE_LINE_BYTES, activeShape, errorCode, lineKinds, permEvent, recordMs } from './records.mjs';
import { QUIET, walkCodex } from './codex-walk.mjs';

export { nearDays } from './days.mjs'; // 테스트가 여기서 부른다

/** Files modified longer ago than this before the start sleep until they change. */
export const RECENT_MS = 10 * 60 * 1000;
/** active_sessions.json is read up to this many bytes. */
export const ACTIVE_BYTES = 1024 * 1024;
/** One read call at most (the reader yields between chunks). */
export const CHUNK_BYTES = 1024 * 1024;

const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);
const UPDATES = 'updates.jsonl';
const EVENTS = 'events.jsonl';
const ACTIVE = 'active_sessions.json';
const NL = 0x0a;

/**
 * The watcher. new Observer({ roots: { grok?, codex? }, startMs, now?, emit, fsImpl?, recentMs?, maxLine?, chunk?,
 * activeBytes? }). emit(record) gets every record object (file, append, active, error) synchronously, in order; the
 * caller writes the start and summary records. rescan() walks the roots (the first call is the start scan), poll()
 * reads what was appended to every watched file. cancel() makes running and later calls return early.
 */
export class Observer {
  constructor({ roots = {}, startMs, now = Date.now, emit, fsImpl = fsp, recentMs = RECENT_MS,
    maxLine = OBSERVE_LINE_BYTES, chunk = CHUNK_BYTES, activeBytes = ACTIVE_BYTES } = {}) {
    this.grok = typeof roots.grok === 'string' && roots.grok !== '' ? roots.grok : null;
    this.codex = typeof roots.codex === 'string' && roots.codex !== '' ? roots.codex : null;
    this.now = now;
    this.startMs = Number.isFinite(startMs) ? startMs : now();
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.fs = fsImpl; // 부를 때마다 this.fs.open(...) (시험이 fsp.open 을 바꿔 끼워 엿볼 수 있게)
    this.recentMs = recentMs;
    this.maxLine = maxLine;
    this.chunk = chunk;
    this.activeBytes = activeBytes;
    this.files = new Map(); // 경로 -> 파일 상태 (경로는 여기에만 있다)
    this.sessions = new Map(); // 세션 키 (Grok 세션 폴더, Codex rollout 경로) -> 's#'
    this.nFile = 0;
    this.nSession = 0;
    this.scanned = false;
    this.codexDays = new Set(); // 시작할 때 10분 안에, 또는 시작 뒤에 바뀐 rollout 이 있던 날 폴더 (codex-walk.mjs)
    this.fullWalkAt = 0; // Codex 날 폴더를 모두 훑은 마지막 시각
    this.activeSig = null;
    this.errs = new Map(); // 대상 -> 마지막 오류 코드 (같은 오류는 한 번만 남긴다)
    this.cancelled = false;
    this.queue = Promise.resolve();
    this.dirMemo = new Map(); // 한 번의 rescan / poll 안에서 폴더마다 lstat 한 번
  }

  cancel() {
    this.cancelled = true;
  }

  rescan() {
    return this._serial(() => this._rescan());
  }

  poll() {
    return this._serial(() => this._poll());
  }

  _serial(fn) {
    const run = this.queue.then(() => (this.cancelled ? undefined : fn()));
    this.queue = run.catch(() => {});
    return run;
  }

  _t(ms = this.now()) {
    return Math.round(ms - this.startMs);
  }

  _error(key, kind, file, err) {
    const code = errorCode(err);
    if (this.errs.get(key) === code) return;
    this.errs.set(key, code);
    this.emit({ type: 'error', t: this._t(), kind, file: file ?? null, code });
  }

  async _dir(dir, kind) {
    try {
      const list = await this.fs.readdir(dir, { withFileTypes: true });
      this.errs.delete(dir);
      return list;
    } catch (err) {
      if (!QUIET.has(err?.code)) this._error(dir, kind, null, err);
      return [];
    }
  }

  // 진짜 폴더인지 (링크가 아닌지) lstat 으로
  async _isDir(dir, kind) {
    try {
      return (await this.fs.lstat(dir)).isDirectory();
    } catch (err) {
      if (!QUIET.has(err?.code)) this._error(dir, kind, null, err);
      return false;
    }
  }

  // 루트와 파일 사이의 폴더들 (Grok: sessions, <그룹>, <세션>; Codex rollout: sessions, YYYY, MM, DD; 그 밖: 없음)
  _chain(p, agent) {
    const root = agent === 'grok' ? this.grok : this.codex;
    const rel = path.relative(root, path.dirname(p));
    const parts = rel === '' ? [] : rel.split(path.sep);
    return parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)));
  }

  // 그 폴더들이 지금도 모두 진짜 폴더인가: true, false (링크나 다른 것으로 바뀌었거나 없다) 또는 오류
  async _realChain(f) {
    for (const dir of f.dirs) {
      const isDir = () => this.fs.lstat(dir).then((st) => st.isDirectory(), (err) => (QUIET.has(err?.code) ? false : err));
      if (!this.dirMemo.has(dir)) this.dirMemo.set(dir, isDir());
      const ok = await this.dirMemo.get(dir);
      if (ok !== true) return ok;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------- rescan

  async _rescan() {
    const initial = !this.scanned;
    this.scanned = true;
    this.dirMemo = new Map();
    const found = new Map(); // 경로 -> { kind, agent, sessionKey, st? }
    if (this.grok) await this._walkGrok(found);
    if (this.codex) await this._walkCodex(found, initial);
    for (const [p, info] of found) {
      if (this.cancelled) return;
      await this._see(p, info, initial);
    }
    // 진짜 폴더로 걸어서는 못 찾은 파일: 폴더가 링크로 바뀌었으면 버리고, 아니면 (어제에서 빠진 날 폴더 등) 그대로 본다
    for (const f of [...this.files.values()]) {
      if (this.cancelled) return;
      if (found.has(f.path)) continue;
      const real = await this._realChain(f);
      if (real === true) await this._see(f.path, null, initial);
      else if (real === false) this._drop(f);
    }
    if (this.grok && !this.cancelled) await this._active();
  }

  async _walkGrok(found) {
    const sessions = path.join(this.grok, 'sessions');
    if (!(await this._isDir(sessions, 'grok-scan'))) return;
    for (const g of await this._dir(sessions, 'grok-scan')) {
      if (this.cancelled) return;
      if (!g.isDirectory()) continue;
      const gdir = path.join(sessions, g.name);
      for (const s of await this._dir(gdir, 'grok-scan')) {
        if (!s.isDirectory()) continue;
        const sdir = path.join(gdir, s.name);
        found.set(path.join(sdir, UPDATES), { kind: 'grok-updates', agent: 'grok', sessionKey: sdir });
        found.set(path.join(sdir, EVENTS), { kind: 'grok-events', agent: 'grok', sessionKey: sdir });
      }
      await yieldToLoop();
    }
  }

  _walkCodex(found, initial) {
    return walkCodex(this, found, initial);
  }

  // 시작 전에 있던 파일인가 (생성 시각을 모르면 mtime 으로)
  _existed(st) {
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return born < this.startMs;
  }

  async _see(p, info, initial) {
    let st = info?.st ?? null;
    let err = null;
    if (!st) {
      try {
        st = await this.fs.lstat(p);
      } catch (e) {
        err = e;
      }
    }
    const f = this.files.get(p);
    const regular = st !== null && st.isFile();
    if (f) {
      if (err && !QUIET.has(err.code)) return this._error(p, f.kind, f.id, err);
      if (!regular) return this._drop(f);
      if (f.mode === 'dormant' && (st.ino !== f.ino || st.dev !== f.dev || st.size !== f.size || st.mtimeMs !== f.mtimeMs)) {
        await this._watchAt(f, st, 'watch');
      }
      return;
    }
    if (!info) return;
    if (err) {
      if (!QUIET.has(err.code)) this._error(p, info.kind, null, err);
      return;
    }
    if (!regular) return;
    const nf = {
      path: p, kind: info.kind, agent: info.agent, sessionKey: info.sessionKey, id: null, mode: 'dormant',
      ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs, offset: 0, frame: null, dirs: this._chain(p, info.agent),
    };
    this.files.set(p, nf);
    // 시작 훑기: 생성 시각만 본다 (mtime 으로 가르면 시작 직전에 덧붙은 오래된 파일을 0 부터 다시 읽는다).
    // late (Codex 전체 훑기에서 늦게 찾은 오래된 날의 파일): 생성 시각과 상관없이 지금 크기부터
    if (initial ? Math.floor(st.birthtimeMs) <= this.startMs : (info.late === true || this._existed(st))) {
      if (st.mtimeMs >= this.startMs - this.recentMs) await this._watchAt(nf, st, 'watch');
      return;
    }
    nf.mode = 'watch';
    nf.frame = this._frame(nf, true);
    this._announce(nf, 'new');
  }

  _frame(f, lastNL) {
    return new LineFrame({ maxLine: this.maxLine, buffer: f.kind !== 'codex-index', lastNL });
  }

  // 지금 크기부터 본다. 마지막 바이트가 '\n' 인지는 한 바이트만 읽어 안다 (midLineStart 와 머리 없는 줄을 위해).
  async _watchAt(f, st, event) {
    f.mode = 'watch';
    f.ino = st.ino;
    f.dev = st.dev;
    f.offset = st.size;
    f.frame = this._frame(f, await this._lastNL(f.path, st));
    if (this.files.get(f.path) === f) this._announce(f, event);
  }

  async _lastNL(p, st) {
    if (st.size <= 0) return true;
    const o = await this._open(p, st);
    if (!o.fh) return true;
    try {
      const b = Buffer.alloc(1);
      const { bytesRead } = await o.fh.read(b, 0, 1, st.size - 1);
      return bytesRead !== 1 || b[0] === NL;
    } catch {
      return true;
    } finally {
      await o.fh.close().catch(() => {});
    }
  }

  _announce(f, event) {
    if (!f.id) f.id = `f${++this.nFile}`;
    let session = null;
    if (f.sessionKey !== null) {
      session = this.sessions.get(f.sessionKey);
      if (!session) this.sessions.set(f.sessionKey, (session = `s${++this.nSession}`));
    }
    f.session = session;
    this.emit({ type: 'file', t: this._t(), file: f.id, session, agent: f.agent, kind: f.kind, event });
  }

  _drop(f) {
    this.files.delete(f.path);
    if (f.mode === 'watch') this.emit({ type: 'file', t: this._t(), file: f.id, session: f.session, agent: f.agent, kind: f.kind, event: 'gone' });
  }

  // lstat 한 그 일반 파일만 연다: { fh, cur } 또는 { err } 또는 {} (다른 파일로 바뀌었거나 일반 파일이 아니다)
  async _open(p, st) {
    let fh;
    try {
      fh = await this.fs.open(p, OPEN_FLAGS);
    } catch (err) {
      return err?.code === 'ELOOP' || err?.code === 'EMLINK' ? {} : { err };
    }
    try {
      const cur = await fh.stat();
      if (cur.isFile() && cur.ino === st.ino && cur.dev === st.dev) return { fh, cur };
    } catch (err) {
      await fh.close().catch(() => {});
      return { err };
    }
    await fh.close().catch(() => {});
    return {};
  }

  async _active() {
    const p = path.join(this.grok, ACTIVE);
    let st;
    try {
      st = await this.fs.lstat(p);
    } catch (err) {
      if (!QUIET.has(err?.code)) this._error(p, 'grok-active', null, err);
      this.activeSig = null;
      return;
    }
    if (!st.isFile()) {
      this.activeSig = null;
      return;
    }
    const sig = `${st.ino}:${st.dev}:${st.size}:${st.mtimeMs}`;
    if (sig === this.activeSig) return;
    const o = await this._open(p, st);
    if (!o.fh) {
      if (o.err && !QUIET.has(o.err.code)) this._error(p, 'grok-active', null, o.err);
      return;
    }
    try {
      const len = Math.min(o.cur.size, this.activeBytes);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await o.fh.read(buf, got, len - got, got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      this.activeSig = sig;
      this.errs.delete(p);
      this.emit({ type: 'active', t: this._t(), ...activeShape(buf.subarray(0, got).toString('utf8')) });
    } catch (err) {
      this._error(p, 'grok-active', null, err);
    } finally {
      await o.fh.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------------------------- poll

  // 같은 poll 안에서는 events.jsonl 을 updates.jsonl 뒤에 읽는다 (tool_call 덧붙이기의 t <= 요청을 본 t)
  async _poll() {
    this.dirMemo = new Map();
    const list = [...this.files.values()].filter((f) => f.mode === 'watch');
    for (const f of list) if (f.kind !== 'grok-events' && !this.cancelled) await this._pollFile(f);
    for (const f of list) if (f.kind === 'grok-events' && !this.cancelled) await this._pollFile(f);
  }

  _reset(f, st) {
    f.ino = st.ino;
    f.dev = st.dev;
    f.offset = 0;
    f.frame.restart();
    this.emit({ type: 'file', t: this._t(), file: f.id, session: f.session, agent: f.agent, kind: f.kind, event: 'reset' });
  }

  async _pollFile(f) {
    if (this.files.get(f.path) !== f) return;
    const real = await this._realChain(f);
    if (real === false) return this._drop(f); // 사이의 폴더가 링크로 바뀌었거나 없어졌다: 따라가지 않는다 (reset 이 아니다)
    if (real !== true) return this._error(f.path, f.kind, f.id, real);
    let st;
    try {
      st = await this.fs.lstat(f.path);
    } catch (err) {
      if (!QUIET.has(err?.code)) this._error(f.path, f.kind, f.id, err);
      return;
    }
    if (!st.isFile()) return; // 링크나 다른 것으로 바뀌었다: rescan 이 gone 을 남긴다
    if (st.ino !== f.ino || st.dev !== f.dev || st.size < f.offset) this._reset(f, st);
    if (st.size === f.offset) return;
    const seenAt = this.now();
    const o = await this._open(f.path, st);
    if (!o.fh) {
      if (o.err && !QUIET.has(o.err.code)) this._error(f.path, f.kind, f.id, o.err);
      return;
    }
    try {
      if (o.cur.size < f.offset) this._reset(f, o.cur);
      await this._read(f, o.fh, o.cur.size, seenAt);
      this.errs.delete(f.path);
    } catch (err) {
      this._error(f.path, f.kind, f.id, err);
    } finally {
      await o.fh.close().catch(() => {});
    }
  }

  async _read(f, fh, end, seenAt) {
    if (end <= f.offset) return;
    const from = f.offset;
    const midLineStart = !f.frame.lastNL;
    const acc = { lines: 0, maxLineBytes: 0, oversize: 0, bad: 0, kinds: new Map(), lagMin: null, lagMax: null, perm: [] };
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(this.chunk, end - f.offset)));
    const onLine = (bytes) => this._line(f, bytes, seenAt, acc);
    while (f.offset < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - f.offset), f.offset);
      if (!bytesRead || this.files.get(f.path) !== f) break;
      const r = f.frame.push(buf.subarray(0, bytesRead), onLine);
      acc.lines += r.lines;
      acc.oversize += r.oversize;
      if (r.maxLineBytes > acc.maxLineBytes) acc.maxLineBytes = r.maxLineBytes;
      f.offset += bytesRead;
      if (f.offset < end) await yieldToLoop();
    }
    const bytes = f.offset - from;
    if (bytes <= 0) return;
    const kinds = {};
    for (const k of [...acc.kinds.keys()].sort()) kinds[k] = acc.kinds.get(k);
    this.emit({
      type: 'append', t: this._t(seenAt), file: f.id, bytes, lines: acc.lines, partialTail: !f.frame.lastNL, midLineStart,
      maxLineBytes: acc.maxLineBytes, kinds, lagMs: acc.lagMin === null ? null : { min: acc.lagMin, max: acc.lagMax },
      bad: acc.bad, oversize: acc.oversize, ...(acc.perm.length ? { perm: acc.perm } : {}),
    });
  }

  // 끝난 줄 하나 (bytes 가 null 이면 해석하지 않는 줄: 너무 길거나, 머리를 못 봤거나, session_index)
  _line(f, bytes, seenAt, acc) {
    if (bytes === null) return;
    let rec;
    try {
      rec = JSON.parse(bytes.toString('utf8'));
    } catch {
      acc.bad += 1;
      return;
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      acc.bad += 1;
      return;
    }
    for (const k of lineKinds(f.kind, rec)) acc.kinds.set(k, (acc.kinds.get(k) ?? 0) + 1);
    const ms = recordMs(f.kind, rec);
    let lag = null;
    if (ms !== null) {
      lag = Math.round(seenAt - ms);
      if (acc.lagMin === null || lag < acc.lagMin) acc.lagMin = lag;
      if (acc.lagMax === null || lag > acc.lagMax) acc.lagMax = lag;
    }
    if (f.kind === 'grok-events') {
      const ev = permEvent(rec);
      if (ev) acc.perm.push({ ev, lagMs: lag });
    }
  }
}
