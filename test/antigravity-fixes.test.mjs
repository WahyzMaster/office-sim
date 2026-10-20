// P5e review fixes in the Antigravity normalizer (src/adapters/antigravity/records.mjs, session.mjs):
// - finding 1: CHECKPOINT is not a closer, so a result line that lands after a compaction keeps its real outcome;
// - finding 3: only a top-level <USER_REQUEST> block is the prompt (one nested in ADDITIONAL_METADATA or any other block
//   never reaches prompt or title);
// - finding 7: a summary status 'idle' read before the closing PLANNER_RESPONSE still ends the turn at that answer.
// Synthetic steps only (test/fixtures/antigravity.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntigravitySession } from '../src/adapters/antigravity/session.mjs';
import { CLOSERS, userRequestOf } from '../src/adapters/antigravity/records.mjs';
import { createAntigravityBuilder, call, linePositions, toolId as tid, AG_ID } from './fixtures/antigravity.mjs';

const SERVER_T = Date.UTC(2026, 9, 20, 10, 0, 0);

function mk({ format = 'full' } = {}) {
  const s = new AntigravitySession({ id: AG_ID, agent: 'antigravity', kind: 'main', now: () => SERVER_T, facts: { full: format === 'full' } });
  return { s, b: createAntigravityBuilder({ format }) };
}
const run = (s, steps, opts) => steps.flatMap((st) => s.apply(st, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const noTs = (evs) => evs.map(({ ts, ...rest }) => rest);
const work = (evs) => noTs(evs.filter((e) => e.type !== 'session'));

// ---------------------------------------------------------------------------------------------- finding 1

test('finding 1: CHECKPOINT is not a closer; a result after the checkpoint keeps its outcome (compact, then failed Exit code 1)', () => {
  assert.equal(CLOSERS.has('CHECKPOINT'), false);
  for (const t of ['PLANNER_RESPONSE', 'USER_INPUT', 'ERROR_MESSAGE']) assert.equal(CLOSERS.has(t), true, t);
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.runCommand()] }), b.checkpoint(), b.runResult({ exitCode: 1 }),
    b.planner({ content: 'Fixed.' })];
  const pos = linePositions(steps);
  const evs = work(run(s, steps));
  assert.deepEqual(evs.slice(2, 5), [
    { type: 'system', sessionId: AG_ID, kind: 'compact', text: 'Conversation compacted' },
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: false, errorKind: 'failed', error: 'Exit code 1' },
    { type: 'say', sessionId: AG_ID, text: 'Fixed.' },
  ]);
  assert.equal(s.debugState().antigravity.orphans, 0, 'the late result is paired, not an orphan');
  assert.equal(of(evs, 'tool_end').length, 1, 'no abandoned end for that call');
  assert.equal(s.debugState().turnOpen, true);
});

test('finding 1: a call with no result after a checkpoint ends abandoned at the next planner line (after the compact)', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile(), call.writeFile()] }), b.result(), b.checkpoint(),
    b.planner({ content: 'Done.' })];
  const pos = linePositions(steps);
  const evs = work(run(s, steps)).filter((e) => e.type === 'system' || e.type === 'tool_end');
  assert.deepEqual(evs, [
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: true },
    { type: 'system', sessionId: AG_ID, kind: 'compact', text: 'Conversation compacted' },
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 1), ok: false, errorKind: 'abandoned', error: 'no result' },
  ]);
});

test('finding 1: unreadable tool_calls keep skipping result lines past a checkpoint, until a real closer', () => {
  const { s, b } = mk({ format: 'truncated' });
  const cut = { ...b.planner({ content: 'Writing.' }), tool_calls: '[{"name":"write_to_file","args":{"TargetFile":"\\"/Users/agt' };
  const steps = [b.userInput(), cut, b.checkpoint(), b.result(), b.result(), b.planner({ calls: [call.listDir()] }), b.result()];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.toolUseId, e.ok]), [[tid(pos[5], 0), true]]);
  assert.equal(s.debugState().antigravity.orphans, 0, 'results of the unreadable line after the checkpoint are swallowed, not orphans');
});

// ---------------------------------------------------------------------------------------------- finding 3

const LEAKS = [
  '<USER_REQUEST>\n\n</USER_REQUEST><ADDITIONAL_METADATA>\nActive document excerpt: const t = "<USER_REQUEST>LEAK_META_SECRET</USER_REQUEST>";\n</ADDITIONAL_METADATA>',
  '<ADDITIONAL_METADATA>Selected: <USER_REQUEST>LEAK_META_FIRST</USER_REQUEST></ADDITIONAL_METADATA>',
  'The user template.\n<USER_REQUEST></USER_REQUEST><ADDITIONAL_METADATA>Selected: "<USER_REQUEST attr="1">LEAK_ATTR</USER_REQUEST>"</ADDITIONAL_METADATA>',
  '<PLAN>step: <USER_REQUEST>LEAK_PLAN</USER_REQUEST></PLAN>',
  '<USER_SETTINGS_CHANGE>x <USER_REQUEST>LEAK_SETTINGS</USER_REQUEST></USER_SETTINGS_CHANGE><USER_REQUEST> </USER_REQUEST>',
  '<ADDITIONAL_METADATA>never closed <USER_REQUEST>LEAK_UNCLOSED</USER_REQUEST>',
];

