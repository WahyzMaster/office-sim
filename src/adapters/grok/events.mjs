// Grok events.jsonl 읽기 (P5g 승인 대기, ADAPTERS 5.2, CONTRACT 4.6). 세션 폴더의 events.jsonl 은 덧붙이기만 하는 런타임
// 기록 { type, ts, ... } 이고, 권한 요청 한 번은 tool_started X -> phase_changed permission_prompt -> permission_requested X
// -> permission_resolved X { decision } 로 남는다. 권한 기록에는 도구 호출 id 가 없으므로 요청은 바로 앞의 같은 이름
// tool_started 의 순번(e, 파일 처음부터 센 1 부터의 번호)으로만 가리킨다. updates.jsonl 의 호출과 짝짓는 일은 approval.mjs 가 한다.
//
// 읽는 방법은 Codex SessionIndex (codex/titles.mjs) 와 같다: lstat 해서 일반 파일만, O_NOFOLLOW 로 열고 같은 inode/장치인지
// 다시 보고, 새로 붙은 바이트만 읽는다. 줄 상한 64 KB (넘는 줄은 통째로 버린다), 한 번에 8 MB 까지 1 MB 씩 나눠 읽고 사이에
// 양보한다. inode 가 바뀌거나 파일이 짧아지면 처음부터 다시 센다. 던지지 않고, 아무것도 로그하지 않는다.
// 개인정보: JSON.parse 전에 따옴표 붙은 타입 이름으로 거른다 ("phase_changed" 가 든 줄과 다섯 타입 중 어느 것도 없는 줄은
// 해석하지 않는다; 문자열 안의 따옴표는 \" 로 escape 되므로 mcp 오류 문구 같은 값은 걸리지 않는다). 읽는 필드는 type, ts,
// tool_name (records.mjs 의 TOOL_NAME_RE, 같은지 비교에만 쓴다), decision 넷뿐이다. mcp_*, model_id, session_id,
// cancellation_context, wait_ms, tool_completed 는 읽지 않는다.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { toolNameOf } from './records.mjs';

export const EVENTS_FILE = 'events.jsonl';
const UPDATES_FILE = 'updates.jsonl';
/** A longer line is skipped whole. */
export const EVENTS_LINE_BYTES = 64 * 1024;
/** Bytes read per check at most (the rest waits for the next check; facts wait until caught up). */
export const EVENTS_CHECK_BYTES = 8 * 1024 * 1024;
/** One read call at most; the reader yields between chunks. */
export const EVENTS_CHUNK_BYTES = 1024 * 1024;
/** Open requests kept at most per file (the oldest is dropped as 'gone'). */
export const EVENTS_MAX_OPEN = 64;
/** The only record types read (everything else is dropped before JSON.parse). */
export const EVENT_TYPES = Object.freeze(['tool_started', 'permission_requested', 'permission_resolved', 'turn_started', 'turn_ended']);

const TYPE_SET = new Set(EVENT_TYPES);
const NEEDLES = EVENT_TYPES.map((t) => `"${t}"`);
const PHASE_NEEDLE = '"phase_changed"'; // 85% 의 줄: 먼저 버린다
const MAX_TS = 64;
const NL = 0x0a;
const NONE = Object.freeze([]);
const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

/** <session dir>/updates.jsonl -> <session dir>/events.jsonl, else null (the only events path ever opened). */
export function eventsPathOf(updatesPath) {
  if (typeof updatesPath !== 'string' || path.basename(updatesPath) !== UPDATES_FILE) return null;
  return path.join(path.dirname(updatesPath), EVENTS_FILE);
}

/** Prefilter on raw line bytes (Buffer or string): true only when the line may be one of EVENT_TYPES. */
export function wantedLine(bytes) {
  if (bytes.includes(PHASE_NEEDLE)) return false;
  for (const n of NEEDLES) if (bytes.includes(n)) return true;
  return false;
}

