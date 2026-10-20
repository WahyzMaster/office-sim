// Antigravity metadata sidecars (src/adapters/antigravity/meta.mjs, ADAPTERS 3.3, 5.3): the annotations pbtxt title,
// the task.md checklist, the paths of a transcript's sidecars, and the AntigravityMeta watcher (shared summaries file
// parsed once per change, per-conversation files re-read only on change, title ranking annotation > summary, only
// changed keys delivered, caps, symlinks). Plus the D1 floor on a real server: an Antigravity conversation and a Claude
// session in the same folder share one floor. Temp roots and invented content only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAnnotation, parseTaskMd, locate, metaPaths, AntigravityMeta, SUMMARY_FILES, TASKS_MAX_ITEMS,
} from '../src/adapters/antigravity/meta.mjs';
import { scanAntigravity } from '../src/adapters/antigravity/discover.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, until } from './fixtures/sse.mjs';
import {
  aid, charOf, CLI, IDE, writeConversation, writeSummaries, writeAnnotation, writeTasks, summaryOf, annotationOf, tasksOf,
  fullOf, antigravityTestAdapter,
} from './fixtures/antigravity-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-agy-meta-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const refFor = (root, n, base = CLI) => ({ path: fullOf(root, aid(n), base), sessionId: aid(n) });
const bump = async (file) => { const t = Date.now() / 1000 + Math.random() * 100; await fsp.utimes(file, t, t); };

// count fs opens under a folder while fn runs
async function countOpens(dir, fn) {
  const orig = fsp.open;
  const opened = [];
  fsp.open = function spied(p, ...rest) {
    if (typeof p === 'string' && p.startsWith(dir)) opened.push(p);
    return orig.call(this, p, ...rest);
  };
  try {
    await fn();
  } finally {
    fsp.open = orig;
  }
  return opened;
}

