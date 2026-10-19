// Unit tests for src/plan.mjs (contract 3.2, R34-R36). Synthetic, invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPlan, applyUpdatePlan, reconcilePlanText,
  emptyTasks, applyTaskReminder, applyTaskCreate, applyTaskUpdate, tasksToItems,
  planFromMarkdown,
} from '../src/plan.mjs';

// Frozen inputs: any mutation throws in strict-mode ESM.
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

const P = 'pending';
const I = 'in_progress';
const C = 'completed';
const plan = (...statuses) => deepFreeze({
  items: statuses.map((status, i) => ({ content: `step ${i + 1}`, status })),
});
const statuses = (p) => p.items.map((it) => it.status);

test('emptyPlan / emptyTasks shapes', () => {
  assert.deepEqual(emptyPlan(), { items: [] });
  assert.deepEqual(emptyTasks(), { tasks: [] });
  assert.notStrictEqual(emptyPlan(), emptyPlan());
});

test('items replaces the whole list and normalises entries', () => {
  const before = plan(C, I, P);
  const out = applyUpdatePlan(before, deepFreeze({
    items: [
      { content: 'write parser', status: 'completed' },
      { content: 'write tests', status: 'in_progress', session: 'x' },
      { content: 'ship', status: 'weird' },
      null,
      'bare string step',
    ],
    scope: 'continuation',
  }));
  assert.deepEqual(out, {
    items: [
      { content: 'write parser', status: C },
      { content: 'write tests', status: I },
      { content: 'ship', status: P },
      { content: 'bare string step', status: P },
    ],
  });
  assert.notStrictEqual(out.items, before.items);
  assert.deepEqual(applyUpdatePlan(before, { items: [] }), { items: [] });
});

test('items wins over advance/done in the same input', () => {
  const out = applyUpdatePlan(plan(I, P), { items: [{ content: 'a', status: P }], advance: true, done: [1] });
  assert.deepEqual(out, { items: [{ content: 'a', status: P }] });
});

const advanceCases = [
  ['from first', [I, P, P], [C, I, P]],
  ['from middle', [C, I, P, P], [C, C, I, P]],
  ['from last', [C, C, I], [C, C, C]],
  ['no in_progress -> no change', [C, P, P], [C, P, P]],
  ['empty plan -> no change', [], []],
  ['next already completed -> first pending after', [I, C, P, P], [C, C, I, P]],
  // Literal contract rule "else the next index": may reopen a completed step; reconcile fixes it.
  ['nothing pending after -> next index', [P, I, C, C], [P, C, I, C]],
  ['pending before current is not used', [P, I, C], [P, C, I]],
  ['two in_progress -> first one advances (literal rule)', [I, I, P], [C, I, I]],
];
for (const [name, from, expected] of advanceCases) {
  test(`advance ${name}`, () => {
    const before = plan(...from);
    const out = applyUpdatePlan(before, deepFreeze({ advance: true }));
    assert.deepEqual(statuses(out), expected);
    assert.deepEqual(out.items.map((it) => it.content), before.items.map((it) => it.content));
  });
}

test('advance accepts the string flag and ignores falsy advance', () => {
  assert.deepEqual(statuses(applyUpdatePlan(plan(I, P), { advance: 'true' })), [C, I]);
  assert.deepEqual(statuses(applyUpdatePlan(plan(I, P), { advance: false })), [I, P]);
});

const doneStartCases = [
  ['done [2,3] start 4', [C, I, I, P, P], { done: [2, 3], start: 4 }, [C, C, C, I, P]],
  ['done [1,2] start 3', [C, I, P, P], { done: [1, 2], start: 3 }, [C, C, I, P]],
  ['done [1,3] start 4', [I, C, P, P, P], { done: [1, 3], start: 4 }, [C, C, C, I, P]],
  // done does not include the in_progress step: it stays in_progress ("leave the rest").
  ['done without the in_progress step', [I, P, P], { done: [2], start: 3 }, [I, C, I]],
  ['start only', [I, P, P], { start: 2 }, [I, I, P]],
  ['done only', [I, P], { done: [1] }, [C, P]],
  ['numeric strings and scalar done', [I, P, P], { done: '1', start: '2' }, [C, I, P]],
  ['out of range / bad indices ignored', [I, P], { done: [0, 5, -1, 1.5, 'x'], start: 9 }, [I, P]],
];
for (const [name, from, input, expected] of doneStartCases) {
  test(`done/start ${name}`, () => {
    assert.deepEqual(statuses(applyUpdatePlan(plan(...from), deepFreeze(input))), expected);
  });
}

