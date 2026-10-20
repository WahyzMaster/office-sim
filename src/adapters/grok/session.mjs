// GrokSession: one Grok Build updates.jsonl (ADAPTERS 5.2) -> UI events, through the shared SessionCore (CONTRACT 4.0.2).
// SessionLike (ADAPTERS 3.2): apply(rec, { replay }), idle(nowMs), setInfo(info), sessionEvent(), snapshotEvents(),
// title, firstCwd, lastActivityMs, ended. 기록 하나를 records.mjs 로 풀어 정규화 항목으로 바꾸고, 그 사이에 필요한
// 상태(턴 id, 열린 도구 표, 지난 턴 id)를 여기서 가진다. chunk 하나가 항목 하나다(이어 붙이지 않는다).
// 리플레이와 라이브는 같은 코드 경로를 지난다.
//
// Turns (research "Turn boundaries"): user_message_chunk has no promptId; the turn's id shows on hook_execution
// (user_prompt_submit) and on every model/tool record. Both orders occur: the hook BEFORE the message (the real logs,
// 1214/1238 turns, and every subagent file starts with it) or after it. A new promptId opens the turn (`turn_start { id }`)
// and user messages that follow before any work belong to it; a user message with no fresh turn sends `turn_start` right
// away (before its prompt, CONTRACT 4.0.2 order rule) and the next new promptId is adopted as that turn's id. A new
// promptId without a user message is a new turn (prompt_id change -> turn_start). turn_completed closes the turn by
// prompt_id. When a message opened a turn while the previous one was still running and that previous turn's records go
// on (no new id came), the open turn adopts the previous id instead of dropping its work as late.
// Records of a turn that already ended (research: 7 late updates) and of older turns never reopen a turn.
import { SessionCore } from '../../core/session-core.mjs';
import { itemId } from '../../core/session-items.mjs';
import {
  GROK_AGENT, TERMINAL_STATUSES, parseRecord, contentText, userMessageOf, toolNameOf, xaiKindOf, toolStartOf, toolEndOf,
  planItemsOf, turnReasonOf, retrySystem, childIdOf,
} from './records.mjs';

const MAX_SEEN = 4096; // 기억하는 지난 턴 id 수 (오래된 것부터 잊는다)
const MAX_TOOLS = 4096; // 열린 도구 표 상한

export class GrokSession {
  /**
   * @param {{ id: string, agent?: string, kind?: 'main'|'sub', parentId?: string|null, agentType?: string|null,
   *   now?: () => number }} o  id: the D2 character id 'grok-<session folder uuid>'. Records whose params.sessionId is
   *   not that uuid are skipped (R10 analog). The Runner's Claude-only options (file, stem, subMeta, journalLabel) are
   *   accepted and ignored.
   */
  constructor({ id, agent = GROK_AGENT, kind = 'main', parentId = null, agentType = null, now = Date.now } = {}) {
    this.agent = typeof agent === 'string' && agent !== '' ? agent : GROK_AGENT;
    this.core = new SessionCore({ id, agent: this.agent, kind, parentId, agentType, now });
    const prefix = `${this.agent}-`;
    this._sessionUuid = typeof id === 'string' && id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
    this._skipped = 0; // 읽을 수 없는 기록 (Grok 기록이 아니거나 모양이 틀림)
    this._late = 0; // 끝난 턴이나 지난 턴의 늦은 기록 (버림)
    this._turnId = null; // 지금 턴의 promptId (사람 입력으로 연 턴은 다음 새 id 를 받을 때까지 null)
    this._turnOpen = false;
    this._awaiting = false; // 사람 입력이 턴을 열었고 그 턴의 id 를 아직 모른다
    this._started = false; // 턴이 한 번이라도 열렸다
    this._fresh = false; // 열린 턴에 일(생각, 말, 도구)이 아직 없다: 사람 입력은 그 턴의 것 (훅이 메시지보다 먼저 온 턴)
    this._prevOpen = null; // 메시지가 새 턴을 열 때 끝나지 않고 닫힌 앞 턴의 id (그 턴의 기록이 이어지면 다시 받는다)
    this._apiError = false; // 이 턴에 system api_error 를 이미 냈다
    this._seen = new Set(); // 지난 턴 id
    this._tools = new Map(); // toolCallId -> { name, promptId, plan }: 열린 (보이는) 도구
  }

