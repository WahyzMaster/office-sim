// Section 5 regressions found by the read-only corpus check (aggregate counts only; fixtures are invented):
// free text in say / thinking / prompt / title / ask / plan / system / tool_end carried full paths, URLs and
// emails. Every event text now goes through the same scrub as tool summaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../src/session.mjs';
import { subTitle } from '../src/store-link.mjs';
import { cleanText } from '../src/summarize.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '7a7a7a7a-1111-4222-8333-444455556666';
const PATH = '/Users/someone/coding/invented-app/src/deep/secret-module.mjs';
const URL = 'https://docs.invented.example/private/page?token=abc123';
const EMAIL = 'person.invented@example.org';
const LEAKS = ['/Users/someone', '/src/deep/', 'token=abc123', '/private/page', EMAIL];

function run(records, kind = 'main') {
  const st = new SessionState({ id: kind === 'main' ? SID : 'a1234567890abcdef', kind, stem: SID, now: () => Date.parse('2026-01-01T00:10:00Z') });
  const events = [];
  for (const r of records) events.push(...st.apply(r));
  return { st, events };
}

function assertClean(events) {
  const blob = JSON.stringify(events.map((e) => ({ ...e, project: undefined })));
  for (const leak of LEAKS) assert.equal(blob.includes(leak), false, `leaked ${leak}`);
}

test('cleanText: path -> basename, URL -> host, email -> (email), then truncate', () => {
  assert.equal(cleanText(`see ${PATH} and ${URL}, mail ${EMAIL}`, 200), 'see secret-module.mjs and docs.invented.example, mail (email)');
  assert.equal(cleanText('x'.repeat(200), 10).length, 10);
  assert.equal(cleanText(42, 10), '');
});

test('say, thinking, prompt and title are scrubbed', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const { st, events } = run([
    b.humanPrompt({ text: `Fix ${PATH} please` }),
    b.assistantThinking({ msgId: 'm1', text: `The bug is in ${PATH}. Then more.` }),
    b.assistantText({ msgId: 'm1', text: `Updated ${PATH}, see ${URL} or ask ${EMAIL}.` }),
  ]);
  const by = (t) => events.find((e) => e.type === t);
  assert.equal(by('prompt').text, 'Fix secret-module.mjs please');
  assert.equal(by('thinking').text, 'The bug is in secret-module.mjs.');
  assert.equal(by('say').text, 'Updated secret-module.mjs, see docs.invented.example or ask (email).');
  assert.equal(st.title, 'Fix secret-module.mjs please');
  assertClean(events);
});

test('custom titles, AskUserQuestion text and options are scrubbed', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const { st, events } = run([
    b.customTitle(`Work on ${PATH}`),
    b.humanPrompt({ text: 'go' }),
    b.askUse({ msgId: 'm1', id: 'toolu_q', questions: [{ question: `Publish to ${URL}?`, header: 'Publish', options: [{ label: EMAIL }, { label: 'No' }] }] }),
  ]);
  assert.equal(st.title, 'Work on secret-module.mjs');
  const ask = events.find((e) => e.type === 'tool_start');
  assert.equal(ask.question, 'Publish to docs.invented.example?');
  assert.deepEqual(ask.options, ['(email)', 'No']);
  assertClean(events);
});

test('plan items (update_plan, tasks) are scrubbed and capped at 80 code points', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const long = '가'.repeat(120);
  const tasks = run([
    b.humanPrompt({ text: 'go' }),
    b.taskCreateUse({ msgId: 'm1', id: 'toolu_t1', subject: `Edit ${PATH}` }),
    b.taskCreateResult({ toolUseId: 'toolu_t1', taskId: '1', subject: `Edit ${PATH}` }),
  ]).events.filter((e) => e.type === 'plan');
  assert.deepEqual(tasks.at(-1).items, [{ content: 'Edit secret-module.mjs', status: 'pending' }]);
  const plan = run([
    b.humanPrompt({ text: 'go' }),
    b.updatePlanUse({ msgId: 'm2', id: 'toolu_p1', input: { items: [{ content: `Read ${URL}`, status: 'in_progress' }, { content: long, status: 'pending' }] } }),
    b.updatePlanResult({ toolUseId: 'toolu_p1', text: 'Plan updated: step 1 of 2 is in progress.' }),
  ]);
  const ev = plan.events.find((e) => e.type === 'plan');
  assert.equal(ev.items[0].content, 'Read docs.invented.example');
  assert.equal([...ev.items[1].content].length, 80);
  assertClean([...tasks, ...plan.events]);
  // snapshot carries the same cleaned items
  assert.deepEqual(plan.st.snapshotEvents().find((e) => e.type === 'plan').items, ev.items);
});

test('tool_end error and synthetic api error text are scrubbed', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const { events } = run([
    b.humanPrompt({ text: 'go' }),
    b.bashUse({ msgId: 'm1', id: 'toolu_b1', command: 'git push', description: 'Push' }),
    b.toolResult({ toolUseId: 'toolu_b1', isError: true, content: `remote rejected for ${EMAIL} at ${URL}` }),
    b.syntheticApiError({ text: `API Error: see ${URL} for ${EMAIL}` }),
  ]);
  const end = events.find((e) => e.type === 'tool_end');
  assert.equal(end.error, 'remote rejected for (email) at docs.invented.example');
  const sys = events.find((e) => e.type === 'system');
  assert.equal(sys.text, 'API Error: see docs.invented.example for (email)');
  assertClean(events);
});

test('tool_start.tool hides a connector account uuid but keeps the shape the browser classifies', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const raw = 'mcp__0b5e2a6c-1234-4abc-9def-0123456789ab__get_issue';
  const { events } = run([b.humanPrompt({ text: 'go' }), b.assistantToolUse({ msgId: 'm1', id: 'toolu_m1', name: raw, input: { id: 'X-1' } })]);
  const ev = events.find((e) => e.type === 'tool_start');
  assert.equal(ev.tool, 'mcp__00000000-0000-0000-0000-000000000000__get_issue');
  assert.match(ev.tool.split('__')[1], /^[0-9a-f-]{20,}$/); // public/js/rooms.js toolLabel -> 'mcp'
  assert.equal(JSON.stringify(events).includes('0b5e2a6c'), false);
  const plain = run([b.assistantToolUse({ msgId: 'm2', id: 'toolu_m2', name: 'mcp__github__get_issue', input: {} })]).events;
  assert.equal(plain.find((e) => e.type === 'tool_start').tool, 'mcp__github__get_issue');
});

test('store subagent titles from meta are scrubbed', () => {
  assert.equal(subTitle({ description: `Audit ${PATH}` }, null, 'a1234567890abcdef'), 'Audit secret-module.mjs');
  assert.equal(subTitle(null, `Check ${URL}`, 'a1234567890abcdef'), 'Check docs.invented.example');
  assert.equal(subTitle(null, null, 'a1234567890abcdef'), 'a1234567890abcdef');
});
