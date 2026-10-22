// Antigravity discovery (ADAPTERS 3.1, 5.3, 7.1, D2, D6): allowlist scan of <root>/antigravity-{cli,ide}/brain/<uuid>/
// .system_generated/logs/transcript_full.jsonl (else transcript.jsonl), every conversation a main, the file preference
// by line count with its slack, the incremental line counter, the active window, odd names, symlinks, caps, the file
// switch on a real server (one character, no session_end), the allowlist fs spy with bait files for every never-open
// path, and the bin's agents line with all four roots. Temp roots and invented content only (never the real ~/.gemini).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  scanAntigravity, createAntigravityScanner, collectConversations, chooseTranscript, createLineCounter, charIdOf,
  SCAN_LIMITS, FULL_SLACK_LINES,
} from '../src/adapters/antigravity/discover.mjs';
import { refIdsOk } from '../src/store-link.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import {
  aid, charOf, CLI, IDE, APP, writeConversation, appendLines, fullOf, plainOf, brainDir, logsDir, writeSummaries, writeAnnotation,
  writeTasks, summaryOf, annotationOf, tasksOf, antigravityTestAdapter,
} from './fixtures/antigravity-tree.mjs';
import { writeSession, gid, groupOf } from './fixtures/grok-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-agy-disc-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const OLD = Date.now() - 2 * 3600_000;
const WINDOW = { activeMs: 30 * 60_000, nowMs: Date.now() + 1000 };
const brief = (refs) => refs.map((r) => [r.charId, path.basename(r.path), r.facts.base]);
const n = (k) => Array.from({ length: k }, (_, i) => ({ k: 'say', text: `line ${i}` }));

test('refs: every conversation of all three sub-roots (cli, ide, app) or a direct sub-root is a main with a D2 id', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(3), full: n(2), plain: n(2) });
  await writeConversation(root, { id: aid(1), full: null, plain: n(1) });
  await writeConversation(root, { id: aid(2), base: IDE, full: null, plain: n(3) });
  await writeConversation(root, { id: aid(4), base: APP, full: n(2), plain: n(1) });
  const refs = await scanAntigravity(root, WINDOW);
  assert.deepEqual(brief(refs), [
    [charOf(1), 'transcript.jsonl', CLI], [charOf(2), 'transcript.jsonl', IDE],
    [charOf(3), 'transcript_full.jsonl', CLI], [charOf(4), 'transcript_full.jsonl', APP],
  ]);
  const direct = await scanAntigravity(path.join(root, APP), WINDOW);
  assert.deepEqual(brief(direct), [[charOf(4), 'transcript_full.jsonl', APP]]);
  for (const r of refs) {
    assert.equal(r.agent, 'antigravity');
    assert.equal(r.kind, 'main');
    assert.equal(r.stem, r.charId);
    assert.equal(r.sid, r.charId);
    assert.equal(r.parentId, undefined);
    assert.equal(r.charId, charIdOf(r.sessionId));
    assert.ok(refIdsOk(r), `${r.charId} passes the F2 guard`);
    assert.ok(Number.isFinite(r.mtimeMs) && Number.isFinite(r.size) && Number.isFinite(r.ino));
    assert.equal(r.facts.full, path.basename(r.path) === 'transcript_full.jsonl');
  }
});

