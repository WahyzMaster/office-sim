// Grok approval wait (P5g, ADAPTERS 5.2, CONTRACT 4.6), session level: GrokSession with an injected clock and injected
// GrokMeta results ({ approval: { facts, seenAt, reset, caughtUp? } } through setInfo, the shape GrokMeta reports).
// Pairing by ordinal with name + 50 ms verification, resync to a unique candidate, held requests, the 1 s show rule, the
// allow / deny / cancel / next-turn ends, ask and hidden tools, and attach parity. Synthetic records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { ApprovalPairing, APPROVAL_SHOW_MS, PAIR_MS, AHEAD_MS } from '../src/adapters/grok/approval.mjs';
import { createGrokBuilder, GROK_SESSION } from './fixtures/grok.mjs';

const MAIN_ID = `grok-${GROK_SESSION}`;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function mk(o = {}) {
  const clock = { t: T0 };
  const s = new GrokSession({ id: MAIN_ID, agent: 'grok', kind: 'main', now: () => clock.t, ...o });
  return { s, clock, g: createGrokBuilder({ startMs: T0, stepMs: 1000 }) };
}
const run = (s, recs, opts) => recs.flatMap((r) => s.apply(r, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const types = (evs) => evs.map((e) => e.type);
const callMs = (rec) => rec.params._meta.agentTimestampMs;
const idOf = (rec) => rec.params.update.toolCallId;
const shell = (g, o = {}) => g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' }, ...o });
// the open fact EventsTail reports for the e-th tool_started (its tool_started 2 ms after the call, the request 4 ms)
const req = (e, rec, { name = rec.params.update._meta['x.ai/tool'].name, startMs = callMs(rec) + 2, reqMs = startMs + 2 } = {}) => (
  { e, name, startMs, reqMs, state: 'open' });
const closed = (f, state, resMs) => ({ ...f, state, resMs });
const read = (s, facts, seenAt, reset = false) => s.setInfo({ approval: { facts, seenAt, reset } });
// GrokMeta's shape: a caught-up read lists every request still open (P5g review: what it does not list has closed)
const readUp = (s, facts, seenAt, reset = false) => s.setInfo({ approval: { facts, seenAt, reset, caughtUp: true } });
const ap = (s) => s.debugState().grok.approval;
const turn = (g, text = 'Run the tests') => [g.userMessage({ text }), g.hook()];

test('a prompt resolved before a read finds it 1 s old emits nothing (auto-approval and a 400 ms wait)', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  assert.deepEqual(read(s, [f], f.reqMs + 400), [], 'a 400 ms old request is not shown yet');
  assert.deepEqual(read(s, [closed(f, 'allow', f.reqMs + 600)], f.reqMs + 3000), [], 'allowed before it was due: nothing');
  assert.deepEqual(of(s.snapshotEvents(), 'tool_wait'), []);
  assert.deepEqual([ap(s).stats.paired, ap(s).stats.shown, ap(s).stats.cleared], [1, 0, 0], 'paired once, never shown');
  // a later open fact for the same ordinal stays silent (decided once)
  assert.deepEqual(read(s, [f], f.reqMs + 6000), []);
});

test('a request open 1 s or more at a read: one tool_wait true after its tool_start, ts = the request ts, in the snapshot', () => {
  const { s, g } = mk();
  const c = shell(g);
  const live = run(s, [...turn(g), c]);
  const f = req(1, c);
  assert.deepEqual(read(s, [f], f.reqMs + 400), []);
  const evs = read(s, [f], f.reqMs + 3400);
  assert.deepEqual(evs, [{ type: 'tool_wait', sessionId: MAIN_ID, ts: iso(f.reqMs), toolUseId: idOf(c), waiting: true }]);
  assert.ok(types(live).indexOf('tool_start') >= 0, 'its tool_start came first');
  const snap = s.snapshotEvents();
  assert.deepEqual(types(snap), ['session', 'tool_start', 'tool_wait']);
  assert.equal(JSON.stringify(snap[2]), JSON.stringify(evs[0]), 'the snapshot copy is the wire event');
  assert.deepEqual(read(s, [f], f.reqMs + 6400), [], 'still open at the next read: no second true');
  assert.deepEqual(s.debugState().waiting, [idOf(c)]);
});

test('allow: waiting:false at the resolution ts, the snapshot drops it, a later open fact stays silent', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  read(s, [f], f.reqMs + 2000);
  const evs = read(s, [closed(f, 'allow', f.reqMs + 2500)], f.reqMs + 5000);
  assert.deepEqual(evs, [{ type: 'tool_wait', sessionId: MAIN_ID, ts: iso(f.reqMs + 2500), toolUseId: idOf(c), waiting: false }]);
  assert.deepEqual(types(s.snapshotEvents()), ['session', 'tool_start']);
  assert.deepEqual(read(s, [f], f.reqMs + 8000), [], 'the same ordinal open again: silent');
  const done = run(s, [g.toolDone({ id: idOf(c) })]);
  assert.deepEqual(types(done), ['tool_end']);
  assert.equal(of(done, 'tool_end')[0].ok, true);
});

