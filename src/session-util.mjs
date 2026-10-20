// Pure helpers for session.mjs: project keys (4.4), tool_result status (R25), event text shaping.
import { summarize, cleanText, looksLikeUuid, ZERO_UUID } from './summarize.mjs';

const WORKTREE_RE = /^(.*?)\/(\.claude\/worktrees|\.worktrees)\/([^/]+)(?:\/|$)/;

/** Contract 4.4: stable floor key. worktreeState.originalCwd, else the worktree parent, else cwd. */
export function projectKey(cwd, worktreeState) {
  let key = worktreeState && typeof worktreeState === 'object' && typeof worktreeState.originalCwd === 'string'
    && worktreeState.originalCwd !== '' ? worktreeState.originalCwd : null;
  if (key === null && typeof cwd === 'string' && cwd !== '') {
    const m = WORKTREE_RE.exec(cwd);
    key = m ? m[1] : cwd;
  }
  if (key === null) return '';
  const stripped = key.replace(/\/+$/, '');
  return stripped === '' && key.startsWith('/') ? '/' : stripped;
}

/** Worktree name from a path inside `.claude/worktrees/<name>` or `.worktrees/<name>`, else null. */
export function worktreeFromPath(path) {
  if (typeof path !== 'string') return null;
  const m = WORKTREE_RE.exec(path);
  return m ? m[3] : null;
}

