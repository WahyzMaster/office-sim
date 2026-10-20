// Codex rollout record -> pieces of SessionCore items (pure, no state). ADAPTERS 5.1, 6.1, 6.2, 7; 형식 근거는
// docs/research/codex-format.json (구조와 개수만 센 조사). 상태가 필요한 부분(열린 호출 표, code-mode 창, 턴 id, 서브의
// 상속 문맥 건너뛰기, ordinal dedupe)은 session.mjs 의 CodexSession 이, code-mode exec 는 exec.mjs 가 한다.
//
// Envelope: { timestamp: '<ISO ms Z>', ordinal: <0-based line index>, type, payload, metadata? }.
// 개인정보 (CONTRACT 5, ADAPTERS 7): session_meta 에서는 cwd, git.branch, cli_version, subagent_history_start_ordinal,
// 서브의 역할/별명/경로 끝 조각만 읽는다 (계정 id, 지침, 저장소 URL 은 읽지 않는다). 도구 설명자는 허용된 인자 조각만
// 꺼낸다 (셸 명령 문자열이나 argv -> 프로그램 이름, patch -> 헤더의 파일 이름, 경로 -> basename, 질문과 선택지 이름,
// 에이전트 종류, MCP 이름). workdir, justification, message, explanation, 결과 본문은 읽지 않는다. 오류 문구는 고정
// 문구나 종료 코드로만 만든다.
import { isObj } from '../../core/session-items.mjs';
import { firstLine } from '../../session-util.mjs';

export const CODEX_AGENT = 'codex';

/** From this cli_version on, say / thinking are read from item_completed (AgentMessage, Reasoning), before from response_item. */
export const ITEM_TEXT_SINCE = Object.freeze([0, 142, 5]);

/**
 * Plumbing calls that never become a tool_start (ADAPTERS 6.2 "무시"): write_stdin and wait look into a command or
 * script cell that is already running; the rest are tool lookup and resource helpers. Their outputs are ignored too.
 */
export const HIDDEN_TOOLS = new Set([
  'write_stdin', 'wait', 'search_tool_bm25', 'list_mcp_resources', 'list_mcp_resource_templates', 'get_goal',
]);

const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CHILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,57}$/; // 'codex-' 를 붙여도 publicSessionId (64자) 안
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 4; // askFields 는 첫 질문의 선택지 4개만 쓴다
const MAX_PLAN = 1000;
const MAX_JSON = 4 * 1024 * 1024; // 이보다 큰 JSON 결과 문자열은 풀지 않는다 (종료 코드 없이 ok)
const MAX_HEAD_LINES = 12;

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

// --------------------------------------------------------------------------------------------- envelope

/** One parsed line -> { type, sub (payload.type), payload, ordinal (int >= 0 or null), ms (or null) }, or null. */
export function parseRecord(rec) {
  if (!isObj(rec) || typeof rec.type !== 'string' || rec.type === '' || !isObj(rec.payload)) return null;
  const { payload } = rec;
  const ordinal = Number.isSafeInteger(rec.ordinal) && rec.ordinal >= 0 ? rec.ordinal : null;
  let ms = null;
  if (typeof rec.timestamp === 'string') {
    const t = Date.parse(rec.timestamp);
    if (Number.isFinite(t)) ms = t;
  }
  return { type: rec.type, sub: typeof payload.type === 'string' ? payload.type : null, payload, ordinal, ms };
}

/** cli_version ('0.162.0-alpha.17.2') -> [major, minor, patch] (a pre-release suffix is ignored), or null. */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^\s*v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(v, min) {
  const p = parseVersion(v);
  if (!p) return false;
  for (let i = 0; i < 3; i++) if (p[i] !== min[i]) return p[i] > min[i];
  return true;
}

/**
 * Which duplicate carries say / thinking for this file (research: paginated files write an assistant message and a
 * reasoning block twice). 'item': item_completed AgentMessage / Reasoning (the code-mode era, where the item log is the
 * primary record and Reasoning items carry started/completed times); 'response': response_item message / reasoning
 * (every version has it, so an unknown or missing version reads it).
 */
