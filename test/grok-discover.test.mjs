// Grok discovery (CONTRACT 4.6, ADAPTERS 3.4, 7.1): allowlist scan of <root>/sessions/<group>/<uuid>/updates.jsonl,
// subagent linkage from subagents/<child>/ folder names across every cwd group, D2 ids, the active window with
// ancestors, the link grace, odd names, ENOENT and caps. The allowlist test spies on every fs call while a real server
// runs the Grok adapter and proves the bait files are never opened. Temp roots and invented content only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanGrok, createGrokScanner, classify, ancestorsOf, collectSessions, SCAN_LIMITS, LINK_GRACE_MS,
} from '../src/adapters/grok/discover.mjs';
import { refIdsOk } from '../src/store-link.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, until } from './fixtures/sse.mjs';
import { gid, charOf, groupOf, writeSession, transcriptOf, sessionDir, grokTestAdapter } from './fixtures/grok-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-grok-disc-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const brief = (refs) => refs.map((r) => [r.kind, r.charId, r.parentId ?? null, r.sid]);
const OLD = Date.now() - 2 * 3600_000;
const WINDOW = { activeMs: 30 * 60_000, nowMs: Date.now() + 1000 };

test('linkage across cwd groups: subagents/<child>/ names make subs, sid walks up to the root main, ids are D2', async () => {
  const root = await tmp();
  const gA = groupOf('/work/proj');
  const gB = groupOf('/work/proj/.worktrees/feat');
  await writeSession(root, { group: gA, id: gid(1), children: [gid(2), gid(9)] }); // gid(9): no folder anywhere
  await writeSession(root, { group: gB, id: gid(2), children: [gid(3)] }); // the child sits in another group
  await writeSession(root, { group: gB, id: gid(3) });
  await writeSession(root, { group: gA, id: gid(4) }); // an unrelated main
  const refs = await scanGrok(root, WINDOW);
  assert.deepEqual(brief(refs), [
    ['main', charOf(1), null, charOf(1)],
    ['main', charOf(4), null, charOf(4)],
    ['sub', charOf(2), charOf(1), charOf(1)],
    ['sub', charOf(3), charOf(2), charOf(1)],
  ]);
  for (const r of refs) {
    assert.equal(r.agent, 'grok');
    assert.equal(r.stem, r.charId);
    assert.equal(r.sessionId, r.charId.slice('grok-'.length));
    assert.ok(refIdsOk(r), `${r.charId} passes the F2 guard`);
    assert.equal(path.basename(r.path), 'updates.jsonl');
    assert.ok(Number.isFinite(r.mtimeMs) && Number.isFinite(r.size) && Number.isFinite(r.ino));
  }
  assert.equal(refs.find((r) => r.charId === charOf(2)).path, transcriptOf(root, gB, gid(2)));
});

test('active window: only transcripts inside it, plus every ancestor of an active child (a waiting parent writes nothing)', async () => {
  const root = await tmp();
  const g = groupOf('/work/win');
  await writeSession(root, { group: g, id: gid(1), children: [gid(2)], mtimeMs: OLD });
  await writeSession(root, { group: g, id: gid(2), children: [gid(3)], mtimeMs: OLD });
  await writeSession(root, { group: g, id: gid(3) }); // active grandchild
  await writeSession(root, { group: g, id: gid(4), mtimeMs: OLD }); // old main, nothing active below
  await writeSession(root, { group: g, id: gid(5), children: [gid(6)] }); // active main, old child
  await writeSession(root, { group: g, id: gid(6), mtimeMs: OLD });
  assert.deepEqual(brief(await scanGrok(root, WINDOW)), [
    ['main', charOf(1), null, charOf(1)],
    ['main', charOf(5), null, charOf(5)],
    ['sub', charOf(2), charOf(1), charOf(1)],
    ['sub', charOf(3), charOf(2), charOf(1)],
  ]);
  // no window given: everything with a transcript
  assert.equal((await scanGrok(root, {})).length, 6);
});

