// AntigravitySession: one Antigravity CLI (or legacy IDE) transcript (ADAPTERS 5.3) -> UI events, through the shared
// SessionCore (CONTRACT 4.0.2). SessionLike (ADAPTERS 3.2): apply(rec, { replay }), idle(nowMs), setInfo(info),
// sessionEvent(), snapshotEvents(), title, firstCwd, lastActivityMs, ended. 줄 하나(단계 하나)를 records.mjs / tools.mjs 로
// 풀어 정규화 항목으로 바꾸고, 그 사이에 필요한 상태(줄 위치, 결과를 기다리는 호출 대기열, 작업 폴더 대안)를 여기서
// 가진다. 리플레이와 라이브는 같은 코드 경로를 지난다. 파일 순서가 이긴다 (R12): created_at 으로 정렬하지 않는다.
//
// Mapping (ADAPTERS 6.1 / 6.2 Antigravity column):
//   USER_INPUT        -> calls still waiting end abandoned, turn_start (the core closes an open previous turn as
//                        next_turn), then prompt from the top-level <USER_REQUEST> only (no block -> no prompt)
//   PLANNER_RESPONSE  -> calls still waiting end abandoned; thinking (no duration); say from content (final: true when
//                        the step has no tool_calls: the core's end_turn quiet-time fallback); tool_start per call with
//                        id '<conversation>:<line position>:<i>' and a descriptor from tools.mjs
//   result lines      -> the next N result lines after a planner line with N calls are its results, in order
//                        (records.mjs resultEndOf: ERROR / error / exit_code != 0 -> failed, RUNNING -> ok + background)
//   CHECKPOINT        -> system compact (its text is not read). Not a closer: a result line can still come after it,
//                        so the calls keep waiting (P5e review finding 1)
//   ERROR_MESSAGE     -> calls still waiting end abandoned, system api_error (the turn goes on: the agent retries)
//   SYSTEM_MESSAGE, CONVERSATION_HISTORY -> nothing (they take no result slot)
//   unknown types     -> a result line while calls wait, else nothing
//   (no end marker)   -> a final say + 20 s of quiet ends the turn (core), a summary status idle ends it at once after
//                        a final say, and an idle that has stood IDLE_STATUS_QUIET_MS with no new line ends a turn
//                        without a closing answer (interrupted, given up after an error): its calls end abandoned
//
// Line position (the dedupe key and the tool ids). Antigravity records carry no call id, and step_index repeats and
// goes backwards (43 repeats, 19 backward jumps), so a line is known by its position in the file, never by step_index.
// The session counts the bytes of the lines it receives, from byte 0 at the start of the attach replay; live lines go on
// from where the replay stopped, so the ids of a line are the same whether it was replayed or read live. The Runner
// hands over parsed records, so the count uses the line's raw text when the caller gives it (`apply(line)` with the raw
// string, or `apply(rec, { line })`), else the byte length of the record re-serialized plus the newline: a pseudo offset
// that is deterministic for the same lines, not the file offset (blank and unparseable lines, which the Runner drops,
// are not counted). A caller that knows the real offset passes `{ offset }`; a line that starts before the position
// already reached is then a repeat (re-delivered) and is skipped. A re-attach (truncation, new inode, a switch between
// transcript_full.jsonl and transcript.jsonl) builds a fresh session that counts from 0 again, like the Tailer.
//
// Working folder: the workspace of the summaries proto arrives through setInfo({ cwd }) (the metadata reader). The
// first absolute run_command Cwd is only a fallback: during the attach replay it is remembered, and it is applied when the
// replay ends (the first idle() or live apply, after the Runner's first metadata read) if no cwd is known by then; after
// that the first Cwd is applied at once while no cwd is known. The core keeps the first cwd as the floor (4.4).
import { SessionCore } from '../../core/session-core.mjs';
import { isObj } from '../../core/session-items.mjs';
import {
  ANTIGRAVITY_AGENT, CLOSERS, PASSING, parseStep, userRequestOf, userCwdOf, resultEndOf, errorMessageText, planItemsOf, runStatusOf,
} from './records.mjs';
import { callStartOf, cwdOfCall } from './tools.mjs';

/**
 * A turn without a closing answer (interrupted, or given up after an error) has no end marker. Once a summary status
 * `idle` has been delivered for the open turn, this much quiet (no new line, no `running`, counted from the later of the
 * last line and that delivery) ends it: the waiting calls end abandoned, then turn_end end_turn. Longer than the closing
 * answer's END_TURN_IDLE_MS (20 s) and than the longest gap before a planner line in the study (35 s), so an idle read
 * while the model still writes its next step does not cut the turn.
 */
export const IDLE_STATUS_QUIET_MS = 60_000;

