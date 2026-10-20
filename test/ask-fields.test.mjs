// Shared askFields (src/session-util.mjs, R33): the question text of an ask tool_start never is a bare " (+N)" (CONTRACT
// 2: a question needs text). Regression for the follow-up of #9/#10: when the first of several questions cleaned to an
// empty string, the event carried question " (+N)". The lead question is now the first one with text, its option labels
// are the options, and " (+N)" (the other questions) is added only behind a lead. Every adapter that shows ask tools
// goes through this one function: Claude (toolStart, AskUserQuestion), and through SessionCore askOf the Grok
// (ask_user_question), Codex (request_user_input) and Antigravity (ask_question) adapters, so each path has a test.
// Synthetic records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askFields } from '../src/session-util.mjs';
import { SessionState } from '../src/session.mjs';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { CodexSession } from '../src/adapters/codex/session.mjs';
import { AntigravitySession } from '../src/adapters/antigravity/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';
import { createGrokBuilder, GROK_SESSION } from './fixtures/grok.mjs';
import { createCodexBuilder, CODEX_THREAD } from './fixtures/codex.mjs';
import { createAntigravityBuilder, call, AG_ID } from './fixtures/antigravity.mjs';

// Texts that clean to '' (cleanText): empty, blanks, a zero-width space, a control character, line breaks.
const EMPTY_TEXTS = ['', '   ', '​', '\u0007', '\n\n'];

const asks = (evs) => evs.filter((e) => e.type === 'tool_start' && 'question' in e);
const pair = (ev) => [ev.question, ev.options];
function assertQuestionShape(ev) {
  assert.ok(ev.question === null || (typeof ev.question === 'string' && !ev.question.startsWith(' (+') && ev.question.trim() !== ''),
    `question ${JSON.stringify(ev.question)} has text or is null`);
}

// ---------------------------------------------------------------------------------------------- the function

test('askFields: a first question that cleans to empty gives the lead to the next question with text, with its options', () => {
  for (const blank of EMPTY_TEXTS) {
    const f = askFields({ questions: [{ question: blank, options: ['A'] }, { question: 'Which layout?', options: ['Grid', { label: 'List' }] }] });
    assert.deepEqual(pair(f), ['Which layout? (+1)', ['Grid', 'List']], JSON.stringify(blank));
  }
  const three = askFields({ questions: [{ question: '' }, { question: '  ', options: ['x'] }, { question: 'Third?', options: [] }] });
  assert.deepEqual(pair(three), ['Third? (+2)', []], '(+N) counts every other question, also the empty ones');
  const later = askFields({ questions: [{ question: 'First?', options: ['a'] }, { question: '' }, { question: 'Third?' }] });
  assert.deepEqual(pair(later), ['First? (+2)', ['a']], 'a first question with text keeps the lead (unchanged)');
});

test('askFields: no question with text -> question null (never " (+N)"); the options stay those of the first question', () => {
  assert.deepEqual(pair(askFields({ questions: [{ question: '', options: ['A', 'B'] }, { question: ' ', options: ['C'] }] })), [null, ['A', 'B']]);
  assert.deepEqual(pair(askFields({ questions: [{ question: '​', options: ['A'] }] })), [null, ['A']], 'one question (unchanged)');
  assert.deepEqual(pair(askFields({ questions: [{ options: ['A'] }, { question: 42 }] })), [null, ['A']], 'non-string texts are empty');
  assert.deepEqual(pair(askFields({ questions: [] })), [null, []]);
  assert.deepEqual(pair(askFields(null)), [null, []]);
});

// ---------------------------------------------------------------------------------------------- Claude (SessionState)

