// Antigravity transcript step -> pieces of SessionCore items (pure, no state). ADAPTERS 5.3, 6.1, 7; 형식 근거는
// docs/research/antigravity-format.json (구조와 개수만 센 조사). 상태가 필요한 부분(위치로 짝짓는 결과 대기열, 줄의 바이트
// 위치, 작업 폴더 대안을 언제 쓸지)은 session.mjs 의 AntigravitySession 이, 도구 이름 표는 tools.mjs 가 한다.
//
// One line = one step: { step_index, type, source, status, created_at, content?, thinking?, tool_calls?, error?,
// exit_code?, input_tokens?, ..., truncated_fields? (transcript.jsonl only) }. No message id, turn id, tool-call id or
// cwd. step_index repeats and steps backwards around compaction, so it is never read (lines are keyed by position).
// type: USER_INPUT, PLANNER_RESPONSE, GENERIC (most results), typed results (RUN_COMMAND, VIEW_FILE, CODE_ACTION,
// GREP_SEARCH, LIST_DIRECTORY, MCP_TOOL, ASK_QUESTION, SEARCH_WEB, GENERATE_IMAGE, READ_URL_CONTENT, BROWSER_SUBAGENT ...),
// SYSTEM_MESSAGE, CONVERSATION_HISTORY, CHECKPOINT, ERROR_MESSAGE, and new types in later versions (tolerated).
// status: DONE | RUNNING | ERROR | INVALID.
//
// 개인정보 (CONTRACT 5, ADAPTERS 7): USER_INPUT 은 맨 바깥 <USER_REQUEST> 블록의 안쪽 글만 쓴다 (ADDITIONAL_METADATA,
// USER_SETTINGS_CHANGE, PLAN 블록은 환경 정보와 주입 문맥이라 버리고, 그 안에 적힌 <USER_REQUEST> 도 읽지 않는다). 결과 줄은 status, error 의 첫 줄, exit_code 만 읽고
// content (도구 출력 본문)는 읽지 않는다. SYSTEM_MESSAGE, CHECKPOINT, CONVERSATION_HISTORY 의 글은 읽지 않는다.
// ERROR_MESSAGE 는 첫 줄만 (core 가 sanitizeLine, cleanText, 120 자로 줄인다).
import { isObj } from '../../core/session-items.mjs';
import { firstLine } from '../../session-util.mjs';

export const ANTIGRAVITY_AGENT = 'antigravity';

/**
 * Step types after which the calls still waiting for a result line will never get one: they end `abandoned`. CHECKPOINT
 * (a compaction marker) is not one: the result line of a call can still come after it (P5e review finding 1), so the
 * calls keep waiting until one of these, or their result line, arrives.
 */
export const CLOSERS = Object.freeze(new Set(['PLANNER_RESPONSE', 'USER_INPUT', 'ERROR_MESSAGE']));

/**
 * Step types that pass by without taking a result slot: SYSTEM_MESSAGE (one boilerplate template, written after a turn
 * ends or between steps) and CONVERSATION_HISTORY (always empty). Every other type is a result line while calls wait
 * (GENERIC, typed results, and unknown future types, as the research's positional rule says) and is ignored otherwise.
 */
export const PASSING = Object.freeze(new Set(['SYSTEM_MESSAGE', 'CONVERSATION_HISTORY']));

const TYPE_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_CALLS = 256; // 한 계획 줄의 호출 상한 (조사에서는 최대 3개 남짓)
const MAX_LINE = 4096; // 오류 첫 줄을 찾을 때 보는 앞부분

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

function intOf(v) {
  if (Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d{1,12}\s*$/.test(v)) return Number(v);
  return null;
}

// One entry of tool_calls: an object, or (tolerated) a JSON-encoded object; anything else is still one call slot.
function callOf(c) {
  if (isObj(c)) return c;
  if (typeof c === 'string') {
    try {
      const p = JSON.parse(c);
      if (isObj(p)) return p;
    } catch {
      // 읽을 수 없는 호출: 이름 없는 도구로 자리만 차지한다
    }
  }
  return {};
}

/**
 * tool_calls -> { list, unreadable }. An array is the call list (every entry keeps its slot, so the results stay paired).
 * A string is tried as a JSON array (a truncated value); when it cannot be read the line had calls whose count is
 * unknown (`unreadable`): the session shows none and skips result lines until the next closer.
 */
export function callsOf(v) {
  if (v === undefined || v === null) return { list: [], unreadable: false };
  let arr = v;
  if (typeof v === 'string') {
    if (v.trim() === '') return { list: [], unreadable: false };
    try {
      arr = JSON.parse(v);
    } catch {
      return { list: [], unreadable: true };
    }
  }
  if (!Array.isArray(arr)) return { list: [], unreadable: true };
  return { list: arr.slice(0, MAX_CALLS).map(callOf), unreadable: false };
}

/**
 * One parsed line -> the fields the session uses, or null when it is not a step (no string `type`).
 * @returns {{ type: string, status: string|null, ms: number|null, content: string|null, thinking: string|null,
 *   calls: object[], callsUnreadable: boolean, error: string|null, exitCode: number|null }|null}
 */