test('chooseTranscript: one file -> it; both: full when it has at least as many lines, sticky within the slack', () => {
  const st = {};
  const c = (o) => chooseTranscript({ full: st, plain: st, ...o });
  assert.equal(chooseTranscript({ full: null, plain: st }), 'plain');
  assert.equal(chooseTranscript({ full: st, plain: null }), 'full');
  assert.equal(chooseTranscript({ full: null, plain: null }), null);
  assert.equal(c({ fullLines: 10, plainLines: 10 }), 'full');
  assert.equal(c({ fullLines: 11, plainLines: 10 }), 'full');
  assert.equal(c({ fullLines: 9, plainLines: 10 }), 'plain', 'no previous choice: a shorter full file is not trusted');
  assert.equal(c({ fullLines: 44, plainLines: 118, prev: 'full' }), 'plain', 'the study case: a full file that started late');
  assert.equal(c({ fullLines: 10, plainLines: 10 + FULL_SLACK_LINES, prev: 'full' }), 'full', 'write lag within the slack');
  assert.equal(c({ fullLines: 10, plainLines: 11 + FULL_SLACK_LINES, prev: 'full' }), 'plain');
  assert.equal(c({ fullLines: 9, plainLines: 10, prev: 'plain' }), 'plain', 'on plain, full must catch up first');
  assert.equal(c({ fullLines: 10, plainLines: 10, prev: 'plain' }), 'full');
  assert.equal(c({ fullLines: null, plainLines: 10, prev: 'plain' }), 'plain', 'unknown counts keep the previous choice');
  assert.equal(c({ fullLines: null, plainLines: null }), 'full');
});

test('scanner: the full file is preferred, falls back to transcript.jsonl when it is much shorter, never flips on a short lag', async () => {
  const root = await tmp();
  const scan = createAntigravityScanner();
  // a full file that started late (the study: 44 lines against 118)
  await writeConversation(root, { id: aid(1), full: n(44), plain: n(118) });
  // full and plain in step
  await writeConversation(root, { id: aid(2), full: n(20), plain: n(20) });
  let refs = await scan(root, WINDOW);
  assert.deepEqual(brief(refs).map((r) => r[1]), ['transcript.jsonl', 'transcript_full.jsonl']);
  // aid(2): plain runs a few lines ahead (write lag): stays on full
  await appendLines(plainOf(root, aid(2)), n(5));
  refs = await scan(root, WINDOW);
  assert.equal(path.basename(refs[1].path), 'transcript_full.jsonl');
  // ... and much further ahead: switches to plain
  await appendLines(plainOf(root, aid(2)), n(FULL_SLACK_LINES));
  refs = await scan(root, WINDOW);
  assert.equal(path.basename(refs[1].path), 'transcript.jsonl');
  // on plain it goes back to full only once full has caught up
  await appendLines(fullOf(root, aid(2)), n(FULL_SLACK_LINES));
  assert.equal(path.basename((await scan(root, WINDOW))[1].path), 'transcript.jsonl');
  await appendLines(fullOf(root, aid(2)), n(5));
  assert.equal(path.basename((await scan(root, WINDOW))[1].path), 'transcript_full.jsonl');
  // a partial last line is not a line
  await fsp.appendFile(plainOf(root, aid(2)), '{"k":"say","text":"half');
  assert.equal(path.basename((await scan(root, WINDOW))[1].path), 'transcript_full.jsonl');
  // aid(1) stays on plain while full stays behind
  assert.equal(path.basename((await scan(root, WINDOW))[0].path), 'transcript.jsonl');
});

test('line counter: reads only appended bytes, starts over after an inode change or a shrink, keeps progress past the budget', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'transcript.jsonl');
  await fsp.writeFile(f, 'a\nb\nc\n');
  const counter = createLineCounter();
  const st = async () => fsp.lstat(f);
  assert.deepEqual(await counter.count(f, await st(), 1e6), { lines: 3, used: 6 });
  await fsp.appendFile(f, 'd\ne');
  assert.deepEqual(await counter.count(f, await st(), 1e6), { lines: 4, used: 3 }, 'only the 3 new bytes; the partial line is no line');
  assert.deepEqual(await counter.count(f, await st(), 1e6), { lines: 4, used: 0 });
  await fsp.writeFile(f, 'x\n'); // shrink
  assert.deepEqual(await counter.count(f, await st(), 1e6), { lines: 1, used: 2 });
  // 옛 파일을 지우지 않고 옮겨 둔다: 지우면 리눅스(ext4)가 같은 inode 번호를 바로 다시 쓸 수 있다
  await fsp.rename(f, path.join(dir, 'old-transcript.jsonl'));
  await fsp.writeFile(f, 'p\nq\nr\ns\n'); // a new inode
  const r = await counter.count(f, await st(), 3);
  assert.deepEqual(r, { lines: null, used: 3 }, 'budget ran out');
  assert.deepEqual(await counter.count(f, await st(), 100), { lines: 4, used: 5 }, 'continues where it stopped');
  // a symlink in place of the file is not read (O_NOFOLLOW + same inode)
  const real = path.join(dir, 'real.jsonl');
  await fsp.writeFile(real, 'z\n');
  const link = path.join(dir, 'link.jsonl');
  await fsp.symlink(real, link);
  assert.equal((await counter.count(link, await fsp.stat(real), 100)).lines, null);
  counter.prune(new Set([f]));
  assert.equal(counter.size, 1);
});

