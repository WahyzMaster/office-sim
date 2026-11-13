// Claude Code hooks: the settings.json installer (merge-safe) and the parser for hook-only sessions.
// Launch readiness D13: the installer registers exactly two events, PermissionRequest and Notification, as http hooks
// that POST to /api/hooks/claude. The route itself lives in hooks-bridge.mjs (contract 7.2).
import fs from 'node:fs';
import path from 'node:path';
import { cleanText, summarize } from './summarize.mjs';
import { cleanLabel, publicSessionId, CLAUDE_CODE_AGENT } from './session-identity.mjs';
import { basename, projectKey, worktreeFromPath, publicToolName, iso } from './session-util.mjs';

/** The events the installer registers (D13). The transcript is the source for everything else. */
export const HOOK_EVENTS = Object.freeze(['PermissionRequest', 'Notification']);
// Notification fires for several reasons; only the permission prompt is wanted
const HOOK_MATCHERS = Object.freeze({ Notification: 'permission_prompt' });
const HOOK_TIMEOUT_S = 2; // an http hook waits 600 s by default; a missing office must not hold a prompt up

export const HOOK_MARKER = 'office-sim-claude-hook';
// A hook-only session's tool name goes on the wire and into its synthetic tool id: the charset of D20, up to 128
// characters (an mcp name runs past 64). Any other name sends no event.
const HOOK_TOOL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL_FAILED = 'Tool failed'; // the whole error line of a failed hook-only tool: no text of the body is sent
const API_ERROR = 'API error / rate limit'; // the whole line of a StopFailure: `stop_reason` is not read
// A subagent type goes on the wire as the Agent tool's summary only when it has the shape of a name (D20's charset).
const HOOK_LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

let syntheticSeq = 0;
function nextHookToolId(sessionId, toolName) {
  syntheticSeq = (syntheticSeq + 1) % 1_000_000;
  return `hook_${sessionId.slice(0, 8)}_${toolName}_${syntheticSeq}`;
}

/**
 * Parse a Claude Code HTTP / command hook JSON payload into privacy-scrubbed Office Sim wire events.
 * Enforces CONTRACT section 5: basename-only project labels, cleanText scrubbing, and publicSessionId validation.
 */
