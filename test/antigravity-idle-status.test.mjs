// AntigravitySession: a turn that ends without a closing answer (interrupted, or given up after an error) has no end
// marker in the transcript, so before this rule it stayed open with its waiting calls (a read-only count of real files:
// 6 of 36 conversations, 4 closed by this rule). Rule (CONTRACT 4.8 Status / Turns): once the summary status `idle` has been delivered
// for the open turn (the early-idle flag of finding 7: after the turn's USER_INPUT, its last planner line with calls and
// any `running`) and neither a new transcript line nor a `running` came for IDLE_STATUS_QUIET_MS (counted from the later
// of the last line and that delivery), the waiting calls end `abandoned` and the turn ends `end_turn`, once. A closing
// answer still ends the turn at once (finding 7). Synthetic steps only (test/fixtures/antigravity.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntigravitySession, IDLE_STATUS_QUIET_MS } from '../src/adapters/antigravity/session.mjs';
import { END_TURN_IDLE_MS } from '../src/core/session-core.mjs';
import { createAntigravityBuilder, call, linePositions, toolId as tid, AG_ID } from './fixtures/antigravity.mjs';

const SERVER_T = Date.UTC(2026, 9, 20, 10, 0, 0);
const Q = IDLE_STATUS_QUIET_MS;

function mk() {
  const clock = { t: SERVER_T };
  const s = new AntigravitySession({ id: AG_ID, agent: 'antigravity', kind: 'main', now: () => clock.t, facts: { full: true } });
  return { s, clock, b: createAntigravityBuilder() };
}
const run = (s, steps, opts) => steps.flatMap((st) => s.apply(st, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const noTs = (evs) => evs.map(({ ts, ...rest }) => rest);
const openTools = (s) => s.snapshotEvents().filter((e) => e.type === 'tool_start').map((e) => e.toolUseId);

test('the quiet time is longer than the closing-answer fallback and than the longest planner gap of the study (35 s)', () => {
  assert.ok(Q > END_TURN_IDLE_MS && Q > 35_000);
});

test('interrupted turn: idle, then quiet -> the waiting calls end abandoned and the turn ends end_turn, once', () => {
  const { s, b, clock } = mk();
  const steps = [b.userInput(), b.planner({ thinking: 'Look first.', calls: [call.viewFile(), call.runCommand('npm test')] }), b.result()];
  const pos = linePositions(steps);
  run(s, steps);
  s.setInfo({ status: 'running' });
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'not final: nothing at once');
  assert.deepEqual(s.idle(clock.t + Q - 1), []);
  const evs = s.idle(clock.t + Q);
  assert.deepEqual(noTs(evs), [
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 1), ok: false, errorKind: 'abandoned', error: 'no result' },
    { type: 'turn_end', sessionId: AG_ID, reason: 'end_turn' },
  ]);
  assert.equal(evs[1].ts, new Date(clock.t + Q).toISOString(), 'stamped at the idle() time');
  assert.deepEqual(s.idle(clock.t + 10 * Q), [], 'once');
  assert.deepEqual(openTools(s), [], 'the snapshot has no open call');
  assert.equal(s.debugState().turnOpen, false);
  assert.deepEqual(s.debugState().antigravity.pending, []);
  assert.equal(s.ended, false, 'a main never ends by itself');
  // A late result line has nothing left to pair with; the next request starts a new turn without a second turn_end.
  assert.deepEqual(run(s, [b.result({ status: 'ERROR', error: 'cancelled' })]), []);
  const next = run(s, [b.userInput('Try again')]);
  assert.deepEqual(of(next, 'turn_end'), []);
  assert.deepEqual(of(next, 'prompt').map((e) => e.text), ['Try again']);
});

