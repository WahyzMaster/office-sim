// SessionCore review fixes (P5b): one regression test per confirmed finding, named after the Claude rule it restores
// (CONTRACT 4.2) or the 4.0.2 contract line. Synthetic items only; no file system, no real agent logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCore, END_TURN_IDLE_MS, SUB_IDLE_MS } from '../src/core/session-core.mjs';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const HOUR = 3_600_000;

function mk(o = {}) {
  const clock = { t: T0 };
  const s = new SessionCore({ id: 'grok-m1', agent: 'grok', kind: 'main', now: () => clock.t, ...o });
  return { s, clock };
}
const sub = (o = {}) => mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1', ...o });
const run = (s, items, opts) => items.flatMap((it) => s.apply(it, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const brief = (evs) => evs.filter((e) => e.type !== 'session')
  .map((e) => [e.type, e.text ?? e.errorKind ?? e.reason ?? (e.type === 'tool_end' ? 'ok' : e.toolUseId)].join(':'));
const read = (id) => ({ k: 'tool_start', id, desc: { tool: 'read_file', kind: 'read', path: `/w/${id}.txt` } });
const ago = (ms) => new Date(T0 + HOUR - ms).toISOString();

// ---- turns (R30) ------------------------------------------------------------------------------------------------

test('R30: work before the first turn_start opens no turn, so that turn_start emits no turn_end', () => {
  for (const first of [{ k: 'thinking', text: 'x' }, { k: 'prompt', text: 'one' }, { k: 'say', text: 'hi' }, read('t0')]) {
    const { s } = mk();
    const evs = run(s, [first, { k: 'turn_start', id: 'p1' }]);
    assert.deepEqual(of(evs, 'turn_end'), [], `${first.k} before turn_start`);
  }
});

test('R30: a prompt never opens or reopens a turn; the next turn_start closes only a turn that was started', () => {
  const { s } = mk();
  const evs = run(s, [
    { k: 'turn_start' }, { k: 'prompt', text: 'one' }, { k: 'say', text: 'Done.', final: true }, { k: 'turn_end', reason: 'end_turn' },
    { k: 'prompt', text: 'two' }, { k: 'turn_start' },
  ]);
  assert.deepEqual(brief(evs), ['prompt:one', 'say:Done.', 'turn_end:end_turn', 'prompt:two']);
});

test('R30: turn_start first (the documented order) gives the Claude order: tool_end abandoned, turn_end next_turn, prompt', () => {
  const { s } = mk();
  const evs = run(s, [
    { k: 'turn_start', id: 'p1' }, { k: 'prompt', text: 'one' }, read('t1'), { k: 'turn_start', id: 'p2' }, { k: 'prompt', text: 'two' },
  ]);
  assert.deepEqual(brief(evs), ['prompt:one', 'tool_start:t1', 'tool_end:abandoned', 'turn_end:next_turn', 'prompt:two']);
});

test('R30: prompt-first input never emits a turn_end for a turn that was not started', () => {
  const { s } = mk();
  const evs = run(s, [
    { k: 'prompt', text: 'one' }, { k: 'turn_start', id: 'p1' }, read('t1'), { k: 'prompt', text: 'two' }, { k: 'turn_start', id: 'p2' },
  ]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['next_turn'], 'only the started turn p1 ends');
  assert.equal(brief(evs)[0], 'prompt:one');
  assert.notEqual(brief(evs)[1], 'turn_end:next_turn');
});

test('R30: after a turn_start, assistant work still reopens a closed turn (id-less turns too)', () => {
  const { s } = mk();
  run(s, [{ k: 'turn_start' }, { k: 'say', text: 'a' }, { k: 'turn_end', reason: 'interrupt' }]);
  run(s, [{ k: 'thinking', text: 'again' }]);
  assert.deepEqual(s.apply({ k: 'turn_end', reason: 'end_turn' }).map((e) => e.reason), ['end_turn']);
});

// ---- system text (R31) ------------------------------------------------------------------------------------------

test('R31: system text is the first line only, reduced like a tool error (payload cut, <= 120)', () => {
  const { s } = mk();
  const evs = of(run(s, [
    { k: 'system', kind: 'api_error', text: 'stream error: disconnected\nBAIT_SECOND_LINE response body {"secret":"BAIT_JSON"}' },
    { k: 'system', kind: 'api_error', text: 'API Error: 500 {"secret":"BAIT_JSON"}' },
    { k: 'system', kind: 'compact', text: '\n  Compacted\nBAIT_COMPACT_LINE2' },
    { k: 'system', kind: 'refusal', text: '{"secret":"BAIT_JSON"}' },
  ]), 'system');
  assert.deepEqual(evs.map((e) => e.text), ['stream error: disconnected', 'API Error: 500', 'Compacted', '응답 거절']);
  assert.ok(!JSON.stringify(evs).includes('BAIT'));
});

// ---- plan source (D5, CONTRACT 2) -------------------------------------------------------------------------------

test('D5: markdown is always exit_plan (<= 6 items), whatever source the item names', () => {
  const md = `# Task\n${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((t) => `- [ ] ${t}`).join('\n')}`;
  for (const source of ['tasks', 'update_plan', 'exit_plan', undefined]) {
    const { s } = mk();
    const [p] = of(s.apply({ k: 'plan', markdown: md, source }), 'plan');
    assert.equal(p.source, 'exit_plan', String(source));
    assert.ok(p.items.length <= 6);
  }
});

test('D5: an items list is update_plan or tasks, never exit_plan, and keeps every item with its status', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ content: `step ${i}`, status: i < 2 ? 'completed' : 'pending' }));
  const { s } = mk();
  const [a] = of(s.apply({ k: 'plan', items, source: 'exit_plan' }), 'plan');
  assert.equal(a.source, 'update_plan');
  assert.equal(a.items.length, 9);
  assert.deepEqual(a.items.slice(0, 3).map((it) => it.status), ['completed', 'completed', 'pending']);
  const [b] = of(s.apply({ k: 'plan', items, source: 'tasks' }), 'plan');
  assert.equal(b.source, 'tasks');
});