test('a child waits while an ancestor has no transcript yet, and is reported once it has one', async () => {
  const root = await tmp();
  const g = groupOf('/work/wait');
  await fsp.mkdir(path.join(sessionDir(root, g, gid(1)), 'subagents', gid(2)), { recursive: true }); // parent: no updates.jsonl
  await writeSession(root, { group: g, id: gid(2) });
  assert.deepEqual(brief(await scanGrok(root, WINDOW)), []);
  await fsp.writeFile(transcriptOf(root, g, gid(1)), '');
  assert.deepEqual(brief(await scanGrok(root, WINDOW)), [
    ['main', charOf(1), null, charOf(1)], ['sub', charOf(2), charOf(1), charOf(1)],
  ]);
});

test('link grace: folders present at the first scan are classified at once; a new unlinked folder waits, then is a main', async () => {
  const root = await tmp();
  const g = groupOf('/work/grace');
  await writeSession(root, { group: g, id: gid(1) });
  const scan = createGrokScanner({ linkGraceMs: 1000 });
  const t0 = Date.now();
  assert.deepEqual(brief(await scan(root, { nowMs: t0 })), [['main', charOf(1), null, charOf(1)]]);
  // a new folder no parent names yet: held for the grace
  await writeSession(root, { group: g, id: gid(2) });
  assert.deepEqual(brief(await scan(root, { nowMs: t0 + 100 })).map((r) => r[1]), [charOf(1)]);
  assert.deepEqual(brief(await scan(root, { nowMs: t0 + 900 })).map((r) => r[1]), [charOf(1)]);
  assert.deepEqual(brief(await scan(root, { nowMs: t0 + 1200 })), [['main', charOf(1), null, charOf(1)], ['main', charOf(2), null, charOf(2)]]);
  // a new child whose parent names it within the grace: a sub, never a main first
  await writeSession(root, { group: groupOf('/work/grace/.worktrees/x'), id: gid(3) });
  assert.ok(!(await scan(root, { nowMs: t0 + 1300 })).some((r) => r.charId === charOf(3)), 'held');
  await fsp.mkdir(path.join(sessionDir(root, g, gid(1)), 'subagents', gid(3)), { recursive: true });
  const refs = await scan(root, { nowMs: t0 + 1400 });
  assert.deepEqual(brief(refs).find((r) => r[1] === charOf(3)), ['sub', charOf(3), charOf(1), charOf(1)]);
  assert.equal(LINK_GRACE_MS, 1000);
});

test('odd names and shapes are skipped: non-uuid folders, files, hidden groups, symlinks, a folder without a transcript', async () => {
  const root = await tmp();
  const g = groupOf('/work/odd');
  await writeSession(root, { group: g, id: gid(1) });
  await fsp.mkdir(path.join(root, 'sessions', g, 'not-a-uuid'), { recursive: true });
  await fsp.writeFile(path.join(root, 'sessions', g, 'not-a-uuid', 'updates.jsonl'), '');
  await fsp.writeFile(path.join(root, 'sessions', g, `${gid(7)}.jsonl`), ''); // a file, not a folder
  await fsp.writeFile(path.join(root, 'sessions', 'prompt_history.jsonl'), 'BAIT');
  await writeSession(root, { group: '.hidden', id: gid(2) });
  await fsp.mkdir(sessionDir(root, g, gid(3)), { recursive: true }); // no transcript
  await fsp.mkdir(sessionDir(root, g, gid(4)), { recursive: true });
  await fsp.symlink(transcriptOf(root, g, gid(1)), transcriptOf(root, g, gid(4))); // a linked transcript
  await fsp.symlink(sessionDir(root, g, gid(1)), sessionDir(root, g, gid(5))); // a linked session folder
  await fsp.mkdir(path.join(sessionDir(root, g, gid(1)), 'subagents', 'notes'), { recursive: true }); // odd child name
  await fsp.writeFile(path.join(sessionDir(root, g, gid(1)), 'subagents', gid(6)), ''); // a child that is a file
  await writeSession(root, { group: g, id: gid(6) });
  assert.deepEqual(brief(await scanGrok(root, WINDOW)), [['main', charOf(1), null, charOf(1)], ['main', charOf(6), null, charOf(6)]]);
  // upper-case uuid folders are fine (still a valid D2 id)
  const up = gid(8).toUpperCase();
  await writeSession(root, { group: g, id: up });
  assert.ok((await scanGrok(root, WINDOW)).some((r) => r.charId === `grok-${up}` && refIdsOk(r)));
});

