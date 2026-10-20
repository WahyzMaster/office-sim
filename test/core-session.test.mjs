// SessionCore (src/core/session-core.mjs): normalized items (ADAPTERS 3.2) -> events (CONTRACT 2), rules mirrored from
// the Claude SessionState (CONTRACT 4.2). Synthetic items only; no file system, no real agent logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCore, END_TURN_IDLE_MS, SUB_IDLE_MS } from '../src/core/session-core.mjs';
import { ZERO_UUID } from '../src/summarize.mjs';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');

function mk(o = {}) {
  const clock = { t: T0 };
  const s = new SessionCore({ id: 'grok-m1', agent: 'grok', kind: 'main', now: () => clock.t, ...o });
  return { s, clock };
}
const run = (s, items, opts) => items.flatMap((it) => s.apply(it, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const types = (evs) => evs.map((e) => e.type);
const cps = (t) => Array.from(t).length;

test('session: the first item emits the session event first, with the core agent and the D2 id', () => {
  const { s } = mk({ id: 'grok-0198abcdef' });
  const evs = run(s, [{ k: 'say', text: 'Hello.' }]);
  assert.deepEqual(types(evs), ['session', 'say']);
  assert.equal(evs[0].sessionId, 'grok-0198abcdef');
  assert.equal(evs[0].agent, 'grok');
  assert.equal(evs[0].isSubagent, false);
  assert.equal(evs[0].parentSessionId, null);
  assert.equal(evs[0].title, '0198abcd', 'fallback title: 8 chars after the adapter prefix');
});

test('meta: title/cwd/branch/project via projectKey and the worktree rule; session re-emitted only when it changed', () => {
  const { s } = mk();
  const [ev] = run(s, [{ k: 'meta', cwd: '/work/repo/.worktrees/feat-x', branch: 'HEAD', title: 'Fix login', model: 'm-1' }]);
  assert.deepEqual([ev.project, ev.projectLabel, ev.worktree, ev.branch, ev.title], ['/work/repo', 'repo', 'feat-x', 'detached', 'Fix login']);
  assert.deepEqual(run(s, [{ k: 'meta', cwd: '/work/repo/.worktrees/feat-x', model: 'm-2' }]), [], 'nothing changed (model is not a field)');
  const [moved] = run(s, [{ k: 'meta', cwd: '/elsewhere', branch: 'main' }]);
  assert.deepEqual([moved.project, moved.worktree, moved.branch], ['/work/repo', null, 'main'], 'the floor stays on the first cwd');
  assert.equal(s.firstCwd, '/work/repo/.worktrees/feat-x');
});

test('meta parentId: a sub takes only an id of its own agent (D2)', () => {
  const { s } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'codex-x' });
  assert.equal(s.sessionEvent().parentSessionId, null, 'a foreign constructor parent is dropped');
  run(s, [{ k: 'meta', parentId: 'codex-p9' }]);
  assert.equal(s.sessionEvent().parentSessionId, null);
  const [ev] = run(s, [{ k: 'meta', parentId: 'grok-m1', agentType: 'explorer', title: 'Helper' }]);
  assert.deepEqual([ev.isSubagent, ev.parentSessionId, ev.agentType, ev.title], [true, 'grok-m1', 'explorer', 'Helper']);
});

test('dedupe key: a repeated key yields nothing and changes no state', () => {
  const { s } = mk();
  run(s, [{ k: 'tool_start', key: 7, id: 't1', desc: { tool: 'read_file', kind: 'read', path: '/a/b.txt' } }]);
  assert.deepEqual(s.apply({ k: 'tool_end', key: 7, id: 't1' }), []);
  assert.deepEqual(s.debugState().open, [{ id: 't1', ignored: false }]);
  assert.deepEqual(s.apply({ k: 'say', key: 'line-9', text: 'one' }).map((e) => e.text), ['one']);
  assert.deepEqual(s.apply({ k: 'say', key: 'line-9', text: 'two' }), []);
});