  // ------------------------------------------------------------------------------- SessionLike API

  /** One parsed updates.jsonl record -> events (and hint items). Replay builds the same state, returns only hints. */
  apply(rec, { replay = false } = {}) {
    let items;
    try {
      items = this._items(rec);
    } catch {
      this._skipped += 1;
      return [];
    }
    const out = [];
    for (const it of items) for (const ev of this.core.apply(it, { replay })) out.push(ev);
    return out;
  }

  idle(nowMs) { return this.core.idle(nowMs); }
  /** Late info: the Store ({ parentProject, parentId, agentType }) or the summary.json sidecar ({ title, cwd, branch }). */
  setInfo(info) { return this.core.setInfo(info); }
  sessionEvent() { return this.core.sessionEvent(); }
  snapshotEvents() { return this.core.snapshotEvents(); }
  get title() { return this.core.title; }
  get firstCwd() { return this.core.firstCwd; }
  get lastActivityMs() { return this.core.lastActivityMs; }
  get ended() { return this.core.ended; }
  get skipped() { return this._skipped + this.core.skipped; }

  /** Plain copy of the core state plus the Grok normalizer state (tests, debugging). */
  debugState() {
    return {
      ...this.core.debugState(),
      grok: {
        turnId: this._turnId, turnOpen: this._turnOpen, awaiting: this._awaiting, fresh: this._fresh, started: this._started,
        tools: [...this._tools.keys()], seen: this._seen.size, late: this._late, skipped: this._skipped,
      },
    };
  }

  // ------------------------------------------------------------------------------- record -> items

  _items(rec) {
    const r = parseRecord(rec);
    if (!r) {
      this._skipped += 1;
      return [];
    }
    if (this._sessionUuid !== null && r.sessionId !== null && r.sessionId !== this._sessionUuid) return [];
    const out = [];
    const push = (item) => { out.push(r.ms === null ? item : { ...item, ts: r.ms }); };
    if (Object.hasOwn(RECORDS, r.kind)) RECORDS[r.kind].call(this, r, push);
    return out; // 모르는 종류는 무시한다 (바이너리에는 조사에서 못 본 종류가 더 있다)
  }

  // A record of the turn `pid` (null: no id on the record). Adopts a new id, or opens a turn for it; false = late
  // (the turn already ended, or an older turn): such work is dropped so it never reopens a turn.
  _enter(pid, push) {
    if (pid === null) return !(this._started && !this._turnOpen);
    if (pid === this._turnId) return this._turnOpen;
    if (this._seen.has(pid)) {
      if (!this._awaiting || pid !== this._prevOpen) return false;
      this._turnId = pid; // 메시지가 연 턴이 아니라 앞 턴이 이어진다: 그 id 를 받는다 (일을 늦은 기록으로 버리지 않는다)
      this._awaiting = false;
      this._prevOpen = null;
      return true;
    }
    this._remember(pid);
    if (this._awaiting) {
      this._turnId = pid;
      this._awaiting = false;
      return true;
    }
    this._openTurn(push, pid);
    return true;
  }

  _openTurn(push, id = null) {
    this._prevOpen = id === null && this._turnOpen ? this._turnId : null;
    push(id === null ? { k: 'turn_start' } : { k: 'turn_start', id }); // SessionCore 가 앞 턴을 next_turn 으로 닫는다
    this._turnId = id;
    this._turnOpen = true;
    this._awaiting = id === null;
    this._fresh = true;
    this._started = true;
    this._apiError = false;
    this._tools.clear(); // 결과 없는 도구는 SessionCore 가 abandoned 로 닫았다
  }

