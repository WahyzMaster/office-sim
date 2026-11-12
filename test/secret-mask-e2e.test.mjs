// The secret mask end to end (launch readiness W10): the real server on port 0 with a temporary Claude root and an
// invented transcript (test/fixtures/records.mjs). A sample of several shapes sits in every free-text field a
// transcript can show; none of them may be in GET /state, the SSE stream, GET /api/recap or a notifier payload, and the
// marker must be there instead. The samples are built when the test runs (test/fixtures/secret-samples.mjs, D39).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { SECRET_MARKER as M } from '../src/secret-mask.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { sampleSet, hiddenOf } from './fixtures/secret-samples.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '5e5e5e5e-1111-4222-8333-444455556666';
const CWD = '/work/invented-mask';
const NAMED = ['DEPLOY_API_KEY', M].join('='); // what is left of the name-and-value sample

const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });
const line = (rec) => `${JSON.stringify(rec)}\n`;
const ESC = '\u001b';
const hit = (text) => `${ESC}[01;31m${ESC}[K${text}${ESC}[m${ESC}[K`; // how grep --color marks a match
const split = (text, by) => `${text.slice(0, 9)}${by}${text.slice(9)}`; // a character the page never gets, inside a sample

test('a secret in every shown field of a transcript: masked in /state, the SSE stream, /api/recap and the notifier', async () => {
  // one set of samples per field, so that every hidden part is its own string
  const sets = Object.fromEntries(['title', 'prompt', 'thinking', 'say', 'bash', 'grep', 'search', 'ask', 'error', 'plan', 'colour']
    .map((field, i) => [field, sampleSet(100 + i * 10)]));
  const hidden = Object.values(sets).flatMap(hiddenOf);
  assert.equal(new Set(hidden).size, hidden.length, 'every hidden part is different');

  const notified = [];
  const notifyOpts = {
    enabled: true, categories: ['ask', 'error', 'done', 'tool_error'], platform: 'darwin', cooldownMs: 0,
    execFileFn: (_c, _a, _o, cb) => cb(null, 'ok'), onNotify: (n) => notified.push(n),
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-secret-mask-'));
  tmpDirs.push(root);
  const dir = path.join(root, '-work-invented-mask');
  await fs.mkdir(dir, { recursive: true });
  const m = createRecordBuilder({ sessionId: SID, cwd: CWD, startMs: Date.now() - 5000, stepMs: 10 });
  const main = path.join(dir, `${SID}.jsonl`);
  // a control character inside the token of the title, a zero-width space inside the pasted token of the prompt
  await fs.writeFile(main, toJsonl([m.customTitle(`Rotate ${sets.title.named.text} and ${split(sets.title.github.text, '\u0007')}`)]));

  const app = await start({ port: 0, intervalMs: 50, rescanMs: 200, activeMinutes: 30, root, publicDir: PUBLIC, notifyOpts });
  let client;
  try {
    await app.ready;
    const state = async () => {
      const res = await request(app.port, { path: '/state' });
      return { text: res.body, events: JSON.parse(res.body).events };
    };
    await until(async () => (await state()).events.some((e) => e.type === 'session'));
    client = await sse(app.port);
    assert.equal((await client.nextData()).data.type, 'snapshot');

    const ok = (toolUseId) => m.toolResult({ toolUseId, content: 'ok' });
    await fs.appendFile(main, [
      m.humanPrompt({ text: `Deploy with ${split(sets.prompt.github.text, '\u200b')} and ${sets.prompt.named.text}` }),
      m.assistantThinking({ msgId: 'msg_1', text: `The key ${sets.thinking.anthropic.text} is in the notes, with ${sets.thinking.jwt.text}. More.` }),
      m.assistantText({ msgId: 'msg_1', text: `Set ${sets.say.aws.text} and send ${split(sets.say.bearer.text, `${ESC}[0m`)} with it.` }),
      m.bashUse({ msgId: 'msg_2', id: 'toolu_b1', command: `curl -H "${sets.bash.bearer.text}" api.invented.example`, description: `Call with ${sets.bash.bearer.text} and ${sets.bash.aws.text}` }),
      m.toolResult({ toolUseId: 'toolu_b1', isError: true, content: `Error: refused ${sets.error.named.text} for ${sets.error.github.text}\nsecond line ${sets.error.aws.text}` }),
      // the first line of a failed search as grep --color writes it: the highlight stands on the file name, on the
      // name word in front of the sign, on the token prefix and on the scheme word (a line break follows that one)
      m.bashUse({ msgId: 'msg_2b', id: 'toolu_b2', command: 'grep --color=always -rn KEY .', description: 'Search the config' }),
      m.toolResult({ toolUseId: 'toolu_b2', isError: true, content: [
        `${hit('config.js')}${ESC}[36m${ESC}[K:${ESC}[m${ESC}[K3:DEPLOY_${hit('API_KEY')}=${sets.colour.named.hidden}`,
        `${hit(sets.colour.github.text.slice(0, 4))}${sets.colour.github.hidden}`,
        `${hit('Bearer')}\u00a0${sets.colour.bearer.hidden}`,
      ].join(' ') }),
      m.assistantToolUse({ msgId: 'msg_3', id: 'toolu_g1', name: 'Grep', input: { pattern: sets.grep.jwt.text, path: `${CWD}/src` } }),
      ok('toolu_g1'),
      m.assistantToolUse({ msgId: 'msg_4', id: 'toolu_w1', name: 'WebSearch', input: { query: `${sets.search.github.text} revoke ${sets.search.anthropic.text}` } }),
      ok('toolu_w1'),
      m.updatePlanUse({ msgId: 'msg_5', id: 'toolu_p1', input: { items: [
        { content: `Rotate ${sets.plan.jwt.text}`, status: 'in_progress' },
        { content: `Replace ${sets.plan.bearer.text} in CI, then ${sets.plan.named.text}`, status: 'pending' },
      ] } }),
      m.updatePlanResult({ toolUseId: 'toolu_p1', text: 'Plan shown (2 steps).' }),
      m.askUse({ msgId: 'msg_6', id: 'toolu_q1', questions: [{
        question: `Keep ${sets.ask.anthropic.text} or rotate it?`, header: sets.ask.aws.text, multiSelect: false,
        options: [{ label: sets.ask.github.text, description: 'keep' }, { label: sets.ask.named.text, description: 'rotate' }],
      }] }),
    ].map(line).join(''));

    await until(async () => (await state()).events.some((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_q1'), 5000);
    await until(() => client.frames.some((f) => f.data?.type === 'tool_start' && f.data.toolUseId === 'toolu_q1'), 5000);
    const st = await state();
    const live = client.frames.filter((f) => f.data !== null).map((f) => f.data);
    const one = (type, pred = () => true) => {
      const ev = live.find((e) => e.type === type && pred(e));
      assert.ok(ev, `a live ${type} event`);
      return ev;
    };

    // the marker is where each sample was
    assert.equal(one('prompt').text, `Deploy with ${M} and ${NAMED}`);
    assert.equal(one('thinking').text, `The key ${M} is in the notes, with ${M}.`);
    assert.equal(one('say').text, `Set ${M} and send Bearer ${M} with it.`);
    assert.equal(one('tool_start', (e) => e.toolUseId === 'toolu_b1').summary, `Call with Bearer ${M} and ${M}`);
    assert.equal(one('tool_end', (e) => e.toolUseId === 'toolu_b1').error, `Error: refused ${NAMED} for ${M}`);
    assert.equal(one('tool_end', (e) => e.toolUseId === 'toolu_b2').error, `config.js:3:${NAMED} ${M} Bearer ${M}`);
    assert.equal(one('tool_start', (e) => e.toolUseId === 'toolu_g1').summary, `${M} · src`);
    assert.equal(one('tool_start', (e) => e.toolUseId === 'toolu_w1').summary, `${M} revoke ${M}`);
    assert.deepEqual(one('plan').items.map((it) => it.content), [`Rotate ${M}`, `Replace Bearer ${M} in CI, then ${NAMED}`]);
    const ask = one('tool_start', (e) => e.toolUseId === 'toolu_q1');
    assert.equal(ask.question, `Keep ${M} or rotate it?`);
    assert.equal(ask.summary, M);
    assert.deepEqual(ask.options, [M, `${NAMED}`]);
    const title = `Rotate ${NAMED} and ${M}`;
    assert.equal(st.events.find((e) => e.type === 'session').title, title);
    // the snapshot carries the title, the plan and the open question
    assert.deepEqual(st.events.find((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_q1'), ask);
    assert.equal(st.events.find((e) => e.type === 'plan').items.length, 2);

    const recap = await request(app.port, { path: `/api/recap?sessionId=${SID}` });
    const recaps = await request(app.port, { path: '/api/recap' });
    assert.equal(JSON.parse(recap.body).title, title);
    assert.ok(JSON.parse(recaps.body).sessions.some((s) => s.title === title));
    // the notifier: the question, the failed tool (its summary), under the session's title
    const asked = notified.find((n) => n.category === 'ask');
    assert.equal(asked?.body, `Keep ${M} or rotate it?`);
    assert.equal(notified.find((n) => n.category === 'tool_error')?.body, `Call with Bearer ${M} and ${M}`);
    assert.ok(asked.subtitle.includes(M), `the notification subtitle is the scrubbed title: ${asked.subtitle}`);

    // and no hidden part is anywhere on the wire
    const wire = {
      '/state': st.text,
      'the SSE stream': client.frames.map((f) => f.raw).join('\n'),
      '/api/recap?sessionId': recap.body,
      '/api/recap': recaps.body,
      'the notifier payloads': JSON.stringify(notified),
    };
    for (const [what, text] of Object.entries(wire)) {
      assert.ok(text.includes(M), `${what} carries the marker`);
      for (const h of hidden) assert.equal(text.includes(h), false, `a hidden part is in ${what}`);
      // nor a piece of one: the first and the last 12 characters of each
      for (const h of hidden) for (const piece of [h.slice(0, 12), h.slice(-12)]) assert.equal(text.includes(piece), false, `a piece of a hidden part is in ${what}`);
    }
  } finally {
    client?.close();
    await app.close();
  }
});
