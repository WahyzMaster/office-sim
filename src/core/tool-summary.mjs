// Normalized tool descriptor (built by an adapter) -> tool_start fields { tool, summary, room?, background? } (pure).
// ADAPTERS 3.2, 6.2, 7; CONTRACT 3.1, 5. Claude 의 summarize.mjs 와 같은 개인정보 규칙을 쓴다.
// 어댑터가 미리 줄여 둔 설명자만 받는다(원래 도구 입력은 받지 않는다). 명령 원문, 인자, 파일 내용, 전체 경로,
// 전체 URL, patch 본문, 결과 본문은 절대 돌려주지 않는다. 출력 객체에는 위 네 필드만 있다(그대로 이벤트에 펼쳐도 된다).
import { cleanText, truncate, hostOf, looksLikeUuid, ZERO_UUID, baseName, toolLabel, shellRoom } from '../summarize.mjs';
import { programOf, lex } from '../summarize-shell.mjs';

export const TOOL_KINDS = Object.freeze(['read', 'edit', 'shell', 'web', 'search', 'plan', 'ask', 'agent', 'other']);
const KINDS = new Set(TOOL_KINDS);

// 종류 -> 방 힌트 (shell 은 프로그램 이름 규칙, MCP 는 힌트 없이 화면 규칙)
const KIND_ROOMS = new Map([
  ['read', 'archive'], ['search', 'archive'], ['edit', 'dev'], ['web', 'research'],
  ['ask', 'desk'], ['plan', 'meeting'], ['agent', 'here'], ['other', 'here'],
]);

const SUMMARY_MAX = 80; // 조각은 각각 40/60 으로 잘리고, 합친 요약도 이 안에 둔다
const MAX_FILES = 1000;

// ---------------------------------------------------------------------------------------------
// MCP name: mcp__<server>__<tool>

// Claude Code 와 같은 이름 정규화: [A-Za-z0-9_-] 밖의 글자는 '_'
const MCP_BAD_CHAR_RE = /[^A-Za-z0-9_-]/g;
// 세그먼트 안에 박힌 uuid 모양 토큰 ('conn_<uuid>'), 24자 이상 16진수
const UUID_TOKEN_RE = /(?<![0-9A-Za-z-])[0-9A-Za-z]{6,10}(?:-[0-9A-Za-z]{3,5}){3}-[0-9A-Za-z]{10,14}(?![0-9A-Za-z-])/g;
const HEX_TOKEN_RE = /(?<![0-9A-Za-z])[0-9a-f]{24,}(?![0-9A-Za-z])/gi;

function mcpSegment(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().slice(0, 128).replace(MCP_BAD_CHAR_RE, '_');
  if (!s) return '';
  if (looksLikeUuid(s)) return ZERO_UUID;
  return s.replace(UUID_TOKEN_RE, (m) => (looksLikeUuid(m) ? ZERO_UUID : m)).replace(HEX_TOKEN_RE, ZERO_UUID);
}

/**
 * Public MCP tool name `mcp__<server>__<tool>` (CONTRACT 5): both segments normalized to [A-Za-z0-9_-] like Claude Code
 * does, a uuid-looking server (or a uuid token inside it) becomes ZERO_UUID. Missing server -> 'mcp'. '' when both missing.
 */
export function mcpToolName(server, tool) {
  const srv = mcpSegment(server);
  const name = mcpSegment(tool);
  if (!srv && !name) return '';
  return name ? `mcp__${srv || 'mcp'}__${name}` : `mcp__${srv}`;
}

/** `mcp__<server>__<tool>` already in the raw name -> the same normalization. */
function mcpFromRawName(name) {
  const rest = name.slice(5);
  const idx = rest.indexOf('__');
  return idx < 0 ? mcpToolName(rest, '') : mcpToolName(rest.slice(0, idx), rest.slice(idx + 2));
}

// ---------------------------------------------------------------------------------------------
// shell: program name (+ allowed subcommand), never arguments

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const C_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const MAX_UNWRAP = 2;
const MAX_ARGV = 256;
const MAX_SCAN = 8192; // programOf 도 앞 8 KB 만 본다
const PROGRAM_RE = /^[A-Za-z_][A-Za-z0-9._+-]{0,63}$/; // programOf 의 프로그램 이름 규칙
// exec 할 수 없는 셸 키워드: argv[0] 이면 프로그램이 아니다 (programOf 는 건너뛰고 인자를 프로그램으로 올린다)
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'for', 'case', 'select', 'function', 'fi', 'done', 'esac', 'in',
]);

