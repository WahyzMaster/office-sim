// The secret mask in every other source of events (launch readiness W10, D34): Codex, Grok, Antigravity, the Gemini
// CLI plug-in, a session only hooks report, the Grok Bot title and a long plan line. Each test puts a sample in the
// free-text fields that source shows and checks that the marker is there instead. Existing fixture builders only
// (test/fixtures/); the samples are built when the test runs (test/fixtures/secret-samples.mjs, D39).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SECRET_MARKER as M } from '../src/secret-mask.mjs';
import { CodexSession } from '../src/adapters/codex/session.mjs';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { scanGrokDesktopBot } from '../src/adapters/grok/desktop-bot.mjs';
import { AntigravitySession } from '../src/adapters/antigravity/session.mjs';
import { parseTaskMd } from '../src/adapters/antigravity/meta.mjs';
import { GeminiCliSession } from '../src/adapters/gemini-cli/session.mjs';
import { parseClaudeHookPayload } from '../src/hooks-receiver.mjs';
import { planFromMarkdown } from '../src/plan.mjs';
import { SessionState } from '../src/session.mjs';
import { toolLabel } from '../src/summarize.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';
import { createCodexBuilder, CODEX_THREAD, OLD_VERSION } from './fixtures/codex.mjs';
import { createGrokBuilder, out as grokOut, GROK_SESSION } from './fixtures/grok.mjs';
import { createAntigravityBuilder, call, AG_ID } from './fixtures/antigravity.mjs';
import { sampleSet, hiddenOf, chars, LOWER } from './fixtures/secret-samples.mjs';

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const NAMED = ['DEPLOY_API_KEY', M].join('='); // what is left of the name-and-value sample
const of = (evs, type) => evs.filter((e) => e.type === type);
const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }); });

/** No hidden part of the set, nor its first or last 12 characters, is in what the session sent or would send again. */
function assertHidden(set, ...shown) {
  const text = JSON.stringify(shown);
  assert.ok(text.includes(M), 'the marker is there');
  for (const h of hiddenOf(set)) {
    for (const piece of [h, h.slice(0, 12), h.slice(-12)]) assert.equal(text.includes(piece), false, 'a hidden part is shown');
  }
}

test('Codex: prompt, reasoning summary, reply, plan step, question, option and index title are masked', () => {
  const set = sampleSet(210);
  const g = createCodexBuilder({ threadId: CODEX_THREAD, cliVersion: OLD_VERSION });
  const s = new CodexSession({ id: `codex-${CODEX_THREAD}`, agent: 'codex', kind: 'main', now: () => T0, file: '/tmp/x', stem: 'x' });
  const evs = [
    g.sessionMeta(), g.taskStarted(), g.userMessage(`Deploy with ${set.github.text}`),
    ...g.think(`The key ${set.anthropic.text} is set. More.`), ...g.say(`Sending ${set.bearer.text} now`),
    g.updatePlan([{ step: `Rotate ${set.jwt.text}`, status: 'in_progress' }]), g.functionOutput(),
    g.requestUserInput([{ id: 'q1', header: 'h', question: `Keep ${set.aws.text}?`, options: [{ label: set.named.text, description: 'd' }] }]),
  ].flatMap((r) => s.apply(r));
  evs.push(...s.setInfo({ title: `Rotate ${set.github.text}` }));
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), [`Deploy with ${M}`]);
  assert.deepEqual(of(evs, 'thinking').map((e) => e.text), [`The key ${M} is set.`]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), [`Sending Bearer ${M} now`]);
  assert.deepEqual(of(evs, 'plan').map((e) => e.items.map((it) => it.content)), [[`Rotate ${M}`]]);
  const ask = of(evs, 'tool_start').at(-1);
  assert.deepEqual([ask.question, ask.options], [`Keep ${M}?`, [NAMED]]);
  assert.equal(s.title, `Rotate ${M}`);
  assertHidden(set, evs, s.snapshotEvents());
});

