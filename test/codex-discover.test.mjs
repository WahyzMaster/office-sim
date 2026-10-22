// Codex discovery (ADAPTERS 3.4, 5.1, 7.1, 8.1 #17, D10): allowlist scan of <root>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl,
// line-0 (session_meta) facts read once under a size cap, guardian threads hidden, /review threads as subs, parent chains
// across date folders, rollback continuation pieces (one ref per thread, the Runner switches paths), hot/cold date
// folders. The allowlist test spies on every fs call while a real server runs the Codex adapter. Temp roots and
// invented content only: the real ~/.codex is never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanCodex, createCodexScanner, parseRolloutName, hotKeys, dayKey, SCAN_LIMITS,
} from '../src/adapters/codex/discover.mjs';
import { Line0Cache, factsOf } from '../src/adapters/codex/line0.mjs';
import { refIdsOk } from '../src/store-link.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import {
  cid, charOf, today, rolloutPath, sessionMeta, writeRollout, setMtime, appendLines, appendIndex, CodexTestSession, codexTestAdapter,
} from './fixtures/codex-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-codex-disc-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const WINDOW = () => ({ activeMs: 30 * 60_000, nowMs: Date.now() + 1000 });
const brief = (refs) => refs.map((r) => [r.kind, r.charId, r.parentId ?? null, r.sid]);
const OLD_DAY = '2025/01/15';
const HOUR = 3600_000;
const sessionsOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'session');
const startCodex = (root, extra = {}) => start({
  ...FAST, root: path.join(root, 'no-claude'), agents: ['codex'], roots: { codex: root }, adapters: { ...ADAPTERS, codex: codexTestAdapter() }, ...extra,
});

test('names: rollout-<ts>-<uuid>[_<uuid2>].jsonl only; date keys are local; hot folders cover the window, never more', () => {
  const [a, b] = [cid(1), cid(2)];
  assert.deepEqual(parseRolloutName(`rollout-2026-10-20T09-00-00-${a}.jsonl`), { uuid: a, piece: null });
  assert.deepEqual(parseRolloutName(`rollout-2026-10-20T09-00-00-${a.toUpperCase()}_${b}.jsonl`), { uuid: a, piece: b });
  for (const bad of [`rollout-2026-10-20T09-00-00-${a}.jsonl.zst`, `rollout-${a}.jsonl`, `x-rollout-2026-10-20T09-00-00-${a}.jsonl`,
    'history.jsonl', 'session_index.jsonl', `rollout-2026-10-20T09-00-00-${a}_x.jsonl`, null]) {
    assert.equal(parseRolloutName(bad), null, String(bad));
  }
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime(); // local noon
  assert.equal(dayKey(now), '2026/10/20');
  // a 30 min window: the folders that can hold a file created in it, one day of margin on both sides
  assert.deepEqual(hotKeys(now, 30 * 60_000), ['2026/10/19', '2026/10/20', '2026/10/21']);
  // a long window lists only the folders inside it that the last full walk saw, plus the recent ones
  const known = new Set(['2026/09/01', '2026/10/01', '2025/01/15']);
  assert.deepEqual(hotKeys(now, 40 * 24 * HOUR, known), ['2026/10/01', '2026/10/18', '2026/10/19', '2026/10/20', '2026/10/21']);
});

test('fixture: line 0 is stamped now by default (a fixed time would end subs idle once the clock passes it), or the given ts', () => {
  const m = sessionMeta({ id: cid(1) });
  assert.ok(Math.abs(Date.parse(m.timestamp) - Date.now()) < 60_000, m.timestamp);
  assert.equal(m.payload.timestamp, m.timestamp);
  assert.equal(sessionMeta({ id: cid(1), ts: '2026-01-02T03:04:05.000Z' }).timestamp, '2026-01-02T03:04:05.000Z');
});