test('applyUpdatePlan tolerates bad inputs and keeps extra plan keys', () => {
  for (const bad of [undefined, null, 'x', 42, [], {}, { __unparsedToolInput: { raw: '...' } }]) {
    assert.deepEqual(statuses(applyUpdatePlan(plan(I, P), bad)), [I, P]);
  }
  assert.deepEqual(applyUpdatePlan(null, { advance: true }), { items: [] });
  assert.deepEqual(applyUpdatePlan(undefined, { items: [{ content: 'a', status: I }] }),
    { items: [{ content: 'a', status: I }] });
  const withExtra = deepFreeze({ items: [{ content: 'a', status: I }], marker: 7 });
  assert.equal(applyUpdatePlan(withExtra, { advance: true }).marker, 7);
});

const reconcileCases = [
  ['agrees -> unchanged', [C, I, P], 'Plan updated: step 2 of 3 is in progress.', [C, I, P]],
  ['moves marker forward', [C, I, P, P], 'Plan updated: step 3 of 4 is in progress.', [C, C, I, P]],
  ['moves marker back', [C, C, I, P], 'Plan updated: step 2 of 4 is in progress.', [C, I, P, P]],
  ['with app actions suffix', [P, C, I, C],
    'Plan updated: step 2 of 4 is in progress. App actions available now: commit, create_pr, verify.',
    [P, I, P, C]],
  ['no in_progress replayed', [C, C, C], 'Plan updated: step 3 of 3 is in progress.', [C, C, I]],
  ['collapses two in_progress', [I, C, I], 'Plan updated: step 3 of 3 is in progress.', [C, C, I]],
  ['N differs from list length -> unchanged', [C, I], 'Plan updated: step 1 of 5 is in progress.', [C, I]],
  ['K out of range -> unchanged', [C, I], 'Plan updated: step 3 of 2 is in progress.', [C, I]],
  ['K zero -> unchanged', [C, I], 'Plan updated: step 0 of 2 is in progress.', [C, I]],
  ['Plan shown confirms only', [I, I, P], 'Plan shown (3 steps).', [I, I, P]],
  ['Plan shown + keep one in_progress', [I, I, P], 'Plan shown (3 steps). Keep only one step in_progress.', [I, I, P]],
  ['Plan shown + app actions', [C, I], 'Plan shown (2 steps). App actions available now: commit.', [C, I]],
  ['unrelated text', [C, I], 'Something else happened.', [C, I]],
];
for (const [name, from, text, expected] of reconcileCases) {
  test(`reconcilePlanText ${name}`, () => {
    const before = plan(...from);
    const out = reconcilePlanText(before, text);
    assert.deepEqual(statuses(out), expected);
    assert.notStrictEqual(out.items, before.items);
  });
}

test('reconcilePlanText accepts text block arrays and tolerates non-strings', () => {
  const blocks = deepFreeze([{ type: 'text', text: 'Plan updated: step 1 of 2 is in progress.' }]);
  assert.deepEqual(statuses(reconcilePlanText(plan(C, I), blocks)), [I, P]);
  for (const bad of [undefined, null, 42, { text: 'Plan updated: step 1 of 2 is in progress.' }]) {
    assert.deepEqual(statuses(reconcilePlanText(plan(C, I), bad)), [C, I]);
  }
  assert.deepEqual(reconcilePlanText(null, 'Plan updated: step 1 of 1 is in progress.'), { items: [] });
});

test('replay sequence: items, advance, done/start, reconcile', () => {
  let p = emptyPlan();
  p = applyUpdatePlan(p, { items: [1, 2, 3, 4].map((n) => ({ content: `s${n}`, status: n === 1 ? I : P })) });
  p = reconcilePlanText(p, 'Plan shown (4 steps).');
  p = applyUpdatePlan(p, { advance: true });
  p = reconcilePlanText(p, 'Plan updated: step 2 of 4 is in progress.');
  assert.deepEqual(statuses(p), [C, I, P, P]);
  p = applyUpdatePlan(p, { done: [2, 3], start: 4 });
  p = reconcilePlanText(p, 'Plan updated: step 4 of 4 is in progress. App actions available now: commit.');
  assert.deepEqual(statuses(p), [C, C, C, I]);
});

