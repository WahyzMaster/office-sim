// Codex (OpenAI Codex: 데스크톱 앱, CLI, IDE 확장) 어댑터 설명자 (ADAPTERS 3.1, 5.1, 6.3, CONTRACT 4.0.1). 탐색은
// discover.mjs (첫 줄 사실은 line0.mjs), 제목은 titles.mjs (session_index.jsonl 을 이어 읽기), 기록 정규화와 세션 상태는
// records.mjs / session.mjs (CodexSession, SessionCore 위에 선다). deps() 는 Runner 가 쓰는 묶음이고 CodexSession 은 처음
// 쓸 때 불러온다 (등록표를 import 하는 것만으로 세션 모듈을 읽지 않는다, Grok 설명자와 같은 방식).
import path from 'node:path';
import { CODEX_AGENT, createCodexScanner } from './discover.mjs';
import { CodexTitles } from './titles.mjs';

export { CODEX_AGENT };

/**
 * D1 floor hint for a Codex-managed worktree: a project inside `<root>/worktrees/<id>/<name>` ->
 * { key: that worktree folder (its own floor), names: [name] (the floor to join by basename; <id> is opaque),
 * badge: name }. Anything else (ordinary cwds, project-local `.worktrees/`) -> null: the shared projectKey decides.
 */
export function worktreeFloor(project, root) {
  if (typeof project !== 'string' || typeof root !== 'string' || root === '') return null;
  const base = `${path.join(root, 'worktrees')}/`;
  if (!project.startsWith(base)) return null;
  const [id, name] = project.slice(base.length).split('/');
  if (!id || !name) return null;
  return { key: `${base}${id}/${name}`, names: [name], badge: name };
}

export const codex = Object.freeze({
  id: CODEX_AGENT,
  defaultRoot: '~/.codex', // --codex-root 기본값 (bin 이 채운다, CONTRACT 6)
  worktreeFloor,
  /**
   * The Runner deps: { agent, SessionState: CodexSession, Tailer, scan, sidecarWatcher: CodexTitles, worktreeFloor }.
   * The scan reads line 0 (session_meta) for kind, parent and guardian and puts the rest of its facts on the ref
   * (`ref.facts`: cwd, branch, cliVersion, historyStart, a sub's agentType), which the Runner passes to the session
   * constructor as `facts`; CodexSession also reads its own line 0 from the transcript. `over` (test hook)
   * replaces any part. `scan` and the titles watcher are fresh per call (one per Runner: the scanner keeps its
   * date-folder and line-0 caches, the watcher its read offset).
   */
  async deps(over = {}) {
    const deps = { ...over };
    if (!deps.SessionState) deps.SessionState = (await import('./session.mjs')).CodexSession;
    if (!deps.Tailer) deps.Tailer = (await import('../../tailer.mjs')).Tailer;
    deps.scan ??= createCodexScanner();
    deps.sidecarWatcher ??= new CodexTitles();
    deps.worktreeFloor ??= worktreeFloor;
    deps.agent ??= CODEX_AGENT;
    return deps;
  },
});
