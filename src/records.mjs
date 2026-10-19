// One parsed jsonl record -> one normalized item (pure, never throws). CONTRACT 3.3.
// 분류만 한다: 이벤트 생성, 중복 제거, 턴 추적은 session.mjs 가 맡는다.

const META_FIELDS = {
  'custom-title': ['title', (r) => r.customTitle],
  'agent-name': ['agentName', (r) => r.agentName],
  'last-prompt': ['lastPrompt', (r) => r.lastPrompt],
  'worktree-state': ['worktree', (r) => (r.worktreeSession && typeof r.worktreeSession === 'object' ? r.worktreeSession : null)],
  relocated: ['relocatedCwd', (r) => r.relocatedCwd],
  summary: ['summary', (r) => r.summary],
};

const SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'api_error', 'compact_boundary', 'model_refusal_fallback']);
const INTERRUPT_PREFIX = '[Request interrupted by user';
const INTERRUPT_FOR_TOOL = '[Request interrupted by user for tool use';
const SYSTEM_REMINDER = '<system-reminder>';
const TASK_NOTIFICATION = '<task-notification>';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : undefined;
}

// ts / cwd / gitBranch / sessionId / agentId, only when present.
function base(rec) {
  const out = {};
  if (typeof rec.timestamp === 'string') out.ts = rec.timestamp;
  if (typeof rec.cwd === 'string') out.cwd = rec.cwd;
  if (typeof rec.gitBranch === 'string') out.gitBranch = rec.gitBranch;
  if (typeof rec.sessionId === 'string') out.sessionId = rec.sessionId;
  if (typeof rec.agentId === 'string') out.agentId = rec.agentId;
  return out;
}

