// Grok Build (xAI) updates.jsonl record -> pieces of SessionCore items (pure, no state). ADAPTERS 5.2, 6.1, 6.2, 7;
// 형식 근거는 docs/research/grok-format.json (구조와 개수만 센 조사). 상태가 필요한 부분(prompt_id 로 턴 나누기, 열린
// 도구 표, 늦게 온 기록)은 session.mjs 의 GrokSession 이 한다.
//
// Envelope: { method: 'session/update' | '_x.ai/session/update', params: { sessionId, update: { sessionUpdate, ... },
// _meta: { agentTimestampMs, eventId, promptId?, ... } }, timestamp /* unix seconds */ }.
// 개인정보 (CONTRACT 5, ADAPTERS 7): 도구 설명자는 허용된 rawInput 조각만 꺼낸다 (경로, 셸 명령 문자열, URL, 검색어,
// use_tool 의 '<server>__<tool>' 이름, 질문과 선택지 이름). title, locations, description, prompt, content, tool_input,
// rawOutput 본문(output, stdout, stderr)은 읽지 않는다. 오류 문구는 구조화된 필드(error, message, 변형 이름, 종료 코드)나
// 고정된 거절 문구에서만 만든다.
import { isObj, isFlag, itemId } from '../../core/session-items.mjs';
import { firstLine, EXIT_PLAN_QUESTION, EXIT_PLAN_OPTIONS } from '../../session-util.mjs';

export const GROK_AGENT = 'grok';
export const METHODS = Object.freeze(['session/update', '_x.ai/session/update']);
/** Terminal tool statuses written by Grok (ACP also allows pending / in_progress, which are not an end). */
export const TERMINAL_STATUSES = new Set(['completed', 'failed']);
/** Tools that never become a tool_start (ADAPTERS 6.2): the plan record drives the board, search_tool is plumbing. */
export const HIDDEN_TOOLS = new Set(['todo_write', 'enter_plan_mode', 'search_tool']);

const METHOD_SET = new Set(METHODS);
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CHILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,57}$/; // 'grok-' 를 붙여도 publicSessionId (64자) 안
const DENIAL_TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/; // 거절 문구에 넣는 도구 이름 (점, 콜론 없이)
const VARIANT_RE = /^[A-Z][A-Za-z0-9]{1,47}$/; // Rust enum 변형 이름 (FileNotFound, NoMatchesFound ...)
const ERROR_TYPE_RE = /^[a-z][a-z_]{0,19}$/;
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 4; // askFields 는 첫 질문의 선택지 4개만 쓴다
const MAX_PLAN_ENTRIES = 1000;

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

// --------------------------------------------------------------------------------------------- envelope

/** Record time in ms: `timestamp` (unix seconds; ms tolerated), else `_meta.agentTimestampMs`, else null. */
export function recordMs(rec, meta = {}) {
  const t = rec?.timestamp;
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
    if (t < 1e11) return Math.round(t * 1000);
    if (t < 1e14) return Math.round(t);
  }
  const a = meta.agentTimestampMs;
  return typeof a === 'number' && Number.isFinite(a) && a > 1e11 && a < 1e14 ? Math.round(a) : null;
}

/**
 * One parsed line -> { kind, update, meta, promptId, sessionId, ms } or null when it is not a Grok session update.
 * promptId (the turn id) comes from params._meta.promptId (ACP kinds) or, for hook_execution, update.prompt_id.
 * user_message_chunk carries none (research: the turn's id first appears on the records after it).
 */
export function parseRecord(rec) {
  if (!isObj(rec) || !METHOD_SET.has(rec.method) || !isObj(rec.params)) return null;
  const { params } = rec;
  const update = params.update;
  if (!isObj(update) || typeof update.sessionUpdate !== 'string' || update.sessionUpdate === '') return null;
  const meta = isObj(params._meta) ? params._meta : {};
  let promptId = typeof meta.promptId === 'string' ? itemId(meta.promptId) : null;
  if (promptId === null && update.sessionUpdate === 'hook_execution' && typeof update.prompt_id === 'string') {
    promptId = itemId(update.prompt_id);
  }
  return {
    kind: update.sessionUpdate, update, meta, promptId,
    sessionId: typeof params.sessionId === 'string' ? params.sessionId : null, ms: recordMs(rec, meta),
  };
}

// --------------------------------------------------------------------------------------------- text

/** ACP content block ({ type: 'text', text }) or an array of them -> text, or null when there is no text. */
export function contentText(content) {
  const one = (c) => (isObj(c) && (c.type === undefined || c.type === 'text') && typeof c.text === 'string' ? c.text : null);
  if (Array.isArray(content)) {
    const parts = content.map(one).filter((t) => t !== null);
    return parts.length ? parts.join('') : null;
  }
  return one(content);
}