test('layout: odd names, folders, links and .zst are skipped; refs carry D2 ids and only the scan facts', async () => {
  const root = await tmp();
  const main = await writeRollout(root, { id: cid(1), meta: { cwd: '/work/one', branch: 'feat/x', historyStart: 3 } });
  const day = path.dirname(main);
  await fsp.writeFile(`${rolloutPath(root, today(), cid(2))}.zst`, 'BAIT_ZST'); // compressed: never stat-ed or opened
  await fsp.writeFile(path.join(day, 'notes.jsonl'), '{}\n');
  await fsp.mkdir(path.join(day, `rollout-2026-10-20T09-00-00-${cid(3)}.jsonl`)); // a folder with a rollout name
  await fsp.symlink(main, rolloutPath(root, today(), cid(4))); // a link: not followed
  await writeRollout(root, { id: cid(5), day: '2026/13/01' }); // no month 13
  await fsp.mkdir(path.join(root, 'sessions', 'misc'), { recursive: true });
  await fsp.writeFile(path.join(root, 'sessions', 'misc', `rollout-2026-10-20T09-00-00-${cid(6)}.jsonl`), JSON.stringify(sessionMeta({ id: cid(6) })) + '\n');
  await fsp.writeFile(path.join(root, 'sessions', `rollout-2026-10-20T09-00-00-${cid(7)}.jsonl`), JSON.stringify(sessionMeta({ id: cid(7) })) + '\n');
  const refs = await scanCodex(root, WINDOW());
  assert.deepEqual(brief(refs), [['main', charOf(1), null, charOf(1)]]);
  const [r] = refs;
  assert.deepEqual([r.agent, r.stem, r.sessionId, r.path], ['codex', charOf(1), cid(1), main]);
  assert.ok(refIdsOk(r));
  assert.deepEqual(Object.keys(r).sort(), ['agent', 'charId', 'facts', 'ino', 'kind', 'mtimeMs', 'path', 'sid', 'size', 'stem', 'sessionId'].sort());
  assert.deepEqual(r.facts, { cwd: '/work/one', branch: 'feat/x', cliVersion: '0.162.0-alpha.17.2', historyStart: 3, agentType: null });
  assert.ok(!JSON.stringify(refs).includes('BAIT_'), 'no account id, instructions or repository url on a ref');
  // the line-0 facts the scan keeps (pure): never the account ids or the payload
  const f = factsOf(sessionMeta({ id: cid(1), cwd: '/work/one', branch: 'feat/x', historyStart: 3 }), cid(1));
  assert.deepEqual(f, { id: cid(1), guardian: false, review: false, parent: null, cwd: '/work/one', branch: 'feat/x',
    cliVersion: '0.162.0-alpha.17.2', historyStart: 3, agentType: null, ordinal: 0 });
  assert.deepEqual(await scanCodex(path.join(root, 'nope'), WINDOW()), [], 'no sessions folder: empty');
  await fsp.writeFile(path.join(root, 'file-root'), 'x');
  await fsp.mkdir(path.join(root, 'file-root2'));
  await fsp.writeFile(path.join(root, 'file-root2', 'sessions'), 'x');
  await assert.rejects(scanCodex(path.join(root, 'file-root2'), WINDOW()), { code: 'ENOTDIR' });
});