test('prompt: scrubbed and capped at 80, text starting with < skipped (R17-R19), first prompt is the title (<= 40)', () => {
  const { s } = mk();
  const long = `Please fix /Users/bait-user/proj/app.js and mail bait.person@example.com ${'x'.repeat(200)}`;
  const evs = run(s, [{ k: 'prompt', text: '<environment_context>cwd</environment_context>' }, { k: 'prompt', text: long }]);
  const [p] = of(evs, 'prompt');
  assert.equal(of(evs, 'prompt').length, 1);
  assert.ok(cps(p.text) <= 80);
  assert.ok(p.text.startsWith('Please fix app.js and mail (email)'));
  assert.ok(!JSON.stringify(evs).includes('bait-user') && !JSON.stringify(evs).includes('example.com'));
  assert.ok(cps(s.title) <= 40 && s.title.startsWith('Please fix app.js'));
});

test('prompt in a sub: never emitted and never a title (the parent task, section 5)', () => {
  const { s } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
  const evs = run(s, [{ k: 'prompt', text: 'Secret task text for the helper' }]);
  assert.deepEqual(of(evs, 'prompt'), []);
  assert.equal(s.title, 'grok-c1');
});

test('say: scrubbed, <= 100; an empty say emits nothing', () => {
  const { s } = mk();
  const evs = run(s, [{ k: 'say', text: `See https://bait.example.com/cb?token=bait-secret ${'y'.repeat(300)}` }, { k: 'say', text: '   ' }]);
  const says = of(evs, 'say');
  assert.equal(says.length, 1);
  assert.ok(cps(says[0].text) <= 100);
  assert.ok(says[0].text.startsWith('See bait.example.com'));
  assert.ok(!says[0].text.includes('token'));
});

test('thinking: first sentence <= 100, null without text, durationMs a number or null', () => {
  const { s } = mk();
  const evs = of(run(s, [
    { k: 'thinking', text: 'Check the config first. BAIT_SECOND_SENTENCE', durationMs: 1500 },
    { k: 'thinking', text: null },
    { k: 'thinking', text: 'z'.repeat(400), durationMs: -3 },
  ]), 'thinking');
  assert.deepEqual(evs.map((e) => [e.text, e.durationMs]).slice(0, 2), [['Check the config first.', 1500], [null, null]]);
  assert.ok(cps(evs[2].text) <= 100);
  assert.equal(evs[2].durationMs, null);
});

test('tool_start via tool-summary: public name, summary, room, background; never the raw input', () => {
  const { s } = mk();
  const evs = of(run(s, [
    { k: 'tool_start', id: 't1', desc: { tool: 'run_terminal_command', kind: 'shell', command: 'rm -rf /Users/bait-user/x', background: true } },
    { k: 'tool_start', id: 't2', tool: 'use_tool', kind: 'web', desc: { mcpServer: '3f2a9c4e-1b7d-4e8a-9c3f-5d6e7f8a9b0c', mcpTool: 'get_issue' } },
    { k: 'tool_start', id: 't3', tool: 'write', kind: 'edit', desc: { patch: '*** Update File: src/a.js\n+BAIT_PATCH_BODY' } },
  ]), 'tool_start');
  assert.deepEqual(evs.map((e) => [e.toolUseId, e.tool, e.summary, e.room ?? null, e.background ?? null]), [
    ['t1', 'run_terminal_command', 'rm', 'server', true],
    ['t2', `mcp__${ZERO_UUID}__get_issue`, 'get issue', null, null],
    ['t3', 'write', 'a.js', 'dev', null],
  ]);
  const text = JSON.stringify(evs);
  for (const bait of ['rm -rf', 'bait-user', '3f2a9c4e', 'BAIT_PATCH_BODY', '"command"', '"patch"', '"desc"']) assert.ok(!text.includes(bait), bait);
});