/** First non-empty line of a tool_call_update `content` list ([{ type: 'content', content: { type: 'text', text } }]). */
export function firstContentLine(content) {
  if (!Array.isArray(content)) return '';
  for (const c of content) {
    if (!isObj(c)) continue;
    const text = c.type === 'content' ? contentText(c.content) : c.type === 'text' ? contentText(c) : null;
    const line = firstLine(text);
    if (line) return line;
  }
  return '';
}

/**
 * user_message_chunk -> { text, hidden, interjection, indexed }. hidden: update._meta.hideFromScrollback or
 * syntheticPrompt (injected <system-reminder> / <monitor-event> / synthetic prompts: they open a turn but are not a
 * prompt). indexed: the message carries `promptIndex` (a submitted prompt); a human message without one, typed while a
 * turn runs, belongs to that turn like an interjection (real logs: 7 such messages).
 */
export function userMessageOf(update) {
  const m = isObj(update._meta) ? update._meta : {};
  return {
    text: contentText(update.content),
    hidden: isFlag(m.hideFromScrollback) || isFlag(m.syntheticPrompt),
    interjection: isFlag(m.interjection),
    indexed: Number.isInteger(m.promptIndex),
  };
}

// --------------------------------------------------------------------------------------------- tool start

function xaiTool(update) {
  const m = isObj(update._meta) ? update._meta['x.ai/tool'] : null;
  return isObj(m) ? m : null;
}

/**
 * Tool name: `_meta['x.ai/tool'].name`, never `title` (a display string that can hold paths and commands). A call without
 * x.ai/tool whose rawInput names a `backend` is the server-side web search. Else null (an unknown tool).
 */
export function toolNameOf(update) {
  const x = xaiTool(update);
  const name = x && typeof x.name === 'string' ? x.name.trim() : '';
  if (TOOL_NAME_RE.test(name)) return name;
  if (isObj(update.rawInput) && update.rawInput.backend !== undefined) return 'web_search';
  return null;
}

/** `_meta['x.ai/tool'].kind` (read, execute, search, edit, ...), used only for tools missing from the table. */
export function xaiKindOf(update) {
  const x = xaiTool(update);
  return x && typeof x.kind === 'string' ? x.kind : null;
}

// x.ai/tool.kind -> descriptor kind for tools not in TOOL_TABLE (no input is read for them)
const XAI_KINDS = new Map([
  ['read', 'read'], ['list', 'read'], ['search', 'search'], ['edit', 'edit'], ['write', 'edit'], ['execute', 'shell'],
  ['fetch', 'web'], ['web_fetch', 'web'],
]);

/** ask_user_question questions -> the minimal shape askFields reads ({ question, options: [{ label }] }). */
function questionsOf(qs) {
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, MAX_QUESTIONS).filter(isObj).map((q) => ({
    question: typeof q.question === 'string' ? q.question : '',
    options: (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS)
      .map((o) => ({ label: typeof o === 'string' ? o : isObj(o) && typeof o.label === 'string' ? o.label : '' })),
  }));
}

/** use_tool: tool_name '<server>__<tool>' (double underscore) -> the mcp__<server>__<tool> descriptor. */
function useToolDesc(i) {
  const name = str(i.tool_name)?.trim();
  if (!name) return { kind: 'web' }; // {file} 꼴: MCP 이름이 없다 (정보검색실)
  const k = name.indexOf('__');
  if (k > 0 && k + 2 < name.length) return { kind: 'other', mcpServer: name.slice(0, k), mcpTool: name.slice(k + 2) };
  return { kind: 'other', mcpServer: name };
}