test('kinds: thread_spawn chain to depth 3, /review is a sub (D10d), guardian threads and their descendants are hidden (D10a)', async () => {
  const root = await tmp();
  await writeRollout(root, { id: cid(1) });
  await writeRollout(root, { id: cid(2), meta: { source: { parent: cid(1) }, role: 'worker' } });
  await writeRollout(root, { id: cid(3), meta: { source: { parent: cid(2) } } });
  await writeRollout(root, { id: cid(4), meta: { source: { parent: cid(3) } } });
  await writeRollout(root, { id: cid(5), meta: { source: 'review', parentField: cid(1) } });
  await writeRollout(root, { id: cid(6), meta: { source: 'review' } }); // no parent named: a main
  await writeRollout(root, { id: cid(7), meta: { source: 'guardian', parentField: cid(1) } });
  await writeRollout(root, { id: cid(8), meta: { source: { parent: cid(7) } } }); // under a guardian: hidden too
  await writeRollout(root, { id: cid(9), meta: { source: 'cli', parentField: cid(1) } }); // a parent field without a subagent source
  const refs = await scanCodex(root, WINDOW());
  assert.deepEqual(brief(refs), [
    ['main', charOf(1), null, charOf(1)], ['main', charOf(6), null, charOf(6)], ['main', charOf(9), null, charOf(9)],
    ['sub', charOf(2), charOf(1), charOf(1)], ['sub', charOf(5), charOf(1), charOf(1)],
    ['sub', charOf(3), charOf(2), charOf(1)], ['sub', charOf(4), charOf(3), charOf(1)],
  ]);
  assert.ok(refs.every(refIdsOk));
  assert.equal(factsOf(sessionMeta({ id: cid(2), source: { parent: cid(1) }, role: 'worker' }), cid(2)).agentType, 'worker');
  // pure facts: guardian by source.subagent.other, never by thread_source
  const g = factsOf(sessionMeta({ id: cid(7), source: 'guardian', extra: { thread_source: 'user' } }), cid(7));
  assert.deepEqual([g.guardian, g.review], [true, false]);
  assert.equal(factsOf(sessionMeta({ id: cid(1), extra: { thread_source: 'guardian_review' } }), cid(1)).guardian, false);
});

test('parents: one outside the window is found by uuid in an old date folder; no plain rollout or an unusable line 0 ends the chain; a pending one waits; a cycle is not trusted', async () => {
  const root = await tmp();
  const old = Date.now() - 5 * HOUR;
  await writeRollout(root, { id: cid(1), day: OLD_DAY, mtimeMs: old }); // waiting parent, outside the window, old folder
  await writeRollout(root, { id: cid(2), meta: { source: { parent: cid(1) } } });
  await writeRollout(root, { id: cid(3), day: OLD_DAY, mtimeMs: old }); // not active, no active child: not reported
  await fsp.writeFile(`${rolloutPath(root, OLD_DAY, cid(4))}.zst`, 'x');
  await writeRollout(root, { id: cid(5), meta: { source: { parent: cid(4) } } }); // parent compressed: a main
  await writeRollout(root, { id: cid(6), raw: `{"type":"session_meta","payload":{"id":"${cid(6)}","pad":"${'x'.repeat(300 * 1024)}"}}\n` });
  await writeRollout(root, { id: cid(7), meta: { source: { parent: cid(6) } } }); // parent line 0 over the cap: a main
  await writeRollout(root, { id: cid(8), raw: `{"type":"session_meta","payload":{"id":"${cid(8)}"` }); // no newline yet
  await writeRollout(root, { id: cid(9), meta: { source: { parent: cid(8) } } }); // waits for its parent's line 0
  await writeRollout(root, { id: cid(10), meta: { source: { parent: cid(11) } } });
  await writeRollout(root, { id: cid(11), meta: { source: { parent: cid(10) } } }); // a cycle: both mains
  const refs = await scanCodex(root, WINDOW());
  assert.deepEqual(brief(refs), [
    ['main', charOf(1), null, charOf(1)], ['main', charOf(5), null, charOf(5)], ['main', charOf(7), null, charOf(7)],
    ['main', charOf(10), null, charOf(10)], ['main', charOf(11), null, charOf(11)], ['sub', charOf(2), charOf(1), charOf(1)],
  ]);
  assert.equal(refs[0].path, rolloutPath(root, OLD_DAY, cid(1)));
  await fsp.appendFile(rolloutPath(root, today(), cid(8)), '}}\n'); // the line is complete now
  const again = await scanCodex(root, WINDOW());
  assert.deepEqual(brief(again).filter((r) => r[1] === charOf(9) || r[1] === charOf(8)),
    [['main', charOf(8), null, charOf(8)], ['sub', charOf(9), charOf(8), charOf(8)]]);
});