test('Grok: prompt, thought, reply, plan entry, question, option, error line and summary title are masked', () => {
  const set = sampleSet(220);
  const g = createGrokBuilder({ sessionId: GROK_SESSION });
  const s = new GrokSession({ id: `grok-${GROK_SESSION}`, agent: 'grok', kind: 'main', now: () => T0, file: '/tmp/x', stem: 'x' });
  const evs = [
    g.userMessage({ text: `Deploy with ${set.github.text}` }), g.hook(),
    g.thought(`The key ${set.anthropic.text} is set. More.`), g.message(`Sending ${set.bearer.text} now`),
    g.plan([{ content: `Rotate ${set.jwt.text}`, status: 'in_progress' }]),
    g.toolCall({ name: 'run_terminal_command', input: { command: `deploy --token ${set.github.text}` } }),
    g.toolDone({ status: 'failed', output: grokOut.error(`refused ${set.named.text} by the service\nsecond line`, 'Not shown') }),
    g.toolCall({ name: 'ask_user_question', input: { questions: [{ question: `Keep ${set.aws.text}?`, options: [{ label: set.named.text }] }] } }),
  ].flatMap((r) => s.apply(r));
  evs.push(...s.setInfo({ title: `Rotate ${set.github.text}` }));
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), [`Deploy with ${M}`]);
  assert.deepEqual(of(evs, 'thinking').map((e) => e.text), [`The key ${M} is set.`]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), [`Sending Bearer ${M} now`]);
  assert.deepEqual(of(evs, 'plan').map((e) => e.items.map((it) => it.content)), [[`Rotate ${M}`]]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => e.error), [`refused ${NAMED} by the service`]);
  const ask = of(evs, 'tool_start').at(-1);
  assert.deepEqual([ask.question, ask.options], [`Keep ${M}?`, [NAMED]]);
  assert.equal(s.title, `Rotate ${M}`);
  assertHidden(set, evs, s.snapshotEvents());
});

test('Antigravity: request, thinking, answer, search query, question, option, error line, title and task items are masked', () => {
  const set = sampleSet(230);
  const b = createAntigravityBuilder({ format: 'full' });
  const s = new AntigravitySession({
    id: AG_ID, agent: 'antigravity', kind: 'main', now: () => T0 + 3_600_000, file: '/tmp/x', stem: 'x', subMeta: null,
    journalLabel: null, facts: { full: true, base: 'antigravity-cli' },
  });
  const evs = [
    b.userInput(`Deploy with ${set.github.text}`),
    b.planner({ thinking: `The key ${set.anthropic.text} is set. More.`, content: `Sending ${set.bearer.text} now`, calls: [call.searchWeb(`${set.jwt.text} revoke`)] }),
    b.result({ status: 'ERROR', error: `refused ${set.named.text} by the service\nsecond line` }),
    b.planner({ calls: [call.askQuestion([{ question: `Keep ${set.aws.text}?`, options: [set.named.text, 'No'], is_multi_select: false }])] }),
  ].flatMap((st) => s.apply(st));
  evs.push(...s.setInfo({ title: `Rotate ${set.github.text}`, tasks: [{ content: `Replace ${set.jwt.text}`, status: 'pending' }] }));
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), [`Deploy with ${M}`]);
  assert.deepEqual(of(evs, 'thinking').map((e) => e.text), [`The key ${M} is set.`]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), [`Sending Bearer ${M} now`]);
  const [search, ask] = of(evs, 'tool_start');
  assert.equal(search.summary, `${M} revoke`);
  assert.deepEqual(of(evs, 'tool_end').map((e) => e.error), [`refused ${NAMED} by the service`]);
  assert.deepEqual([ask.question, ask.options], [`Keep ${M}?`, [NAMED, 'No']]);
  assert.deepEqual(of(evs, 'plan').map((e) => e.items.map((it) => it.content)), [[`Replace ${M}`]]);
  assert.equal(s.title, `Rotate ${M}`);
  assertHidden(set, evs, s.snapshotEvents());
  // task.md itself: the item text goes to the plan as it is read, and the core masks it (above)
  assert.deepEqual(parseTaskMd(`- [ ] Replace ${set.jwt.text}\n`), [{ content: `Replace ${set.jwt.text}`, status: 'pending' }]);
});

