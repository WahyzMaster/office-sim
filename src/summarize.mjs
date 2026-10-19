// tool_use -> { summary, room?, background?, ignore? } (pure). CONTRACT 3.1 + 5.
// 요약만 만든다: 명령어 원문, 파일 내용, 전체 경로, 전체 URL 은 절대 내보내지 않는다.
import { programOf } from './summarize-shell.mjs';

const ELLIPSIS = '\u2026';

// C0, DEL, C1, zero-width space, LRM/RLM, bidi embedding/override, invisible operators, bidi isolates
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g; // terminal colour/cursor sequences (CSI)

/** Code-point safe truncation. Collapses whitespace, strips control chars, appends an ellipsis (U+2026) within the limit. */
export function truncate(text, maxCodePoints) {
  let s;
  if (typeof text === 'string') s = text;
  else if (typeof text === 'number' || typeof text === 'boolean' || typeof text === 'bigint') s = String(text);
  else return '';
  s = s.replace(ANSI_RE, '').replace(/\s+/g, ' ').replace(CONTROL_RE, '').replace(LONE_SURROGATE_RE, '').replace(/ {2,}/g, ' ').trim();
  if (typeof maxCodePoints !== 'number' || Number.isNaN(maxCodePoints) || maxCodePoints === Infinity) return s;
  const max = Math.max(0, Math.floor(maxCodePoints));
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  if (max === 0) return '';
  return cps.slice(0, max - 1).join('').trimEnd() + ELLIPSIS;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// scheme 없는 입력은 호스트처럼 시작할 때만 http:// 를 붙인다 ('/Users/x' 가 호스트 'users' 가 되지 않도록)
const HOSTLIKE_RE =
  /^(?:\[[0-9a-f:.]+\]|[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*)(?::\d{1,5})?(?:[/?#]|$)/iu;

/** Host only (hostname[:port], never userinfo, path, query or fragment); '' on failure. */
export function hostOf(url) {
  if (typeof url !== 'string') return '';
  let s = url.trim();
  if (!s) return '';
  if (s.startsWith('//')) s = 'http:' + s;
  else if (!SCHEME_RE.test(s)) {
    // 정규식은 앞부분에만 (호스트는 앞에 있다); 실제 파싱은 WHATWG URL 이 전체 문자열로 한다
    if (!HOSTLIKE_RE.test(s.slice(0, 512))) return '';
    s = 'http://' + s;
  }
  try {
    return new URL(s).host || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

// 앞 글자가 ASCII 단어 문자면 URL 이 아니다 ('_https://' 나 '링크https://' 는 URL 로 본다)
const URL_IN_TEXT_RE = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_TAIL_RE = /[.,;:!?)\]}]+$/; // 문장 부호는 URL 이 아니라 문장 것이다

// scheme 없는 URL 의 호스트: 점이 있는 이름(마지막 라벨은 2글자 이상), localhost, IPv4, [IPv6]. 단일 라벨('src/x')은 아니다.
const DOTTED_HOST = String.raw`(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,}`;
const BARE_HOST = String.raw`(?:${DOTTED_HOST}|localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f.]*:[0-9a-f:.]*\])(?::\d{1,5})?`;
// host[:port] 뒤에 / ? # 가 오면 URL ('//' 접두 허용). 경로 안(앞이 '/')이나 단어 중간에서는 시작하지 않는다.
// userinfo 가 붙은 형태('me@corp.example/x', 브랜치 이름 등)는 메일 주소로 본다: 도메인도 남기지 않는다.
const BARE_URL_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}._%+@/\\-])(?:\/\/)?(?:([\p{L}\p{N}._%+-]+)@)?(${BARE_HOST})[/?#][^\s"'<>\x60]*`, 'giu');
// file:// URL 은 경로다: 접두만 떼고 경로 규칙(공백 이어 붙이기 포함)이 basename 으로 줄인다
const FILE_URL_RE = /(?<![a-z0-9+.-])file:\/\/(?:localhost)?(?=\/)/gi;
// scp 형식 'git@github.com:org/repo.git' -> 호스트
const SCP_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._-]+@(${DOTTED_HOST}|localhost|\d{1,3}(?:\.\d{1,3}){3}):(?!\/\/)[^\s"'<>\x60]+`, 'giu');

// 절대 경로 (/, ~/, ./, ../, C:\, C:/). 앞 글자 목록을 고정하지 않는다: ASCII 단어/경로 문자에 붙은 것만 경로가 아니다.
// 경로 글자는 공백과 이 STOP 문자에서 끝난다 ('**/a/b**', '|/a/b|', '<b>/a</b>' 의 꾸밈 문자는 경로가 아니다).
const STOP = String.raw`\s"'\x60<>)\]},;*|\x00-\x1F\x7F`;
const PCH = String.raw`(?:\\ |\([^\s()]*\)|[^${STOP}])`; // 경로 글자: '\ ' (셸 이스케이프 공백), 짝 맞는 (...)
// 'Application Support/x' 처럼 공백 뒤 단어가 곧바로 구분자로 이어지면 같은 경로로 이어 붙인다 (줄바꿈은 잇지 않는다)
const CONT = String.raw`(?:[ \t]+(?:\([^\s()\\/]*\)|[^${STOP}\\/])+[\\/]${PCH}*)*`;
// 경로 앞머리: ~, ., .., 환경 변수 ('$HOME/x', '${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh' 도 전체 경로다)
const LEAD = String.raw`(?:~|\.{1,2}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)`;
const ABS_PATH_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9/\\.~+-])(` +
    // 앞이 공백, 문장 부호, 기호, 줄 처음, 앞머리이면 한 세그먼트로 충분하다
    // ('//server/share/x', '///Users/x' 처럼 앞 슬래시가 둘, 셋이어도 경로다. 'a // b', 'foo//bar' 는 아니다)
    String.raw`${LEAD}?\/{1,3}(?![\/\s])(?:(?<=(?:^|[\s\p{P}\p{S}\p{C}])${LEAD}?\/{1,3})${PCH}+` +
    // 한글 등 글자에 붙은 경로는 ASCII 로 시작하는 세그먼트 뒤에 구분자가 더 있을 때만 ('설정/.claude/', '폴더/src/x' 는
    // 경로, '예/아니오', '읽기/쓰기/실행' 은 그대로)
    String.raw`|[A-Za-z0-9._~-][^${STOP}\/]*\/${PCH}*)${CONT}` +
    String.raw`|(?<![A-Za-z0-9])[A-Za-z]:[\\/]${PCH}+${CONT}` +
    String.raw`|\\\\[A-Za-z0-9][^${STOP}\\/]*\\${PCH}+${CONT})`, // UNC '\\server\share\x'
  'gu');

// 서버 세그먼트가 계정별 커넥터 uuid 인지 (한 글자 오타도 잡도록 느슨하게)
const UUIDISH_RE = /^[0-9a-z]{6,10}-[0-9a-z]{3,5}-[0-9a-z]{3,5}-[0-9a-z]{3,5}-[0-9a-z]{10,14}$/i;
/** Loose connector-uuid test for an mcp server segment (strict uuid, one-char typos, 24+ hex). */
export function looksLikeUuid(s) {
  return typeof s === 'string' && (UUIDISH_RE.test(s) || /^[0-9a-f]{24,}$/i.test(s));
}
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const MCP_SERVER_RE = /mcp__([0-9A-Za-z-]+)/g;

/** Path match -> basename. A path cut by a glued glob or markup char ('/a/CLIENT/*.pdf') keeps no directory name. */
function pathTail(p, offset, str) {
  if (/[\\/]$/.test(p) && /[*<>|]/.test(str[offset + p.length] ?? '')) return str[offset - 1] === '*' ? '/' : '';
  return baseName(p);
}

/** URL match -> host + trailing sentence punctuation ('is it summarize.mjs?' keeps its '?'). */
function urlToHost(m, host) {
  const tail = URL_TAIL_RE.exec(m)?.[0] ?? '';
  const h = host ?? hostOf(m.slice(0, m.length - tail.length));
  return (h || '(url)') + tail;
}

/**
 * Free text privacy scrub (section 5): connector uuid in `mcp__<uuid>` -> zero uuid, URL (with or without a
 * scheme, scp form) -> host, email (also 'me@corp.example/x') -> '(email)', file:// URL and absolute path (spaces
 * included, UNC, '//x') -> basename.
 */
function scrub(s) {
  return s
    .replace(MCP_SERVER_RE, (m, server) => (looksLikeUuid(server) ? `mcp__${ZERO_UUID}` : m))
    .replace(FILE_URL_RE, '')
    .replace(URL_IN_TEXT_RE, (m) => urlToHost(m))
    .replace(SCP_RE, (m, host) => urlToHost(m, host))
    .replace(BARE_URL_RE, (m, user, host) => (user ? '(email)' + (URL_TAIL_RE.exec(m)?.[0] ?? '') : urlToHost(m, host)))
    .replace(EMAIL_RE, '(email)')
    .replace(ABS_PATH_RE, (_m, p, offset, str) => pathTail(p, offset, str));
}

const SCRUB_LIMIT = 1024; // 정규식 비용을 묶어 둔다 (입력 필드는 수십 KB 까지 온다)

/** Short display text from an untrusted value: strings only (anything else counts as missing). */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  let s = value;
  if (s.length > SCRUB_LIMIT) {
    // 잘린 마지막 토큰(반쯤 잘린 URL/메일/경로)은 scrub 을 피할 수 있으니 버린다
    s = s.slice(0, SCRUB_LIMIT);
    let k = s.length - 1;
    while (k >= 0 && !/\s/.test(s[k])) k--;
    s = k > 0 ? s.slice(0, k) : '';
  }
  // ANSI 색 코드('\u001b[0m')는 글자로 끝나서 뒤의 경로/URL 을 단어에 붙은 것처럼 가린다: scrub 전에 제어 문자 하나로
  // 바꿔 경계로 남기고(경로/URL 규칙은 제어 문자를 경계로 본다), 그 제어 문자는 truncate 가 지운다.
  s = s.replace(ANSI_RE, '\u0000');
  return truncate(scrub(s), max);
}

/** Event free text (say, thinking, prompt, titles, plan items, errors): section 5 scrub, then truncate. */
export function cleanText(value, max) {
  return clean(value, max);
}

function baseName(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isTruthyFlag(v) {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

function intOf(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d{1,12}\s*$/.test(v)) return Number(v);
  return null;
}

/** Split `mcp__<server>__<tool>`; tool may itself contain `__`. null for non-mcp names. */
function splitMcp(name) {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf('__');
  if (idx < 0) return { server: rest, suffix: '' };
  return { server: rest.slice(0, idx), suffix: rest.slice(idx + 2) };
}

/** Display label for a tool name; never shows an mcp server segment. */
function toolLabel(name) {
  const mcp = splitMcp(name);
  if (mcp) {
    const label = clean(mcp.suffix.replace(/_/g, ' '), 40);
    if (label) return label;
    if (!mcp.server || looksLikeUuid(mcp.server)) return 'mcp tool';
    return clean(name, 40) || 'mcp tool';
  }
  return clean(name, 40) || 'tool';
}

// ---------------------------------------------------------------------------------------------
// ignore list (app plumbing)

const IGNORE = new Set([
  'ToolSearch',
  'ListAgents',
  'ListMcpResourcesTool',
  'mcp__visualize__read_me',
  'mcp__serena__initial_instructions',
  'mcp__firebase__firebase_get_environment',
  'mcp__plugin_firebase_firebase__firebase_get_environment',
  'mcp__computer-use__request_access',
  'mcp__computer-use__request_full_control',
  'mcp__computer-use__release_full_control',
  'mcp__computer-use__app_release',
  'mcp__claude-in-chrome__tabs_context_mcp',
  'mcp__claude-in-chrome__list_connected_browsers',
  'mcp__Claude_Browser__tabs_context',
  'mcp__Claude_Browser__preview_list',
]);

function isIgnored(name) {
  return name.startsWith('mcp__ccd_') || IGNORE.has(name);
}

// ---------------------------------------------------------------------------------------------
// rooms

const ARCHIVE_PROGRAMS = new Set([
  'grep', 'rg', 'ag', 'find', 'fd', 'ls', 'tree', 'cat', 'head', 'tail', 'less', 'wc', 'sed', 'awk', 'jq', 'file', 'stat', 'du',
]);
const RESEARCH_PROGRAMS = new Set(['curl', 'wget', 'http']);
const FIXED_ROOMS = new Map([
  ['TaskOutput', 'server'],
  ['TaskStop', 'server'],
  ['StructuredOutput', 'here'],
  ['SubagentHandback', 'here'],
  ['ScheduleWakeup', 'lounge'],
]);

function shellRoom(parsed) {
  const p = parsed ? parsed.program.toLowerCase() : '';
  if (ARCHIVE_PROGRAMS.has(p)) return 'archive';
  if (RESEARCH_PROGRAMS.has(p)) return 'research';
  return 'server';
}

// ---------------------------------------------------------------------------------------------
// per-tool summaries

function shellSummary(name, input, parsed) {
  const desc = clean(input.description, 60);
  if (desc) return desc;
  if (parsed) {
    const prog = clean(parsed.program, 40);
    const sub = clean(parsed.sub, 30);
    if (prog) return sub ? `${prog} ${sub}` : prog;
  }
  return toolLabel(name);
}

function fileSummary(name, input) {
  const base = clean(baseName(input.file_path ?? input.notebook_path), 60);
  if (!base) return toolLabel(name);
  if (name === 'Read') {
    const off = intOf(input.offset);
    const lim = intOf(input.limit);
    if (off !== null && lim !== null) return `${base} L${off}-${off + lim}`;
  }
  return base;
}

function grepSummary(input) {
  const pat = clean(input.pattern, 40);
  const base = clean(baseName(input.path), 40);
  if (pat && base) return `${pat} \u00B7 ${base}`;
  return pat || base || 'Grep';
}

function globSummary(input) {
  if (typeof input.pattern !== 'string') return 'Glob';
  let p = input.pattern.trim();
  // 절대/홈 경로 패턴은 앞쪽 디렉터리를 버리고 첫 glob 세그먼트부터 보여준다
  if (/^(?:~|\/|[A-Za-z]:[\\/])/.test(p)) {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    const k = segs.findIndex((seg) => /[*?[{]/.test(seg));
    p = k >= 0 ? segs.slice(k).join('/') : segs[segs.length - 1] || '';
  }
  return clean(p, 60) || 'Glob';
}

const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan']);

function agentSummary(input) {
  const desc = clean(input.description, 60);
  const type = typeof input.subagent_type === 'string' && BUILTIN_AGENTS.has(input.subagent_type) ? input.subagent_type : '';
  if (desc) return type ? `${desc} \u00B7 ${type}` : desc;
  return type || 'Agent';
}

function workflowSummary(input) {
  return clean(input.description, 60) || clean(baseName(input.scriptPath), 60) || 'inline workflow';
}

function skillSummary(input) {
  const s = typeof input.skill === 'string' ? input.skill.slice(input.skill.lastIndexOf('/') + 1) : '';
  return clean(s, 40) || 'Skill';
}

function sendMessageSummary(input) {
  const who = clean(input.to, 40) || clean(input.recipient, 40);
  return who ? `to ${who}` : 'SendMessage';
}

function taskUpdateSummary(input) {
  const rawId = input.taskId ?? input.id ?? input.task_id;
  const idText = typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : rawId;
  const id = clean(typeof idText === 'string' ? idText.replace(/^#/, '') : idText, 16);
  const status = clean(input.status, 20);
  if (id && status) return `#${id} -> ${status}`;
  if (id) return `#${id}`;
  if (status) return `task -> ${status}`;
  return 'TaskUpdate';
}