/** Epoch ms -> ISO string (epoch 0 for an invalid time). */
export function iso(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

export function basename(path) {
  if (typeof path !== 'string' || path === '') return '';
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

// ---------------------------------------------------------------------------------------------
// R25 tool_end status

// Contract list, plus two policy denials from the corpus study (safety check, worktree isolation).
const DENIAL_PREFIXES = [
  "The user doesn't want to proceed",
  'Permission to use',
  'Permission for this action was denied',
  'Permission for this command was denied',
  'PreToolUse:',
  'Blocked:',
  'This session is isolated in the worktree',
  'This agent is isolated in the worktree',
];
const INTERRUPT_PREFIX = '[Request interrupted by user';
const USER_REJECT_PREFIX = "The user doesn't want to proceed";

function stripToolUseError(text) {
  return text.replace(/^\s*<tool_use_error>/, '').replace(/<\/tool_use_error>\s*$/, '');
}

// 구조화된 본문이 시작하는 곳: JSON '{"' '["' '[{' '[[', Python dict/list "{'k':" "['a',", 따옴표 없는 키 '{a:'.
// 따옴표 안의 괄호("Unexpected token '{'", "Type '{ a: string }'")와 '[guard.sh]:' 는 아니다.
const PAYLOAD_RE = /(?<!['"`])(?:\{\s*(?:"|'[^'\n]*'\s*:|[{[]|[A-Za-z_$][\w$-]*\s*:)|\[\s*(?:"|'[^'\n]*'\s*[,\]]|[{[]))/;
// 여러 줄로 펼친 본문의 첫 줄: 줄 처음이나 ':' 뒤의 '{' / '[' 로 끝난다 ('MCP error -32603: {'). 'Unexpected token [' 는 아니다.
const PAYLOAD_EOL_RE = /(?:^|:)\s*[{[]\s*$/;

/** Cut the line where a structured payload starts, then trim the separator left before it. Unchanged otherwise. */
function cutPayload(s) {
  const m = PAYLOAD_RE.exec(s) ?? PAYLOAD_EOL_RE.exec(s);
  return m ? s.slice(0, m.index).replace(/[\s:]+$/, '') : s;
}

// 오류 줄의 uuid 모양 토큰 ('Server "<uuid>" not found' 의 커넥터 계정 id, 한 글자 오타 포함): 0 uuid 로 가린다
const UUID_TOKEN_RE = /(?<![0-9A-Za-z-])[0-9A-Za-z]{6,10}(?:-[0-9A-Za-z]{3,5}){3}-[0-9A-Za-z]{10,14}(?![0-9A-Za-z-])/g;

/**
 * Section 5: an error line may carry a denied command, a classifier reason that paraphrases it, an MCP JSON
 * payload (firestore documents, filters) or a connector account uuid. Reduce those to their category (uuids become
 * the zero uuid); paths, URLs, emails and `mcp__<uuid>` are left to cleanText, the one scrub every event text goes through.
 */
export function sanitizeLine(line) {
  let s = typeof line === 'string' ? line : '';
  s = s.replace(/^(Permission to use \S+) with command .*$/, '$1 has been denied.');
  // 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: <text>' -> 이유는 버린다
  s = s.replace(/^((?:Error: )?Permission for this (?:action|command) was denied by [^.]*)\..*$/, '$1.');
  s = s.replace(UUID_TOKEN_RE, (m) => (looksLikeUuid(m) ? ZERO_UUID : m));
  return cutPayload(s);
}

function errorText(body, fallback) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') || '';
  return cleanText(sanitizeLine(line), 120) || fallback;
}

/** tool_result item -> { ok } | { ok:false, errorKind, error }. */
export function resultStatus(c) {
  const body = stripToolUseError(typeof c.text === 'string' ? c.text : '');
  const lead = body.trimStart();
  if (c.isError === true && lead.startsWith(INTERRUPT_PREFIX)) {
    return { ok: false, errorKind: 'interrupted', error: errorText(lead, 'interrupted') };
  }
  const generated = DENIAL_PREFIXES.some((p) => lead.startsWith(p));
  if (c.toolDenialKind) {
    // A rejection whose text is only the user's own feedback (or an abort notice) gets a fixed text.
    return { ok: false, errorKind: 'denied', error: generated ? errorText(lead, 'denied') : 'denied' };
  }
  if (c.isError === true) {
    const denied = generated;
    return { ok: false, errorKind: denied ? 'denied' : 'failed', error: errorText(lead, denied ? 'denied' : 'failed') };
  }
  return { ok: true };
}

/** A user rejection: held for one record, because an interrupt marker may follow (R25). */
export function isUserRejected(c) {
  if (c.toolDenialKind === 'user-rejected') return true;
  const lead = stripToolUseError(typeof c.text === 'string' ? c.text : '').trimStart();
  return c.isError === true && lead.startsWith(USER_REJECT_PREFIX);
}

// ---------------------------------------------------------------------------------------------
// Event text

/** First sentence of a thinking block, <= 100 code points; null when there is no text. */
export function firstSentence(text) {
  if (typeof text !== 'string') return null;
  const para = text.trim().split(/\n\s*\n/)[0] || '';
  const flat = para.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  const m = /^(.+?[.!?。])(?=\s|$)/u.exec(flat);
  return cleanText(m ? m[1] : flat, 100) || null;
}

export function firstLine(text) {
  if (typeof text !== 'string') return '';
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') || '';
}

/**
 * R33: the lead question's text (<= 160) + ' (+N)' for the other questions, the lead's option labels (<= 4, each <= 30).
 * The lead is the first question whose cleaned text is not empty; with none, the question is null (never a bare
 * ' (+N)', CONTRACT 2) and the options are the first question's.
 */
export function askFields(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions.filter((q) => q && typeof q === 'object') : [];
  if (qs.length === 0) return { question: null, options: [] };
  let lead = qs[0];
  let question = '';
  for (const q of qs) {
    const text = cleanText(q.question, 160);
    if (text === '') continue;
    lead = q;
    question = qs.length > 1 ? `${text} (+${qs.length - 1})` : text;
    break;
  }
  const opts = Array.isArray(lead.options) ? lead.options : [];
  const options = opts.slice(0, 4)
    .map((o) => cleanText(typeof o === 'string' ? o : o && o.label, 30))
    .filter((o) => o !== '');
  return { question: question || null, options };
}

export const EXIT_PLAN_QUESTION = '이 계획대로 진행할까요?';
export const EXIT_PLAN_OPTIONS = ['승인', '수정 요청'];

/**
 * Raw tool name for tool_start.tool, except that a connector account uuid in the mcp server segment
 * (`mcp__<uuid>__get_issue`, bare `mcp__<uuid>`, one-char typos, 24+ hex) becomes the zero uuid.
 * public/js/rooms.js still labels it 'mcp' and classifies it like any `mcp__*` tool.
 */
export function publicToolName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  if (parts.length >= 2 && looksLikeUuid(parts[1])) parts[1] = ZERO_UUID;
  return parts.join('__');
}

/** tool_use block -> { ignore, fields } for the tool_start event (summary via summarize.mjs). */
export function toolStart(b) {
  let s;
  try {
    s = summarize(b.name, b.input) || {};
  } catch {
    s = {};
  }
  const fields = { toolUseId: b.id, tool: publicToolName(b.name), summary: s.summary || publicToolName(b.name) };
  if (s.room) fields.room = s.room;
  if (s.background === true) fields.background = true;
  if (b.name === 'AskUserQuestion') Object.assign(fields, askFields(b.input));
  if (b.name === 'ExitPlanMode') {
    fields.question = EXIT_PLAN_QUESTION;
    fields.options = [...EXIT_PLAN_OPTIONS];
  }
  return { ignore: Boolean(s.ignore), fields };
}

/** R31/R32 system record -> `system` event fields, or null (stop_hook_summary has none). */
export function systemFields(c) {
  switch (c.subtype) {
    case 'api_error': {
      const tries = `${c.retryAttempt ?? '?'}/${c.maxRetries ?? '?'}`;
      return { kind: 'api_error', text: c.status !== null && c.status !== undefined ? `API 재시도 ${tries} (${c.status})` : `API 재시도 ${tries}` };
    }
    case 'compact_boundary':
      return { kind: 'compact', text: cleanText(c.text || 'Conversation compacted', 100) };
    case 'model_refusal_fallback':
      return { kind: 'refusal', text: '응답 거절, 다른 모델로 다시 시도' };
    default:
      return null;
  }
}