test('tool_start precedence: desc wins over the item tool/kind, which fill gaps; an unknown kind is other (room here)', () => {
  const { s } = mk();
  const evs = of(run(s, [
    { k: 'tool_start', id: 'a', tool: 'item_name', kind: 'shell', desc: { tool: 'read_file', kind: 'read', path: '/p/q.txt' } },
    { k: 'tool_start', id: 'b', tool: 'grep', kind: 'search', desc: { query: 'needle' } },
    { k: 'tool_start', id: 'c', tool: 'mystery', kind: 'teleport' },
    { k: 'tool_start', id: 'd', tool: 'spawn_subagent', kind: 'agent', desc: { description: 'Explore the repo' } },
  ]), 'tool_start');
  assert.deepEqual(evs.map((e) => [e.tool, e.summary, e.room]), [
    ['read_file', 'q.txt', 'archive'], ['grep', 'needle', 'archive'], ['mystery', 'mystery', 'here'], ['spawn_subagent', 'Explore the repo', 'here'],
  ]);
});

test('tool_end without a status is ok (the adapter default)', () => {
  const { s } = mk();
  run(s, [{ k: 'tool_start', id: 't1', desc: { tool: 'read_file', kind: 'read', path: 'a' } }]);
  const [end] = of(s.apply({ k: 'tool_end', id: 't1', errorLine: 'not shown' }), 'tool_end');
  assert.deepEqual([end.ok, 'error' in end], [true, false]);
});

test('tool pairing (R9/R16): unknown tool_end ids are ignored; a second start for an open or closed id is ignored', () => {
  const { s } = mk();
  run(s, [{ k: 'say', text: 'go' }]);
  assert.deepEqual(s.apply({ k: 'tool_end', id: 'nope' }), []);
  assert.equal(of(s.apply({ k: 'tool_start', id: 't1', desc: { tool: 'grep', kind: 'search', query: 'x' } }), 'tool_start').length, 1);
  assert.deepEqual(s.apply({ k: 'tool_start', id: 't1', desc: { tool: 'other', kind: 'other' } }), []);
  assert.equal(of(s.apply({ k: 'tool_end', id: 't1' }), 'tool_end').length, 1);
  assert.deepEqual(s.apply({ k: 'tool_end', id: 't1' }), [], 'already closed');
  assert.deepEqual(s.apply({ k: 'tool_start', id: 't1', desc: { tool: 'grep', kind: 'search' } }), [], 'never reopened');
  assert.equal(s.skipped, 0);
});

test('tool_end status: ok, failed, denied, interrupted; error = first line, scrubbed, <= 120, fallback by kind', () => {
  const { s } = mk();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  run(s, ids.map((id) => ({ k: 'tool_start', id, desc: { tool: 'shell', kind: 'shell', command: 'make' } })));
  const ends = of(run(s, [
    { k: 'tool_end', id: 'a', status: 'ok', errorLine: 'ignored' },
    { k: 'tool_end', id: 'b', status: 'failed', errorLine: '\n  Error at /Users/bait-user/p/x.js: {"secret":"BAIT_JSON"}\nBAIT_RESULT_BODY' },
    { k: 'tool_end', id: 'c', status: 'denied' },
    { k: 'tool_end', id: 'd', status: 'interrupted', errorLine: 'w'.repeat(500) },
    { k: 'tool_end', id: 'e', status: 'exploded' },
  ]), 'tool_end');
  assert.deepEqual(ends[0], { ...ends[0], ok: true });
  assert.ok(!('errorKind' in ends[0]) && !('error' in ends[0]));
  assert.deepEqual([ends[1].errorKind, ends[1].error], ['failed', 'Error at x.js']);
  assert.deepEqual([ends[2].errorKind, ends[2].error], ['denied', 'denied']);
  assert.equal(ends[3].errorKind, 'interrupted');
  assert.ok(cps(ends[3].error) <= 120);
  assert.deepEqual([ends[4].errorKind, ends[4].error], ['failed', 'failed'], 'an unknown status is a failure');
  assert.ok(!JSON.stringify(ends).includes('BAIT'));
});

