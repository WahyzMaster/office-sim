// SessionState: ordered records of one transcript file -> UI events (stateful). CONTRACT 3.4, rules in 4.
// 리플레이 모드와 라이브 모드는 같은 코드 경로로 상태를 만들고, 리플레이일 때만 이벤트를 버린다.
import { classifyRecord } from './records.mjs';
import { cleanText } from './summarize.mjs';
import { PlanBoard, UPDATE_PLAN } from './session-plan.mjs';
import {
  projectKey, resultStatus, isUserRejected, firstSentence, firstLine, toolStart, systemFields, iso,
} from './session-util.mjs';
import { buildSessionEvent, CLAUDE_CODE_AGENT } from './session-identity.mjs';

export { projectKey };

export const END_TURN_IDLE_MS = 20_000; // R30 end_turn fallback
export const SUB_FINAL_IDLE_MS = 15_000; // R29 final text with no tool_use
export const SUB_IDLE_MS = 120_000; // R29 no growth, no pending tools
export const SUB_UNFINISHED_IDLE_MS = 600_000; // R29 same, while the current API message is still streaming
export const HOLD_FLUSH_MS = 2_000; // R25 held user rejection with no following record

const WRAP_UP = 'mcp__ccd_turn__wrap_up';
const PLUMBING = new Set([UPDATE_PLAN, WRAP_UP]);
const NO_RESPONSE = 'No response requested.';
// R29: only these stop reasons mark a final text; a mid-message text line has stop_reason null or tool_use.
const FINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal']);

const CLAUDE_SURFACE = Object.freeze({
  'claude-desktop': 'app', cli: 'cli', 'sdk-cli': 'cli', 'claude-vscode': 'ide', vscode: 'ide',
});
export const claudeSurfaceOf = (ep) => (typeof ep === 'string' && Object.hasOwn(CLAUDE_SURFACE, ep) ? CLAUDE_SURFACE[ep] : null);

export class SessionState {
  constructor({
    id, file = null, kind = 'main', stem = null, parentId = null, agentType = null, now = Date.now,
    subMeta = null, journalLabel = null, fileTitle = null, parentProject = null, agent = CLAUDE_CODE_AGENT,
  } = {}) {
    this.id = id;
    this.agent = agent; // session.agent (4.0.1): the adapter id, 'claude-code' unless the Runner says otherwise
    this.file = file;
    this.kind = kind;
    this.stem = stem;
    this.parentId = parentId;
    this.agentType = agentType;
    this._now = typeof now === 'function' ? now : Date.now;
    this._info = { subMeta, journalLabel, fileTitle, parentProject };

    this._seen = new Set(); // R9 uuid dedupe
    this._opened = new Set(); // R9 never open a tool twice
    this._open = new Map(); // toolUseId -> entry, insertion order = start order
    this._held = []; // R25 user-rejected results waiting one record
    this._curMsgId = null; // R13 current assistant message group
    this._curMsgHasTool = false;

    this._board = new PlanBoard({ collectDeltas: kind !== 'main' }); // sub/wf: TaskCreate/TaskUpdate for the main (R36)
    this._planEv = null;

    this._promptId = null; // R30
    this._turnOpen = false;
    this._endTurnSeen = false;
    this._subFinal = false; // R29
    this._unfinished = false; // R29: last line stop_reason null and the message has no tool_use yet
    this._ended = false;

    this._meta = { title: null, agentName: null, lastPrompt: null, summary: null, relocatedCwd: null };
    this._worktreeState = null; // latest worktree-state (null = exited)
    this._worktreeSticky = null; // latest non-null worktree-state, keeps the project key stable
    this._firstPrompt = null;
    this._firstCwd = null;
    this._lastCwd = null;
    this._branch = null;
    this._lastTs = null;
    this._lastGrowthMs = 0;
    this._surface = null;
    this._sessionKey = null;
    this._out = null;
  }

  // ------------------------------------------------------------------------------- public API

