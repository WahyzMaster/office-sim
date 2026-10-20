// 세션 등록부 + 이벤트 링 버퍼 + 스냅샷. 모든 어댑터가 같이 쓴다 (contract 4.0.1).
// SessionState 는 파일 하나만 보므로, 파일을 가로지르는 일(부모 찾기, 부모 쪽 신호로 끝내기, 부모 층 상속)은 여기서 한다.
// Claude 서브에이전트 연결(4.5)은 store-claude.mjs 에 있고, entry 의 agent 가 'claude-code' 일 때만 부른다.
// IO 는 하지 않는다: meta/journal 은 서버가 읽어서 넣어 준다.
import { refIdentity, refAgent, refIdsOk, subTitle, newIndex, sameSession, parentFirst, ringSince } from './store-link.mjs';
import { cleanLabel, publicSessionId, agentScopedId, CLAUDE_CODE_AGENT } from './session-identity.mjs';
import * as claude from './store-claude.mjs';

const KIND_ORDER = { main: 0, sub: 1, wf: 2 };
// 부모 쪽 신호로 끝낸 직후 같은 서브 파일에서 늦게 읽힌 꼬리 이벤트는 되살리지 않고 버린다.
const DONE_GRACE_MS = 5000;
const END_REASONS = new Set(['done', 'idle']);
// 거절한 경로 (로그 한 번): 차면 새 경로는 기억하지 않는다 (G1). 아직 알리지 않은 직원의 끝 힌트 (F4): 넘치면 가장 오래된 것부터 버린다
const MAX_REMEMBERED = 1000;

const isClaude = (e) => e.agent === CLAUDE_CODE_AGENT;
// 세션 객체가 낸 내부 힌트 ({ hint: 'end', charId }, 4.0.1). 이벤트가 아니라 브라우저로 가지 않는다.
const isHint = (ev) => ev.hint !== undefined;

export class Store {
  constructor({ log = () => {}, ringSize = 1000, seqStart = 0, now = Date.now } = {}) {
    this.log = log;
    this.ringSize = ringSize;
    this.now = now;
    this.lastSeq = seqStart;
    this.ring = [];
    this.listeners = new Set();
    this.byPath = new Map();
    this.byChar = new Map();
    this.bySid = new Map(); // sid -> Set(entry), byPath 와 같은 삽입 순서
    this.indexes = new Map(); // sid -> index (Claude 서브에이전트 연결 색인, store-link newIndex)
    this.movedShown = new Set(); // 열린 페이지에 보이던 채로 다른 경로로 옮겨 간 캐릭터
    this.order = 0;
    this.rejected = new Set(); // 거절한 ref 경로 (F2, G1): 경로마다 로그 한 줄, 1000 개까지, 지우지 않는다
    this.rejectedFull = false; // 1000 개가 찬 뒤 처음 거절할 때 한 번만 로그한다
    this.pendingEnds = new Map(); // `${agent}|${charId}` -> reason: 아직 알리지 않은 직원의 끝 힌트 (F4)
  }

  /**
   * Store counters for start().stats(): rejectedRefs = distinct ref paths refused by the ref guard (D2 ids, G3 foreign
   * agent). A lower bound: it stops at 1000 remembered paths, new paths after that are refused but not counted.
   */
  stats() { return { rejectedRefs: this.rejected.size }; }

  get seq() { return this.lastSeq; }
  get fileCount() { return this.byPath.size; }
  get sessionCount() { return this.byChar.size; }
  has(path) { return this.byPath.has(path); }
  entry(path) { return this.byPath.get(path) ?? null; }
  identity(ref) { return refIdentity(ref); }

  index(sid) {
    let idx = this.indexes.get(sid);
    if (!idx) this.indexes.set(sid, (idx = newIndex()));
    return idx;
  }

  // ---- registry -------------------------------------------------------------------------------

  // D2 (F2, G2): 다른 어댑터의 ref 는 charId, (있으면) parentId 와 sid 가 그 어댑터의 id 여야 붙는다 (메인은 sid = charId).
  // Claude ref 는 그대로.
  acceptsRef(ref) {
    return refIdsOk(ref) || this.rejectRef(ref, refAgent(ref), 'invalid id');
  }