// ---------------------------------------------------------------------------
// tasks

const snapshot = deepFreeze([
  { id: '2', subject: 'beta', description: 'secret text', activeForm: 'Doing beta', status: 'in_progress',
    blocks: [], blockedBy: [], owner: 'agent-x' },
  { id: '1', subject: 'alpha', description: 'more text', status: 'completed', blocks: [], blockedBy: [] },
  { id: 3, subject: 'gamma', status: 'pending' },
  { subject: 'no id' },
  null,
]);
const tasks = (...list) => deepFreeze({ tasks: list });

test('task_reminder snapshot replaces the list (minimal task shape)', () => {
  const before = tasks({ id: '9', subject: 'old', status: P });
  const out = applyTaskReminder(before, snapshot);
  assert.deepEqual(out, {
    tasks: [
      { id: '2', subject: 'beta', status: I, activeForm: 'Doing beta' },
      { id: '1', subject: 'alpha', status: C },
      { id: '3', subject: 'gamma', status: P },
    ],
  });
});

test('task_reminder empty content clears; non-array leaves the list', () => {
  const before = tasks({ id: '1', subject: 'a', status: C });
  assert.deepEqual(applyTaskReminder(before, deepFreeze([])), { tasks: [] });
  assert.deepEqual(applyTaskReminder(before, undefined), { tasks: [{ id: '1', subject: 'a', status: C }] });
  assert.deepEqual(applyTaskReminder(null, null), { tasks: [] });
});

test('TaskCreate takes the id from toolUseResult.task.id', () => {
  const out = applyTaskCreate(tasks({ id: '1', subject: 'a', status: C }),
    deepFreeze({ subject: 'write docs', description: 'long private text', activeForm: 'Writing docs' }),
    deepFreeze({ task: { id: '2', subject: 'write docs' } }),
    'Task #2 created successfully: write docs');
  assert.deepEqual(out.tasks, [
    { id: '1', subject: 'a', status: C },
    { id: '2', subject: 'write docs', status: P, activeForm: 'Writing docs' },
  ]);
});

test('TaskCreate falls back to "Task #N created" text (subagent results lack toolUseResult)', () => {
  const out = applyTaskCreate(emptyTasks(), { subject: 'x' }, undefined, 'Task #12 created successfully: x');
  assert.deepEqual(out.tasks, [{ id: '12', subject: 'x', status: P }]);
  const blocks = [{ type: 'text', text: 'Task #4 created successfully: y' }];
  assert.deepEqual(applyTaskCreate(emptyTasks(), { subject: 'y' }, null, blocks).tasks,
    [{ id: '4', subject: 'y', status: P }]);
});

test('TaskCreate without an id (validation error) changes nothing', () => {
  const before = tasks({ id: '1', subject: 'a', status: P });
  const out = applyTaskCreate(before, { tasks: 'bulk' },
    'InputValidationError: TaskCreate failed due to the following issues',
    '<tool_use_error>InputValidationError: TaskCreate failed</tool_use_error>');
  assert.deepEqual(out, { tasks: [{ id: '1', subject: 'a', status: P }] });
  assert.notStrictEqual(out.tasks, before.tasks);
});

test('TaskCreate for a known id refreshes the label but keeps the status', () => {
  const out = applyTaskCreate(tasks({ id: '3', subject: 'old', status: I }), { subject: 'new' },
    { task: { id: '3', subject: 'new' } }, '');
  assert.deepEqual(out.tasks, [{ id: '3', subject: 'new', status: I }]);
});