export function parseStep(rec) {
  if (!isObj(rec) || typeof rec.type !== 'string' || !TYPE_RE.test(rec.type)) return null;
  const ms = typeof rec.created_at === 'string' ? Date.parse(rec.created_at) : NaN;
  const calls = callsOf(rec.tool_calls);
  return {
    type: rec.type,
    status: typeof rec.status === 'string' ? rec.status : null,
    ms: Number.isFinite(ms) ? ms : null,
    content: text(rec.content),
    thinking: text(rec.thinking),
    calls: calls.list,
    callsUnreadable: calls.unreadable,
    error: text(rec.error),
    exitCode: intOf(rec.exit_code),
  };
}

// --------------------------------------------------------------------------------------------- USER_INPUT

const REQUEST = 'USER_REQUEST';
const ANY_TAG_RE = /<\/?[A-Z][A-Z0-9_]*(?:\s[^>]*)?>/; // 닫는 태그가 없을 때 (잘린 content) 다음 블록에서 끊는다

/**
 * The human prompt of a USER_INPUT content: the trimmed inner text of the first non-empty top-level <USER_REQUEST>
 * block, or null. Only top-level blocks count (P5e review finding 3): the walk goes from one opening tag to the next and
 * jumps over every other block (ADDITIONAL_METADATA, USER_SETTINGS_CHANGE, PLAN, ...) to its own closing tag, so a
 * <USER_REQUEST> written inside one of them (a selection or a file excerpt in the environment context) is never read.
 * Another block that never closes holds the rest of the content: null. Content without a top-level USER_REQUEST block
 * gives null (the raw content is never a prompt). A USER_REQUEST cut by the truncation (no closing tag) ends at the next
 * tag.
 */
export function userRequestOf(content) {
  if (typeof content !== 'string') return null;
  const open = /<([A-Z][A-Z0-9_]*)(?:\s[^>]*)?>/g; // 여는 태그만 (닫는 태그는 '/' 로 시작해 걸리지 않는다)
  let m;
  while ((m = open.exec(content)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length;
    const closeTag = `</${name}>`;
    const close = content.indexOf(closeTag, start);
    if (name === REQUEST) {
      let inner;
      if (close >= 0) inner = content.slice(start, close);
      else {
        const rest = content.slice(start);
        const tag = rest.search(ANY_TAG_RE);
        inner = tag >= 0 ? rest.slice(0, tag) : rest;
      }
      inner = inner.trim();
      if (inner !== '') return inner;
    }
    if (close < 0) return null; // 닫히지 않은 블록: 나머지는 모두 그 블록 안이다
    open.lastIndex = close + closeTag.length; // 그 블록 전체를 건너뛴다 (안쪽의 태그는 보지 않는다)
  }
  return null;
}

// --------------------------------------------------------------------------------------------- results

/**
 * A result line -> the tool_end fields { status, errorLine?, background? } (the core reduces the error line).
 * failed: status ERROR (or INVALID / an unknown status), an `error` field, or a non-zero exit_code; the error line is
 * `Exit code <n>` when there is one, else the first line of `error`. RUNNING: the tool went to the background (its line
 * is never rewritten; R28) -> ok with background. DONE or no status -> ok. The content (tool output) is never read.
 */
export function resultEndOf(step) {
  const code = step.exitCode;
  const err = step.error ? firstLine(step.error.slice(0, MAX_LINE)) : '';
  const badCode = code !== null && code !== 0;
  if (step.status === 'ERROR' || err !== '' || badCode) {
    const out = { status: 'failed' };
    const line = badCode ? `Exit code ${code}` : err;
    if (line) out.errorLine = line;
    return out;
  }
  if (step.status === 'RUNNING') return { status: 'ok', background: true };
  if (step.status === null || step.status === 'DONE') return { status: 'ok' };
  return { status: 'failed' }; // INVALID 과 모르는 상태 (오류 줄 없이: core 의 'failed')
}

/** ERROR_MESSAGE -> the system api_error text: the first line of `error`, else of `content` ('' -> the core fallback). */
export function errorMessageText(step) {
  const src = step.error ?? step.content ?? '';
  return firstLine(src.slice(0, MAX_LINE));
}

// --------------------------------------------------------------------------------------------- metadata (setInfo)

/**
 * The `tasks` the metadata reader hands over (meta.mjs: the task.md checklist, already parsed into items) -> the item
 * list for a `plan { items, source: 'tasks' }`, or null. Accepts an array of { content | step, status } or { items }.
 */
export function planItemsOf(v) {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.items) ? v.items : null;
  if (!list) return null;
  return list.filter((it) => isObj(it) && (typeof it.content === 'string' || typeof it.step === 'string'));
}

/** The summary status (idle / running) handed over by the metadata reader -> 'idle' | 'running' | null. */
export function runStatusOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s === 'idle' || s === 'running' ? s : null;
}
