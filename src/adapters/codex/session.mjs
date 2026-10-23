// CodexSession: one Codex rollout file (ADAPTERS 5.1) -> UI events, through the shared SessionCore (CONTRACT 4.0.2).
// SessionLike (ADAPTERS 3.2): apply(rec, { replay }), idle(nowMs), setInfo(info), sessionEvent(), snapshotEvents(),
// title, firstCwd, lastActivityMs, ended. 기록 하나를 records.mjs / exec.mjs 로 풀어 정규화 항목으로 바꾸고, 그 사이에
// 필요한 상태(열린 호출 표, 열린 code-mode exec, 턴 id, 서브의 상속 문맥, ordinal dedupe)를 여기서 가진다. 리플레이와
// 라이브는 같은 코드 경로를 지난다. 파일 순서가 이긴다 (R12): 시각으로 정렬하거나 버리지 않는다.
//
// Mapping (ADAPTERS 6.1 / 6.2 Codex column):
//   session_meta (the file's own, line 0)   -> meta { cwd, branch (+ sub agentType, fallback title) }; cli_version picks
//                                             the say/thinking source; subagent_history_start_ordinal (H) the skip
//   event_msg task_started                  -> turn_start { id: turn_id } (a start without an end -> next_turn, core)
//   event_msg task_complete                 -> turn_end end_turn; with `error` -> system api_error + turn_end api_error
//   event_msg turn_aborted                  -> open tools interrupted + turn_end interrupt
//   item_completed UserMessage              -> prompt (core skips '<' text); role:user messages are never prompts
//   item_completed AgentMessage / Reasoning -> say / thinking, only when the file's text source is 'item'
//   response_item message(assistant) / reasoning -> say / thinking, only when the text source is 'response'
//   item_completed Plan                     -> plan { markdown } (exit_plan)
//   item_completed SubAgentActivity completed|interrupted -> sub_end for 'codex-<agent_thread_id>' (on attach: only when it
//                                             is the child's last lifecycle entry in this file, see below)
//   response_item function_call / custom_tool_call -> tool_start (records.mjs table; plumbing hidden; exec: exec.mjs)
//   response_item *_output (same call_id)    -> tool_end (exit codes, fixed denial / abort phrases)
//   inner item_completed while an exec is open -> a visit: tool_start + tool_end keyed by the item id (exec.mjs)
//   response_item web_search_call           -> a visit (start + end)
//   compacted                               -> system compact (response_item compaction, ContextCompaction ignored)
//   turn_context                            -> cwd only when session_meta had none; every other type is ignored
//
// Inherited context (subagent_history_start_ordinal H): records with ordinal < H copy the parent's context. While the
// attach replay runs they are applied provisionally (replay mode builds state only). The first record with ordinal >= H
// drops that state: a fresh core and normalizer, with the file's meta and setInfo re-applied. When the replay ends (the
// first idle() or live apply; the Runner calls idle() before it announces the file) and no record >= H came: a file
// older than 0.154 keeps the provisional state as its own (old migrated files set H to the file length, so skipping
// would leave nothing; research: every spawn file without records after H is older than 0.154); a 0.154+ file drops it
// (a fork child written in a burst at birth, attached before its first own record) and waits. Records < H that arrive
// later (live) are dropped.
//
// Child ends on attach (v2 multi-agent re-tasks a completed child, often without a new 'started'): while the attach
// replay runs, SubAgentActivity only records each child's last lifecycle kind (started, interacted, completed,
// interrupted). When the replay ends, the children whose last kind is completed / interrupted get their end hint (before
// the Runner announces anything, so a finished child still starts ended, F4). After that a live completed / interrupted
// ends the child at once; a later re-task is the Store's revive.
import { SessionCore } from '../../core/session-core.mjs';
import { isObj, itemId } from '../../core/session-items.mjs';
import { agentScopedId } from '../../session-identity.mjs';
import { firstLine } from '../../session-util.mjs';
import {
  CODEX_AGENT, parseRecord, sessionMetaOf, metaItemOf, textSource, versionAtLeast, userMessageText, assistantText,
  agentMessageText, reasoningSummary, reasoningItemSummary, itemDurationMs, childIdOf, callStartOf, webSearchCallOf, outputEndOf,
} from './records.mjs';
import { execStartOf, execEndOf, innerVisitOf, INNER_ITEM_TYPES } from './exec.mjs';