test('line 0: read once and cached by inode; an incomplete line is asked again; over the cap or not this thread is no rollout', async () => {
  const root = await tmp();
  const file = await writeRollout(root, { id: cid(1), items: [{ k: 'say', text: 'x' }] });
  const cache = new Line0Cache();
  const scan = createCodexScanner({ cache, fullWalkMs: 0 });
  await scan(root, WINDOW());
  await appendLines(file, [{ k: 'say', text: 'more' }]);
  await scan(root, WINDOW());
  assert.equal(cache.reads, 1, 'the growing file is not read again');
  await fsp.rename(file, `${file}.tmp`); // a new inode at the same path
  await fsp.copyFile(`${file}.tmp`, file);
  await fsp.rm(`${file}.tmp`);
  await scan(root, WINDOW());
  assert.equal(cache.reads, 2);
  const partial = await writeRollout(root, { id: cid(2), raw: '{"type":"session_meta"' });
  assert.deepEqual(brief(await scan(root, WINDOW())).map((r) => r[1]), [charOf(1)]);
  assert.deepEqual(brief(await scan(root, WINDOW())).map((r) => r[1]), [charOf(1)]);
  assert.equal(cache.reads, 4, 'an incomplete first line is not cached');
  await fsp.writeFile(partial, `${JSON.stringify(sessionMeta({ id: cid(2) }))}\n`);
  assert.deepEqual(brief(await scan(root, WINDOW())).map((r) => r[1]), [charOf(1), charOf(2)]);
  await writeRollout(root, { id: cid(3), raw: `${JSON.stringify(sessionMeta({ id: cid(4) }))}\n` }); // another thread's id
  await writeRollout(root, { id: cid(5), raw: '{"type":"turn_context","payload":{}}\n' });
  await writeRollout(root, { id: cid(6), raw: 'not json\n' });
  const small = new Line0Cache({ maxBytes: 256 });
  await writeRollout(root, { id: cid(7) });
  const refs = await createCodexScanner({ cache: small })(root, WINDOW());
  assert.deepEqual(refs.map((r) => r.charId), [], 'every session_meta here is longer than 256 bytes');
  assert.ok(small.over >= 3);
  assert.deepEqual(brief(await scanCodex(root, WINDOW())).map((r) => r[1]), [charOf(1), charOf(2), charOf(7)]);
});

test('continuation pieces: one ref per thread; the newest piece wins, then the higher first ordinal; a pending newer piece leaves the old one', async () => {
  const root = await tmp();
  const t = Date.now();
  const base = await writeRollout(root, { id: cid(1), mtimeMs: t - 60_000 });
  const piece = await writeRollout(root, { id: cid(1), piece: cid(91), meta: { ordinal: 40 }, mtimeMs: t - 1000 });
  assert.deepEqual((await scanCodex(root, WINDOW())).map((r) => [r.charId, r.path]), [[charOf(1), piece]]);
  await setMtime(base, t); // newer again (never in practice): mtime first
  assert.deepEqual((await scanCodex(root, WINDOW())).map((r) => r.path), [base]);
  // same mtime: the piece whose first ordinal is higher
  const p2 = await writeRollout(root, { id: cid(2), piece: cid(92), meta: { ordinal: 7 }, mtimeMs: t });
  const p3 = await writeRollout(root, { id: cid(2), piece: cid(93), meta: { ordinal: 9 }, mtimeMs: t });
  await writeRollout(root, { id: cid(2), mtimeMs: t, day: OLD_DAY });
  assert.deepEqual((await scanCodex(root, WINDOW())).filter((r) => r.sessionId === cid(2)).map((r) => r.path), [p3]);
  await fsp.rm(p3);
  assert.deepEqual((await scanCodex(root, WINDOW())).filter((r) => r.sessionId === cid(2)).map((r) => r.path), [p2]);
  // a newer piece whose first line is not complete yet: the older piece still stands (no gap for the character)
  await writeRollout(root, { id: cid(3), mtimeMs: t - 5000 });
  await writeRollout(root, { id: cid(3), piece: cid(94), raw: '{"type":"sess', mtimeMs: t });
  assert.deepEqual((await scanCodex(root, WINDOW())).filter((r) => r.sessionId === cid(3)).map((r) => r.path), [rolloutPath(root, today(), cid(3))]);
});