test('deny: no waiting:false; the transcript ends the tool as denied with its fixed line', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  assert.equal(read(s, [f], f.reqMs + 2000).length, 1);
  assert.deepEqual(read(s, [closed(f, 'deny', f.reqMs + 2500)], f.reqMs + 5000), []);
  assert.deepEqual(s.debugState().waiting, [idOf(c)], 'the wait stays until the tool ends');
  const [end] = run(s, [g.toolDenied({ id: idOf(c) })]);
  assert.deepEqual([end.type, end.ok, end.errorKind, end.error],
    ['tool_end', false, 'denied', 'Tool run_terminal_command was not executed: Auto mode blocked this action']);
  assert.deepEqual(types(s.snapshotEvents()), ['session']);
  // an unknown decision is reported as allow by events.mjs: it clears like an allow (covered above); gone sends nothing
});

test('a fact read before the k-th tool_call is held, then comes out in the same apply() as that tool_start', () => {
  const { s, g } = mk();
  const first = g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
  run(s, [...turn(g), first, g.toolDone({ id: idOf(first) })]);
  // the 2nd call's tool_started and request are on disk, its tool_call line is not yet
  const startMs = g.clockMs + 2;
  const f = { e: 2, name: 'run_terminal_command', startMs, reqMs: startMs + 3, state: 'open' };
  assert.deepEqual(read(s, [f], f.reqMs + 1500), []);
  assert.deepEqual(ap(s).held, [2]);
  const c = shell(g);
  const evs = s.apply(c);
  assert.deepEqual(types(evs), ['tool_start', 'tool_wait']);
  assert.deepEqual([evs[1].toolUseId, evs[1].waiting, evs[1].ts], [idOf(c), true, iso(f.reqMs)]);
  assert.deepEqual(ap(s).held, []);
  // held but not yet due when its call came: pending, shown at the next read that still finds it open
  const { s: s2, g: g2 } = mk();
  run(s2, turn(g2));
  const f2 = { e: 1, name: 'run_terminal_command', startMs: g2.clockMs + 2, reqMs: g2.clockMs + 4, state: 'open' };
  read(s2, [f2], f2.reqMs + 300);
  assert.deepEqual(types(s2.apply(shell(g2))), ['tool_start']);
  assert.deepEqual(types(read(s2, [f2], f2.reqMs + 3300)), ['tool_wait']);
  // held, then resolved before its call came: never shown
  const { s: s3, g: g3 } = mk();
  run(s3, turn(g3));
  const f3 = { e: 1, name: 'run_terminal_command', startMs: g3.clockMs + 2, reqMs: g3.clockMs + 4, state: 'open' };
  read(s3, [f3], f3.reqMs + 2000);
  read(s3, [closed(f3, 'allow', f3.reqMs + 2100)], f3.reqMs + 5000);
  assert.deepEqual(types(s3.apply(shell(g3))), ['tool_start']);
});

