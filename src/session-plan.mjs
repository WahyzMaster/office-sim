// Whiteboard state of one session (R34-R36): update_plan list, task list, ExitPlanMode plan.
// Pure state; every method returns a plan view { items, source } to emit, or null when nothing changed.
// Task deltas from subagent files (they share the main task list) go through `external()` with timestamp guards
// so an older sub-side change never rolls back a newer main-side snapshot or update.
import {
  emptyPlan, applyUpdatePlan, reconcilePlanText, emptyTasks, applyTaskReminder,
  applyTaskCreate, applyTaskUpdate, tasksToItems, planFromMarkdown, taskIdOf, createdId,
} from './plan.mjs';

export const UPDATE_PLAN = 'mcp__ccd_turn__update_plan';
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);
const MAX_DELTAS = 1000;

function tsMs(ts) {
  const t = Date.parse(ts ?? '');
  return Number.isFinite(t) ? t : null;
}

export class PlanBoard {
  /** collectDeltas: sub/wf files keep their own successful TaskCreate/TaskUpdate for the main whiteboard (R36). */
  constructor({ collectDeltas = false } = {}) {
    this.collectDeltas = collectDeltas;
    this.deltas = [];
    this.plan = emptyPlan();
    this.tasks = emptyTasks();
    this.tasksKey = '[]';
    this.reminderMs = -Infinity; // latest main task_reminder (authoritative snapshot)
    this.touchMs = new Map(); // task id -> latest main-side TaskCreate/TaskUpdate time
    this.applied = new Set(); // external delta tool_use ids already decided
  }

  /**
   * A successful whiteboard tool result `c` (update_plan, TaskCreate, TaskUpdate) for tool_use `id`.
   * Returns the views to emit, in order (null entries are skipped by the caller).
   */
  toolResult(id, name, input, c) {
    if (name === UPDATE_PLAN) {
      const views = [this.updatePlan(input, c.text)];
      // R36: once update_plan has no items the task list shows again, even if it did not change meanwhile.
      // '[]' (not null) so an empty task list still emits nothing.
      if (!this.plan.items.length) {
        this.tasksKey = '[]';
        views.push(this.taskView());
      }
      return views;
    }
    if (!TASK_TOOLS.has(name)) return [];
    if (this.collectDeltas && this.deltas.length < MAX_DELTAS) {
      this.deltas.push({ ts: c.ts, toolUseId: id, name, input, text: c.text, toolUseResult: c.toolUseResult });
    }
    return [this.task(name, input, c)];
  }

  /** Drain the collected sub/wf task deltas. */
  takeDeltas() {
    const out = this.deltas;
    if (out.length) this.deltas = [];
    return out;
  }

  updatePlan(input, resultText) {
    this.plan = reconcilePlanText(applyUpdatePlan(this.plan, input), resultText);
    return { items: this.plan.items, source: 'update_plan' };
  }

  exitPlan(md) {
    const items = planFromMarkdown(md);
    return Array.isArray(items) && items.length ? { items, source: 'exit_plan' } : null;
  }

  reminder(content, ts) {
    this.tasks = applyTaskReminder(this.tasks, content);
    const t = tsMs(ts);
    if (t !== null && t > this.reminderMs) this.reminderMs = t;
    return this.taskView();
  }

  /** Own TaskCreate / TaskUpdate success. `c` is the classified tool_result. */
  task(name, input, c) {
    const id = this._applyTask(name, input, c.toolUseResult, c.text);
    const t = tsMs(c.ts);
    if (id !== null && t !== null && t > (this.touchMs.get(id) ?? -Infinity)) this.touchMs.set(id, t);
    return this.taskView();
  }

  /** A subagent's successful TaskCreate / TaskUpdate: apply only when newer than what this file already knows. */
  external(delta) {
    if (!delta || typeof delta.toolUseId !== 'string' || this.applied.has(delta.toolUseId)) return null;
    this.applied.add(delta.toolUseId);
    const t = tsMs(delta.ts);
    if (t === null || t <= this.reminderMs) return null;
    const id = delta.name === 'TaskUpdate' ? taskIdOf(delta.input) : createdId(delta.toolUseResult, delta.text);
    if (id === null || t <= (this.touchMs.get(id) ?? -Infinity)) return null;
    this._applyTask(delta.name, delta.input, delta.toolUseResult, delta.text);
    this.touchMs.set(id, t);
    return this.taskView();
  }

  _applyTask(name, input, toolUseResult, text) {
    if (name === 'TaskCreate') {
      this.tasks = applyTaskCreate(this.tasks, input, toolUseResult, text);
      return createdId(toolUseResult, text);
    }
    this.tasks = applyTaskUpdate(this.tasks, input);
    return taskIdOf(input);
  }

  // R36: tasks show only while update_plan has no items; repeated identical snapshots emit nothing.
  taskView() {
    if (this.plan.items.length) return null;
    const items = tasksToItems(this.tasks);
    const key = JSON.stringify(items);
    if (key === this.tasksKey) return null;
    this.tasksKey = key;
    return { items, source: 'tasks' };
  }

  debug() {
    return { plan: this.plan.items.map((it) => ({ ...it })), tasks: tasksToItems(this.tasks) };
  }
}
