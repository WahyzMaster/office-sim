// POST /api/hooks/claude (contract 7.2, launch readiness D13 to D16 and D25). Claude Code hooks add one signal the
// transcript lacks: a permission prompt is open. A PermissionRequest (or the later Notification of type
// permission_prompt) becomes one `tool_wait { toolUseId, waiting: true }` for an open tool of that session.
// The hook body has no tool_use id, so the bridge keeps its own list of open tools from the events the Store pushes
// (tool_start opens, tool_end closes, session_end clears) and picks the newest open, non-ask tool of the same name.
// Nothing of a body is kept but ids and a tool name: of a wait that is still held (HOLD_MS), for the repeat rule of a
// permission event that sent or held a wait (DEDUP_MS), of a sent wait while its tool is in the open list, and of a
// tool that a session only hooks report has open (legacyTools).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeHookPayload } from './hooks-receiver.mjs';
import { publicSessionId, CLAUDE_CODE_AGENT } from './session-identity.mjs';
import { publicToolName, iso } from './session-util.mjs';
import { isBlockingAskToolStart, ASK_TOOLS } from './system-notify.mjs';

/** D16: the hook route reads bodies up to 1 MiB (a Write or Edit tool_input is large); other JSON routes keep 4096. */
export const HOOK_MAX_BODY = 1024 * 1024;
/** A prompt whose tool_use line the tailer has not read yet is held this long, then forgotten. */
export const HOLD_MS = 10_000;
export const MAX_HELD = 64;
/**
 * The same permission event (session, agent id, tool name) again within this time is the same prompt: one hook
 * installed twice (settings.json and the plugin) posts two bodies. A second real prompt cannot open that fast.
 */
export const DEDUP_MS = 1000;
const MAX_RECENT = 256; // permission events remembered for DEDUP_MS
const MAX_TOOL_NAME = 200;
const MAX_CHARS = 1000; // characters with open tools; beyond it the oldest character's list goes
const MAX_TOOLS = 256; // open tools remembered per character
const MAX_LEGACY_TOOLS = 500;
const MAX_PATH = 4096; // a longer transcript_path is not looked up
const MAX_UP = 64; // folders climbed to find one that exists
const OK = Object.freeze({ status: 200, body: Object.freeze({}) });
const BAD = Object.freeze({ status: 400, body: Object.freeze({ error: 'invalid hook payload' }) });

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const waitKey = (charId, toolUseId) => `${charId}|${toolUseId}`;
// the tool name as tool_start.tool carries it (a connector uuid in an mcp name is masked), or null
const wireTool = (v) => (typeof v === 'string' && v !== '' && v.length <= MAX_TOOL_NAME ? publicToolName(v) : null);
// AskUserQuestion, ExitPlanMode and the like walk to the desk on their own: never the target of a wait
const isAsk = (ev) => 'question' in ev || 'options' in ev || isBlockingAskToolStart(ev);