test('active window: a conversation counts when its newest transcript was written inside it', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(1), full: n(1), plain: n(1), mtimeMs: OLD });
  await writeConversation(root, { id: aid(2), full: n(1) });
  await writeConversation(root, { id: aid(3), full: n(1), plain: n(1), mtimeMs: OLD });
  await fsp.utimes(plainOf(root, aid(3)), new Date(), new Date()); // only transcript.jsonl is fresh
  assert.deepEqual((await scanAntigravity(root, WINDOW)).map((r) => r.charId), [charOf(2), charOf(3)]);
  assert.equal((await scanAntigravity(root, {})).length, 3, 'no window: every conversation');
});

test('odd names and shapes: non-uuid folders, files, symlinked conversation / .system_generated / logs / transcript / brain / sub-root', async () => {
  const root = await tmp();
  const outside = await tmp('office-sim-agy-outside-');
  await writeConversation(root, { id: aid(1), full: n(1) });
  await fsp.mkdir(path.join(root, CLI, 'brain', 'not-a-uuid', '.system_generated', 'logs'), { recursive: true });
  await fsp.writeFile(path.join(root, CLI, 'brain', 'not-a-uuid', '.system_generated', 'logs', 'transcript_full.jsonl'), '{}\n');
  await fsp.writeFile(path.join(root, CLI, 'brain', aid(9)), 'a file, not a folder');
  await fsp.mkdir(brainDir(root, aid(8)), { recursive: true }); // no .system_generated
  // links: a conversation folder, .system_generated, logs, the transcript itself, all pointing at real data outside
  await writeConversation(outside, { id: aid(2), full: n(1) });
  await fsp.symlink(brainDir(outside, aid(2)), brainDir(root, aid(2)));
  await fsp.mkdir(brainDir(root, aid(3)), { recursive: true });
  await fsp.symlink(path.join(brainDir(outside, aid(2)), '.system_generated'), path.join(brainDir(root, aid(3)), '.system_generated'));
  await fsp.mkdir(path.join(brainDir(root, aid(4)), '.system_generated'), { recursive: true });
  await fsp.symlink(logsDir(outside, aid(2)), logsDir(root, aid(4)));
  await fsp.mkdir(logsDir(root, aid(5)), { recursive: true });
  await fsp.symlink(fullOf(outside, aid(2)), fullOf(root, aid(5)));
  // a symlinked brain/ and a symlinked sub-root are no folders at all
  const root2 = await tmp();
  await fsp.mkdir(path.join(root2, CLI), { recursive: true });
  await fsp.symlink(path.join(outside, CLI, 'brain'), path.join(root2, CLI, 'brain'));
  await fsp.symlink(path.join(outside, CLI), path.join(root2, IDE));
  const links = [brainDir(root, aid(2)), path.join(brainDir(root, aid(3)), '.system_generated'), logsDir(root, aid(4)),
    fullOf(root, aid(5)), path.join(root2, CLI, 'brain'), path.join(root2, IDE)];
  const spy = spyFs();
  try {
    assert.deepEqual((await scanAntigravity(root, WINDOW)).map((r) => r.charId), [charOf(1)]);
    assert.deepEqual(await scanAntigravity(root2, WINDOW), []);
  } finally {
    spy.restore();
  }
  // a link itself may be lstat-ed (that is how it is recognized), but never listed, opened or walked through
  for (const l of links) {
    assert.ok(!spy.calls.some((c) => c.path.startsWith(`${l}${path.sep}`)), `walked through ${path.relative(root, l)}`);
    const other = spy.calls.find((c) => c.path === l && c.fn !== 'lstat');
    assert.equal(other, undefined, `${other?.fn} on ${path.relative(root, l)}`);
  }
  assert.ok(!spy.calls.some((c) => c.path.startsWith(outside)));
});