test('parseAnnotation: the top-level title only, C escapes, octal UTF-8 bytes, adjacent strings, comments', () => {
  assert.deepEqual(parseAnnotation(Buffer.from('title: "Fix the build"\n')), { title: 'Fix the build' });
  assert.deepEqual(parseAnnotation('# comment\ntitle:"a \\"quoted\\" \\\\ word\\n"'), { title: 'a "quoted" \\ word\n' });
  assert.deepEqual(parseAnnotation('title: "\\355\\225\\234\\352\\270\\200 \\x41\\u00e9"'), { title: '한글 Aé' });
  assert.deepEqual(parseAnnotation("title: 'single' \"joined\""), { title: 'singlejoined' });
  assert.deepEqual(parseAnnotation('last_user_view_time {\n  seconds: 1\n  title: "nested BAIT"\n}\ntitle: "Top"'), { title: 'Top' });
  assert.deepEqual(parseAnnotation('other: 3\nname: "x"\ntitle: "After"'), { title: 'After' });
  assert.deepEqual(parseAnnotation('title: "First"\ntitle: "Second"'), { title: 'First' });
  for (const bad of ['last_user_view_time {\n  seconds: 1700000000\n}\n', 'title: "unterminated', 'title: "\\377\\376"', 'title: ""', '',
    'name: "title"', 'title: 3']) {
    assert.equal(parseAnnotation(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseAnnotation(Buffer.from([0x74, 0xff, 0xfe])), null, 'invalid UTF-8 file');
});

test('parseTaskMd: [ ] pending, [/] in_progress, [x] completed at any indent; headings, fences, other markers skipped', () => {
  const md = [
    '# Task: invented feature', '', '## Phase 1',
    '- [x] Read the config <!-- id: 0 -->', '  - [/] Write the `parser` for [docs](https://example.com/x?q=BAIT)',
    '    * [ ] Add tests', '1. [X] Numbered done', '- [-] cancelled marker', '- plain bullet', '- [ ]', '```', '- [ ] in a fence', '```',
    '+ [ ]   spaced   words   ',
  ].join('\n');
  assert.deepEqual(parseTaskMd(Buffer.from(md)), [
    { content: 'Read the config', status: 'completed' },
    { content: 'Write the parser for docs', status: 'in_progress' },
    { content: 'Add tests', status: 'pending' },
    { content: 'Numbered done', status: 'completed' },
    { content: 'spaced words', status: 'pending' },
  ]);
  assert.equal(parseTaskMd('# only a heading\n- a bullet\n'), null);
  assert.equal(parseTaskMd(Buffer.from([0xc3, 0x28])), null);
  const many = Array.from({ length: TASKS_MAX_ITEMS + 5 }, (_, i) => `- [ ] item ${i}`).join('\n');
  assert.equal(parseTaskMd(many).length, TASKS_MAX_ITEMS);
  const long = parseTaskMd(`- [ ] ${'x'.repeat(5000)}`);
  assert.ok(long[0].content.length < 1000, 'the raw line is cut before parsing');
});

test('locate / metaPaths: only <root>/antigravity-{cli,ide}/brain/<uuid>/.system_generated/logs/<transcript>', () => {
  const root = '/h/.gemini';
  const full = `${root}/antigravity-cli/brain/${aid(1)}/.system_generated/logs/transcript_full.jsonl`;
  assert.deepEqual(locate(full), { root, base: CLI, baseDir: `${root}/${CLI}`, uuid: aid(1), brainDir: `${root}/${CLI}/brain/${aid(1)}` });
  assert.deepEqual(metaPaths(full), {
    summary: `${root}/${CLI}/${SUMMARY_FILES[CLI]}`, annotation: `${root}/${CLI}/annotations/${aid(1)}.pbtxt`,
    tasks: `${root}/${CLI}/brain/${aid(1)}/task.md`,
  });
  const ide = `${root}/antigravity-ide/brain/${aid(2)}/.system_generated/logs/transcript.jsonl`;
  assert.equal(metaPaths(ide).summary, `${root}/${IDE}/agyhub_summaries_proto.pb`);
  for (const bad of [
    `${root}/antigravity/brain/${aid(1)}/.system_generated/logs/transcript_full.jsonl`, // the desktop app root (D6)
    `${root}/antigravity-cli/brain/not-a-uuid/.system_generated/logs/transcript.jsonl`,
    `${root}/antigravity-cli/brain/${aid(1)}/.system_generated/logs/chunks.jsonl`,
    `${root}/antigravity-cli/brain/${aid(1)}/logs/transcript.jsonl`, 'relative/x.jsonl', null,
  ]) assert.equal(metaPaths(bad), null, String(bad));
});

test('watcher: first check delivers title (annotation over summary), cwd, branch, status, tasks; unchanged -> null', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(1), full: ['{}'] });
  await writeSummaries(root, [{ id: aid(1), title: 'Summary title', status: 2, cwd: '/work/meta', branch: 'main', remote: 'owner/repo' }]);
  await writeAnnotation(root, aid(1), 'Annotated title');
  await writeTasks(root, aid(1), '- [x] one\n- [/] two\n- [ ] three\n');
  const w = new AntigravityMeta();
  const ref = refFor(root, 1);
  assert.deepEqual(await w.check(ref), {
    title: 'Annotated title', cwd: '/work/meta', branch: 'main', status: 'running',
    tasks: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }, { content: 'three', status: 'pending' }],
  });
  assert.equal(await w.check(ref), null, 'nothing changed');
  // the summaries file is rewritten every step: a new summary title never beats the annotation; only status moves
  await writeSummaries(root, [{ id: aid(1), title: 'Newer summary title', status: 1, cwd: '/work/meta', branch: 'main' }]);
  await bump(summaryOf(root));
  assert.deepEqual(await w.check(ref), { status: 'idle' });
  await writeTasks(root, aid(1), '- [x] one\n- [x] two\n- [ ] three\n');
  await bump(tasksOf(root, aid(1)));
  assert.deepEqual((await w.check(ref)).tasks.map((t) => t.status), ['completed', 'completed', 'pending']);
  // forget (detach / move): the next check delivers everything again
  w.forget(ref.path);
  assert.deepEqual(Object.keys(await w.check(ref)).sort(), ['branch', 'cwd', 'status', 'tasks', 'title']);
});

test('watcher: without an annotation the summary title is used; a conversation missing from the summary gets nothing', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(1), full: ['{}'] });
  await writeConversation(root, { id: aid(2), full: ['{}'] });
  await writeSummaries(root, [{ id: aid(1), title: 'Only summary', status: 1 }]);
  const w = new AntigravityMeta();
  assert.deepEqual(await w.check(refFor(root, 1)), { title: 'Only summary', status: 'idle' });
  assert.equal(await w.check(refFor(root, 2)), null);
  // an annotation that appears later takes over the title
  await writeAnnotation(root, aid(1), 'Late annotation');
  assert.deepEqual(await w.check(refFor(root, 1)), { title: 'Late annotation' });
  // the summary entry disappears: what was delivered stays
  await writeSummaries(root, []);
  await bump(summaryOf(root));
  assert.equal(await w.check(refFor(root, 1)), null);
});