  // 거절 (F2, G1): 경로마다 로그 한 줄과 카운터 하나 (경로도 id 도 로그에 남기지 않는다). 기억한 경로는 지우지 않는다:
  // 1000 개가 차면 그 뒤의 새 경로는 거절만 하고 따로 로그하거나 세지 않는다 (처음 넘칠 때 한 줄). 그래서 rejectedRefs 는 하한이다.
  // agent 는 로그 앞머리: Runner 가 거절하면 (G3) ref 가 내세운 id 가 아니라 Runner 의 어댑터 id. 늘 false.
  rejectRef(ref, agent, why) {
    const key = String(ref?.path ?? '');
    if (this.rejected.has(key)) return false;
    const who = publicSessionId(agent) ?? 'adapter';
    if (this.rejected.size < MAX_REMEMBERED) {
      this.rejected.add(key);
      this.log(`${who}: rejected ref with ${why}`);
    } else if (!this.rejectedFull) {
      this.rejectedFull = true;
      this.log(`${who}: too many rejected refs, further ones not logged`);
    }
    return false;
  }

  attachFile(ref, state, { meta = null, label = null } = {}) {
    if (!this.acceptsRef(ref)) return null;
    const id = refIdentity(ref);
    const agent = refAgent(ref);
    const prev = this.byChar.get(id.charId) ?? this.byPath.get(ref.path);
    if (prev) this.dropEntry(prev);
    const moved = this.movedShown.delete(id.charId); // 지우기는 항상 한다
    const e = {
      ...id, agent, path: ref.path, ref, state, meta, label,
      metaPending: agent === CLAUDE_CODE_AGENT && id.kind === 'sub' && !meta, // 늦은 meta.json 은 Claude 서브만
      parent: null, resolved: id.kind !== 'sub',
      announced: false, ended: false, doneAt: 0, lastSession: null,
      wasShown: (!!prev && prev.announced && !prev.ended) || moved,
      order: this.order++,
    };
    this.byPath.set(ref.path, e);
    this.byChar.set(e.charId, e);
    if (!this.bySid.has(e.sid)) this.bySid.set(e.sid, new Set());
    this.bySid.get(e.sid).add(e);
    this.index(e.sid);
    this.resolve(e);
    this.syncInfo(e);
    if (isClaude(e)) claude.endIfStopped(this, e);
    return { charId: e.charId, parentId: e.kind === 'main' ? null : e.parent, kind: e.kind, sid: e.sid };
  }

  dropEntry(e) {
    if (this.byPath.get(e.path) === e) this.byPath.delete(e.path);
    if (this.byChar.get(e.charId) === e) this.byChar.delete(e.charId);
    const group = this.bySid.get(e.sid);
    if (group) {
      group.delete(e);
      if (!group.size) this.bySid.delete(e.sid);
    }
  }

  // 같은 inode 로 옮겨 간 파일 (contract 4.5 relocation): 등록부의 경로만 바꾼다. 상태, 알림 여부, 색인은 그대로라
  // 다시 replay 하거나 다시 알리지 않는다. 신원(sid, charId, kind)이 다르면 거절한다 (false).
  rekey(from, ref) {
    const e = this.byPath.get(from);
    const id = refIdentity(ref);
    if (!e || this.byPath.has(ref.path) || id.charId !== e.charId || id.sid !== e.sid || id.kind !== e.kind) return false;
    if (!this.acceptsRef(ref)) return false;
    this.byPath.delete(from);
    Object.assign(e, { path: ref.path, ref, runId: id.runId, runDir: id.runDir });
    this.byPath.set(ref.path, e);
    return true;
  }

  // moved: 같은 캐릭터가 새 경로에서 곧 다시 붙는다. 열린 페이지에 보이던 캐릭터면 기억해 두었다가, 옮기는 사이에
  // 끝났으면 다시 붙을 때 session_end 를 보낸다. 다시 붙지 못하면(사라짐) 여기서 idle 로 끝을 알린다.
  detachFile(path, { moved = false } = {}) {
    const e = this.byPath.get(path);
    if (!e) return false;
    const shown = e.announced ? !e.ended : e.wasShown;
    this.dropEntry(e);
    if (shown && moved) this.movedShown.add(e.charId);
    else if (shown && !e.announced) {
      this.push({ type: 'session_end', sessionId: e.charId, ts: new Date(this.now()).toISOString(), reason: 'idle' });
    }
    if (!this.bySid.has(e.sid)) this.indexes.delete(e.sid);
    return true;
  }

  // ---- parents (4.5 for Claude, ref.parentId for the other adapters) --------------------------