test('Gemini CLI plug-in: prompt, thought, reply, search query, question, todo, tool error and title are masked', () => {
  const set = sampleSet(240);
  const s = new GeminiCliSession({ id: 'gemini-cli-mask-session-1', now: () => T0 });
  const ts = new Date(T0).toISOString();
  const evs = [
    { type: 'session_metadata', cwd: '/work/gemini-repo', title: `Rotate ${set.github.text}`, timestamp: ts },
    { type: 'user', content: `Deploy with ${set.github.text}`, timestamp: ts },
    {
      type: 'gemini', timestamp: ts, content: `Sending ${set.bearer.text} now`,
      thoughts: [{ subject: 'Key', description: `${set.anthropic.text} is set. More.` }],
      toolCalls: [
        { id: 't1', name: 'google_web_search', args: { query: `${set.jwt.text} revoke` }, status: 'error', error: `refused ${set.named.text} by the service` },
        { id: 't2', name: 'write_todos', args: { todos: [{ description: `Replace ${set.jwt.text}`, status: 'pending' }] }, status: 'success' },
        { id: 't3', name: 'ask_user', args: { question: `Keep ${set.aws.text}?`, options: [set.named.text, 'No'] }, status: 'executing' },
      ],
    },
  ].flatMap((r) => s.apply(r));
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), [`Deploy with ${M}`]);
  assert.deepEqual(of(evs, 'thinking').map((e) => e.text), [`Key: ${M} is set.`]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), [`Sending Bearer ${M} now`]);
  const [search, ask] = of(evs, 'tool_start');
  assert.equal(search.summary, `${M} revoke`);
  assert.deepEqual(of(evs, 'tool_end').filter((e) => !e.ok).map((e) => e.error), [`refused ${NAMED} by the service`]);
  assert.deepEqual(of(evs, 'plan').map((e) => e.items.map((it) => it.content)), [[`Replace ${M}`]]);
  assert.deepEqual([ask.question, ask.options], [`Keep ${M}?`, [NAMED, 'No']]);
  assert.equal(s.title, `Rotate ${M}`);
  assertHidden(set, evs, s.snapshotEvents());
});

test('a session only hooks report: the command description, a search query, a subagent type of token shape and the title are masked', () => {
  const set = sampleSet(250);
  const activeHookTools = new Map();
  const hook = (hook_event_name, extra = {}) => parseClaudeHookPayload(
    { session_id: 'hook-only-mask-1', hook_event_name, ...extra }, { activeHookTools, now: () => T0 },
  ).events;
  const [session] = hook('SessionStart', { cwd: `/work/${set.aws.text}` });
  const [bash] = hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: `curl -H "${set.bearer.text}" api.invented.example`, description: `Call with ${set.bearer.text}` } });
  const [search] = hook('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: `${set.jwt.text} revoke` } });
  const [grep] = hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: set.named.text } });
  // a subagent type has the shape of a name, and so has a token: it goes through the scrub like any text
  const [sub] = hook('SubagentStart', { agent_type: set.github.text });
  const [plain] = hook('SubagentStart', { agent_type: 'code-reviewer' });
  assert.equal(session.title, M);
  assert.equal(bash.summary, `Call with Bearer ${M}`);
  assert.equal(search.summary, `${M} revoke`);
  assert.equal(grep.summary, NAMED);
  assert.equal(sub.summary, M);
  assert.equal(plain.summary, 'code-reviewer', 'an ordinary type is shown as before');
  // project and projectLabel are the floor key and its last segment (CONTRACT 5): path fields with their own rule
  assertHidden(set, [{ ...session, project: undefined, projectLabel: undefined }, bash, search, grep, sub]);
});