// x.ai/tool.name -> start piece. Only the fields listed here are read from rawInput (ADAPTERS 7.2).
const TOOL_TABLE = {
  read_file: (i) => ({ desc: { kind: 'read', path: str(i.target_file) } }),
  list_dir: (i) => ({ desc: { kind: 'read', path: str(i.target_directory) } }),
  search_replace: (i) => ({ desc: { kind: 'edit', path: str(i.file_path) } }),
  write: (i) => ({ desc: { kind: 'edit', path: str(i.file_path) } }),
  grep: (i) => ({ desc: { kind: 'search', query: str(i.pattern), path: str(i.path) } }),
  run_terminal_command: (i) => ({ desc: { kind: 'shell', command: str(i.command), background: isFlag(i.background) } }),
  // 모니터는 늘 백그라운드 작업이다 (research: task_backgrounded monitor 259/259)
  monitor: (i) => ({ desc: { kind: 'shell', command: str(i.command), background: true } }),
  // 이미 돌고 있는 작업을 들여다보거나 끄는 호출: 명령 없이 서버실 (shell 규칙, 요약은 도구 이름)
  get_command_or_subagent_output: () => ({ desc: { kind: 'shell' } }),
  kill_command_or_subagent: () => ({ desc: { kind: 'shell' } }),
  web_fetch: (i) => ({ desc: { kind: 'web', url: str(i.url) } }),
  web_search: () => ({ desc: { kind: 'web' } }), // 검색어는 끝날 때만 알 수 있다 (rawOutput.action.query, 읽지 않는다)
  use_tool: (i) => ({ desc: useToolDesc(i) }),
  // 요약은 subagent_type (에이전트 종류 이름표). 모델이 쓴 description 과 prompt 는 쓰지 않는다
  spawn_subagent: (i) => ({ desc: { kind: 'agent', description: str(i.subagent_type) } }),
  ask_user_question: (i) => ({ desc: { kind: 'ask' }, questions: questionsOf(i.questions) }),
  // R34: 계획 승인 질문. rawInput 은 {} 라 계획은 보통 끝날 때 (PlanReady.plan_content) 온다
  exit_plan_mode: (i) => ({
    desc: { kind: 'ask' }, question: EXIT_PLAN_QUESTION, options: [...EXIT_PLAN_OPTIONS],
    markdown: str(i.plan) ?? str(i.plan_content),
  }),
  scheduler_list: () => ({ desc: { kind: 'other' } }),
};

function compact(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined || obj[k] === false) delete obj[k];
  return obj;
}

/**
 * tool_call -> { hidden: true } for HIDDEN_TOOLS, else the tool_start item fields without `k` / `id`:
 * { desc, question?, options?, questions?, markdown? } (`markdown`: a plan proposal to show before the question, R34).
 */
export function toolStartOf(name, rawInput, xaiKind = null) {
  if (name !== null && HIDDEN_TOOLS.has(name)) return { hidden: true };
  const input = isObj(rawInput) ? rawInput : {};
  const build = name !== null && Object.hasOwn(TOOL_TABLE, name) ? TOOL_TABLE[name] : null;
  const piece = build ? build(input) : { desc: { kind: XAI_KINDS.get(xaiKind) ?? 'other' } };
  piece.desc = compact({ tool: name ?? 'tool', ...piece.desc });
  return compact(piece);
}

// --------------------------------------------------------------------------------------------- tool end

/** rawOutput { type: 'X', X: {...} } (adjacently tagged): the payload object of `name`, also one level down. */
function variantPayload(out, name) {
  if (isObj(out[name])) return out[name];
  const inner = isObj(out[out.type]) ? out[out.type] : null;
  if (!inner) return null;
  if (isObj(inner[name])) return inner[name];
  return inner.type === name ? inner : null;
}

/** Bash result exit code (rawOutput.type 'Bash'), or null. */
export function bashExitCode(out) {
  if (!isObj(out) || out.type !== 'Bash') return null;
  const p = isObj(out.Bash) ? out.Bash : out;
  return Number.isInteger(p.exit_code) ? p.exit_code : null;
}

/** The inner enum variant of a failed result ('FileNotFound', 'NoMatchesFound', ...), or null. Never a value. */
function variantName(out) {
  const t = typeof out.type === 'string' ? out.type : '';
  const inner = t ? out[t] : undefined;
  if (typeof inner === 'string' && VARIANT_RE.test(inner)) return inner;
  if (isObj(inner)) {
    if (typeof inner.type === 'string' && inner.type !== t && VARIANT_RE.test(inner.type)) return inner.type;
    const k = Object.keys(inner).find((key) => VARIANT_RE.test(key));
    if (k) return k;
  }
  return Object.keys(out).find((key) => key !== 'type' && key !== t && VARIANT_RE.test(key)) ?? null;
}

/** Error line of a failed result with rawOutput: { error, message }, an exit code or the variant name; else undefined. */
function failureLine(out) {
  for (const f of ['error', 'message']) {
    const line = firstLine(out[f]);
    if (line) return line;
  }
  const code = bashExitCode(out);
  if (code !== null && code !== 0) return `Exit code ${code}`;
  const v = variantName(out);
  if (v) return v;
  const mcp = out.type === 'MCP' ? variantPayload(out, 'MCP') : null;
  return mcp && mcp.is_error === true ? 'MCP tool error' : undefined;
}

const NOT_EXECUTED_RE = /^Tool \S+ was not executed:\s*(.*)$/;
const NOT_EXECUTED_REASONS = ['Auto mode blocked this action', 'Denied by permission policy'];

