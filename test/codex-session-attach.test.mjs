// CodexSession on attach (src/adapters/codex/session.mjs): what the attach replay may and may not decide before the
// Runner announces a file. A parent's SubAgentActivity ends a child only when it is the child's last lifecycle entry
// (v2 multi-agent re-tasks completed children); a 0.154+ fork child attached inside its birth burst waits for its own
// records instead of taking the inherited block as its own; the ordinal dedupe stays O(1) per line on very long files.
// Synthetic records only (test/fixtures/codex.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexSession } from '../src/adapters/codex/session.mjs';
import { createCodexBuilder, cloneRecord, CODEX_THREAD, CODEX_CHILD, CODEX_GRANDCHILD, NEW_VERSION } from './fixtures/codex.mjs';

const MAIN_ID = `codex-${CODEX_THREAD}`;
const CHILD_ID = `codex-${CODEX_CHILD}`;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');

function mk({ version = NEW_VERSION, id = MAIN_ID, kind = 'main', threadId = CODEX_THREAD } = {}) {
  const clock = { t: T0 };
  const s = new CodexSession({ id, agent: 'codex', kind, parentId: kind === 'sub' ? MAIN_ID : null, now: () => clock.t });
  return { s, clock, g: createCodexBuilder({ threadId, cliVersion: version }) };
}
const mkChild = () => mk({ id: CHILD_ID, kind: 'sub', threadId: CODEX_CHILD });
const run = (s, recs, opts) => recs.flat().flatMap((r) => s.apply(r, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const opening = (g, text = 'Fix the login bug') => [g.sessionMeta(), g.taskStarted(), g.userMessage(text)];

test('SubAgentActivity on attach: the last lifecycle entry decides; a re-task after completed (interacted or started) keeps the child', () => {
  const RETASKED = CODEX_CHILD;
  const DONE_TWICE = CODEX_GRANDCHILD;
  const STOPPED = '019a2b3c-2222-7333-8444-555566667777';
  const RESTARTED = '019a2b3c-3333-7444-8555-666677778888';
  const { s, g } = mk();
  const act = (child, ...kinds) => kinds.map((kind) => g.subAgentActivity({ child, kind }));
  const recs = [
    ...opening(g), ...act(RETASKED, 'started', 'completed'), g.collab('followup_task', { target: '/root/BAIT_TARGET' }),
    ...act(RETASKED, 'interacted'), ...act(DONE_TWICE, 'started', 'completed', 'interacted', 'completed'),
    ...act(STOPPED, 'started', 'interrupted'), ...act(RESTARTED, 'completed', 'started'), g.collab('wait_agent'),
  ];
  assert.deepEqual(run(s, recs, { replay: true }), [], 'no end hint while the attach replay runs');
  assert.deepEqual(s.idle(T0).filter((e) => e.hint), [
    { hint: 'end', charId: `codex-${DONE_TWICE}`, reason: 'done' }, { hint: 'end', charId: `codex-${STOPPED}`, reason: 'done' },
  ], 'released when the replay ends, only for children whose last entry is completed / interrupted');
  assert.deepEqual(s.idle(T0 + 1000).filter((e) => e.hint), [], 'once');
  // live, after the replay: a completed ends the child at once (a later re-task is the Store's revive)
  assert.deepEqual(run(s, act(RETASKED, 'completed')).filter((e) => e.hint), [{ hint: 'end', charId: `codex-${RETASKED}`, reason: 'done' }]);
  // a re-attach of the same file (continuation switch, truncation) replays it again with the same answer
  const again = mk();
  run(again.s, [...recs, ...act(RETASKED, 'completed')].map((r) => cloneRecord(r)), { replay: true });
  assert.deepEqual(again.s.idle(T0).filter((e) => e.hint).map((e) => e.charId).sort(),
    [`codex-${DONE_TWICE}`, `codex-${STOPPED}`, `codex-${RETASKED}`].sort());
});

test('history start: a 0.154+ fork child attached inside its birth burst waits for its own records (no fallback)', () => {
  for (const version of ['0.154.0-alpha.3', NEW_VERSION]) {
    const { s } = mkChild();
    const p = createCodexBuilder({ threadId: CODEX_THREAD, cliVersion: version });
    // the inherited block 1..H-1, written at birth before any record of the child's own: the parent's session_meta, a
    // compaction, a parent exec whose output is not written yet, and the spawn call itself
    const inherited = [p.sessionMeta(), p.taskStarted(), p.compacted(), p.exec('await tools.exec_command({ cmd: "BAIT_PARENT_CMD" });'),
      p.spawnAgent(), p.subAgentActivity({ child: CODEX_GRANDCHILD })];
    const c = createCodexBuilder({ threadId: CODEX_CHILD, cliVersion: version });
    const H = 1 + inherited.length;
    const recs = [c.sessionMeta({ sub: { parent: CODEX_THREAD, role: 'explorer', nickname: 'Hume' }, historyStart: H }), ...c.inherit(inherited)];
    assert.deepEqual(run(s, recs, { replay: true }), [], version);
    const settled = s.idle(T0);
    assert.deepEqual(settled.filter((e) => e.hint), [], `${version}: no hint from the inherited block`);
    const st = s.debugState();
    assert.equal(st.codex.hist, 'waiting', version);
    assert.deepEqual(st.open, [], `${version}: the parent's in-flight exec is not the child's open tool`);
    const snap = s.snapshotEvents();
    assert.deepEqual(snap.map((e) => e.type), ['session'], version);
    assert.equal(snap[0].title, 'Hume', `${version}: the child's own meta stays`);
    assert.doesNotMatch(JSON.stringify([snap, settled]), /BAIT/);
    // later inherited copies are dropped, the child's own records apply
    const own = run(s, [c.taskStarted(), c.exec('await tools.exec_command({ cmd: "rg -n auth src" });')]);
    assert.deepEqual(of(own, 'tool_start').map((e) => e.tool), ['exec'], version);
  }
});

test('dedupe scale: the ordinal set costs O(1) per line past 65,536 ordinals and still remembers at least the last 65,536', () => {
  const { s } = mk();
  const rec = (ordinal) => ({ timestamp: '2026-10-20T09:00:00.000Z', ordinal, type: 'event_msg', payload: { type: 'token_count' } });
  const CHUNK = 60_000;
  const timed = (from) => {
    const t = performance.now();
    for (let i = from; i < from + CHUNK; i++) s.apply(rec(i), { replay: true });
    return performance.now() - t;
  };
  const early = timed(0); // below the cap: plain Set inserts
  timed(CHUNK);
  timed(2 * CHUNK);
  const late = timed(3 * CHUNK); // far past the cap: an evicting FIFO would walk its tombstones on every line
  assert.ok(late < Math.max(10 * early, 250), `late chunk ${late.toFixed(0)} ms vs early ${early.toFixed(0)} ms`);
  const last = 4 * CHUNK - 1;
  for (const ord of [last, last - 65_535, 0, 1000]) assert.deepEqual(s.apply(rec(ord), { replay: true }), [], `ordinal ${ord} is a repeat`);
  const g = createCodexBuilder();
  const fresh = cloneRecord(g.taskStarted());
  fresh.ordinal = last + 1;
  assert.deepEqual(s.apply(fresh, { replay: true }), [], 'replay returns hints only');
  assert.equal(s.debugState().turnOpen, true, 'a new ordinal is applied');
});

test('history start (0.154+ wait): a cwd the inherited block gave is dropped with it; the child\'s own turn_context gives its cwd', () => {
  const { s } = mkChild();
  const p = createCodexBuilder({ threadId: CODEX_THREAD, cliVersion: NEW_VERSION, cwd: '/work/BAIT_PARENT_CWD' });
  const inherited = [p.sessionMeta(), p.turnContext(), p.taskStarted(), p.spawnAgent()];
  const c = createCodexBuilder({ threadId: CODEX_CHILD, cliVersion: NEW_VERSION });
  const H = 1 + inherited.length;
  // line 0 without a usable cwd: only a turn_context can give one
  const recs = [c.sessionMeta({ cwd: 'not/absolute', sub: { parent: CODEX_THREAD, role: 'worker' }, historyStart: H }), ...c.inherit(inherited)];
  run(s, recs, { replay: true });
  assert.equal(s.firstCwd, '/work/BAIT_PARENT_CWD', 'provisional while the replay runs');
  s.idle(T0);
  assert.equal(s.firstCwd, null, 'dropped with the inherited block');
  run(s, [c.turnContext({ cwd: '/work/child-own' }), c.taskStarted()]);
  assert.equal(s.firstCwd, '/work/child-own');
  assert.doesNotMatch(JSON.stringify(s.snapshotEvents()), /BAIT/);
});