const MAX_TOOLS = 4096; // 열린 호출 표 상한
const SEEN_MAX = 65536; // 기억하는 ordinal 수 (그보다 오래된 것은 바닥값 아래로 본다)
const KIDS_MAX = 1000; // 붙일 때 기억하는 자식의 마지막 SubAgentActivity 종류 수
/** From this cli_version on, a sub whose replay has no record >= H waits for its own records (no inherited fallback). */
export const NO_FALLBACK_SINCE = Object.freeze([0, 154, 0]);
const LIFECYCLE = new Set(['started', 'interacted', 'completed', 'interrupted']);
const ENDS = new Set(['completed', 'interrupted']);

// The normalizer state that inherited records may have touched (dropped together with the core at a reset).
const freshNorm = () => ({ turnId: null, tools: new Map(), exec: new Set(), lounge: new Set(), cwd: false });
const pick = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);

export class CodexSession {
  /**
   * @param {{ id: string, agent?: string, kind?: 'main'|'sub', parentId?: string|null, agentType?: string|null,
   *   now?: () => number }} o  id: the D2 character id 'codex-<thread uuid>'. A session_meta line of another thread
   *   (inherited context) is ignored. The Runner's Claude-only options (file, stem, subMeta, journalLabel) are ignored.
   */
  constructor({ id, agent = CODEX_AGENT, kind = 'main', parentId = null, agentType = null, now = Date.now } = {}) {
    this.agent = typeof agent === 'string' && agent !== '' ? agent : CODEX_AGENT;
    this._opts = { id, agent: this.agent, kind, parentId, agentType, now };
    this.core = new SessionCore(this._opts);
    const prefix = `${this.agent}-`;
    this._threadId = typeof id === 'string' && id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
    this._skipped = 0; // 읽을 수 없는 기록
    this._coreSkipped = 0; // reset 으로 버린 core 의 skipped
    this._facts = null; // 이 파일의 session_meta 사실
    this._metaItem = null;
    this._source = 'response'; // say / thinking 을 읽는 쪽 (cli_version)
    this._info = {}; // setInfo 로 받은 값 (reset 뒤에 다시 넣는다)
    this._seen = new Set();
    this._seenFloor = -1;
    this._hist = 'none'; // 'none' | 'pending' | 'own' | 'fallback' | 'waiting'
    this._provisional = false; // pending 동안 H 앞 기록을 임시로 넣었다
    this._kids = new Map(); // replay 동안: 자식 charId -> 마지막 SubAgentActivity 종류 (끝 힌트는 _settle 이 정한다)
    this._settled = false; // 붙일 때의 replay 가 끝났다 (첫 idle() 이나 라이브 apply)
    this._dropped = 0;
    this._resets = 0;
    this._n = freshNorm();
  }

  // ------------------------------------------------------------------------------- SessionLike API

  /** One parsed rollout line -> events (and hint items). Replay builds the same state and returns only hints. */
  apply(rec, { replay = false } = {}) {
    const out = [];
    try {
      if (!replay) this._settle(out);
      const r = parseRecord(rec);
      if (!r) {
        this._skipped += 1;
        return out;
      }
      if (this._repeat(r.ordinal)) return out; // ordinal 이 dedupe 키다 (R9)
      if (r.type === 'session_meta') {
        this._sessionMeta(r, replay, out);
        return out;
      }
      const mode = this._history(r.ordinal);
      if (mode === 'drop') {
        this._dropped += 1;
        return out;
      }
      this._feed(this._items(r), replay || mode === 'provisional', out);
    } catch {
      this._skipped += 1;
    }
    return out;
  }

  idle(nowMs) {
    const out = [];
    this._settle(out);
    for (const ev of this.core.idle(nowMs)) out.push(ev);
    return out;
  }

  /** Late info: the Store ({ parentProject, parentId, agentType }) or the session_index sidecar ({ title }). */
  setInfo(info) {
    if (isObj(info)) this._info = { ...this._info, ...info };
    return this.core.setInfo(info);
  }

  sessionEvent() { return this.core.sessionEvent(); }
  snapshotEvents() { return this.core.snapshotEvents().map((ev) => this._patch(ev)); }
  get title() { return this.core.title; }
  get firstCwd() { return this.core.firstCwd; }
  get lastActivityMs() { return this.core.lastActivityMs; }
  get ended() { return this.core.ended; }
  get surface() { return this._facts?.surface ?? null; }
  get skipped() { return this._skipped + this._coreSkipped + this.core.skipped; }