/**
 * The fixed denial phrases of a failed update without rawOutput (research: 80/80 were denials) -> a fixed error line, or
 * null. The rest of the text (a hook's or classifier's reason) is never kept; the tool name is ours, not the text's.
 */
export function denialLine(line, name) {
  if (typeof line !== 'string' || line === '') return null;
  const tool = typeof name === 'string' && DENIAL_TOOL_RE.test(name) ? name : 'tool';
  const m = NOT_EXECUTED_RE.exec(line);
  if (m) {
    const reason = NOT_EXECUTED_REASONS.find((r) => m[1].startsWith(r));
    return reason ? `Tool ${tool} was not executed: ${reason}` : `Tool ${tool} was not executed`;
  }
  if (line.startsWith('Hook denied:')) return 'Hook denied';
  if (line.startsWith('User rejected the execution')) return 'User rejected the execution';
  if (line.startsWith('Rejected: file edits are not allowed in plan')) return 'Rejected: file edits are not allowed in plan mode';
  if (line.startsWith('Rejected:')) return 'Rejected';
  return null;
}

// exit_plan_mode 이 rawOutput 없이 completed: 사용자가 수정 요청이나 포기를 골랐다 (research: 24건). 고정 문구만 쓴다
function planRejectLine(line) {
  if (line.startsWith('The user wants to revise')) return 'User asked to revise the plan';
  if (line.startsWith('The user chose to abandon')) return 'User abandoned the plan';
  return 'Plan not approved';
}

function completedEnd(name, out, content) {
  if (name === 'exit_plan_mode') {
    const ready = out ? variantPayload(out, 'PlanReady') : null;
    if (ready) return compact({ status: 'ok', markdown: str(ready.plan_content) });
    return out ? { status: 'ok' } : { status: 'denied', errorLine: planRejectLine(firstContentLine(content)) };
  }
  if (name === 'spawn_subagent') return { status: 'ok' }; // 비동기 실행 (R28): 띄웠으면 ok
  const code = bashExitCode(out);
  // 종료 코드가 0 이 아닌 셸 명령도 completed 로 적힌다 (research: 602건): 실패로 바꾼다. 출력 본문은 쓰지 않는다
  if (code !== null && code !== 0) return { status: 'failed', errorLine: `Exit code ${code}` };
  if (out && out.type === 'BackgroundTaskStarted') return { status: 'ok', background: true };
  return { status: 'ok' };
}

/**
 * tool_call(_update) with a terminal status -> { status: 'ok'|'failed'|'denied', errorLine?, background?, markdown? },
 * else null (the first update only repeats rawInput / title / locations). `markdown`: the approved plan (PlanReady).
 */
export function toolEndOf(name, update) {
  if (!isObj(update) || !TERMINAL_STATUSES.has(update.status)) return null;
  const out = isObj(update.rawOutput) ? update.rawOutput : null;
  if (update.status === 'completed') return completedEnd(name, out, update.content);
  if (!out) {
    const line = denialLine(firstContentLine(update.content), name);
    return line ? { status: 'denied', errorLine: line } : { status: 'failed' };
  }
  return compact({ status: 'failed', errorLine: failureLine(out) });
}

// --------------------------------------------------------------------------------------------- other kinds

/** plan record -> the full list [{ content, status }] (ACP stores a cancelled todo as completed + _meta.cancelled). */
export function planItemsOf(update) {
  if (!Array.isArray(update.entries)) return null;
  return update.entries.slice(0, MAX_PLAN_ENTRIES).filter(isObj).map((e) => ({
    content: typeof e.content === 'string' ? e.content : '',
    status: e.status === 'cancelled' ? 'completed' : e.status,
  }));
}

/** turn_completed.stop_reason -> turn_end reason. */
export function turnReasonOf(stopReason) {
  if (stopReason === 'cancelled') return 'interrupt';
  if (stopReason === 'error') return 'api_error';
  return 'end_turn';
}

/** retry_state -> system api_error fields, or null for an unknown type. */
export function retrySystem(update) {
  if (update.type === 'retrying') {
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : '?');
    const kind = typeof update.error_type === 'string' && ERROR_TYPE_RE.test(update.error_type) ? ` (${update.error_type})` : '';
    return { kind: 'api_error', text: `API 재시도 ${n(update.attempt)}/${n(update.max_retries)}${kind}` };
  }
  if (update.type === 'failed') return { kind: 'api_error', text: firstLine(update.message) || 'API error' };
  return null;
}

/** subagent_finished / subagent_spawned -> the child's D2 id '<agent>-<child_session_id>', or null. */
export function childIdOf(update, agent = GROK_AGENT) {
  const c = update.child_session_id ?? update.subagent_id;
  return typeof c === 'string' && CHILD_ID_RE.test(c) ? `${agent}-${c}` : null;
}
