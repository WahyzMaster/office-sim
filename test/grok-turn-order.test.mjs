// GrokSession turn order as the real Grok Build logs write it (found by the read-only counts check against ~/.grok,
// CONTRACT 4.6): the user_prompt_submit hook (with the new prompt_id) comes BEFORE the user_message_chunk in most turns and
// is the first record of every subagent file; a human message without promptIndex can be typed mid-turn; a turn may carry
// its message twice around the hook. None of these may drop the turn's work as late records or split the turn.
// Synthetic records only (test/fixtures/grok.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { createGrokBuilder, out, GROK_SESSION, GROK_CHILD } from './fixtures/grok.mjs';

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
function mk({ kind = 'main', uuid = GROK_SESSION } = {}) {
  const s = new GrokSession({ id: `grok-${uuid}`, kind, parentId: kind === 'sub' ? `grok-${GROK_SESSION}` : null, now: () => T0 });
  const items = [];
  const orig = s.core.apply.bind(s.core);
  s.core.apply = (it, o) => {
    items.push(it.k);
    return orig(it, o);
  };
  return { s, items, g: createGrokBuilder({ sessionId: uuid }) };
}
const run = (s, recs) => recs.flatMap((r) => s.apply(r));
const of = (evs, type) => evs.filter((e) => e.type === type);
const ends = (evs) => Object.fromEntries(of(evs, 'tool_end').map((e) => [e.toolUseId, e.errorKind ?? 'ok']));
// The real order: the hook with the new prompt id first, then the message (no promptId on it).
const hookFirst = (g, text, o = {}) => {
  g.newPrompt();
  return [g.hook(), g.userMessage({ text, newTurn: false, ...o })];
};

test('hook before message (real order): one turn per prompt, its work is kept, turn_start comes before the prompt', () => {
  const { s, items, g } = mk();
  const recs = [g.hook({ event: 'session_start' }), ...hookFirst(g, 'Fix the login bug'), g.thought('Read first.'),
    g.toolCall({ name: 'read_file', input: { target_file: '/w/a.txt' } })];
  const read = g.lastToolId;
  recs.push(g.toolDone({ output: out.readFile() }), g.message('Fixed.'), g.turnCompleted(), g.hook({ event: 'stop' }));
  recs.push(...hookFirst(g, 'Now add a test'), g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' } }));
  const shell = g.lastToolId;
  recs.push(g.toolDone({ output: out.bash({ exitCode: 0 }) }), g.message('Tests pass.'), g.turnCompleted());
  const evs = run(s, recs);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug', 'Now add a test']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn', 'end_turn'], 'no next_turn split');
  assert.deepEqual(ends(evs), { [read]: 'ok', [shell]: 'ok' });
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Fixed.', 'Tests pass.']);
  assert.equal(of(evs, 'thinking').length, 1);
  assert.deepEqual(items.filter((k) => k === 'turn_start' || k === 'prompt'), ['turn_start', 'prompt', 'turn_start', 'prompt']);
  assert.equal(s.debugState().grok.late, 0);
});

test('a subagent file starts with the user_prompt_submit hook: the parent task message and the work stay in that turn', () => {
  const { s, g } = mk({ kind: 'sub', uuid: GROK_CHILD });
  const recs = [...hookFirst(g, 'Explore the repo for callers'), g.thought('Search.'),
    g.toolCall({ name: 'grep', input: { pattern: 'login', path: '/w/src' } })];
  const grep = g.lastToolId;
  recs.push(g.toolDone({ output: out.grep() }), g.message('Found 3 callers.'), g.turnCompleted());
  const evs = run(s, recs);
  assert.deepEqual(ends(evs), { [grep]: 'ok' });
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Found 3 callers.']);
  assert.equal(s.debugState().grok.late, 0);
});

test('a human message without promptIndex typed mid-turn stays in the turn: no split, the running tool still ends ok', () => {
  const { s, g } = mk();
  const recs = [...hookFirst(g, 'Refactor the auth module'), g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' } })];
  const shell = g.lastToolId;
  recs.push(g.userMessage({ text: 'Also keep the old API', newTurn: false, promptIndex: null })); // 실제 기록: promptIndex 없음
  recs.push(g.toolDone({ output: out.bash() }), g.message('Kept it.'), g.turnCompleted());
  const evs = run(s, recs);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Refactor the auth module', 'Also keep the old API']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
  assert.deepEqual(ends(evs), { [shell]: 'ok' });
  assert.equal(s.debugState().grok.late, 0);
});

test('a message written before and after its hook is one turn (no work yet), not two', () => {
  const { s, g } = mk();
  const evs = run(s, [
    g.userMessage({ text: 'Deploy the preview' }), g.hook(), g.userMessage({ text: 'Deploy the preview', newTurn: false }),
    g.thought('Check the config.'), g.message('Deployed.'), g.turnCompleted(),
  ]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Deployed.']);
  assert.equal(s.debugState().grok.late, 0);
});

test('safety net: when a message opened a turn but the running turn goes on under its old id, the work is adopted, not dropped', () => {
  const { s, g } = mk();
  const recs = [...hookFirst(g, 'Long task'), g.thought('Step one.')];
  const pA = g.promptId;
  recs.push(g.userMessage({ text: 'Unexpected indexed message', newTurn: false, promptIndex: 7 }));
  recs.push(g.toolCall({ name: 'read_file', input: { target_file: '/w/b.txt' }, promptId: pA }));
  const read = g.lastToolId;
  recs.push(g.toolDone({ output: out.readFile(), promptId: pA }), g.message('Step two done.', { promptId: pA }), g.turnCompleted({ promptId: pA }));
  const evs = run(s, recs);
  assert.deepEqual(ends(evs), { [read]: 'ok' });
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Step two done.']);
  assert.equal(of(evs, 'turn_end').at(-1).reason, 'end_turn', 'the turn_completed of the old id ends the open turn');
  assert.equal(s.debugState().grok.late, 0);
});

test('real late records after turn_completed are still dropped; a cancelled turn redirected to a new prompt keeps both turns apart', () => {
  const { s, g } = mk();
  const recs = [...hookFirst(g, 'First'), g.message('Done.'), g.turnCompleted(), g.thought('Late afterthought.')];
  // cancel_then_send: the new prompt's hook arrives while the old turn still runs, then the old turn's cancel
  recs.push(...hookFirst(g, 'Slow task'), g.toolCall({ name: 'run_terminal_command', input: { command: 'sleep 100' } }));
  const slow = g.lastToolId;
  const pSlow = g.promptId;
  recs.push(...hookFirst(g, 'Do this instead'), g.turnCompleted({ stopReason: 'cancelled', promptId: pSlow }));
  recs.push(g.toolCall({ name: 'list_dir', input: { target_directory: '/w' } }));
  const list = g.lastToolId;
  recs.push(g.toolDone({ output: { type: 'ListDir', ListDir: { entries: 2 } } }), g.turnCompleted());
  const evs = run(s, recs);
  assert.ok(!of(evs, 'thinking').some((e) => e.text.startsWith('Late')), 'the thought after turn_completed is dropped');
  assert.equal(s.debugState().grok.late, 1);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['First', 'Slow task', 'Do this instead']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn', 'next_turn', 'end_turn']);
  assert.deepEqual(ends(evs), { [slow]: 'abandoned', [list]: 'ok' });
});