export function textSource(cliVersion) {
  return versionAtLeast(cliVersion, ITEM_TEXT_SINCE) ? 'item' : 'response';
}

// --------------------------------------------------------------------------------------------- session_meta

/**
 * session_meta payload -> the facts the session uses. Nothing else of the line is read (creator_* account ids,
 * base_instructions, git.repository_url, commit hashes, originator, model ...).
 * @returns {{ id: string|null, cwd?: string, branch?: string, cliVersion?: string, historyStart: number|null,
 *   spawn: boolean, guardian: boolean, review: boolean, role?: string, nickname?: string, pathName?: string }}
 */
export function sessionMetaOf(p) {
  const sub = isObj(p.source) ? p.source.subagent : undefined;
  const spawn = isObj(sub) && isObj(sub.thread_spawn) ? sub.thread_spawn : null;
  const h = p.subagent_history_start_ordinal;
  const path = str(spawn?.agent_path) ?? str(p.agent_path);
  const last = path ? path.split('/').filter(Boolean).pop() : undefined;
  return {
    id: str(p.id) ?? null,
    cwd: str(p.cwd)?.startsWith('/') ? p.cwd : undefined,
    branch: isObj(p.git) ? str(p.git.branch) : undefined,
    cliVersion: str(p.cli_version),
    historyStart: Number.isSafeInteger(h) && h >= 0 ? h : null,
    spawn: spawn !== null,
    guardian: isObj(sub) && sub.other === 'guardian',
    review: sub === 'review',
    role: str(spawn?.agent_role) ?? str(p.agent_role),
    nickname: str(spawn?.agent_nickname) ?? str(p.agent_nickname),
    pathName: last,
  };
}

/**
 * Facts -> the `meta` item: cwd and branch; for a sub (isSub) agentType (role, 'review' for /review threads, D10d) and a
 * fallback title (nickname, else the last agent_path segment; the session_index sidecar title wins later). A main whose
 * own line says it runs a parent's task (thread_spawn / review) gets `subagent: true` (no prompts, no prompt title).
 */
export function metaItemOf(f, isSub) {
  const m = { k: 'meta' };
  if (f.cwd) m.cwd = f.cwd;
  if (f.branch) m.branch = f.branch;
  if (isSub) {
    const type = f.review ? 'review' : f.role;
    if (type) m.agentType = type;
    const title = f.nickname ?? f.pathName;
    if (title) m.title = title;
  } else if (f.spawn || f.review) {
    m.subagent = true;
  }
  return m;
}

// --------------------------------------------------------------------------------------------- text

// The desktop and IDE clients put context sections ('# Context from my IDE setup:', '# Files mentioned by the user:', ...)
// in front of the human's request and mark the request with '## My request:' (legacy and TUI: '## My request for
// Codex:'); the marker is only written when such a prefix exists. The request is the text after the last marker.
const REQUEST_MARK_RE = /## My request(?: for Codex)?:/g;

function requestOf(text) {
  let end = -1;
  for (const m of text.matchAll(REQUEST_MARK_RE)) end = m.index + m[0].length;
  if (end < 0) return text;
  const req = text.slice(end).trim();
  return req === '' ? null : req; // 요청 없는 문맥 묶음은 프롬프트가 아니다 (열린 파일 경로를 보이지 않는다)
}

/**
 * UserMessage item -> the first text part, or null. A context wrapper with the '## My request:' marker gives only the
 * text after its last marker (ADAPTERS 7 #3: injected context is never a prompt); none after it -> null.
 */
export function userMessageText(item) {
  if (!Array.isArray(item.content)) return null;
  for (const c of item.content) if (isObj(c) && c.type === 'text' && typeof c.text === 'string') return requestOf(c.text);
  return null;
}

function joinParts(content, type) {
  if (!Array.isArray(content)) return null;
  const parts = content.filter((c) => isObj(c) && c.type === type && typeof c.text === 'string').map((c) => c.text);
  return parts.length ? parts.join('') : null;
}

/** response_item message role=assistant -> its output_text, or null (other roles are injected context, never text). */
export function assistantText(p) {
  return p.role === 'assistant' ? joinParts(p.content, 'output_text') : null;
}