test('the quiet time counts from the later of the last line and the idle delivery', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.viewFile(), call.grep()] })]);
  clock.t += 30_000;
  s.setInfo({ status: 'idle' }); // 30 s after the last line
  assert.deepEqual(s.idle(clock.t + Q - 1), [], 'counted from the delivery, not from the line');
  clock.t += 10_000;
  run(s, [b.result()]); // a line after the delivery: the clock starts again
  assert.deepEqual(s.idle(clock.t + Q - 1), []);
  assert.deepEqual(of(s.idle(clock.t + Q), 'turn_end').map((e) => e.reason), ['end_turn']);
});

test('a turn that gave up after an error: ERROR_MESSAGE closed the calls, idle then ends the turn', () => {
  const { s, b, clock } = mk();
  const evs = run(s, [b.userInput(), b.planner({ calls: [call.readFile()] }), b.errorMessage()]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => e.errorKind), ['abandoned']);
  s.setInfo({ status: 'idle' });
  assert.deepEqual(noTs(s.idle(clock.t + Q)), [{ type: 'turn_end', sessionId: AG_ID, reason: 'end_turn' }]);
});

test('a thinking-only last line (no answer, no calls) is closed the same way', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ thinking: 'Considering the options.' })]);
  s.setInfo({ status: 'idle' });
  assert.deepEqual(of(s.idle(clock.t + Q), 'turn_end').map((e) => e.reason), ['end_turn']);
});

test('no close: without an idle delivery, or when running, a planner line with calls or USER_INPUT came after it', () => {
  const cases = {
    no_idle: () => {},
    running: (s) => s.setInfo({ status: 'running' }),
    planner_calls: (s, b) => run(s, [b.planner({ calls: [call.listDir()] })]),
    user_input: (s, b) => run(s, [b.userInput('Next')]),
  };
  for (const [name, after] of Object.entries(cases)) {
    const { s, b, clock } = mk();
    run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] })]);
    if (name !== 'no_idle') s.setInfo({ status: 'idle' });
    after(s, b);
    assert.deepEqual(s.idle(clock.t + 10 * Q), [], name);
    assert.equal(s.debugState().turnOpen, true, `${name}: the turn stays open`);
    assert.equal(openTools(s).length, name === 'user_input' ? 0 : 1, `${name}: a call still waits (USER_INPUT closed it)`);
  }
});

test('finding 7 keeps its fast path: a closing answer right after the idle ends the turn at that answer, not again later', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.result()]);
  s.setInfo({ status: 'idle' });
  clock.t += 5_000;
  const evs = run(s, [b.planner({ content: 'All done.' })]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
  assert.deepEqual(s.idle(clock.t + 10 * Q), []);
});

test('attach: an interrupted turn replayed from an old file closes once the delivered idle has stood for the quiet time', () => {
  const { s, b, clock } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile(), call.grep()] }), b.result()];
  const pos = linePositions(steps);
  assert.deepEqual(run(s, steps, { replay: true }), []);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'state only before the replay ends');
  assert.deepEqual(s.idle(SERVER_T), [], 'the Runner attach idle(): the delivery is now, so not yet');
  assert.deepEqual(openTools(s), [tid(pos[1], 1)]);
  const evs = s.idle(clock.t + Q);
  assert.deepEqual(noTs(evs).map((e) => [e.type, e.toolUseId ?? e.reason]), [['tool_end', tid(pos[1], 1)], ['turn_end', 'end_turn']]);
  assert.deepEqual(openTools(s), []);
});

test('a schedule call closed this way leaves the lounge set; a later planner line reopens the turn as usual', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.schedule()] })]);
  s.setInfo({ status: 'idle' });
  assert.deepEqual(of(s.idle(clock.t + Q), 'tool_end').map((e) => e.errorKind), ['abandoned']);
  clock.t += Q;
  const evs = run(s, [b.planner({ content: 'Woke up.', calls: [call.viewFile()] })]);
  assert.deepEqual(evs.map((e) => e.type), ['say', 'tool_start']);
  assert.equal(of(evs, 'tool_start')[0].room, 'archive');
  assert.equal(s.debugState().turnOpen, true, 'work after a closed turn reopens it (4.0.2)');
});