// ISO 시각 -> ms, 아니면 null (문자열만, 길이 상한)
function msOf(v) {
  if (typeof v !== 'string' || v === '' || v.length > MAX_TS) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// records.mjs 의 TOOL_NAME_RE 를 그대로 쓴다: toolNameOf 가 x.ai/tool 이름에 하는 것과 같은 trim 과 검사라서, 세션 쪽 호출
// 이름과 같은 규칙으로 비교된다. 맞지 않으면 null.
const nameOf = (v) => (typeof v === 'string' ? toolNameOf({ _meta: { 'x.ai/tool': { name: v } } }) : null);

/**
 * One parsed line -> { type, ms, name?, decision? } or null for any other record. Reads only `type`, `ts`, `tool_name`
 * (the three tool/permission types) and `decision` (permission_resolved). decision: 'allow' | 'deny' | null (unknown).
 */
export function eventOf(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const type = rec.type;
  if (typeof type !== 'string' || !TYPE_SET.has(type)) return null;
  const ev = { type, ms: msOf(rec.ts) };
  if (type === 'turn_started' || type === 'turn_ended') return ev;
  ev.name = nameOf(rec.tool_name);
  if (type === 'permission_resolved') {
    const d = rec.decision;
    ev.decision = d === 'allow' || d === 'deny' ? d : null;
  }
  return ev;
}

/**
 * The pure reducer of one events.jsonl, fed every kept record from byte 0 (no I/O, no clock).
 * - tool_started: the ordinal e += 1 (every one counts, also with an invalid name); remembered as the last record.
 * - permission_requested opens { e, name, startMs, reqMs } only when the last kept record is a tool_started with the
 *   same valid name; otherwise it is unpaired (counted in stats.unpaired, never a fact).
 * - permission_resolved closes the oldest open request of the same name: 'deny' for decision deny, else 'allow' (an
 *   unknown decision clears the wait the same way).
 * - turn_started / turn_ended close every open request as 'gone' (a prompt cancelled with its turn).
 * - broken() (an over-cap or unparsable line that may have been a record) clears the last record: a request right after
 *   it stays unpaired (fail closed).
 * apply() and broken() return the requests they closed: [{ e, name, startMs, reqMs, state, resMs }] (resMs may be null).
 */
export class EventsReducer {
  constructor({ maxOpen = EVENTS_MAX_OPEN } = {}) {
    this.maxOpen = maxOpen;
    this.e = 0;
    this.last = null; // 마지막으로 남긴 기록 ({ type } 또는 tool_started 의 { type, e, name, ms })
    this.open = new Map(); // e -> { e, name, startMs, reqMs } (e 순서)
    this.stats = { started: 0, requests: 0, unpaired: 0, resolved: 0, unmatched: 0, gone: 0 };
  }

  apply(rec) {
    const ev = eventOf(rec);
    if (!ev) return NONE; // 다른 타입: 마지막 기록은 그대로
    const prev = this.last;
    if (ev.type === 'tool_started') {
      this.e += 1;
      this.stats.started += 1;
      this.last = { type: ev.type, e: this.e, name: ev.name, ms: ev.ms };
      return NONE;
    }
    this.last = { type: ev.type };
    if (ev.type === 'permission_requested') {
      this.stats.requests += 1;
      if (prev?.type !== 'tool_started' || ev.name === null || prev.name !== ev.name) {
        this.stats.unpaired += 1;
        return NONE;
      }
      this.open.set(prev.e, { e: prev.e, name: ev.name, startMs: prev.ms, reqMs: ev.ms });
      if (this.open.size <= this.maxOpen) return NONE;
      const [oldest] = this.open.values();
      return [this._close(oldest, 'gone', null)];
    }
    if (ev.type === 'permission_resolved') {
      if (ev.name !== null) {
        for (const r of this.open.values()) {
          if (r.name === ev.name) return [this._close(r, ev.decision === 'deny' ? 'deny' : 'allow', ev.ms)];
        }
      }
      this.stats.unmatched += 1;
      return NONE;
    }
    return this._closeAll(ev.ms); // turn_started, turn_ended
  }

  broken() {
    this.last = null;
    return NONE;
  }

  _close(r, state, resMs) {
    this.open.delete(r.e);
    this.stats[state === 'gone' ? 'gone' : 'resolved'] += 1;
    return { ...r, state, resMs };
  }

  _closeAll(ms) {
    if (!this.open.size) return NONE;
    return [...this.open.values()].map((r) => this._close(r, 'gone', ms));
  }
}

// 파일 하나의 읽기 상태. forget() 은 이 객체를 통째로 버린다 (읽는 중이던 check 는 버려진 객체를 고치고 null 을 낸다).
function fileState(file, opts) {
  return {
    file, ino: null, dev: null, offset: 0, carry: [], carryLen: 0, skipping: false,
    reducer: new EventsReducer(opts), reported: new Set(), closed: [], resetPending: false,
    stats: { lines: 0, parsed: 0, bad: 0, long: 0 },
  };
}

/**
 * Incremental reader of one session's events.jsonl. check(eventsPath, now) resolves to null when the file is missing,
 * not a regular file, a link, swapped between lstat and open, unreadable, or not named events.jsonl; else to
 *   { caughtUp, facts, seenAt, reset }
 * - caughtUp: every byte up to the bounding stat's size was consumed (a trailing partial line waits in the carry).
 * - facts (only when caughtUp, else []), sorted by e: every request still open, again on every check, as
 *   { e, name, startMs, reqMs, state: 'open' }; plus, once each, the closing of a request that an earlier result
 *   reported open, as { e, name, startMs, reqMs, state: 'allow' | 'deny' | 'gone', resMs }. A request opened and closed
 *   between two results is never reported. Times are epoch ms or null (missing or invalid ts). `name` is for equality
 *   with the call's x.ai/tool name only; it never goes on the wire.
 * - seenAt: now() read right before the stat that bounds the bytes consumed (the fstat of a read, or the lstat when
 *   nothing was appended): when caughtUp, every byte on disk at seenAt has been read, so an 'open' fact was open then.
 * - reset: the file was replaced (inode/device), shrank or the path changed since the last result: every earlier fact
 *   and ordinal is void; facts in this result already count from the new byte 0.
 * Calls are serialized. forget() drops everything (the next check starts at byte 0 with reset false).
 */
export class EventsTail {
  constructor({ maxLine = EVENTS_LINE_BYTES, maxCheck = EVENTS_CHECK_BYTES, chunk = EVENTS_CHUNK_BYTES,
    maxOpen = EVENTS_MAX_OPEN, now = Date.now } = {}) {
    this.maxLine = maxLine;
    this.maxCheck = maxCheck;
    this.chunk = chunk;
    this.maxOpen = maxOpen;
    this.now = now;
    this.s = null;
    this.queue = Promise.resolve(null);
  }

  /** Counters of the current file (lines, parsed, bad, long and the reducer's), for tests and debugState. */
  get stats() {
    return this.s ? { ...this.s.stats, ...this.s.reducer.stats } : null;
  }

  check(eventsPath, now = this.now) {
    const run = this.queue.then(() => this._check(eventsPath, now));
    this.queue = run.catch(() => null);
    return run;
  }

  forget() {
    this.s = null;
  }

  async _check(file, now) {
    try {
      if (typeof file !== 'string' || path.basename(file) !== EVENTS_FILE || typeof now !== 'function') return null;
      if (!this.s || this.s.file !== file) this.s = this._fresh(file, this.s);
      return await this._read(this.s, now);
    } catch {
      return null;
    }
  }

  _fresh(file, old) {
    const s = fileState(file, { maxOpen: this.maxOpen });
    s.resetPending = Boolean(old && (old.offset > 0 || old.resetPending));
    return s;
  }

  // 처음부터 다시 (다른 파일이 됐거나 짧아졌다). 처음 읽는 파일이면 reset 이 아니다.
  _restart(s, st) {
    const fresh = this._fresh(s.file, s);
    Object.assign(s, fresh, { ino: st.ino, dev: st.dev });
  }

  async _read(s, now) {
    const t0 = now();
    let st;
    try {
      st = await fsp.lstat(s.file);
    } catch {
      return null;
    }
    if (this.s !== s || !st.isFile()) return null;
    if (st.ino !== s.ino || st.dev !== s.dev || st.size < s.offset) this._restart(s, st);
    if (st.size === s.offset) return this._result(s, true, t0);
    let fh = null;
    try {
      // O_NONBLOCK: lstat 뒤에 바꿔 놓은 FIFO 도 막히지 않고 열리고, 아래 일반 파일 검사에서 걸러진다 (일반 파일에는 영향 없음)
      fh = await fsp.open(s.file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
      const seenAt = now();
      const cur = await fh.stat();
      if (this.s !== s || !cur.isFile() || cur.ino !== st.ino || cur.dev !== st.dev) return null;
      if (cur.size < s.offset) this._restart(s, cur);
      const end = Math.min(cur.size, s.offset + this.maxCheck);
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(this.chunk, end - s.offset)));
      while (s.offset < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - s.offset), s.offset);
        if (this.s !== s) return null;
        if (!bytesRead) break;
        this._consume(s, buf.subarray(0, bytesRead));
        s.offset += bytesRead;
        if (s.offset < end) await yieldNow();
      }
      return this.s === s ? this._result(s, s.offset === cur.size, seenAt) : null;
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  _result(s, caughtUp, seenAt) {
    const reset = s.resetPending;
    s.resetPending = false;
    if (!caughtUp) return { caughtUp: false, facts: [], seenAt, reset };
    const facts = s.closed;
    s.closed = [];
    for (const r of s.reducer.open.values()) {
      s.reported.add(r.e);
      facts.push({ ...r, state: 'open' });
    }
    facts.sort((a, b) => a.e - b.e);
    return { caughtUp: true, facts, seenAt, reset };
  }

  // 덩어리 하나를 줄로 나눈다. 버퍼는 다음 읽기에 다시 쓰이므로 줄바꿈 없이 남는 조각은 복사해 둔다.
  _consume(s, buf) {
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NL, start);
      const piece = buf.subarray(start, nl < 0 ? buf.length : nl);
      if (!s.skipping) {
        if (s.carryLen + piece.length > this.maxLine) {
          s.skipping = true;
          s.carry = [];
          s.carryLen = 0;
          s.stats.long += 1;
          this._closed(s, s.reducer.broken());
        } else if (nl < 0) {
          if (piece.length) {
            s.carry.push(Buffer.from(piece));
            s.carryLen += piece.length;
          }
        } else if (s.carryLen) {
          s.carry.push(piece);
          this._line(s, Buffer.concat(s.carry, s.carryLen + piece.length));
        } else if (piece.length) {
          this._line(s, piece);
        }
      }
      if (nl < 0) return;
      s.carry = [];
      s.carryLen = 0;
      s.skipping = false;
      start = nl + 1;
    }
  }

  _line(s, bytes) {
    s.stats.lines += 1;
    if (!wantedLine(bytes)) return;
    let rec;
    try {
      s.stats.parsed += 1;
      rec = JSON.parse(bytes.toString('utf8'));
    } catch {
      s.stats.bad += 1;
      this._closed(s, s.reducer.broken());
      return;
    }
    this._closed(s, s.reducer.apply(rec));
  }

  // 닫힌 요청 중 이미 열린 채로 알려 준 것만 다음 결과에 한 번 넣는다
  _closed(s, list) {
    for (const r of list) {
      if (!s.reported.delete(r.e)) continue;
      s.closed.push(r);
    }
  }
}