test('tool_end background (R28): the launch is ok and the event has no background field', () => {
  const { s } = mk();
  run(s, [{ k: 'tool_start', id: 'bg', desc: { tool: 'run', kind: 'shell', command: 'npm run dev', background: true } }]);
  const [end] = of(s.apply({ k: 'tool_end', id: 'bg', background: 'true' }), 'tool_end');
  assert.deepEqual(Object.keys(end).sort(), ['ok', 'sessionId', 'toolUseId', 'ts', 'type']);
  assert.equal(end.ok, true);
});

test('kind plan (R35): no tool_start; a plan carried by the start becomes a plan event at its ok tool_end, no tool_end', () => {
  const { s } = mk();
  const evs = run(s, [{ k: 'tool_start', id: 'p1', desc: { tool: 'todo_write', kind: 'plan' }, items: [{ content: 'Step A', status: 'in_progress' }] }]);
  assert.deepEqual(types(evs), ['session']);
  const end = s.apply({ k: 'tool_end', id: 'p1' });
  assert.deepEqual(types(end), ['plan']);
  assert.equal(end[0].source, 'update_plan');
  assert.deepEqual(run(s, [{ k: 'tool_start', id: 'p2', kind: 'plan', tool: 'update_plan' }, { k: 'tool_end', id: 'p2' }]), []);
});

test('kind ask (R33): tool_start with question <= 160 and options <= 4 x 30; the questions shape adds (+N)', () => {
  const { s } = mk();
  const [a] = of(s.apply({
    k: 'tool_start', id: 'q1', desc: { tool: 'ask_user_question', kind: 'ask' },
    question: `Which one? ${'q'.repeat(300)}`, options: ['A', { label: 'B' }, 'c'.repeat(90), '', 'D', 'E'],
  }), 'tool_start');
  assert.equal(a.room, 'desk');
  assert.ok(cps(a.question) <= 160);
  assert.equal(a.options.length, 3, 'the first 4 options, empty labels dropped');
  assert.ok(a.options.every((o) => cps(o) <= 30));
  const [b] = of(s.apply({
    k: 'tool_start', id: 'q2', desc: { tool: 'request_user_input', kind: 'ask' },
    questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }, { question: 'Second?' }],
  }), 'tool_start');
  assert.deepEqual([b.question, b.options], ['Deploy now? (+1)', ['Yes', 'No']]);
  const [c] = of(s.apply({ k: 'tool_start', id: 'q3', desc: { tool: 'ask', kind: 'ask' } }), 'tool_start');
  assert.deepEqual([c.question, c.options], [null, []]);
});

test('turn_start closes the previous open turn: open tools tool_end abandoned, then turn_end next_turn (R27/R30)', () => {
  const { s } = mk();
  run(s, [{ k: 'turn_start', id: 'p1' }, { k: 'tool_start', id: 't1', desc: { tool: 'grep', kind: 'search' } }]);
  const evs = s.apply({ k: 'turn_start', id: 'p2' });
  assert.deepEqual(evs.map((e) => [e.type, e.errorKind ?? e.reason]), [['tool_end', 'abandoned'], ['turn_end', 'next_turn']]);
  assert.equal(evs[0].error, 'no result');
  assert.deepEqual(s.apply({ k: 'turn_start', id: 'p2' }), [], 'the same turn id is the same turn');
});

test('turn_end closes open tools as abandoned first; unknown reason -> end_turn; a second turn_end emits nothing', () => {
  const { s } = mk();
  run(s, [{ k: 'turn_start' }, { k: 'tool_start', id: 't1', desc: { tool: 'read', kind: 'read', path: 'a' } }]);
  const evs = s.apply({ k: 'turn_end', reason: 'interrupt' });
  assert.deepEqual(evs.map((e) => [e.type, e.errorKind ?? e.reason]), [['tool_end', 'abandoned'], ['turn_end', 'interrupt']]);
  assert.deepEqual(s.apply({ k: 'turn_end', reason: 'end_turn' }), []);
  run(s, [{ k: 'say', text: 'more' }]); // work reopens the turn
  assert.deepEqual(s.apply({ k: 'turn_end', reason: 'cancelled' }).map((e) => e.reason), ['end_turn']);
});