test('finding 3: a USER_REQUEST nested in ADDITIONAL_METADATA, PLAN or any other block is never the prompt', () => {
  for (const c of LEAKS) assert.equal(userRequestOf(c), null, c);
});

test('finding 3: top-level blocks still work (metadata first, an empty block then a second one, attributes, a cut block)', () => {
  assert.equal(userRequestOf('<USER_REQUEST>real</USER_REQUEST><ADDITIONAL_METADATA><USER_REQUEST>X</USER_REQUEST></ADDITIONAL_METADATA>'), 'real');
  assert.equal(userRequestOf('<ADDITIONAL_METADATA>m <USER_REQUEST>X</USER_REQUEST></ADDITIONAL_METADATA><USER_REQUEST>Run it</USER_REQUEST>'), 'Run it');
  assert.equal(userRequestOf('<USER_REQUEST> </USER_REQUEST><PLAN>p</PLAN><USER_REQUEST attr="2">Second</USER_REQUEST>'), 'Second');
  assert.equal(userRequestOf('<USER_REQUEST>Cut by<ADDITIONAL_METADATA>BAIT</ADDITIONAL_METADATA>'), 'Cut by');
  assert.equal(userRequestOf('text <USER_REQUEST>Inline</USER_REQUEST>'), 'Inline');
});

test('finding 3: session level, an empty top-level block with a nested one gives no prompt and keeps the id title fallback', () => {
  for (const raw of LEAKS) {
    const { s, b } = mk();
    const evs = run(s, [b.userInput('', { raw }), b.planner({ content: 'Hello.' })]);
    s.idle(SERVER_T);
    assert.deepEqual(of(evs, 'prompt'), [], raw);
    assert.equal(s.title, '3f6c2a1e', 'the 8-char id fallback, never the nested text');
    assert.doesNotMatch(JSON.stringify([evs, s.snapshotEvents(), s.sessionEvent(), s.debugState()]), /LEAK/);
    assert.equal(s.debugState().turnOpen, true, 'the turn still starts');
  }
});

// ---------------------------------------------------------------------------------------------- finding 7

test('finding 7: idle read while calls wait, then the closing answer: the turn ends at that answer', () => {
  const { s, b } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] })]);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'calls are running: nothing yet');
  assert.equal(s.debugState().antigravity.idleSeen, true);
  const evs = run(s, [b.result(), b.planner({ content: 'All done.' })]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
  assert.ok(evs.findIndex((e) => e.type === 'say') < evs.findIndex((e) => e.type === 'turn_end'), 'after the answer');
  assert.equal(s.debugState().turnOpen, false);
  assert.equal(s.debugState().antigravity.idleSeen, false);
});

test('finding 7: idle read after the results but before the closing planner line also ends the turn at that line', () => {
  const { s, b } = mk();
  run(s, [b.userInput(), b.planner({ thinking: 'Look.', calls: [call.viewFile()] }), b.result()]);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'the last work had calls: not final yet');
  const evs = run(s, [b.planner({ content: 'Here it is.' })]);
  assert.deepEqual(noTs(of(evs, 'turn_end')), [{ type: 'turn_end', sessionId: AG_ID, reason: 'end_turn' }]);
});

test('finding 7: the early-idle flag is cleared by USER_INPUT, by running, and by a planner line with calls', () => {
  const clears = {
    user_input: (s, b) => run(s, [b.userInput('Next')]),
    running: (s) => s.setInfo({ status: 'running' }),
    planner_calls: (s, b) => run(s, [b.planner({ calls: [call.listDir()] }), b.result()]),
    planner_unreadable: (s, b) => run(s, [{ ...b.planner({ content: 'w' }), tool_calls: '[{"name":' }, b.result()]),
  };
  for (const [name, clear] of Object.entries(clears)) {
    const { s, b } = mk();
    run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.result()]);
    s.setInfo({ status: 'idle' });
    clear(s, b);
    assert.equal(s.debugState().antigravity.idleSeen, false, name);
    const evs = run(s, [b.planner({ content: 'Answer.' })]);
    assert.deepEqual(of(evs, 'turn_end'), [], `${name}: no early end`);
    assert.equal(s.debugState().endTurnArmed, true, `${name}: the quiet-time fallback still applies`);
  }
});

test('finding 7: a stale idle never cuts a working turn; a planner with only thinking keeps the flag', () => {
  const { s, b } = mk();
  run(s, [b.userInput(), b.planner({ thinking: 'Working.' })]);
  assert.deepEqual(s.setInfo({ status: 'idle' }), []);
  assert.deepEqual(of(run(s, [b.planner({ thinking: 'Still thinking.' })]), 'turn_end'), []);
  assert.equal(s.debugState().antigravity.idleSeen, true);
  assert.deepEqual(of(run(s, [b.planner({ content: 'Done.' })]), 'turn_end').map((e) => e.reason), ['end_turn']);
});

test('finding 7: an idle delivered with the attach (before the replay ended) ends the turn at the first live answer', () => {
  const { s, b } = mk();
  assert.deepEqual(run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.result()], { replay: true }), []);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'state only before the replay ends');
  s.idle(SERVER_T);
  const evs = run(s, [b.planner({ content: 'Live answer.' })]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
});
