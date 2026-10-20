// SessionCore item tool_wait (P5g, CONTRACT 2 / 4.0.2): an open, visible, non-ask tool waits on a permission prompt.
// Pure core tests with an injected clock, then one run of the shared conformance harness through the real server with
// the test-only core-fixture adapter. Synthetic items only; temp roots, port 0; no real agent logs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionCore, END_TURN_IDLE_MS, SUB_IDLE_MS } from '../src/core/session-core.mjs';
import { runConformance } from './fixtures/conformance.mjs';
import { coreAdapter, corePaths, writeItems, appendItems } from './fixtures/core-adapter.mjs';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

function mk(o = {}) {
  const clock = { t: T0 };
  const s = new SessionCore({ id: 'grok-m1', agent: 'grok', kind: 'main', now: () => clock.t, ...o });
  return { s, clock };
}
const run = (s, items, opts) => items.flatMap((it) => s.apply(it, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const types = (evs) => evs.map((e) => e.type);
const shell = (id, o = {}) => ({ k: 'tool_start', id, desc: { tool: 'run_terminal_command', kind: 'shell', command: 'npm test' }, ...o });
const wait = (id, waiting, o = {}) => ({ k: 'tool_wait', id, waiting, ...o });

test('tool_wait: waiting:true and then false after its tool_start, exactly the wire fields', () => {
  const { s } = mk();
  run(s, [{ k: 'meta', ts: at(0), title: 'Wait' }, shell('t1', { ts: at(1000) })]);
  const [on] = s.apply(wait('t1', true, { ts: at(2000) }));
  assert.deepEqual(on, { type: 'tool_wait', sessionId: 'grok-m1', ts: at(2000), toolUseId: 't1', waiting: true });
  assert.deepEqual(Object.keys(on), ['type', 'sessionId', 'ts', 'toolUseId', 'waiting']);
  assert.deepEqual(s.debugState().waiting, ['t1']);
  const [off] = s.apply(wait('t1', false, { ts: T0 + 9000 }));
  assert.deepEqual(off, { type: 'tool_wait', sessionId: 'grok-m1', ts: at(9000), toolUseId: 't1', waiting: false });
  assert.deepEqual(s.debugState().waiting, []);
  assert.equal(s.skipped, 0);
});

test('tool_wait: ignored for unknown, closed, plan-kind and ask entries; a malformed item is skipped', () => {
  const { s } = mk();
  run(s, [
    { k: 'meta', title: 'Ignored' },
    shell('done'), { k: 'tool_end', id: 'done' },
    { k: 'tool_start', id: 'p1', desc: { tool: 'todo_write', kind: 'plan' }, items: [{ content: 'a', status: 'pending' }] },
    { k: 'tool_start', id: 'q1', desc: { tool: 'ask_user_question', kind: 'ask' }, question: 'Go?', options: ['Yes', 'No'] },
  ]);
  for (const id of ['nope', 'done', 'p1', 'q1']) {
    assert.deepEqual(s.apply(wait(id, true)), [], `${id}: true is ignored`);
    assert.deepEqual(s.apply(wait(id, false)), [], `${id}: false is ignored`);
  }
  assert.equal(s.skipped, 0, 'ignored is not malformed');
  assert.deepEqual(s.debugState().waiting, []);
  run(s, [shell('t1')]);
  for (const bad of [wait('t1', 'true'), wait('t1', 1), { k: 'tool_wait', id: 't1' }, wait('', true), wait({ x: 1 }, true)]) {
    assert.deepEqual(s.apply(bad), []);
  }
  assert.equal(s.skipped, 5, 'a non-boolean waiting or a bad id counts as malformed');
  assert.equal(of(s.snapshotEvents(), 'tool_wait').length, 0);
});

test('tool_wait: a latch per id (one true ever; false only after it, while the tool is open)', () => {
  const { s } = mk();
  run(s, [{ k: 'meta', title: 'Latch' }, shell('a'), shell('b'), shell('c')]);
  assert.deepEqual(run(s, [wait('a', true), wait('a', true)]).map((e) => e.waiting), [true], 'two trues give one event');
  assert.deepEqual(s.apply(wait('b', false)), [], 'false without an earlier true gives nothing');
  assert.deepEqual(run(s, [wait('b', true), wait('b', false), wait('b', true), wait('b', false)]).map((e) => e.waiting),
    [true, false], 'false then true gives nothing (the latch)');
  assert.deepEqual(run(s, [wait('c', true), { k: 'tool_end', id: 'c', status: 'denied', errorLine: 'denied' }, wait('c', false)])
    .map((e) => [e.type, e.waiting ?? e.errorKind]), [['tool_wait', true], ['tool_end', 'denied']], 'a deny closes it by tool_end');
  assert.deepEqual(s.debugState().waiting, ['a']);
});

test('tool_wait: no growth, no last ts and no turn work', () => {
  const { s, clock } = mk();
  run(s, [{ k: 'turn_start', id: 'p1', ts: at(0) }, shell('t1', { ts: at(1000) }), { k: 'say', text: 'Running it.', final: true, ts: at(2000) }]);
  const before = { growth: s.lastActivityMs, state: s.debugState(), ts: s.sessionEvent().ts };
  clock.t = T0 + 15_000;
  const [ev] = s.apply(wait('t1', true));
  assert.equal(ev.ts, at(2000), 'a ts-less wait takes the last item ts, not the server clock');
  assert.equal(s.lastActivityMs, before.growth, 'lastActivityMs is unchanged');
  assert.equal(s.sessionEvent().ts, before.ts);
  const st = s.debugState();
  assert.deepEqual([st.turnId, st.turnOpen, st.endTurnArmed], [before.state.turnId, before.state.turnOpen, true]);
  // the armed end_turn still fires from the say's growth and abandons the waiting tool (no waiting:false)
  clock.t = before.growth + END_TURN_IDLE_MS;
  const evs = s.idle(clock.t);
  assert.deepEqual(evs.map((e) => [e.type, e.errorKind ?? e.reason]), [['tool_end', 'abandoned'], ['turn_end', 'end_turn']]);
  assert.deepEqual(s.apply(wait('t1', false)), [], 'nothing for a closed tool');
  assert.deepEqual(s.debugState().waiting, []);
});

test('tool_wait: a sub with a waiting tool idles out exactly as before', () => {
  const steps = [
    [0, shell('t1')],
    [60_000, wait('t1', true)],
    [SUB_IDLE_MS + 10_000, 'idle'],
    [SUB_IDLE_MS + 20_000, wait('t1', false)],
    [SUB_IDLE_MS + 30_000, { k: 'tool_end', id: 't1' }],
    [SUB_IDLE_MS + 40_000, wait('t1', true)], // closed: ignored
    [2 * SUB_IDLE_MS + 29_999, 'idle'],
    [2 * SUB_IDLE_MS + 30_000, 'idle'],
  ];
  const play = (withWaits) => {
    const { s, clock } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
    const out = [s.apply({ k: 'meta', title: 'Helper' })];
    const growth = [];
    for (const [ms, step] of steps) {
      clock.t = T0 + ms;
      if (step === 'idle') out.push(s.idle(clock.t));
      else out.push(step.k !== 'tool_wait' || withWaits ? s.apply(step) : []);
      growth.push(s.lastActivityMs);
    }
    return { out: out.map((evs) => evs.filter((e) => e.type !== 'tool_wait')), growth, s };
  };
  const a = play(true);
  const b = play(false);
  assert.deepEqual(a.out, b.out);
  assert.deepEqual(a.growth, b.growth);
  assert.deepEqual(types(a.out.at(-2)), [], 'one ms early: still there');
  assert.deepEqual(a.out.at(-1).map((e) => [e.type, e.reason]), [['session_end', 'idle']]);
  assert.equal(a.s.ended, true);
});

test('tool_wait: nothing after the core ended, and an ended sub does not wake', () => {
  const { s, clock } = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' });
  run(s, [{ k: 'meta', title: 'Helper' }, shell('t1'), wait('t1', true), { k: 'turn_end', reason: 'interrupt' }]);
  clock.t = T0 + SUB_IDLE_MS;
  assert.deepEqual(types(s.idle(clock.t)), ['session_end']);
  for (const it of [wait('t1', false), wait('t1', true), wait('t2', true)]) assert.deepEqual(s.apply(it), []);
  assert.equal(s.ended, true);
  assert.deepEqual(s.snapshotEvents(), []);
});

test('tool_wait: the snapshot is session, plan, tool_starts, each wait right after its tool_start, JSON-identical', () => {
  const { s } = mk();
  const live = run(s, [
    { k: 'meta', title: 'Snap', ts: at(0) },
    { k: 'plan', items: [{ content: 'Ship', status: 'in_progress' }], ts: at(500) },
    shell('a', { ts: at(1000) }),
    shell('b', { ts: at(2000) }),
    wait('b', true, { ts: at(2500) }),
    { k: 'tool_start', id: 'q', desc: { tool: 'ask_user_question', kind: 'ask' }, question: 'Go?', options: ['Yes'], ts: at(3000) },
  ]);
  const startJson = JSON.stringify(of(live, 'tool_start'));
  const snap = s.snapshotEvents();
  assert.deepEqual(snap.map((e) => [e.type, e.toolUseId]),
    [['session', undefined], ['plan', undefined], ['tool_start', 'a'], ['tool_start', 'b'], ['tool_wait', 'b'], ['tool_start', 'q']]);
  assert.equal(JSON.stringify(snap[4]), JSON.stringify(of(live, 'tool_wait')[0]), 'the copy equals the emitted event');
  assert.equal(JSON.stringify(snap.filter((e) => e.type === 'tool_start')), startJson, 'startEv is never mutated');
  assert.ok(!snap.some((e) => e.type === 'tool_start' && ('waiting' in e || 'awaitsApproval' in e)));
  snap[4].waiting = false;
  of(live, 'tool_wait')[0].ts = 'mutated';
  assert.deepEqual(s.snapshotEvents()[4], { type: 'tool_wait', sessionId: 'grok-m1', ts: at(2500), toolUseId: 'b', waiting: true },
    'neither the snapshot copy nor the emitted event aliases the stored one');
  s.apply(wait('b', false, { ts: at(4000) }));
  assert.deepEqual(of(s.snapshotEvents(), 'tool_wait'), [], 'an allow drops it from the snapshot');
  assert.equal(JSON.stringify(of(s.snapshotEvents(), 'tool_start')), startJson);
});

test('tool_wait: replay builds the same wait (no events), live false follows; growth stays at the record ts', () => {
  const { s } = mk();
  const rep = run(s, [{ k: 'meta', title: 'Replay', ts: at(0) }, shell('t1', { ts: at(1000) }), wait('t1', true)], { replay: true });
  assert.deepEqual(rep, [], 'replay returns hint items only');
  assert.equal(s.lastActivityMs, T0 + 1000, 'a ts-less replayed wait adds no growth');
  const snap = s.snapshotEvents();
  assert.deepEqual(snap.slice(-2).map((e) => [e.type, e.toolUseId, e.waiting]), [['tool_start', 't1', undefined], ['tool_wait', 't1', true]]);
  assert.equal(snap.at(-1).ts, at(1000));
  assert.deepEqual(s.apply(wait('t1', true)), [], 'the latch holds across replay and live');
  assert.deepEqual(s.apply(wait('t1', false, { ts: at(6000) })).map((e) => [e.type, e.waiting, e.ts]), [['tool_wait', false, at(6000)]]);
});

test('tool_wait: R9 is untouched, the dedupe key applies, a sub emits it too', () => {
  const { s } = mk();
  run(s, [{ k: 'meta', title: 'R9' }]);
  assert.deepEqual(s.apply(wait('x', true)), []);
  assert.deepEqual(types(s.apply(shell('x'))), ['tool_start'], 'a wait for an unknown id never marks it opened');
  run(s, [wait('x', true), { k: 'tool_end', id: 'x' }]);
  assert.deepEqual(run(s, [shell('x'), wait('x', true)]), [], 'a reused id stays closed (R9), and so does its wait');
  run(s, [shell('k')]);
  assert.equal(s.apply(wait('k', true, { key: 'w-1' })).length, 1);
  assert.deepEqual(s.apply(wait('k', false, { key: 'w-1' })), [], 'a repeated key yields nothing');
  const sub = mk({ id: 'grok-c1', kind: 'sub', parentId: 'grok-m1' }).s;
  run(sub, [{ k: 'meta', title: 'Helper' }, shell('s1')]);
  assert.deepEqual(sub.apply(wait('s1', true, { ts: at(1) })).map((e) => [e.sessionId, e.toolUseId, e.waiting]), [['grok-c1', 's1', true]]);
});

// ---- the shared harness through the real server (core-fixture adapter, ADAPTERS 10) -------------------------------

test('conformance: tool_wait from attach replay and live passes the shared harness (snapshot, live, /state)', async () => {
  const id = 'grok';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-conf-wait-'));
  tmpDirs.push(root);
  const p = corePaths(root);
  const ts = (agoMs) => new Date(Date.now() - agoMs).toISOString();
  await writeItems(p.main('m1'), [
    { k: 'meta', ts: ts(9000), cwd: '/work/wait', title: 'Wait main' },
    { k: 'turn_start', id: 'p1' },
    { k: 'tool_start', id: 't-old', desc: { tool: 'run_terminal_command', kind: 'shell', command: 'npm test' } },
    { k: 'tool_wait', id: 't-old', waiting: true, ts: ts(5000) },
  ]);
  await writeItems(p.sub('m1', 'c1'), [
    { k: 'meta', ts: ts(8000), title: 'Helper' },
    { k: 'tool_start', id: 'c1-t1', desc: { tool: 'write', kind: 'edit', path: 'src/a.js' } },
    { k: 'tool_wait', id: 'c1-t1', waiting: true, ts: ts(4000) },
  ]);
  const res = await runConformance(coreAdapter({ id }), root, {
    mustSee: ['session', 'tool_start', 'tool_end', 'tool_wait'],
    live: async ({ waitFor }) => {
      await appendItems(p.main('m1'), [
        { k: 'tool_wait', id: 't-old', waiting: false, ts: new Date().toISOString() },
        { k: 'tool_end', id: 't-old' },
        { k: 'tool_start', id: 't-new', desc: { tool: 'web_fetch', kind: 'web', url: 'https://docs.example.com/x' } },
        { k: 'tool_wait', id: 't-new', waiting: true, ts: new Date().toISOString() },
        { k: 'tool_start', id: 't-ask', desc: { tool: 'ask_user_question', kind: 'ask' }, question: 'Go?', options: ['Yes'] },
        { k: 'tool_wait', id: 't-ask', waiting: true },
        { k: 'tool_wait', id: 't-gone', waiting: true },
        { k: 'meta', title: 'Wait main 2' },
      ]);
      await waitFor((ev) => ev.type === 'session' && ev.title === 'Wait main 2');
    },
  });
  const waits = res.stream.filter((e) => e.type === 'tool_wait').map((e) => [e.sessionId, e.toolUseId, e.waiting]);
  assert.deepEqual(waits, [
    [`${id}-m1`, 't-old', true], [`${id}-c1`, 'c1-t1', true], // the attach snapshot
    [`${id}-m1`, 't-old', false], [`${id}-m1`, 't-new', true], // live
  ]);
  assert.deepEqual(res.state.filter((e) => e.type === 'tool_start' || e.type === 'tool_wait').map((e) => [e.type, e.toolUseId]),
    [['tool_start', 't-new'], ['tool_wait', 't-new'], ['tool_start', 't-ask'], ['tool_start', 'c1-t1'], ['tool_wait', 'c1-t1']]);
});