test('say final arms end_turn (R30): idle() fires turn_end end_turn once after END_TURN_IDLE_MS; new work disarms', () => {
  const { s, clock } = mk();
  run(s, [{ k: 'turn_start', id: 'p1' }, { k: 'say', text: 'All done.', final: true }]);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS - 1), []);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS).map((e) => [e.type, e.reason]), [['turn_end', 'end_turn']]);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS * 3), [], 'once');
  run(s, [{ k: 'turn_start', id: 'p2' }, { k: 'say', text: 'Thinking aloud', final: true }]);
  clock.t += 1000;
  run(s, [{ k: 'tool_start', id: 't9', desc: { tool: 'grep', kind: 'search' } }]);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS * 2), [], 'a tool after the final say disarmed it');
});

test('subs (R29/R30): no turn_end events; idle out after SUB_IDLE_MS of quiet with no open tools', () => {
  const { s, clock } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
  run(s, [{ k: 'turn_start', id: 'x' }, { k: 'tool_start', id: 't1', desc: { tool: 'grep', kind: 'search' } }]);
  assert.deepEqual(s.idle(clock.t + SUB_IDLE_MS * 2), [], 'an open tool keeps the sub alive');
  const closed = run(s, [{ k: 'turn_end', reason: 'end_turn' }]);
  assert.deepEqual(types(closed), ['tool_end'], 'the tool is abandoned, no turn_end for a sub');
  assert.deepEqual(s.idle(clock.t + SUB_IDLE_MS - 1), []);
  const end = s.idle(clock.t + SUB_IDLE_MS);
  assert.deepEqual(end.map((e) => [e.type, e.reason]), [['session_end', 'idle']]);
  assert.equal(s.ended, true);
  assert.deepEqual(s.snapshotEvents(), []);
  assert.deepEqual(s.idle(clock.t + SUB_IDLE_MS * 5), []);
  const main = mk().s;
  run(main, [{ k: 'say', text: 'x' }]);
  assert.deepEqual(main.idle(T0 + SUB_IDLE_MS * 10), [], 'a main never idles out by itself');
});

test('an ended sub comes back on new work (re-announced), and stays quiet on anything else', () => {
  const { s, clock } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
  run(s, [{ k: 'say', text: 'first' }]);
  s.idle(clock.t + SUB_IDLE_MS);
  assert.deepEqual(s.apply({ k: 'say', text: 'late chatter' }), []);
  const back = s.apply({ k: 'tool_start', id: 't2', desc: { tool: 'read_file', kind: 'read', path: '/x/y.md' } });
  assert.deepEqual(types(back), ['session', 'tool_start']);
  assert.equal(s.ended, false);
});

test('plan: a full list replaces the board, markdown -> planFromMarkdown (exit_plan), source per D5, every call emits', () => {
  const { s } = mk();
  const first = of(run(s, [{ k: 'plan', items: [{ content: 'Read /Users/bait-user/notes.md', status: 'completed' }, { step: 'Write', status: 'odd' }, 'Ship'] }]), 'plan');
  assert.deepEqual(first[0].items, [
    { content: 'Read notes.md', status: 'completed' }, { content: 'Write', status: 'pending' }, { content: 'Ship', status: 'pending' }]);
  assert.equal(first[0].source, 'update_plan');
  assert.equal(of(s.apply({ k: 'plan', items: [{ content: 'Read /Users/bait-user/notes.md', status: 'completed' }, { step: 'Write', status: 'odd' }, 'Ship'] }), 'plan').length, 1, 'R35: an identical update_plan list emits again');
  const [md] = of(s.apply({ k: 'plan', markdown: '# Plan\n```\nBAIT_FENCE\n```\n- one\n- two\n- three\n- four\n- five\n- six\n- seven' }), 'plan');
  assert.equal(md.source, 'exit_plan');
  assert.equal(md.items.length, 6);
  assert.ok(!JSON.stringify(md).includes('BAIT_FENCE'));
  const [tasks] = of(s.apply({ k: 'plan', items: [{ content: 'z'.repeat(200), status: 'in_progress' }], source: 'tasks' }), 'plan');
  assert.equal(tasks.source, 'tasks');
  assert.ok(cps(tasks.items[0].content) <= 80);
  assert.deepEqual(of(s.apply({ k: 'plan', items: [], source: 'bogus' }), 'plan').map((e) => [e.items, e.source]), [[[], 'update_plan']]);
  assert.deepEqual(s.apply({ k: 'plan', markdown: 'no list here' }), []);
});

