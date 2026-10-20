// Codex code-mode `exec` (ADAPTERS 6.3, decision D10 b/c). From 0.142.5 the model drives almost everything through one
// custom tool `exec` whose input is a script calling tools.<name>(...). The inner calls have no call record of their
// own: they show up only as item_completed items (CommandExecution, FileChange, McpToolCall, WebSearch, ImageView)
// written while the exec call is still open. Pure helpers; CodexSession (session.mjs) keeps the open exec calls.
//
// 1. The exec call -> an outer tool_start (tool 'exec') whose summary and room come from the FIRST tools.<name>
//    identifier of the script: identifiers only (outside string literals and comments), never an argument.
// 2. While an exec is open, each inner item -> a short tool_start + tool_end pair keyed by the item id (a visit).
// 3. The exec output -> the outer tool_end ('Script failed' / 'Script error' -> failed, 'aborted by user' -> interrupted).
// 4. tools.update_plan(...) inside a script is not shown (D10c): the script text is never parsed for arguments.
// 개인정보: 스크립트에서는 tools. 뒤의 식별자 이름만 읽는다. 안쪽 항목에서도 허용된 조각만 꺼낸다 (parsed_cmd 첫 명령이나
// argv -> 프로그램 이름, 바뀐 파일 경로 -> basename, MCP 서버/도구 이름, 검색어나 URL host, 이미지 경로 basename).
// 출력(aggregated_output, stdout, stderr, diff, result)은 읽지 않는다.
import { isObj, itemId } from '../../core/session-items.mjs';
import { mcpToolName } from '../../core/tool-summary.mjs';
import { outputText } from './records.mjs';
import { firstLine } from '../../session-util.mjs';

const SCAN_MAX = 64 * 1024; // 스크립트 앞부분만 본다
const MAX_PATHS = 1000;
const UUID_UNDERSCORE_RE = /[0-9A-Fa-f]{8}_[0-9A-Fa-f]{4}_[0-9A-Fa-f]{4}_[0-9A-Fa-f]{4}_[0-9A-Fa-f]{12}/g;

/**
 * Script tool names that never decide the outer summary: the plan board call (D10c, not shown) and plumbing (polling a
 * running command or cell, tool lookup). The first other name wins; none -> a plain 'exec'.
 */
export const SCRIPT_SKIP = new Set([
  'update_plan', 'write_stdin', 'wait', 'tool_search', 'search_tool_bm25', 'list_mcp_resources',
  'list_mcp_resource_templates', 'get_goal',
]);

/** item_completed item types that become a visit while an exec is open. */
export const INNER_ITEM_TYPES = new Set(['CommandExecution', 'FileChange', 'McpToolCall', 'WebSearch', 'ImageView']);

// ---- a small JavaScript scanner: only enough to know what is code, string, template text, regex or comment

const SPACE = new Set([' ', '\t', '\n', '\r', '\v', '\f', ' ', '﻿', ' ', ' ']);
const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || (c > '\x7f' && !SPACE.has(c));
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);
// A '/' right after one of these words starts a regex literal; after any other word, a number, ')' or ']' it divides.
const REGEX_AFTER = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'new', 'instanceof', 'throw',
]);
const BROKEN = -1; // 줄바꿈이 문자열이나 정규식 안에 왔다: JavaScript 가 아니다 (스캐너가 상태를 잃었다)
const OUT = -2; // 닫히기 전에 글이 끝났다

function readWord(s, i) {
  let j = i;
  while (j < s.length && isIdentPart(s[j])) j++;
  return j;
}

function skipSpace(s, i) {
  let j = i;
  while (j < s.length && SPACE.has(s[j])) j++;
  return j;
}

// '...' / "..." from the opening quote -> the index after the closing one, BROKEN at a raw line break, OUT at the end
function skipString(s, i, q) {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j += s[j + 1] === '\r' && s[j + 2] === '\n' ? 2 : 1; // 이스케이프 (줄 잇기 포함)
    else if (c === q) return j + 1;
    else if (c === '\n' || c === '\r') return BROKEN;
  }
  return OUT;
}

// A regex literal from its opening '/' -> the index after its flags ('\' escapes, a '/' inside [...] does not close it)
function skipRegex(s, i) {
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\n' || c === '\r') return BROKEN;
    if (c === '\\') {
      if (s[j + 1] === '\n' || s[j + 1] === '\r') return BROKEN;
      j += 1;
    } else if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      return readWord(s, j + 1);
    }
  }
  return OUT;
}

// Template text from i (after the opening '`', or after the '}' that closes an expression) -> [next index, true when
// a '${' expression starts there], or null when the text ends first.
function templateText(s, i) {
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j += 1;
    else if (c === '`') return [j + 1, false];
    else if (c === '$' && s[j + 1] === '{') return [j + 2, true];
  }
  return null;
}

