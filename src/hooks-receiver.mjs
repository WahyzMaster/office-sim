// P1: Opt-in Claude Code HTTP hook receiver (POST /api/hooks/claude) and merge-safe settings.json hook installer.
import fs from 'node:fs';
import path from 'node:path';
import { cleanText, summarize } from './summarize.mjs';
import { cleanLabel, publicSessionId, CLAUDE_CODE_AGENT } from './session-identity.mjs';
import { basename, projectKey, worktreeFromPath, iso } from './session-util.mjs';

export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'TaskCompleted',
]);

export const HOOK_MARKER = 'office-sim-claude-hook';

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
  const toolName = typeof payload.tool_name === 'string' ? cleanLabel(payload.tool_name) : null;
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const toolUseIdRaw = typeof payload.tool_use_id === 'string' ? publicSessionId(payload.tool_use_id) : null;
  const agentType = typeof payload.agent_type === 'string' ? cleanLabel(payload.agent_type) : null;
  const stopReason = typeof payload.stop_reason === 'string' ? cleanText(payload.stop_reason, 80) : null;

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
        title: projectLabel || `Session ${sessionId.slice(0, 8)}`,
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
          ...(isFailure ? { errorKind: 'failed', error: cleanText(String(payload.error || payload.tool_output || 'Tool failed'), 100) } : {}),
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
        events.push({
          type: 'tool_wait',
          sessionId,
          ts,
          toolUseId: waitId,
          waiting: true,
          question: msg || 'Awaiting permission approval',
        });
      }
      break;
    }
    case 'SubagentStart': {
      const subName = agentType || 'subagent';
      const toolUseId = toolUseIdRaw || nextHookToolId(sessionId, 'Agent');
      if (activeHookTools instanceof Map) activeHookTools.set(`${sessionId}:Subagent`, toolUseId);
      events.push({
        type: 'tool_start',
        sessionId,
        ts,
        toolUseId,
        tool: 'Agent',
        summary: cleanText(subName, 60),
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
        text: stopReason || 'API error / rate limit',
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
    stopReason,
    events,
  };
}

/**
 * Build the non-blocking curl/node one-liner command that Claude Code executes on hook events.
 */
export function buildHookCommand({ port = 4317, host = '127.0.0.1' } = {}) {
  const safeHost = host === '::1' ? '[::1]' : '127.0.0.1';
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 4317;
  return `curl -sS -m 1 -X POST -H "Content-Type: application/json" --data-binary @- "http://${safeHost}:${safePort}/api/hooks/claude" >/dev/null 2>&1 || true # ${HOOK_MARKER}`;
}

/**
 * Merge-safe installer for ~/.claude/settings.json (inspired by pixel-agents PR #378).
 * Never overwrites malformed JSON; creates a one-time .office-sim.bak backup before first modification.
 */
export function installClaudeHooks({ settingsPath, port = 4317, host = '127.0.0.1' } = {}) {
  if (typeof settingsPath !== 'string' || !settingsPath.trim()) {
    throw new TypeError('settingsPath must be a non-empty string');
  }
  let root = {};
  const exists = fs.existsSync(settingsPath);
  if (exists) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
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
    const backupPath = `${settingsPath}.office-sim.bak`;
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, raw, { encoding: 'utf8', mode: 0o600 });
    }
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  }

  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    throw new Error('Refusing to modify settings.json: hooks field is not an object');
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  const command = buildHookCommand({ port, host });

  for (const evName of HOOK_EVENTS) {
    const existingList = Array.isArray(hooks[evName]) ? [...hooks[evName]] : [];
    const filtered = existingList.filter((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some((h) => isRecord(h) && typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
    });
    filtered.push({
      hooks: [{ type: 'command', command }],
    });
    hooks[evName] = filtered;
  }

  const nextRoot = { ...root, hooks };
  fs.writeFileSync(settingsPath, `${JSON.stringify(nextRoot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { installed: true, settingsPath, events: HOOK_EVENTS.length };
}

export function uninstallClaudeHooks({ settingsPath } = {}) {
  if (typeof settingsPath !== 'string' || !fs.existsSync(settingsPath)) {
    return { removed: false, settingsPath };
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let root;
  try {
    root = JSON.parse(raw);
  } catch {
    throw new Error('Refusing to modify unparseable settings.json');
  }
  if (!isRecord(root) || !isRecord(root.hooks)) {
    return { removed: false, settingsPath };
  }
  const hooks = { ...root.hooks };
  let removedCount = 0;
  for (const [evName, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return true;
      const isOurs = entry.hooks.some((h) => isRecord(h) && typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
      if (isOurs) removedCount += 1;
      return !isOurs;
    });
    if (kept.length > 0) hooks[evName] = kept;
    else delete hooks[evName];
  }
  const nextRoot = { ...root, hooks };
  if (Object.keys(hooks).length === 0) delete nextRoot.hooks;
  fs.writeFileSync(settingsPath, `${JSON.stringify(nextRoot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { removed: removedCount > 0, removedCount, settingsPath };
}
