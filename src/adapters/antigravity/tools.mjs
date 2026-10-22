// Antigravity tool calls -> normalized tool descriptors for SessionCore (pure). ADAPTERS 6.2 (Antigravity column), 7;
// CONTRACT 4.0.2. 형식 근거는 docs/research/antigravity-format.json (구조와 개수만 센 조사).
//
// 이름 표는 두 시대를 모두 받는다: 예전 CLI (view_file, write_to_file, toolAction/toolSummary 인자)와 1.4.x
// (read_file, write_file, edit_file, Path/Content/Target/Replacement 인자; edit_file 은 조사 파일이 아니라 통합 단계의
// 실제 데이터 개수 확인에서 찾았다). 두 transcript 형식도 받는다: transcript_full.jsonl 은 인자가 원래 JSON 타입
// (경로는 그냥 문자열, StartLine 은 정수, questions 는 배열)이고, transcript.jsonl 은 모든 인자 값이 JSON 으로 한 번 더
// 감싼 문자열이다 (경로가 따옴표로 시작한다). 긴 값은 잘려 있을 수 있다 (truncated_fields).
//
// 개인정보 (CONTRACT 5, ADAPTERS 7): 설명자에는 표에 적힌 인자만 들어간다. 경로 (core 가 basename 으로), run_command 의
// CommandLine (core 가 programOf 로 프로그램 이름만), URL (host 만), 검색어, MCP 서버/도구 이름, 질문과 선택지 이름.
// toolAction, toolSummary, Description, Instruction, CodeContent, Content, ReplacementContent, ReplacementChunks,
// TargetContent, Target, Replacement, ArtifactMetadata, Cwd, Arguments, Prompt, Task, TaskName, TaskSummary 같은 나머지
// 인자는 읽지 않는다. Cwd 는 설명자가 아니라 작업 폴더 대안으로만 쓴다 (cwdOfCall, 세션이 정한 때에만).
import { isObj } from '../../core/session-items.mjs';

const NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 4; // askFields 는 첫 질문의 선택지 4개만 쓴다
const MAX_TEXT = 4096; // 설명자에 넘기는 문자열 조각의 상한 (core 가 다시 줄인다)

// --------------------------------------------------------------------------------------------- argument values

/**
 * A string argument. `format` is the file's format when the scan knows it (ref facts): 'full' (transcript_full.jsonl,
 * native values: a string is taken as is), 'truncated' (transcript.jsonl: every value is JSON-encoded, so a string must
 * decode from '"..."'; one cut by the truncation does not and is dropped), or null (unknown: a value that starts with '"'
 * is decoded, and dropped when it does not decode to a string, rather than guessed at; any other string is taken as is).
 * @param {unknown} v
 * @param {'full'|'truncated'|null} [format]
 * @returns {string|undefined}
 */
export function argString(v, format = null) {
  if (typeof v !== 'string') return undefined;
  let s = v;
  if (format === 'truncated' || (format !== 'full' && v.startsWith('"'))) {
    try {
      s = JSON.parse(v);
    } catch {
      return undefined;
    }
    if (typeof s !== 'string') return undefined;
  }
  return s.trim() === '' ? undefined : s.slice(0, MAX_TEXT);
}

/** A list argument (native array, or a JSON-encoded array in transcript.jsonl). @returns {any[]|undefined} */
export function argList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return undefined;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** The args object of one call: native, or the whole object JSON-encoded (tolerated). Never throws. */
export function argsOf(call) {
  const a = isObj(call) ? call.args : undefined;
  if (isObj(a)) return a;
  if (typeof a === 'string') {
    try {
      const p = JSON.parse(a);
      if (isObj(p)) return p;
    } catch {
      // 잘린 인자: 아무것도 읽지 않는다
    }
  }
  return {};
}

const firstString = (args, keys, format) => {
  for (const k of keys) {
    const v = argString(args[k], format);
    if (v !== undefined) return v;
  }
  return undefined;
};

// --------------------------------------------------------------------------------------------- name table

const T = (kind, fields = {}) => Object.freeze({ kind, ...fields });

/**
 * ADAPTERS 6.2 Antigravity column, both eras. Fields: kind (the core's tool kind), path / query / command / url (the
 * argument keys read for that descriptor field, first present wins), mcp (ServerName + ToolName), questions
 * (ask_question), room (a room hint the core's kinds do not have: lounge), hidden (plumbing: no tool_start, no tool_end,
 * but it still takes its result line, so the calls after it stay paired). Rooms: read/search -> archive, edit -> dev,
 * shell -> program rule (server without a command), web -> research, MCP -> none (the page classifies the name), ask ->
 * desk, agent/other -> here.
 */
