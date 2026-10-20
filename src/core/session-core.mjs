// SessionCore: normalized items of one session file (ADAPTERS 3.2) -> UI events (stateful, CONTRACT 2).
// 새 어댑터(Codex, Grok, Antigravity)가 같이 쓰는 SessionLike. 어댑터는 자기 기록을 정규화 항목으로 바꾸고, 걸러 내기,
// 도구 짝짓기, 턴, 계획판, 제목/cwd/branch, 시간 규칙, snapshot 은 여기서 한다. 규칙은 Claude 의 SessionState
// (CONTRACT 4.2 R14-R36) 를 따른다. 리플레이와 라이브는 같은 코드 경로로 상태를 만들고, 리플레이는 힌트 항목만 돌려준다.
//
// Items (adapter -> SessionCore, CONTRACT 4.0.2). Any item may carry `key` (dedupe: a repeated key yields nothing) and
// `ts` (ISO or ms; in replay a ts-less item adds no growth).
//   { k: 'meta', cwd?, branch?, title?, model?, parentId?, agentType? }   { k: 'prompt', text }
//   { k: 'tool_start', id, tool?, kind?, desc?, question?, options?, questions?, background?, items?, markdown?, source? }
//     (items / markdown / source only on a kind 'plan' call: its plan shows at an ok tool_end, R35)
//   { k: 'tool_end', id, status?: 'ok'|'failed'|'denied'|'interrupted', errorLine?, background? }
//   { k: 'thinking', text|null, durationMs? }   { k: 'say', text, final? }
//   { k: 'plan', items?: [{ content, status }], markdown?, source?: 'update_plan'|'tasks' }  (markdown -> exit_plan)
//   { k: 'turn_start', id? }   { k: 'turn_end', reason }   { k: 'system', kind: 'api_error'|'compact'|'refusal', text }
//   { k: 'sub_end', childId, reason?: 'done'|'idle' }  -> an internal { hint: 'end', charId } item (CONTRACT 4.0.1)
// Order: a turn's `turn_start` comes before its `prompt` (R30). Work before the first turn_start opens no turn.
import { iso } from '../session-util.mjs';
import { buildSessionEvent, agentScopedId } from '../session-identity.mjs';
import { END_TURN_IDLE_MS, SUB_IDLE_MS } from '../session.mjs';
import {
  isObj, itemTs, itemId, itemKey, promptOf, sayText, thinkingFields, endFields, startFields, planViewOf, planFields,
  systemFields, TURN_END_REASONS,
} from './session-items.mjs';

export { END_TURN_IDLE_MS, SUB_IDLE_MS };

const ABANDONED = { ok: false, errorKind: 'abandoned', error: 'no result' }; // R27 과 같은 문구
const END_HINT_REASONS = new Set(['done', 'idle']);
const isHint = (ev) => ev.hint !== undefined;
const str = (v) => typeof v === 'string' && v.trim() !== '';

export class SessionCore {
  /**
   * @param {{ id: string, agent: string, kind?: 'main'|'sub', parentId?: string|null, agentType?: string|null,
   *   now?: () => number }} o  id: the character id (D2: '<agent>-...'); parentId: the owner of a sub (same agent).
   *   Other Runner options (file, stem, subMeta, ...) are accepted and ignored.
   */
  constructor({ id, agent, kind = 'main', parentId = null, agentType = null, now = Date.now } = {}) {
    this.id = id;
    this.agent = agent;
    this.kind = kind === 'sub' ? 'sub' : 'main';
    this.parentId = this.kind === 'sub' && agentScopedId(agent, parentId) ? parentId : null;
    this.agentType = str(agentType) ? agentType : null;
    this._now = typeof now === 'function' ? now : Date.now;
    this.skipped = 0; // 잘못된 항목 (세고 건너뛴다)

    this._keys = new Set(); // dedupe keys
    this._opened = new Set(); // R9: never open the same tool id twice
    this._open = new Map(); // tool id -> { id, ignored, startEv, plan }, insertion order = start order
    this._planEv = null;
    this._planKey = null;
    this._turnId = null; // R30
    this._turnStarted = false; // a turn_start was seen: only then does assistant work reopen a closed turn
    this._turnOpen = false;
    this._endTurnArmed = false;
    this._ended = false;

    this._title = null;
    this._firstPrompt = null;
    this._firstCwd = null;
    this._lastCwd = null;
    this._branch = null;
    this._parentProject = null;
    this._lastTs = null;
    this._lastGrowthMs = 0;
    this._untimedReplay = false; // a replayed item without ts was applied (it adds no growth, like Claude)
    this._sessionKey = null;
    this._out = null;
  }

  // ------------------------------------------------------------------------------- SessionLike API