export function parseClaudeHookPayload(payload, { now = Date.now, activeHookTools = null } = {}) {
  if (!isRecord(payload)) return null;
  const rawSid = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const sessionId = publicSessionId(rawSid);
  if (!sessionId) return null;

  const hookEvent = typeof payload.hook_event_name === 'string' ? payload.hook_event_name.trim() : '';
  if (!hookEvent) return null;

  const ts = iso(now());
  const rawCwd = typeof payload.cwd === 'string' && payload.cwd.startsWith('/') ? payload.cwd : '';
  const project = rawCwd ? projectKey(rawCwd, null) : '';
  const projectLabel = project ? basename(project) : '';
  const worktree = rawCwd ? cleanLabel(worktreeFromPath(rawCwd)) : null;
  const toolName = typeof payload.tool_name === 'string' && HOOK_TOOL_RE.test(payload.tool_name) ? publicToolName(payload.tool_name) : null;
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const toolUseIdRaw = typeof payload.tool_use_id === 'string' ? publicSessionId(payload.tool_use_id) : null;
  const agentType = typeof payload.agent_type === 'string' && HOOK_LABEL_RE.test(payload.agent_type) ? payload.agent_type : null;

  const events = [];
  let waitingApproval = false;

  switch (hookEvent) {
    case 'SessionStart': {
      events.push({
        type: 'session',
        sessionId,
        ts,
        agent: CLAUDE_CODE_AGENT,
        project,
        projectLabel,
        title: cleanText(projectLabel, 80) || `Session ${sessionId.slice(0, 8)}`,
        branch: null,
        worktree,
        isSubagent: false,
        parentSessionId: null,
      });
      break;
    }
    case 'PreToolUse': {
      if (toolName) {
        const toolUseId = toolUseIdRaw || nextHookToolId(sessionId, toolName);
        if (activeHookTools instanceof Map) {
          activeHookTools.set(`${sessionId}:${toolName}`, toolUseId);
        }
        const sum = summarize(toolName, toolInput) || {};
        events.push({
          type: 'tool_start',
          sessionId,
          ts,
          toolUseId,
          tool: toolName,
          room: sum.room || undefined,
          summary: sum.summary || cleanText(toolName, 60),
        });
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (toolName) {
        const key = `${sessionId}:${toolName}`;
        const matchedId = toolUseIdRaw || (activeHookTools instanceof Map ? activeHookTools.get(key) : null) || `hook_${sessionId.slice(0, 8)}_${toolName}`;
        if (activeHookTools instanceof Map) activeHookTools.delete(key);
        const isFailure = hookEvent === 'PostToolUseFailure' || payload.is_error === true;
        events.push({
          type: 'tool_end',
          sessionId,
          ts,
          toolUseId: matchedId,
          ok: !isFailure,
          ...(isFailure ? { errorKind: 'failed', error: TOOL_FAILED } : {}), // payload.error and tool_output are not read
        });
      }
      break;
    }
    case 'Notification': {
      const msg = typeof payload.message === 'string' ? cleanText(payload.message, 100) : '';
      const isPerm = /permission|approve|approval|confirm/i.test(msg) || payload.notification_type === 'permission_prompt';
      if (isPerm) {
        waitingApproval = true;
        const waitId = toolUseIdRaw || `perm_${sessionId.slice(0, 8)}`;
        // D25: exactly toolUseId and waiting, like every tool_wait. Reached only for a session only hooks report
        // (D14); for a session the Store follows, hooks-bridge.mjs matches the prompt to an open tool instead.
        events.push({
          type: 'tool_wait',
          sessionId,
          ts,
          toolUseId: waitId,
          waiting: true,
        });
      }
      break;
    }
    case 'SubagentStart': {
      // a name of the allowed shape can still have the shape of a token: it goes through the one scrub like any text
      const subName = cleanText(agentType, 64) || 'subagent';
      const toolUseId = toolUseIdRaw || nextHookToolId(sessionId, 'Agent');
      if (activeHookTools instanceof Map) activeHookTools.set(`${sessionId}:Subagent`, toolUseId);
      events.push({
        type: 'tool_start',
        sessionId,
        ts,
        toolUseId,
        tool: 'Agent',
        summary: subName,
      });
      break;
    }
    case 'SubagentStop': {
      const key = `${sessionId}:Subagent`;
      const matchedId = toolUseIdRaw || (activeHookTools instanceof Map ? activeHookTools.get(key) : null) || `hook_${sessionId.slice(0, 8)}_Agent`;
      if (activeHookTools instanceof Map) activeHookTools.delete(key);
      events.push({
        type: 'tool_end',
        sessionId,
        ts,
        toolUseId: matchedId,
        ok: true,
      });
      break;
    }
    case 'PreCompact': {
      events.push({
        type: 'system',
        sessionId,
        ts,
        kind: 'compact',
      });
      break;
    }
    case 'Stop':
    case 'TeammateIdle': {
      events.push({
        type: 'turn_end',
        sessionId,
        ts,
      });
      break;
    }
    case 'StopFailure': {
      events.push({
        type: 'system',
        sessionId,
        ts,
        kind: 'api_error',
        text: API_ERROR,
      });
      events.push({
        type: 'turn_end',
        sessionId,
        ts,
      });
      break;
    }
    case 'SessionEnd':
    case 'TaskCompleted': {
      events.push({
        type: 'session_end',
        sessionId,
        ts,
        reason: 'done',
      });
      break;
    }
    default:
      break;
  }

  return {
    sessionId,
    hookEvent,
    waitingApproval,
    events,
  };
}

const isOurs = (h) => isRecord(h) && [h.command, h.url].some((v) => typeof v === 'string' && v.includes(HOOK_MARKER));

/**
 * One event's list without the office-sim handlers: the http hooks of this version and the curl command hooks older
 * versions wrote (both carry HOOK_MARKER). Only our handlers leave a matcher group; a group left empty is dropped.
 */
function withoutOurs(list) {
  const kept = [];
  let removed = 0;
  for (const entry of list) {
    const own = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks.filter(isOurs).length : 0;
    removed += own;
    if (own === 0) kept.push(entry);
    else if (own < entry.hooks.length) kept.push({ ...entry, hooks: entry.hooks.filter((h) => !isOurs(h)) });
  }
  return { kept, removed };
}

// Every event, not only HOOK_EVENTS: an older install registered thirteen. An event list we emptied is removed.
// `byEvent`, when given, gets the number removed per event name (what `office-sim hooks uninstall` prints).
function stripOurs(hooks, byEvent = null) {
  let removed = 0;
  for (const [evName, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const r = withoutOurs(list);
    if (r.removed === 0) continue;
    removed += r.removed;
    if (byEvent) byEvent[evName] = r.removed;
    if (r.kept.length > 0) hooks[evName] = r.kept;
    else delete hooks[evName];
  }
  return removed;
}

/**
 * The URL the http hooks POST to: loopback only (127.0.0.1, or [::1] for host '::1'), the default port for anything
 * that is not a port number. The marker rides in the query so the uninstaller can tell our hooks from the user's;
 * the route matches on the path alone.
 */
export function buildHookUrl({ port = 4747, host = '127.0.0.1' } = {}) {
  const safeHost = host === '::1' || host === '[::1]' ? '[::1]' : '127.0.0.1';
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 4747;
  return `http://${safeHost}:${safePort}/api/hooks/claude?source=${HOOK_MARKER}`;
}

/**
 * What installClaudeHooks would write, without writing anything (the CLI prints it first, contract 6.3). Reads the
 * settings file and throws the installer's refusals: a file that is not a JSON object, a `hooks` that is not an
 * object, and a `hooks.<Event>` of HOOK_EVENTS that is there and is not an array (our entry would replace it).
 * @returns {{ settingsPath: string, exists: boolean, raw: string|null, text: string, changed: boolean,
 *   backupPath: string, backupNeeded: boolean, replaced: number,
 *   entries: { event: string, matcher: string|null, handler: { type: string, url: string, timeout: number } }[] }}
 *   `text`: the whole file after the install. `changed`: false when the file already holds exactly these hooks.
 *   `replaced`: the office-sim hooks already in the file (they are removed before ours are added).
 */
export function planClaudeHooks({ settingsPath, port = 4747, host = '127.0.0.1' } = {}) {
  if (typeof settingsPath !== 'string' || !settingsPath.trim()) {
    throw new TypeError('settingsPath must be a non-empty string');
  }
  let root = {};
  let raw = null;
  const exists = fs.existsSync(settingsPath);
  if (exists) {
    raw = fs.readFileSync(settingsPath, 'utf8');
    if (raw.trim() !== '') {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Refusing to modify unparseable settings.json');
      }
      if (!isRecord(parsed)) {
        throw new Error('Refusing to modify non-object settings.json');
      }
      root = parsed;
    }
    if (root.hooks !== undefined && !isRecord(root.hooks)) {
      throw new Error('Refusing to modify settings.json: hooks field is not an object');
    }
  }

  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  // Our entries are added to these two lists. A value there that is no list (a string, an object, null) could only be
  // replaced, so the file is refused like the shapes above. Under any other event such a value is left as it is.
  for (const evName of HOOK_EVENTS) {
    if (Object.hasOwn(hooks, evName) && !Array.isArray(hooks[evName])) {
      throw new Error(`Refusing to modify settings.json: hooks.${evName} is not an array`);
    }
  }
  const replaced = stripOurs(hooks);
  const handler = { type: 'http', url: buildHookUrl({ port, host }), timeout: HOOK_TIMEOUT_S };
  const entries = [];
  for (const evName of HOOK_EVENTS) {
    const list = [...(hooks[evName] ?? [])];
    const matcher = HOOK_MATCHERS[evName];
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ ...handler }] });
    hooks[evName] = list;
    entries.push({ event: evName, matcher: matcher ?? null, handler: { ...handler } });
  }

  const nextRoot = { ...root, hooks };
  const backupPath = `${settingsPath}.office-sim.bak`;
  return {
    settingsPath, exists, raw, text: `${JSON.stringify(nextRoot, null, 2)}\n`,
    changed: JSON.stringify(nextRoot) !== JSON.stringify(root),
    backupPath, backupNeeded: exists && !fs.existsSync(backupPath), replaced, entries,
  };
}