test('ordinals: hidden todo_write and late calls count; the web_search fallback and a repeated id do not', () => {
  const { s, g } = mk();
  const todo = g.toolCall({ name: 'todo_write', input: { todos: [] } });
  const web = g.toolCall({ name: null, input: { backend: 'x', variant: 'y' } });
  const rd = g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
  const again = g.toolCall({ name: 'read_file', id: idOf(rd), input: { target_file: '/w/a.txt' } });
  run(s, [...turn(g), todo, web, rd, again, g.toolDone({ id: idOf(rd) }), g.toolDone({ id: idOf(web) })]);
  const oldTurn = g.promptId;
  run(s, [g.turnCompleted()]);
  const late = g.toolCall({ name: 'grep', input: { pattern: 'x' }, promptId: oldTurn }); // a late record of the ended turn
  run(s, [late, ...turn(g, 'Next')]);
  assert.equal(s.debugState().grok.late, 1, 'the late call was dropped as late');
  const c = shell(g);
  run(s, [c]);
  assert.equal(ap(s).count, 4, 'todo_write, read_file, the late grep and the shell');
  const evs = read(s, [req(4, c)], callMs(c) + 3000);
  assert.deepEqual(evs.map((e) => [e.type, e.toolUseId]), [['tool_wait', idOf(c)]]);
  assert.deepEqual([ap(s).stats.paired, ap(s).stats.resyncs, ap(s).offset], [1, 0, 0], 'verified by ordinal, no resync');
});

test('resync: a tool_started missing mid-file moves the offset to the unique candidate; later requests verify', () => {
  const { s, g } = mk();
  const a = g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
  const b = g.toolCall({ name: 'read_file', input: { target_file: '/w/b.txt' } }); // no tool_started in events.jsonl
  const c = shell(g);
  run(s, [...turn(g), a, g.toolDone({ id: idOf(a) }), b, g.toolDone({ id: idOf(b) }), c]);
  const evs = read(s, [req(2, c)], callMs(c) + 2000); // e=2 is c (b's start is missing): u = 2 is b, wrong name
  assert.deepEqual(evs.map((e) => e.toolUseId), [idOf(c)]);
  assert.deepEqual([ap(s).offset, ap(s).stats.resyncs, ap(s).lastU], [1, 1, 3]);
  const d = shell(g);
  run(s, [g.toolDone({ id: idOf(c) }), d]);
  assert.deepEqual(read(s, [req(3, d)], callMs(d) + 2000).map((e) => e.toolUseId), [idOf(d)], 'u = 3 + 1 verifies');
  assert.deepEqual([ap(s).stats.paired, ap(s).stats.resyncs], [1, 1]);
});

test('resync: two same-name open calls within 50 ms (a tie), an updated one, or none in time stay silent', () => {
  const { s, g } = mk();
  const a = g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
  run(s, [...turn(g), a, g.toolDone({ id: idOf(a) })]);
  const t = g.clockMs;
  const x = shell(g, { ms: t });
  const y = shell(g, { ms: t + 30 }); // a parallel sibling 30 ms later, neither updated
  run(s, [x, y]);
  // e=1 is x, but u = 1 is the read: resync finds two candidates within 50 ms of the start -> silent
  assert.deepEqual(read(s, [req(1, x, { startMs: t + 15 })], t + 3000), []);
  assert.deepEqual([ap(s).stats.misses, ap(s).offset, ap(s).stats.resyncs], [1, 0, 0]);
  assert.deepEqual(read(s, [req(1, x, { startMs: t + 15 })], t + 6000), [], 'decided once: no retry');
  // one candidate already has a tool_call_update (its prompt was resolved): the other is unique
  const { s: s2, g: g2 } = mk();
  const a2 = g2.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
  run(s2, [...turn(g2), a2, g2.toolDone({ id: idOf(a2) })]);
  const t2 = g2.clockMs;
  const x2 = shell(g2, { ms: t2 });
  const y2 = shell(g2, { ms: t2 + 30 });
  run(s2, [x2, g2.toolInput({ id: idOf(x2), input: { command: 'npm test' } }), y2]);
  // e=1 lands on the read (u = 1): resync skips the updated x2, y2 is the only candidate
  assert.deepEqual(read(s2, [req(1, y2, { startMs: t2 + 25 })], t2 + 3000).map((e) => e.toolUseId), [idOf(y2)]);
  assert.deepEqual([ap(s2).offset, ap(s2).stats.resyncs], [2, 1]);
  // nothing within 50 ms: silent
  const { s: s3, g: g3 } = mk();
  const x3 = shell(g3);
  run(s3, [...turn(g3), g3.toolCall({ name: 'read_file', input: {} }), x3]);
  assert.deepEqual(read(s3, [req(1, x3, { startMs: callMs(x3) + PAIR_MS + 1 })], callMs(x3) + 3000), []);
  assert.equal(ap(s3).stats.misses, 1);
});