/** AgentMessage item -> its Text parts, or null. */
export function agentMessageText(item) {
  return joinParts(item.content, 'Text');
}

/** response_item reasoning -> the first non-empty summary text, else null (raw reasoning is encrypted, never read). */
export function reasoningSummary(p) {
  if (!Array.isArray(p.summary)) return null;
  for (const s of p.summary) if (isObj(s) && typeof s.text === 'string' && s.text.trim() !== '') return s.text;
  return null;
}

/** Reasoning item -> the first non-empty summary_text entry, else null. */
export function reasoningItemSummary(item) {
  if (!Array.isArray(item.summary_text)) return null;
  for (const s of item.summary_text) if (typeof s === 'string' && s.trim() !== '') return s;
  return null;
}

/** item_completed payload -> completed_at_ms - started_at_ms when both are there, else null. */
export function itemDurationMs(p) {
  const a = p.started_at_ms;
  const b = p.completed_at_ms;
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/** SubAgentActivity.agent_thread_id -> the child's D2 id 'codex-<id>', or null. */
export function childIdOf(id, agent = CODEX_AGENT) {
  return typeof id === 'string' && CHILD_ID_RE.test(id) ? `${agent}-${id}` : null;
}

// --------------------------------------------------------------------------------------------- tool start

function parseArgs(raw) {
  if (isObj(raw)) return raw;
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const v = JSON.parse(raw);
    return isObj(v) ? v : {};
  } catch {
    return {}; // research: 2 of 498,056 arguments did not parse
  }
}

const command = (v) => (typeof v === 'string' || Array.isArray(v) ? v : undefined);

/**
 * request_user_input questions -> the minimal shape askFields reads ({ question, options: [{ label }] }). The async form
 * (request_user_input_async) names the question `title` and gives options as strings or null (real data: key sets
 * {title} and {options, title}); only that text and the labels are read.
 */
function questionsOf(qs) {
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, MAX_QUESTIONS).filter(isObj).map((q) => ({
    question: typeof q.question === 'string' ? q.question : typeof q.title === 'string' ? q.title : '',
    options: (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS)
      .map((o) => ({ label: typeof o === 'string' ? o : isObj(o) && typeof o.label === 'string' ? o.label : '' })),
  }));
}

/** update_plan arguments.plan [{ step, status }] -> [{ content, status }] (the status enum is CONTRACT's). */
export function planItemsOf(args) {
  if (!Array.isArray(args.plan)) return null;
  return args.plan.slice(0, MAX_PLAN).filter(isObj).map((s) => ({
    content: typeof s.step === 'string' ? s.step : '', status: s.status,
  }));
}

const ask = (a) => ({ desc: { kind: 'ask' }, questions: questionsOf(a.questions) });
const agent = () => ({ desc: { kind: 'agent' } });

// function name (bare, or '<namespace>.<name>') -> start piece. Only the argument fields named here are read.
const FUNCTIONS = {
  exec_command: (a) => ({ desc: { kind: 'shell', command: command(a.cmd) } }),
  shell_command: (a) => ({ desc: { kind: 'shell', command: command(a.command) } }),
  shell: (a) => ({ desc: { kind: 'shell', command: command(a.command) } }), // argv 배열 (문자열이면 명령 문자열)
  update_plan: (a) => {
    const items = planItemsOf(a);
    return items ? { desc: { kind: 'plan' }, items, source: 'update_plan' } : { desc: { kind: 'plan' } };
  },
  request_user_input: ask,
  request_user_input_async: ask, // 답을 기다리지 않는 질문: 출력 {accepted} 에서 끝난다
  view_image: (a) => ({ desc: { kind: 'read', path: str(a.path) } }),
  // 요약은 에이전트 종류 (explorer, worker, ...). 모델이 쓴 message 와 task_name 은 읽지 않는다
  spawn_agent: (a) => ({ desc: { kind: 'agent', description: str(a.agent_type) } }),
  wait_agent: agent,
  close_agent: agent,
  send_input: agent,
  send_message: agent,
  followup_task: agent,
  list_agents: agent,
  interrupt_agent: agent,
  'web.run': () => ({ desc: { kind: 'web' } }), // 인자는 읽지 않는다 (모양 미확인)
  'clock.sleep': () => ({ desc: { kind: 'other' }, lounge: true }), // ADAPTERS 6.2 라운지
};