  /** One normalized item -> events (and hint items). Replay builds the same state and returns only hint items. */
  apply(item, { replay = false } = {}) {
    const out = this._collect(() => this._apply(item, replay));
    return replay ? out.filter(isHint) : out;
  }

  /** Time rules: end_turn after a final `say` (main), idle end of a sub. */
  idle(nowMs) {
    return this._collect(() => {
      if (!Number.isFinite(nowMs)) return;
      // 시각이 전혀 없는 파일만 첫 idle() 부터 센다 (항목이 없는 서브는 Claude 처럼 세지 않는다)
      if (this._lastGrowthMs === 0 && this._untimedReplay) this._lastGrowthMs = nowMs;
      if (this._lastGrowthMs > nowMs) this._lastGrowthMs = nowMs; // 서버 시계보다 앞선 성장은 지금부터 센다
      const quiet = this._lastGrowthMs > 0 ? nowMs - this._lastGrowthMs : -1;
      if (quiet < 0) return;
      const ts = iso(nowMs);
      if (this.kind === 'main') {
        if (this._turnOpen && this._endTurnArmed && quiet >= END_TURN_IDLE_MS) this._closeTurn('end_turn', ts);
      } else if (!this._ended && quiet >= SUB_IDLE_MS && this._open.size === 0) {
        this._endSession('idle', ts);
      }
    });
  }

  /**
   * Late info: from the Store ({ parentProject, parentId, agentType, subMeta, journalLabel }, the last two ignored) or a
   * sidecar file ({ title, cwd, branch }). Returns the changed `session` event, if any.
   */
  setInfo(info = {}) {
    return this._collect(() => {
      if (!isObj(info)) return;
      if (str(info.parentProject)) this._parentProject = info.parentProject;
      this._applyMeta(info);
      this._checkSession();
    });
  }

  sessionEvent() {
    const sub = this.kind !== 'main';
    const prefix = `${this.agent}-`;
    const id = typeof this.id === 'string' ? this.id : '';
    return buildSessionEvent({
      id: this.id, agent: this.agent, kind: this.kind, parentId: this.parentId, agentType: this.agentType,
      // 제목이 아직 없을 때의 대안(id 앞 8자)은 어댑터 접두사를 뺀 부분에서 (D2 id 자체는 그대로)
      stem: sub ? null : (id.startsWith(prefix) ? id.slice(prefix.length) : id) || null,
      info: { subMeta: sub && this._title ? { name: this._title } : null, journalLabel: null, fileTitle: null,
        parentProject: this._parentProject },
      meta: { title: sub ? null : this._title, agentName: null, lastPrompt: null, summary: null, relocatedCwd: null },
      firstPrompt: sub ? null : this._firstPrompt, firstCwd: this._firstCwd, lastCwd: this._lastCwd, branch: this._branch,
      worktreeState: null, worktreeSticky: null, ts: this._lastTs || iso(this._now()),
    });
  }

  /** Events that recreate the current state: session, current plan, still-open tool_starts (asks with their fields). */
  snapshotEvents() {
    if (this._ended) return [];
    const out = [this.sessionEvent()];
    if (this._planEv && this._planEv.items.length) {
      out.push({ ...this._planEv, items: this._planEv.items.map((it) => ({ ...it })) });
    }
    for (const e of this._open.values()) {
      if (!e.startEv) continue;
      const ev = { ...e.startEv };
      if (Array.isArray(ev.options)) ev.options = [...ev.options];
      out.push(ev);
    }
    return out;
  }

  get title() { return this.sessionEvent().title; }
  get firstCwd() { return this._firstCwd; }
  get lastActivityMs() { return this._lastGrowthMs; }
  get ended() { return this._ended; }

  /** Plain copy of the internal state (tests, debugging). */
  debugState() {
    return {
      open: [...this._open.values()].map((e) => ({ id: e.id, ignored: e.ignored })),
      turnId: this._turnId, turnOpen: this._turnOpen, endTurnArmed: this._endTurnArmed, ended: this._ended,
      plan: this._planEv ? { source: this._planEv.source, items: this._planEv.items } : null, skipped: this.skipped,
    };
  }

  // ------------------------------------------------------------------------------- dispatch

  // Runs fn with an event sink and returns what it emitted. Never throws: a failure counts as a skipped item.
  _collect(fn) {
    const out = [];
    const prev = this._out;
    this._out = out;
    try {
      fn();
    } catch {
      this.skipped += 1;
    }
    this._out = prev;
    return out;
  }