/**
 * Merge-safe installer for ~/.claude/settings.json (inspired by pixel-agents PR #378).
 * Never overwrites malformed JSON or a value it cannot merge into (the refusals of planClaudeHooks); creates a
 * one-time .office-sim.bak backup before first modification.
 * Writes { type: 'http', url, timeout: 2 } for each of HOOK_EVENTS (Notification with matcher "permission_prompt")
 * and removes every older office-sim hook, whatever its event. It writes what planClaudeHooks computes.
 */
function writeAtomicText(targetPath, text, mode, { noFollowTarget = false } = {}) {
  const st = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (noFollowTarget && st?.isSymbolicLink()) {
    throw Object.assign(new Error(`Refusing to write through symlink: ${targetPath}`), { code: 'ELOOP' });
  }
  const destPath = !noFollowTarget && st ? fs.realpathSync(targetPath) : targetPath;
  if (st) fs.accessSync(destPath, fs.constants.W_OK);
  const tmpPath = path.join(path.dirname(destPath), `.office-sim.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, flags, mode);
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function installClaudeHooks({ settingsPath, port = 4747, host = '127.0.0.1' } = {}) {
  const plan = planClaudeHooks({ settingsPath, port, host });
  // A failure says which write it was and whether this call had written the backup before it (for the caller's
  // report): err.step is 'backup' or 'settings', err.backupWritten a boolean.
  let step = plan.exists && plan.backupNeeded ? 'backup' : 'settings';
  let backupWritten = false;
  try {
    if (plan.exists) {
      if (plan.backupNeeded) writeAtomicText(plan.backupPath, plan.raw, 0o600, { noFollowTarget: true });
      backupWritten = plan.backupNeeded;
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    }
    step = 'settings';
    writeAtomicText(settingsPath, plan.text, 0o600, { noFollowTarget: false });
  } catch (err) {
    throw Object.assign(err, { step, backupWritten });
  }
  return { installed: true, settingsPath, events: HOOK_EVENTS.length };
}

/**
 * What uninstallClaudeHooks would remove, without writing. `text` is the whole file afterwards, or null when there is
 * nothing of ours to remove (a missing file, no `hooks` object, none of our handlers). Throws on unparseable JSON.
 * @returns {{ settingsPath: string, removedCount: number, byEvent: Record<string, number>, text: string|null }}
 */
export function planClaudeUnhook({ settingsPath } = {}) {
  const none = { settingsPath, removedCount: 0, byEvent: {}, text: null };
  if (typeof settingsPath !== 'string' || !fs.existsSync(settingsPath)) return none;
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (raw.trim() === '') return none; // an empty file holds no hooks (install treats it as `{}` too)
  let root;
  try {
    root = JSON.parse(raw);
  } catch {
    throw new Error('Refusing to modify unparseable settings.json');
  }
  if (!isRecord(root) || !isRecord(root.hooks)) return none;
  const hooks = { ...root.hooks };
  const byEvent = {};
  const removedCount = stripOurs(hooks, byEvent);
  if (removedCount === 0) return none;
  const nextRoot = { ...root, hooks };
  if (Object.keys(hooks).length === 0) delete nextRoot.hooks;
  return { settingsPath, removedCount, byEvent, text: `${JSON.stringify(nextRoot, null, 2)}\n` };
}

/** Removes the office-sim hooks (this version's http hooks and the older curl hooks). Writes only when it removed one. */
export function uninstallClaudeHooks({ settingsPath } = {}) {
  const plan = planClaudeUnhook({ settingsPath });
  if (plan.text === null) return { removed: false, removedCount: 0, settingsPath };
  writeAtomicText(settingsPath, plan.text, 0o600, { noFollowTarget: false });
  return { removed: true, removedCount: plan.removedCount, settingsPath };
}

/**
 * The office-sim hooks a settings file holds now, for `office-sim hooks status`. Never writes and never throws.
 * `state`: 'missing' (no file), 'unreadable' (not JSON) or 'ok'. Each hook: its event, 'http' (this version) or
 * 'command' (the curl hooks of versions before 0.12.0), and for an http hook the URL we wrote.
 * @returns {{ state: 'missing'|'unreadable'|'ok', hooks: { event: string, type: 'http'|'command', url: string|null }[] }}
 */
export function findClaudeHooks({ settingsPath } = {}) {
  if (typeof settingsPath !== 'string' || !fs.existsSync(settingsPath)) return { state: 'missing', hooks: [] };
  let root = null;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (raw.trim() !== '') root = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', hooks: [] };
  }
  const found = [];
  for (const [event, list] of Object.entries(isRecord(root) && isRecord(root.hooks) ? root.hooks : {})) {
    for (const entry of Array.isArray(list) ? list : []) {
      for (const h of isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (!isOurs(h)) continue;
        const http = h.type === 'http' && typeof h.url === 'string';
        found.push({ event, type: http ? 'http' : 'command', url: http ? h.url : null });
      }
    }
  }
  return { state: 'ok', hooks: found };
}
