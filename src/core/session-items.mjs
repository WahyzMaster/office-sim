// Pure shaping of normalized items (ADAPTERS 3.2) into event fields for SessionCore (session-core.mjs).
// 모든 자유 텍스트는 cleanText 와 CONTRACT 2 의 길이 상한을 지난다. 상태는 없다 (SessionCore 가 가진다).
import { cleanText } from '../summarize.mjs';
import { firstSentence, firstLine, sanitizeLine, askFields, iso } from '../session-util.mjs';
import { applyUpdatePlan, emptyPlan, planFromMarkdown } from '../plan.mjs';
import { toolSummary, TOOL_KINDS } from './tool-summary.mjs';

/** CONTRACT 2 caps in code points. */
export const CAPS = Object.freeze({
  prompt: 80, say: 100, thinking: 100, error: 120, question: 160, option: 30, options: 4, plan: 80,
});

// abandoned: 어댑터가 턴 중간에 결과 없는 도구 하나를 닫을 때 (Antigravity 의 위치 짝짓기, R27 과 같은 뜻)
export const TOOL_STATUSES = new Set(['ok', 'failed', 'denied', 'interrupted', 'abandoned']);
export const TURN_END_REASONS = new Set(['stop_hook', 'api_error', 'interrupt', 'wrap_up', 'next_turn', 'end_turn']);
export const SYSTEM_KINDS = new Set(['api_error', 'compact', 'refusal']);
const KINDS = new Set(TOOL_KINDS);
const SYSTEM_FALLBACK = { api_error: 'API error', compact: 'Conversation compacted', refusal: '응답 거절' };
const MAX_ID = 256;
const MAX_PLAN_ITEMS = 1000; // 메모리 보호용 (CONTRACT 2: update_plan/tasks 는 목록 전체를 보낸다)

export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `true` or the string 'true' (like summarize.mjs run_in_background). */
export function isFlag(v) {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

/** Item timestamp (ISO string or epoch ms) -> ISO string, or null. Never passes the raw string through. */
export function itemTs(v) {
  let ms = NaN;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string' && v !== '') ms = Date.parse(v);
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? iso(ms) : null;
}

/** Tool / turn id: a non-empty string (<= 256 chars) or a finite number, as a string; else null. */
export function itemId(v) {
  if (typeof v === 'string') return v !== '' && v.length <= MAX_ID ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Dedupe key (`key` on any item): a string or finite number, else null (no dedupe). */
export function itemKey(v) {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return `#${v}`;
  return null;
}

// 앞에 붙은 보이지 않는 글자 (제어, 서식, 공백, 결합 문자, 기본 무시 글자: U+200B, U+00AD, U+FEFF, U+034F ...)
const INVISIBLE_LEAD_RE = /^[\p{Cc}\p{Cf}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}\s]+/u;
const TAG_START_RE = /^[<\uFF1C\uFE64]/; // '<' 와 전각/작은 '<'

/**
 * Human prompt: { raw, text } or null. Empty text or text starting with '<' (injected tags) is skipped, also when
 * invisible or control characters come first (checked on the raw text without them and on the scrubbed text).
 */
export function promptOf(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '' || TAG_START_RE.test(raw.replace(INVISIBLE_LEAD_RE, ''))) return null;
  const t = cleanText(raw, CAPS.prompt);
  if (!t || TAG_START_RE.test(t.replace(INVISIBLE_LEAD_RE, ''))) return null;
  return { raw, text: t };
}

export function sayText(text) {
  return cleanText(text, CAPS.say);
}

/** thinking: first sentence <= 100 or null; durationMs a finite number >= 0, else null. */
export function thinkingFields(item) {
  const d = item.durationMs;
  return { text: firstSentence(item.text), durationMs: typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null };
}

/** The first non-empty line of an error, reduced to its category (sanitizeLine), scrubbed, <= 120. */
export function errorText(line, fallback) {
  return cleanText(sanitizeLine(firstLine(line)), CAPS.error) || fallback;
}

/**
 * tool_end fields. A missing status is ok; an unknown one is failed. `background` (R28: the launch is ok, the work lives
 * on) never overrides an explicit failed / denied / interrupted status, and the event never carries it (CONTRACT 2).
 */
