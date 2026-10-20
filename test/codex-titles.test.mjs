// Codex titles (ADAPTERS 3.3, 5.1, 6.1): <root>/session_index.jsonl { id, thread_name, updated_at }, the last line per id
// wins. The index is read incrementally (only appended bytes, a per-read cap, a rewrite starts over), never through a
// link, and each session gets its title through setInfo() only when it changed; without an entry the session keeps its
// own fallback. Temp roots and invented content only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionIndex, CodexTitles, indexEntry, indexPathOf, INDEX_FILE } from '../src/adapters/codex/titles.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { cid, charOf, writeRollout, appendIndex, codexTestAdapter } from './fixtures/codex-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-codex-titles-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const line = (id, name, extra = {}) => `${JSON.stringify({ id, thread_name: name, updated_at: '2026-10-20T09:00:00Z', ...extra })}\n`;
const sessionsOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'session');

test('indexEntry: a uuid id and a non-blank thread_name only; ids are lowercased; nothing else is kept', () => {
  assert.deepEqual(indexEntry({ id: cid(1).toUpperCase(), thread_name: 'Fix login', updated_at: 'x', cwd: '/secret' }), [cid(1), 'Fix login']);
  for (const bad of [null, [], {}, { id: 'abc', thread_name: 'x' }, { id: cid(1) }, { id: cid(1), thread_name: '  ' },
    { id: cid(1), thread_name: 7 }, { id: cid(1), thread_name: 'x'.repeat(1001) }]) {
    assert.equal(indexEntry(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test('SessionIndex: last line per id wins; only appended bytes are read; a partial last line waits for its newline', async () => {
  const dir = await tmp();
  const file = path.join(dir, INDEX_FILE);
  await fsp.writeFile(file, line(cid(1), 'First name') + line(cid(2), 'Other') + line(cid(1), 'Renamed'));
  const idx = new SessionIndex(file);
  assert.equal(await idx.refresh(), true);
  assert.deepEqual([idx.get(cid(1)), idx.get(cid(2)), idx.get(cid(3))], ['Renamed', 'Other', null]);
  const size = (await fsp.stat(file)).size;
  assert.equal(idx.offset, size);
  // prove the old bytes are not read again: change them in place (same size, same inode), then append
  const fh = await fsp.open(file, 'r+');
  await fh.write(Buffer.from(line(cid(2), 'Xther').slice(0, -1)), 0, undefined, Buffer.byteLength(line(cid(1), 'First name')));
  await fh.close();
  await fsp.appendFile(file, line(cid(3), 'Third'));
  assert.equal(await idx.refresh(), true);
  assert.deepEqual([idx.get(cid(2)), idx.get(cid(3))], ['Other', 'Third'], 'only the appended line was read');
  assert.equal(await idx.refresh(), false, 'nothing new: nothing read');
  const half = line(cid(4), 'Half done');
  await fsp.appendFile(file, half.slice(0, 20));
  await idx.refresh();
  assert.equal(idx.get(cid(4)), null);
  await fsp.appendFile(file, half.slice(20));
  await idx.refresh();
  assert.equal(idx.get(cid(4)), 'Half done');
});

test('SessionIndex: a rewritten or shorter file starts over; a missing file keeps the titles; links are not followed', async () => {
  const dir = await tmp();
  const file = path.join(dir, INDEX_FILE);
  await fsp.writeFile(file, line(cid(1), 'Before'));
  const idx = new SessionIndex(file);
  await idx.refresh();
  await fsp.writeFile(`${file}.new`, line(cid(2), 'After a rewrite'));
  await fsp.rename(`${file}.new`, file); // a new inode
  await idx.refresh();
  assert.deepEqual([idx.get(cid(1)), idx.get(cid(2))], [null, 'After a rewrite']);
  await fsp.truncate(file, 0);
  await fsp.appendFile(file, line(cid(3), 'Shorter'));
  await idx.refresh();
  assert.deepEqual([idx.get(cid(2)), idx.get(cid(3))], [null, 'Shorter']);
  await fsp.rm(file);
  assert.equal(await idx.refresh(), false);
  assert.equal(idx.get(cid(3)), 'Shorter', 'a vanished index keeps what was read');
  const target = path.join(dir, 'elsewhere.jsonl');
  await fsp.writeFile(target, line(cid(4), 'BAIT_LINKED'));
  await fsp.symlink(target, file);
  const linked = new SessionIndex(file);
  assert.equal(await linked.refresh(), false);
  assert.equal(linked.get(cid(4)), null);
});

test('SessionIndex: a per-read cap spreads a big index over refreshes; long lines are skipped; the id map is capped', async () => {
  const dir = await tmp();
  const file = path.join(dir, INDEX_FILE);
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push(line(cid(i), `Name ${i}`));
  await fsp.writeFile(file, lines.join('') + line(cid(21), 'x'.repeat(900)) + line(cid(22), 'After the long one'));
  const idx = new SessionIndex(file, { maxRead: 500, maxLine: 400, maxIds: 10 });
  let rounds = 0;
  while (await idx.refresh()) rounds += 1;
  assert.ok(rounds >= 4, `read in ${rounds} rounds`);
  assert.equal(idx.get(cid(21)), null, 'a line over maxLine is skipped');
  assert.equal(idx.get(cid(22)), 'After the long one', 'the line after a skipped one is read');
  assert.equal(idx.titles.size, 10);
  assert.deepEqual([idx.get(cid(1)), idx.get(cid(20))], [null, 'Name 20'], 'the oldest ids are dropped first');
});

test('refreshSoon: checks close together share one read; indexPathOf maps a rollout to its root index only', async () => {
  const dir = await tmp();
  const file = path.join(dir, INDEX_FILE);
  await fsp.writeFile(file, line(cid(1), 'One'));
  const idx = new SessionIndex(file);
  await Promise.all([idx.refreshSoon(1000), idx.refreshSoon(1000), idx.refreshSoon(1000)]);
  await fsp.appendFile(file, line(cid(2), 'Two'));
  await idx.refreshSoon(1000);
  assert.equal(idx.reads, 1);
  assert.equal(idx.get(cid(2)), null);
  await idx.refreshSoon(0);
  assert.equal(idx.get(cid(2)), 'Two');
  assert.equal(indexPathOf('/h/.codex/sessions/2026/10/20/rollout-x.jsonl'), path.join('/h/.codex', INDEX_FILE));
  for (const bad of ['/h/.codex/other/2026/10/20/rollout-x.jsonl', '/rollout-x.jsonl', '', null]) assert.equal(indexPathOf(bad), null, String(bad));
});

test('CodexTitles: { title } once per change and transcript; forget hands it over again; other sessions get nothing', async () => {
  const root = await tmp();
  await appendIndex(root, [[cid(1), 'Thread one']]);
  const t = new CodexTitles({ refreshMs: 0 });
  const ref = { path: path.join(root, 'sessions', '2026', '10', '20', `rollout-2026-10-20T09-00-00-${cid(1)}.jsonl`), sessionId: cid(1) };
  assert.deepEqual(await t.check(ref), { title: 'Thread one' });
  assert.equal(await t.check(ref), null);
  await appendIndex(root, [[cid(1), 'Thread one, renamed']]);
  assert.deepEqual(await t.check(ref), { title: 'Thread one, renamed' });
  t.forget(ref.path);
  assert.deepEqual(await t.check(ref), { title: 'Thread one, renamed' });
  assert.equal(await t.check({ ...ref, sessionId: cid(2), path: ref.path.replace(cid(1), cid(2)) }), null);
  assert.equal(await t.check({ path: '/x/y.jsonl', sessionId: cid(1) }), null);
  assert.equal(await t.check(null), null);
});

test('server: the first session event already has the index title; a later rename updates it live; no entry -> the fallback', async () => {
  const root = await tmp();
  await writeRollout(root, { id: cid(1), items: [{ k: 'turn_start', id: 't1' }, { k: 'prompt', text: 'A typed human prompt' }] });
  await writeRollout(root, { id: cid(2), items: [{ k: 'turn_start', id: 't1' }, { k: 'say', text: 'no prompt here' }] });
  await appendIndex(root, [[cid(1), 'Indexed title'], [cid(9), 'Somebody else']]);
  const app = await start({
    ...FAST, root: path.join(root, 'no-claude'), agents: ['codex'], roots: { codex: root }, adapters: { ...ADAPTERS, codex: codexTestAdapter() },
  });
  let es = null;
  try {
    es = await sse(app.port);
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 2, 4000);
    const first = es.frames.find((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1));
    assert.equal(first.data.title, 'Indexed title', 'the title was read before the character was announced');
    assert.equal((await sessionsOf(app)).find((e) => e.sessionId === charOf(2)).title, cid(2).slice(0, 8), 'no entry: the id fallback');
    await appendIndex(root, [[cid(1), 'Renamed while live'], [cid(2), 'Named later']]);
    await es.next((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1) && fr.data.title === 'Renamed while live', 4000);
    await es.next((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(2) && fr.data.title === 'Named later', 4000);
  } finally {
    es?.close();
    await app.close();
  }
});