  resolve(e) {
    if (e.kind === 'main') return false;
    if (isClaude(e)) return claude.resolve(this, e);
    // 다른 어댑터는 탐색이 부모를 ref 에 적어 준다 (refIdentity 의 parentId). 없으면 메인 세션(sid)이 부모.
    const before = `${e.parent}|${e.resolved}`;
    const owner = e.parentId && e.parentId !== e.charId ? e.parentId : null;
    e.resolved = !!owner;
    e.parent = owner ?? e.sid;
    return before !== `${e.parent}|${e.resolved}`;
  }

  // 등록 전에 부모를 미리 계산한다 (SessionState 생성자의 parentId 용, best effort).
  parentFor(ref, meta = null) {
    const id = refIdentity(ref);
    if (id.kind === 'main') return null;
    const probe = { ...id, agent: refAgent(ref), meta, parent: null, resolved: false };
    this.resolve(probe);
    return probe.parent;
  }

  // Claude 전용 (4.5): 늦게 생긴 meta.json / journal label. 다른 어댑터의 파일이면 아무것도 하지 않는다.
  setMeta(path, meta) {
    const e = this.claudeEntry(path);
    if (e) claude.setMeta(this, e, meta);
  }

  setLabel(path, label) {
    const e = this.claudeEntry(path);
    if (e) claude.setLabel(this, e, label);
  }

  pendingMeta() { return claude.pendingMeta(this); }
  pendingLabels() { return claude.pendingLabels(this, CLAUDE_CODE_AGENT); }

  claudeEntry(path) {
    const e = this.byPath.get(path);
    return e && isClaude(e) ? e : null;
  }

  // 모든 세션의 연결을 다시 계산하고 바뀐 session 이벤트를 보낸다 (rescan 끝마다).
  relinkAll() {
    for (const sid of [...this.bySid.keys()]) this.refreshSubs(sid);
  }

  subsOf(sid) {
    const group = this.bySid.get(sid);
    return group ? [...group].filter((e) => e.kind !== 'main') : [];
  }

  refreshSubs(sid) {
    for (const e of this.subsOf(sid)) {
      if (this.resolve(e)) this.syncInfo(e);
      else if (e.announced) this.syncInfo(e, true);
      if (!e.announced || e.ended) continue;
      const ev = this.patch(e.state.sessionEvent(), e);
      if (e.lastSession && sameSession(e.lastSession, ev)) continue;
      this.push(ev);
    }
  }

  mainEvent(sid) {
    const main = this.byChar.get(sid);
    return main && main.kind === 'main' && main.announced ? main.state.sessionEvent() : null;
  }

  // SessionState 가 setInfo 를 지원하면 같은 정보를 넣어 둔다 (그쪽 session 이벤트도 같은 값이 되도록).
  // 돌려받은 이벤트는 버린다: 바깥으로 나가는 session 이벤트는 Store 가 보정해서 직접 보낸다.
  syncInfo(e, projectOnly = false) {
    if (e.kind === 'main' || typeof e.state?.setInfo !== 'function') return;
    const parentProject = this.mainEvent(e.sid)?.project;
    const info = projectOnly ? {} : {
      subMeta: e.meta ?? null, journalLabel: e.label ?? null, parentId: e.parent ?? e.sid,
      ...(cleanLabel(e.meta?.agentType) ? { agentType: cleanLabel(e.meta.agentType) } : {}),
    };
    if (parentProject) info.parentProject = parentProject;
    if (!Object.keys(info).length) return;
    try {
      e.state.setInfo(info);
    } catch (err) {
      this.log(`setInfo failed for ${e.charId}: ${err?.message ?? err}`);
    }
  }

  // 서브 session 이벤트 보정: 부모, 제목, 층 상속, agentType. agent 는 이벤트에 없을 때 entry 의 agent.
  patch(ev, e) {
    if (!ev || ev.type !== 'session' || !e || e.kind === 'main') return ev;
    const mainEv = this.mainEvent(e.sid);
    return {
      ...ev,
      sessionId: e.charId,
      agent: ev.agent ?? e.agent ?? CLAUDE_CODE_AGENT, // 서브는 부모와 같은 에이전트다
      isSubagent: true,
      parentSessionId: publicSessionId(e.parent ?? e.sid) ?? publicSessionId(e.sid),
      agentType: cleanLabel(e.meta?.agentType) ?? ev.agentType ?? null, // section 5: scrub + cap, like buildSessionEvent
      // 4.3 Claude 서브 제목은 meta/journal 에서. 다른 어댑터는 세션이 낸 제목을 같은 규칙(scrub + 80)으로.
      title: isClaude(e) ? subTitle(e.meta, e.label, e.charId) : subTitle(null, ev.title, e.charId),
      ...(mainEv ? { project: mainEv.project, projectLabel: mainEv.projectLabel } : {}),
    };
  }

