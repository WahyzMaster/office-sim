// GeminiCliSession: wraps `SessionCore` (`src/core/session-core.mjs`) to implement the `SessionLike`
// adapter contract (`ADAPTERS 3.2`) for the optional `gemini-cli` plug-in descriptor.
import { SessionCore } from '../../core/session-core.mjs';
import { isObj } from '../../core/session-items.mjs';
import { GEMINI_CLI_AGENT, normalizeGeminiRecord } from './records.mjs';

export class GeminiCliSession {
  constructor({
    id, agent = GEMINI_CLI_AGENT, kind = 'main', parentId = null, agentType = null, now = Date.now, facts = null,
  } = {}) {
    this.agent = typeof agent === 'string' && agent !== '' ? agent : GEMINI_CLI_AGENT;
    this.core = new SessionCore({ id, agent: this.agent, kind, parentId, agentType, now });
    this._skipped = 0;
    this._ctx = { seq: 0, pending: new Set(), hasCwd: false };
    if (isObj(facts) && typeof facts.cwd === 'string' && facts.cwd.trim() !== '') {
      this._ctx.hasCwd = true;
      this.core.setInfo({ cwd: facts.cwd.trim() });
    }
  }

  apply(rec, { replay = false } = {}) {
    const out = [];
    try {
      let parsed = rec;
      if (typeof rec === 'string') {
        if (rec.trim() === '') return out;
        parsed = JSON.parse(rec);
      }
      if (!isObj(parsed)) {
        this._skipped += 1;
        return out;
      }
      const items = normalizeGeminiRecord(parsed, this._ctx);
      for (const it of items) {
        for (const ev of this.core.apply(it, { replay })) out.push(this._patch(ev));
      }
    } catch {
      this._skipped += 1;
    }
    return out;
  }

  idle(nowMs) {
    return this.core.idle(nowMs).map((ev) => this._patch(ev));
  }

  setInfo(info) {
    if (!isObj(info)) return [];
    if (typeof info.cwd === 'string' && info.cwd.trim() !== '') this._ctx.hasCwd = true;
    return this.core.setInfo(info).map((ev) => this._patch(ev));
  }

  sessionEvent() {
    return this._patch(this.core.sessionEvent());
  }

  snapshotEvents() {
    return this.core.snapshotEvents().map((ev) => this._patch(ev));
  }

  _patch(ev) {
    return ev?.type === 'session' ? { ...ev, surface: 'cli' } : ev;
  }

  get title() { return this.core.title; }
  get firstCwd() { return this.core.firstCwd; }
  get lastActivityMs() { return this.core.lastActivityMs; }
  get ended() { return this.core.ended; }
  get skipped() { return this._skipped + this.core.skipped; }

  debugState() {
    return {
      ...this.core.debugState(),
      geminiCli: {
        skipped: this._skipped,
        pending: [...this._ctx.pending],
        hasCwd: this._ctx.hasCwd,
      },
    };
  }
}
