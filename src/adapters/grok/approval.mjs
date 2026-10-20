// Grok 승인 대기 짝짓기 (P5g, ADAPTERS 5.2, CONTRACT 4.6). events.jsonl 의 권한 요청(events.mjs 의 사실, tool_started 순번
// e)을 updates.jsonl 의 도구 호출(x.ai/tool 이 있는 새 toolCallId 를 센 순번 u, 둘 다 1 부터)과 짝지어 SessionCore 의
// { k: 'tool_wait', id, waiting, ts } 항목으로 바꾼다. 순수 모듈이다 (I/O 도, 시계도 없다: 시각은 사실의 seenAt 뿐).
//
// 짝짓기 (권한 기록에는 호출 id 가 없다):
// 1. u = e + offset (offset 은 0 에서 시작).
// 2. 그 호출의 이름이 같고 agentTimestampMs 가 tool_started ts 와 PAIR_MS 안이면 짝이다.
// 3. 아니면 다시 맞춘다: 열린 보이는 호출 중 이름이 같고, PAIR_MS 안이고, tool_call_update 가 아직 없고, 마지막 짝보다
//    뒤인 것이 꼭 하나일 때만 그것과 짝짓고 offset = u' - e. 둘 이상이거나 없으면 조용히 둔다 (misses).
// 4. u 를 아직 세지 않았으면 (호출 줄이 요청보다 늦게 적혔다) 요청을 들고 있다가 새 호출마다 다시 본다. 다음 읽기에도 열린
//    채 그 호출이 없으면 3 의 후보를 센 호출 중에서 찾는다 (tool_call 줄 하나를 세지 못해 순번이 앞섰다). 없으면 계속 든다.
// 요청 하나(e)는 한 번만 정한다 (처음 열린 채로 본 때). 잘못 짝짓느니 보이지 않는 쪽을 고른다.
//
// 보이기: 짝지은 요청이 어느 읽기(seenAt)에서 APPROVAL_SHOW_MS 이상 열려 있으면 waiting:true (ts = 요청 ts), 허용(또는 모르는
// 결정)으로 닫히면 waiting:false (ts = 결정 ts). 시각이 없거나 읽은 시각보다 AHEAD_MS 넘게 앞서면 처음 열린 채로 본 읽기
// 시각을 쓴다. 거절과 사라짐(턴 경계, 상한)은 아무것도 보내지 않는다: tool_end denied / interrupted / abandoned 가 닫는다.
// 대상은 열린, 보이는, ask 가 아닌 도구뿐이다 (SessionCore 도 다시 본다).
// 따라잡은 읽기(caughtUp)는 열린 요청을 모두 담는다: 거기 없는 보인 요청은 그 닫힘을 받지 못한 것이라 (꼬리를 다시 만들었다:
// 같은 inode 옮김, events.jsonl 교체) 모르는 결정처럼 waiting:false 로 닫는다. reset 은 순번을 무효로 하지만 보인 호출은
// 기억해 둔다 (unseen): 아직 열린 요청이 같은 호출과 다시 짝지어지면 그대로 보인 것이고, 아니면 다음 따라잡은 읽기에서 닫는다.
import { isObj, itemId } from '../../core/session-items.mjs';
import { toolNameOf } from './records.mjs';

/** A paired request shows once a read finds it open this long after its request time. */
export const APPROVAL_SHOW_MS = 1000;
/** |agentTimestampMs - tool_started ts| at most this for a pair (verification and resync). */
export const PAIR_MS = 50;
/** A request or resolution ts more than this past the read sample is not used (the sample time is). */
export const AHEAD_MS = 5000;
/** Counted calls remembered (u -> call), the oldest dropped first. */
export const MAX_CALLS = 1024;
/** Counted toolCallIds and decided ordinals remembered (repeat check, decide-once latch). */
export const MAX_IDS = 4096;
/** Requests held for a call not counted yet. */
export const MAX_HELD = 64;

const STATES = new Set(['open', 'allow', 'deny', 'gone']);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const near = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= PAIR_MS;
const msOrNull = (v) => (finite(v) ? v : null);