/** tool_result.content / user content -> plain text (text items joined, images etc. skipped). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (isObj(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

// First text of a user record (string content or first text block).
function firstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const b of content) {
    if (isObj(b) && b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return '';
}

// Human text: string content, or the text blocks that are not a leading <system-reminder>.
function humanText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!isObj(b) || b.type !== 'text' || typeof b.text !== 'string') continue;
    if (b.text.trimStart().startsWith(SYSTEM_REMINDER)) continue;
    parts.push(b.text);
  }
  return parts.join('\n').trim();
}

function tag(text, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : null;
}

function notification(rec, text, extra) {
  return {
    kind: 'notification',
    uuid: str(rec.uuid),
    promptId: str(rec.promptId),
    toolUseId: tag(text, 'tool-use-id'),
    taskId: tag(text, 'task-id'),
    status: tag(text, 'status'),
    summary: tag(text, 'summary'),
    ...extra,
  };
}

// R17-R19 (critic rules 16-18): a real human prompt.
function isHumanPrompt(rec, content, text) {
  if (rec.isMeta === true || rec.isCompactSummary === true) return false;
  const origin = isObj(rec.origin) ? rec.origin.kind : undefined;
  if (origin !== undefined) return origin === 'human';
  if (typeof rec.turnOrigin === 'string') return rec.turnOrigin === 'human';
  // pre-2.1.187: no origin. String content, promptSource sdk, permissionMode present, not a tag.
  if (rec.isSidechain === true) return false;
  if (typeof content !== 'string') return false;
  if (rec.promptSource !== 'sdk' || rec.permissionMode === undefined) return false;
  const t = text.trimStart();
  return t !== '' && !t.startsWith('<') && !t.startsWith(INTERRUPT_PREFIX);
}

function classifyUser(rec, b) {
  const content = isObj(rec.message) ? rec.message.content : undefined;
  if (Array.isArray(content)) {
    const block = content.find((x) => isObj(x) && x.type === 'tool_result');
    if (block) {
      const meta = isObj(rec.mcpMeta) && isObj(rec.mcpMeta._meta) ? rec.mcpMeta._meta : {};
      return {
        kind: 'tool_result',
        uuid: str(rec.uuid),
        promptId: str(rec.promptId),
        toolUseId: str(block.tool_use_id) ?? null,
        isError: block.is_error === true,
        text: contentText(block.content),
        toolUseResult: rec.toolUseResult,
        toolDenialKind: typeof rec.toolDenialKind === 'string' ? rec.toolDenialKind : null,
        endTurn: meta['claude/endTurn'] === true || rec.toolEndsTurn === true,
        ...b,
      };
    }
  }
  const first = firstText(content).trimStart();
  if (first.startsWith(INTERRUPT_PREFIX)) {
    return {
      kind: 'interrupt', uuid: str(rec.uuid), promptId: str(rec.promptId),
      forTool: first.startsWith(INTERRUPT_FOR_TOOL), ...b,
    };
  }
  const originKind = isObj(rec.origin) ? rec.origin.kind : undefined;
  const all = contentText(content);
  if (originKind === 'task-notification' || (originKind === undefined && all.trimStart().startsWith(TASK_NOTIFICATION))) {
    return notification(rec, all, b);
  }
  const text = humanText(content);
  if (isHumanPrompt(rec, content, text)) {
    return { kind: 'prompt', uuid: str(rec.uuid), promptId: str(rec.promptId), text, ...b };
  }
  if (typeof rec.promptId === 'string') {
    return { kind: 'turn_start', uuid: str(rec.uuid), promptId: rec.promptId, isCompactSummary: rec.isCompactSummary === true, ...b };
  }
  return { kind: 'ignore', uuid: str(rec.uuid), ...b };
}

function classifyAssistant(rec, b) {
  const msg = isObj(rec.message) ? rec.message : {};
  const raw = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
  const blocks = [];
  for (const x of raw) {
    if (!isObj(x)) continue;
    if (x.type === 'thinking') blocks.push({ type: 'thinking', text: typeof x.thinking === 'string' ? x.thinking : '' });
    else if (x.type === 'redacted_thinking') blocks.push({ type: 'thinking', text: '' });
    else if (x.type === 'text') blocks.push({ type: 'text', text: typeof x.text === 'string' ? x.text : '' });
    else if (x.type === 'tool_use' && typeof x.id === 'string') {
      blocks.push({ type: 'tool_use', id: x.id, name: typeof x.name === 'string' ? x.name : '', input: isObj(x.input) ? x.input : {} });
    }
    // server_tool_use, advisor_tool_result, fallback, image ... are dropped.
  }
  return {
    kind: 'assistant',
    uuid: str(rec.uuid),
    msgId: typeof msg.id === 'string' ? msg.id : null,
    synthetic: msg.model === '<synthetic>',
    apiError: rec.isApiErrorMessage === true,
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
    model: typeof msg.model === 'string' ? msg.model : null,
    thinkingDurationMs: typeof rec.thinkingDurationMs === 'number' && Number.isFinite(rec.thinkingDurationMs) ? rec.thinkingDurationMs : null,
    blocks,
    ...b,
  };
}

function classifySystem(rec, b) {
  if (!SYSTEM_SUBTYPES.has(rec.subtype)) return { kind: 'ignore', uuid: str(rec.uuid), ...b };
  const err = isObj(rec.error) ? rec.error : {};
  return {
    kind: 'system',
    uuid: str(rec.uuid),
    subtype: rec.subtype,
    retryAttempt: typeof rec.retryAttempt === 'number' ? rec.retryAttempt : null,
    maxRetries: typeof rec.maxRetries === 'number' ? rec.maxRetries : null,
    status: typeof err.status === 'number' ? err.status : null,
    text: typeof rec.content === 'string' ? rec.content : null,
    ...b,
  };
}

function classifyAttachment(rec, b) {
  const att = isObj(rec.attachment) ? rec.attachment : {};
  if (att.type === 'task_reminder') {
    return { kind: 'task_reminder', uuid: str(rec.uuid), content: Array.isArray(att.content) ? att.content : [], ...b };
  }
  if (att.type === 'queued_command') {
    const originKind = isObj(att.origin) ? att.origin.kind : undefined;
    const text = contentText(att.prompt);
    if (att.commandMode === 'task-notification' || originKind === 'task-notification') {
      return notification(rec, text, b);
    }
    const meta = rec.isMeta === true || att.isMeta === true;
    if (att.commandMode === 'prompt' && !meta && (originKind === undefined || originKind === 'human')) {
      return { kind: 'prompt', uuid: str(rec.uuid), promptId: str(rec.promptId), text: humanText(att.prompt), queued: true, ...b };
    }
  }
  return { kind: 'ignore', uuid: str(rec.uuid), ...b };
}

function classify(rec) {
  if (!isObj(rec)) return { kind: 'ignore' };
  const type = rec.type;
  const metaDef = Object.prototype.hasOwnProperty.call(META_FIELDS, type) ? META_FIELDS[type] : null;
  if (metaDef && typeof rec.uuid !== 'string') {
    const out = { kind: 'meta', field: metaDef[0], value: metaDef[1](rec) };
    if (typeof rec.sessionId === 'string') out.sessionId = rec.sessionId;
    return out;
  }
  if (typeof rec.uuid !== 'string' && type !== 'user' && type !== 'assistant' && type !== 'system' && type !== 'attachment') {
    return { kind: 'ignore' }; // queue-operation, pr-link, mode, file-history-*, artifact-*, cost-state ...
  }
  const b = base(rec);
  switch (type) {
    case 'assistant': return classifyAssistant(rec, b);
    case 'user': return classifyUser(rec, b);
    case 'system': return classifySystem(rec, b);
    case 'attachment': return classifyAttachment(rec, b);
    default: return { kind: 'ignore', uuid: str(rec.uuid), ...b };
  }
}

/** Contract 3.3: one parsed jsonl record -> { kind, ... }. Pure, never throws. */
export function classifyRecord(rec) {
  try {
    return classify(rec);
  } catch {
    return { kind: 'ignore' };
  }
}