// strictly inside: not the root itself, not a sibling whose name starts like it, not above it
function inside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// A folder path as the file system spells it (links followed, letter case as stored). It need not exist: the nearest
// folder that does is resolved and the rest is appended as given. Nothing is opened or listed. null: no answer.
function realOf(p) {
  let dir = p;
  const rest = [];
  for (let i = 0; i < MAX_UP; i += 1) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch (err) {
      const up = path.dirname(dir);
      if ((err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') || up === dir) return null;
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
  return null;
}

export class HooksBridge {
  /**
   * @param {{ store: { push(ev): void, byChar?: Map<string, { agent?: string, sid?: string }> }, claudeRoot?: string|null,
   *   now?: () => number, holdMs?: number, maxHeld?: number, dedupMs?: number, log?: Function }} o
   *   store.push must reach observeEvent() after the Store kept the event (server-http.mjs wraps push that way), so a
   *   tool_wait sent from there lands right behind its tool_start. claudeRoot null: no transcript_path check (D15).
   */
  constructor({ store, claudeRoot = null, now = Date.now, holdMs = HOLD_MS, maxHeld = MAX_HELD, dedupMs = DEDUP_MS, log = () => {} } = {}) {
    Object.assign(this, { store, now, holdMs, maxHeld, dedupMs, log });
    this.root = typeof claudeRoot === 'string' && claudeRoot !== '' ? path.resolve(claudeRoot) : null;
    this.realRoot = undefined; // the root as the file system spells it, or null: looked up once, see inRoot
    this.open = new Map(); // charId -> Map(toolUseId -> { tool, ask, waited }), oldest first
    this.waits = new Map(); // `${charId}|${toolUseId}` -> { ev, sid }: the sent tool_wait of a tool that is still open
    this.held = []; // [{ sid, charId, tool, key, at }] oldest first: PermissionRequests whose tool_start was not pushed yet
    this.recent = new Map(); // repeat key -> ms: permission events that sent or held a wait, oldest first (DEDUP_MS)
    this.legacyTools = new Map(); // hook-only sessions: `${sessionId}:${tool}` -> the synthetic tool id (hooks-receiver)
    this.legacyOpen = new Map(); // hook-only sessions: sessionId -> Set<toolUseId> of open synthetic tools
    this._inLegacy = false;
    this.counts = { waits: 0, duplicates: 0, unmatched: 0, expired: 0, dropped: 0, ignored: 0, foreign: 0, legacy: 0 };
    this.warned = false;
  }

  /** Counters only (numbers): waits sent, held and open now, and what was ignored and why. */
  stats() {
    this.prune();
    return { ...this.counts, held: this.held.length, openWaits: this.waits.size };
  }

  /**
   * One parsed hook body -> { status, body }. 200 {} for everything accepted or ignored, 400 only without a usable
   * session id (D16). Reads session_id, transcript_path, hook_event_name, notification_type, agent_id and (of a
   * PermissionRequest) tool_name; a hook-only session (D14) also goes through parseClaudeHookPayload. The body is
   * not kept.
   */
  handle(payload) {
    this.prune();
    if (!isRecord(payload)) return BAD;
    const sid = publicSessionId(typeof payload.session_id === 'string' ? payload.session_id.trim() : null);
    if (!sid) return BAD;
    if (typeof payload.transcript_path === 'string' && this.root && !this.inRoot(payload.transcript_path)) return this.foreign();
    const main = this.store.byChar?.get(sid) ?? null;
    if (main && main.agent !== CLAUDE_CODE_AGENT) return this.foreign(); // an id of another adapter's character
    if (main) this.purgeLegacy(sid);
    const name = typeof payload.hook_event_name === 'string' ? payload.hook_event_name.trim() : '';
    if (name === 'PermissionRequest') this.permission(sid, payload, true);
    else if (name === 'Notification') this.notification(sid, payload, main !== null);
    else if (main || !name) this.count('ignored'); // D14: the transcript is the source for a followed session
    else this.legacy(payload);
    return OK;
  }

  // D15: another agent that runs Claude hook files posts its own transcript path; it must not show as Claude Code
  foreign() {
    this.counts.foreign += 1;
    if (!this.warned) {
      this.warned = true;
      this.log('claude hooks: ignored a payload from outside the Claude root (counted, logged once)');
    }
    return OK;
  }

  // By spelling first. Only when that fails is the file system asked: once for the root (a linked ~/.claude, another
  // letter case), then per body for the folder that would hold the transcript. The bridge never touches the root
  // folder before a hook body names a path outside it, and no transcript is opened or looked at.
  inRoot(p) {
    if (p.length > MAX_PATH || p.includes('\0')) return false;
    const abs = path.resolve(p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
    if (inside(this.root, abs)) return true;
    if (this.realRoot === undefined) this.realRoot = realOf(this.root);
    if (this.realRoot === null) return false;
    if (inside(this.realRoot, abs)) return true;
    const folder = realOf(path.dirname(abs));
    return folder !== null && inside(this.realRoot, path.join(folder, path.basename(abs)));
  }

  // a session only hooks report (D14): the mapping of before 0.12.0. Returns how many events it pushed.
  legacy(payload) {
    const parsed = parseClaudeHookPayload(payload, { now: this.now, activeHookTools: this.legacyTools });
    while (this.legacyTools.size > MAX_LEGACY_TOOLS) this.legacyTools.delete(this.legacyTools.keys().next().value);
    const events = parsed?.events ?? [];
    this._inLegacy = true;
    try {
      for (const ev of events) {
        this.counts.legacy += 1;
        this.trackLegacyEvent(ev);
        this.store.push(ev);
      }
    } finally {
      this._inLegacy = false;
    }
    return events.length;
  }

  trackLegacyEvent(ev) {
    if (typeof ev.sessionId !== 'string') return;
    if (ev.type === 'tool_start' && typeof ev.toolUseId === 'string') {
      let open = this.legacyOpen.get(ev.sessionId);
      if (!open) {
        if (this.legacyOpen.size >= MAX_CHARS) this.legacyOpen.delete(this.legacyOpen.keys().next().value);
        this.legacyOpen.set(ev.sessionId, (open = new Set()));
      }
      open.add(ev.toolUseId);
    } else if (ev.type === 'tool_end' && typeof ev.toolUseId === 'string') {
      const open = this.legacyOpen.get(ev.sessionId);
      if (open?.delete(ev.toolUseId) && open.size === 0) this.legacyOpen.delete(ev.sessionId);
    } else if (ev.type === 'session_end') {
      this.legacyOpen.delete(ev.sessionId);
      const prefix = `${ev.sessionId}:`;
      for (const key of this.legacyTools.keys()) if (key.startsWith(prefix)) this.legacyTools.delete(key);
    }
  }

  count(key) { this.counts[key] += 1; }

  // D14. A session the Store follows: only the type permission_prompt counts. A session only hooks report keeps the
  // Notification of before 0.12.0 (parseClaudeHookPayload: a wait under a synthetic id, for the native notifier),
  // unless the bridge can mark a tool those hooks opened or the prompt already shows.
  notification(sid, payload, followed) {
    const prompt = payload.notification_type === 'permission_prompt';
    if (!prompt) return followed ? this.count('ignored') : this.legacy(payload);
    return this.permission(sid, payload, false, followed ? null : () => this.legacy(payload) > 0);
  }

  // request: a PermissionRequest. It names the tool (without a usable name there is nothing to match) and may be
  // held. Otherwise the Notification, which has no tool name and fires about six seconds into a prompt: it is never
  // held, it is a no-op when the prompt already shows (a sent wait of this session, or an open ask tool of the
  // character), and when it marks a tool it takes the place of the session's oldest held request.
  // orElse (hook-only sessions): what a Notification does when there is nothing to mark; true when it sent a wait.
  permission(sid, payload, request, orElse = null) {
    const tool = request ? wireTool(payload.tool_name) : null;
    if (request && (tool === null || ASK_TOOLS.has(tool))) return this.count('ignored');
    // A subagent's call carries agent_id: the character id of its transcript (agent-<id>.jsonl), with the session id
    // as the Store entry's sid. An id the Store holds for another session or adapter is refused.
    const agentId = publicSessionId(payload.agent_id);
    const subId = agentId && agentId !== sid ? agentId : null;
    const sub = subId ? (this.store.byChar?.get(subId) ?? null) : null;
    const known = !!sub && sub.agent === CLAUDE_CODE_AGENT && sub.sid === sid;
    if (sub && !known) return this.count('ignored');
    // The repeat rule, by the ids of the body itself (not the character it resolves to), before anything is picked:
    // the same event is held right now, or sent or held a wait less than DEDUP_MS ago.
    const key = `${sid}|${subId ?? sid}|${tool ?? ''}`;
    if (this.held.some((h) => h.key === key) || this.now() - (this.recent.get(key) ?? -Infinity) < this.dedupMs) return this.count('duplicates');
    // A subagent the Store does not have (yet): the parent's matching open tool, else held for the subagent, whose
    // file the next rescan attaches.
    const late = subId !== null && !known;
    const charId = known ? subId : sid;
    if (!request && (this.hasWait(sid) || this.hasOpenAsk(charId))) return this.count('duplicates');
    const hit = this.pick(charId, tool);
    if (hit.id) {
      if (!request) this.unhold(sid); // one prompt, one wait: the request this Notification belongs to never matched
      this.remember(key);
      return this.emit(sid, charId, hit.id, iso(this.now()));
    }
    // Held: a request the tailer has not caught up with. Not when every open tool of that name already had its wait:
    // then the next tool_start of that name would inherit a wait that may not be its own.
    if (request && (late || !hit.waiting)) {
      this.remember(key);
      return this.hold({ sid, charId: late ? subId : charId, tool, key, at: this.now() });
    }
    if (orElse?.()) return this.remember(key);
    return this.count('unmatched');
  }

  hasWait(sid) {
    for (const w of this.waits.values()) if (w.sid === sid) return true;
    return false;
  }

  hasOpenAsk(charId) {
    for (const t of this.open.get(charId)?.values() ?? []) if (t.ask) return true;
    return false;
  }

  // the newest open, non-ask tool of the character with that name (any name for a Notification, tool null) that
  // never had a wait: { id } or, when only tools that had theirs match, { waiting: true } (one true per toolUseId)
  pick(charId, tool) {
    let id = null;
    let waiting = false;
    for (const [toolUseId, t] of this.open.get(charId) ?? []) {
      if (t.ask || (tool !== null && t.tool !== tool)) continue;
      if (t.waited) waiting = true;
      else id = toolUseId;
    }
    return { id, waiting };
  }

  hold(h) {
    this.held.push(h);
    while (this.held.length > this.maxHeld) {
      this.held.shift();
      this.counts.dropped += 1;
    }
  }

  // the session's oldest held request leaves without a wait
  unhold(sid) {
    const i = this.held.findIndex((h) => h.sid === sid);
    if (i >= 0) this.held.splice(i, 1);
  }

  remember(key) {
    this.recent.delete(key); // re-inserted at the end: the Map stays oldest first
    this.recent.set(key, this.now());
    if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value);
  }

  // drops what is too old to be used: held requests (HOLD_MS) and the memory of the repeat rule (DEDUP_MS)
  prune() {
    if (!this.held.length && !this.recent.size) return;
    const now = this.now();
    const before = this.held.length;
    this.held = this.held.filter((h) => h.at > now - this.holdMs);
    this.counts.expired += before - this.held.length;
    for (const [key, at] of this.recent) {
      if (now - at < this.dedupMs) break;
      this.recent.delete(key);
    }
  }

  // D25: exactly the fields of the Grok tool_wait. The wait ends with the tool's tool_end; no waiting:false is sent,
  // because no hook says that a prompt was allowed.
  emit(sid, charId, toolUseId, ts) {
    const ev = { type: 'tool_wait', sessionId: charId, ts, toolUseId, waiting: true };
    const t = this.open.get(charId)?.get(toolUseId);
    if (t) t.waited = true;
    this.waits.set(waitKey(charId, toolUseId), { ev, sid });
    this.counts.waits += 1;
    this.store.push(ev);
  }

  /** Every event the Store pushes (and the snapshot at start): keeps the open tools and sends a held wait. */
  observeEvent(ev) {
    this.prune();
    if (!ev || typeof ev !== 'object' || typeof ev.sessionId !== 'string') return;
    const charId = ev.sessionId;
    if (!this._inLegacy && ev.type === 'session' && this.store.byChar?.get(charId)?.agent === CLAUDE_CODE_AGENT) {
      this.purgeLegacy(charId);
    } else if (ev.type === 'tool_start' && typeof ev.toolUseId === 'string') this.toolStart(charId, ev);
    else if (ev.type === 'tool_end') {
      const tools = this.open.get(charId);
      if (tools?.delete(ev.toolUseId) && tools.size === 0) this.open.delete(charId);
      this.waits.delete(waitKey(charId, ev.toolUseId));
    } else if (ev.type === 'session_end') {
      this.forget(charId);
      this.held = this.held.filter((h) => h.charId !== charId);
    }
  }

  // A character leaves `open` (its session ended, or it was the oldest beyond MAX_CHARS): its sent waits go with it,
  // so `waits` never holds more than `open` does.
  forget(charId) {
    this.open.delete(charId);
    for (const [k, w] of [...this.waits]) if (w.ev.sessionId === charId) this.waits.delete(k); // by the id, not by a key prefix
  }

  // Closes open synthetic legacy-hook tools when the Store starts following a Claude session via its transcript.
  purgeLegacy(sid) {
    const prefix = `${sid}:`;
    for (const key of this.legacyTools.keys()) if (key.startsWith(prefix)) this.legacyTools.delete(key);
    const openIds = this.legacyOpen.get(sid);
    if (!openIds) return;
    this.legacyOpen.delete(sid);
    const ts = iso(this.now());
    for (const toolUseId of openIds) {
      this.store.push({ type: 'tool_end', sessionId: sid, ts, toolUseId, ok: false, errorKind: 'abandoned', error: 'Superseded by transcript' });
    }
  }

  toolStart(charId, ev) {
    const entry = this.store.byChar?.get(charId) ?? null; // null: a session only hooks report
    if (entry && entry.agent !== CLAUDE_CODE_AGENT) return; // Grok, Codex, Antigravity: never the target of a Claude hook
    if (!this._inLegacy && entry) this.purgeLegacy(charId);
    let tools = this.open.get(charId);
    if (!tools) {
      if (this.open.size >= MAX_CHARS) this.forget(this.open.keys().next().value);
      this.open.set(charId, (tools = new Map()));
    }
    const ask = isAsk(ev);
    const tool = wireTool(ev.tool);
    if (!tools.has(ev.toolUseId)) { // a re-announce repeats an open tool_start: it keeps its place
      if (tools.size >= MAX_TOOLS) {
        const oldest = tools.keys().next().value;
        tools.delete(oldest);
        this.waits.delete(waitKey(charId, oldest));
      }
      tools.set(ev.toolUseId, { tool, ask, waited: false });
    }
    if (ask || !this.held.length || tools.get(ev.toolUseId).waited) return;
    const owner = entry?.sid ?? null; // a subagent's session id, when the Store has the character
    const i = this.held.findIndex((h) => h.charId === charId && h.tool === tool && (owner === null || owner === h.sid));
    if (i < 0) return;
    const [h] = this.held.splice(i, 1);
    this.emit(h.sid, charId, ev.toolUseId, iso(h.at)); // ts: when the prompt opened (the hook arrived)
  }

  /**
   * Snapshot events (GET /state, the SSE snapshot) with every open wait put right after its tool_start, as a copy of
   * the live event (contract 2). The input array is not changed; a wait whose tool is not in the snapshot adds nothing.
   */
  decorate(events) {
    if (!this.waits.size || !Array.isArray(events)) return events;
    const out = [];
    for (const ev of events) {
      out.push(ev);
      const w = ev?.type === 'tool_start' ? this.waits.get(waitKey(ev.sessionId, ev.toolUseId)) : null;
      if (w) out.push({ ...w.ev });
    }
    return out;
  }
}
