// P5e review fixes for links planted around the Antigravity files (CONTRACT 4.8: symlinks are never followed):
// - finding 4: a linked <app>/annotations/ folder (or a linked brain/<uuid>/ for task.md) counts as missing, so nothing
//   outside <app>/ or under the desktop root antigravity/ is opened by the metadata watcher;
// - finding 5: the Antigravity Tailer reads an attached transcript only when it is the lstat-ed regular file the scan
//   reported (O_NOFOLLOW + ref.ino), so a link planted between the scan and the attach is never followed. The shared
//   Tailer keeps its default (Claude, Codex and Grok unchanged).
// Temp roots and invented content only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntigravityMeta } from '../src/adapters/antigravity/meta.mjs';
import { antigravity } from '../src/adapters/antigravity/index.mjs';
import { createAntigravityScanner } from '../src/adapters/antigravity/discover.mjs';
import { Tailer } from '../src/tailer.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse } from './fixtures/sse.mjs';
import {
  aid, charOf, CLI, writeConversation, writeSummaries, writeAnnotation, writeTasks, fullOf, brainDir, antigravityTestAdapter,
} from './fixtures/antigravity-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-agy-link-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// every fsp.open path while fn runs
async function opensDuring(fn) {
  const orig = fsp.open;
  const opened = [];
  fsp.open = function spied(p, ...rest) {
    opened.push(String(p));
    return orig.call(this, p, ...rest);
  };
  try {
    await fn();
  } finally {
    fsp.open = orig;
  }
  return opened;
}

// ---------------------------------------------------------------------------------------------- finding 4

test('finding 4: a symlinked <app>/annotations/ (outside the root, or the desktop root) counts as missing; nothing there is opened', async () => {
  for (const target of ['outside', 'desktop']) {
    const root = await tmp();
    const outside = await tmp();
    await writeConversation(root, { id: aid(1), full: ['{}'] });
    await writeSummaries(root, [{ id: aid(1), title: 'Summary title', cwd: '/work/link' }]);
    const linkedDir = target === 'outside' ? path.join(outside, 'annotations') : path.join(root, 'antigravity', 'annotations');
    await fsp.mkdir(linkedDir, { recursive: true });
    await fsp.writeFile(path.join(linkedDir, `${aid(1)}.pbtxt`), 'title: "BAIT linked annotation title"\n');
    await fsp.symlink(linkedDir, path.join(root, CLI, 'annotations'));
    const w = new AntigravityMeta();
    const ref = { path: fullOf(root, aid(1)) };
    let got;
    const opened = await opensDuring(async () => { got = await w.check(ref); });
    assert.equal(got.title, 'Summary title', `${target}: the linked annotation is not read`);
    assert.ok(!opened.some((p) => p.startsWith(linkedDir) || p.startsWith(outside)), `${target}: ${opened.join(', ')}`);
    assert.ok(!opened.some((p) => p.startsWith(path.join(root, 'antigravity') + path.sep)), `${target}: nothing under the desktop root`);
    // the link is replaced by a real folder: its annotation is read then
    await fsp.rm(path.join(root, CLI, 'annotations'));
    await writeAnnotation(root, aid(1), 'Real annotation');
    assert.deepEqual(await w.check(ref), { title: 'Real annotation' });
  }
});

test('finding 4: a real annotations/ folder replaced by a link later is not followed (the delivered title stays)', async () => {
  const root = await tmp();
  const outside = await tmp();
  await writeConversation(root, { id: aid(1), full: ['{}'] });
  await writeAnnotation(root, aid(1), 'First title');
  const w = new AntigravityMeta();
  const ref = { path: fullOf(root, aid(1)) };
  assert.deepEqual(await w.check(ref), { title: 'First title' });
  await fsp.writeFile(path.join(outside, `${aid(1)}.pbtxt`), 'title: "BAIT swapped in"\n');
  await fsp.rm(path.join(root, CLI, 'annotations'), { recursive: true });
  await fsp.symlink(outside, path.join(root, CLI, 'annotations'));
  const opened = await opensDuring(async () => { assert.equal(await w.check(ref), null); });
  assert.ok(!opened.some((p) => p.startsWith(outside)), opened.join(', '));
});

test('finding 4 (task.md): a linked brain/<uuid>/ folder is not followed for task.md; a linked app folder reads nothing', async () => {
  const root = await tmp();
  const outside = await tmp();
  // a real-looking conversation outside the root, reached through a linked brain/<uuid>/
  await writeConversation(outside, { id: aid(2), full: ['{}'] });
  await writeTasks(outside, aid(2), '- [ ] BAIT linked task\n');
  await fsp.mkdir(path.join(root, CLI, 'brain'), { recursive: true });
  await fsp.symlink(brainDir(outside, aid(2)), brainDir(root, aid(2)));
  await writeSummaries(root, [{ id: aid(2), title: 'Linked conv' }]);
  const w = new AntigravityMeta();
  let got;
  let opened = await opensDuring(async () => { got = await w.check({ path: fullOf(root, aid(2)) }); });
  assert.deepEqual(got, { title: 'Linked conv' }, 'no tasks through the link');
  assert.ok(!opened.some((p) => p.startsWith(outside) || p.includes('task.md')), opened.join(', '));
  // a linked app folder: no file under it is opened (not even the summaries file)
  const root2 = await tmp();
  const realApp = await tmp();
  await writeConversation(realApp, { id: aid(3), full: ['{}'] });
  await writeSummaries(realApp, [{ id: aid(3), title: 'BAIT through a linked app folder' }]);
  await writeAnnotation(realApp, aid(3), 'BAIT annotation');
  await fsp.symlink(path.join(realApp, CLI), path.join(root2, CLI));
  opened = await opensDuring(async () => { got = await new AntigravityMeta().check({ path: fullOf(root2, aid(3)) }); });
  assert.equal(got, null);
  assert.deepEqual(opened, []);
});