// 크기 상한이 있는 Set: 넘치면 가장 오래된 것부터 버린다
function capAdd(set, v, max) {
  set.add(v);
  if (set.size > max) set.delete(set.values().next().value);
}

// 쓸 수 있는 시각: 있고, 0 보다 크고, 읽은 시각보다 AHEAD_MS 넘게 앞서지 않는다. 아니면 대안.
const tsOr = (ms, seenAt, fallback) => (finite(ms) && ms > 0 && ms <= seenAt + AHEAD_MS ? ms : fallback);

// events.mjs 의 사실 하나 -> 쓰는 필드만, 모양이 틀리면 null
function factOf(f) {
  if (!isObj(f) || !Number.isInteger(f.e) || f.e < 1 || !STATES.has(f.state)) return null;
  return {
    e: f.e, state: f.state, name: typeof f.name === 'string' && f.name !== '' ? f.name : null,
    startMs: msOrNull(f.startMs), reqMs: msOrNull(f.reqMs), resMs: msOrNull(f.resMs),
  };
}

export class ApprovalPairing {
  /**
   * @param {{ toolOf?: (id: string) => ({ ask?: boolean } | null | undefined) }} [o]  the open, visible tool of a call id
   *   (GrokSession's open-tool table): an entry means open and visible, `ask` marks ask_user_question / exit_plan_mode.
   */
  constructor({ toolOf = () => null } = {}) {
    this.toolOf = toolOf;
    this.count = 0; // 센 호출 수 (마지막 u)
    this.calls = new Map(); // u -> { u, id, name, ms, updated } (최근 MAX_CALLS)
    this.byId = new Map(); // id -> 같은 호출 (calls 에 있는 것만)
    this.ids = new Set(); // 센 toolCallId (같은 id 가 다시 와도 세지 않는다)
    this.offset = 0;
    this.lastU = 0; // 마지막으로 짝지은 u
    this.decided = new Set(); // 정한 e (짝이든 아니든 다시 정하지 않는다)
    this.held = new Map(); // e -> 요청 (그 u 를 아직 세지 않았다)
    this.pending = new Map(); // e -> { e, id, at } 짝지었고 아직 보일 때가 아니다
    this.shown = new Map(); // e -> id: waiting:true 를 보냈다
    this.unseen = new Set(); // reset 전에 보인 호출 id (다시 짝지어지지 않으면 다음 따라잡은 읽기에서 닫는다)
    this.queue = []; // onCall 이 만든 항목 (apply() 가 take() 로 가져간다)
    this.stats = { calls: 0, paired: 0, resyncs: 0, misses: 0, held: 0, dropped: 0, shown: 0, cleared: 0, settled: 0, resets: 0 };
  }

  /**
   * One tool_call record of this session (before the turn check, so hidden and late calls count too). Counts it when
   * it carries `_meta['x.ai/tool']` and a toolCallId not counted before (the web_search fallback has no x.ai/tool).
   * Returns whether it was counted.
   */
  noteCall(update, meta) {
    const xai = isObj(update) && isObj(update._meta) ? update._meta['x.ai/tool'] : null;
    if (!isObj(xai)) return false;
    const id = itemId(update.toolCallId);
    if (id === null || this.ids.has(id)) return false;
    capAdd(this.ids, id, MAX_IDS);
    this.count += 1;
    this.stats.calls += 1;
    // 이름은 events.mjs 와 같은 규칙 (records.mjs 의 trim 과 TOOL_NAME_RE), rawInput 없이: web_search 대안은 끼지 않는다
    const call = { u: this.count, id, name: toolNameOf({ _meta: { 'x.ai/tool': xai } }), ms: msOrNull(meta?.agentTimestampMs), updated: false };
    this.calls.set(call.u, call);
    this.byId.set(id, call);
    if (this.calls.size > MAX_CALLS) {
      const [old] = this.calls.values();
      this.calls.delete(old.u);
      if (this.byId.get(old.id) === old) this.byId.delete(old.id);
    }
    return true;
  }

  /** A tool_call_update reached an open call: it no longer counts as a resync candidate. */
  markUpdated(id) {
    const c = this.byId.get(id);
    if (c) c.updated = true;
  }