test('order: plain mains before Codex-worktree mains (whatever the uuids), then subs by depth (D1 at startup)', async () => {
  const root = await tmp();
  const LOW = '00000000-0000-7000-8000-000000000001';
  const HIGH = 'ffffffff-0000-7000-8000-000000000002';
  await writeRollout(root, { id: LOW, meta: { cwd: path.join(root, 'worktrees', 'a1b2', 'office-demo', 'pkg') } });
  await writeRollout(root, { id: HIGH, meta: { cwd: '/work/office-demo' } });
  await writeRollout(root, { id: cid(3), meta: { source: { parent: LOW } } });
  await writeRollout(root, { id: cid(4), meta: { cwd: '/work/zzz/.worktrees/feat' } }); // a project-local worktree is a plain main
  const refs = await scanCodex(root, WINDOW());
  assert.deepEqual(refs.map((r) => [r.kind, r.sessionId]), [['main', cid(4)], ['main', HIGH], ['main', LOW], ['sub', cid(3)]]);
});

test('hot and cold folders: between full walks only recent folders are listed; a resumed old thread is found by the next walk; a new missing parent forces one early walk', async () => {
  const root = await tmp();
  const t0 = Date.now();
  await writeRollout(root, { id: cid(1) });
  await writeRollout(root, { id: cid(2), day: OLD_DAY, mtimeMs: t0 - 5 * HOUR });
  const scan = createCodexScanner({ fullWalkMs: 30_000 });
  const listed = [];
  const orig = fsp.readdir;
  fsp.readdir = function spied(p, ...rest) { listed.push(String(p)); return orig.call(this, p, ...rest); };
  const oldDir = path.join(root, 'sessions', ...OLD_DAY.split('/'));
  const at = async (dt) => (await scan(root, { activeMs: 30 * 60_000, nowMs: t0 + dt })).map((r) => r.charId);
  try {
    assert.deepEqual(await at(0), [charOf(1)]);
    assert.ok(listed.includes(oldDir), 'the first scan is a full walk');
    listed.length = 0;
    await writeRollout(root, { id: cid(2), day: OLD_DAY }); // the old thread was resumed: a fresh .jsonl in its old folder
    assert.deepEqual(await at(5000), [charOf(1)], 'not seen before the next full walk');
    assert.ok(!listed.includes(oldDir) && !listed.includes(path.join(root, 'sessions')), listed.join('\n'));
    assert.deepEqual(await at(31_000), [charOf(1), charOf(2)]);
    assert.ok(listed.includes(oldDir));
    listed.length = 0;
    // a child whose parent sits in an old folder that the last walk did not see yet: one early walk finds it
    await writeRollout(root, { id: cid(3), day: OLD_DAY, mtimeMs: t0 - 5 * HOUR });
    await writeRollout(root, { id: cid(4), meta: { source: { parent: cid(3) } } });
    assert.deepEqual(await at(33_000), [charOf(1), charOf(2), charOf(3), charOf(4)]);
    assert.equal(listed.filter((p) => p === oldDir).length, 1);
    // a parent that does not exist anywhere: the child is a main, and it does not force a walk on every scan
    await writeRollout(root, { id: cid(5), meta: { source: { parent: cid(6) } } });
    listed.length = 0;
    assert.ok((await at(34_000)).includes(charOf(5)));
    assert.ok((await at(35_000)).includes(charOf(5)));
    assert.ok((await at(36_000)).includes(charOf(5)));
    assert.equal(listed.filter((p) => p === oldDir).length, 1, 'one early walk for the new missing parent, then none');
    // an active thread in a cold folder is lstat-ed on every scan, so it leaves the window on time
    const cold = rolloutPath(root, OLD_DAY, cid(2));
    await setMtime(cold, t0 - 2 * HOUR);
    assert.ok(!(await at(37_000)).includes(charOf(2)));
  } finally {
    fsp.readdir = orig;
  }
});