  /** Apply one parsed record. Returns events (empty in replay mode); state is identical in both. */
  apply(rec, { replay = false } = {}) {
    const out = this._collect(() => this._apply(rec, replay));
    return replay ? [] : out;
  }

  /** Timeouts: held rejections, end_turn fallback (main), subagent end (sub/wf). */
  idle(nowMs) {
    return this._collect(() => this._idle(nowMs));
  }

  _idle(nowMs) {
    const ts = iso(nowMs);
    // Growth stamped ahead of the server clock (replayed timestamps, clock stepped back) counts from now.
    if (this._lastGrowthMs > nowMs) this._lastGrowthMs = nowMs;
    const quiet = this._lastGrowthMs > 0 ? nowMs - this._lastGrowthMs : -1;
    if (this._held.length && quiet >= HOLD_FLUSH_MS) this._flushHeld(false);
    if (this.kind === 'main') {
      if (this._turnOpen && this._endTurnSeen && quiet >= END_TURN_IDLE_MS) this._turnEnd('end_turn', ts);
    } else if (!this._ended && quiet >= 0) {
      const limit = this._unfinished ? SUB_UNFINISHED_IDLE_MS : SUB_IDLE_MS;
      if (this._subFinal && quiet >= SUB_FINAL_IDLE_MS) this._endSession('done', ts);
      else if (quiet >= limit && this._open.size === 0) this._endSession('idle', ts);
    }
  }

  /** Late info from discover/store (meta.json, journal label, custom-title.json, parent project). */
  setInfo(info = {}) {
    return this._collect(() => {
      for (const k of ['subMeta', 'journalLabel', 'fileTitle', 'parentProject']) {
        if (info[k] !== undefined) this._info[k] = info[k];
      }
      if (info.parentId !== undefined) this.parentId = info.parentId;
      if (info.agentType !== undefined) this.agentType = info.agentType;
      this._checkSession();
    });
  }

  sessionEvent() {
    return buildSessionEvent({
      id: this.id, agent: this.agent, kind: this.kind, stem: this.stem, parentId: this.parentId, agentType: this.agentType,
      info: this._info, meta: this._meta, firstPrompt: this._firstPrompt, firstCwd: this._firstCwd,
      lastCwd: this._lastCwd, branch: this._branch, worktreeState: this._worktreeState,
      worktreeSticky: this._worktreeSticky, ts: this._lastTs || iso(this._now()),
    });
  }

  /** Events that recreate the current state: session, current plan, still-open tool_starts. */
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
  get surface() { return this._surface; }

  /** Sub/wf: drain successful TaskCreate/TaskUpdate deltas (collected in replay and live) for the main file. */
  takeTaskDeltas() {
    return this._board.takeDeltas();
  }

  /** Main: apply a subagent's task delta (R36, shared task list). Returns events (a `plan` event or nothing). */
  applyExternalTask(delta) {
    return this._collect(() => {
      if (this.kind === 'main') this._emitPlan(this._board.external(delta), delta?.ts);
    });
  }

  /** Plain copy of the internal state (tests, debugging). Excludes timing. */
  debugState() {
    return {
      seen: this._seen.size,
      open: [...this._open.values()].map((e) => ({ id: e.id, name: e.name, msgId: e.msgId, held: Boolean(e.held) })),
      ...this._board.debug(),
      planEv: this._planEv ? { source: this._planEv.source, items: this._planEv.items } : null,
      promptId: this._promptId,
      turnOpen: this._turnOpen,
      endTurnSeen: this._endTurnSeen,
      subFinal: this._subFinal,
      unfinished: this._unfinished,
      ended: this._ended,
      curMsgId: this._curMsgId,
      session: { ...this.sessionEvent(), ts: undefined },
    };
  }

  // ------------------------------------------------------------------------------- dispatch

  // Runs fn with an event sink and returns what it emitted. Never throws on a strange record.
  _collect(fn) {
    const out = [];
    this._out = out;
    try {
      fn();
    } catch {
      // keep the events emitted so far
    }
    this._out = null;
    return out;
  }

