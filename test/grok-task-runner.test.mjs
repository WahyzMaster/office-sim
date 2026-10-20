// A Grok child folder attached as a main because its parent named it (subagents/<id>/) only after the link grace
// (CONTRACT 4.6, 4.0.2 Prompts): its summary.json says session_kind subagent, and from then on its human text, the
// parent's model-written task, is never a prompt event or a title (the fallback it already took is dropped).
// Synthetic records only (test/fixtures/grok.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { createGrokBuilder, GROK_SESSION } from './fixtures/grok.mjs';

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
function mk() {
  const s = new GrokSession({ id: `grok-${GROK_SESSION}`, kind: 'main', now: () => T0 });
  return { s, g: createGrokBuilder({ sessionId: GROK_SESSION }) };
}
const run = (s, recs, opts) => recs.flatMap((r) => s.apply(r, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const types = (evs) => evs.map((e) => e.type);

test('setInfo subagent flag (summary.json session_kind) on a session attached as main: the task prompt is never a prompt or a title (finding 4)', () => {
  // 부모가 subagents/<id>/ 를 늦게 만들어 메인으로 붙은 자식: 첫 리플레이 뒤에 메타 파일이 자식이라고 알려 준다
  const { s, g } = mk();
  const task = 'Investigate the auth flow in /Users/someone/clients/acme TASK-BAIT';
  run(s, [g.hook({ event: 'session_start' }), g.hook(), g.userMessage({ text: task, newTurn: false }), g.thought('Reading.')], { replay: true });
  assert.match(s.title, /^Investigate the auth flow/, 'before the flag the first human text is the title fallback');
  const evs = s.setInfo({ subagent: true, agentType: 'explore' });
  assert.deepEqual(types(evs), ['session'], 'one corrected session event');
  assert.equal(evs[0].title, GROK_SESSION.slice(0, 8), 'the id fallback, never the task');
  assert.equal(s.title, GROK_SESSION.slice(0, 8));
  // later human text of that session is the parent's model-written follow-up: no prompt, no title
  const later = run(s, [g.message('Found it.'), g.turnCompleted(), g.userMessage({ text: 'Follow-up TASK-BAIT 2' }), g.hook(), g.thought('Ok.')]);
  assert.equal(of(later, 'prompt').length, 0);
  assert.doesNotMatch(JSON.stringify([...evs, ...later, ...s.snapshotEvents()]), /TASK-BAIT|acme|Investigate/);
  // a generated_title still wins; the flag on a real sub changes nothing
  assert.equal(s.setInfo({ title: 'Auth flow review' })[0].title, 'Auth flow review');
  const { s: plain, g: g2 } = mk();
  const live = run(plain, [g2.userMessage({ text: 'Human prompt' }), g2.hook()]);
  assert.equal(of(live, 'prompt').length, 1, 'without the flag a main prompt still goes out');
});