test('the same uuid under both sub-roots is one conversation: the newer one wins', async () => {
  const root = await tmp();
  await writeConversation(root, { id: aid(1), full: n(1), mtimeMs: OLD + 1000 });
  await writeConversation(root, { id: aid(1), base: IDE, full: null, plain: n(1) });
  assert.deepEqual(brief(await scanAntigravity(root, {})), [[charOf(1), 'transcript.jsonl', IDE]]);
  const { size } = await collectConversations(root);
  assert.equal(size, 1);
});

test('missing roots are empty; a brain that is a file or cannot be read fails the scan; the folder cap throws SCAN_CAPPED', async () => {
  assert.deepEqual(await scanAntigravity(path.join(await tmp(), 'missing'), WINDOW), []);
  const gemini = await tmp(); // a ~/.gemini with Gemini CLI data only
  await fsp.mkdir(path.join(gemini, 'tmp', 'x'), { recursive: true });
  await fsp.writeFile(path.join(gemini, CLI), 'a file named like the sub-root');
  assert.deepEqual(await scanAntigravity(gemini, WINDOW), []);
  const bad = await tmp();
  await fsp.mkdir(path.join(bad, CLI), { recursive: true });
  await fsp.writeFile(path.join(bad, CLI, 'brain'), 'not a folder');
  await assert.rejects(scanAntigravity(bad, WINDOW), { code: 'ENOTDIR' });
  const capped = await tmp();
  for (let i = 1; i <= 3; i++) await writeConversation(capped, { id: aid(i), full: n(1) });
  await assert.rejects(scanAntigravity(capped, { ...WINDOW, limits: { ...SCAN_LIMITS, conversations: 2 } }), { code: 'SCAN_CAPPED' });
  assert.equal((await scanAntigravity(capped, { ...WINDOW, limits: { ...SCAN_LIMITS, conversations: 3 } })).length, 3);
});