test('ENOENT and friends: no sessions folder is an empty list; a sessions file is a scan error; a vanished file is skipped', async () => {
  const root = await tmp();
  assert.deepEqual(await scanGrok(root, WINDOW), []);
  assert.deepEqual(await scanGrok(path.join(root, 'missing-root'), WINDOW), []);
  await fsp.writeFile(path.join(root, 'sessions'), 'not a folder');
  await assert.rejects(scanGrok(root, WINDOW), { code: 'ENOTDIR' });
  // a transcript that disappears between listing and stat
  const root2 = await tmp();
  const g = groupOf('/work/gone');
  await writeSession(root2, { group: g, id: gid(1) });
  const gone = await writeSession(root2, { group: g, id: gid(2) });
  const lstat = fsp.lstat;
  fsp.lstat = async (p, ...rest) => {
    if (p === gone) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return lstat.call(fsp, p, ...rest);
  };
  try {
    assert.deepEqual(brief(await scanGrok(root2, WINDOW)).map((r) => r[1]), [charOf(1)]);
  } finally {
    fsp.lstat = lstat;
  }
});

test('duplicates, cycles and caps: newest copy of a uuid wins, a cycle falls back to mains, work per scan is bounded', async () => {
  const root = await tmp();
  await writeSession(root, { group: groupOf('/work/a'), id: gid(1), mtimeMs: Date.now() - 60_000 });
  const newer = await writeSession(root, { group: groupOf('/work/b'), id: gid(1) });
  let refs = await scanGrok(root, WINDOW);
  assert.deepEqual(refs.map((r) => r.path), [newer]);
  // A names B and B names A: no infinite walk, both stay mains
  const root2 = await tmp();
  const g = groupOf('/work/cycle');
  await writeSession(root2, { group: g, id: gid(1), children: [gid(2)] });
  await writeSession(root2, { group: g, id: gid(2), children: [gid(1)] });
  await writeSession(root2, { group: g, id: gid(3), children: [gid(3)] }); // names itself
  refs = await scanGrok(root2, WINDOW);
  assert.deepEqual(brief(refs), [['main', charOf(1), null, charOf(1)], ['main', charOf(2), null, charOf(2)], ['main', charOf(3), null, charOf(3)]]);
  assert.equal(ancestorsOf(gid(1), new Map([[gid(1), gid(2)], [gid(2), gid(1)]])), null);
  assert.deepEqual(ancestorsOf(gid(9), new Map([[gid(9), gid(8)], [gid(8), gid(7)]])), [gid(8), gid(7)]);
  assert.equal(ancestorsOf('x', new Map([['x', 'y'], ['y', 'z']]), 1), null, 'deeper than the cap: not trusted');
  // caps (finding 8): a walk cut by a cap is never classified. Every cap that bites throws SCAN_CAPPED (the Runner logs
  // the code once and skips that rescan without detaching), so a cut by name order never drops the newest sessions.
  const root3 = await tmp();
  for (let i = 1; i <= 4; i++) await writeSession(root3, { group: groupOf(`/work/c${i}`), id: gid(i), children: [gid(10 + i), gid(20 + i)] });
  const full = await collectSessions(root3, { ...SCAN_LIMITS, groups: 4, sessions: 4, children: 2 });
  assert.deepEqual([full.sessions.size, full.parentOf.size], [4, 8], 'exactly at the caps: a whole walk');
  for (const cut of [{ groups: 3 }, { sessions: 3 }, { children: 1 }]) {
    await assert.rejects(collectSessions(root3, { ...SCAN_LIMITS, ...cut }), { code: 'SCAN_CAPPED' }, JSON.stringify(cut));
    await assert.rejects(scanGrok(root3, { ...WINDOW, limits: { ...SCAN_LIMITS, ...cut } }), { code: 'SCAN_CAPPED' });
    await assert.rejects(createGrokScanner({ limits: { ...SCAN_LIMITS, ...cut } })(root3, WINDOW), { code: 'SCAN_CAPPED' });
  }
  assert.deepEqual(SCAN_LIMITS, { groups: 10_000, sessions: 50_000, children: 5_000, depth: 16 }, 'an order of magnitude above 5000');
  // the pure classifier holds an unlinked folder when asked to and keeps mains before subs
  const sessions = new Map([[gid(1), { id: gid(1), file: '/x/1', st: { mtimeMs: 1, size: 0, ino: 1 } }],
    [gid(2), { id: gid(2), file: '/x/2', st: { mtimeMs: 1, size: 0, ino: 2 } }]]);
  assert.deepEqual(classify({ sessions, parentOf: new Map() }, { hold: (id) => id === gid(2) }).map((r) => r.charId), [charOf(1)]);
});