  /** Plain copy of the core state plus the Codex normalizer state (tests, debugging). */
  debugState() {
    return {
      ...this.core.debugState(),
      codex: {
        source: this._source, cliVersion: this._facts?.cliVersion ?? null, historyStart: this._facts?.historyStart ?? null,
        hist: this._hist, settled: this._settled, provisional: this._provisional, resets: this._resets,
        dropped: this._dropped, skipped: this._skipped, turnId: this._n.turnId, tools: [...this._n.tools.keys()],
        exec: [...this._n.exec],
      },
    };
  }

  // ------------------------------------------------------------------------------- plumbing

  // Hints (sub_end, the only kind) before the replay ends are left out: _settle gives them from each child's last kind.
  _feed(items, replay, out) {
    for (const it of items) {
      for (const ev of this.core.apply(it, { replay })) {
        if (ev.hint === undefined) out.push(this._patch(ev));
        else if (this._settled) out.push(ev);
      }
    }
  }

  // clock.sleep: the core has no lounge kind, so its tool_start gets the lounge room hint here (ADAPTERS 6.2)
  _patch(ev) {
    return ev.type === 'tool_start' && this._n.lounge.has(ev.toolUseId) ? { ...ev, room: 'lounge' } : ev;
  }

  // 한 줄에 O(1): 하나씩 지우는 FIFO 는 Set 앞쪽의 지운 칸을 매번 다시 지나가므로, 2 * SEEN_MAX 를 넘을 때 한 번에 새로
  // 만든다 (가장 새 SEEN_MAX 개를 넣은 순서대로 남기고, 버린 값 중 가장 큰 것까지 바닥값을 올린다)
  _repeat(ord) {
    if (ord === null) return false; // legacy 파일에는 ordinal 이 없다
    if (ord <= this._seenFloor || this._seen.has(ord)) return true;
    this._seen.add(ord);
    if (this._seen.size > 2 * SEEN_MAX) {
      const all = [...this._seen];
      const cut = all.length - SEEN_MAX;
      for (let i = 0; i < cut; i++) if (all[i] > this._seenFloor) this._seenFloor = all[i];
      this._seen = new Set(all.slice(cut));
    }
    return false;
  }

  // The file's own session_meta (line 0; a rollback segment starts with one at a higher ordinal). Another thread's copy
  // inside inherited context, or a repeat, changes nothing.
  _sessionMeta(r, replay, out) {
    if (this._facts) return;
    const f = sessionMetaOf(r.payload);
    if (this._threadId !== null && f.id !== this._threadId) return;
    this._facts = f;
    this._source = textSource(f.cliVersion);
    const h = f.historyStart;
    if (h !== null && h > (r.ordinal ?? 0) + 1) this._hist = this._settled ? 'waiting' : 'pending';
    const item = metaItemOf(f, this.core.kind === 'sub');
    this._metaItem = r.ms === null ? item : { ...item, ts: r.ms };
    this._n.cwd = Boolean(f.cwd);
    this._feed([this._metaItem], replay, out);
  }

  // 'apply' | 'provisional' (inherited, while the attach replay runs) | 'drop' (inherited, after it)
  _history(ord) {
    if (this._hist === 'none' || this._hist === 'fallback' || ord === null) return 'apply';
    if (ord >= this._facts.historyStart) {
      if (this._hist === 'pending' && this._provisional) this._reset();
      this._hist = 'own';
      return 'apply';
    }
    if (this._hist === 'pending') {
      this._provisional = true;
      return 'provisional';
    }
    return 'drop';
  }

  // End of the attach replay. Nothing >= H came: a file older than 0.154 keeps the provisional (inherited-looking)
  // records as its own (the fallback of ADAPTERS 5.1); a newer one drops them and waits (later records < H are dropped).
  // Then the end hints of the children whose last lifecycle kind in this file is completed / interrupted.
  _settle(out) {
    if (this._settled) return;
    this._settled = true;
    if (this._hist === 'pending') {
      if (this._provisional && !versionAtLeast(this._facts?.cliVersion, NO_FALLBACK_SINCE)) {
        this._hist = 'fallback';
      } else {
        if (this._provisional) this._reset(); // 상태만 만들었고 아무것도 내보내지 않았다
        this._hist = 'waiting';
      }
    }
    for (const [charId, kind] of this._kids) if (ENDS.has(kind)) out.push({ hint: 'end', charId, reason: 'done' });
    this._kids.clear();
  }