  _apply(rec, replay) {
    const surf = claudeSurfaceOf(rec?.entrypoint);
    if (surf && !this._surface) this._surface = surf;
    const c = classifyRecord(rec);
    if (c.kind === 'ignore' && !c.uuid) return; // queue-operation, mode, pr-link ...
    if (c.kind === 'meta') {
      if (this._isFork(c)) return;
      this._applyMeta(c);
      this._checkSession();
      return;
    }
    if (c.uuid) {
      if (this._seen.has(c.uuid)) return; // R9 resume re-append or copy: keep the first
      this._seen.add(c.uuid);
    }
    if (this._isFork(c)) return; // R10 fork history: uuids collected, nothing else
    this._touch(c, replay);
    if (c.kind === 'ignore') {
      this._checkSession();
      return;
    }
    this._maybeResurrect(c);
    // Sibling rejections queue together; anything else decides the held ones (R25).
    if (this._held.length && c.kind !== 'interrupt' && !(c.kind === 'tool_result' && isUserRejected(c))) this._flushHeld(false);
    this._checkSession();
    switch (c.kind) {
      case 'assistant': this._onAssistant(c); break;
      case 'tool_result': this._onToolResult(c); break;
      case 'interrupt': this._onInterrupt(c); break;
      case 'prompt': this._onPrompt(c); break;
      case 'notification': this._onNotification(c); break;
      case 'turn_start': this._onTurnStart(c); break;
      case 'system': this._onSystem(c); break;
      case 'task_reminder': this._emitPlan(this._board.reminder(c.content, c.ts), c.ts); break;
      default: break;
    }
    this._checkSession();
  }

  _isFork(c) {
    return this.kind === 'main' && typeof this.stem === 'string' && typeof c.sessionId === 'string' && c.sessionId !== this.stem;
  }

  _touch(c, replay) {
    if (c.ts) this._lastTs = c.ts;
    const g = replay ? Date.parse(c.ts ?? '') : this._now();
    if (Number.isFinite(g) && g > this._lastGrowthMs) this._lastGrowthMs = g;
    if (typeof c.cwd === 'string' && c.cwd !== '') {
      if (this._firstCwd === null) this._firstCwd = c.cwd;
      this._lastCwd = c.cwd;
    }
    if (typeof c.gitBranch === 'string' && c.gitBranch !== '') this._branch = c.gitBranch;
  }

  _applyMeta(c) {
    if (c.field === 'worktree') {
      this._worktreeState = c.value;
      if (c.value) this._worktreeSticky = c.value;
    } else if (Object.hasOwn(this._meta, c.field) && typeof c.value === 'string' && c.value.trim() !== '') {
      this._meta[c.field] = c.value; // title, agentName, lastPrompt, summary, relocatedCwd
    }
  }

  // A subagent that ended can be resumed (SendMessage). Only new work brings it back.
  _maybeResurrect(c) {
    if (!this._ended) return;
    const work = c.kind === 'prompt' || c.kind === 'turn_start' || c.kind === 'notification'
      || (c.kind === 'assistant' && c.blocks.some((b) => b.type === 'tool_use'));
    if (!work) return;
    this._ended = false;
    this._subFinal = false;
    const ev = this.sessionEvent();
    this._sessionKey = this._key(ev);
    this._emit(ev);
  }