// ---- plan-kind tools (R35) --------------------------------------------------------------------------------------

test('R35: a plan-kind tool shows its plan at a successful tool_end, not at the start', () => {
  const { s } = mk();
  const start = s.apply({ k: 'tool_start', id: 'u1', desc: { tool: 'update_plan', kind: 'plan' }, items: [{ content: 'A', status: 'pending' }] });
  assert.deepEqual(of(start, 'plan'), []);
  assert.deepEqual(of(s.snapshotEvents(), 'plan'), [], 'a pending plan call is not on the board');
  const [p] = of(s.apply({ k: 'tool_end', id: 'u1' }), 'plan');
  assert.deepEqual(p.items, [{ content: 'A', status: 'pending' }]);
  assert.deepEqual(of(s.apply({ k: 'tool_start', id: 'u2', kind: 'plan', items: [{ content: 'B' }] }), 'plan'), []);
  assert.equal(of(s.apply({ k: 'tool_end', id: 'u2', status: 'ok', background: true }), 'plan').length, 1);
});

test('R35: a failed, denied, interrupted or abandoned plan call leaves the board as it was', () => {
  const { s } = mk();
  run(s, [{ k: 'turn_start', id: 'p1' }, { k: 'plan', items: [{ content: 'Keep', status: 'in_progress' }] }]);
  for (const status of ['failed', 'denied', 'interrupted']) {
    const evs = run(s, [
      { k: 'tool_start', id: `u-${status}`, desc: { tool: 'update_plan', kind: 'plan' }, items: [{ content: 'Wrong' }] },
      { k: 'tool_end', id: `u-${status}`, status },
    ]);
    assert.deepEqual(of(evs, 'plan').concat(of(evs, 'tool_end')), [], status);
  }
  run(s, [{ k: 'tool_start', id: 'u-open', kind: 'plan', items: [{ content: 'Wrong' }] }]);
  assert.deepEqual(of(s.apply({ k: 'turn_end', reason: 'interrupt' }), 'plan'), []);
  assert.deepEqual(of(s.snapshotEvents(), 'plan')[0].items, [{ content: 'Keep', status: 'in_progress' }]);
});

