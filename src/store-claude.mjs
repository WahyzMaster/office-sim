// Claude Code 서브에이전트 연결 (contract 4.5, R28/R29, R36 전달). P5a 에서 store.mjs 에서 떼어 냈다.
// Store 는 entry 의 agent 가 'claude-code' 일 때만 이 함수들을 부른다. 상태(등록부, sid 별 색인)는 Store 에 있고,
// 여기 함수는 그 Store 를 첫 인자로 받는다. 동작은 떼어 내기 전과 같다 (기존 테스트가 지킨다).
import {
  linkFacts, isAgentTool, looksLikeAgentId, trailerAgentId, END_STATUSES, isAsyncLaunchText, resumedAgentIdOf,
  rememberStopped, takeStopped, setCapped, addCapped,
} from './store-link.mjs';

const MAX_TASK_DELTAS = 500; // 세션 하나에 보관하는 서브 TaskCreate/TaskUpdate (메인이 다시 붙을 때 다시 적용)

// ---- parent (4.5) -------------------------------------------------------------------------------

/** Claude sub/wf entry: find the owner of its Agent tool_use (or the main session). Returns true when it changed. */
export function resolve(store, e) {
  const before = `${e.parent}|${e.resolved}`;
  if (e.kind === 'wf') {
    e.parent = e.sid;
    e.resolved = true;
  } else {
    const idx = store.index(e.sid);
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

// ---- late meta.json / journal labels ------------------------------------------------------------

export function setMeta(store, e, meta) {
  if (!meta) return;
  e.meta = meta;
  e.metaPending = false;
  store.resolve(e);
  store.syncInfo(e);
  endIfStopped(store, e);
  store.refreshSubs(e.sid);
}

// R29: 부모가 이 서브(meta.toolUseId)를 기다리지 않게 된 결과가 서브보다 먼저 읽혔다 (재시작 replay, 늦은 meta.json)
export function endIfStopped(store, e) {
  const ts = e.kind === 'sub' ? takeStopped(store.index(e.sid), e) : undefined;
  if (ts !== undefined) endAgent(store, e.charId, ts, e.sid);
}

export function setLabel(store, e, label) {
  if (!label || e.label === label) return;
  e.label = label;
  store.syncInfo(e);
  store.refreshSubs(e.sid);
}

// meta 가 아직 없는 서브 (jsonl 보다 1초 이상 늦게 생기는 경우가 있다). metaPending 은 Claude 서브에만 선다.
export function pendingMeta(store) {
  return [...store.byPath.values()].filter((e) => e.metaPending).map((e) => e.path);
}

// journal label 이 필요한 wf 에이전트: [{ path, runDir, charId }]
export function pendingLabels(store, agent) {
  return [...store.byPath.values()]
    .filter((e) => e.agent === agent && e.kind === 'wf' && !e.label && !e.meta?.name && !e.meta?.description)
    .map((e) => ({ path: e.path, runDir: e.runDir, charId: e.charId }));
}

// ---- cross-file signals -------------------------------------------------------------------------

// 서버가 파일의 모든 레코드를 (replay 포함) 여기에 넘긴다. 색인 + 부모 쪽 신호로 서브 끝내기.
export function observe(store, e, rec) {
  const facts = linkFacts(rec);
  if (!facts) return;
  // R10: 메인 파일의 다른 sessionId 레코드는 fork 기록이다
  if (e.kind === 'main' && typeof rec.sessionId === 'string' && rec.sessionId !== e.sid) return;
  const idx = store.index(e.sid);
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  let linked = false;
  for (const tu of facts.toolUses ?? []) {
    if (!idx.toolOwner.has(tu.id)) linked = true;
    setCapped(idx.toolOwner, tu.id, e.charId);
    setCapped(idx.toolName, tu.id, tu.name);
  }
  for (const block of facts.results ?? []) {
    if (onResult(store, idx, e.sid, block, rec.toolUseResult, ts)) linked = true;
  }
  for (const n of facts.notifications ?? []) onNotification(store, idx, e.sid, n, ts);
  // R29: 서브 파일 자신의 endTurn 결과 (StructuredOutput / SubagentHandback)
  if (facts.endTurn && e.kind !== 'main') endAgent(store, e.charId, ts, e.sid);
  if (linked && store.subsOf(e.sid).some((s) => !s.resolved)) store.refreshSubs(e.sid);
}

function onResult(store, idx, sid, block, tur, ts) {
  const tuId = block.tool_use_id;
  const name = idx.toolName.get(tuId);
  if (!name) return false;
  const obj = tur && typeof tur === 'object' && !Array.isArray(tur) ? tur : null;
  let linked = false;
  if (isAgentTool(name)) {
    let agentId = looksLikeAgentId(obj?.agentId) ? obj.agentId : null;
    // 중첩 서브의 결과에는 toolUseResult 가 없다: 본문 꼬리표 "agentId: a…" 로 대신한다
    const trailer = agentId ? null : trailerAgentId(block);
    if (!agentId) agentId = trailer ?? subByToolUse(store, tuId, sid)?.charId ?? null;
    const completed = obj ? obj.status === 'completed' : !!trailer && !block.is_error && !isAsyncLaunchText(block);
    // 오류/중단/거절된 결과: 부모가 동기 에이전트를 더 기다리지 않는다 (비동기 실행은 is_error 가 없다)
    const terminal = completed || block.is_error === true;
    if (agentId) {
      if (!idx.agentOwner.has(agentId)) linked = true;
      setCapped(idx.agentOwner, agentId, idx.toolOwner.get(tuId));
      setCapped(idx.agentByToolUse, tuId, agentId);
      if (terminal) {
        const key = `r|${tuId}`;
        if (!idx.doneKeys.has(key)) {
          addCapped(idx.doneKeys, key);
          endAgent(store, agentId, ts, sid);
        }
      }
    } else if (terminal) {
      rememberStopped(idx, tuId, ts); // 오류 결과에는 agentId 가 없다: 서브(meta.toolUseId)가 붙을 때 끝낸다
    }
  } else if (name === 'Workflow' && obj) {
    if (typeof obj.runId === 'string') {
      setCapped(idx.runByToolUse, tuId, obj.runId);
      if (typeof obj.taskId === 'string') setCapped(idx.runByTask, obj.taskId, obj.runId);
    }
  } else if (name === 'SendMessage') {
    const resumed = resumedAgentIdOf(block, obj);
    if (resumed) {
      setCapped(idx.resumeByToolUse, tuId, resumed);
      revive(idx, resumed); // 끝났던 에이전트가 다시 일한다: 유예 시간 없이 바로 되살린다
      const e = store.byChar.get(resumed);
      if (e && e.sid === sid) e.doneAt = 0;
    }
  }
  return linked;
}

function onNotification(store, idx, sid, n, ts) {
  if (!END_STATUSES.has(n.status)) return; // <status> 없는 진행 알림
  const key = `n|${n.toolUseId}|${n.taskId}|${n.status}`;
  if (idx.doneKeys.has(key)) return;
  addCapped(idx.doneKeys, key);
  const agents = new Set();
  const runs = new Set();
  if (n.toolUseId) {
    const a = idx.agentByToolUse.get(n.toolUseId) ?? idx.resumeByToolUse.get(n.toolUseId)
      ?? subByToolUse(store, n.toolUseId, sid)?.charId;
    if (a) agents.add(a);
    const r = idx.runByToolUse.get(n.toolUseId);
    if (r) runs.add(r);
  }
  if (n.taskId) {
    if (looksLikeAgentId(n.taskId)) agents.add(n.taskId);
    const r = idx.runByTask.get(n.taskId);
    if (r) runs.add(r);
  }
  for (const a of agents) endAgent(store, a, ts, sid);
  for (const r of runs) {
    addCapped(idx.doneRuns, r);
    for (const e of store.subsOf(sid)) if (e.kind === 'wf' && e.runId === r) endAgent(store, e.charId, ts, sid);
  }
}

export function subByToolUse(store, tuId, sid = null) {
  for (const e of sid ? (store.bySid.get(sid) ?? []) : store.byPath.values()) {
    if (e.kind === 'sub' && e.meta?.toolUseId === tuId) return e;
  }
  return null;
}

// ---- R36 task list forwarding -------------------------------------------------------------------

// 서브 파일의 TaskCreate/TaskUpdate 는 같은 세션 메인의 작업 목록을 바꾼다. 메인이 아직 알려지지 않았으면
// 모아 두었다가 announce 때 (메인 replay 가 끝난 뒤) 적용한다. 시각 비교는 SessionState 가 한다.
export function taskDeltas(store, e, deltas) {
  if (e.kind === 'main' || !deltas?.length) return;
  const idx = store.index(e.sid);
  for (const d of deltas) {
    if (!d || typeof d.toolUseId !== 'string' || idx.taskDeltas.has(d.toolUseId)) continue;
    if (idx.taskDeltas.size >= MAX_TASK_DELTAS) idx.taskDeltas.delete(idx.taskDeltas.keys().next().value);
    idx.taskDeltas.set(d.toolUseId, d);
    const main = store.byChar.get(e.sid);
    if (main?.kind !== 'main' || !main.announced || typeof main.state.applyExternalTask !== 'function') continue;
    const evs = main.state.applyExternalTask(d);
    if (evs?.length) store.ingest(main.path, evs);
  }
}

export function applyBufferedTasks(store, e) {
  if (e.kind !== 'main' || typeof e.state.applyExternalTask !== 'function') return;
  const list = [...(store.indexes.get(e.sid)?.taskDeltas.values() ?? [])];
  list.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  for (const d of list) e.state.applyExternalTask(d); // 아직 알리기 전: 이벤트는 버리고 상태만 (snapshot 이 싣는다)
}

// ---- done / revived -----------------------------------------------------------------------------

// 끝난 에이전트가 다시 일한다: doneAgents 에서 빼고, run 전체가 끝난 wf 도 이 에이전트만 살아 있게 표시한다.
export function revive(idx, agentId) {
  idx.doneAgents.delete(agentId);
  addCapped(idx.revived, agentId);
}

// Store 쪽 신호(부모 결과, 알림, endTurn)로 끝난 서브. 아직 알리기 전이면 표시만 해 둔다 (announce 가 알리지 않는다).
export function endAgent(store, agentId, ts, sid = null) {
  const e = store.byChar.get(agentId);
  const owner = sid ?? e?.sid;
  if (owner) {
    const idx = store.index(owner);
    addCapped(idx.doneAgents, agentId);
    idx.revived.delete(agentId);
  }
  if (!e || e.kind === 'main' || (sid && e.sid !== sid)) return;
  e.doneAt = store.now();
  if (!e.announced || e.ended) {
    if (!e.announced) e.ended = true;
    return;
  }
  store.push({ type: 'session_end', sessionId: e.charId, ts: ts ?? new Date(store.now()).toISOString(), reason: 'done' });
}

export function isDone(store, e) {
  if (e.kind === 'main') return false;
  const idx = store.index(e.sid);
  if (idx.revived.has(e.charId)) return false;
  return idx.doneAgents.has(e.charId) || (e.kind === 'wf' && idx.doneRuns.has(e.runId));
}