  // ---- cross-file signals ---------------------------------------------------------------------

  // 서버가 파일의 모든 레코드를 (replay 포함) 여기에 넘긴다. Claude 파일만: 색인 + 부모 쪽 신호로 서브 끝내기.
  observe(path, rec) {
    const e = this.claudeEntry(path);
    if (e) claude.observe(this, e, rec);
  }

  // R36: 서브 파일의 TaskCreate/TaskUpdate 를 같은 세션 메인의 작업 목록으로 (Claude 만)
  taskDeltas(path, deltas) {
    const e = this.claudeEntry(path);
    if (e) claude.taskDeltas(this, e, deltas);
  }

  // 4.0.1 공통 끝 규칙: 어댑터가 다른 파일에서 알게 된 끝(부모 파일에 적힌 자식의 끝)을 그 직원에게 알린다.
  // 살아 있는(알렸고 아직 끝나지 않은) 직원에게 한 번만 session_end 를 보낸다. 이미 끝난 직원은 아무것도 하지 않는다.
  // 끝낸 직후 늦게 읽힌 그 직원의 꼬리 줄은 R29 처럼 유예 시간 동안 버린다.
  // agent (F3): 있으면 entry 의 agent 가 같은 직원만 끝낸다 (다르면 아무것도 하지 않는다). 없으면 예전 그대로.
  // F4: agent 가 있고 그 직원이 아직 알려지지 않았으면 (파일이 아직 안 붙었거나 같은 rescan 에서 뒤에 붙는다) 힌트를
  // 기억해 두었다가 알릴 때 쓴다 (announce: 끝난 채로 시작해서 보이지 않는다). agent 없는 직접 호출은 기억하지 않는다.
  endCharacter(charId, reason = 'done', agent = null) {
    if (typeof charId !== 'string') return false;
    const e = this.byChar.get(charId) ?? null;
    const scoped = typeof agent === 'string' && agent !== '';
    if (scoped && e && e.agent !== agent) return false;
    const why = END_REASONS.has(reason) ? reason : 'done';
    if (!e || !e.announced) {
      if (scoped) this.rememberEnd(agent, charId, why);
      return false;
    }
    if (e.ended) return false;
    e.doneAt = this.now();
    this.push({ type: 'session_end', sessionId: e.charId, ts: new Date(this.now()).toISOString(), reason: why });
    return true;
  }

  // 그 어댑터의 id 모양인 것만 (D2, Claude 는 id 규칙만): 터무니없는 id 로 메모리를 채우지 않는다. 상한을 넘으면 가장 오래된 것부터.
  rememberEnd(agent, charId, reason) {
    const fits = agent === CLAUDE_CODE_AGENT ? publicSessionId(charId) !== null : agentScopedId(agent, charId);
    if (!fits) return;
    const key = `${agent}|${charId}`;
    this.pendingEnds.delete(key);
    if (this.pendingEnds.size >= MAX_REMEMBERED) this.pendingEnds.delete(this.pendingEnds.keys().next().value);
    this.pendingEnds.set(key, reason);
  }

  // 알리는 직원의 기억해 둔 끝 힌트 (한 번 쓰면 지운다): 끝 이유, 없으면 null.
  takeEnd(e) {
    const key = `${e.agent}|${e.charId}`;
    const reason = this.pendingEnds.get(key) ?? null;
    if (reason) this.pendingEnds.delete(key);
    return reason;
  }

  isDone(e) {
    return isClaude(e) ? claude.isDone(this, e) : false;
  }

  // ---- events ---------------------------------------------------------------------------------

  // 파일 하나가 붙은 뒤(replay 끝) 열린 페이지에 새 직원을 알린다: session + snapshotEvents.
  announce(path) {
    const e = this.byPath.get(path);
    if (!e) return 0;
    if (isClaude(e)) claude.applyBufferedTasks(this, e);
    e.announced = true;
    this.resolve(e);
    const before = this.lastSeq;
    const hinted = this.takeEnd(e); // F4: 부모 파일에서 이미 끝난 자식은 끝난 채로 시작한다 (보인 적 없으면 아무것도 보내지 않는다)
    if (hinted || this.isDone(e) || e.state.ended) {
      if (e.wasShown) {
        this.push({ type: 'session_end', sessionId: e.charId, ts: new Date(this.now()).toISOString(), reason: hinted ?? 'done' });
      }
      e.ended = true;
      if (hinted) e.doneAt = this.now(); // endCharacter 처럼: 바로 뒤에 읽힌 꼬리 줄은 유예 시간 동안 버린다
    } else {
      e.ended = false;
      for (const ev of this.entryEvents(e)) this.push(ev);
    }
    e.wasShown = false;
    if (e.kind === 'main') this.refreshSubs(e.sid);
    return this.lastSeq - before;
  }

