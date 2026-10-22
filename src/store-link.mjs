// Store 가 여러 파일을 가로질러 서브에이전트를 연결하는 데 쓰는 순수 도우미.
// 원본 레코드에서 "연결에 필요한 사실"만 싸게 뽑는다 (내용은 절대 꺼내지 않는다).
import path from 'node:path';
import { cleanText } from './summarize.mjs';
import { CLAUDE_CODE_AGENT, agentScopedId } from './session-identity.mjs';

// 서브에이전트를 띄우거나 이어 가는 도구만 색인한다 (메모리 절약).
export const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'SendMessage']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
export const END_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed']);
const AGENT_ID_RE = /^a[0-9a-f]{16}$/;
const TRAILER_RE = /agentId: (a[0-9a-f]{16})\b/;

export function isAgentTool(name) {
  return AGENT_TOOLS.has(name);
}

export function looksLikeAgentId(s) {
  return typeof s === 'string' && AGENT_ID_RE.test(s);
}

function kindFromPath(p) {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf('subagents');
  if (i < 0) return 'main';
  return parts[i + 1] === 'workflows' ? 'wf' : 'sub';
}

/** The adapter id of a FileRef (4.0.1): `ref.agent`, or 'claude-code' when the ref has none. */
export function refAgent(ref) {
  return typeof ref?.agent === 'string' && ref.agent !== '' ? ref.agent : CLAUDE_CODE_AGENT;
}

// FileRef -> { kind, sid, charId, runId, runDir }. Claude 파일은 경로 구조(3.5)를 우선 믿고, 맞지 않으면 ref 필드를 쓴다.
// 다른 어댑터의 ref 는 경로를 해석하지 않는다: 그 어댑터의 탐색이 채운 kind/sid/charId/parentId 를 그대로 믿는다.
export function refIdentity(ref) {
  if (refAgent(ref) !== CLAUDE_CODE_AGENT) {
    const sid = ref.sid ?? ref.sessionId ?? null;
    return { kind: ref.kind ?? 'main', sid, charId: ref.charId ?? sid, runId: null, runDir: null, parentId: ref.parentId ?? null };
  }
  const p = ref.path;
  const kind = ref.kind ?? kindFromPath(p);
  const base = path.basename(p, '.jsonl');
  if (kind === 'main') {
    const sid = base || ref.stem || ref.sessionId;
    return { kind, sid, charId: sid, runId: null, runDir: null };
  }
  const agentId = base.startsWith('agent-') ? base.slice(6) : (ref.agentId ?? base);
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf('subagents');
  let sid = i > 0 ? parts[i - 1] : null;
  if (!sid) sid = ref.sessionId ?? null;
  let runId = null;
  let runDir = null;
  if (kind === 'wf') {
    runDir = path.dirname(p);
    runId = ref.runId ?? path.basename(runDir);
  }
  return { kind, sid, charId: agentId, runId, runDir };
}

/**
 * D2 at the Store boundary (F2, G2): a non-Claude ref may attach only when its charId, and its parentId and sid when
 * present (not null/undefined), are ids of its own agent (agentScopedId), and a main ref's sid equals its charId.
 * The sid is the owner and floor fallback of a sub, so a foreign sid would hand it another agent's parent or floor.
 * Claude refs are not checked.
 */
export function refIdsOk(ref) {
  const agent = refAgent(ref);
  if (agent === CLAUDE_CODE_AGENT) return true;
  const id = refIdentity(ref);
  const own = (v) => v == null || agentScopedId(agent, v);
  return agentScopedId(agent, id.charId) && own(id.parentId) && own(id.sid) && (id.kind !== 'main' || id.sid === id.charId);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text;
  return out;
}

// tool_result 본문 끝의 "agentId: a…" 꼬리표 (toolUseResult.agentId 가 없을 때의 대안).
export function trailerAgentId(block) {
  const m = TRAILER_RE.exec(contentText(block?.content));
  return m ? m[1] : null;
}

// Store 의 세션별 색인 (sid 하나에 하나).
export function newIndex() {
  return {
    toolOwner: new Map(),       // spawn tool_use id -> 그 tool_use 를 쓴 캐릭터 id
    toolName: new Map(),        // spawn tool_use id -> 도구 이름
    agentOwner: new Map(),      // agentId -> 부모 캐릭터 id (toolUseResult.agentId / 꼬리표)
    agentByToolUse: new Map(),  // Agent tool_use id -> agentId
    runByToolUse: new Map(),    // Workflow tool_use id -> runId
    runByTask: new Map(),       // Workflow taskId -> runId
    resumeByToolUse: new Map(), // SendMessage tool_use id -> resumedAgentId
    doneAgents: new Set(),
    doneRuns: new Set(),
    revived: new Set(),         // 끝난 뒤 다시 일하는 에이전트: doneAgents/doneRuns 보다 우선 (wf 는 run 전체가 done 이라서)
    doneKeys: new Set(),        // (tool-use-id, task-id, status) 중복 제거
    taskDeltas: new Map(),      // 서브 TaskCreate/TaskUpdate tool_use id -> delta (R36, 메인 화이트보드)
    stopped: new Map(),         // 서브를 아직 모르는 채 읽힌 Agent 오류/중단/완료 결과: tool_use id -> ts (R29)
  };
}