  // SubAgentActivity while the attach replay runs: the child's last kind (the core's sub_end id rule applies).
  _lifecycle(childId, kind) {
    if (!agentScopedId(this.agent, childId) || childId === this._opts.id) return;
    this._kids.delete(childId);
    if (this._kids.size >= KIDS_MAX) this._kids.delete(this._kids.keys().next().value);
    this._kids.set(childId, kind);
  }

  // Drop the state built from inherited records (only ever during the attach replay, so no event was sent from it).
  _reset() {
    this._coreSkipped += this.core.skipped;
    this.core = new SessionCore(this._opts);
    this._n = freshNorm();
    this._provisional = false;
    this._kids.clear(); // 물려받은 SubAgentActivity 는 부모의 것이다
    this._resets += 1;
    if (this._metaItem) {
      this.core.apply(this._metaItem, { replay: true });
      this._n.cwd = Boolean(this._metaItem.cwd);
    }
    if (Object.keys(this._info).length) this.core.setInfo(this._info);
  }

  // ------------------------------------------------------------------------------- record -> items

  _items(r) {
    const out = [];
    const push = (item) => { out.push(r.ms === null ? item : { ...item, ts: r.ms }); };
    let h = null;
    if (r.type === 'event_msg') h = pick(EVENTS, r.sub);
    else if (r.type === 'response_item') h = pick(RESPONSES, r.sub);
    else h = pick(RECORDS, r.type);
    if (h) h.call(this, r, push);
    return out; // 모르는 종류는 무시한다 (token_count, world_state, token_usage_record, agent_message, ...)
  }

  _stale(turnId) {
    const t = itemId(turnId);
    return t !== null && this._n.turnId !== null && t !== this._n.turnId; // 지난 턴의 늦은 끝
  }

  // The core closes calls still open at a turn boundary (abandoned / interrupted); the normalizer forgets them too.
  _clearTools() {
    this._n.tools.clear();
    this._n.exec.clear();
    this._n.lounge.clear();
  }

  _track(id, info) {
    this._n.tools.set(id, info);
    if (info.exec) this._n.exec.add(id);
    if (this._n.tools.size > MAX_TOOLS) {
      const old = this._n.tools.keys().next().value;
      this._n.tools.delete(old);
      this._n.exec.delete(old);
      this._n.lounge.delete(old);
    }
  }

  _say(text, phase, push) {
    if (text === null) return;
    // phase final_answer 는 그 턴의 마지막 답이다: task_complete 가 오지 않으면 20 초 뒤 end_turn (core)
    push(phase === 'final_answer' ? { k: 'say', text, final: true } : { k: 'say', text });
  }

  _call(r, push, kind) {
    const p = r.payload;
    const id = itemId(p.call_id);
    if (id === null) {
      this._skipped += 1;
      return;
    }
    if (this._n.tools.has(id)) return; // 같은 call_id 가 다시 왔다 (R9)
    const c = callStartOf(p, kind);
    if (c.hidden) return; // write_stdin, wait, ... (배관): 출력도 무시된다
    if (c.exec) {
      push({ k: 'tool_start', id, ...execStartOf(c.script) });
      this._track(id, { exec: true, name: 'exec' });
      return;
    }
    push({ k: 'tool_start', id, ...c.start });
    this._track(id, { exec: false, name: c.name });
    if (c.lounge) this._n.lounge.add(id);
  }

  _output(r, push) {
    const p = r.payload;
    const id = itemId(p.call_id);
    const t = id === null ? undefined : this._n.tools.get(id);
    if (!t) return; // 모르는 call_id, 숨긴 호출, 이미 닫힌 호출
    this._n.tools.delete(id);
    this._n.exec.delete(id);
    this._n.lounge.delete(id);
    push({ k: 'tool_end', id, ...(t.exec ? execEndOf(p.output) : outputEndOf(p.output, t.name)) });
  }

  _visit(v, push) {
    if (!v) return;
    push({ k: 'tool_start', id: v.id, ...v.start });
    push({ k: 'tool_end', id: v.id, ...v.end });
  }