function askSummary(input) {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const headers = qs.map((q) => (isPlainObject(q) ? clean(q.header, 20) : '')).filter(Boolean);
  return clean(headers.join(' \u00B7 '), 60) || 'AskUserQuestion';
}

const MCP_KEYS = ['query', 'libraryName', 'libraryId', 'collection_path', 'collectionId', 'element', 'action_summary', 'action', 'title'];
const NAVIGATE_RE = /(?:^|_)navigate(?:_page)?$/;

function mcpSummary(name, mcp, input) {
  const suffix = mcp ? mcp.suffix : name;
  if (NAVIGATE_RE.test(suffix) || suffix === 'preview_start') {
    const host = clean(hostOf(input.url), 60);
    if (host) return host;
  }
  for (const key of MCP_KEYS) {
    let v = input[key];
    // collection 경로에는 문서 id 가 섞일 수 있으니 마지막 세그먼트(컬렉션 이름)만
    if (key === 'collection_path' && typeof v === 'string') v = baseName(v);
    const s = clean(v, 60);
    if (s && !looksLikeUuid(s)) return s; // 불투명한 id (커넥터 계정 uuid 일 수 있다) 보다는 도구 이름
  }
  return toolLabel(name);
}

function summaryFor(name, input, parsed) {
  switch (name) {
    case 'Bash':
    case 'Monitor':
      return shellSummary(name, input, parsed);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return fileSummary(name, input);
    case 'Grep':
      return grepSummary(input);
    case 'Glob':
      return globSummary(input);
    case 'WebFetch':
      return clean(hostOf(input.url), 60) || 'WebFetch';
    case 'WebSearch':
      return clean(input.query, 60) || 'WebSearch';
    case 'Agent':
    case 'Task':
      return agentSummary(input);
    case 'Workflow':
      return workflowSummary(input);
    case 'Skill':
      return skillSummary(input);
    case 'SendMessage':
      return sendMessageSummary(input);
    case 'TaskCreate':
      return clean(input.subject, 60) || 'TaskCreate';
    case 'TaskUpdate':
      return taskUpdateSummary(input);
    case 'AskUserQuestion':
      return askSummary(input);
    case 'ExitPlanMode':
      return 'plan ready';
    default: {
      const mcp = splitMcp(name);
      if (mcp || NAVIGATE_RE.test(name)) return mcpSummary(name, mcp, input);
      return toolLabel(name);
    }
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {string} tool raw tool name
 * @param {object} input message.content[].input (never wireToolInputs)
 * @returns {{ summary: string, room?: string, background?: boolean, ignore?: boolean }}
 */
export function summarize(tool, input) {
  const name = typeof tool === 'string' ? tool : '';
  try {
    if (isIgnored(name)) return { summary: toolLabel(name), ignore: true };
    const inp = isPlainObject(input) ? input : {};
    const isShell = name === 'Bash' || name === 'Monitor';
    const parsed = isShell ? programOf(inp.command) : null;
    const summary = Object.prototype.hasOwnProperty.call(inp, '__unparsedToolInput')
      ? `${toolLabel(name)} (unparsed input)`
      : summaryFor(name, inp, parsed);
    const out = { summary: summary || toolLabel(name) };
    const room = isShell ? shellRoom(parsed) : FIXED_ROOMS.get(name);
    if (room) out.room = room;
    if (isTruthyFlag(inp.run_in_background)) out.background = true;
    return out;
  } catch {
    return { summary: toolLabel(name) };
  }
}