  _remember(pid) {
    this._seen.add(pid);
    if (this._seen.size > MAX_SEEN) this._seen.delete(this._seen.values().next().value);
  }

  _dropLate() {
    this._late += 1;
  }

  // user_message_chunk: a prompt only when not hidden/synthetic. A message opens a turn unless it belongs to the open one
  // (a turn with no work yet, e.g. one its user_prompt_submit hook just opened, an interjection or a message without
  // promptIndex typed mid-turn, a second message before the turn's id is known, or a hidden injection mid-turn).
  _user(r, push) {
    const u = userMessageOf(r.update);
    const sameTurn = this._turnOpen && (this._fresh || u.interjection || !u.indexed || this._awaiting || u.hidden);
    if (!sameTurn) this._openTurn(push);
    if (!u.hidden && u.text !== null) push({ k: 'prompt', text: u.text });
  }

  // agent_message_chunk / agent_thought_chunk. Research: each line is a whole segment (a thought is a whole
  // reasoning-summary segment), not a token delta, so one record is one say / thinking item and is never joined to the
  // one before it (each is scrubbed on its own, CONTRACT 5). A say is never `final`: Grok ends every turn with
  // turn_completed (1234/1234), so the 20 s end_turn idle fallback would only end a working turn early.
  _chunk(r, push, k) {
    this._fresh = false;
    const text = contentText(r.update.content);
    if (text === null) {
      this._skipped += 1;
      return;
    }
    push(k === 'say' ? { k: 'say', text } : { k: 'thinking', text, durationMs: null });
  }

  _toolCall(r, push) {
    this._fresh = false;
    const u = r.update;
    const id = itemId(u.toolCallId);
    if (id === null) {
      this._skipped += 1;
      return;
    }
    if (this._tools.has(id)) {
      this._toolUpdate(r, push); // 같은 id 의 tool_call 이 다시 왔다: 상태만 본다 (R9)
      return;
    }
    const name = toolNameOf(u);
    const start = toolStartOf(name, u.rawInput, xaiKindOf(u));
    if (start.hidden) return; // todo_write (plan 기록이 판을 바꾼다), enter_plan_mode, search_tool
    const { markdown, ...fields } = start;
    if (markdown) push({ k: 'plan', markdown }); // R34: 질문을 기다리는 동안 보일 계획 제안은 질문보다 먼저
    push({ k: 'tool_start', id, ...fields });
    this._tools.set(id, { name, promptId: r.promptId ?? this._turnId, plan: markdown ?? null });
    if (this._tools.size > MAX_TOOLS) this._tools.delete(this._tools.keys().next().value);
    if (TERMINAL_STATUSES.has(u.status)) this._toolUpdate(r, push);
  }

  // tool_call_update: only a terminal status ends the tool (the first update repeats rawInput, title and locations).
  _toolUpdate(r, push) {
    const u = r.update;
    const id = itemId(u.toolCallId);
    if (id === null) {
      this._skipped += 1;
      return;
    }
    const t = this._tools.get(id);
    const end = t ? toolEndOf(t.name, u) : null;
    if (!end) return; // 모르는 id, 숨긴 도구, 이미 닫힌 도구 (늦은 갱신), 아직 끝나지 않음
    this._tools.delete(id);
    if (end.markdown && end.markdown !== t.plan) push({ k: 'plan', markdown: end.markdown }); // 승인된 계획
    const item = { k: 'tool_end', id, status: end.status };
    if (end.errorLine) item.errorLine = end.errorLine;
    if (end.background) item.background = true;
    push(item);
  }

  // subagent_spawned: the child is launched, so its spawn_subagent call ends ok now (async launch, R28). The oldest open
  // spawn of the same turn (parent_prompt_id); the spawn's own completion may come before or after (research 10/62).
  _spawned(r, push) {
    const pp = typeof r.update.parent_prompt_id === 'string' ? r.update.parent_prompt_id : null;
    for (const [id, t] of this._tools) {
      if (t.name !== 'spawn_subagent' || (pp !== null && t.promptId !== null && t.promptId !== pp)) continue;
      this._tools.delete(id);
      push({ k: 'tool_end', id, status: 'ok' });
      return;
    }
  }