test('symlinks: a linked sessions/, year, month or day folder is never listed, stat-ed through or read, in the full and the hot walk', async () => {
  const [y, m, d] = today().split('/');
  for (const level of ['day', 'month', 'year', 'sessions']) {
    const root = await tmp();
    const outside = await tmp('office-sim-codex-outside-');
    await writeRollout(outside, { id: cid(9), meta: { cwd: '/work/BAIT_OUTSIDE' } }); // an active rollout outside the root
    if (level !== 'sessions') await writeRollout(root, { id: cid(1), day: OLD_DAY }); // a real folder chain (active, cold)
    const parts = { day: [y, m, d], month: [y, m], year: [y], sessions: [] }[level];
    const link = path.join(root, 'sessions', ...parts);
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.symlink(path.join(outside, 'sessions', ...parts), link);
    const scan = createCodexScanner({ fullWalkMs: 30_000 });
    const t0 = Date.now();
    const spy = spyFs();
    const seen = [];
    try {
      for (const dt of [0, 5000, 10_000]) seen.push((await scan(root, { activeMs: 30 * 60_000, nowMs: t0 + dt })).map((r) => r.sessionId));
    } finally {
      spy.restore();
    }
    const want = level === 'sessions' ? [] : [cid(1)];
    assert.deepEqual(seen, [want, want, want], `${level}: the full walk and the hot walks agree; nothing from outside`);
    const through = spy.calls.filter((c) => c.path.startsWith(`${link}${path.sep}`) || c.path.startsWith(outside)
      || (c.path === link && !/^lstat(Sync)?$/.test(c.fn)));
    assert.deepEqual(through.map((c) => `${c.fn} ${c.path}`), [], `${level}: only lstat of the link itself`);
  }
});

test('caps: a walk past the date-folder or file cap throws SCAN_CAPPED instead of returning a cut list', async () => {
  const root = await tmp();
  for (let i = 1; i <= 3; i++) await writeRollout(root, { id: cid(i), day: `2026/10/0${i}` });
  await assert.rejects(scanCodex(root, { ...WINDOW(), limits: { ...SCAN_LIMITS, days: 2 } }), { code: 'SCAN_CAPPED' });
  await assert.rejects(scanCodex(root, { ...WINDOW(), limits: { ...SCAN_LIMITS, files: 2 } }), { code: 'SCAN_CAPPED' });
  assert.equal((await scanCodex(root, { limits: { ...SCAN_LIMITS, days: 3, files: 3 } })).length, 3, 'no window: every thread');
});

test('Runner: the session is built from the scan-time identity (kind, parent, D2 ids, facts) before the file is announced', async () => {
  const root = await tmp();
  await writeRollout(root, { id: cid(1) });
  await writeRollout(root, { id: cid(2), meta: { source: { parent: cid(1) }, historyStart: 6, cliVersion: '0.141.0' } });
  CodexTestSession.created.length = 0;
  const app = await startCodex(root);
  try {
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 2, 4000);
    const child = CodexTestSession.created.find((o) => o.id === charOf(2));
    assert.deepEqual([child.kind, child.parentId, child.agent], ['sub', charOf(1), 'codex']);
    // the ref's line-0 facts reach the session constructor as `facts` (CodexSession reads its own line 0 as well)
    assert.deepEqual(child.facts, { cwd: '/work/codex', branch: 'main', cliVersion: '0.141.0', historyStart: 6, agentType: 'explorer' });
    const s = await sessionsOf(app);
    assert.deepEqual(s.map((e) => [e.sessionId, e.isSubagent, e.parentSessionId, e.project]),
      [[charOf(1), false, null, '/work/codex'], [charOf(2), true, charOf(1), '/work/codex']]);
  } finally {
    await app.close();
  }
});

