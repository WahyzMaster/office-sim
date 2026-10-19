// Session identity for session.mjs (pure): titles (4.3), project / worktree / branch (4.4).
import { cleanText } from './summarize.mjs';
import { projectKey, worktreeFromPath, basename } from './session-util.mjs';

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function metaObj(info) {
  return info && info.subMeta && typeof info.subMeta === 'object' ? info.subMeta : {};
}

/**
 * Main title, first that exists: custom-title, agent-name, <sid>/custom-title.json, legacy summary,
 * first human prompt (<= 40), last-prompt (<= 40), first 8 chars of the stem.
 */
export function mainTitle({ meta, info, firstPrompt, stem, id }) {
  return cleanText(meta.title, 80) || cleanText(meta.agentName, 80) || cleanText(info.fileTitle, 80)
    || cleanText(meta.summary, 80) || cleanText(firstPrompt, 40) || cleanText(meta.lastPrompt, 40)
    || String(stem || id || '').slice(0, 8);
}

/** Subagent title: meta name, description, journal label, workflowPhase, meta agentType, agentId. */
export function subTitle({ info, agentType, id }) {
  const meta = metaObj(info);
  return cleanText(meta.name, 80) || cleanText(meta.description, 80) || cleanText(info.journalLabel, 80)
    || cleanText(meta.workflowPhase, 80) || cleanText(meta.agentType, 80) || cleanText(agentType, 80)
    || String(id || '');
}

/** Worktree badge: latest worktree-state name, else the latest cwd inside a worktree, else null. */
export function worktreeName(worktreeState, lastCwd) {
  if (worktreeState) {
    return str(worktreeState.worktreeName) || worktreeFromPath(worktreeState.worktreePath)
      || worktreeFromPath(lastCwd) || null;
  }
  return worktreeFromPath(lastCwd);
}

// 세션 / 에이전트 id: uuid, a<16 hex>, 파일 이름에서 온 id. 그 밖의 글자(@, /, 공백 ...)가 있으면 id 가 아니다.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LABEL_MAX = 60;

/** Section 5 for identity labels (branch, worktree, agentType): same scrub as every event text, capped. */
export function cleanLabel(value) {
  return cleanText(value, LABEL_MAX) || null;
}

/** A parent id fit to send: strict charset and cap, else null. */
export function publicSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value) ? value : null;
}

/** The `session` event from a plain view of SessionState fields. */
export function buildSessionEvent(s) {
  const isSub = s.kind !== 'main';
  // 세션을 다른 폴더로 옮기면(relocated) 옮긴 폴더의 층으로 간다. 없으면 처음 작업 폴더.
  const project = str(s.info.parentProject) || projectKey(str(s.meta?.relocatedCwd) || s.firstCwd, s.worktreeSticky);
  // 부모 id 가 id 모양이 아니면 메인 세션(stem)으로 (store.mjs 도 연결을 못 찾으면 메인 세션을 부모로 쓴다)
  const stem = publicSessionId(s.stem) !== s.id ? publicSessionId(s.stem) : null;
  const ev = {
    type: 'session',
    sessionId: s.id,
    ts: s.ts,
    project,
    projectLabel: basename(project),
    title: isSub ? subTitle(s) : mainTitle(s),
    branch: s.branch === 'HEAD' ? 'detached' : cleanLabel(s.branch),
    worktree: cleanLabel(worktreeName(s.worktreeState, s.lastCwd)),
    isSubagent: isSub,
    parentSessionId: isSub && s.parentId != null ? publicSessionId(s.parentId) ?? stem : null,
  };
  if (isSub) ev.agentType = cleanLabel(s.agentType) || cleanLabel(metaObj(s.info).agentType);
  return ev;
}