test('the 21-starts-vs-64-calls shape (no start agrees with any call in time) stays silent', () => {
  const { s, g } = mk({ kind: 'sub', parentId: 'grok-01920000-0000-7000-8000-000000000001' });
  run(s, turn(g, 'Task from the parent'));
  const calls = [];
  for (let i = 0; i < 64; i++) {
    const c = shell(g);
    calls.push(c);
    run(s, i % 3 === 0 ? [c] : [c, g.toolDone({ id: idOf(c) })]);
  }
  const facts = [];
  for (let e = 1; e <= 21; e++) {
    const c = calls[e * 3];
    facts.push(req(e, c, { startMs: callMs(c) + 400 })); // same name, 400 ms off every call
  }
  assert.deepEqual(read(s, facts, callMs(calls.at(-1)) + 5000), []);
  assert.deepEqual([ap(s).stats.paired, ap(s).stats.resyncs, ap(s).stats.misses, ap(s).offset], [0, 0, 21, 0]);
});

test('ask_user_question, exit_plan_mode and hidden tools never get a tool_wait (also when paired)', () => {
  const { s, g } = mk();
  const ask = g.toolCall({ name: 'ask_user_question', input: { questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
  const plan = g.toolCall({ name: 'exit_plan_mode', input: {} });
  const todo = g.toolCall({ name: 'todo_write', input: { todos: [] } });
  const evs = run(s, [...turn(g), ask, plan, todo]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [idOf(ask), idOf(plan)]);
  assert.deepEqual(read(s, [req(1, ask), req(2, plan), req(3, todo)], callMs(todo) + 5000), []);
  assert.deepEqual([ap(s).stats.paired, ap(s).stats.shown], [3, 0], 'paired by ordinal, but no target');
  assert.deepEqual(s.debugState().waiting, []);
});

test('turn_completed cancelled while waiting: interrupted and no false; the next turn_start: abandoned and no false', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  assert.equal(read(s, [f], f.reqMs + 2000).length, 1);
  const end = run(s, [g.turnCompleted({ stopReason: 'cancelled' })]);
  assert.deepEqual(end.map((e) => [e.type, e.errorKind ?? e.reason]), [['tool_end', 'interrupted'], ['turn_end', 'interrupt']]);
  assert.deepEqual(read(s, [closed(f, 'gone', f.reqMs + 3000)], f.reqMs + 5000), []);
  assert.deepEqual(ap(s).shown, []);
  // the next turn while waiting (no turn_completed): abandoned; a late allow for it stays silent
  const d = shell(g, { promptId: g.newPrompt() });
  run(s, [g.hook(), d]);
  const f2 = req(2, d);
  assert.equal(read(s, [f2], f2.reqMs + 2000).length, 1);
  const next = run(s, turn(g, 'Something else'));
  assert.deepEqual(of(next, 'tool_end').map((e) => [e.toolUseId, e.errorKind]), [[idOf(d), 'abandoned']]);
  assert.deepEqual(read(s, [closed(f2, 'allow', f2.reqMs + 3000)], f2.reqMs + 5000), []);
  assert.deepEqual(of(s.snapshotEvents(), 'tool_wait'), []);
});

test('a turn boundary drops a held request; a sub shows waits like a main', () => {
  const { s, g } = mk();
  run(s, turn(g));
  const f = { e: 1, name: 'run_terminal_command', startMs: g.clockMs + 2, reqMs: g.clockMs + 4, state: 'open' };
  read(s, [f], f.reqMs + 2000);
  run(s, [g.turnCompleted({ stopReason: 'cancelled' })]);
  assert.deepEqual([ap(s).held, ap(s).stats.dropped], [[], 1]);
  const late = shell(g, { promptId: g.promptId }); // a record of the cancelled turn
  assert.deepEqual(s.apply(late), [], 'its call comes late: nothing');
  assert.equal(ap(s).count, 1, 'the late call still counts');
  const { s: sub, g: gs } = mk({ kind: 'sub', parentId: 'grok-01920000-0000-7000-8000-000000000001' });
  const c = shell(gs);
  run(sub, [...turn(gs, 'Task'), c]);
  assert.deepEqual(read(sub, [req(1, c)], callMs(c) + 2000).map((e) => [e.type, e.waiting]), [['tool_wait', true]]);
});

test('times: a missing or far-ahead request ts uses the first read that found it open; reset voids the ordinals', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const S = callMs(c) + 100;
  const f = { ...req(1, c), reqMs: null };
  assert.deepEqual(read(s, [f], S), [], 'no request time: counted from this read');
  const [on] = read(s, [f], S + 3000);
  assert.equal(on.ts, iso(S));
  const { s: s2, g: g2 } = mk();
  const c2 = shell(g2);
  run(s2, [...turn(g2), c2]);
  const S2 = callMs(c2) + 100;
  assert.deepEqual(read(s2, [req(1, c2, { reqMs: S2 + AHEAD_MS + 1 })], S2), []);
  assert.equal(read(s2, [req(1, c2, { reqMs: S2 + AHEAD_MS + 1 })], S2 + APPROVAL_SHOW_MS)[0].ts, iso(S2));
  // reset: the old ordinal 1 is void; the new file's e=1 is the new call (resync, the old one is closed)
  const d = shell(g2);
  run(s2, [g2.toolDone({ id: idOf(c2) }), d]);
  const evs = read(s2, [req(1, d)], callMs(d) + 2000, true);
  assert.deepEqual(evs.map((e) => [e.toolUseId, e.waiting]), [[idOf(d), true]]);
  assert.deepEqual([ap(s2).stats.resets, ap(s2).stats.resyncs, ap(s2).offset], [1, 1, 1]);
  // malformed results are no information
  for (const bad of [null, 'x', { facts: [req(2, d)] }, { facts: [{ e: 0, state: 'open' }, { e: 1.5, state: 'open' }, { e: 9, state: 'odd' }], seenAt: 1 }]) {
    assert.deepEqual(s2.setInfo({ approval: bad }), []);
  }
});

test('attach parity: replay plus setInfo(approval) with its events dropped gives the same snapshot as live', () => {
  const build = () => {
    const g = createGrokBuilder({ startMs: T0, stepMs: 1000 });
    const a = g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
    const c = shell(g);
    return { c, recs: [...turn(g), a, g.toolDone({ id: idOf(a) }), c] };
  };
  const live = mk();
  const { c, recs } = build();
  run(live.s, recs);
  const replay = mk();
  assert.deepEqual(run(replay.s, build().recs, { replay: true }), []);
  const f = req(2, c);
  const out = read(live.s, [f], f.reqMs + 5000);
  read(replay.s, [f], f.reqMs + 5000); // the Runner drops these (attach: syncSidecars(f, false))
  assert.equal(out.length, 1);
  assert.deepEqual(types(replay.s.snapshotEvents()), ['session', 'tool_start', 'tool_wait']);
  assert.equal(JSON.stringify(replay.s.snapshotEvents()), JSON.stringify(live.s.snapshotEvents()));
  assert.deepEqual(replay.s.debugState(), live.s.debugState());
});

test('Store-style setInfo (no approval key) passes through: no tool_wait, the pairing state is untouched', () => {
  const { s, g } = mk({ kind: 'sub', parentId: 'grok-01920000-0000-7000-8000-000000000001' });
  const c = shell(g);
  run(s, [...turn(g, 'Task'), c]);
  const before = JSON.stringify(ap(s));
  const evs = [
    ...s.setInfo({ parentProject: '/work/parent' }),
    ...s.setInfo({ subMeta: null, journalLabel: null, parentId: 'grok-01920000-0000-7000-8000-000000000001', agentType: 'explore' }),
    ...s.setInfo({ title: 'Helper', cwd: '/work/parent', branch: 'main' }),
  ];
  assert.deepEqual(of(evs, 'tool_wait'), []);
  assert.ok(evs.every((e) => e.type === 'session'));
  assert.equal(JSON.stringify(ap(s)), before);
  // the summary fields next to an approval still reach the core
  const mixed = s.setInfo({ title: 'Helper 2', approval: { facts: [req(1, c)], seenAt: callMs(c) + 2000, reset: false } });
  assert.deepEqual(types(mixed), ['session', 'tool_wait']);
});

test('ApprovalPairing alone: a counted call needs x.ai/tool and a new id; markUpdated only for remembered calls', () => {
  const p = new ApprovalPairing();
  assert.equal(p.noteCall({ toolCallId: 'a', _meta: { 'x.ai/tool': { name: ' read_file ' } } }, { agentTimestampMs: 5 }), true);
  assert.equal(p.noteCall({ toolCallId: 'a', _meta: { 'x.ai/tool': { name: 'read_file' } } }, {}), false, 'repeated id');
  assert.equal(p.noteCall({ toolCallId: 'b', rawInput: { backend: 'x' } }, {}), false, 'web_search fallback');
  assert.equal(p.noteCall({ toolCallId: '', _meta: { 'x.ai/tool': {} } }, {}), false, 'no id');
  assert.equal(p.noteCall({ toolCallId: 'c', _meta: { 'x.ai/tool': { name: 'bad name!' } }, rawInput: { backend: 'x' } }, {}), true);
  assert.deepEqual([...p.calls.values()].map((c) => [c.u, c.name, c.ms]), [[1, 'read_file', 5], [2, null, null]]);
  p.markUpdated('a');
  p.markUpdated('zzz');
  assert.equal(p.calls.get(1).updated, true);
  assert.deepEqual(p.take(), []);
});

// ---- P5g review: a rebuilt events tail or a reset must not strand a shown wait -------------------------------------

test('reset while a wait is shown: the same open request re-pairs silently and its allow still sends waiting:false', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  assert.equal(readUp(s, [f], f.reqMs + 2000).length, 1);
  // events.jsonl replaced (new inode, same bytes): the reset read lists the prompt again, still open
  assert.deepEqual(readUp(s, [f], f.reqMs + 5000, true), [], 'no second true, no false: the prompt is still open');
  assert.deepEqual([ap(s).shown, s.debugState().waiting], [[1], [idOf(c)]]);
  const evs = readUp(s, [closed(f, 'allow', f.reqMs + 6000)], f.reqMs + 8000);
  assert.deepEqual(evs, [{ type: 'tool_wait', sessionId: MAIN_ID, ts: iso(f.reqMs + 6000), toolUseId: idOf(c), waiting: false }]);
  assert.deepEqual(types(s.snapshotEvents()), ['session', 'tool_start']);
});