const MAX_STOPPED = 500;
export const MAX_INDEX_ENTRIES = 2000;

export function setCapped(map, key, val, max = MAX_INDEX_ENTRIES) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, val);
}

export function addCapped(set, val, max = MAX_INDEX_ENTRIES) {
  if (set.has(val)) set.delete(val);
  else if (set.size >= max) set.delete(set.values().next().value);
  set.add(val);
}

/** R29: the parent stopped waiting for a sync Agent before its sub was known (restart replay, meta.json late). */
export function rememberStopped(idx, tuId, ts) {
  setCapped(idx.stopped, tuId, ts, MAX_STOPPED);
}

/**
 * The remembered stop for sub entry `e` (matched by meta.toolUseId), consumed once: its ts (or null), or undefined
 * when there is none, it was already applied, or the agent was resumed (SendMessage) after that stop.
 */
export function takeStopped(idx, e) {
  const tu = e.meta?.toolUseId;
  if (e.kind !== 'sub' || typeof tu !== 'string' || !idx.stopped.has(tu)) return undefined;
  const ts = idx.stopped.get(tu);
  idx.stopped.delete(tu);
  const key = `r|${tu}`;
  if (idx.doneKeys.has(key) || idx.revived.has(e.charId)) return undefined;
  addCapped(idx.doneKeys, key);
  return ts ?? null;
}

/** Ring items after `seq`; null when `seq` already left the ring or belongs to another server run. */
export function ringSince(ring, lastSeq, seq) {
  const n = Number(seq);
  if (!Number.isInteger(n)) return null;
  if (n === lastSeq) return [];
  if (n > lastSeq) return null;
  const first = ring.length ? ring[0].seq : lastSeq + 1;
  if (n < first - 1) return null;
  return ring.filter((x) => x.seq > n);
}

export function isAsyncLaunchText(block) {
  const c = block?.content;
  const first = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : '';
  return typeof first === 'string' && first.trimStart().startsWith('Async agent launched');
}

export function sameSession(a, b) {
  const strip = (e) => JSON.stringify({ ...e, ts: undefined });
  return strip(a) === strip(b);
}

// SendMessage 결과의 resumedAgentId. 중첩 서브의 결과에는 toolUseResult 가 없고 본문이 그 JSON 이다.
export function resumedAgentIdOf(block, obj) {
  if (looksLikeAgentId(obj?.resumedAgentId)) return obj.resumedAgentId;
  const text = contentText(block?.content).trim();
  if (!text.startsWith('{') || text.length > 20_000) return null;
  try {
    const id = JSON.parse(text)?.resumedAgentId;
    return looksLikeAgentId(id) ? id : null;
  } catch {
    return null;
  }
}

function tag(block, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  const v = m ? m[1].trim() : '';
  return v || null;
}

// <task-notification> 블록들 -> [{ taskId, toolUseId, status }]
export function parseNotifications(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return [];
  const out = [];
  for (const chunk of text.split('<task-notification>').slice(1)) {
    const body = chunk.split('</task-notification>')[0];
    out.push({ taskId: tag(body, 'task-id'), toolUseId: tag(body, 'tool-use-id'), status: tag(body, 'status') });
  }
  return out;
}

function notificationText(rec) {
  if (rec.type === 'user') {
    const content = rec.message?.content;
    if (rec.origin?.kind === 'task-notification') return contentText(content);
    // 2.1.181 처럼 origin 이 없는 예전 기록
    if (!rec.origin && typeof content === 'string' && content.trimStart().startsWith('<task-notification>')) return content;
    return null;
  }
  if (rec.type === 'attachment') {
    const a = rec.attachment;
    if (a && a.type === 'queued_command' && a.commandMode === 'task-notification') {
      return typeof a.prompt === 'string' ? a.prompt : contentText(a.prompt);
    }
  }
  return null;
}