export const TOOLS = Object.freeze({
  // 자료실
  view_file: T('read', { path: ['AbsolutePath'] }),
  read_file: T('read', { path: ['Path', 'AbsolutePath'] }), // 1.4.x
  list_dir: T('read', { path: ['DirectoryPath'] }),
  grep_search: T('search', { query: ['Query'], path: ['SearchPath'] }),
  find_by_name: T('search', { query: ['Pattern'], path: ['SearchDirectory'] }),
  // 개발실
  write_to_file: T('edit', { path: ['TargetFile'] }),
  write_file: T('edit', { path: ['Path', 'TargetFile'] }), // 1.4.x
  edit_file: T('edit', { path: ['Path', 'TargetFile'] }), // 1.4.x (Path, Target, Replacement): Target/Replacement 는 읽지 않는다
  replace_file_content: T('edit', { path: ['TargetFile'] }),
  multi_replace_file_content: T('edit', { path: ['TargetFile'] }),
  // 서버실 (run_command 는 프로그램 이름 규칙: grep/cat -> 자료실, curl -> 정보검색실)
  run_command: T('shell', { command: ['CommandLine'] }),
  command_status: T('shell'), // CommandId 는 읽지 않는다
  manage_task: T('shell'), // 백그라운드 작업 제어 (할 일 목록이 아니다). Action, TaskId 는 읽지 않는다
  // 정보검색실
  search_web: T('web', { query: ['query'] }), // domain 은 읽지 않는다
  read_url_content: T('web', { url: ['Url'] }),
  call_mcp_tool: T('web', { mcp: true }), // Arguments 는 읽지 않는다
  list_resources: T('web'), // 2.x MCP 리소스 목록 (ServerName 은 읽지 않는다)
  read_resource: T('web'), // 2.x MCP 리소스 읽기 (ServerName, Uri 는 읽지 않는다)
  // 내 자리
  ask_question: T('ask', { questions: true }),
  // 제자리 (서브에이전트 연결은 없다: 부모 직원의 도구 호출로 보인다)
  define_subagent: T('agent'), // 2.x 서브에이전트 정의 (Name, Description, SystemPrompt 는 읽지 않는다)
  invoke_subagent: T('agent'), // 2.x 서브에이전트 호출 (TypeName, Role, Prompt 는 읽지 않는다)
  send_message: T('agent'), // 2.x 에이전트 메시지 전달 (Recipient, Message 는 읽지 않는다)
  manage_subagents: T('agent'),
  browser_subagent: T('agent'), // Task, TaskName, TaskSummary, RecordingName 은 읽지 않는다
  generate_image: T('other'), // Prompt, ImageName 은 읽지 않는다
  // 라운지
  schedule: T('other', { room: 'lounge' }), // DurationSeconds, TimerCondition, Prompt 는 읽지 않는다
  // 배관
  list_permissions: T('other', { hidden: true }),
});

/** A tool name as written in the call, validated (`tool` when it is missing or odd). */
export function toolNameOf(call) {
  const n = isObj(call) ? call.name : undefined;
  return typeof n === 'string' && NAME_RE.test(n) ? n : 'tool';
}

// ask_question { questions: [{ question, options[], is_multi_select }] } -> only the question text and option names
function questionsOf(args) {
  const list = argList(args.questions);
  if (!list) return [];
  const out = [];
  for (const q of list.slice(0, MAX_QUESTIONS)) {
    if (!isObj(q) || typeof q.question !== 'string') continue;
    const opts = Array.isArray(q.options) ? q.options.slice(0, MAX_OPTIONS) : [];
    out.push({
      question: q.question.slice(0, MAX_TEXT),
      options: opts.map((o) => (typeof o === 'string' ? o : isObj(o) && typeof o.label === 'string' ? o.label : ''))
        .map((o) => o.slice(0, MAX_TEXT)),
    });
  }
  return out;
}

/**
 * One tool call `{ name, args }` -> what the session needs:
 *   { hidden: true, name }                          plumbing (list_permissions)
 *   { name, start: { tool, kind, desc, questions? }, room? }   the tool_start item fields (without id)
 * Only the argument keys of the table are read (both formats, `format` as for argString). An unknown name keeps its
 * name, kind other, no argument.
 */
export function callStartOf(call, format = null) {
  const name = toolNameOf(call);
  const spec = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (spec?.hidden) return { hidden: true, name };
  if (!spec) return { name, start: { tool: name, kind: 'other', desc: { tool: name, kind: 'other' } } };
  const args = argsOf(call);
  const desc = { tool: name, kind: spec.kind };
  if (spec.path) {
    const p = firstString(args, spec.path, format);
    if (p !== undefined) desc.path = p;
  }
  if (spec.query) {
    const q = firstString(args, spec.query, format);
    if (q !== undefined) desc.query = q;
  }
  if (spec.command) {
    const c = firstString(args, spec.command, format);
    if (c !== undefined) desc.command = c;
  }
  if (spec.url) {
    const u = firstString(args, spec.url, format);
    if (u !== undefined) desc.url = u;
  }
  if (spec.mcp) {
    const server = argString(args.ServerName, format);
    const tool = argString(args.ToolName, format);
    if (server !== undefined || tool !== undefined) {
      desc.mcpServer = server ?? '';
      desc.mcpTool = tool ?? '';
    }
  }
  const start = { tool: name, kind: spec.kind, desc };
  if (spec.questions) start.questions = questionsOf(args);
  const out = { name, start };
  if (spec.room) out.room = spec.room;
  return out;
}

/** The `Cwd` of a run_command call when it is an absolute path (the cwd fallback, ADAPTERS 6.1), else null. */
export function cwdOfCall(call, format = null) {
  if (toolNameOf(call) !== 'run_command') return null;
  const cwd = argString(argsOf(call).Cwd, format);
  return cwd !== undefined && cwd.startsWith('/') ? cwd : null;
}
