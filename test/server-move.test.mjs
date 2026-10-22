// Move / truncation gap (2026-10-19 finding 28): records written while a file was being moved or after it was
// truncated still stream live once the server re-finds it. Real discover + tailer + SessionState on a synthetic temp
// root (test/fixtures/records.mjs); the real ~/.claude is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { scan as realScan } from '../src/discover.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const MIN = 60_000;
const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

async function mkRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-move-'));
  tmpDirs.push(root);
  return root;
}
function layout(root, sid, dirName) {
  const dir = path.join(root, dirName);
  return { dir, main: path.join(dir, `${sid}.jsonl`), sub: (id) => path.join(dir, sid, 'subagents', `agent-${id}.jsonl`) };
}
async function write(file, recs, meta) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, toJsonl(recs));
  if (meta) await fs.writeFile(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
}
async function run(root, fn, opts = {}) {
  const app = await start({ port: 0, intervalMs: 50, rescanMs: 60_000, idleMs: 50, activeMinutes: 30, root, publicDir: PUBLIC, ...opts });
  try {
    await app.ready;
    await fn(app);
  } finally {
    await app.close();
  }
}
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
}
const ring = (app) => app.store.ring.map((x) => x.event);
const says = (app) => ring(app).filter((e) => e.type === 'say').map((e) => `${e.sessionId}:${e.text}`);
const brief = (evs) => evs.map((e) => `${e.type}:${e.sessionId}${e.toolUseId ? `/${e.toolUseId}` : ''}${e.text ? `/${e.text}` : ''}`);

test('a session moved to a new path keeps streaming: lines written during the move arrive live, no re-announce', async () => {
  const root = await mkRoot();
  const SID = '28282828-1111-4222-8333-444455556666';
  const A = 'a0000000000002801';
  const from = layout(root, SID, '-work-old');
  const to = layout(root, SID, '-work-new');
  const t0 = Date.now() - 5000;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: t0, stepMs: 10 });
  const s = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: A, startMs: t0, stepMs: 10 });
  await write(from.main, [m.humanPrompt({ text: 'Invented move task' }), m.agentUse({ msgId: 'mm1', id: 'toolu_ag', description: 'Look' })]);
  await write(from.sub(A), [s.subagentPrompt(), s.assistantToolUse({ msgId: 'ms1', id: 'toolu_s1', name: 'Grep', input: { pattern: 'y' } })],
    { agentType: 'Explore', description: 'Look', toolUseId: 'toolu_ag' });
  let frozen = null;
  const scan = async (r, o) => frozen ?? realScan(r, o);
  await run(root, async (app) => {
    assert.ok(brief(ring(app)).includes(`tool_start:${A}/toolu_s1`));
    frozen = await realScan(root, { activeMs: 30 * MIN }); // the old layout, while the files move
    await fs.mkdir(to.dir, { recursive: true });
    await fs.rename(path.join(from.dir, SID), path.join(to.dir, SID));
    await fs.rename(from.main, to.main);
    await fs.appendFile(to.main, toJsonl([m.assistantText({ msgId: 'mm2', text: 'GAP_MAIN_SAY' })]));
    await fs.appendFile(to.sub(A), toJsonl([s.assistantText({ msgId: 'ms2', text: 'GAP_SUB_SAY' })]));
    await sleep(150); // polls of the old paths see nothing
    frozen = null;
    const ok = await waitFor(() => says(app).includes(`${SID}:GAP_MAIN_SAY`) && says(app).includes(`${A}:GAP_SUB_SAY`));
    assert.ok(ok, `gap lines not streamed: ${brief(ring(app)).join(' ')}`);
    await fs.appendFile(to.main, toJsonl([m.assistantText({ msgId: 'mm3', text: 'LATER_SAY' })]));
    assert.ok(await waitFor(() => says(app).includes(`${SID}:LATER_SAY`)), 'polling continues at the new path');
    const starts = brief(ring(app)).filter((x) => x === `tool_start:${A}/toolu_s1`);
    assert.equal(starts.length, 1, 'the moved file was carried over, not replayed and re-announced');
    assert.equal(app.store.entry(to.sub(A))?.path, to.sub(A));
    assert.equal(app.store.entry(from.sub(A)), null);
  }, { rescanMs: 50, deps: { scan } });
});

test('a truncated file re-attaches at once and lines appended after the truncation arrive live', async () => {
  const root = await mkRoot();
  const SID = '28282828-2222-4222-8333-444455556666';
  const L = layout(root, SID, '-work-demo');
  const t0 = Date.now() - 5000;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: t0, stepMs: 10 });
  const first = m.humanPrompt({ text: 'Invented truncation task' });
  await write(L.main, [first, m.assistantText({ msgId: 'mm1', text: 'Some long invented progress note before the cut.' }),
    m.assistantText({ msgId: 'mm2', text: 'Another invented note before the cut.' })]);
  let delay = 0;
  let scans = 0; // scan calls made while `delay` is set (the startup rescan ran before, with delay 0)
  const scan = async (r, o) => {
    if (delay) {
      scans += 1; // counted before the sleep: the append below lands while this re-attach rescan is still pending
      await sleep(delay);
    }
    return realScan(r, o);
  };
  await run(root, async (app) => {
    assert.ok(ring(app).some((e) => e.type === 'session' && e.sessionId === SID));
    delay = 400; // the re-attach rescan takes a while
    await fs.writeFile(L.main, toJsonl([first])); // same inode, shorter
    // rescanMs is 60 s, so the only scan from here on is the one a poll starts after it saw size < offset
    // (and set the replay boundary at the shrunken size): the append below is past that boundary
    assert.ok(await waitFor(() => scans > 0, 5000), 'no poll saw the shrink (no re-attach rescan started)');
    await fs.appendFile(L.main, toJsonl([m.assistantText({ msgId: 'mm3', text: 'AFTER_TRUNCATE_SAY' })]));
    const ok = await waitFor(() => says(app).includes(`${SID}:AFTER_TRUNCATE_SAY`), 4000);
    assert.ok(ok, `line after the truncation not streamed: ${brief(ring(app)).join(' ')}`);
    delay = 0;
    await fs.appendFile(L.main, toJsonl([m.assistantText({ msgId: 'mm4', text: 'LATER_SAY' })]));
    assert.ok(await waitFor(() => says(app).includes(`${SID}:LATER_SAY`)));
  }, { rescanMs: 60_000, deps: { scan } }); // no periodic rescan in time: the reset itself triggers the re-attach
});