/** A call's public name parts: { name, namespace, full } (full = '<namespace>.<name>' or the name), names validated. */
export function callNameOf(p) {
  const name = typeof p.name === 'string' && TOOL_NAME_RE.test(p.name) ? p.name : null;
  const namespace = typeof p.namespace === 'string' && TOOL_NAME_RE.test(p.namespace) ? p.namespace : null;
  const full = name === null ? 'tool' : namespace && !namespace.startsWith('mcp__') ? `${namespace}.${name}` : name;
  return { name, namespace, full };
}

/**
 * function_call / custom_tool_call payload -> one of
 *   { hidden: true }                       plumbing (HIDDEN_TOOLS): no tool_start, its output is ignored
 *   { exec: true, script }                 code-mode exec (exec.mjs)
 *   { name, start: { tool, desc, questions?, items?, source? }, lounge? }  the tool_start item fields
 * @param {'function'|'custom'} kind  function_call or custom_tool_call
 */
export function callStartOf(p, kind = 'function') {
  const { name, namespace, full } = callNameOf(p);
  if (kind === 'custom') {
    if (name === 'exec') return { exec: true, script: typeof p.input === 'string' ? p.input : '' };
    // apply_patch: 헤더의 파일 이름만 쓴다 (본문은 tool-summary 가 버린다)
    const desc = name === 'apply_patch' ? { kind: 'edit', patch: typeof p.input === 'string' ? p.input : undefined } : { kind: 'other' };
    return { name: full, start: { tool: full, desc: { tool: full, ...clean(desc) } } };
  }
  if (namespace?.startsWith('mcp__') && name !== null) { // 0.117+: namespace mcp__<server> + name <tool>
    const desc = { tool: `${namespace}__${name}`, kind: 'other', mcpServer: namespace.slice(5), mcpTool: name };
    return { name: full, start: { tool: desc.tool, desc } };
  }
  if (name !== null && HIDDEN_TOOLS.has(full)) return { hidden: true }; // 이름공간 없는 배관 호출만
  if (name !== null && name.startsWith('mcp__')) { // 옛 이름 mcp__<server>__<tool> (tool-summary 가 정규화한다)
    return { name: full, start: { tool: name, desc: { tool: name, kind: 'other' } } };
  }
  const build = Object.hasOwn(FUNCTIONS, full) ? FUNCTIONS[full] : name !== null && Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : null;
  const piece = build ? build(parseArgs(p.arguments)) : { desc: { kind: 'other' } };
  const { lounge, desc, ...rest } = piece;
  const out = { name: full, start: { tool: full, desc: { tool: full, ...clean(desc) }, ...rest } };
  if (lounge) out.lounge = true;
  return out;
}

function clean(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** response_item web_search_call (0.91 - 0.142.5, no output record) -> { desc, end }. */
export function webSearchCallOf(p) {
  const a = isObj(p.action) ? p.action : {};
  const query = str(a.query) ?? (Array.isArray(a.queries) ? str(a.queries[0]) : undefined);
  const desc = clean({ tool: 'web_search', kind: 'web', url: str(a.url), query: str(a.url) ? undefined : query });
  return { desc, end: p.status === 'failed' ? { status: 'failed' } : { status: 'ok' } };
}

// --------------------------------------------------------------------------------------------- tool end

/** function_call_output / custom_tool_call_output `output` -> its text (a string, or the first input_text), or null. */
export function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    for (const o of output) if (isObj(o) && o.type === 'input_text' && typeof o.text === 'string') return o.text;
  }
  return null;
}

function exitEnd(code) {
  return code === 0 ? { status: 'ok' } : { status: 'failed', errorLine: `Exit code ${code}` };
}

// JSON result string { output, metadata: { exit_code } } (shell <= 0.58, apply_patch): the exit code, null for other
// JSON (answers, MCP results, arrays: ok), undefined when it is not JSON. The `output` body is never read.
function jsonExit(text) {
  if (text.length > MAX_JSON || !(text.endsWith('}') || text.endsWith(']'))) return undefined;
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return null;
    if (!isObj(v)) return undefined;
    return isObj(v.metadata) && Number.isInteger(v.metadata.exit_code) ? v.metadata.exit_code : null;
  } catch {
    return undefined;
  }
}