test('reset whose new file already holds the allow (or no longer lists the prompt): waiting:false at the read', () => {
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  readUp(s, [f], f.reqMs + 2000);
  // a reset read that is not caught up says nothing about what is open: nothing is closed on it
  assert.deepEqual(s.setInfo({ approval: { facts: [], seenAt: f.reqMs + 4000, reset: true, caughtUp: false } }), []);
  assert.deepEqual(s.debugState().waiting, [idOf(c)]);
  const evs = readUp(s, [], f.reqMs + 7000);
  assert.deepEqual(evs.map((e) => [e.toolUseId, e.waiting, e.ts]), [[idOf(c), false, iso(f.reqMs + 7000)]]);
  assert.deepEqual(types(s.snapshotEvents()), ['session', 'tool_start']);
  assert.deepEqual(readUp(s, [], f.reqMs + 9000), [], 'once');
});

test('a caught-up read that no longer lists a shown, held or pending request (the tail was rebuilt) closes it', () => {
  // shown: the allow was lost with the old tail (a same-inode move): waiting:false
  const { s, g } = mk();
  const c = shell(g);
  run(s, [...turn(g), c]);
  const f = req(1, c);
  readUp(s, [f], f.reqMs + 2000);
  assert.deepEqual(readUp(s, [f], f.reqMs + 5000), [], 'listed: still waiting');
  assert.deepEqual(readUp(s, [], f.reqMs + 8000).map((e) => [e.toolUseId, e.waiting]), [[idOf(c), false]]);
  assert.deepEqual(ap(s).shown, []);
  // held: its call comes after the request closed, so it is never shown
  const { s: s2, g: g2 } = mk();
  run(s2, turn(g2));
  const f2 = { e: 1, name: 'run_terminal_command', startMs: g2.clockMs + 2, reqMs: g2.clockMs + 4, state: 'open' };
  readUp(s2, [f2], f2.reqMs + 2000);
  assert.deepEqual(ap(s2).held, [1]);
  assert.deepEqual(readUp(s2, [], f2.reqMs + 5000), []);
  assert.deepEqual(ap(s2).held, []);
  assert.deepEqual(types(s2.apply(shell(g2))), ['tool_start'], 'no true for an already closed prompt');
  // pending: paired but not yet due, then gone from the list
  const { s: s3, g: g3 } = mk();
  const c3 = shell(g3);
  run(s3, [...turn(g3), c3]);
  const f3 = req(1, c3);
  readUp(s3, [f3], f3.reqMs + 300);
  assert.deepEqual(ap(s3).pending, [1]);
  assert.deepEqual(readUp(s3, [], f3.reqMs + 3000), []);
  assert.deepEqual(readUp(s3, [f3], f3.reqMs + 6000), [], 'decided once');
});