test('watcher: the shared summaries file is read once per change for every conversation; small files only on change', async () => {
  const root = await tmp();
  const n = 5;
  for (let i = 1; i <= n; i++) {
    await writeConversation(root, { id: aid(i), full: ['{}'] });
    await writeAnnotation(root, aid(i), `Title ${i}`);
  }
  await writeSummaries(root, Array.from({ length: n }, (_, i) => ({ id: aid(i + 1), title: `S${i + 1}`, cwd: `/work/c${i + 1}`, status: 1 })));
  const w = new AntigravityMeta();
  let opened = await countOpens(root, async () => {
    for (let i = 1; i <= n; i++) assert.equal((await w.check(refFor(root, i))).cwd, `/work/c${i}`);
  });
  assert.equal(opened.filter((p) => p === summaryOf(root)).length, 1, 'the summaries file is opened once');
  assert.equal(opened.filter((p) => p.endsWith('.pbtxt')).length, n);
  opened = await countOpens(root, async () => {
    for (let i = 1; i <= n; i++) assert.equal(await w.check(refFor(root, i)), null);
  });
  assert.deepEqual(opened, [], 'nothing changed: nothing is opened again');
  await writeSummaries(root, Array.from({ length: n }, (_, i) => ({ id: aid(i + 1), cwd: `/work/c${i + 1}`, status: 2 })));
  await bump(summaryOf(root));
  opened = await countOpens(root, async () => {
    for (let i = 1; i <= n; i++) assert.deepEqual(await w.check(refFor(root, i)), { status: 'running' });
  });
  assert.deepEqual(opened, [summaryOf(root)]);
});

test('watcher: IDE conversations use agyhub_summaries_proto.pb; the desktop app root antigravity/ is never touched', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(3), base: IDE, plain: ['{}'], full: null });
  await writeSummaries(root, [{ id: aid(3), title: 'IDE title', cwd: '/work/ide' }], IDE);
  await writeSummaries(root, [{ id: aid(3), title: 'BAIT CLI title' }], CLI);
  await fsp.mkdir(path.join(root, 'antigravity'), { recursive: true });
  await fsp.writeFile(path.join(root, 'antigravity', 'agyhub_summaries_proto.pb'), 'BAIT');
  const w = new AntigravityMeta();
  const opened = await countOpens(root, async () => {
    assert.deepEqual(await w.check({ path: path.join(root, IDE, 'brain', aid(3), '.system_generated', 'logs', 'transcript.jsonl') }),
      { title: 'IDE title', cwd: '/work/ide' });
  });
  assert.ok(opened.every((p) => p.startsWith(path.join(root, IDE))), opened.join(', '));
});

test('watcher: caps, symlinks, junk and parse errors are skipped quietly; never throws', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(1), full: ['{}'] });
  await writeSummaries(root, [{ id: aid(1), title: 'x'.repeat(10), cwd: '/work/cap' }]);
  await writeTasks(root, aid(1), `- [ ] ${'y'.repeat(300)}\n`);
  const small = new AntigravityMeta({ summaryMaxBytes: 16, fileMaxBytes: 64 });
  assert.equal(await small.check(refFor(root, 1)), null, 'every file is over its cap');
  // a symlinked annotation (pointing at a real-looking file outside) is not read
  const outside = await tmp();
  await fsp.writeFile(path.join(outside, 'secret.pbtxt'), 'title: "BAIT linked title"');
  await fsp.mkdir(path.dirname(annotationOf(root, aid(1))), { recursive: true });
  await fsp.symlink(path.join(outside, 'secret.pbtxt'), annotationOf(root, aid(1)));
  const w = new AntigravityMeta();
  const got = await w.check(refFor(root, 1));
  assert.equal(got.title, 'x'.repeat(10), 'the linked annotation is ignored');
  // garbage refs and a non-transcript path
  for (const ref of [null, {}, { path: 42 }, { path: '/nope/x.jsonl' }]) assert.equal(await w.check(ref), null);
  // a summaries file that is not protobuf
  const root2 = await tmp();
  await writeConversation(root2, { id: aid(2), full: ['{}'] });
  await fsp.mkdir(path.join(root2, CLI), { recursive: true });
  await fsp.writeFile(summaryOf(root2), Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x01]));
  assert.equal(await new AntigravityMeta().check(refFor(root2, 2)), null);
});

