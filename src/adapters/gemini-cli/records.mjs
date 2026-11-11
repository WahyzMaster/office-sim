// Pure normalizer converting Gemini CLI records (`ConversationRecord` messages and `.jsonl` steps)
// into `SessionCore` normalized items (`CONTRACT 4.0.2` & Section 5 privacy rules).
// Raw commands, file bodies, full paths, and URLs are never forwarded — only reduced descriptors.
import { isObj } from '../../core/session-items.mjs';

export const GEMINI_CLI_AGENT = 'gemini-cli';

const READ_TOOLS = new Set(['read_file', 'read_many_files', 'get_file_outline']);
const EDIT_TOOLS = new Set(['write_file', 'replace', 'edit_file', 'apply_patch', 'create_file']);
const SHELL_TOOLS = new Set(['run_shell_command', 'shell', 'bash', 'execute_command']);
const SEARCH_TOOLS = new Set(['grep_search', 'search_file_content', 'glob', 'list_directory', 'find_by_name']);
const WEB_TOOLS = new Set(['google_web_search', 'web_fetch', 'search_web']);
const PLAN_TOOLS = new Set(['write_todos', 'todo_write', 'update_plan']);
const ASK_TOOLS = new Set(['ask_user', 'ask_followup_question']);
const AGENT_TOOLS = new Set(['delegate_to_agent', 'codebase_investigator', 'invoke_subagent']);

const OK_STATUS = new Set(['success', 'ok', 'completed', 'done']);
const DENIED_STATUS = new Set(['cancelled', 'canceled', 'denied', 'rejected']);
const INTERRUPTED_STATUS = new Set(['interrupted', 'aborted']);
const PENDING_STATUS = new Set(['', 'scheduled', 'validating', 'awaiting_approval', 'executing', 'running', 'pending']);

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function contentText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string' && p.trim()) parts.push(p.trim());
    else if (isObj(p) && typeof p.text === 'string' && p.text.trim()) parts.push(p.text.trim());
  }
  return parts.length ? parts.join(' ') : null;
}

function thoughtText(rec) {
  if (typeof rec.thinking === 'string' && rec.thinking.trim()) return rec.thinking.trim();
  if (!Array.isArray(rec.thoughts) || !rec.thoughts.length) return null;
  const last = rec.thoughts[rec.thoughts.length - 1];
  if (typeof last === 'string') return last.trim() || null;
  if (!isObj(last)) return null;
  const subj = str(last.subject);
  const desc = str(last.description);
  return subj && desc ? `${subj}: ${desc}` : subj || desc || null;
}

function mapPlanStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'in_progress' || s === 'active' || s === 'doing') return 'in_progress';
  return 'pending';
}

function planItemsFromArgs(args) {
  const list = Array.isArray(args?.todos) ? args.todos : Array.isArray(args?.items) ? args.items : null;
  if (!list) return null;
  const out = [];
  for (const it of list) {
    if (!isObj(it)) continue;
    const content = str(it.description ?? it.content ?? it.step ?? it.title) ?? '';
    if (!content) continue;
    out.push({ content, status: mapPlanStatus(it.status) });
  }
  return out;
}