function byteLength(rec) {
  try {
    return Buffer.byteLength(JSON.stringify(rec), 'utf8') + 1;
  } catch {
    return 1;
  }
}

export class AntigravitySession {
  /**
   * @param {{ id: string, agent?: string, kind?: 'main'|'sub', parentId?: string|null, agentType?: string|null,
   *   now?: () => number }} o  id: the D2 character id 'antigravity-<conversation uuid>' (the brain folder uuid); the part
   *   after the prefix starts every tool id. All conversations are mains (no subagent link exists in the files).
   *   facts: the scan's facts for the file ({ full: true } transcript_full.jsonl with native argument values, { full:
   *   false } transcript.jsonl with JSON-encoded ones; unknown -> decided per value, tools.mjs argString). The Runner's
   *   other options (file, stem, subMeta, journalLabel) are accepted and ignored.
   */
  constructor({
    id, agent = ANTIGRAVITY_AGENT, kind = 'main', parentId = null, agentType = null, now = Date.now, facts = null,
  } = {}) {
    this.agent = typeof agent === 'string' && agent !== '' ? agent : ANTIGRAVITY_AGENT;
    this.core = new SessionCore({ id, agent: this.agent, kind, parentId, agentType, now });
    this._now = typeof now === 'function' ? now : Date.now;
    const prefix = `${this.agent}-`;
    const sid = typeof id === 'string' ? id : '';
    this._conv = sid.startsWith(prefix) && sid.length > prefix.length ? sid.slice(prefix.length) : sid || this.agent;
    this._pos = 0; // 지금까지 센 바이트 (다음 줄의 위치)
    this._lines = 0;
    this._repeats = 0; // 이미 지난 위치의 줄 (offset 을 받을 때만)
    this._skipped = 0; // 단계가 아닌 줄
    this._orphans = 0; // 기다리는 호출이 없는데 온 결과 줄
    this._pending = []; // 지난 계획 줄의 호출 중 결과 줄을 기다리는 것, 호출 순서: { id, hidden }
    this._unreadable = false; // 지난 계획 줄의 tool_calls 를 읽지 못했다: 다음 closer 까지 결과 줄을 건너뛴다
    this._lounge = new Set(); // 열린 schedule 호출 (라운지 방 힌트)
    this._settled = false; // 붙일 때의 replay 가 끝났다 (첫 idle() 이나 라이브 apply)
    this._cwdFallback = null; // replay 중에 본 첫 run_command Cwd
    this._final = false; // 열린 턴의 마지막 일이 도구 없는 말이다 (요약 상태 idle 이 턴을 닫을 수 있다)
    this._idleSeen = false; // 닫는 답보다 먼저 읽힌 요약 상태 idle: 그 답이 오면 턴을 바로 닫는다 (finding 7)
    this._idleAt = 0; // 그 idle 을 받은 서버 시각: 닫는 답 없이 IDLE_STATUS_QUIET_MS 가 지나면 턴을 닫는다
    this._tasksShown = false;
    this._format = isObj(facts) && typeof facts.full === 'boolean' ? (facts.full ? 'full' : 'truncated') : null;
  }

  // ------------------------------------------------------------------------------- SessionLike API

  /**
   * One transcript line -> events (and hint items). `rec` is the parsed record (the Runner) or the raw line text.
   * Replay builds the same state and returns only hints (there are none for Antigravity).
   * @param {object|string} rec
   * @param {{ replay?: boolean, line?: string, offset?: number }} [o]  line: the raw text of `rec` (exact byte count);
   *   offset: the line's real byte offset (then a line before the position already reached is skipped as a repeat).
   */
  apply(rec, { replay = false, line, offset } = {}) {
    const out = [];
    try {
      if (!replay) this._settle(out);
      let r = rec;
      let len;
      if (typeof rec === 'string') {
        len = Buffer.byteLength(rec, 'utf8') + 1;
        try {
          r = rec.trim() === '' ? null : JSON.parse(rec);
        } catch {
          r = null;
        }
      } else {
        len = typeof line === 'string' ? Buffer.byteLength(line, 'utf8') + 1 : byteLength(rec);
      }
      const pos = Number.isSafeInteger(offset) && offset >= 0 ? offset : this._pos;
      if (pos < this._pos) { // 다시 전달된 줄: 위치가 dedupe 키다
        this._repeats += 1;
        return out;
      }
      this._pos = pos + len;
      this._lines += 1;
      const step = parseStep(r);
      if (!step) {
        if (r !== null || typeof rec !== 'string' || rec.trim() !== '') this._skipped += 1;
        return out;
      }
      this._feed(this._items(step, pos), replay, out);
    } catch {
      this._skipped += 1;
    }
    return out;
  }

