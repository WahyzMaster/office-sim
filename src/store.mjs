// 세션 등록부 + 서브에이전트 연결(4.5) + 이벤트 링 버퍼 + 스냅샷.
// SessionState 는 파일 하나만 보므로, 파일을 가로지르는 일(부모 찾기, 부모 쪽 결과/알림으로 끝내기,
// 부모 층 상속)은 여기서 한다. IO 는 하지 않는다: meta/journal 은 서버가 읽어서 넣어 준다.
import {
  refIdentity, linkFacts, isAgentTool, looksLikeAgentId, trailerAgentId, subTitle, END_STATUSES, parentFirst,
  newIndex, isAsyncLaunchText, sameSession, resumedAgentIdOf, rememberStopped, takeStopped, ringSince,
} from './store-link.mjs';
import { cleanLabel, publicSessionId, CLAUDE_CODE_AGENT } from './session-identity.mjs';

const KIND_ORDER = { main: 0, sub: 1, wf: 2 };
// 부모 쪽 신호로 끝낸 직후 같은 서브 파일에서 늦게 읽힌 꼬리 이벤트는 되살리지 않고 버린다.
const DONE_GRACE_MS = 5000;
const MAX_TASK_DELTAS = 500; // 세션 하나에 보관하는 서브 TaskCreate/TaskUpdate (메인이 다시 붙을 때 다시 적용)

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
    this.indexes = new Map(); // sid -> index
    this.movedShown = new Set(); // 열린 페이지에 보이던 채로 다른 경로로 옮겨 간 캐릭터
    this.order = 0;
  }

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

  attachFile(ref, state, { meta = null, label = null } = {}) {
    const id = refIdentity(ref);
    const prev = this.byChar.get(id.charId) ?? this.byPath.get(ref.path);
    if (prev) this.dropEntry(prev);
    const moved = this.movedShown.delete(id.charId); // 지우기는 항상 한다
    const e = {
      ...id, path: ref.path, ref, state, meta, label,
      metaPending: id.kind === 'sub' && !meta,
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
    this.endIfStopped(e);
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

  // ---- subagent linking (4.5) -----------------------------------------------------------------

  resolve(e) {
    if (e.kind === 'main') return false;
    const before = `${e.parent}|${e.resolved}`;
    if (e.kind === 'wf') {
      e.parent = e.sid;
      e.resolved = true;
    } else {
      const idx = this.index(e.sid);
      let owner = null;
      const tu = e.meta?.toolUseId;
      if (typeof tu === 'string') owner = idx.toolOwner.get(tu) ?? null;
      if (!owner) owner = idx.agentOwner.get(e.charId) ?? null;
      if (!owner && looksLikeAgentId(e.meta?.parentAgentId)) owner = e.meta.parentAgentId; // id 모양만 (section 5)
      if (owner === e.charId) owner = null;
      e.resolved = !!owner;
      e.parent = owner ?? e.sid; // 못 찾으면 메인 세션이 부모 (다음 rescan 에 다시 시도)
    }
    return before !== `${e.parent}|${e.resolved}`;
  }

  // 등록 전에 부모를 미리 계산한다 (SessionState 생성자의 parentId 용, best effort).
  parentFor(ref, meta = null) {
    const id = refIdentity(ref);
    if (id.kind === 'main') return null;
    const probe = { ...id, meta, parent: null, resolved: false };
    this.resolve(probe);
    return probe.parent;
  }

  setMeta(path, meta) {
    const e = this.byPath.get(path);
    if (!e || !meta) return;
    e.meta = meta;
    e.metaPending = false;
    this.resolve(e);
    this.syncInfo(e);
    this.endIfStopped(e);
    this.refreshSubs(e.sid);
  }

  // R29: 부모가 이 서브(meta.toolUseId)를 기다리지 않게 된 결과가 서브보다 먼저 읽혔다 (재시작 replay, 늦은 meta.json)
  endIfStopped(e) {
    const ts = e.kind === 'sub' ? takeStopped(this.index(e.sid), e) : undefined;
    if (ts !== undefined) this.endAgent(e.charId, ts, e.sid);
  }

  setLabel(path, label) {
    const e = this.byPath.get(path);
    if (!e || !label || e.label === label) return;
    e.label = label;
    this.syncInfo(e);
    this.refreshSubs(e.sid);
  }

  // meta 가 아직 없는 서브 (jsonl 보다 1초 이상 늦게 생기는 경우가 있다)
  pendingMeta() {
    return [...this.byPath.values()].filter((e) => e.metaPending).map((e) => e.path);
  }

  // journal label 이 필요한 wf 에이전트: [{ path, runDir, charId }]
  pendingLabels() {
    return [...this.byPath.values()]
      .filter((e) => e.kind === 'wf' && !e.label && !e.meta?.name && !e.meta?.description)
      .map((e) => ({ path: e.path, runDir: e.runDir, charId: e.charId }));
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

  // 서브 session 이벤트 보정: 부모, 제목, 층 상속, agentType.
  patch(ev, e) {
    if (!ev || ev.type !== 'session' || !e || e.kind === 'main') return ev;
    const mainEv = this.mainEvent(e.sid);
    return {
      ...ev,
      sessionId: e.charId,
      agent: ev.agent ?? CLAUDE_CODE_AGENT, // 서브는 부모와 같은 에이전트다 (지금은 Claude Code 하나뿐)
      isSubagent: true,
      parentSessionId: publicSessionId(e.parent ?? e.sid) ?? publicSessionId(e.sid),
      agentType: cleanLabel(e.meta?.agentType) ?? ev.agentType ?? null, // section 5: scrub + cap, like buildSessionEvent
      title: subTitle(e.meta, e.label, e.charId),
      ...(mainEv ? { project: mainEv.project, projectLabel: mainEv.projectLabel } : {}),
    };
  }

  // ---- cross-file signals ---------------------------------------------------------------------

  // 서버가 파일의 모든 레코드를 (replay 포함) 여기에 넘긴다. 색인 + 부모 쪽 신호로 서브 끝내기.
  observe(path, rec) {
    const e = this.byPath.get(path);
    if (!e) return;
    const facts = linkFacts(rec);
    if (!facts) return;
    // R10: 메인 파일의 다른 sessionId 레코드는 fork 기록이다
    if (e.kind === 'main' && typeof rec.sessionId === 'string' && rec.sessionId !== e.sid) return;
    const idx = this.index(e.sid);
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    let linked = false;
    for (const tu of facts.toolUses ?? []) {
      if (!idx.toolOwner.has(tu.id)) linked = true;
      idx.toolOwner.set(tu.id, e.charId);
      idx.toolName.set(tu.id, tu.name);
    }
    for (const block of facts.results ?? []) {
      if (this.onResult(idx, e.sid, block, rec.toolUseResult, ts)) linked = true;
    }
    for (const n of facts.notifications ?? []) this.onNotification(idx, e.sid, n, ts);
    // R29: 서브 파일 자신의 endTurn 결과 (StructuredOutput / SubagentHandback)
    if (facts.endTurn && e.kind !== 'main') this.endAgent(e.charId, ts, e.sid);
    if (linked && this.subsOf(e.sid).some((s) => !s.resolved)) this.refreshSubs(e.sid);
  }

  onResult(idx, sid, block, tur, ts) {
    const tuId = block.tool_use_id;
    const name = idx.toolName.get(tuId);
    if (!name) return false;
    const obj = tur && typeof tur === 'object' && !Array.isArray(tur) ? tur : null;
    let linked = false;
    if (isAgentTool(name)) {
      let agentId = looksLikeAgentId(obj?.agentId) ? obj.agentId : null;
      // 중첩 서브의 결과에는 toolUseResult 가 없다: 본문 꼬리표 "agentId: a…" 로 대신한다
      const trailer = agentId ? null : trailerAgentId(block);
      if (!agentId) agentId = trailer ?? this.subByToolUse(tuId, sid)?.charId ?? null;
      const completed = obj ? obj.status === 'completed' : !!trailer && !block.is_error && !isAsyncLaunchText(block);
      // 오류/중단/거절된 결과: 부모가 동기 에이전트를 더 기다리지 않는다 (비동기 실행은 is_error 가 없다)
      const terminal = completed || block.is_error === true;
      if (agentId) {
        if (!idx.agentOwner.has(agentId)) linked = true;
        idx.agentOwner.set(agentId, idx.toolOwner.get(tuId));
        idx.agentByToolUse.set(tuId, agentId);
        if (terminal) {
          const key = `r|${tuId}`;
          if (!idx.doneKeys.has(key)) {
            idx.doneKeys.add(key);
            this.endAgent(agentId, ts, sid);
          }
        }
      } else if (terminal) {
        rememberStopped(idx, tuId, ts); // 오류 결과에는 agentId 가 없다: 서브(meta.toolUseId)가 붙을 때 끝낸다
      }
    } else if (name === 'Workflow' && obj) {
      if (typeof obj.runId === 'string') {
        idx.runByToolUse.set(tuId, obj.runId);
        if (typeof obj.taskId === 'string') idx.runByTask.set(obj.taskId, obj.runId);
      }
    } else if (name === 'SendMessage') {
      const resumed = resumedAgentIdOf(block, obj);
      if (resumed) {
        idx.resumeByToolUse.set(tuId, resumed);
        this.revive(idx, resumed); // 끝났던 에이전트가 다시 일한다: 유예 시간 없이 바로 되살린다
        const e = this.byChar.get(resumed);
        if (e && e.sid === sid) e.doneAt = 0;
      }
    }
    return linked;
  }

  onNotification(idx, sid, n, ts) {
    if (!END_STATUSES.has(n.status)) return; // <status> 없는 진행 알림
    const key = `n|${n.toolUseId}|${n.taskId}|${n.status}`;
    if (idx.doneKeys.has(key)) return;
    idx.doneKeys.add(key);
    const agents = new Set();
    const runs = new Set();
    if (n.toolUseId) {
      const a = idx.agentByToolUse.get(n.toolUseId) ?? idx.resumeByToolUse.get(n.toolUseId)
        ?? this.subByToolUse(n.toolUseId, sid)?.charId;
      if (a) agents.add(a);
      const r = idx.runByToolUse.get(n.toolUseId);
      if (r) runs.add(r);
    }
    if (n.taskId) {
      if (looksLikeAgentId(n.taskId)) agents.add(n.taskId);
      const r = idx.runByTask.get(n.taskId);
      if (r) runs.add(r);
    }
    for (const a of agents) this.endAgent(a, ts, sid);
    for (const r of runs) {
      idx.doneRuns.add(r);
      for (const e of this.subsOf(sid)) if (e.kind === 'wf' && e.runId === r) this.endAgent(e.charId, ts, sid);
    }
  }

  subByToolUse(tuId, sid = null) {
    for (const e of sid ? (this.bySid.get(sid) ?? []) : this.byPath.values()) {
      if (e.kind === 'sub' && e.meta?.toolUseId === tuId) return e;
    }
    return null;
  }

  // R36: 서브 파일의 TaskCreate/TaskUpdate 는 같은 세션 메인의 작업 목록을 바꾼다. 메인이 아직 알려지지 않았으면
  // 모아 두었다가 announce 때 (메인 replay 가 끝난 뒤) 적용한다. 시각 비교는 SessionState 가 한다.
  taskDeltas(path, deltas) {
    const e = this.byPath.get(path);
    if (!e || e.kind === 'main' || !deltas?.length) return;
    const idx = this.index(e.sid);
    for (const d of deltas) {
      if (!d || typeof d.toolUseId !== 'string' || idx.taskDeltas.has(d.toolUseId)) continue;
      if (idx.taskDeltas.size >= MAX_TASK_DELTAS) idx.taskDeltas.delete(idx.taskDeltas.keys().next().value);
      idx.taskDeltas.set(d.toolUseId, d);
      const main = this.byChar.get(e.sid);
      if (main?.kind !== 'main' || !main.announced || typeof main.state.applyExternalTask !== 'function') continue;
      const evs = main.state.applyExternalTask(d);
      if (evs?.length) this.ingest(main.path, evs);
    }
  }

  applyBufferedTasks(e) {
    if (e.kind !== 'main' || typeof e.state.applyExternalTask !== 'function') return;
    const list = [...(this.indexes.get(e.sid)?.taskDeltas.values() ?? [])];
    list.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
    for (const d of list) e.state.applyExternalTask(d); // 아직 알리기 전: 이벤트는 버리고 상태만 (snapshot 이 싣는다)
  }

  // 끝난 에이전트가 다시 일한다: doneAgents 에서 빼고, run 전체가 끝난 wf 도 이 에이전트만 살아 있게 표시한다.
  revive(idx, agentId) {
    idx.doneAgents.delete(agentId);
    idx.revived.add(agentId);
  }

  endAgent(agentId, ts, sid = null) {
    const e = this.byChar.get(agentId);
    const owner = sid ?? e?.sid;
    if (owner) {
      const idx = this.index(owner);
      idx.doneAgents.add(agentId);
      idx.revived.delete(agentId);
    }
    if (!e || e.kind === 'main' || (sid && e.sid !== sid)) return;
    e.doneAt = this.now();
    if (!e.announced || e.ended) {
      if (!e.announced) e.ended = true;
      return;
    }
    this.push({ type: 'session_end', sessionId: e.charId, ts: ts ?? new Date(this.now()).toISOString(), reason: 'done' });
  }

  isDone(e) {
    if (e.kind === 'main') return false;
    const idx = this.index(e.sid);
    if (idx.revived.has(e.charId)) return false;
    return idx.doneAgents.has(e.charId) || (e.kind === 'wf' && idx.doneRuns.has(e.runId));
  }

  // ---- events ---------------------------------------------------------------------------------

  // 파일 하나가 붙은 뒤(replay 끝) 열린 페이지에 새 직원을 알린다: session + snapshotEvents.
  announce(path) {
    const e = this.byPath.get(path);
    if (!e) return 0;
    this.applyBufferedTasks(e);
    e.announced = true;
    this.resolve(e);
    const before = this.lastSeq;
    if (this.isDone(e) || e.state.ended) {
      if (e.wasShown) {
        this.push({ type: 'session_end', sessionId: e.charId, ts: new Date(this.now()).toISOString(), reason: 'done' });
      }
      e.ended = true;
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
      if (!ev || typeof ev !== 'object') continue;
      if (e.kind !== 'main' && ev.type === 'prompt') continue;
      out.push(ev.type === 'session' ? this.patch(ev, this.byChar.get(ev.sessionId) ?? e) : ev);
    }
    return out;
  }

  // SessionState 가 만든 라이브 이벤트를 받는다.
  ingest(path, events) {
    if (!events?.length) return 0;
    const src = this.byPath.get(path) ?? null;
    const before = this.lastSeq;
    let mainSession = false;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
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
        if (e.kind !== 'main') this.revive(this.index(e.sid), e.charId); // snapshot()/announce() 도 살아 있게 본다
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
