// Claude Code 어댑터 설명자 (contract 4.0.1, 결정 D8). Claude 모듈(session, tailer, discover, replay)은 제자리에 두고
// 여기서 가리키기만 한다. deps() 는 P5a 전에 server.mjs 의 loadDeps() 가 Runner 에 넣던 묶음과 같고, agent id 가 더해졌다.
import { CLAUDE_CODE_AGENT } from '../session-identity.mjs';

export const claudeCode = Object.freeze({
  id: CLAUDE_CODE_AGENT,
  defaultRoot: '~/.claude/projects', // --claude-root (--root) 기본값. start() 의 root 옵션이 이 루트다
  /**
   * The Runner deps: { agent, SessionState, Tailer, scan, readSubMeta, readJournalLabels }.
   * `over` (test hook) replaces any part; the rest is loaded from the Claude modules in place.
   */
  async deps(over = {}) {
    const deps = { ...over };
    if (!deps.SessionState) deps.SessionState = (await import('../session.mjs')).SessionState;
    if (!deps.Tailer) deps.Tailer = (await import('../tailer.mjs')).Tailer;
    if (!deps.scan || !deps.readSubMeta || !deps.readJournalLabels) {
      const d = await import('../discover.mjs');
      deps.scan ??= d.scan;
      deps.readSubMeta ??= d.readSubMeta;
      deps.readJournalLabels ??= d.readJournalLabels;
    }
    deps.agent ??= CLAUDE_CODE_AGENT;
    return deps;
  },
  /** --replay (contract 6.1): replay is Claude Code only (D12). */
  async replayRunner() {
    return (await import('../replay.mjs')).ReplayRunner;
  },
});