  entryEvents(e) {
    const raw = e.state.snapshotEvents() ?? [];
    const evs = raw.some((ev) => ev?.type === 'session') ? raw : [e.state.sessionEvent(), ...raw];
    const out = [];
    for (const ev of evs) {
      if (!ev || typeof ev !== 'object' || isHint(ev)) continue;
      if (e.kind !== 'main' && ev.type === 'prompt') continue;
      out.push(ev.type === 'session' ? this.patch(ev, this.byChar.get(ev.sessionId) ?? e) : ev);
    }
    return out;
  }

  // SessionState 가 만든 라이브 이벤트를 받는다. 힌트 항목은 Runner 가 이미 뺐다 (남아 있어도 보내지 않는다).
  ingest(path, events) {
    if (!events?.length) return 0;
    const src = this.byPath.get(path) ?? null;
    const before = this.lastSeq;
    let mainSession = false;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || isHint(ev)) continue;
      // sessionId 가 다른 (등록 안 된) 캐릭터면 원본 파일의 상태를 빌려 쓰지 않는다
      const e = ev.sessionId ? (this.byChar.get(ev.sessionId) ?? null) : src;
      const isSub = e ? e.kind !== 'main' : false;
      // 개인정보: 서브 파일의 사용자 레코드는 부모가 넘긴 Agent prompt 다
      if (isSub && ev.type === 'prompt') continue;
      if (e && ev.type === 'session_end') {
        if (e.ended) continue;
      } else if (e && e.ended) {
        if (e.doneAt && this.now() - e.doneAt < DONE_GRACE_MS) continue;
        e.ended = false; // 다시 일을 시작했다: 직원부터 다시 세운다
        e.doneAt = 0;
        // snapshot()/announce() 도 살아 있게 본다 (Claude 의 끝 표시는 sid 색인에 있다)
        if (e.kind !== 'main' && isClaude(e)) claude.revive(this.index(e.sid), e.charId);
        if (ev.type !== 'session') this.push(this.patch(e.state.sessionEvent(), e));
      }
      if (e && !e.announced) e.announced = true;
      if (ev.type === 'session' && e?.kind === 'main') mainSession = true;
      this.push(ev.type === 'session' && isSub ? this.patch(ev, e) : ev);
    }
    if (mainSession && src) this.refreshSubs(src.sid);
    return this.lastSeq - before;
  }

  push(ev) {
    const e = ev.sessionId ? this.byChar.get(ev.sessionId) : null;
    if (e) {
      if (ev.type === 'session_end') e.ended = true;
      if (ev.type === 'session') e.lastSession = ev;
    }
    const item = { seq: ++this.lastSeq, event: ev };
    this.ring.push(item);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const fn of [...this.listeners]) {
      try { fn(item); } catch (err) { this.log(`listener failed: ${err?.message ?? err}`); }
    }
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.unsubscribe(fn); }
  unsubscribe(fn) { this.listeners.delete(fn); }

  // 열린 세션 전체를 다시 그리는 이벤트. 메인 -> 부모가 먼저 나온 서브 순서.
  snapshot() {
    const live = [...this.byPath.values()]
      // replay 중인(아직 announce 전) 파일은 상태가 반쯤이라 넣지 않는다
      .filter((e) => e.announced && !e.ended && !e.state.ended && !this.isDone(e))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order);
    const events = [];
    for (const e of parentFirst(live)) {
      try {
        events.push(...this.entryEvents(e));
      } catch (err) {
        this.log(`snapshot failed for ${e.charId}: ${err?.message ?? err}`);
      }
    }
    return { seq: this.lastSeq, events };
  }

  // seq 다음 이벤트들 [{ seq, event }]. 링에서 이미 밀려났거나 다른 서버 실행의 seq 면 null.
  since(seq) { return ringSince(this.ring, this.lastSeq, seq); }
}