const base3 = tasks(
  { id: '1', subject: 'a', status: P },
  { id: '2', subject: 'b', status: I, activeForm: 'Doing b' },
  { id: '3', subject: 'c', status: C },
);
const updateCases = [
  ['taskId key', { taskId: '1', status: 'in_progress', activeForm: 'Doing a' },
    [['1', I, 'Doing a'], ['2', I, 'Doing b'], ['3', C]]],
  ['id alias', { id: '2', status: 'completed' }, [['1', P], ['2', C, 'Doing b'], ['3', C]]],
  ['task_id alias, numeric', { task_id: 3, status: 'in_progress' }, [['1', P], ['2', I, 'Doing b'], ['3', I]]],
  ['#-prefixed id', { taskId: '#1', status: 'completed' }, [['1', C], ['2', I, 'Doing b'], ['3', C]]],
  ['status deleted removes', { taskId: '2', status: 'deleted' }, [['1', P], ['3', C]]],
  ['unknown id ignored', { taskId: '99', status: 'completed' }, [['1', P], ['2', I, 'Doing b'], ['3', C]]],
  ['missing id ignored', { status: 'completed' }, [['1', P], ['2', I, 'Doing b'], ['3', C]]],
  ['addBlocks/addBlockedBy/owner tolerated', { taskId: '1', addBlocks: ['2'], addBlockedBy: ['3'], owner: 'z' },
    [['1', P], ['2', I, 'Doing b'], ['3', C]]],
  ['unknown status ignored, subject still patched', { taskId: '3', status: 'cancelled', subject: 'c2' },
    [['1', P], ['2', I, 'Doing b'], ['3', C]], 'c2'],
];
for (const [name, input, expected, subject3] of updateCases) {
  test(`TaskUpdate ${name}`, () => {
    const out = applyTaskUpdate(base3, deepFreeze(input));
    assert.deepEqual(out.tasks.map((t) => (t.activeForm ? [t.id, t.status, t.activeForm] : [t.id, t.status])),
      expected);
    if (subject3) assert.equal(out.tasks.find((t) => t.id === '3').subject, subject3);
  });
}

test('TaskUpdate tolerates bad input', () => {
  for (const bad of [undefined, null, 'x', 5]) {
    assert.equal(applyTaskUpdate(base3, bad).tasks.length, 3);
  }
  assert.deepEqual(applyTaskUpdate(null, { taskId: '1', status: 'completed' }), { tasks: [] });
});

test('tasksToItems orders by numeric id, non-numeric ids last in original order', () => {
  const t = tasks(
    { id: '10', subject: 'ten', status: P },
    { id: 'b', subject: 'bee', status: P },
    { id: '2', subject: 'two', status: C },
    { id: 'a', subject: 'ay', status: I },
    { id: '1', subject: 'one', status: I },
  );
  assert.deepEqual(tasksToItems(t), [
    { content: 'one', status: I },
    { content: 'two', status: C },
    { content: 'ten', status: P },
    { content: 'bee', status: P },
    { content: 'ay', status: I },
  ]);
  assert.deepEqual(tasksToItems(emptyTasks()), []);
  assert.deepEqual(tasksToItems(null), []);
});

test('task replay: snapshot, create, update, delete', () => {
  let t = applyTaskReminder(emptyTasks(), [{ id: '1', subject: 'a', status: 'completed' }]);
  t = applyTaskCreate(t, { subject: 'b', activeForm: 'Doing b' }, { task: { id: '2', subject: 'b' } }, '');
  t = applyTaskUpdate(t, { taskId: '2', status: 'in_progress' });
  t = applyTaskCreate(t, { subject: 'c' }, undefined, 'Task #3 created successfully: c');
  t = applyTaskUpdate(t, { id: '1', status: 'deleted' });
  assert.deepEqual(tasksToItems(t), [{ content: 'b', status: I }, { content: 'c', status: P }]);
});

// ---------------------------------------------------------------------------
// planFromMarkdown

const contents = (items) => items.map((it) => it.content);

test('planFromMarkdown pulls headings and top-level list items as pending', () => {
  const md = [
    '# Add **widget** export',
    '',
    'Some intro paragraph that is not an item.',
    '## Steps',
    '1. Parse the `config` file',
    '   - nested detail is skipped',
    '2) Wire the [router](https://example.com/docs/x) up',
    '- [ ] Write *unit* tests',
    '* [x] Keep snake_case_names intact',
    '',
  ].join('\n');
  const out = planFromMarkdown(md, 10);
  assert.deepEqual(contents(out), [
    'Add widget export',
    'Steps',
    'Parse the config file',
    'Wire the router up',
    'Write unit tests',
    'Keep snake_case_names intact',
  ]);
  assert.ok(out.every((it) => it.status === P));
});