export function classifyGeminiTool(rawName, args = {}, call = {}) {
  const name = str(rawName) || 'tool';
  const lower = name.toLowerCase();
  const a = isObj(args) ? args : {};
  const mcpServer = str(call.serverName ?? a.serverName);
  if (mcpServer || name.startsWith('mcp__')) {
    return {
      kind: 'other',
      tool: name,
      desc: {
        tool: name,
        kind: 'other',
        ...(mcpServer ? { mcpServer, mcpTool: name } : {}),
        path: str(a.file_path ?? a.path ?? a.dir_path) ?? undefined,
        query: str(a.query ?? a.pattern) ?? undefined,
        url: str(a.url) ?? undefined,
      },
    };
  }
  if (PLAN_TOOLS.has(lower)) {
    return {
      kind: 'plan',
      tool: name,
      items: planItemsFromArgs(a),
      desc: { tool: name, kind: 'plan' },
    };
  }
  if (ASK_TOOLS.has(lower)) {
    return {
      kind: 'ask',
      tool: name,
      question: str(a.question ?? a.prompt) ?? 'Input needed',
      options: Array.isArray(a.options) ? a.options : [],
      desc: { tool: name, kind: 'ask' },
    };
  }
  if (READ_TOOLS.has(lower)) {
    const paths = Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === 'string') : undefined;
    return {
      kind: 'read',
      tool: name,
      desc: { tool: name, kind: 'read', path: str(a.file_path ?? a.absolute_path ?? a.path) ?? undefined, paths },
    };
  }
  if (EDIT_TOOLS.has(lower)) {
    return {
      kind: 'edit',
      tool: name,
      desc: {
        tool: name, kind: 'edit',
        path: str(a.file_path ?? a.absolute_path ?? a.path) ?? undefined,
        patch: typeof a.patch === 'string' ? a.patch : undefined,
      },
    };
  }
  if (SHELL_TOOLS.has(lower)) {
    return {
      kind: 'shell',
      tool: name,
      desc: {
        tool: name, kind: 'shell',
        command: typeof a.command === 'string' ? a.command : undefined,
        background: a.is_background === true || a.background === true,
      },
    };
  }
  if (SEARCH_TOOLS.has(lower)) {
    return {
      kind: 'search',
      tool: name,
      desc: {
        tool: name, kind: 'search',
        query: str(a.pattern ?? a.query) ?? undefined,
        path: str(a.dir_path ?? a.path ?? a.directory) ?? undefined,
      },
    };
  }
  if (WEB_TOOLS.has(lower)) {
    return {
      kind: 'web',
      tool: name,
      desc: {
        tool: name, kind: 'web',
        url: str(a.url) ?? undefined,
        query: str(a.query) ?? undefined,
      },
    };
  }
  if (AGENT_TOOLS.has(lower)) {
    return {
      kind: 'agent',
      tool: name,
      desc: {
        tool: name, kind: 'agent',
        description: str(a.objective ?? a.description ?? a.agent_name) ?? undefined,
      },
    };
  }
  return {
    kind: 'other',
    tool: name,
    desc: {
      tool: name, kind: 'other',
      path: str(a.file_path ?? a.path) ?? undefined,
    },
  };
}

export function toolEndStatusOf(rawStatus, errField) {
  const s = String(rawStatus ?? '').trim().toLowerCase();
  if (PENDING_STATUS.has(s)) return null;
  if (OK_STATUS.has(s)) return { status: 'ok' };
  if (DENIED_STATUS.has(s)) return { status: 'denied', errorLine: str(errField) ?? 'denied' };
  if (INTERRUPTED_STATUS.has(s)) return { status: 'interrupted', errorLine: str(errField) ?? 'interrupted' };
  return { status: 'failed', errorLine: str(errField) ?? 'tool failed' };
}

function cwdHintFromArgs(args) {
  if (!isObj(args)) return null;
  for (const k of ['cwd', 'dir_path', 'directory', 'working_directory']) {
    const v = str(args[k]);
    if (v && (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v))) return v;
  }
  return null;
}

/**
 * Convert one parsed Gemini CLI record into normalized `SessionCore` items.
 * `ctx` tracks `{ seq, pending: Set<string>, hasCwd: boolean }` per session instance.
 */