test('the preferred file changes while the server runs: one character moves to it, no session_end, live lines follow', async () => {
  const root = await tmp();
  const { plain } = await writeConversation(root, { id: aid(1), full: null, plain: [{ k: 'turn_start' }, { k: 'say', text: 'from the plain file' }] });
  // 진짜 스캐너를 감싸 끝난 scan 수를 센다: 옮긴 뒤 몇 번의 rescan 을 시간이 아니라 횟수로 기다린다
  let scans = 0;
  const realScan = createAntigravityScanner();
  const scan = async (r, o) => {
    const refs = await realScan(r, o);
    scans += 1;
    return refs;
  };
  const app = await start({ ...FAST, root: path.join(root, 'no-claude'), agents: ['antigravity'], roots: { antigravity: root },
    adapters: { ...ADAPTERS, antigravity: antigravityTestAdapter({ scan }) } });
  let client = null;
  try {
    client = await sse(app.port); // try 안에서: 연결이 실패해도 finally 가 서버를 닫는다
    await app.ready;
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.some((e) => e.type === 'session'), 4000);
    await appendLines(plain, [{ k: 'say', text: 'still plain' }]);
    await client.next((fr) => fr.data?.type === 'say' && fr.data.text === 'still plain', 4000);
    // the full file appears with every line: the conversation moves to it (full has caught up)
    await writeConversation(root, { id: aid(1), full: [{ k: 'turn_start' }, { k: 'say', text: 'from the plain file' }, { k: 'say', text: 'still plain' }], plain: null });
    // 옮겨 갔다: full 파일의 새 항목이 replay 와 announce 까지 끝났다 (announce 가 붙이기의 마지막 단계라 Tailer 는 replay 끝에
    // 있고, 다음 줄은 라이브로 읽힌다). 옮기기 전에는 이 경로의 항목이 없어 예전 상태로는 참이 되지 않는다.
    // 상한 20초: 돌던 rescan, 두 파일의 줄을 세는 다음 rescan, replay 와 메타 파일 확인까지라 이 파일에서 가장 무거운 기다림이다
    // (느린 fs 에서 몇 초). 조건이 서면 바로 끝나므로 보통은 수십 ms 다.
    await until(() => app.store.entry(fullOf(root, aid(1)))?.announced === true, 20_000);
    await appendLines(fullOf(root, aid(1)), [{ k: 'say', text: 'now from full' }]);
    await client.next((fr) => fr.data?.type === 'say' && fr.data.text === 'now from full', 4000);
    // 옮긴 것이 유지된다: 다음 rescan 들이 transcript.jsonl 로 되돌리지 않는다 (되돌리면 full 파일의 다음 줄을 잃는다).
    // 시간이 아니라 횟수로 센다 (느린 기계에서도 같은 수의 rescan): 다섯 번을 보려고 여섯 번을 기다린다. s0 때 돌던 scan 이나
    // 'defer' 로 한 번 밀린 옮기기가 경계를 하나 옮길 수 있어서다.
    const s0 = scans;
    await until(() => scans >= s0 + 6, 30_000);
    assert.equal(app.store.entry(fullOf(root, aid(1)))?.announced, true, 'still on the full file a few rescans later');
    assert.equal(app.store.entry(plain), null, 'transcript.jsonl is not attached again');
    await appendLines(fullOf(root, aid(1)), [{ k: 'say', text: 'later from full' }]);
    await client.next((fr) => fr.data?.type === 'say' && fr.data.text === 'later from full', 4000);
    const all = client.frames.map((fr) => fr.data).filter(Boolean);
    assert.ok(!all.some((e) => e.type === 'session_end'), 'a move is not an end');
    const ids = new Set(all.filter((e) => e.sessionId).map((e) => e.sessionId));
    assert.deepEqual([...ids], [charOf(1)], 'one character');
    const st = JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'session');
    assert.deepEqual(st.map((e) => e.sessionId), [charOf(1)]);
    assert.equal(app.stats().files, 1);
  } finally {
    client?.close();
    await app.close();
  }
});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- allowlist: every fs call is recorded while the real server runs the Antigravity adapter --------------------------

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
  for (const name of SPIED) wrap(fsp, name);
  for (const name of SPIED_SYNC) wrap(fs, name);
  return { calls, restore: () => { for (const [obj, name, orig] of saved) obj[name] = orig; } };
}