test('one tool_call never counted (an oversize id): a held request resyncs at the next read that still finds it open', () => {
  const { s, g } = mk();
  const a = g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } });
  const lost = g.toolCall({ name: 'grep', input: { pattern: 'x' }, id: `call-${'x'.repeat(300)}` }); // itemId refuses it
  run(s, [...turn(g), a, g.toolDone({ id: idOf(a) }), lost]);
  const c = shell(g);
  run(s, [c]);
  assert.equal(ap(s).count, 2, 'events.jsonl has 3 tool_started, the session counts 2 calls');
  const f = req(3, c);
  assert.deepEqual(readUp(s, [f], f.reqMs + 2000), [], 'e = 3 > 2 counted calls: held (its call may come later)');
  assert.deepEqual(ap(s).held, [3]);
  const evs = readUp(s, [f], f.reqMs + 5000);
  assert.deepEqual(evs.map((e) => [e.toolUseId, e.waiting, e.ts]), [[idOf(c), true, iso(f.reqMs)]]);
  assert.deepEqual([ap(s).offset, ap(s).stats.resyncs, ap(s).held], [-1, 1, []]);
  assert.deepEqual(readUp(s, [closed(f, 'allow', f.reqMs + 6000)], f.reqMs + 8000).map((e) => e.waiting), [false]);
  // the next prompt verifies by ordinal with the new offset, at its first read
  const d = shell(g);
  run(s, [g.toolDone({ id: idOf(c) }), d]);
  assert.deepEqual(readUp(s, [req(4, d)], callMs(d) + 2000).map((e) => [e.toolUseId, e.waiting]), [[idOf(d), true]]);
  assert.deepEqual([ap(s).stats.paired, ap(s).stats.resyncs, ap(s).stats.misses], [1, 1, 0]);
  // no candidate at the next read (the call is really not written yet): still held, not decided
  const { s: s2, g: g2 } = mk();
  run(s2, turn(g2));
  const f2 = { e: 1, name: 'run_terminal_command', startMs: g2.clockMs + 2, reqMs: g2.clockMs + 4, state: 'open' };
  readUp(s2, [f2], f2.reqMs + 2000);
  assert.deepEqual(readUp(s2, [f2], f2.reqMs + 5000), []);
  assert.deepEqual([ap(s2).held, ap(s2).stats.misses], [[1], 0]);
  assert.deepEqual(types(s2.apply(shell(g2))), ['tool_start', 'tool_wait'], 'the late call still pairs');
});

test('an approval-only setInfo never announces the session: the stream minus tool_wait equals the stream without events.jsonl', () => {
  // P5g recount: the first caught-up read of a tail comes with no facts; it reached core.setInfo({}) and its session check,
  // so a session with nothing visible yet got a session event the same session without events.jsonl never sends
  const { s, g } = mk();
  assert.deepEqual(readUp(s, [], T0), [], 'fresh session, no facts: nothing');
  assert.deepEqual(read(s, [], T0 + 3000, true), [], 'a reset with no facts: nothing');
  const plain = mk().s;
  const recs = [...turn(g), shell(g)];
  assert.deepEqual(types(run(s, recs)), types(run(plain, recs)), 'the session event still comes with the first record');
  assert.deepEqual(readUp(s, [], T0 + 6000), [], 'later, still nothing extra');
  // a sidecar title next to the approval still reaches the core (GrokMeta merges summary.json info with the fact)
  assert.deepEqual(types(s.setInfo({ title: 'Renamed in summary.json', approval: { facts: [], seenAt: T0 + 9000, reset: false, caughtUp: true } })), ['session']);
});
