// P3 & P4: Context window fuel occupancy, token burn estimator, compaction counter,
// unreviewed "Done" badge state, and 1-click Sprint Recap builder.
import { cleanText } from './summarize.mjs';
import { publicSessionId } from './session-identity.mjs';
import { basename } from './session-util.mjs';

export const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_TRACKED_SESSIONS = 500;
const MAX_FILES_PER_SESSION = 40;

// Approximate per-million-token blended USD rate for lightweight developer cost awareness.
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;
const COST_PER_M_CACHE_READ = 0.3;

export class SessionRecapTracker {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessions = new Map(); // sessionId -> metrics record
  }

  ensure(sessionId) {
    const sid = publicSessionId(sessionId);
    if (!sid) return null;
    let rec = this.sessions.get(sid);
    if (!rec) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      rec = {
        sessionId: sid,
        agent: 'claude-code',
        title: sid.slice(0, 8),
        projectLabel: 'Global',
        branch: null,
        worktree: null,
        startedAt: this.now(),
        lastActivityAt: this.now(),
        turns: 0,
        compactions: 0,
        apiErrors: 0,
        toolCalls: 0,
        toolErrors: 0,
        toolCounts: {},
        filesTouched: [],
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        cacheReadTokens: 0,
        contextTokens: 0,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        unreviewedDone: false,
        ended: false,
      };
      this.sessions.set(sid, rec);
    }
    return rec;
  }

  /**
   * Observe a wire event emitted by Store (privacy-scrubbed).
   */
  observeEvent(ev) {
    if (!ev || typeof ev !== 'object' || !ev.sessionId) return;
    const rec = this.ensure(ev.sessionId);
    if (!rec) return;
    rec.lastActivityAt = this.now();

    switch (ev.type) {
      case 'session': {
        if (ev.agent) rec.agent = ev.agent;
        if (ev.title) rec.title = cleanText(ev.title, 80) || rec.title;
        if (ev.projectLabel) rec.projectLabel = cleanText(ev.projectLabel, 60) || rec.projectLabel;
        if (ev.branch) rec.branch = cleanText(ev.branch, 60);
        if (ev.worktree) rec.worktree = cleanText(ev.worktree, 60);
        break;
      }
      case 'prompt': {
        rec.unreviewedDone = false;
        rec.estimatedInputTokens += 650;
        rec.contextTokens = Math.min(rec.contextWindow, rec.contextTokens + 650);
        break;
      }
      case 'thinking': {
        rec.estimatedOutputTokens += 450;
        rec.contextTokens = Math.min(rec.contextWindow, rec.contextTokens + 450);
        break;
      }
      case 'say': {
        const len = typeof ev.text === 'string' ? ev.text.length : 80;
        const toks = Math.max(80, Math.round(len * 1.5));
        rec.estimatedOutputTokens += toks;
        rec.contextTokens = Math.min(rec.contextWindow, rec.contextTokens + toks);
        break;
      }
      case 'tool_start': {
        rec.toolCalls += 1;
        const tool = cleanText(ev.tool || 'tool', 40) || 'tool';
        rec.toolCounts[tool] = (rec.toolCounts[tool] || 0) + 1;
        rec.estimatedInputTokens += 900;
        rec.contextTokens = Math.min(rec.contextWindow, rec.contextTokens + 900);
        if (typeof ev.summary === 'string' && ev.summary.trim()) {
          const tokenCandidate = ev.summary.trim().split(/\s+/)[0];
          if (tokenCandidate && /\.[a-z0-9]{1,8}$/i.test(tokenCandidate)) {
            const safeBase = cleanText(basename(tokenCandidate), 60);
            if (safeBase && !rec.filesTouched.includes(safeBase) && rec.filesTouched.length < MAX_FILES_PER_SESSION) {
              rec.filesTouched.push(safeBase);
            }
          }
        }
        break;
      }
      case 'tool_end': {
        if (ev.ok === false && ev.errorKind !== 'abandoned') {
          rec.toolErrors += 1;
        }
        break;
      }
      case 'turn_end': {
        rec.turns += 1;
        rec.unreviewedDone = true;
        break;
      }
      case 'session_end': {
        rec.ended = true;
        rec.unreviewedDone = true;
        break;
      }
      case 'system': {
        if (ev.kind === 'compact') {
          rec.compactions += 1;
          rec.contextTokens = Math.round(rec.contextTokens * 0.35);
        } else if (ev.kind === 'api_error') {
          rec.apiErrors += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  markReviewed(sessionId) {
    const sid = publicSessionId(sessionId);
    if (!sid) return false;
    const rec = this.sessions.get(sid);
    if (!rec) return false;
    rec.unreviewedDone = false;
    return true;
  }

  getRecap(sessionId) {
    const sid = publicSessionId(sessionId);
    if (!sid) return null;
    const rec = this.sessions.get(sid);
    if (!rec) return null;

    const durationSec = Math.max(1, Math.round((rec.lastActivityAt - rec.startedAt) / 1000));
    const contextOccupancyPct = Math.min(100, Math.round((rec.contextTokens / rec.contextWindow) * 100));
    const estimatedCostUsd = Number((
      (rec.estimatedInputTokens / 1_000_000) * COST_PER_M_INPUT
      + (rec.estimatedOutputTokens / 1_000_000) * COST_PER_M_OUTPUT
      + (rec.cacheReadTokens / 1_000_000) * COST_PER_M_CACHE_READ
    ).toFixed(4));

    const topTools = Object.entries(rec.toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => `${name} (${count})`);

    const markdown = [
      `## Sprint Session Recap — ${rec.title} (${rec.projectLabel})`,
      '',
      `- **Agent**: \`${rec.agent}\`${rec.branch ? ` · **Branch**: \`${rec.branch}\`` : ''}${rec.worktree ? ` (\`${rec.worktree}\`)` : ''}`,
      `- **Duration**: ${durationSec}s · **Turns**: ${rec.turns} · **Status**: ${rec.ended ? 'Completed' : (rec.unreviewedDone ? 'Turn Done (Needs Review)' : 'Active')}`,
      `- **Context Fuel**: ${contextOccupancyPct}% (${rec.contextTokens.toLocaleString()} / ${rec.contextWindow.toLocaleString()} tokens) · **Compactions**: ${rec.compactions}`,
      `- **Est. Token Spend**: ~$${estimatedCostUsd.toFixed(4)} (${rec.estimatedInputTokens.toLocaleString()} in / ${rec.estimatedOutputTokens.toLocaleString()} out)`,
      `- **Tool Calls**: ${rec.toolCalls} (${rec.toolErrors} failed)${topTools.length ? ` — ${topTools.join(', ')}` : ''}`,
      rec.filesTouched.length ? `- **Files Touched**: ${rec.filesTouched.map((f) => `\`${f}\``).join(', ')}` : '- **Files Touched**: (none recorded)',
    ].join('\n');

    return {
      sessionId: rec.sessionId,
      agent: rec.agent,
      title: rec.title,
      projectLabel: rec.projectLabel,
      branch: rec.branch,
      worktree: rec.worktree,
      durationSec,
      turns: rec.turns,
      compactions: rec.compactions,
      apiErrors: rec.apiErrors,
      toolCalls: rec.toolCalls,
      toolErrors: rec.toolErrors,
      toolCounts: { ...rec.toolCounts },
      filesTouched: [...rec.filesTouched],
      contextTokens: rec.contextTokens,
      contextWindow: rec.contextWindow,
      contextOccupancyPct,
      estimatedInputTokens: rec.estimatedInputTokens,
      estimatedOutputTokens: rec.estimatedOutputTokens,
      estimatedCostUsd,
      unreviewedDone: rec.unreviewedDone,
      ended: rec.ended,
      markdown,
    };
  }

  summaryList() {
    const out = [];
    for (const sid of this.sessions.keys()) {
      const r = this.getRecap(sid);
      if (r) out.push(r);
    }
    return out;
  }
}