  // turn_completed { prompt_id, stop_reason }: end_turn -> end_turn, cancelled -> open tools interrupted + interrupt,
  // error -> api_error (with a system api_error unless this turn already had one). Only for the current turn.
  _turnCompleted(r, push) {
    const u = r.update;
    const pid = typeof u.prompt_id === 'string' ? itemId(u.prompt_id) : null;
    if (pid !== null && pid !== this._turnId) {
      if (pid === this._prevOpen) this._prevOpen = null; // 메시지가 새 턴을 연 뒤 앞 턴이 정말 끝났다: 다시 받지 않는다
      if (this._seen.has(pid) || !this._awaiting) return; // 지난 턴이거나 지금 턴이 아닌 끝
      this._remember(pid);
      this._turnId = pid; // 일 기록 없이 끝난 턴: 사람 입력으로 연 턴의 id
      this._awaiting = false;
    }
    if (!this._turnOpen) return;
    const reason = turnReasonOf(u.stop_reason);
    if (reason === 'interrupt') for (const id of this._tools.keys()) push({ k: 'tool_end', id, status: 'interrupted' });
    if (reason === 'api_error' && !this._apiError) push({ k: 'system', kind: 'api_error', text: 'API error' });
    push({ k: 'turn_end', reason });
    this._tools.clear();
    this._turnOpen = false;
    this._awaiting = false;
    this._prevOpen = null;
  }
}

// sessionUpdate -> handler (this = GrokSession). Every other kind (hook_execution without a prompt_id, current_mode_update,
// session_recap, task_*, background_tasks, compaction_*, auto_compact_completed/failed, memory_*, rewind_marker, unknown
// kinds) yields nothing.
const RECORDS = {
  user_message_chunk(r, push) { this._user(r, push); },
  agent_message_chunk(r, push) {
    if (this._enter(r.promptId, push)) this._chunk(r, push, 'say');
    else this._dropLate();
  },
  agent_thought_chunk(r, push) {
    if (this._enter(r.promptId, push)) this._chunk(r, push, 'thinking');
    else this._dropLate();
  },
  tool_call(r, push) {
    if (this._enter(r.promptId, push)) this._toolCall(r, push);
    else this._dropLate();
  },
  tool_call_update(r, push) { this._toolUpdate(r, push); },
  plan(r, push) {
    this._enter(r.promptId, push); // 턴 경계만 (늦은 계획도 판에는 쓴다)
    const items = planItemsOf(r.update);
    if (items) push({ k: 'plan', items, source: 'update_plan' }); // 늘 전체 목록 (D5)
    else this._skipped += 1;
  },
  hook_execution(r, push) {
    // user_prompt_submit: 새 턴을 열거나 (메시지보다 먼저 온 훅) 사람 입력으로 연 턴의 id 를 알려 준다
    if (r.promptId !== null) this._enter(r.promptId, push);
  },
  turn_completed(r, push) { this._turnCompleted(r, push); },
  subagent_spawned(r, push) { this._spawned(r, push); },
  subagent_finished(r, push) {
    // 자식의 끝은 부모 파일에 적힌다: Store.endCharacter 로 가는 힌트 (CONTRACT 4.0.1). cancelled 도 done
    const childId = childIdOf(r.update, this.agent);
    if (childId) push({ k: 'sub_end', childId, reason: 'done' });
    else this._skipped += 1;
  },
  auto_compact_started(r, push) { push({ k: 'system', kind: 'compact' }); },
  retry_state(r, push) {
    const s = retrySystem(r.update);
    if (!s) return;
    push({ k: 'system', ...s });
    this._apiError = true;
  },
};
