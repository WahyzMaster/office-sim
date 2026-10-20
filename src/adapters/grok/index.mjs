// Grok (xAI Grok Build) 어댑터 설명자 (ADAPTERS 3.1, 5.2, CONTRACT 4.0.1). 탐색은 discover.mjs, 기록 정규화와 세션 상태는
// records.mjs / session.mjs (GrokSession, SessionCore 위에 선다). deps() 는 Runner 가 쓰는 묶음이고 GrokSession 은 처음
// 쓸 때 불러온다 (등록표를 import 하는 것만으로 세션 모듈을 읽지 않는다, claude-code 설명자와 같은 방식).
import path from 'node:path';
import { GROK_AGENT, createGrokScanner } from './discover.mjs';

export { GROK_AGENT };
export const SUMMARY_FILE = 'summary.json';
const SUB_KINDS = new Set(['subagent', 'subagent_resume']);

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * summary.json (rewritten in place) -> setInfo() fields { title: generated_title, cwd: info.cwd, branch: head_branch },
 * plus { subagent: true, agentType: agent_name } for a subagent session (session_kind subagent | subagent_resume; a
 * main's agent_name is the agent profile and is not used). `subagent` tells a session attached as a main (its parent
 * named it too late) that its human text is the parent's task: SessionCore then never sends it as a prompt or title.
 * No other field is kept (session_summary, last_recap, git_remotes, ...). `info.id` is only checked: a file that names
 * another session than this folder is ignored (null), so is anything that is not a JSON object. Throws on invalid JSON
 * (SidecarWatcher ignores it).
 */
export function parseSummary(buf, ref = null) {
  const obj = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const info = obj.info && typeof obj.info === 'object' && !Array.isArray(obj.info) ? obj.info : {};
  if (text(info.id) && text(ref?.sessionId) && info.id !== ref.sessionId) return null;
  const out = {};
  if (text(obj.generated_title)) out.title = obj.generated_title;
  if (text(info.cwd) && info.cwd.startsWith('/')) out.cwd = info.cwd;
  if (text(obj.head_branch)) out.branch = obj.head_branch;
  if (SUB_KINDS.has(obj.session_kind)) {
    out.subagent = true;
    if (text(obj.agent_name)) out.agentType = obj.agent_name;
  }
  return Object.keys(out).length ? out : null;
}

/** The sidecar hook (ADAPTERS 3.3): the session folder's summary.json, read by SidecarWatcher. */
export function grokSidecars(ref) {
  if (typeof ref?.path !== 'string') return [];
  return [{ path: path.join(path.dirname(ref.path), SUMMARY_FILE), parse: (buf) => parseSummary(buf, ref) }];
}

/**
 * D1 floor hint for a Grok-made worktree: a project inside `<root>/worktrees/<repo>/<name>` ->
 * { key: that worktree folder (its own floor), names: [repo, name] (floors to join by basename, in order),
 * badge: name }. Anything else (ordinary cwds, project-local `.worktrees/`) -> null: the shared projectKey decides.
 */
export function worktreeFloor(project, root) {
  if (typeof project !== 'string' || typeof root !== 'string' || root === '') return null;
  const base = `${path.join(root, 'worktrees')}/`;
  if (!project.startsWith(base)) return null;
  const [repo, name] = project.slice(base.length).split('/');
  if (!repo || !name) return null;
  return { key: `${base}${repo}/${name}`, names: [repo, name], badge: name };
}

export const grok = Object.freeze({
  id: GROK_AGENT,
  defaultRoot: '~/.grok', // --grok-root 기본값 (bin 이 채운다, CONTRACT 6)
  sidecars: grokSidecars,
  worktreeFloor,
  /**
   * The Runner deps: { agent, SessionState: GrokSession, Tailer, scan, sidecars, worktreeFloor }. `over` (test hook)
   * replaces any part. `scan` is a fresh stateful scanner per call (one per Runner, for the link grace).
   */
  async deps(over = {}) {
    const deps = { ...over };
    if (!deps.SessionState) deps.SessionState = (await import('./session.mjs')).GrokSession;
    if (!deps.Tailer) deps.Tailer = (await import('../../tailer.mjs')).Tailer;
    deps.scan ??= createGrokScanner();
    deps.sidecars ??= grokSidecars;
    deps.worktreeFloor ??= worktreeFloor;
    deps.agent ??= GROK_AGENT;
    return deps;
  },
});