const HEADER_RE = /^(?:Chunk ID|Wall time|Original token count):/;
const EXITED_RE = /^Process exited with code (-?\d+)/;
const RUNNING_RE = /^Process running with session ID\b/;
const EXIT_LINE_RE = /^Exit code:\s*(-?\d+)/;
const FAILED_RE = /^[a-z0-9_. -]{1,64} failed\b/;
const SAFE_TOOL_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// exec_command / write_stdin header ('Chunk ID: ...', 'Wall time: ...', 'Process exited with code n' |
// 'Process running with session ID n', 'Original token count: ...', 'Output:'): only the lines before 'Output:'.
function headerEnd(text) {
  const lines = text.split('\n', MAX_HEAD_LINES);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'Output:') break;
    const m = EXITED_RE.exec(line);
    if (m) return exitEnd(Number(m[1]));
    if (RUNNING_RE.test(line)) return { status: 'ok', background: true }; // 백그라운드로 계속 돈다 (R28)
  }
  return { status: 'ok' };
}

/**
 * Fixed-phrase outcomes of a first line that is not a result header (research "Errors, denials, interrupts"):
 * aborted -> interrupted; rejected / approval policy / sandbox -> denied; timed out, 'Script failed', '<x> failed' ->
 * failed. The error lines are fixed text (the tool name is the call's own), never the output's words.
 */
export function phraseEnd(first, tool = 'tool') {
  const low = first.toLowerCase();
  if (low.startsWith('aborted by user')) return { status: 'interrupted', errorLine: 'Aborted by user' };
  if (low.includes('rejected by user') || low.includes('exec command rejected') || low.includes('patch rejected')) {
    return { status: 'denied', errorLine: 'Rejected by user' };
  }
  if (low.includes('approval required by policy')) return { status: 'denied', errorLine: 'Approval required by policy' };
  if (low.includes('sandbox denied') || low.includes('failed in sandbox')) return { status: 'denied', errorLine: 'Sandbox denied' };
  if (low.startsWith('command timed out')) return { status: 'failed', errorLine: 'Command timed out' };
  if (low.startsWith('script failed')) return { status: 'failed', errorLine: 'Script failed' };
  if (low.startsWith('script error')) return { status: 'failed', errorLine: 'Script error' };
  if (FAILED_RE.test(low)) return { status: 'failed', errorLine: `${SAFE_TOOL_RE.test(tool) ? tool : 'tool'} failed` };
  return null;
}

/**
 * A function / custom tool output -> { status: 'ok'|'failed'|'denied'|'interrupted', errorLine?, background? }.
 * Exit codes: JSON metadata.exit_code, 'Exit code: <n>' (shell_command, apply_patch text), 'Process exited with code
 * <n>' (exec_command, write_stdin); 'Process running with session ID' -> ok + background. Otherwise the first line's
 * fixed phrases (phraseEnd), else ok. Result bodies are never read beyond the first line or the header.
 */
export function outputEndOf(output, tool = 'tool') {
  if (isObj(output) && isObj(output.metadata) && Number.isInteger(output.metadata.exit_code)) return exitEnd(output.metadata.exit_code);
  // 내용 항목 배열 (MCP 결과, 이미지) 은 결과 본문이다: 문구로 판정하지 않는다 (Codex 의 실패/거절 문구는 문자열 출력)
  if (typeof output !== 'string') return { status: 'ok' };
  const t = output.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    const code = jsonExit(t.trimEnd());
    if (code !== undefined) return code === null ? { status: 'ok' } : exitEnd(code);
  }
  const first = firstLine(t.slice(0, 4096));
  const exit = EXIT_LINE_RE.exec(first);
  if (exit) return exitEnd(Number(exit[1]));
  if (HEADER_RE.test(first) || EXITED_RE.test(first) || RUNNING_RE.test(first)) return headerEnd(t);
  return phraseEnd(first, tool) ?? { status: 'ok' };
}