test('planFromMarkdown skips code fences (``` and ~~~, unclosed runs to the end)', () => {
  const md = [
    '## Before',
    '```js',
    '# not a heading',
    '- not an item',
    '```',
    '- after fence',
    '~~~',
    '## inside tilde fence',
    '~~~',
    '## Tail',
    '```',
    '- never seen',
  ].join('\n');
  assert.deepEqual(contents(planFromMarkdown(md)), ['Before', 'after fence', 'Tail']);
});

test('planFromMarkdown caps at max (default 6)', () => {
  const md = Array.from({ length: 10 }, (_, i) => `- item ${i + 1}`).join('\n');
  assert.equal(planFromMarkdown(md).length, 6);
  assert.deepEqual(contents(planFromMarkdown(md, 2)), ['item 1', 'item 2']);
  assert.deepEqual(planFromMarkdown(md, 0), []);
});

test('planFromMarkdown returns [] for empty or non-string input', () => {
  for (const bad of ['', '   \n\n', undefined, null, 42, {}, 'just prose\nno structure']) {
    assert.deepEqual(planFromMarkdown(bad), []);
  }
});

test('planFromMarkdown skips rules, tables, quotes and empty markers', () => {
  const md = ['---', '- - -', '***', '| a | b |', '> - quoted', '#', '-', '#hashtag', '#### Real ###'].join('\n');
  assert.deepEqual(contents(planFromMarkdown(md)), ['Real']);
});

test('planFromMarkdown strips markdown and keeps privacy (host-only URLs, basename paths)', () => {
  const md = [
    '## Edit `/Users/someone/project/src/plan.mjs` and ~/notes/todo.md',
    '- Fetch https://api.example.org/v1/private?token=abc then <https://other.example.net/p>',
    '- See ![diagram](./img/d.png) and __bold__ ~~old~~ <b>tag</b>',
    '- Open file:///Users/someone/secret/report.txt',
    '- Keep src/plan.mjs relative and /events route',
  ].join('\n');
  assert.deepEqual(contents(planFromMarkdown(md)), [
    'Edit plan.mjs and todo.md',
    'Fetch api.example.org then other.example.net',
    'See diagram and bold old tag',
    'Open report.txt',
    // the one section 5 scrub: a single-segment absolute path is a path too (relative paths stay)
    'Keep src/plan.mjs relative and events route',
  ]);
});

test('finding 2: plan items use the shared scrub, so paths with spaces reduce to the basename', () => {
  const md = [
    '- Edit open /Users/victim/Library/Application Support/XPLANAPPSUP/notes.txt now',
    '- Edit open ~/Google Drive/My Drive/XPLANMYDRIVE/budget.xlsx',
    '- Edit open /Users/victim/Library/Application\\ Support/XPLANESC/f.txt',
    '- Read **/Users/victim/XPLANBOLD/f.md** and @/Users/victim/XPLANAT/g.md',
    '- Open file:///Users/victim/Mobile Documents/XPLANFILE/x.txt and //server/share/XPLANUNC/y.txt',
    '- Mail victim.person@corp.example/XPLANMAIL and see github.com/org/XPLANREPO?k=1',
  ].join('\n');
  const items = contents(planFromMarkdown(md));
  assert.deepEqual(items, [
    'Edit open notes.txt now',
    'Edit open budget.xlsx',
    'Edit open f.txt',
    'Read f.md and @g.md',
    'Open x.txt and y.txt',
    'Mail (email) and see github.com',
  ]);
  assert.doesNotMatch(items.join('\n'), /XPLAN|victim|Support|Drive/);
});

test('planFromMarkdown caps each item at 80 code points', () => {
  const long = '가'.repeat(200);
  const [item] = planFromMarkdown(`- ${long}`);
  assert.equal(Array.from(item.content).length, 80);
  assert.ok(item.content.endsWith('…'));
});

test('planFromMarkdown handles CRLF line endings', () => {
  assert.deepEqual(contents(planFromMarkdown('# One\r\n- two\r\n')), ['One', 'two']);
});

test('planFromMarkdown stays fast on a giant single-line item', () => {
  const giant = `- ${'*a '.repeat(40000)}`;
  const t0 = Date.now();
  const [item] = planFromMarkdown(`${giant}\n${'x'.repeat(120000)}`);
  assert.ok(Date.now() - t0 < 5000); // generous: only catches catastrophic backtracking
  assert.ok(Array.from(item.content).length <= 80);
});