  /** After a counted call's tool_start: decides the held requests whose call is now counted (items -> take()). */
  onCall() {
    if (!this.held.size) return;
    for (const h of [...this.held.values()].sort((a, b) => a.e - b.e)) {
      if (h.e + this.offset > this.count) continue;
      this.held.delete(h.e);
      const call = this._pair(h);
      if (call) this._paired(h, call, h.lastSeen, this.queue);
    }
  }

  /**
   * One GrokMeta result { facts, seenAt, reset, caughtUp } -> tool_wait items. reset voids the ordinals first. A
   * caught-up result lists every open request: a shown, held or pending one it does not list has closed (settle). A
   * malformed result (no finite seenAt) is no information.
   */
  onFact(approval) {
    const out = [];
    if (!isObj(approval) || !finite(approval.seenAt)) return out;
    if (approval.reset === true) this._reset();
    if (!Array.isArray(approval.facts)) return out;
    const open = new Set();
    for (const raw of approval.facts) {
      const f = factOf(raw);
      if (!f) continue;
      if (f.state === 'open') {
        open.add(f.e);
        this._onOpen(f, approval.seenAt, out);
      } else this._onClose(f, approval.seenAt, out);
    }
    if (approval.caughtUp === true) this._settle(open, approval.seenAt, out);
    return out;
  }

  /** A turn boundary of the session: open tools are closed, so held, pending and shown requests are dropped. */
  onTurnBoundary() {
    for (const e of this.held.keys()) capAdd(this.decided, e, MAX_IDS);
    this.stats.dropped += this.held.size;
    this.held.clear();
    this.pending.clear();
    this.shown.clear();
    this.unseen.clear();
  }

  /** The items onCall made since the last take(). */
  take() {
    if (!this.queue.length) return [];
    const q = this.queue;
    this.queue = [];
    return q;
  }

  debugState() {
    return {
      count: this.count, offset: this.offset, lastU: this.lastU, decided: this.decided.size, held: [...this.held.keys()],
      pending: [...this.pending.keys()], shown: [...this.shown.keys()], unseen: this.unseen.size, stats: { ...this.stats },
    };
  }

  // ------------------------------------------------------------------------------- internals

  _isOpen(id) { return !!this.toolOf(id); }

  _isTarget(id) {
    const t = this.toolOf(id);
    return !!t && t.ask !== true;
  }

  _onOpen(f, seenAt, out) {
    if (this.shown.has(f.e)) return; // 빗장: true 는 한 번
    const p = this.pending.get(f.e);
    if (p) {
      this._due(p, seenAt, out);
      return;
    }
    const h = this.held.get(f.e);
    if (h) {
      h.lastSeen = seenAt; // 아직 열려 있다: 호출이 오면 이 읽기로 때를 본다
      // 한 읽기를 더 지나도 호출이 없다: 센 호출 중 하나뿐인 후보가 있으면 순번이 앞선 것이다 (없으면 정하지 않고 계속 든다)
      const call = this._candidate(h);
      if (!call) return;
      this.held.delete(f.e);
      capAdd(this.decided, f.e, MAX_IDS);
      this._paired(h, this._resync(h, call), seenAt, out);
      return;
    }
    if (this.decided.has(f.e)) return;
    const req = { e: f.e, name: f.name, startMs: f.startMs, at: tsOr(f.reqMs, seenAt, seenAt), lastSeen: seenAt };
    if (f.e + this.offset > this.count) {
      this.held.set(f.e, req);
      this.stats.held += 1;
      if (this.held.size > MAX_HELD) this._drop(this.held.keys().next().value);
      return;
    }
    const call = this._pair(req);
    if (call) this._paired(req, call, seenAt, out);
  }

  _onClose(f, seenAt, out) {
    this.pending.delete(f.e);
    if (this.held.has(f.e)) this._drop(f.e); // 호출이 오기 전에 끝났다: 보이지 않는다
    const id = this.shown.get(f.e);
    if (id === undefined) return;
    this.shown.delete(f.e);
    if (f.state === 'allow') this._clear(id, tsOr(f.resMs, seenAt, seenAt), out); // 거절과 사라짐은 tool_end 가 닫는다
  }