  idle(nowMs) {
    const out = [];
    this._settle(out);
    for (const ev of this.core.idle(nowMs)) out.push(this._patch(ev));
    this._idleEnd(nowMs, out);
    return out;
  }

  /**
   * Late info: the Store ({ parentProject, parentId, agentType }) or the metadata reader (meta.mjs AntigravityMeta, the
   * keys that changed): { title (annotation over summary), cwd (the workspace), branch } from the summaries proto /
   * annotations go to the core; `tasks` (the task.md checklist as [{ content, status }]) becomes a plan with source
   * 'tasks' (an empty list only clears a board it filled); `status` ('idle' | 'running') of the summaries proto: 'idle'
   * while the open turn's last work was a final say ends that turn now (turn_end end_turn, instead of waiting for the
   * quiet time). An 'idle' read before that answer (the summaries file and the transcript are read by separate loops) is
   * remembered: the next final say ends the turn at once, unless a USER_INPUT, a planner line with calls or a 'running'
   * status comes first (P5e review finding 7); when no closing answer comes, idle() ends the turn once that idle has
   * stood for IDLE_STATUS_QUIET_MS without a new line (_idleEnd). Before the attach replay has ended this builds state
   * only (no events).
   */
  setInfo(info) {
    const out = [];
    if (!isObj(info)) return out;
    for (const ev of this.core.setInfo(info)) out.push(ev);
    const items = planItemsOf(info.tasks);
    if (items && (items.length > 0 || this._tasksShown)) {
      this._tasksShown = true;
      this._feed([{ k: 'plan', items, source: 'tasks' }], !this._settled, out);
    }
    const status = runStatusOf(info.status);
    if (status === 'idle' && this._final && this._pending.length === 0) {
      this._final = false;
      this._idleSeen = false;
      this._feed([{ k: 'turn_end', reason: 'end_turn' }], !this._settled, out);
    } else if (status === 'idle') {
      if (!this._idleSeen) this._idleAt = this._now();
      this._idleSeen = true; // 아직 닫는 답 전이다: 그 답이 오면 닫고, 오지 않으면 _idleEnd 가 닫는다
    } else if (status === 'running') {
      this._idleSeen = false;
    }
    return out;
  }

  sessionEvent() { return this.core.sessionEvent(); }
  snapshotEvents() { return this.core.snapshotEvents().map((ev) => this._patch(ev)); }
  get title() { return this.core.title; }
  get firstCwd() { return this.core.firstCwd; }
  get lastActivityMs() { return this.core.lastActivityMs; }
  get ended() { return this.core.ended; }
  get skipped() { return this._skipped + this.core.skipped; }
  /** Bytes counted so far: the position the next line gets. */
  get position() { return this._pos; }

  /** Plain copy of the core state plus the Antigravity normalizer state (tests, debugging). */
  debugState() {
    return {
      ...this.core.debugState(),
      antigravity: {
        position: this._pos, lines: this._lines, repeats: this._repeats, skipped: this._skipped, orphans: this._orphans,
        pending: this._pending.map((p) => p.id), unreadable: this._unreadable, settled: this._settled,
        cwdFallback: this._cwdFallback !== null, final: this._final, idleSeen: this._idleSeen, format: this._format,
      },
    };
  }

  // ------------------------------------------------------------------------------- plumbing

  _feed(items, replay, out) {
    for (const it of items) for (const ev of this.core.apply(it, { replay })) out.push(this._patch(ev));
  }

  // schedule: the core has no lounge kind, so its tool_start gets the lounge room hint here (ADAPTERS 6.2)
  _patch(ev) {
    return ev.type === 'tool_start' && this._lounge.has(ev.toolUseId) ? { ...ev, room: 'lounge' } : ev;
  }

  // A turn that ends without a closing answer (interrupted, given up after an error): the delivered idle has stood for
  // IDLE_STATUS_QUIET_MS and no line came since. The waiting calls end abandoned (_close), then turn_end end_turn; on a
  // closed turn the core emits nothing for it. Once: the flag is cleared. A later line reopens the turn as usual (4.0.2).
  _idleEnd(nowMs, out) {
    if (!this._idleSeen || !Number.isFinite(nowMs)) return;
    const since = Math.max(this.core.lastActivityMs, this._idleAt);
    if (since <= 0 || nowMs - since < IDLE_STATUS_QUIET_MS) return;
    this._idleSeen = false;
    this._final = false;
    const items = [];
    const push = (item) => { items.push({ ...item, ts: nowMs }); };
    this._close(push);
    push({ k: 'turn_end', reason: 'end_turn' });
    this._feed(items, false, out);
  }

