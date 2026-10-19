// Plan / task-list reconstruction (pure). Contract section 3.2, rules R34-R36.
// Every function returns a new object and never mutates its arguments.
import { cleanText } from './summarize.mjs';

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const MD_ITEM_MAX_CODE_POINTS = 80;
const MD_RAW_MAX_CHARS = 1000;

function normStatus(status) {
  return PLAN_STATUSES.has(status) ? status : 'pending';
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function copyItems(plan) {
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  return items.filter((it) => it && typeof it === 'object')
    .map((it) => ({ content: it.content, status: it.status }));
}

function basePlan(plan) {
  return plan && typeof plan === 'object' ? plan : {};
}

// 1-based index (number or numeric string) -> 0-based index, or -1 when unusable.
function toIndex(value, length) {
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n)) return -1;
  const i = n - 1;
  return i >= 0 && i < length ? i : -1;
}

function isTruthyFlag(v) {
  return v === true || v === 'true';
}

// ---------------------------------------------------------------------------
// update_plan

export function emptyPlan() {
  return { items: [] };
}

function replaceItems(rawItems) {
  const out = [];
  for (const it of rawItems) {
    if (typeof it === 'string') {
      out.push({ content: it, status: 'pending' });
    } else if (it && typeof it === 'object') {
      out.push({ content: asText(it.content), status: normStatus(it.status) });
    }
  }
  return out;
}

function advanceItems(items) {
  const cur = items.findIndex((it) => it.status === 'in_progress');
  if (cur < 0) return items; // no in_progress -> no change
  items[cur].status = 'completed';
  let next = -1;
  for (let j = cur + 1; j < items.length; j++) {
    if (items[j].status === 'pending') { next = j; break; }
  }
  // Contract: "first pending item after it, else the next index". The fallback can set an
  // already-completed item back to in_progress; that is intentional (reconcilePlanText then
  // trusts the harness text "step K of N").
  if (next < 0 && cur + 1 < items.length) next = cur + 1;
  if (next >= 0) items[next].status = 'in_progress';
  return items;
}

function doneStartItems(items, done, start) {
  const doneList = Array.isArray(done) ? done : done === undefined || done === null ? [] : [done];
  for (const d of doneList) {
    const i = toIndex(d, items.length);
    if (i >= 0) items[i].status = 'completed';
  }
  if (start !== undefined && start !== null) {
    const s = toIndex(start, items.length);
    if (s >= 0) items[s].status = 'in_progress';
  }
  // Every other status (including an old in_progress not listed in done) is left as is.
  return items;
}

export function applyUpdatePlan(plan, input) {
  const base = basePlan(plan);
  let items = copyItems(base);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (Array.isArray(input.items)) {
      items = replaceItems(input.items);
    } else if ((input.done !== undefined && input.done !== null)
      || (input.start !== undefined && input.start !== null)) {
      items = doneStartItems(items, input.done, input.start);
    } else if (isTruthyFlag(input.advance)) {
      items = advanceItems(items);
    }
  }
  return { ...base, items };
}