  // R13/R14/R27/R31
  _onAssistant(c) {
    // R30/R32: work under a known promptId after the turn closed (or in a compact-summary-first file) reopens it
    if (this.kind === 'main' && !this._turnOpen && this._promptId && !c.synthetic) {
      this._turnOpen = true;
      this._endTurnSeen = false;
    }
    const newMsg = c.msgId !== null && c.msgId !== this._curMsgId;
    if (newMsg) {
      this._abandon((e) => e.msgId !== c.msgId, c.ts);
      this._curMsgId = c.msgId;
      this._curMsgHasTool = false;
    }
    const hasTool = c.blocks.some((b) => b.type === 'tool_use');
    const hasText = c.blocks.some((b) => b.type === 'text' && b.text.trim() !== '');
    if (c.synthetic && c.apiError) {
      const text = firstLine(c.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
      this._emit(this._ev('system', c.ts, { kind: 'api_error', text: cleanText(text, 120) || 'API error' }));
      this._endTurnSeen = false;
      this._turnEnd('api_error', c.ts);
      this._unfinished = false;
      if (this.kind !== 'main') this._subFinal = this._open.size === 0;
      return;
    }
    for (const b of c.blocks) {
      if (b.type === 'thinking') {
        this._emit(this._ev('thinking', c.ts, { text: firstSentence(b.text), durationMs: c.thinkingDurationMs }));
      } else if (b.type === 'text') {
        if (c.synthetic && b.text.trim() === NO_RESPONSE) continue;
        const text = cleanText(b.text, 100);
        if (text) this._emit(this._ev('say', c.ts, { text }));
      } else if (b.type === 'tool_use') {
        this._startTool(b, c);
      }
    }
    if (hasTool) this._curMsgHasTool = true;
    this._endTurnSeen = c.stopReason === 'end_turn';
    this._unfinished = c.stopReason === null && !this._curMsgHasTool;
    if (this.kind !== 'main') {
      if (hasTool) this._subFinal = false;
      else if (hasText) this._subFinal = FINAL_STOPS.has(c.stopReason) && !this._curMsgHasTool && this._open.size === 0;
      else if (newMsg) this._subFinal = false;
    }
  }

  // R14/R33/R34
  _startTool(b, c) {
    if (this._opened.has(b.id)) return;
    this._opened.add(b.id);
    const t = toolStart(b);
    const entry = { id: b.id, name: b.name, msgId: c.msgId, input: b.input, ignored: t.ignore || PLUMBING.has(b.name), startEv: null, held: null };
    this._open.set(b.id, entry);
    if (entry.ignored) return;
    // R34: the plan goes on the board before the blocking approval question (same order as snapshotEvents)
    if (b.name === 'ExitPlanMode') this._emitPlan(this._board.exitPlan(b.input && b.input.plan), c.ts);
    entry.startEv = this._ev('tool_start', c.ts, t.fields);
    this._emit(entry.startEv);
  }

  // R16/R24/R25/R28/R35/R36
  _onToolResult(c) {
    const entry = c.toolUseId ? this._open.get(c.toolUseId) : null;
    if (!entry || entry.held) return; // unknown id, or already answered
    this._unfinished = false;
    if (this.kind !== 'main') this._subFinal = false;
    const st = resultStatus(c);
    if (!st.ok && !entry.ignored && isUserRejected(c)) {
      entry.held = { st, c };
      this._held.push(entry);
      return;
    }
    this._finish(entry, st, c);
  }

  _finish(entry, st, c) {
    this._open.delete(entry.id);
    if (!entry.ignored) {
      const fields = { toolUseId: entry.id, ok: st.ok };
      if (!st.ok) {
        fields.errorKind = st.errorKind;
        fields.error = st.error;
      }
      this._emit(this._ev('tool_end', c.ts, fields));
    }
    if (!st.ok) return;
    for (const view of this._board.toolResult(entry.id, entry.name, entry.input, c)) this._emitPlan(view, c.ts);
    if (c.endTurn) {
      if (this.kind === 'main') {
        if (entry.name === WRAP_UP) this._turnEnd('wrap_up', c.ts);
      } else {
        this._endSession('done', c.ts);
      }
    }
  }

  _flushHeld(interrupted) {
    const held = this._held;
    this._held = [];
    for (const e of held) {
      if (this._open.get(e.id) !== e) continue;
      const st = interrupted ? { ok: false, errorKind: 'interrupted', error: e.held.st.error } : e.held.st;
      this._finish(e, st, e.held.c);
    }
  }

  // R27: tools with no result become abandoned.
  _abandon(pred, ts) {
    for (const e of [...this._open.values()]) {
      if (e.held || !pred(e)) continue;
      this._open.delete(e.id);
      if (!e.ignored) this._emit(this._ev('tool_end', ts, { toolUseId: e.id, ok: false, errorKind: 'abandoned', error: 'no result' }));
    }
  }

  // R25/R27/R30
  _onInterrupt(c) {
    if (this._held.length) this._flushHeld(true);
    this._abandon(() => true, c.ts);
    this._endTurnSeen = false;
    this._turnEnd('interrupt', c.ts);
  }

  _onPrompt(c) {
    this._unfinished = false;
    if (this.kind !== 'main') this._subFinal = false;
    if (c.promptId) this._turnStart(c.promptId, true, c.ts);
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (text === '' || text.startsWith('<')) return;
    if (this._firstPrompt === null) this._firstPrompt = text;
    const t = cleanText(text, 80);
    if (t) this._emit(this._ev('prompt', c.ts, { text: t }));
  }

  _onNotification(c) {
    this._unfinished = false;
    if (this.kind !== 'main') this._subFinal = false;
    if (c.promptId) this._turnStart(c.promptId, true, c.ts);
  }

  _onTurnStart(c) {
    this._unfinished = false;
    if (this.kind !== 'main') {
      this._subFinal = false;
      return;
    }
    if (c.isCompactSummary) {
      if (c.promptId) this._promptId = c.promptId; // R32 absorbed, no new turn
      return;
    }
    this._turnStart(c.promptId, false, c.ts);
  }

  // R30: a new promptId starts a turn; a reused one is the same turn.
  _turnStart(pid, reopen, ts) {
    if (this.kind !== 'main' || !pid) return;
    if (pid === this._promptId) {
      if (reopen && !this._turnOpen) {
        this._turnOpen = true;
        this._endTurnSeen = false;
      }
      return;
    }
    this._abandon(() => true, ts);
    if (this._turnOpen) this._emit(this._ev('turn_end', ts, { reason: 'next_turn' }));
    this._promptId = pid;
    this._turnOpen = true;
    this._endTurnSeen = false;
  }

  _turnEnd(reason, ts) {
    if (this.kind !== 'main' || !this._turnOpen) return;
    this._turnOpen = false;
    this._endTurnSeen = false;
    this._emit(this._ev('turn_end', ts, { reason }));
  }

  // R30/R31/R32
  _onSystem(c) {
    if (c.subtype === 'stop_hook_summary') this._turnEnd('stop_hook', c.ts);
    const fields = systemFields(c);
    if (fields) this._emit(this._ev('system', c.ts, fields));
  }

  _endSession(reason, ts) {
    if (this._ended) return;
    if (this._held.length) this._flushHeld(false);
    this._abandon(() => true, ts);
    this._emit(this._ev('session_end', ts, { reason }));
    this._ended = true;
    this._subFinal = false;
    this._unfinished = false;
  }

  // ------------------------------------------------------------------------------- plan

  _emitPlan(view, ts) {
    if (!view) return;
    // section 5: plan text is free text (model or user written), scrub and cap it like any other event text
    const items = view.items.map((it) => ({ content: cleanText(it.content, 80), status: it.status }));
    const ev = this._ev('plan', ts, { items, source: view.source });
    this._planEv = ev;
    this._emit(ev);
  }

  // ------------------------------------------------------------------------------- identity (4.3/4.4)

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

  // ------------------------------------------------------------------------------- events

  _ev(type, ts, fields) {
    return { type, sessionId: this.id, ts: ts || this._lastTs || iso(this._now()), ...fields };
  }

  _emit(ev) {
    if (!this._out) return;
    if (this._ended && ev.type !== 'session_end') return; // a finished subagent stays gone
    this._out.push(ev);
  }
}