test('sub_end: returns a hint item { hint: end, charId } (CONTRACT 4.0.1); foreign or own ids are malformed', () => {
  const { s } = mk();
  run(s, [{ k: 'say', text: 'x' }]);
  assert.deepEqual(s.apply({ k: 'sub_end', childId: 'grok-c1' }), [{ hint: 'end', charId: 'grok-c1' }]);
  assert.deepEqual(s.apply({ k: 'sub_end', childId: 'grok-c2', reason: 'idle' }), [{ hint: 'end', charId: 'grok-c2', reason: 'idle' }]);
  assert.deepEqual(s.apply({ k: 'sub_end', childId: 'grok-c3', reason: 'weird' }), [{ hint: 'end', charId: 'grok-c3' }]);
  for (const childId of ['codex-c1', 'grok-m1', 'grok-bad id', undefined]) assert.deepEqual(s.apply({ k: 'sub_end', childId }), []);
  assert.equal(s.skipped, 4);
});

test('replay: the same state as live, and only hint items are returned', () => {
  const items = [
    { k: 'meta', cwd: '/work/r', title: 'R' }, { k: 'turn_start', id: 'p1' }, { k: 'prompt', text: 'go' },
    { k: 'plan', items: [{ content: 'A', status: 'in_progress' }] },
    { k: 'tool_start', id: 't1', desc: { tool: 'grep', kind: 'search', query: 'q' } }, { k: 'tool_end', id: 't1' },
    { k: 'tool_start', id: 'q1', desc: { tool: 'ask', kind: 'ask' }, question: 'Ok?', options: ['y', 'n'] },
    { k: 'sub_end', childId: 'grok-c1' },
  ];
  const live = mk().s;
  const replayed = mk().s;
  run(live, items);
  const out = run(replayed, items, { replay: true });
  assert.deepEqual(out, [{ hint: 'end', charId: 'grok-c1' }]);
  assert.deepEqual(replayed.snapshotEvents(), live.snapshotEvents());
  assert.deepEqual(replayed.debugState(), live.debugState());
});

test('snapshotEvents: session, current plan, open tool_starts (asks with question/options), nothing that ended', () => {
  const { s } = mk();
  run(s, [
    { k: 'plan', items: [{ content: 'A', status: 'pending' }] },
    { k: 'tool_start', id: 'done', desc: { tool: 'grep', kind: 'search' } }, { k: 'tool_end', id: 'done' },
    { k: 'tool_start', id: 'open', desc: { tool: 'read_file', kind: 'read', path: 'a.txt' } },
    { k: 'tool_start', id: 'ask', desc: { tool: 'ask', kind: 'ask' }, question: 'Proceed?', options: ['Yes', 'No'] },
  ]);
  const snap = s.snapshotEvents();
  assert.deepEqual(snap.map((e) => e.type), ['session', 'plan', 'tool_start', 'tool_start']);
  assert.deepEqual(snap.slice(2).map((e) => e.toolUseId), ['open', 'ask']);
  assert.deepEqual([snap[3].question, snap[3].options], ['Proceed?', ['Yes', 'No']]);
  snap[3].options.push('mutated');
  assert.deepEqual(s.snapshotEvents()[3].options, ['Yes', 'No'], 'copies');
});