// ---- the watcher on a real server, and D1 floors ------------------------------------------------------------------

const CLAUDE_ID = 'c1a0de00-1111-4222-8333-44445555a601';
async function claudeSession(root, sid, cwd) {
  const dir = path.join(root, `-claude-${sid.slice(-4)}`);
  await fsp.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: sid, cwd, startMs: Date.now() - 4000, stepMs: 10 });
  const tmpFile = path.join(dir, `${sid}.tmp`);
  await fsp.writeFile(tmpFile, toJsonl([mb.humanPrompt({ text: 'Invented Claude prompt' }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  await fsp.rename(tmpFile, path.join(dir, `${sid}.jsonl`));
}
const stateOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events;

test('D1 on a real server: an Antigravity conversation and a Claude session in one folder share a floor; sidecars fill the first session event', async () => {
  const claudeRoot = await tmp();
  const agRoot = await tmp();
  await claudeSession(claudeRoot, CLAUDE_ID, '/work/shared');
  await writeConversation(agRoot, { id: aid(1), full: [{ k: 'turn_start' }, { k: 'say', text: 'Antigravity at work.' }] });
  await writeSummaries(agRoot, [{ id: aid(1), title: 'Summary title', status: 2, cwd: '/work/shared', branch: 'main' }]);
  await writeAnnotation(agRoot, aid(1), 'Shared floor conversation');
  await writeTasks(agRoot, aid(1), '- [x] Plan\n- [/] Build\n');
  // a second conversation in a project-local worktree of the same repository joins the floor with a badge
  await writeConversation(agRoot, { id: aid(2), full: [{ k: 'say', text: 'worktree' }] });
  await writeSummaries(agRoot, [
    { id: aid(1), title: 'Summary title', status: 2, cwd: '/work/shared', branch: 'main' },
    { id: aid(2), cwd: '/work/shared/.worktrees/feat' },
  ]);
  const app = await start({ ...FAST, root: claudeRoot, roots: { antigravity: agRoot }, adapters: { ...ADAPTERS, antigravity: antigravityTestAdapter() } });
  try {
    await app.ready;
    assert.deepEqual(app.agents, ['claude-code', 'antigravity']);
    await until(async () => (await stateOf(app)).filter((e) => e.type === 'session').length === 3, 4000);
    const events = await stateOf(app);
    const sessions = events.filter((e) => e.type === 'session');
    const ag = sessions.find((e) => e.sessionId === charOf(1));
    const claude = sessions.find((e) => e.sessionId === CLAUDE_ID);
    assert.equal(ag.agent, 'antigravity');
    assert.equal(claude.agent, 'claude-code');
    assert.deepEqual([ag.project, ag.projectLabel, ag.title, ag.branch], ['/work/shared', 'shared', 'Shared floor conversation', 'main']);
    assert.equal(claude.project, ag.project, 'same folder, same floor (shared projectKey)');
    const wt = sessions.find((e) => e.sessionId === charOf(2));
    assert.deepEqual([wt.project, wt.worktree], ['/work/shared', 'feat']);
    const plan = events.find((e) => e.type === 'plan' && e.sessionId === charOf(1));
    assert.deepEqual(plan && [plan.source, plan.items], ['tasks', [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }]]);
    assert.ok(!JSON.stringify(events).includes('BAIT'), 'never-read summary fields stay off the wire');
  } finally {
    await app.close();
  }
});

test('the real deps: a fresh scanner and metadata watcher per Runner, no floor rule, the session class loads lazily', async () => {
  const { antigravity } = await import('../src/adapters/antigravity/index.mjs');
  const a = await antigravity.deps({ SessionState: class {} });
  const b = await antigravity.deps({ SessionState: class {} });
  assert.equal(a.agent, 'antigravity');
  assert.notEqual(a.scan, b.scan);
  assert.notEqual(a.sidecarWatcher, b.sidecarWatcher);
  assert.equal(typeof a.sidecarWatcher.check, 'function');
  assert.equal(typeof a.sidecarWatcher.forget, 'function');
  assert.equal(a.worktreeFloor, undefined);
  assert.equal(a.sidecars, undefined);
  assert.equal(antigravity.defaultRoot, '~/.gemini');
  assert.equal(ADAPTERS.antigravity, antigravity);
  // stateless scan of an empty root
  assert.deepEqual(await scanAntigravity(await tmp(), {}), []);
});