test('a symlinked subagents/ folder is never followed: its uuid entries link nothing (finding 5)', async () => {
  const root = await tmp();
  const outside = await tmp('office-sim-grok-outside-');
  const g = groupOf('/work/link');
  await writeSession(root, { group: g, id: gid(1) });
  await writeSession(root, { group: g, id: gid(2) });
  await fsp.mkdir(path.join(outside, gid(2)), { recursive: true }); // names a real session, but lives outside the root
  await fsp.symlink(outside, path.join(sessionDir(root, g, gid(1)), 'subagents'));
  const walk = await collectSessions(root);
  assert.deepEqual([...walk.parentOf.entries()], [], 'nothing is read through the link');
  assert.deepEqual(brief(await scanGrok(root, WINDOW)), [['main', charOf(1), null, charOf(1)], ['main', charOf(2), null, charOf(2)]]);
  // a real subagents/ folder still links, and a file named subagents is no folder
  await fsp.rm(path.join(sessionDir(root, g, gid(1)), 'subagents'));
  await fsp.writeFile(path.join(sessionDir(root, g, gid(2)), 'subagents'), 'x');
  await fsp.mkdir(path.join(sessionDir(root, g, gid(1)), 'subagents', gid(2)), { recursive: true });
  assert.deepEqual([...(await collectSessions(root)).parentOf.entries()], [[gid(2), gid(1)]]);
});

test('Runner: a capped Grok walk is logged once by code and detaches nothing (finding 8)', async () => {
  const root = await tmp();
  const g = groupOf('/work/cap');
  await writeSession(root, { group: g, id: gid(1), items: [{ k: 'turn_start', id: 'p1' }, { k: 'say', text: 'working' }] });
  const logs = [];
  const limits = { ...SCAN_LIMITS, sessions: 2 };
  const adapter = grokTestAdapter({ scan: createGrokScanner({ linkGraceMs: 0, limits }) });
  const app = await start({
    port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30, log: (l) => logs.push(l),
    root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root }, adapters: { ...ADAPTERS, grok: adapter },
  });
  try {
    await app.ready;
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.some((e) => e.sessionId === charOf(1)), 4000);
    // 오래된 폴더가 늘어 상한을 넘는다: 붙은 세션은 그대로, 새 세션은 다음 온전한 탐색 때
    await writeSession(root, { group: g, id: gid(2), mtimeMs: OLD });
    await writeSession(root, { group: g, id: gid(3), items: [{ k: 'turn_start', id: 'p9' }] });
    await until(() => logs.includes('scan failed: SCAN_CAPPED'), 4000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(logs.filter((l) => l === 'scan failed: SCAN_CAPPED').length, 1, 'logged once, by code only');
    const st = JSON.parse((await request(app.port, { path: '/state' })).body).events;
    assert.ok(st.some((e) => e.type === 'session' && e.sessionId === charOf(1)), 'the attached session stays');
    assert.ok(!st.some((e) => e.type === 'session_end'), 'nothing detached');
    assert.ok(!st.some((e) => e.sessionId === charOf(3)), 'nothing classified from a cut walk');
    await fsp.rm(sessionDir(root, g, gid(2)), { recursive: true });
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.some((e) => e.sessionId === charOf(3)), 4000);
    assert.ok(logs.includes('scan recovered'));
  } finally {
    await app.close();
  }
});