  // End of the attach replay: the run_command Cwd fallback, when the metadata gave no workspace. Through setInfo, so it
  // adds no growth (an old turn still ends at this idle()).
  _settle(out) {
    if (this._settled) return;
    this._settled = true;
    if (this._cwdFallback !== null && this.core.firstCwd === null) {
      for (const ev of this.core.setInfo({ cwd: this._cwdFallback })) out.push(ev);
    }
    this._cwdFallback = null; // 쓰였거나 필요 없다: 그 뒤로는 _cwd 가 바로 정한다
  }

  // ------------------------------------------------------------------------------- step -> items

  _items(s, pos) {
    const out = [];
    const push = (item) => { out.push(s.ms === null ? item : { ...item, ts: s.ms }); };
    if (CLOSERS.has(s.type)) this._close(push);
    switch (s.type) {
      case 'USER_INPUT': {
        const ucwd = userCwdOf(s.content);
        if (ucwd !== null) this._takeCwd(ucwd, push);
        push({ k: 'turn_start' }); // 턴 시작이 프롬프트보다 먼저 (CONTRACT 4.0.2)
        const text = userRequestOf(s.content);
        if (text !== null) push({ k: 'prompt', text });
        this._final = false;
        this._idleSeen = false;
        break;
      }
      case 'PLANNER_RESPONSE':
        this._planner(s, pos, push);
        break;
      case 'CHECKPOINT':
        push({ k: 'system', kind: 'compact' }); // 압축 글 (요약)은 읽지 않는다
        break;
      case 'ERROR_MESSAGE':
        push({ k: 'system', kind: 'api_error', text: errorMessageText(s) }); // 턴은 끝나지 않는다 (다시 시도한다)
        break;
      default:
        if (!PASSING.has(s.type)) this._result(s, push);
    }
    return out;
  }

  // The calls still waiting will never get their result line (research: >= 51 such cases): abandoned, mid-turn. Only the
  // CLOSERS call this (a CHECKPOINT does not: the result line of a waiting call can follow the compaction marker).
  _close(push) {
    for (const p of this._pending) {
      if (p.hidden) continue;
      this._lounge.delete(p.id);
      push({ k: 'tool_end', id: p.id, status: 'abandoned' });
    }
    this._pending = [];
    this._unreadable = false;
  }

  _planner(s, pos, push) {
    const hasCalls = s.calls.length > 0 || s.callsUnreadable;
    for (const call of s.calls) if (this._cwd(call, push)) break; // the session event moves before this line's events
    if (s.thinking !== null) push({ k: 'thinking', text: s.thinking, durationMs: null });
    if (s.content !== null) push(hasCalls ? { k: 'say', text: s.content } : { k: 'say', text: s.content, final: true });
    if (s.thinking !== null || s.content !== null || hasCalls) this._final = s.content !== null && !hasCalls;
    if (hasCalls) this._idleSeen = false; // 다시 일한다: 먼저 읽힌 idle 은 낡았다
    else if (this._final && this._idleSeen && this._pending.length === 0) { // idle 이 이 답보다 먼저 읽혔다 (finding 7)
      this._final = false;
      this._idleSeen = false;
      push({ k: 'turn_end', reason: 'end_turn' });
    }
    this._unreadable = s.callsUnreadable;
    for (let i = 0; i < s.calls.length; i++) {
      const call = s.calls[i];
      const id = `${this._conv}:${pos}:${i}`;
      const c = callStartOf(call, this._format);
      this._pending.push({ id, hidden: Boolean(c.hidden) });
      if (c.hidden) continue; // list_permissions: 결과 줄 자리만 차지한다
      if (c.room === 'lounge') this._lounge.add(id);
      push({ k: 'tool_start', id, ...c.start });
    }
  }

  // Cwd fallback (from <user_information> or run_command Cwd): remembered during replay, applied at once after it.
  // true = done (a cwd is remembered or known), so the caller stops looking.
  _takeCwd(cwd, push) {
    if (!this._settled) {
      if (this._cwdFallback !== null) return true;
      if (cwd !== null) this._cwdFallback = cwd;
      return this._cwdFallback !== null;
    }
    if (this.core.firstCwd !== null) return true;
    if (cwd === null) return false;
    push({ k: 'meta', cwd });
    return true;
  }

  _cwd(call, push) {
    return this._takeCwd(cwdOfCall(call, this._format), push);
  }

  _result(s, push) {
    if (this._pending.length === 0) {
      if (!this._unreadable) this._orphans += 1; // 짝 없는 결과 (순서가 어긋난 줄): 무시한다
      return;
    }
    const p = this._pending.shift();
    if (p.hidden) return;
    this._lounge.delete(p.id);
    push({ k: 'tool_end', id: p.id, ...resultEndOf(s) });
  }
}