test('Runner: a continuation piece takes over the same character (no second one, no session_end); new lines come from it', async () => {
  const root = await tmp();
  const base = await writeRollout(root, { id: cid(1), mtimeMs: Date.now() - 2000,
    items: [{ k: 'turn_start', id: 't1' }, { k: 'say', text: 'Base piece.' }] });
  // the poll is held off (the slowest allowed interval) until the piece has taken over: the Runner defers the takeover
  // while a poll reads the base, and with a short poll on a slow disk the rescan kept finding the base busy (the
  // takeover waited past 15 s). Nothing before the takeover needs a poll; POST /config brings it back to 50 ms below.
  const app = await startCodex(root, { intervalMs: 5000 });
  let es = null;
  try {
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 1, 4000);
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    const piece = await writeRollout(root, { id: cid(1), piece: cid(90), meta: { ordinal: 2 }, items: [{ k: 'say', text: 'Rolled back.' }] });
    // published, not just registered: has() turns true before the replay stats the piece, and a line appended
    // before that stat is replayed silently; announced comes after the replay, so the next line is read live.
    // The bound covers a rescan plus the whole attach (real fs work), so it is wide
    await until(() => app.store.entry(piece)?.announced === true, 15_000);
    // a shorter interval moves the waiting poll up at once, so the line below is read within one 50 ms poll
    const cfg = await request(app.port, { method: 'POST', path: '/config', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intervalMs: 50 }) });
    assert.equal(cfg.status, 200);
    await appendLines(piece, [{ k: 'say', text: 'Live from the piece.' }]);
    await es.next((fr) => fr.data?.type === 'say' && fr.data.text === 'Live from the piece.', 4000);
    await setMtime(piece, Date.now() + 60_000); // the piece stays the newest while the base is touched below
    await appendLines(base, [{ k: 'say', text: 'Stale base line.' }]); // the old piece is never read again
    await setMtime(base, Date.now() - 3000);
    await new Promise((r) => setTimeout(r, 300));
    const mine = es.frames.filter((fr) => fr.data?.sessionId === charOf(1)).map((fr) => fr.data);
    assert.ok(!mine.some((e) => e.type === 'session_end'), 'the character never left');
    assert.ok(!mine.some((e) => e.text === 'Stale base line.'));
    assert.equal(app.store.has(base), false);
    assert.deepEqual((await sessionsOf(app)).map((e) => e.sessionId), [charOf(1)]);
  } finally {
    es?.close();
    await app.close();
  }
});

// ---- allowlist: every fs call is recorded while the real server runs the Codex adapter -------------------------------

const SPIED = ['open', 'readFile', 'stat', 'lstat', 'readdir', 'opendir', 'access', 'readlink', 'realpath'];
const SPIED_SYNC = ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'opendirSync', 'existsSync', 'createReadStream'];

function spyFs() {
  const calls = [];
  const saved = [];
  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    saved.push([obj, name, orig]);
    obj[name] = function spied(p, ...rest) {
      calls.push({ fn: name, path: typeof p === 'string' ? p : (p instanceof URL ? fileURLToPath(p) : String(p)) });
      return orig.call(this, p, ...rest);
    };
  };
  for (const n of SPIED) wrap(fsp, n);
  for (const n of SPIED_SYNC) wrap(fs, n);
  return { calls, restore: () => { for (const [obj, name, orig] of saved) obj[name] = orig; } };
}