// After the word `tools`: '.' or '?.' and an identifier -> [start, end] of that name, else null.
function toolAfter(s, i) {
  let k = skipSpace(s, i);
  if (s[k] === '?' && s[k + 1] === '.') k += 2;
  else if (s[k] === '.') k += 1;
  else return null;
  k = skipSpace(s, k);
  return k < s.length && isIdentStart(s[k]) ? [k, readWord(s, k)] : null;
}

/**
 * The identifiers called as `tools.<name>` / `tools?.<name>` in a script, in order, read as code only: never inside
 * string literals, template text, regex literals or comments (the code inside a template's ${...} is code). At most
 * `limit` names. Bracket forms (tools["x"]) are strings and are not read. A script whose scan ends inside an unclosed
 * string, regex, template or comment, or meets a line break inside a string or regex, is not JavaScript as far as the
 * scanner can tell, so nothing it read is trusted: no names (a script cut at the 64 KB scan limit keeps what was read).
 */
export function scriptToolNames(script, limit = 64) {
  const names = [];
  if (typeof script !== 'string' || script === '') return names;
  const s = script.slice(0, SCAN_MAX);
  const n = s.length;
  const out = () => (script.length > SCAN_MAX ? names : []);
  const exprs = []; // 열린 템플릿 ${ } 마다 그 안의 중괄호 깊이 (그 안은 코드로 읽는다)
  let regexOk = true; // 여기의 '/' 는 정규식의 시작이다 (앞에 값이 없다)
  let member = false; // 앞 토큰이 '.' 이나 '?.' 이다: 다음 단어는 속성 (obj.tools.x 는 tools 객체가 아니다)
  const template = (from) => {
    const t = templateText(s, from);
    if (!t) return OUT;
    if (t[1]) exprs.push(0);
    regexOk = t[1];
    return t[0];
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (SPACE.has(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return out();
      i = end + 2;
      continue;
    }
    let j;
    const wasMember = member;
    member = false;
    if (c === '"' || c === "'") {
      j = skipString(s, i, c);
      regexOk = false;
    } else if (c === '`') {
      j = template(i + 1);
    } else if (c === '}' && exprs.length > 0 && exprs[exprs.length - 1] === 0) {
      exprs.pop(); // ${ ... } 이 닫혔다: 템플릿 글로 돌아간다
      j = template(i + 1);
    } else if (c === '/') {
      j = regexOk ? skipRegex(s, i) : i + 1;
      regexOk = !regexOk;
    } else if (isIdentStart(c)) {
      j = readWord(s, i);
      const word = s.slice(i, j);
      const name = word === 'tools' && !wasMember ? toolAfter(s, j) : null;
      if (name) {
        if (names.length < limit) names.push(s.slice(name[0], name[1]));
        j = name[1];
      }
      regexOk = !name && !wasMember && REGEX_AFTER.has(word);
    } else if (isDigit(c) || (c === '.' && isDigit(s[i + 1] ?? ''))) {
      j = i + 1;
      while (j < n && (isIdentPart(s[j]) || s[j] === '.')) j++;
      regexOk = false;
    } else if (c === '.' && s[i + 1] === '.' && s[i + 2] === '.') {
      j = i + 3;
      regexOk = true;
    } else if (c === '.' || (c === '?' && s[i + 1] === '.' && !isDigit(s[i + 2] ?? ''))) {
      j = i + (c === '.' ? 1 : 2);
      member = true;
      regexOk = false;
    } else if (c === ')' || c === ']') {
      j = i + 1;
      regexOk = false;
    } else {
      if (exprs.length > 0 && (c === '{' || c === '}')) exprs[exprs.length - 1] += c === '{' ? 1 : -1;
      j = i + 1;
      regexOk = true;
    }
    if (j === BROKEN) return [];
    if (j === OUT) return out();
    i = j;
  }
  return exprs.length > 0 ? out() : names;
}

/** The first script tool name that decides the outer summary (SCRIPT_SKIP names are passed over), or null. */
export function firstScriptTool(script) {
  for (const n of scriptToolNames(script)) if (!SCRIPT_SKIP.has(n)) return n;
  return null;
}

const SHELL_NAMES = new Set(['exec_command', 'shell', 'shell_command']);
const AGENT_NAMES = new Set([
  'spawn_agent', 'wait_agent', 'close_agent', 'send_input', 'send_message', 'followup_task', 'list_agents', 'interrupt_agent',
]);
const NAME_KINDS = new Map([['apply_patch', 'edit'], ['view_image', 'read'], ['web_search', 'web'], ['web_fetch', 'web']]);

/**
 * The outer exec tool_start fields { tool: 'exec', desc } from the script: the first tools.<name> picks the kind (room)
 * and is the summary (`description`): exec_command / shell -> shell (server room), apply_patch -> edit (dev),
 * view_image -> read (archive), an MCP name (mcp__<server>__<tool>) or web tool -> web (research), agent calls -> agent,
 * anything else -> other. No name -> a plain 'exec' (other).
 */
export function execStartOf(script) {
  const name = firstScriptTool(script);
  if (name === null) return { tool: 'exec', desc: { tool: 'exec', kind: 'other' } };
  let kind = 'other';
  let description = name;
  if (SHELL_NAMES.has(name)) kind = 'shell';
  else if (AGENT_NAMES.has(name)) kind = 'agent';
  else if (NAME_KINDS.has(name)) kind = NAME_KINDS.get(name);
  else if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const k = rest.indexOf('__');
    // 식별자에는 '-' 가 없으므로 커넥터 uuid 가 '_' 로 이어져 올 수 있다: uuid 모양으로 되돌려 같은 가리기 규칙을 쓴다
    const server = (k > 0 ? rest.slice(0, k) : rest).replace(UUID_UNDERSCORE_RE, (m) => m.replace(/_/g, '-'));
    description = mcpToolName(server, k > 0 ? rest.slice(k + 2) : '');
    kind = 'web';
  }
  return { tool: 'exec', desc: { tool: 'exec', kind, description } };
}