// 레코드 하나 -> 연결에 필요한 사실. 해당 없는 레코드는 null (대부분의 줄은 여기서 바로 끝난다).
export function linkFacts(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.type === 'assistant') {
    const content = rec.message?.content;
    if (!Array.isArray(content)) return null;
    let toolUses = null;
    for (const b of content) {
      if (b && b.type === 'tool_use' && typeof b.id === 'string' && SPAWN_TOOLS.has(b.name)) {
        (toolUses ??= []).push({ id: b.id, name: b.name });
      }
    }
    return toolUses ? { toolUses, results: null, notifications: null, endTurn: false } : null;
  }
  if (rec.type === 'user') {
    const content = rec.message?.content;
    let results = null;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') (results ??= []).push(b);
      }
    }
    const endTurn = !!results && (rec.toolEndsTurn === true || rec.mcpMeta?._meta?.['claude/endTurn'] === true);
    const text = results ? null : notificationText(rec);
    const notifications = text ? parseNotifications(text) : null;
    if (!results && !notifications?.length) return null;
    return { toolUses: null, results, notifications, endTurn };
  }
  if (rec.type === 'attachment') {
    const text = notificationText(rec);
    const notifications = text ? parseNotifications(text) : null;
    return notifications?.length ? { toolUses: null, results: null, notifications, endTurn: false } : null;
  }
  return null;
}

/** D1: the first floor whose label equals one of `names`, tried in order (<repo>, then <name>); else null. */
export function pickFloor(names, floors) {
  if (!Array.isArray(names) || !Array.isArray(floors)) return null;
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue;
    const hit = floors.find((f) => f?.projectLabel === name);
    if (hit) return hit;
  }
  return null;
}

// snapshot 순서: 메인, 그다음 부모가 이미 놓인(또는 살아 있지 않은) 서브. 순환이면 남은 것을 그대로 둔다.
// 부모 확인은 Set 으로 한다 (부모 없는 서브가 수천 개여도 선형).
export function parentFirst(live) {
  const liveIds = new Set(live.map((e) => e.charId));
  const placed = new Set();
  const ordered = [];
  let rest = live;
  while (rest.length) {
    const next = rest.filter((e) => e.kind === 'main' || placed.has(e.parent) || !liveIds.has(e.parent));
    const batch = next.length ? next : rest;
    for (const e of batch) { ordered.push(e); placed.add(e.charId); }
    rest = rest.filter((e) => !placed.has(e.charId));
  }
  return ordered;
}

// 코드 포인트 단위로 자르고 제어 문자를 지운다 (summarize.mjs 와 같은 규칙, 의존성 없이).
export function clip(text, max) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(clean);
  return cps.length <= max ? clean : cps.slice(0, max - 1).join('') + '…';
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// 4.3 서브에이전트 제목: meta name, description, journal label, workflowPhase, agentType, agentId.
// SessionState 의 제목은 쓰지 않는다 (서브 파일의 첫 사용자 레코드는 Agent prompt 라서).
export function subTitle(meta, label, agentId) {
  const t = nonEmpty(meta?.name) ?? nonEmpty(meta?.description) ?? nonEmpty(label)
    ?? nonEmpty(meta?.workflowPhase) ?? nonEmpty(meta?.agentType) ?? agentId;
  return cleanText(String(t), 80) || agentId; // session-identity.mjs 와 같은 규칙 (section 5 scrub + 80)
}

// ---- a character that moved to another file (P5e review finding 6) ---------------------------------------------------

/** The ids of the tools open in a session's snapshot (its tool_start events). Never throws: a failing state gives none. */
export function openToolIds(state) {
  const out = new Set();
  let evs = null;
  try {
    evs = state?.snapshotEvents?.();
  } catch {
    evs = null;
  }
  for (const ev of Array.isArray(evs) ? evs : []) if (ev?.type === 'tool_start' && typeof ev.toolUseId === 'string') out.add(ev.toolUseId);
  return out;
}

/**
 * After a move to another file, the tools the page still shows under the old file (`shownIds`) that are not open in the
 * new snapshot (`events`): tool_end `abandoned`, the core's shape (CONTRACT 4.0.2). Antigravity ids carry the line's
 * byte position, which differs between its two transcripts; stable ids that are still open come back, so nothing for
 * them (a tool that ended during the move closes `abandoned` instead of staying open on the page).
 */
export function staleToolEnds(shownIds, events, charId, ts) {
  if (!shownIds?.size) return [];
  const open = new Set(events.filter((ev) => ev?.type === 'tool_start').map((ev) => ev.toolUseId));
  return [...shownIds].filter((id) => !open.has(id))
    .map((id) => ({ type: 'tool_end', sessionId: charId, ts, toolUseId: id, ok: false, errorKind: 'abandoned', error: 'no result' }));
}