  _item(r, push) {
    const p = r.payload;
    const it = p.item;
    if (!isObj(it) || typeof it.type !== 'string') {
      this._skipped += 1;
      return;
    }
    switch (it.type) {
      case 'UserMessage': {
        const text = userMessageText(it);
        if (text !== null) push({ k: 'prompt', text }); // '<' 로 시작하는 글 (heartbeat, 주입 문맥) 은 core 가 건너뛴다
        return;
      }
      case 'AgentMessage':
        if (this._source === 'item') this._say(agentMessageText(it), it.phase, push);
        return;
      case 'Reasoning':
        if (this._source === 'item') push({ k: 'thinking', text: reasoningItemSummary(it), durationMs: itemDurationMs(p) });
        return;
      case 'Plan':
        if (typeof it.text === 'string') push({ k: 'plan', markdown: it.text }); // 계획 모드 제안 (exit_plan)
        return;
      case 'SubAgentActivity': {
        if (!LIFECYCLE.has(it.kind)) return;
        const childId = childIdOf(it.agent_thread_id, this.agent);
        if (!childId) {
          if (ENDS.has(it.kind)) this._skipped += 1;
          return;
        }
        if (!this._settled) this._lifecycle(childId, it.kind); // 붙일 때: 마지막 종류가 정한다 (_settle)
        if (ENDS.has(it.kind)) push({ k: 'sub_end', childId, reason: 'done' }); // 힌트는 replay 가 끝난 뒤에만 나간다 (_feed)
        return;
      }
      default:
        // code-mode 안쪽 일: 열린 exec 가 있을 때만 (그 전 버전의 CommandExecution 은 exec_command 호출과 겹친다)
        if (this._n.exec.size > 0 && INNER_ITEM_TYPES.has(it.type)) this._visit(innerVisitOf(it), push);
    }
  }
}

// event_msg payload.type -> handler (this = CodexSession). token_count, thread_settings_applied, thread_goal_updated,
// legacy user_message / agent_message and unknown types yield nothing.
const EVENTS = {
  task_started(r, push) {
    const tid = itemId(r.payload.turn_id);
    // 끝 없이 다음 턴: 열린 호출은 core 가 abandoned 로 닫는다 (next_turn). 같은 턴 id 는 같은 턴이라 core 도 닫지 않는다
    if (tid === null || tid !== this._n.turnId) this._clearTools();
    this._n.turnId = tid;
    push(tid === null ? { k: 'turn_start' } : { k: 'turn_start', id: tid });
  },
  task_complete(r, push) {
    const p = r.payload;
    if (this._stale(p.turn_id)) return;
    const err = isObj(p.error) ? p.error : null;
    if (err) push({ k: 'system', kind: 'api_error', text: firstLine(typeof err.message === 'string' ? err.message : '') || 'API error' });
    push({ k: 'turn_end', reason: err ? 'api_error' : 'end_turn' });
    this._clearTools();
  },
  turn_aborted(r, push) {
    if (this._stale(r.payload.turn_id)) return;
    for (const id of this._n.tools.keys()) push({ k: 'tool_end', id, status: 'interrupted' });
    push({ k: 'turn_end', reason: 'interrupt' });
    this._clearTools();
  },
  item_completed(r, push) { this._item(r, push); },
};

// response_item payload.type -> handler. agent_message (a task between agents), compaction, tool_search_*,
// additional_tools, image_generation_call and unknown types yield nothing.
const RESPONSES = {
  message(r, push) {
    if (this._source === 'response') this._say(assistantText(r.payload), r.payload.phase, push);
  },
  reasoning(r, push) {
    if (this._source === 'response') push({ k: 'thinking', text: reasoningSummary(r.payload), durationMs: null });
  },
  function_call(r, push) { this._call(r, push, 'function'); },
  custom_tool_call(r, push) { this._call(r, push, 'custom'); },
  function_call_output(r, push) { this._output(r, push); },
  custom_tool_call_output(r, push) { this._output(r, push); },
  web_search_call(r, push) {
    const id = itemId(r.payload.id) ?? (r.ordinal !== null ? `ws-${r.ordinal}` : null);
    if (id === null) return;
    const v = webSearchCallOf(r.payload);
    this._visit({ id, start: { tool: 'web_search', desc: v.desc }, end: v.end }, push);
  },
};

// Top-level record types other than event_msg / response_item / session_meta.
const RECORDS = {
  compacted(r, push) { push({ k: 'system', kind: 'compact' }); }, // message (요약 글) 는 읽지 않는다
  turn_context(r, push) {
    const cwd = r.payload.cwd;
    if (this._n.cwd || typeof cwd !== 'string' || !cwd.startsWith('/')) return;
    this._n.cwd = true;
    push({ k: 'meta', cwd });
  },
};