  _apply(item, replay) {
    const handler = isObj(item) && typeof item.k === 'string' && Object.hasOwn(HANDLERS, item.k) ? HANDLERS[item.k] : null;
    if (!handler) {
      this.skipped += 1;
      return;
    }
    const key = itemKey(item.key);
    if (key !== null) {
      if (this._keys.has(key)) return; // 같은 기록이 다시 왔다 (이어 쓰기, 복사): 처음 것만
      this._keys.add(key);
    }
    const ts = itemTs(item.ts);
    this._touch(ts, replay);
    // 끝난 서브는 받아들인 일 항목(handler 안의 _wake)에서만 다시 선다: 잘못된 항목은 세고 건너뛸 뿐이다
    if (item.k !== 'meta') this._checkSession(); // 첫 항목: session 이벤트가 다른 이벤트보다 먼저 (meta 는 바꾼 뒤 한 번)
    if (handler.call(this, item, ts) === false) this.skipped += 1;
    this._checkSession();
  }

  _touch(ts, replay) {
    if (ts) this._lastTs = ts;
    // 리플레이는 기록 시각으로, 라이브는 서버 시계로 성장을 센다 (SessionState._touch 와 같다). 시각 없는 리플레이 항목은
    // 성장이 아니다: 오래된 파일이 붙는 순간 끝날 수 있게 (모두 시각이 없으면 idle() 이 첫 호출부터 센다)
    if (replay && !ts) {
      this._untimedReplay = true;
      return;
    }
    const g = replay ? Date.parse(ts) : this._now();
    if (Number.isFinite(g) && g > this._lastGrowthMs) this._lastGrowthMs = g;
  }

  _applyMeta(m) {
    if (str(m.cwd)) {
      if (this._firstCwd === null) this._firstCwd = m.cwd; // 4.4: 층은 첫 작업 폴더
      this._lastCwd = m.cwd;
    }
    if (str(m.branch)) this._branch = m.branch;
    if (str(m.title)) this._title = m.title;
    if (str(m.agentType)) this.agentType = m.agentType;
    if (this.kind === 'sub' && agentScopedId(this.agent, m.parentId)) this.parentId = m.parentId;
  }

  // 끝난 서브가 받아들인 새 일 (prompt, turn_start, tool_start; Claude R29): 다시 세우고 session 을 먼저 낸다
  _wake() {
    if (!this._ended) return;
    this._ended = false;
    const ev = this.sessionEvent();
    this._sessionKey = this._key(ev);
    this._emit(ev);
  }

  // 일하는 항목 (thinking, say, tool_start): 턴 끝 추정을 풀고, turn_start 를 본 뒤에만 닫힌 턴을 다시 연다 (R30 reopen,
  // Claude 는 promptId 를 알 때만). 그 전의 일은 턴을 열지 않는다: 시작하지 않은 턴의 turn_end 는 없다
  _work() {
    this._endTurnArmed = false;
    if (this._turnStarted) this._turnOpen = true;
  }

  // ------------------------------------------------------------------------------- tools

  _startTool(item, ts) {
    const id = itemId(item.id);
    if (id === null) return false;
    this._wake(); // Claude 도 같은 id 가 다시 온 tool_use 로 끝난 서브를 다시 세운다
    if (this._opened.has(id)) return true; // R9
    this._opened.add(id);
    this._work();
    const s = startFields(id, item);
    const entry = { id, ignored: s.ignore, startEv: null, plan: null };
    this._open.set(id, entry);
    if (s.ignore) { // kind 'plan': tool_start 없이, 성공한 tool_end 에서 plan 이벤트만 (R35)
      entry.plan = planViewOf(item);
      return true;
    }
    entry.startEv = this._ev('tool_start', ts, s.fields);
    this._emit(entry.startEv);
    return true;
  }

  _endTool(item, ts) {
    const id = itemId(item.id);
    if (id === null) return false;
    const entry = this._open.get(id);
    if (!entry) return true; // R16: 모르는 id 는 무시
    this._open.delete(id);
    // R28: background 는 띄운 일이 ok 로 끝났다는 뜻일 뿐, 명시한 failed/denied/interrupted 를 덮지 않는다
    const fields = endFields(id, item);
    if (!entry.ignored) this._emit(this._ev('tool_end', ts, fields));
    else if (fields.ok && entry.plan) this._emitPlan(entry.plan, ts); // R35: 성공한 호출만 판을 바꾼다
    return true;
  }

  // R27: 결과 없이 턴이 끝나거나 다음 턴이 오면 열린 도구는 abandoned (plan 도구는 아무것도 내지 않는다)
  _abandonAll(ts) {
    for (const e of [...this._open.values()]) {
      this._open.delete(e.id);
      if (!e.ignored) this._emit(this._ev('tool_end', ts, { toolUseId: e.id, ...ABANDONED }));
    }
  }

  // ------------------------------------------------------------------------------- turns (R30)