export function endFields(id, item) {
  const raw = item.status ?? 'ok';
  const status = TOOL_STATUSES.has(raw) ? raw : 'failed';
  if (status === 'ok') return { toolUseId: id, ok: true };
  // R27 과 같은 모양. errorLine 은 쓰지 않는다(결과가 없었으므로 보여 줄 문구도 없다).
  if (status === 'abandoned') return { toolUseId: id, ok: false, errorKind: 'abandoned', error: 'no result' };
  return { toolUseId: id, ok: false, errorKind: status, error: errorText(item.errorLine, status) };
}

/**
 * tool_wait fields (P5g, CONTRACT 2): exactly { toolUseId, waiting }, or null when `waiting` is not a boolean (malformed).
 * 필드 순서가 곧 선 위의 모양이다: snapshot 의 사본이 보낸 이벤트와 JSON 으로 같아야 한다.
 */
export function waitFields(id, item) {
  return typeof item.waiting === 'boolean' ? { toolUseId: id, waiting: item.waiting } : null;
}

/** R33-like ask fields: `questions` (Codex/Grok shape) via askFields, else `question` (<= 160) and `options` (<= 4 x 30). */
export function askOf(item) {
  if (Array.isArray(item.questions)) return askFields({ questions: item.questions });
  const options = (Array.isArray(item.options) ? item.options : []).slice(0, CAPS.options)
    .map((o) => cleanText(typeof o === 'string' ? o : isObj(o) ? o.label : '', CAPS.option))
    .filter((o) => o !== '');
  return { question: cleanText(item.question, CAPS.question) || null, options };
}

/**
 * tool_start item -> { kind, ignore, fields }. The descriptor `desc` wins over the item's own `tool` / `kind`, which fill
 * gaps; `background` is set when either says so. kind 'plan' is plumbing (ignore: no tool_start, R35).
 */
export function startFields(id, item) {
  const desc = isObj(item.desc) ? item.desc : {};
  const merged = { tool: item.tool, kind: item.kind, ...desc };
  merged.background = isFlag(desc.background) || isFlag(item.background);
  const kind = KINDS.has(merged.kind) ? merged.kind : 'other';
  const s = toolSummary(merged);
  const fields = { toolUseId: id, tool: s.tool, summary: s.summary };
  if (s.room) fields.room = s.room;
  if (s.background === true) fields.background = true;
  if (kind === 'ask') Object.assign(fields, askOf(item));
  return { kind, ignore: kind === 'plan', fields };
}

/**
 * plan item (or a plan-kind tool_start carrying a plan) -> { items, source } or null. The source follows the shape (D5,
 * CONTRACT 2), not the item's word for it:
 * `markdown` -> planFromMarkdown (<= 6 pending items), always 'exit_plan' (a markdown plan proposal).
 * `items` -> the full list replaces the board ({ content | step, status }, unknown status -> pending): 'tasks' when the
 * item says so (a checklist such as Antigravity task.md, parsed by the adapter), else 'update_plan'; never 'exit_plan'.
 * Item text is scrubbed by the caller (<= 80).
 */
export function planViewOf(item) {
  if (typeof item.markdown === 'string') {
    const items = planFromMarkdown(item.markdown);
    return items.length ? { items, source: 'exit_plan' } : null;
  }
  if (!Array.isArray(item.items)) return null;
  const raw = item.items.slice(0, MAX_PLAN_ITEMS)
    .map((it) => (isObj(it) && it.content === undefined && typeof it.step === 'string' ? { ...it, content: it.step } : it));
  return { items: applyUpdatePlan(emptyPlan(), { items: raw }).items, source: item.source === 'tasks' ? 'tasks' : 'update_plan' };
}

/** Plan view -> event fields: every content scrubbed and capped at 80 (section 5). */
export function planFields(view) {
  return { items: view.items.map((it) => ({ content: cleanText(it.content, CAPS.plan), status: it.status })), source: view.source };
}

/**
 * system item -> { kind, text } or null for an unknown kind. R31: only the first line of the text, reduced like a tool
 * error (sanitizeLine: a structured payload is cut, uuid tokens masked; stricter than Claude), scrubbed, <= 120.
 */
export function systemFields(item) {
  if (!SYSTEM_KINDS.has(item.kind)) return null;
  return { kind: item.kind, text: errorText(item.text, SYSTEM_FALLBACK[item.kind]) };
}
