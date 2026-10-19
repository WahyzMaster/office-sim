// 세션을 다른 폴더로 옮긴(relocated) 경우 층(project)이 옮긴 폴더를 따라간다. 합성 레코드만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '20202020-1010-4333-8333-333333333333';

function harness() {
  const clock = { t: Date.UTC(2026, 0, 1, 1, 0, 0) };
  const b = createRecordBuilder({ sessionId: SID, cwd: '/tmp/co-fixture/scratch-1', startMs: clock.t });
  const s = new SessionState({ id: SID, file: '/tmp/co-fixture/x.jsonl', kind: 'main', stem: SID, now: () => clock.t });
  const feed = (recs, opt) => recs.flatMap((r) => s.apply(r, opt));
  return { s, b, feed };
}

test('relocated: the session event moves to the relocated folder floor (live)', () => {
  const { s, b, feed } = harness();
  feed([b.humanPrompt()]);
  assert.equal(s.sessionEvent().projectLabel, 'scratch-1');
  const evs = feed([{ type: 'relocated', sessionId: SID, relocatedCwd: '/tmp/co-fixture/my-app' }, b.assistantText({ msgId: 'm1', text: 'hi' })]);
  const sessions = evs.filter((e) => e.type === 'session');
  assert.equal(sessions.length, 1, 'one session update announces the move');
  assert.equal(sessions[0].project, '/tmp/co-fixture/my-app');
  assert.equal(sessions[0].projectLabel, 'my-app');
});

test('relocated into a worktree of a repo groups on the repo floor (replay and snapshot)', () => {
  const { s, b, feed } = harness();
  feed([b.humanPrompt(), { type: 'relocated', sessionId: SID, relocatedCwd: '/tmp/co-fixture/repo/.claude/worktrees/wt-1' }], { replay: true });
  const ev = s.snapshotEvents().find((e) => e.type === 'session');
  assert.equal(ev.project, '/tmp/co-fixture/repo');
  assert.equal(ev.projectLabel, 'repo');
});