test('allowlist: bait files are never opened, listed or stat-ed; a guardian thread and account ids never reach the wire (fs spy, real server)', async () => {
  const root = await tmp('office-sim-codex-allow-');
  const main = await writeRollout(root, { id: cid(1), meta: { cwd: '/work/allow' }, items: [{ k: 'turn_start', id: 't1' }, { k: 'say', text: 'Working.' }] });
  const child = await writeRollout(root, { id: cid(2), meta: { source: { parent: cid(1) } }, items: [{ k: 'say', text: 'Sub work.' }] });
  const guardian = await writeRollout(root, { id: cid(3), meta: { source: 'guardian', parentField: cid(1) },
    items: [{ k: 'turn_start', id: 'g1' }, { k: 'say', text: 'BAIT_GUARDIAN_SAY' }] });
  await appendIndex(root, [[cid(1), 'Allowlist main'], [cid(3), 'BAIT_GUARDIAN_TITLE']]);
  const day = path.dirname(main);
  const bait = [
    path.join(root, 'history.jsonl'), path.join(root, 'auth.json'), path.join(root, 'config.toml'), path.join(root, 'AGENTS.md'),
    path.join(root, 'state_5.sqlite'), path.join(root, 'logs_2.sqlite'), path.join(root, 'sqlite', 'codex-dev.db'),
    path.join(root, '.codex-global-state.json'), path.join(root, 'thread-writer-locks', 'x.lock'), path.join(root, 'version.json'),
    path.join(root, 'archived_sessions', `rollout-2026-10-20T09-00-00-${cid(4)}.jsonl.zst`),
    path.join(root, 'archived_sessions', `rollout-2026-10-20T09-00-00-${cid(5)}.jsonl`),
    `${rolloutPath(root, today(), cid(6))}.zst`, path.join(day, 'notes.txt'),
    path.join(root, 'worktrees', 'a1b2', 'repo', 'secret.txt'), path.join(root, 'shell_snapshots', 'snap.sh'),
    path.join(root, 'sessions', 'index.json'),
  ];
  for (const b of bait) {
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.writeFile(b, '{"secret":"BAIT_SECRET_TOKEN","prompt":"BAIT_RAW_PROMPT"}\n');
  }
  const spy = spyFs();
  let app = null;
  try {
    app = await startCodex(root);
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 2, 4000);
    await new Promise((r) => setTimeout(r, 300)); // more rescans, polls and title checks
    const body = (await request(app.port, { path: '/state' })).body;
    assert.ok(!body.includes('BAIT_'), 'no bait content on the wire (account ids, guardian work, bait files)');
    const sessions = JSON.parse(body).events.filter((e) => e.type === 'session');
    assert.deepEqual(sessions.map((e) => [e.sessionId, e.title, e.project, e.agent]),
      [[charOf(1), 'Allowlist main', '/work/allow', 'codex'], [charOf(2), sessions[1].title, '/work/allow', 'codex']]);
    assert.ok(!body.includes(cid(3)), 'the guardian thread never appears');
  } finally {
    await app?.close();
    spy.restore();
  }
  const under = spy.calls.filter((c) => c.path.startsWith(root));
  for (const b of bait) assert.ok(!under.some((c) => c.path === b), `bait touched: ${path.relative(root, b)}`);
  assert.ok(!under.some((c) => c.path.includes(`${path.sep}worktrees`) || c.path.includes('archived_sessions')));
  const opens = under.filter((c) => /^(open|readFile|createReadStream)(Sync)?$/.test(c.fn));
  assert.deepEqual([...new Set(opens.map((c) => path.relative(root, c.path)))].sort(),
    [main, child, guardian, path.join(root, 'session_index.jsonl')].map((p) => path.relative(root, p)).sort());
  assert.equal(opens.filter((c) => c.path === guardian).length, 1, 'the guardian file: line 0 once, never tailed');
  const home = os.homedir();
  assert.ok(!spy.calls.some((c) => c.path.startsWith(path.join(home, '.codex'))), 'the real ~/.codex is never touched');
});