test('Claude Code: the timestamp of a record reaches the wire only as a time, in ISO form', () => {
  const set = sampleSet(290);
  const sid = '6f6f6f6f-1111-4222-8333-444455556666';
  const b = createRecordBuilder({ sessionId: sid, cwd: '/work/invented-ts' });
  const st = new SessionState({ id: sid, kind: 'main', stem: sid, now: () => T0 });
  const evs = [
    b.humanPrompt({ text: 'first', ts: set.github.text }),
    b.assistantText({ msgId: 'm1', text: 'reply', ts: `not a time ${set.anthropic.text}` }),
    b.assistantText({ msgId: 'm2', text: 'again', ts: '2026-10-20T10:00:05+00:00' }),
  ].flatMap((r) => st.apply(r));
  const all = [...evs, ...st.snapshotEvents()];
  assert.ok(of(evs, 'say').length === 2 && of(evs, 'prompt').length === 1);
  for (const e of all) assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${e.type}: ${e.ts}`);
  assert.equal(of(evs, 'say').at(-1).ts, '2026-10-20T10:00:05.000Z', 'a time in another form is sent in ISO form');
  assert.equal(of(evs, 'prompt')[0].ts, new Date(T0).toISOString(), 'no time in the record: the server time');
  const text = JSON.stringify(all);
  for (const h of hiddenOf(set)) assert.equal(text.includes(h.slice(0, 8)), false, 'a piece of a timestamp that is no time is shown');
});

test('the label made from an MCP tool name: each segment is scrubbed as it was written, before "_" becomes a space', () => {
  const set = sampleSet(295);
  assert.equal(toolLabel(`mcp__srv__${set.github.text}`), M);
  assert.equal(toolLabel(`mcp__${set.github.text}`), `mcp__${M}`);
  assert.equal(toolLabel('mcp__github__get_pull_request'), 'get pull request', 'an ordinary name is shown as before');
  assert.equal(toolLabel('mcp__codegraph'), 'mcp__codegraph');
});

// --------------------------------------------------------------------------------------------- cuts before the scrub (D39)

async function botTitle(title) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-mask-bot-'));
  tmpDirs.push(tmp);
  const appSupportRoot = path.join(tmp, 'GrokBotSupport');
  const persistDir = path.join(appSupportRoot, 'sand-client-persistence');
  await fsp.mkdir(persistDir, { recursive: true });
  const now = Date.now();
  const row = { id: 'b1bc694a-77df-43f3-8635-835395346f0e', name: 'Bot', title, updatedAt: now, lastActivityAt: now };
  await fsp.writeFile(path.join(persistDir, 'bots.blob'), JSON.stringify({ schemaVersion: 2, value: { rows: [row] } }));
  const refs = await scanGrokDesktopBot(path.join(tmp, 'grok'), { grokBotRoot: '', appSupportRoot, unifiedLogPath: '', nowMs: now });
  assert.equal(refs.length, 1);
  // what the page gets: the scan's title through the Grok session (title, prompt and reply of the made-up turn)
  const ref = refs[0];
  const s = new GrokSession({ id: ref.charId, agent: 'grok', kind: 'main', now: () => now, file: ref.path, stem: ref.stem, facts: ref.facts });
  const evs = [];
  await ref.facts.readAll(ref, (ln) => { evs.push(...s.apply(JSON.parse(ln))); });
  ref.facts.forget(ref.path);
  return { title: ref.facts.title, shown: JSON.stringify([evs, s.snapshotEvents(), s.title]) };
}

test('Grok Bot title: a secret, an address or a path that reaches past character 48 is not shown in part', async () => {
  const set = sampleSet(260);
  const lead = `${chars(30, LOWER)} `; // the sample starts at character 31 and ends far behind 48
  const secret = await botTitle(`${lead}${set.github.text} rest`);
  assert.equal(secret.title, `Grok Bot · ${lead}${M} rest`);
  assert.equal(secret.shown.includes(set.github.hidden.slice(0, 8)), false, 'no piece of the token');
  assert.equal(secret.shown.includes('gh'.concat('p_')), false, 'not even its prefix');

  const mail = await botTitle(`${lead}first.last.invented@mail.invented.example rest`);
  assert.equal(mail.title, `Grok Bot · ${lead}(email) rest`);
  assert.equal(mail.shown.includes('first.last'), false, 'no piece of the address');

  const file = await botTitle(`${lead}/Users/someone/private-folder/deep/notes.md rest`);
  assert.equal(file.title, `Grok Bot · ${lead}notes.md rest`);
  assert.equal(file.shown.includes('someone'), false, 'no piece of the path');

  // the cap is still 48 characters of the scrubbed text, and a plain title is as before
  const long = await botTitle(`${'word '.repeat(30)}end`);
  assert.equal(Array.from(long.title.slice('Grok Bot · '.length)).length, 48);
  assert.equal((await botTitle('Weekly notes')).title, 'Grok Bot · Weekly notes');
  assert.equal((await botTitle(`${chars(2000, LOWER)}`)).title, 'Grok Bot', 'one unbroken word past the scrub limit shows nothing');
});

test('a plan line longer than 1,000 characters is scrubbed before it is cut: no piece of a token at the cut', () => {
  const set = sampleSet(270);
  // the link target is dropped by the plan parser, which pulls the text behind it to the front of the item
  const target = `(https://docs.invented.example/${chars(940, LOWER)})`;
  const md = `- [x](${target.slice(1)} ${set.github.text} and the rest of a long line`;
  assert.ok(md.indexOf(set.github.text) < 1000 && md.indexOf(set.github.text) + set.github.text.length > 1000, 'the token straddles character 1000');
  const [item] = planFromMarkdown(md);
  const text = JSON.stringify(item ?? null);
  assert.equal(text.includes(set.github.hidden.slice(0, 6)), false, `no piece of the token: ${text}`);
  assert.equal(text.includes('gh'.concat('p_')), false, 'not even its prefix');
  // a line under the limit is read as before
  assert.deepEqual(planFromMarkdown(`- Rotate ${set.github.text} today`), [{ content: `Rotate ${M} today`, status: 'pending' }]);
});

test('a plan heading with markdown emphasis inside a secret: the markers go after the scrub, so it is scrubbed again before the cap', () => {
  const set = sampleSet(275);
  const sid = '6e6e6e6e-1111-4222-8333-444455556666';
  const items = (line) => {
    const b = createRecordBuilder({ sessionId: sid, cwd: '/work/invented-plan' });
    const st = new SessionState({ id: sid, kind: 'main', stem: sid, now: () => T0 });
    const evs = [b.humanPrompt({ text: 'plan it' }), b.exitPlanUse({ msgId: 'm1', id: 'toolu_p', plan: line })].flatMap((r) => st.apply(r));
    return { shown: JSON.stringify([evs, st.snapshotEvents()]), content: of(evs, 'plan').flatMap((e) => e.items.map((it) => it.content)) };
  };
  const gh = set.github.text;
  const prefix = gh.slice(0, gh.length - set.github.hidden.length);
  const [name, value] = set.named.text.split('=');
  const lead = chars(52, LOWER); // with it the token reaches past the 80 code points of an item
  const rows = [
    [`## Set **${name}**=${value} first`, `Set ${NAMED} first`],
    [`## Use **${prefix}**${set.github.hidden} now`, `Use ${M} now`],
    [`## Use ${gh.slice(0, 10)}~~${gh.slice(10)} now`, `Use ${M} now`],
    [`## ${lead} ${gh.slice(0, 10)}~~${gh.slice(10)} now`, `${lead} ${M} now`],
    [`## ${lead} **${prefix}**${set.github.hidden} now`, `${lead} ${M} now`],
  ];
  for (const [i, [line, want]] of rows.entries()) {
    const { shown, content } = items(line);
    assert.deepEqual(content, [want], `row ${i}`);
    for (const piece of [set.github.hidden.slice(-8), set.github.hidden.slice(8, 16), value.slice(0, 8)]) {
      assert.equal(shown.includes(piece), false, `a piece of the sample is shown: row ${i}`);
    }
  }
});

test('an Antigravity task.md line longer than 1,000 characters is scrubbed before it is cut: no piece of a token at the cut', () => {
  const set = sampleSet(280);
  const board = (md) => {
    const s = new AntigravitySession({
      id: AG_ID, agent: 'antigravity', kind: 'main', now: () => T0 + 3_600_000, file: '/tmp/x', stem: 'x', subMeta: null,
      journalLabel: null, facts: { full: true, base: 'antigravity-cli' },
    });
    const tasks = parseTaskMd(md);
    return JSON.stringify([tasks, tasks ? s.setInfo({ tasks }) : [], s.snapshotEvents()]);
  };
  // the parser drops the comment, which pulls the text behind it to the front of the item
  for (const sample of [set.github, set.anthropic, set.bearer, set.jwt]) {
    for (const reach of [6, 12, 20, sample.text.length - 4]) {
      const head = '- [ ] two words <!-- ';
      const start = 1000 - reach; // `reach` characters of the sample stand in front of character 1,000
      const md = `${head}${chars(start - head.length - 5, LOWER)} --> ${sample.text} and the rest of the line`;
      assert.equal(md.indexOf(sample.text), start, 'the sample starts where the row says');
      const shown = board(md);
      for (const piece of [sample.hidden.slice(0, 6), sample.hidden.slice(-6), sample.text.slice(0, 8)]) {
        assert.equal(shown.includes(piece), false, `a piece of the sample is shown (${reach} characters in front of the cut)`);
      }
      assert.ok(shown.includes('two words'), 'the start of the item is still read');
    }
  }
  // a sample that ends in front of the cut is masked by the core as on a short line
  const md = `- [/] Replace ${set.github.text} ${'and more '.repeat(200)}`;
  const shown = board(md);
  assert.ok(shown.includes(`Replace ${M} and more`), shown.slice(0, 200));
  assert.equal(shown.includes(set.github.hidden.slice(0, 6)), false);
});