test('R35/R36: every successful update_plan emits, also an identical list; identical tasks snapshots emit once', () => {
  const { s } = mk();
  const list = [{ content: 'A', status: 'pending' }];
  assert.equal(of(run(s, [{ k: 'plan', items: list }, { k: 'plan', items: list }]), 'plan').length, 2);
  assert.equal(of(run(s, [
    { k: 'tool_start', id: 'u1', kind: 'plan', items: list }, { k: 'tool_end', id: 'u1' },
    { k: 'tool_start', id: 'u2', kind: 'plan', items: list }, { k: 'tool_end', id: 'u2' },
  ]), 'plan').length, 2);
  assert.equal(of(run(s, [{ k: 'plan', items: list, source: 'tasks' }, { k: 'plan', items: list, source: 'tasks' }]), 'plan').length, 1);
});

// ---- replay growth (R29 idle) -----------------------------------------------------------------------------------

test('R29 replay: a ts-less item adds no growth, so an old sub with one still ends at the first idle() after attach', () => {
  for (const extra of [{ k: 'meta', title: 'Helper' }, { k: 'tool_end' }]) {
    const { s, clock } = sub();
    clock.t = T0 + HOUR;
    run(s, [extra, { k: 'say', text: 'old', ts: ago(HOUR) }, read('t1'), { k: 'tool_end', id: 't1', ts: ago(HOUR - 1000) }], { replay: true });
    assert.deepEqual(s.idle(clock.t).map((e) => [e.type, e.reason]), [['session_end', 'idle']], JSON.stringify(extra));
    assert.equal(s.ended, true);
  }
});

test('R30 replay: a ts-less item does not keep an old finished turn open past attach', () => {
  const { s, clock } = mk();
  clock.t = T0 + HOUR;
  run(s, [
    { k: 'meta', cwd: '/w/r' }, { k: 'turn_start', id: 'p1', ts: ago(HOUR) }, { k: 'say', text: 'Done.', final: true, ts: ago(HOUR) },
  ], { replay: true });
  assert.deepEqual(s.idle(clock.t).map((e) => [e.type, e.reason]), [['turn_end', 'end_turn']]);
  assert.equal(s.debugState().turnOpen, false);
});

test('R29 replay: a file with no timestamps at all counts from the first idle(); a sub with no items never idles', () => {
  const { s, clock } = sub();
  clock.t = T0 + HOUR;
  run(s, [{ k: 'say', text: 'no ts' }], { replay: true });
  assert.deepEqual(s.idle(clock.t + 1000), []);
  assert.deepEqual(s.idle(clock.t + 1000 + SUB_IDLE_MS).map((e) => e.type), ['session_end']);
  const empty = sub().s;
  assert.deepEqual(empty.idle(T0 + SUB_IDLE_MS * 10), []);
  assert.equal(empty.ended, false);
});

// ---- revive (R29) -----------------------------------------------------------------------------------------------

test('R29: a malformed work item never revives an ended sub (counted in skipped, no event)', () => {
  const bad = [{ k: 'tool_start' }, { k: 'tool_start', id: {} }, { k: 'tool_start', id: 'x'.repeat(300) }, { k: 'prompt', text: 42 }, { k: 'prompt', text: null }];
  for (const it of bad) {
    const { s, clock } = sub();
    run(s, [{ k: 'say', text: 'first' }]);
    assert.equal(s.idle(clock.t + SUB_IDLE_MS).length, 1);
    const before = s.skipped;
    assert.deepEqual(s.apply(it), [], JSON.stringify(it));
    assert.equal(s.ended, true);
    assert.equal(s.skipped, before + 1);
    assert.deepEqual(s.snapshotEvents(), []);
  }
});