test('system: api_error / compact / refusal, text scrubbed <= 120; an unknown kind is skipped', () => {
  const { s } = mk();
  const evs = of(run(s, [
    { k: 'system', kind: 'api_error', text: `Retry 2/5 from https://api.bait.example.com/v1?key=BAIT_KEY ${'e'.repeat(300)}` },
    { k: 'system', kind: 'compact' }, { k: 'system', kind: 'refusal', text: '' }, { k: 'system', kind: 'noise', text: 'x' },
  ]), 'system');
  assert.deepEqual(evs.map((e) => e.kind), ['api_error', 'compact', 'refusal']);
  assert.ok(cps(evs[0].text) <= 120 && !evs[0].text.includes('BAIT_KEY'));
  assert.deepEqual(evs.slice(1).map((e) => e.text), ['Conversation compacted', '응답 거절']);
  assert.equal(s.skipped, 1);
});

test('setInfo: the Store parentProject and a sidecar title apply; subMeta/journalLabel never wipe the title', () => {
  const { s } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
  run(s, [{ k: 'meta', cwd: '/work/repo/sub-dir', title: 'Helper' }]);
  const evs = s.setInfo({ subMeta: null, journalLabel: null, parentId: 'grok-m1', parentProject: '/work/repo' });
  assert.deepEqual(evs.map((e) => [e.title, e.project, e.parentSessionId]), [['Helper', '/work/repo', 'grok-m1']]);
  assert.deepEqual(s.setInfo({ parentProject: '/work/repo' }), [], 'no change, no event');
  const main = mk().s;
  assert.equal(main.setInfo({ title: 'From sidecar', branch: 'dev' })[0].title, 'From sidecar');
  assert.deepEqual(main.setInfo(null), []);
});

test('replay growth: item ts drives the clock, so an old sub idles out at the first idle() after attach', () => {
  const { s, clock } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
  clock.t = T0 + 3_600_000;
  run(s, [{ k: 'say', text: 'old', ts: '2026-10-20T10:00:00Z' }], { replay: true });
  assert.equal(s.lastActivityMs, T0);
  assert.deepEqual(s.idle(clock.t).map((e) => e.type), ['session_end']);
  const fresh = mk({ id: 'grok-c2', kind: 'sub', parentId: 'grok-m1' });
  fresh.clock.t = T0 + 3_600_000;
  run(fresh.s, [{ k: 'say', text: 'no ts' }], { replay: true });
  assert.deepEqual(fresh.s.idle(fresh.clock.t + 1000), [], 'without a ts the replayed item counts from now');
});

test('ts: an item ts becomes ISO on its events; a junk ts string never reaches an event', () => {
  const { s } = mk();
  const [a] = of(run(s, [{ k: 'say', text: 'a', ts: '2026-10-20T10:00:05+00:00' }]), 'say');
  assert.equal(a.ts, '2026-10-20T10:00:05.000Z');
  const [b] = of(run(s, [{ k: 'say', text: 'b', ts: 'BAIT /Users/bait-user/x' }]), 'say');
  assert.equal(b.ts, '2026-10-20T10:00:05.000Z', 'falls back to the last good ts');
  const [c] = of(run(s, [{ k: 'say', text: 'c', ts: T0 + 9000 }]), 'say');
  assert.equal(c.ts, '2026-10-20T10:00:09.000Z');
});

test('malformed items never throw: they are counted in skipped and change nothing', () => {
  const { s } = mk();
  const bad = [
    null, 42, 'say', [], {}, { k: 'nope' }, { k: 'toString' }, { k: 'tool_start' }, { k: 'tool_end', id: {} },
    { k: 'plan' }, { k: 'say', text: 5 }, { k: 'prompt', text: null }, { k: 'tool_start', id: 'x'.repeat(300) },
    { k: 'say', get text() { throw new Error('boom'); } },
  ];
  for (const it of bad) assert.doesNotThrow(() => s.apply(it));
  assert.equal(s.skipped, bad.length);
  assert.deepEqual(s.debugState().open, []);
  assert.doesNotThrow(() => s.idle(NaN));
  assert.doesNotThrow(() => new SessionCore().snapshotEvents());
});