test('allowlist: bait files for every never-open path and symlinked folders are never opened, listed or stat-ed (fs spy, real server)', async () => {
  const root = await tmp('office-sim-agy-allow-');
  const outside = await tmp('office-sim-agy-allow-out-');
  const BAIT = '{"secret":"BAIT_SECRET_TOKEN","prompt":"BAIT_RAW_PROMPT","workspace":"/BAIT/ws"}\n';
  const cli = await writeConversation(root, { id: aid(1), full: [{ k: 'turn_start' }, { k: 'say', text: 'cli work' }], plain: [{ k: 'say', text: 'x' }] });
  const ide = await writeConversation(root, { id: aid(2), base: IDE, full: null, plain: [{ k: 'say', text: 'ide work' }] });
  await writeSummaries(root, [{ id: aid(1), title: 'Allow title', cwd: '/work/allow', branch: 'main', remote: 'BAIT/repo' }]);
  await writeAnnotation(root, aid(1), 'Allowlist conversation');
  await writeTasks(root, aid(2), '- [ ] ide task\n', IDE);
  // an unallowed sub-root with a valid-looking transcript: skipped by path, not by shape
  const desk = await writeConversation(root, { id: aid(3), base: 'antigravity-bait', full: [{ k: 'say', text: 'BAIT desktop' }] });
  const c1 = brainDir(root, aid(1));
  const gen1 = path.join(c1, '.system_generated');
  const bait = [
    desk.full, path.join(root, 'antigravity', 'conversations', `${aid(3)}.pb`), path.join(root, 'antigravity-bait', 'agyhub_summaries_proto.pb'),
    path.join(root, 'antigravity-bait', 'brain', aid(3), 'task.md'), path.join(root, 'antigravity-bait', 'annotations', `${aid(3)}.pbtxt`),
    path.join(root, CLI, 'conversations', `${aid(1)}.db`), path.join(root, CLI, 'conversations', `${aid(1)}.db-wal`),
    path.join(root, CLI, 'conversations', `${aid(1)}.db-shm`), path.join(root, CLI, 'conversations', `${aid(1)}.pb`),
    path.join(root, CLI, 'conversation_summaries.db'), path.join(root, CLI, 'history.jsonl'), path.join(root, CLI, 'history', 'x.jsonl'),
    path.join(root, CLI, 'cache', 'last_conversations.json'), path.join(root, CLI, 'cache', 'conversation_metadata.json'),
    path.join(root, CLI, 'log', 'cli-2026-10-20_10-00-00.log'), path.join(root, CLI, 'presence', `${aid(1)}.lock`),
    path.join(root, CLI, 'implicit', `${aid(1)}.pb`), path.join(root, IDE, 'browser_recordings', 'a.jpg'),
    path.join(gen1, 'messages', `${aid(9)}.json`), path.join(gen1, 'messages', 'read.json'), path.join(gen1, 'steps', '3', 'output.txt'),
    path.join(gen1, 'tasks', 'task-1.log'), path.join(gen1, 'logs', 'chunks', 'transcript_full', '00000001.jsonl'),
    path.join(gen1, 'history.jsonl'), path.join(gen1, 'logs', 'history.jsonl'), path.join(c1, 'history', 'h.jsonl'),
    path.join(c1, 'settings.json'), path.join(c1, 'oauth_creds.json'),
    path.join(gen1, 'logs', 'chunks', 'transcript', '00000001.jsonl'), path.join(gen1, 'logs', 'other.jsonl'),
    path.join(c1, 'walkthrough.md'), path.join(c1, 'implementation_plan.md'), path.join(c1, 'walkthrough.md.metadata.json'),
    path.join(c1, 'task.md.resolved.1'), path.join(c1, 'scratch', 'notes.md'), path.join(c1, '.git', 'HEAD'),
    path.join(root, 'oauth_creds.json'), path.join(root, 'google_accounts.json'), path.join(root, 'settings.json'),
    path.join(root, 'settings.local.json'), path.join(root, 'state.json'), path.join(root, 'trustedFolders.json'),
    path.join(root, 'projects.json'), path.join(root, 'history', 'h.jsonl'), path.join(root, 'history.jsonl'),
    path.join(root, 'sandbox', 'x.json'), path.join(root, 'tmp', 'chat.jsonl'), path.join(root, 'config', 'c.json'),
  ];
  for (const b of bait) {
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.writeFile(b, BAIT);
  }
  // symlinked folders that point at a real-looking conversation outside the root
  await writeConversation(outside, { id: aid(7), full: [{ k: 'say', text: 'BAIT linked' }] });
  await fsp.symlink(brainDir(outside, aid(7)), brainDir(root, aid(7)));
  await fsp.mkdir(brainDir(root, aid(8)), { recursive: true });
  await fsp.symlink(path.join(brainDir(outside, aid(7)), '.system_generated'), path.join(brainDir(root, aid(8)), '.system_generated'));
  const spy = spyFs();
  let app = null;
  try {
    app = await start({ ...FAST, root: path.join(root, 'no-claude'), agents: ['antigravity'], roots: { antigravity: root },
      adapters: { ...ADAPTERS, antigravity: antigravityTestAdapter() } });
    await app.ready;
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'session').length === 2, 4000);
    await sleepMs(300); // a few more rescans, polls and sidecar checks
    const body = (await request(app.port, { path: '/state' })).body;
    assert.ok(!body.includes('BAIT'), 'no bait content on the wire');
    const sessions = JSON.parse(body).events.filter((e) => e.type === 'session');
    assert.deepEqual(sessions.map((e) => [e.sessionId, e.title, e.project]).sort(),
      [[charOf(1), 'Allowlist conversation', '/work/allow'], [charOf(2), aid(2).slice(0, 8), '']].sort(), 'no summary entry: no floor yet');
  } finally {
    await app?.close();
    spy.restore();
  }
  const under = spy.calls.filter((c) => c.path.startsWith(root));
  for (const b of bait) assert.ok(!under.some((c) => c.path === b), `bait touched: ${path.relative(root, b)}`);
  assert.ok(!under.some((c) => c.path.startsWith(path.join(root, 'antigravity-bait') + path.sep) || c.path === path.join(root, 'antigravity-bait')),
    'nothing under an unallowed sub-root, not even a stat');
  assert.ok(!under.some((c) => c.fn.startsWith('readdir') && c.path === root), 'the root itself is never listed');
  assert.ok(!spy.calls.some((c) => c.path.startsWith(outside)), 'symlinks are never followed out of the root');
  // what was opened under the root: the transcripts (line counts and the Tailer; transcript.jsonl of aid(1) only to count
  // its lines) and the sidecars that exist (the CLI summaries file, aid(1)'s annotation, aid(2)'s task.md)
  const read = new Set(under.filter((c) => /^(open|readFile|createReadStream)(Sync)?$/.test(c.fn)).map((c) => path.relative(root, c.path)));
  assert.deepEqual([...read].sort(), [cli.full, cli.plain, ide.plain, summaryOf(root), annotationOf(root, aid(1)), tasksOf(root, aid(2), IDE)]
    .map((p) => path.relative(root, p)).sort());
  const home = os.homedir();
  assert.ok(!spy.calls.some((c) => c.path.startsWith(path.join(home, '.gemini'))), 'the real ~/.gemini is never touched');
});