  _clear(id, ts, out) {
    if (!this._isTarget(id)) return;
    out.push({ k: 'tool_wait', id, waiting: false, ts });
    this.stats.cleared += 1;
  }

  // 따라잡은 읽기에 없는 요청은 닫혔다: 보인 것(과 다시 짝지어지지 않은 reset 전의 것)은 waiting:false, 나머지는 버린다
  _settle(open, seenAt, out) {
    for (const e of [...this.held.keys()]) if (!open.has(e)) this._drop(e);
    for (const e of [...this.pending.keys()]) if (!open.has(e)) this.pending.delete(e);
    const ids = new Set(this.unseen);
    this.unseen.clear();
    for (const [e, id] of [...this.shown]) {
      if (open.has(e)) continue;
      this.shown.delete(e);
      ids.add(id);
    }
    for (const id of ids) {
      this.stats.settled += 1;
      this._clear(id, seenAt, out);
    }
  }

  _drop(e) {
    this.held.delete(e);
    capAdd(this.decided, e, MAX_IDS);
    this.stats.dropped += 1;
  }

  // 정한다 (한 번): 순번으로 짝, 아니면 하나뿐인 후보로 다시 맞춤, 아니면 null
  _pair(req) {
    capAdd(this.decided, req.e, MAX_IDS);
    if (req.name !== null) {
      const u = req.e + this.offset;
      const c = this.calls.get(u);
      if (c && u > this.lastU && c.name === req.name && near(c.ms, req.startMs)) {
        this.lastU = u;
        this.stats.paired += 1;
        return c;
      }
      const found = this._candidate(req);
      if (found) return this._resync(req, found);
    }
    this.stats.misses += 1;
    return null;
  }

  // 다시 맞출 후보: 센 호출 중 열린 보이는 것, 이름이 같고, PAIR_MS 안이고, 갱신이 아직 없고, 마지막 짝보다 뒤인 것이 꼭 하나면
  // 그것, 아니면 null (정하지도 세지도 않는다)
  _candidate(req) {
    if (req.name === null) return null;
    let found = null;
    let n = 0;
    for (const x of this.calls.values()) {
      if (x.u <= this.lastU || x.updated || x.name !== req.name || !near(x.ms, req.startMs) || !this._isOpen(x.id)) continue;
      found = x;
      if (++n > 1) return null;
    }
    return found;
  }

  _resync(req, call) {
    this.offset = call.u - req.e;
    this.lastU = call.u;
    this.stats.resyncs += 1;
    return call;
  }

  _paired(req, call, seenAt, out) {
    // reset 전에 보인 그 호출과 다시 짝지어졌다: 코어에 이미 있으므로 보낼 것 없이 다시 보인 것으로 둔다
    if (this.unseen.delete(call.id)) {
      this.shown.set(req.e, call.id);
      return;
    }
    const p = { e: req.e, id: call.id, at: req.at };
    this.pending.set(req.e, p);
    this._due(p, seenAt, out);
  }

  // 읽은 시각에 APPROVAL_SHOW_MS 이상 열려 있었으면 보인다 (그때 대상이 아니면 조용히 버린다)
  _due(p, seenAt, out) {
    if (seenAt - p.at < APPROVAL_SHOW_MS) return;
    this.pending.delete(p.e);
    if (!this._isTarget(p.id)) return;
    this.shown.set(p.e, p.id);
    if (this.shown.size > MAX_IDS) this.shown.delete(this.shown.keys().next().value);
    out.push({ k: 'tool_wait', id: p.id, waiting: true, ts: p.at });
    this.stats.shown += 1;
  }

  // events.jsonl 이 바뀌었다 (교체, 줄어듦): 예전 순번과 사실은 모두 무효 (마지막 짝 u 도: 새 파일의 순번은 처음부터다).
  // 센 호출은 그대로 (기록은 그대로다). 보인 호출은 unseen 으로: 아직 열린 요청이 다시 짝지어지면 보인 채로, 아니면 닫는다
  _reset() {
    for (const id of this.shown.values()) capAdd(this.unseen, id, MAX_IDS);
    this.offset = 0;
    this.lastU = 0;
    this.decided.clear();
    this.held.clear();
    this.pending.clear();
    this.shown.clear();
    this.stats.resets += 1;
  }
}