test('Claude AskUserQuestion: an empty first question does not leave " (+N)" in the tool_start or the snapshot', () => {
  const sid = '33333333-3333-4333-8333-333333333333';
  const b = createRecordBuilder({ sessionId: sid, cwd: '/tmp/office-sim-fixture/repo' });
  const s = new SessionState({ id: sid, file: '/tmp/office-sim-fixture/x.jsonl', kind: 'main', stem: sid, now: () => Date.UTC(2026, 0, 1) });
  const qs = [{ question: '   ', header: 'One', options: [{ label: 'A' }] },
    { question: 'Which layout should the demo use?', header: 'Two', options: [{ label: 'Grid' }, { label: 'List' }] }];
  const evs = [b.humanPrompt(), b.askUse({ msgId: 'm1', id: 'ask1', questions: qs })].flatMap((r) => s.apply(r));
  const [ask] = asks(evs);
  assertQuestionShape(ask);
  assert.deepEqual(pair(ask), ['Which layout should the demo use? (+1)', ['Grid', 'List']]);
  assert.deepEqual(pair(asks(s.snapshotEvents())[0]), pair(ask));
  const none = [b.askUse({ msgId: 'm2', id: 'ask2', questions: [{ question: '', options: [] }, { question: '​', options: [] }] })]
    .flatMap((r) => s.apply(r));
  assert.deepEqual(pair(asks(none)[0]), [null, []]);
});

// ---------------------------------------------------------------------------------------------- Grok

test('Grok ask_user_question: an empty first question does not leave " (+N)"', () => {
  const s = new GrokSession({ id: `grok-${GROK_SESSION}`, agent: 'grok', kind: 'main', now: () => Date.UTC(2026, 9, 20) });
  const g = createGrokBuilder({ sessionId: GROK_SESSION });
  const run = (recs) => recs.flatMap((r) => s.apply(r));
  run([g.userMessage({ text: 'Fix the login bug' }), g.hook()]);
  const evs = run([g.toolCall({ name: 'ask_user_question', input: { questions: [
    { question: '', options: [{ label: 'A', description: 'd' }] },
    { question: 'Which database should we use?', options: [{ label: 'Postgres', description: 'd1' }, { label: 'SQLite', description: 'd2' }] }] } })]);
  const [ask] = asks(evs);
  assertQuestionShape(ask);
  assert.deepEqual(pair(ask), ['Which database should we use? (+1)', ['Postgres', 'SQLite']]);
  // A non-string question text (Grok's questionsOf turns it into '') and nothing else: null, not " (+1)".
  const none = run([g.toolCall({ name: 'ask_user_question', input: { questions: [{ question: 7 }, { question: '  ' }] } })]);
  assert.equal(asks(none)[0].question, null);
});

// ---------------------------------------------------------------------------------------------- Codex

test('Codex request_user_input: an empty first question does not leave " (+N)"', () => {
  const s = new CodexSession({ id: `codex-${CODEX_THREAD}`, agent: 'codex', kind: 'main', now: () => Date.UTC(2026, 9, 20) });
  const g = createCodexBuilder();
  const run = (recs) => recs.flatMap((r) => s.apply(r));
  run([g.sessionMeta(), g.taskStarted(), g.userMessage('Fix the login bug')]);
  const evs = run([g.requestUserInput([
    { id: 'q1', header: 'H1', question: '​', options: [{ label: 'A', description: 'd' }] },
    { id: 'q2', header: 'H2', question: 'Which database should I use?', options: [{ label: 'Postgres', description: 'd' }] }])]);
  const [ask] = asks(evs);
  assertQuestionShape(ask);
  assert.deepEqual(pair(ask), ['Which database should I use? (+1)', ['Postgres']]);
  const none = run([g.requestUserInputAsync([{ title: '   ', options: ['Yes'] }, { title: '' }])]);
  assert.deepEqual(pair(asks(none)[0]), [null, ['Yes']]);
});

// ---------------------------------------------------------------------------------------------- Antigravity

test('Antigravity ask_question: an empty first question does not leave " (+N)"', () => {
  for (const format of ['full', 'truncated']) {
    const s = new AntigravitySession({ id: AG_ID, agent: 'antigravity', kind: 'main', now: () => Date.UTC(2026, 9, 20), facts: { full: format === 'full' } });
    const b = createAntigravityBuilder({ format });
    const evs = [b.userInput(), b.planner({ calls: [call.askQuestion([
      { question: '  ', options: ['A'], is_multi_select: false },
      { question: 'Which database should the session store use?', options: ['Postgres', 'SQLite'], is_multi_select: false }])] })]
      .flatMap((st) => s.apply(st));
    const [ask] = asks(evs);
    assertQuestionShape(ask);
    assert.deepEqual(pair(ask), ['Which database should the session store use? (+1)', ['Postgres', 'SQLite']], format);
  }
});