test('R29: valid work revives an ended sub with the session event first (tool_start, prompt, turn_start)', () => {
  for (const it of [read('t2'), { k: 'prompt', text: 'more work' }, { k: 'turn_start', id: 'x2' }]) {
    const { s, clock } = sub();
    run(s, [{ k: 'say', text: 'first' }]);
    s.idle(clock.t + SUB_IDLE_MS);
    const back = s.apply(it);
    assert.equal(back[0]?.type, 'session', it.k);
    assert.equal(s.ended, false);
  }
});

// ---- background (R28) -------------------------------------------------------------------------------------------

test('R28: background never overrides an explicit failed, denied or interrupted status', () => {
  const { s } = mk();
  run(s, ['a', 'b', 'c', 'd', 'e'].map((id) => ({ k: 'tool_start', id, desc: { tool: 'run', kind: 'shell', command: 'npm run dev', background: true } })));
  const ends = of(run(s, [
    { k: 'tool_end', id: 'a', status: 'denied', errorLine: 'Permission to use Bash with command npm run dev', background: true },
    { k: 'tool_end', id: 'b', status: 'failed', errorLine: 'spawn failed', background: true },
    { k: 'tool_end', id: 'c', status: 'interrupted', background: 'true' },
    { k: 'tool_end', id: 'd', background: true },
    { k: 'tool_end', id: 'e', status: 'ok', background: true },
  ]), 'tool_end');
  assert.deepEqual(ends.map((e) => [e.ok, e.errorKind ?? null]),
    [[false, 'denied'], [false, 'failed'], [false, 'interrupted'], [true, null], [true, null]]);
  assert.equal(ends[0].error, 'Permission to use Bash has been denied.');
});

// ---- injected prompts (R17-R19, section 5) ----------------------------------------------------------------------

test('prompt: injected text starting with < is skipped even behind invisible or control characters', () => {
  const prefixes = ['​', '\u0000', '\u001b[0m', '⁠', '­', '﻿', '‎', '͏', '᠎', '  '];
  for (const p of prefixes) {
    const { s } = mk();
    const evs = run(s, [{ k: 'turn_start' }, { k: 'prompt', text: `${p}<system-reminder>BAIT_INJECT</system-reminder>` }]);
    assert.deepEqual(of(evs, 'prompt'), [], JSON.stringify(p));
    assert.ok(!JSON.stringify([evs, s.snapshotEvents(), s.title]).includes('BAIT_INJECT'), JSON.stringify(p));
  }
  const { s } = mk();
  assert.deepEqual(of(s.apply({ k: 'prompt', text: '​Fix the login bug' }), 'prompt').map((e) => e.text), ['Fix the login bug']);
});

test('constants: END_TURN_IDLE_MS and SUB_IDLE_MS are re-exported from session.mjs', () => {
  assert.ok(END_TURN_IDLE_MS > 0 && SUB_IDLE_MS > END_TURN_IDLE_MS);
});

// ---- tool_end status abandoned (R27, mid-turn) ------------------------------------------------------------------

test('R27: tool_end status abandoned closes one tool mid-turn with the R27 shape, ignores errorLine, keeps the turn open', () => {
  const { s } = mk();
  const evs = run(s, [
    { k: 'turn_start', id: 'p1' }, read('t1'), read('t2'),
    { k: 'tool_end', id: 't1', status: 'abandoned', errorLine: '/Users/bait-user/secret.txt leaked' },
  ]);
  const ends = of(evs, 'tool_end');
  assert.deepEqual(ends.map(({ toolUseId, ok, errorKind, error }) => ({ toolUseId, ok, errorKind, error })),
    [{ toolUseId: 't1', ok: false, errorKind: 'abandoned', error: 'no result' }]);
  assert.equal(of(evs, 'turn_end').length, 0, 'closing one tool does not end the turn');
  const open = s.snapshotEvents().filter((e) => e.type === 'tool_start').map((e) => e.toolUseId);
  assert.deepEqual(open, ['t2'], 'the other tool stays open');
  assert.ok(!JSON.stringify(evs).includes('bait-user'));
});