// ---- allowlist: every fs call is recorded while the real server runs the Grok adapter --------------------------------

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

test('allowlist: bait files next to the transcripts are never opened, listed by path or stat-ed (fs spy, real server)', async () => {
  const root = await tmp('office-sim-grok-allow-');
  const g = groupOf('/work/allow');
  const g2 = groupOf('/work/allow/.worktrees/w');
  const main = await writeSession(root, {
    group: g, id: gid(1), children: [gid(2)], summary: { cwd: '/work/allow', title: 'Allowlist main', branch: 'main' },
    items: [{ k: 'turn_start', id: 'p1' }, { k: 'say', text: 'Working.' }],
  });
  const child = await writeSession(root, { group: g2, id: gid(2), summary: { cwd: '/work/allow/.worktrees/w', title: 'Helper' }, items: [{ k: 'say', text: 'Sub work.' }] });
  const dir = sessionDir(root, g, gid(1));
  const bait = [
    path.join(root, 'auth.json'), path.join(root, 'config.toml'), path.join(root, 'active_sessions.json'),
    path.join(root, 'worktrees.db'), path.join(root, 'sessions', 'session_search.sqlite'),
    path.join(root, 'sessions', g, 'prompt_history.jsonl'), path.join(root, 'sessions', g, '.cwd'),
    path.join(dir, 'prompt_history.jsonl'), path.join(dir, 'chat_history.jsonl'), path.join(dir, 'events.jsonl'),
    path.join(dir, 'plan.json'), path.join(dir, 'plan.md'), path.join(dir, 'plan_mode.json'), path.join(dir, 'updates.jsonl.lock'),
    path.join(dir, 'summary.json.lock'), path.join(dir, 'subagents', gid(2), 'meta.json'), path.join(dir, 'subagents', gid(2), 'output.json'),
    path.join(dir, 'terminal', 'out-1.txt'), path.join(sessionDir(root, g2, gid(2)), 'events.jsonl'),
  ];
  for (const b of bait) {
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.writeFile(b, '{"secret":"BAIT_SECRET_TOKEN","prompt":"BAIT_RAW_PROMPT"}\n');
  }
  const spy = spyFs();
  let app = null;
  try {
    app = await start({
      port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
      root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root }, adapters: { ...ADAPTERS, grok: grokTestAdapter() },
    });
    await app.ready;
    await until(async () => {
      const st = JSON.parse((await request(app.port, { path: '/state' })).body);
      return st.events.filter((e) => e.type === 'session').length === 2;
    }, 4000);
    await new Promise((r) => setTimeout(r, 250)); // a few more rescans, polls and sidecar checks
    const body = (await request(app.port, { path: '/state' })).body;
    assert.ok(!body.includes('BAIT_'), 'no bait content on the wire');
    const sessions = JSON.parse(body).events.filter((e) => e.type === 'session');
    assert.deepEqual(sessions.map((e) => [e.sessionId, e.title, e.project]),
      [[charOf(1), 'Allowlist main', '/work/allow'], [charOf(2), 'Helper', '/work/allow']]);
  } finally {
    await app?.close();
    spy.restore();
  }
  const under = spy.calls.filter((c) => c.path.startsWith(root));
  for (const b of bait) assert.ok(!under.some((c) => c.path === b), `bait touched: ${path.relative(root, b)}`);
  // what was read under the root: transcripts (Tailer) and summary.json (sidecar) only
  const read = new Set(under.filter((c) => /^(open|readFile|createReadStream)(Sync)?$/.test(c.fn)).map((c) => path.relative(root, c.path)));
  assert.deepEqual([...read].sort(), [main, child, path.join(dir, 'summary.json'), path.join(sessionDir(root, g2, gid(2)), 'summary.json')]
    .map((p) => path.relative(root, p)).sort());
  // nothing outside the temp root that looks like a real Grok or Claude folder
  const home = os.homedir();
  assert.ok(!spy.calls.some((c) => c.path.startsWith(path.join(home, '.grok')) || c.path.startsWith(path.join(home, '.claude'))));
});