  _turnStart(item, ts) {
    this._wake();
    const id = item.id === undefined || item.id === null ? null : itemId(item.id);
    if (id === null || id !== this._turnId || !this._turnStarted) this._closeTurn('next_turn', ts); // 같은 턴 id: 같은 턴
    this._turnId = id;
    this._turnStarted = true;
    this._work(); // 닫혀 있던 같은 턴도 다시 연다
    return true;
  }

  _turnEnd(item, ts) {
    this._closeTurn(TURN_END_REASONS.has(item.reason) ? item.reason : 'end_turn', ts);
    return true;
  }

  // 열린 도구를 abandoned 로 닫고, 열린 턴이면 turn_end. 턴 이벤트는 메인만 (서브는 session_end 로 끝난다, R29/R30)
  _closeTurn(reason, ts) {
    this._abandonAll(ts);
    if (this._turnOpen && this.kind === 'main') this._emit(this._ev('turn_end', ts, { reason }));
    this._turnOpen = false;
    this._endTurnArmed = false;
  }

  _endSession(reason, ts) {
    if (this._ended) return;
    this._closeTurn('end_turn', ts);
    this._emit(this._ev('session_end', ts, { reason }));
    this._ended = true;
  }

  // ------------------------------------------------------------------------------- plan

  _emitPlan(view, ts) {
    const fields = planFields(view);
    const key = JSON.stringify(fields);
    // 같은 tasks 스냅숏은 다시 보내지 않는다 (PlanBoard.taskView). update_plan / exit_plan 은 호출마다 (R34/R35)
    if (fields.source === 'tasks' && key === this._planKey) return;
    this._planKey = key;
    this._planEv = this._ev('plan', ts, fields);
    this._emit(this._planEv);
  }

  // ------------------------------------------------------------------------------- identity / events

  _key(ev) {
    return JSON.stringify({ ...ev, ts: undefined });
  }

  _checkSession() {
    const ev = this.sessionEvent();
    const key = this._key(ev);
    if (key === this._sessionKey) return;
    this._sessionKey = key;
    this._emit(ev);
  }

  _ev(type, ts, fields) {
    return { type, sessionId: this.id, ts: ts || this._lastTs || iso(this._now()), ...fields };
  }

  _emit(ev) {
    if (!this._out) return;
    if (this._ended && ev.type !== 'session_end') return; // 끝난 서브는 새 일을 받을 때까지 조용하다
    this._out.push(ev);
  }
}

// item.k -> handler (this = SessionCore). false = malformed (counted in `skipped`).
const HANDLERS = {
  meta(item) {
    this._applyMeta(item);
  },
  prompt(item, ts) {
    if (typeof item.text !== 'string') return false;
    this._wake();
    this._endTurnArmed = false; // 사람 입력은 턴을 열지 않는다 (turn_start 가 연다, R30): 턴 끝 추정만 푼다
    const p = promptOf(item.text);
    // 서브의 사람 입력은 부모가 넘긴 과제다 (Agent prompt, section 5): 보내지 않고 제목에도 쓰지 않는다
    if (!p || this.kind !== 'main') return true;
    if (this._firstPrompt === null) this._firstPrompt = p.raw;
    this._emit(this._ev('prompt', ts, { text: p.text }));
    return true;
  },
  tool_start(item, ts) { return this._startTool(item, ts); },
  tool_end(item, ts) { return this._endTool(item, ts); },
  thinking(item, ts) {
    this._work();
    this._emit(this._ev('thinking', ts, thinkingFields(item)));
  },
  say(item, ts) {
    this._work();
    const text = sayText(item.text);
    if (text) this._emit(this._ev('say', ts, { text }));
    if (item.final === true) this._endTurnArmed = true; // R30 end_turn: 20 s 조용하면 idle() 이 턴을 닫는다
    return typeof item.text === 'string';
  },
  plan(item, ts) {
    if (!Array.isArray(item.items) && typeof item.markdown !== 'string') return false;
    const view = planViewOf(item);
    if (view) this._emitPlan(view, ts);
    return true;
  },
  turn_start(item, ts) { return this._turnStart(item, ts); },
  turn_end(item, ts) { return this._turnEnd(item, ts); },
  system(item, ts) {
    const fields = systemFields(item);
    if (!fields) return false;
    this._emit(this._ev('system', ts, fields));
    return true;
  },
  sub_end(item) {
    // 부모 파일에 적힌 자식의 끝: 이벤트가 아니라 Runner 가 Store.endCharacter 로 넘기는 힌트 (같은 어댑터의 id 만)
    if (!agentScopedId(this.agent, item.childId) || item.childId === this.id) return false;
    const hint = { hint: 'end', charId: item.childId };
    if (END_HINT_REASONS.has(item.reason)) hint.reason = item.reason;
    this._out?.push(hint);
    return true;
  },
};