function argText(a) {
  if (typeof a === 'string') return a;
  if (typeof a === 'number' && Number.isFinite(a)) return String(a);
  return '';
}

/** Tokens of one simple command -> the script string of `bash|sh|zsh [-opts] -c <script>`, else null. */
function innerScript(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGN_RE.test(tokens[i]) || tokens[i] === 'exec' || tokens[i] === 'command')) i++;
  if (i >= tokens.length || !SHELLS.has(baseName(tokens[i]))) return null;
  let sawC = false;
  for (i++; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-o' || t === '+o' || t === '-O' || t === '+O') i++; // 값을 받는 옵션 (-o pipefail)
    else if (C_FLAG_RE.test(t)) sawC = true;
    else if (!t.startsWith('-') && !t.startsWith('+')) break;
  }
  return sawC && i < tokens.length ? tokens[i] : null;
}

/**
 * Does a bare option ('-n', '--project', no '=') sit between the program and its subcommand? Then the "subcommand" may be
 * that option's value ('kubectl -n prod-ns get' -> 'prod-ns'). Looks at the first segment holding both; not found -> true.
 */
function optionBeforeSub(cmd, { program, sub }) {
  for (const tokens of lex(cmd.slice(0, MAX_SCAN))) {
    const p = tokens.findIndex((t) => baseName(t.replace(/^[({]+/, '')) === program);
    const k = p < 0 ? -1 : tokens.indexOf(sub, p + 1);
    if (k < 0) continue;
    return tokens.slice(p + 1, k).some((t) => t.startsWith('-') && !t.includes('='));
  }
  return true;
}

/**
 * programOf (Claude Bash rule) plus one core-only rule: a subcommand after a bare option is dropped, because it may be the
 * option's value (a project, profile, namespace or host). Fail closed: 'git --no-pager log' shows only 'git'.
 */
function programOfSafe(cmd) {
  const parsed = programOf(cmd);
  if (!parsed || !parsed.sub || !optionBeforeSub(cmd, parsed)) return parsed;
  return { program: parsed.program, sub: '' };
}

function fromString(cmd, depth) {
  const parsed = programOfSafe(cmd);
  if (!parsed || depth >= MAX_UNWRAP || !SHELLS.has(parsed.program)) return parsed;
  // 'cd x && bash -lc "grep y"' 처럼 셸이 실제 프로그램일 때만 그 셸의 -c 문자열을 다시 본다
  for (const tokens of lex(cmd.slice(0, MAX_SCAN))) {
    const inner = innerScript(tokens);
    if (inner !== null) return fromString(inner, depth + 1) ?? parsed;
  }
  return parsed;
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** argv[0] can be exec'd as a program: a non-empty string, no whitespace, a program-like basename, not a shell keyword. */
function programToken(first) {
  if (first === '' || /\s/.test(first)) return false;
  const base = baseName(first.replace(/^[({]+/, ''));
  return PROGRAM_RE.test(base) && !SHELL_KEYWORDS.has(base);
}

function fromArgv(argv) {
  const tokens = argv.slice(0, MAX_ARGV).map(argText);
  const first = tokens[0].trim();
  // 원소 하나에 명령 줄 전체가 들어 있으면 명령 문자열로 읽는다 (['git push https://...'])
  if (tokens.length === 1 && /\s/.test(first)) return fromString(first, 0);
  // argv[0] 이 프로그램이 아니면 (빈 값, 문자열 아님, VAR=val, 셸 키워드, 공백) 프로그램 없음: 인자가 그 자리로 오르지 않게
  if (!programToken(first)) return null;
  const inner = innerScript(tokens);
  if (inner !== null) {
    const r = fromString(inner, 1);
    if (r) return r;
  }
  // 따옴표로 감싸 이어 붙이면 lex 가 토큰을 그대로 되살린다: 래퍼, 경로 basename, 하위 명령 규칙을 그대로 쓴다
  let joined = '';
  for (const t of tokens) {
    if (joined.length > MAX_SCAN) break;
    joined += (joined ? ' ' : '') + shellQuote(t);
  }
  return programOfSafe(joined);
}

/**
 * Shell descriptor -> programOf result `{ program, sub } | null`. `argv` (array) wins over `command` (string, or an
 * array treated as argv; a one-element array with whitespace is a command string). `bash|sh|zsh [-l] -c "<script>"` is
 * unwrapped to programOf(script) (at most twice). Stricter than programOf: no program when argv[0] is not one, and no
 * subcommand after a bare option (optionBeforeSub).
 */
export function shellProgram(desc) {
  if (desc === null || typeof desc !== 'object') return null;
  try {
    if (Array.isArray(desc.argv) && desc.argv.length) return fromArgv(desc.argv);
    if (Array.isArray(desc.command) && desc.command.length) return fromArgv(desc.command);
    if (typeof desc.command === 'string') return fromString(desc.command, 0);
  } catch {
    // 실패하면 프로그램 이름 없이 (도구 이름으로) 보여준다
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// patch: file names from headers only, the body is never read

const MAX_PATCH = 256 * 1024; // 앞부분만 본다 (거대한 patch 도 빠르게, 넘친 부분은 버린다)
const APPLY_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;
const APPLY_MOVE_RE = /^\*\*\* Move to: (.+)$/;
const APPLY_FORMAT_RE = /^\*\*\* (?:Begin Patch|(?:Update|Add|Delete) File: )/m;
const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function unquote(name) {
  const s = name.trim();
  return s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** `+++ b/x\t<timestamp>` / `--- a/x` path -> x ('' for /dev/null). */
function diffSidePath(rest) {
  const p = unquote(rest.replace(/\t.*$/, ''));
  if (p === '/dev/null') return '';
  return p.replace(/^[ab]\//, '');
}

/** `diff --git a/x b/x` -> x. */
function gitHeaderPath(rest) {
  const s = rest.trim();
  const k = s.lastIndexOf(s.endsWith('"') ? ' "b/' : ' b/');
  if (k < 0) return '';
  return unquote(s.slice(k + 1)).replace(/^b\//, '');
}

/** apply_patch 형식: '*** ' 헤더만. 본문 줄은 늘 ' ', '+', '-', '@@' 로 시작하므로 헤더로 읽힐 수 없다. */
function applyPatchNames(lines, add) {
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const m = APPLY_FILE_RE.exec(line) || APPLY_MOVE_RE.exec(line);
    if (m) add(m[1]);
  }
}

/** unified diff: 'diff --git' 와 '--- ' / '+++ ' 짝. '@@ -a,b +c,d @@' 의 줄 수만큼 본문을 건너뛴다 ('+++ x' 본문 줄 방지). */
function unifiedNames(lines, add) {
  let oldLeft = 0;
  let newLeft = 0;
  let prevOld = null; // 바로 앞 줄이 '--- ' 헤더였으면 그 경로
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '-') oldLeft--;
      else if (c === '+') newLeft--;
      else if (c === '\\') continue;
      else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      prevOld = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      add(gitHeaderPath(line.slice(11)));
      prevOld = null;
    } else if (line.startsWith('--- ')) {
      prevOld = diffSidePath(line.slice(4));
      continue;
    } else if (line.startsWith('+++ ') && prevOld !== null) {
      add(diffSidePath(line.slice(4)) || prevOld);
    }
    prevOld = null;
  }
}

/**
 * File basenames named by a patch's headers (`*** Update|Add|Delete File: x`, `*** Move to: x`, `diff --git a/x b/x`,
 * `--- a/x` + `+++ b/x`), deduped, each through cleanText (<= 60). Nothing else of the patch is read.
 */
export function patchFiles(patch) {
  const names = [];
  if (typeof patch !== 'string' || patch === '') return names;
  try {
    const text = patch.slice(0, MAX_PATCH);
    const add = (p) => {
      if (names.length >= MAX_FILES) return;
      const b = cleanText(baseName(p), 60);
      if (b && !names.includes(b)) names.push(b);
    };
    const lines = text.split('\n');
    if (APPLY_FORMAT_RE.test(text)) applyPatchNames(lines, add);
    else unifiedNames(lines, add);
  } catch {
    // 헤더를 못 읽으면 파일 이름 없이
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// summary

function isTruthyFlag(v) {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

function fileNames(desc) {
  const names = [];
  const add = (p) => {
    if (names.length >= MAX_FILES) return;
    const b = cleanText(baseName(p), 60);
    if (b && !names.includes(b)) names.push(b);
  };
  if (typeof desc.path === 'string') add(desc.path);
  if (Array.isArray(desc.paths)) for (const p of desc.paths.slice(0, MAX_FILES)) add(p);
  if (names.length === 0 && typeof desc.patch === 'string') return patchFiles(desc.patch);
  return names;
}

function fileList(names) {
  if (names.length === 0) return '';
  return names.length > 1 ? `${names[0]} (+${names.length - 1})` : names[0];
}

function shellLabel(parsed) {
  if (!parsed) return '';
  const prog = cleanText(parsed.program, 40);
  const sub = cleanText(parsed.sub, 30);
  if (!prog) return '';
  return sub ? `${prog} ${sub}` : prog;
}

function summaryOf(kind, desc, tool, parsed, isMcp) {
  // MCP 는 불투명한 id (커넥터 계정 uuid 일 수 있다) 보다 도구 이름을 보여준다 (summarize.mjs mcpSummary 와 같다)
  const text = (v, max) => {
    const s = cleanText(v, max);
    return isMcp && looksLikeUuid(s) ? '' : s;
  };
  const description = text(desc.description, 60);
  const query = text(desc.query, 60);
  const host = typeof desc.url === 'string' ? cleanText(hostOf(desc.url), 60) : '';
  const files = fileNames(desc);
  const fileText = fileList(files);
  let primary = '';
  switch (kind) {
    case 'shell':
      primary = description || shellLabel(parsed);
      break;
    case 'read':
    case 'edit':
      primary = fileText;
      break;
    case 'search': {
      // Claude Grep 과 같은 모양: 검색어(<= 40) · 경로 basename
      const q = text(desc.query, 40);
      primary = q && files.length ? `${q} · ${files[0]}` : query || fileText;
      break;
    }
    case 'web':
      primary = host || query;
      break;
    default:
      primary = description;
  }
  return primary || description || fileText || host || query || toolLabel(tool);
}

/**
 * @param {{ tool: string, kind: string, path?: string, paths?: string[], command?: string, argv?: string[], url?: string,
 *   query?: string, mcpServer?: string, mcpTool?: string, patch?: string, description?: string, background?: boolean }} desc
 * @returns {{ tool: string, summary: string, room?: string, background?: true }}
 */
export function toolSummary(desc) {
  const d = desc !== null && typeof desc === 'object' && !Array.isArray(desc) ? desc : {};
  let tool = 'tool';
  try {
    const kind = KINDS.has(d.kind) ? d.kind : 'other';
    let mcp = '';
    if (typeof d.mcpServer === 'string' || typeof d.mcpTool === 'string') mcp = mcpToolName(d.mcpServer, d.mcpTool);
    if (!mcp && typeof d.tool === 'string' && d.tool.startsWith('mcp__')) mcp = mcpFromRawName(d.tool);
    tool = mcp || cleanText(d.tool, 64) || 'tool';
    const parsed = kind === 'shell' ? shellProgram(d) : null;
    const out = { tool, summary: truncate(summaryOf(kind, d, tool, parsed, Boolean(mcp)), SUMMARY_MAX) || toolLabel(tool) };
    // MCP 는 room 힌트를 붙이지 않는다: 화면의 지금 규칙 (codegraph -> 자료실, github -> 서버실, 그 밖 -> 정보검색실) 이
    // tool 이름으로 고른다 (ADAPTERS 6.2, office.js 는 room 힌트가 있으면 규칙보다 먼저 쓴다)
    if (!mcp) out.room = kind === 'shell' ? shellRoom(parsed) : KIND_ROOMS.get(kind);
    if (isTruthyFlag(d.background)) out.background = true;
    return out;
  } catch {
    return { tool, summary: toolLabel(tool) };
  }
}