function resultToString(resultText) {
  if (typeof resultText === 'string') return resultText;
  if (Array.isArray(resultText)) {
    return resultText
      .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

const STEP_RE = /Plan updated: step (\d+) of (\d+) is in progress\./;

// Trust "Plan updated: step K of N is in progress." for the in_progress position only.
// "Plan shown (N steps)." (with or without " Keep only one step in_progress.") confirms an
// items call, which always wins, so it changes nothing.
export function reconcilePlanText(plan, resultText) {
  const base = basePlan(plan);
  const items = copyItems(base);
  const m = STEP_RE.exec(resultToString(resultText));
  if (!m) return { ...base, items };
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (n !== items.length || k < 1 || k > n) return { ...base, items };
  const target = k - 1;
  const current = [];
  items.forEach((it, i) => { if (it.status === 'in_progress') current.push(i); });
  if (current.length === 1 && current[0] === target) return { ...base, items };
  // Move the marker: stale in_progress items before K become completed, after K become pending.
  for (const i of current) {
    if (i !== target) items[i].status = i < target ? 'completed' : 'pending';
  }
  items[target].status = 'in_progress';
  return { ...base, items };
}

// ---------------------------------------------------------------------------
// TaskCreate / TaskUpdate / task_reminder

export function emptyTasks() {
  return { tasks: [] };
}

function baseTasks(tasks) {
  return tasks && typeof tasks === 'object' ? tasks : {};
}

function copyTasks(tasks) {
  const list = tasks && Array.isArray(tasks.tasks) ? tasks.tasks : [];
  return list.filter((t) => t && typeof t === 'object').map((t) => {
    const c = { id: t.id, subject: t.subject, status: t.status };
    if (typeof t.activeForm === 'string') c.activeForm = t.activeForm;
    return c;
  });
}

function normTaskId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim().replace(/^#/, '');
  return s === '' ? null : s;
}

export function applyTaskReminder(tasks, content) {
  const base = baseTasks(tasks);
  if (!Array.isArray(content)) return { ...base, tasks: copyTasks(base) };
  const list = [];
  for (const t of content) {
    if (!t || typeof t !== 'object') continue;
    const id = normTaskId(t.id);
    if (id === null || t.status === 'deleted') continue;
    const task = { id, subject: asText(t.subject), status: normStatus(t.status) };
    if (typeof t.activeForm === 'string') task.activeForm = t.activeForm;
    list.push(task);
  }
  return { ...base, tasks: list };
}

const CREATED_RE = /Task #(\d+) created/;

/** Task id a successful TaskCreate result names (toolUseResult.task.id or "Task #N created"), else null. */
export function createdId(toolUseResult, resultText) {
  if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
    const id = normTaskId(toolUseResult.task && toolUseResult.task.id);
    if (id !== null) return id;
  }
  const m = CREATED_RE.exec(resultToString(resultText));
  return m ? m[1] : null;
}

export function applyTaskCreate(tasks, input, toolUseResult, resultText) {
  const base = baseTasks(tasks);
  const list = copyTasks(base);
  const id = createdId(toolUseResult, resultText);
  if (id === null) return { ...base, tasks: list }; // failed create (validation error etc.)
  const inp = input && typeof input === 'object' ? input : {};
  const trSubject = toolUseResult && typeof toolUseResult === 'object' && toolUseResult.task
    ? toolUseResult.task.subject : undefined;
  const subject = typeof inp.subject === 'string' ? inp.subject : asText(trSubject);
  const existing = list.find((t) => t.id === id);
  if (existing) {
    // Already known (snapshot or duplicate): refresh the label, keep the status.
    if (subject) existing.subject = subject;
    if (typeof inp.activeForm === 'string') existing.activeForm = inp.activeForm;
    return { ...base, tasks: list };
  }
  const task = { id, subject, status: 'pending' };
  if (typeof inp.activeForm === 'string') task.activeForm = inp.activeForm;
  list.push(task);
  return { ...base, tasks: list };
}

/** Task id a TaskUpdate input targets (taskId | id | task_id), else null. */
export function taskIdOf(input) {
  return input && typeof input === 'object' ? normTaskId(input.taskId ?? input.id ?? input.task_id) : null;
}

export function applyTaskUpdate(tasks, input) {
  const base = baseTasks(tasks);
  const list = copyTasks(base);
  if (!input || typeof input !== 'object') return { ...base, tasks: list };
  const id = normTaskId(input.taskId ?? input.id ?? input.task_id);
  const idx = id === null ? -1 : list.findIndex((t) => t.id === id);
  if (idx < 0) return { ...base, tasks: list }; // unknown id -> ignored
  if (input.status === 'deleted') {
    list.splice(idx, 1);
    return { ...base, tasks: list };
  }
  const task = list[idx];
  if (PLAN_STATUSES.has(input.status)) task.status = input.status;
  if (typeof input.subject === 'string') task.subject = input.subject;
  if (typeof input.activeForm === 'string') task.activeForm = input.activeForm;
  // addBlocks / addBlockedBy / owner / description are accepted and ignored.
  return { ...base, tasks: list };
}

export function tasksToItems(tasks) {
  const list = tasks && Array.isArray(tasks.tasks) ? tasks.tasks : [];
  const numeric = [];
  const other = [];
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const n = /^\d+$/.test(String(t.id)) ? Number(t.id) : NaN;
    (Number.isNaN(n) ? other : numeric).push({ t, n, i });
  });
  numeric.sort((a, b) => a.n - b.n || a.i - b.i);
  return [...numeric, ...other].map(({ t }) => ({ content: asText(t.subject), status: normStatus(t.status) }));
}

// ---------------------------------------------------------------------------
// ExitPlanMode markdown -> pending items

function capCodePoints(text, max) {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  return cps.slice(0, max - 1).join('').trimEnd() + '…';
}

// Strip inline markdown. URLs, emails and absolute paths go through the one section 5 scrub (cleanText) after the
// link/HTML/backtick markup is gone and before emphasis markers are dropped, so 'Application Support/x' style
// paths with spaces reduce to the basename like in every other event text.
function cleanInline(raw) {
  let s = raw;
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
  s = s.replace(/`+/g, '');
  s = cleanText(s, Infinity); // raw is capped at MD_RAW_MAX_CHARS, under the scrub limit
  s = s.replace(/\*\*/g, '');
  s = s.replace(/(^|[^\w])__(?=\S)(.*?\S)__(?=$|[^\w])/g, '$1$2');
  s = s.replace(/~~/g, '');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?=$|[^\w*])/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?=$|[^\w])/g, '$1$2');
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_RE = /^ ?(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const CHECKBOX_RE = /^\[[ xX]\]\s+/;

export function planFromMarkdown(md, max = 6) {
  if (typeof md !== 'string' || md.trim() === '') return [];
  const limit = Number.isInteger(max) ? max : 6;
  if (limit <= 0) return [];
  const out = [];
  let fence = null;
  for (const line of md.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    if (HR_RE.test(line)) continue;
    let raw = null;
    const h = HEADING_RE.exec(line);
    if (h) {
      raw = h[1];
    } else {
      const li = LIST_RE.exec(line);
      if (li) raw = li[1].replace(CHECKBOX_RE, '');
    }
    if (raw === null) continue;
    // Bound regex work on giant single-line items (plans reach ~122 KB); output is capped anyway.
    if (raw.length > MD_RAW_MAX_CHARS) raw = Array.from(raw).slice(0, MD_RAW_MAX_CHARS).join('');
    const text = cleanInline(raw);
    if (!text) continue;
    out.push({ content: capCodePoints(text, MD_ITEM_MAX_CODE_POINTS), status: 'pending' });
    if (out.length >= limit) break;
  }
  return out;
}