// ---------------------------------------------------------------------------------------------- finding 5

async function linkedTranscript() {
  const root = await tmp();
  const outside = await tmp();
  const secret = path.join(outside, 'oauth_creds.json');
  // a prompt: the first prompt becomes the session title, so a followed link would show it in the attach snapshot
  await fsp.writeFile(secret, '{"k":"turn_start"}\n{"k":"prompt","text":"BAIT_OUTSIDE_SECRET"}\n');
  const { full } = await writeConversation(root, { id: aid(1), full: [{ k: 'say', text: 'real line' }] });
  const ino = (await fsp.lstat(full)).ino;
  return { root, outside, secret, full, ino };
}

test('finding 5: a noFollow Tailer refuses a transcript replaced by a link after the scan (gone, no line delivered)', async () => {
  const { secret, full, ino } = await linkedTranscript();
  await fsp.rm(full);
  await fsp.symlink(secret, full);
  const lines = [];
  const t = new Tailer({ noFollow: true });
  assert.deepEqual(await t.readAll({ path: full, ino }, (l) => lines.push(l)), { offset: 0, skipped: 0, gone: true });
  assert.deepEqual(lines, []);
  assert.equal(t.offsetOf(full), null, 'not attached');
  // the shared default is unchanged: a plain Tailer still opens the path as before (Claude, Codex, Grok)
  const plain = [];
  await new Tailer().readAll({ path: full, ino }, (l) => plain.push(l));
  assert.equal(plain.length, 2);
});

test('finding 5: a noFollow Tailer refuses a different regular file at the path (ino differs from the scan ref)', async () => {
  const { full, ino } = await linkedTranscript();
  await fsp.rm(full);
  await fsp.writeFile(full, '{"k":"say","text":"BAIT_REPLACED"}\n');
  const lines = [];
  const t = new Tailer({ noFollow: true });
  assert.equal((await t.readAll({ path: full, ino }, (l) => lines.push(l))).gone, true);
  assert.deepEqual(lines, []);
  // without an ino (a string ref) the regular file is read
  assert.equal((await t.readAll(full, (l) => lines.push(l))).offset > 0, true);
  assert.equal(lines.length, 1);
});

test('finding 5: the Antigravity deps Tailer is a noFollow Tailer (an override is kept)', async () => {
  const { secret, full, ino } = await linkedTranscript();
  const deps = await antigravity.deps({ SessionState: class {} });
  await fsp.rm(full);
  await fsp.symlink(secret, full);
  const lines = [];
  assert.equal((await new deps.Tailer().readAll({ path: full, ino }, (l) => lines.push(l))).gone, true);
  assert.deepEqual(lines, []);
  assert.ok(new deps.Tailer() instanceof Tailer);
  class Mine {}
  assert.equal((await antigravity.deps({ SessionState: class {}, Tailer: Mine })).Tailer, Mine);
});

test('finding 5 on a real server: a transcript swapped for a link between the scan and the attach never reaches the page', async () => {
  const { root, secret, full } = await linkedTranscript();
  const real = createAntigravityScanner();
  let raced = false;
  const scan = async (r, o) => {
    const refs = await real(r, o);
    if (!raced && refs.length) { // the race: after the scan's lstat, before the Runner's attach
      raced = true;
      await fsp.rm(full);
      await fsp.symlink(secret, full);
    }
    return refs;
  };
  const app = await start({ ...FAST, root: path.join(root, 'no-claude'), agents: ['antigravity'], roots: { antigravity: root },
    adapters: { ...ADAPTERS, antigravity: antigravityTestAdapter({ scan }) } });
  const client = await sse(app.port);
  try {
    await app.ready;
    await sleepMs(400); // a few rescans
    assert.equal(raced, true);
    const body = (await request(app.port, { path: '/state' })).body;
    const frames = JSON.stringify(client.frames.map((fr) => fr.data));
    assert.doesNotMatch(body + frames, /BAIT_OUTSIDE_SECRET/);
    assert.ok(!JSON.parse(body).events.some((e) => e.sessionId === charOf(1)), 'not attached');
    assert.ok(!client.frames.some((fr) => fr.data?.sessionId === charOf(1)), 'never announced');
  } finally {
    client.close();
    await app.close();
  }
});
