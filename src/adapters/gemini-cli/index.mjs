// Optional plug-in adapter descriptor for `@google/gemini-cli` (`~/.gemini/tmp/<project>/chats/session-*.json[l]`).
// Built on `SessionCore` (`src/core/session-core.mjs`) and verified by `test/fixtures/conformance.mjs`.
import { GEMINI_CLI_AGENT, GeminiCliTailer, createGeminiCliScanner } from './discover.mjs';

export { GEMINI_CLI_AGENT };

export const geminiCli = Object.freeze({
  id: GEMINI_CLI_AGENT,
  label: 'Gemini CLI',
  defaultRoot: '~/.gemini/tmp',
  async deps(over = {}) {
    const deps = { ...over };
    if (!deps.SessionState) deps.SessionState = (await import('./session.mjs')).GeminiCliSession;
    deps.Tailer ??= GeminiCliTailer;
    deps.scan ??= createGeminiCliScanner();
    deps.agent ??= GEMINI_CLI_AGENT;
    return deps;
  },
});