export function normalizeGeminiRecord(rec, ctx) {
  if (!isObj(rec)) return [];
  const ts = str(rec.timestamp ?? rec.createdAt ?? rec.startTime);
  const stamp = (it) => (ts ? { ...it, ts } : it);
  const type = String(rec.type ?? rec.role ?? '').toLowerCase();
  const out = [];

  if (type === 'session_metadata' || type === 'init' || type === 'meta') {
    const meta = { k: 'meta' };
    if (str(rec.cwd)) { meta.cwd = str(rec.cwd); ctx.hasCwd = true; }
    if (str(rec.branch ?? rec.gitBranch)) meta.branch = str(rec.branch ?? rec.gitBranch);
    if (str(rec.title ?? rec.summary)) meta.title = str(rec.title ?? rec.summary);
    if (Object.keys(meta).length > 1) out.push(stamp(meta));
    return out;
  }

  if (type === 'user') {
    for (const pid of [...ctx.pending]) {
      ctx.pending.delete(pid);
      out.push(stamp({ k: 'tool_end', id: pid, status: 'abandoned' }));
    }
    if (!ctx.hasCwd && str(rec.cwd)) {
      ctx.hasCwd = true;
      out.push(stamp({ k: 'meta', cwd: str(rec.cwd) }));
    }
    out.push(stamp({ k: 'turn_start' }));
    const text = contentText(rec.content);
    if (text) out.push(stamp({ k: 'prompt', text }));
    return out;
  }

  if (type === 'gemini' || type === 'model' || type === 'assistant') {
    const calls = Array.isArray(rec.toolCalls) ? rec.toolCalls.filter(isObj) : [];
    if (!ctx.hasCwd) {
      if (str(rec.cwd)) {
        ctx.hasCwd = true;
        out.push(stamp({ k: 'meta', cwd: str(rec.cwd) }));
      } else {
        for (const tc of calls) {
          const hint = cwdHintFromArgs(tc.args ?? tc.input);
          if (hint) {
            ctx.hasCwd = true;
            out.push(stamp({ k: 'meta', cwd: hint }));
            break;
          }
        }
      }
    }
    const think = thoughtText(rec);
    if (think) out.push(stamp({ k: 'thinking', text: think, durationMs: Number.isFinite(rec.durationMs) ? rec.durationMs : null }));
    const say = contentText(rec.content);
    if (say) out.push(stamp({ k: 'say', text: say, ...(calls.length === 0 ? { final: true } : {}) }));
    for (const tc of calls) {
      const id = str(tc.id ?? tc.callId) || `gcall_${++ctx.seq}`;
      const args = isObj(tc.args) ? tc.args : isObj(tc.input) ? tc.input : {};
      const cls = classifyGeminiTool(tc.name ?? tc.tool, args, tc);
      const startItem = { k: 'tool_start', id, tool: cls.tool, kind: cls.kind, desc: cls.desc };
      if (cls.kind === 'plan' && cls.items) startItem.items = cls.items;
      if (cls.kind === 'ask') {
        startItem.question = cls.question;
        startItem.options = cls.options;
      }
      out.push(stamp(startItem));
      const endInfo = toolEndStatusOf(tc.status, tc.error ?? (String(tc.status).toLowerCase() === 'error' ? tc.resultDisplay : null));
      if (endInfo) {
        out.push(stamp({ k: 'tool_end', id, ...endInfo }));
      } else {
        ctx.pending.add(id);
      }
    }
    return out;
  }

  if (type === 'tool_result') {
    const id = str(rec.id ?? rec.toolCallId ?? rec.callId);
    if (!id) return out;
    ctx.pending.delete(id);
    const endInfo = toolEndStatusOf(rec.status ?? (rec.error ? 'error' : 'success'), rec.error) ?? { status: 'ok' };
    out.push(stamp({ k: 'tool_end', id, ...endInfo }));
    return out;
  }

  if (type === 'error' || type === 'api_error') {
    out.push(stamp({ k: 'system', kind: 'api_error', text: contentText(rec.content) ?? str(rec.message ?? rec.error) ?? 'API error' }));
    return out;
  }

  if (type === 'compact' || type === 'checkpoint') {
    out.push(stamp({ k: 'system', kind: 'compact', text: 'Conversation compacted' }));
    return out;
  }

  if (type === 'turn_end') {
    out.push(stamp({ k: 'turn_end', reason: str(rec.reason) || 'end_turn' }));
    return out;
  }

  return out;
}