test('bin: "office-sim: agents claude-code,codex,grok,antigravity" when all four default roots exist (HOME is a temp dir)', async () => {
  const home = await tmp('office-sim-agy-home-');
  await fsp.mkdir(path.join(home, '.claude', 'projects'), { recursive: true });
  await fsp.mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
  await writeSession(path.join(home, '.grok'), { group: groupOf('/work/bin'), id: gid(1) });
  await writeConversation(path.join(home, '.gemini'), { id: aid(1), full: [{ k: 'say', text: 'bin' }] });
  const child = spawn(process.execPath, [BIN, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((r) => child.on('close', (code) => r(code))); // close: stdout 도 다 읽은 뒤
  // 자식의 사건으로 기다린다: agents 줄이 끝까지 나오면 이어 가고, 그 전에 자식이 끝나면 (spawn 실패 포함) 바로 실패한다.
  // 상한 20초: node 를 띄우고 네 기본 루트를 살핀 뒤 listen 하는 진짜 일이라 바쁜 기계에서는 5초를 넘을 수 있다.
  let timer = null;
  const failed = new Promise((_, reject) => {
    child.once('exit', (code, sig) => reject(new Error(`bin ended before it was up (${code ?? sig}): ${err}`)));
    child.once('error', reject);
    timer = setTimeout(() => reject(new Error(`bin not up within 20 s: ${err}`)), 20_000);
  });
  const printed = new Promise((resolve) => {
    child.stdout.on('data', (c) => {
      out += c;
      if (/^office-sim: agents [^\n]*\n/m.test(out)) resolve();
    });
  });
  try {
    await Promise.race([printed, failed]);
    // bin 은 SIGINT 처리기를 이 줄을 찍은 바로 뒤 (같은 동기 구간) 에 단다. 그 전에 온 SIGINT 는 기본 동작으로 자식을 죽인다
    // (종료 코드 null). 요청 하나가 돌아오면 그 구간은 끝났다.
    const url = out.match(/^office-sim: (http:\/\/\S+)$/m)?.[1];
    assert.ok(url, `no url line before the agents line: ${out}`);
    await Promise.race([request(Number(new URL(url).port), { path: '/healthz' }), failed]);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  child.kill('SIGINT');
  assert.equal(await exited, 0, err);
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines[1], 'office-sim: agents claude-code,codex,grok,antigravity');
  assert.ok(!out.includes('is not implemented yet'));
});