/** The exec call's output -> { status, errorLine? }. Only fixed heads of the first line are read (the script prints). */
export function execEndOf(output) {
  const text = outputText(output);
  if (text === null) return { status: 'ok' };
  const low = firstLine(text.slice(0, 4096)).toLowerCase();
  if (low.startsWith('script failed')) return { status: 'failed', errorLine: 'Script failed' };
  if (low.startsWith('script error')) return { status: 'failed', errorLine: 'Script error' };
  if (low.startsWith('aborted by user')) return { status: 'interrupted', errorLine: 'Aborted by user' };
  if (low.startsWith('rejected by user') || low.startsWith('exec rejected')) return { status: 'denied', errorLine: 'Rejected by user' };
  if (low.startsWith('approval required by policy')) return { status: 'denied', errorLine: 'Approval required by policy' };
  if (low.startsWith('sandbox denied')) return { status: 'denied', errorLine: 'Sandbox denied' };
  return { status: 'ok' };
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

function statusEnd(status, failedLine, deniedLine) {
  if (status === 'failed') return { status: 'failed', errorLine: failedLine };
  if (status === 'declined') return { status: 'denied', errorLine: deniedLine };
  return { status: 'ok' };
}

// CommandExecution: argv is always [zsh|bash, -lc, <script>] (research), so the program comes from parsed_cmd[0].cmd
// (one simple command) or from the script (tool-summary unwraps `zsh -lc "<script>"` to programOf(script)).
function commandVisit(it) {
  const p0 = Array.isArray(it.parsed_cmd) && isObj(it.parsed_cmd[0]) ? str(it.parsed_cmd[0].cmd) : undefined;
  const desc = { tool: 'exec_command', kind: 'shell' };
  if (p0 !== undefined) desc.command = p0;
  else if (Array.isArray(it.command)) desc.argv = it.command;
  else if (typeof it.command === 'string') desc.command = it.command;
  const code = Number.isInteger(it.exit_code) ? it.exit_code : null;
  let end;
  if (it.status === 'declined') end = { status: 'denied', errorLine: 'Command declined' };
  else if (code !== null && code !== 0) end = { status: 'failed', errorLine: `Exit code ${code}` };
  else if (it.status === 'failed') end = { status: 'failed', errorLine: 'Command failed' };
  else end = { status: 'ok' };
  return { desc, end };
}

const VISITS = {
  CommandExecution: commandVisit,
  FileChange: (it) => ({
    desc: { tool: 'apply_patch', kind: 'edit', paths: isObj(it.changes) ? Object.keys(it.changes).slice(0, MAX_PATHS) : [] },
    end: statusEnd(it.status, 'Patch failed', 'Patch declined'),
  }),
  McpToolCall: (it) => ({
    desc: { tool: 'mcp', kind: 'other', mcpServer: str(it.server), mcpTool: str(it.tool) },
    end: statusEnd(it.status, 'MCP tool error', 'MCP call declined'),
  }),
  WebSearch: (it) => {
    const a = isObj(it.action) ? it.action : {};
    const url = str(a.url);
    return { desc: { tool: 'web_search', kind: 'web', url, query: url ? undefined : str(it.query) ?? str(a.query) }, end: statusEnd(it.status, 'Search failed', 'Search declined') };
  },
  ImageView: (it) => ({ desc: { tool: 'view_image', kind: 'read', path: str(it.path) }, end: { status: 'ok' } }),
};

/**
 * One inner item_completed item -> a visit { id, start: { tool, desc }, end: { status, errorLine? } }, or null for an
 * item type that is not a visit (or without an id). The id is the item's own id (opaque).
 */
export function innerVisitOf(it) {
  if (!isObj(it) || !Object.hasOwn(VISITS, it.type)) return null;
  const id = itemId(it.id);
  if (id === null) return null;
  const { desc, end } = VISITS[it.type](it);
  for (const k of Object.keys(desc)) if (desc[k] === undefined) delete desc[k];
  return { id, start: { tool: desc.tool, desc }, end };
}
