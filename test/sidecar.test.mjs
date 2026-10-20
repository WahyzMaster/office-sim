// SidecarWatcher (ADAPTERS 3.3, CONTRACT 4.6): small metadata files are stat-ed at each rescan and re-read only when
// their inode, size or mtime changed (1 MB cap, parse errors ignored); the Grok summary.json parser keeps title, cwd and
// branch only; the Runner reads the sidecars once before a session is announced and then at each rescan, and only for an
// adapter with the hook (Claude has none). Temp roots and invented content only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarWatcher, SIDECAR_MAX_BYTES } from '../src/core/sidecar.mjs';
import { parseSummary, grokSidecars, grok } from '../src/adapters/grok/index.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';
import { Runner } from '../src/server-runner.mjs';
import { Store } from '../src/store.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { gid, charOf, groupOf, writeSession, sessionDir, summaryJson, appendLines, grokTestAdapter } from './fixtures/grok-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-sidecar-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// counts the opens of one file (the watcher reads with fsp.open)
function countOpens(file) {
  const orig = fsp.open;
  let n = 0;
  fsp.open = function counted(p, ...rest) {
    if (p === file) n += 1;
    return orig.call(this, p, ...rest);
  };
  return { get n() { return n; }, restore: () => { fsp.open = orig; } };
}

const jsonSpec = (file) => ({ path: file, parse: (buf) => JSON.parse(buf.toString('utf8')) });
const setMtime = (file, sec) => fsp.utimes(file, sec, sec);

test('SidecarWatcher: the first check reads, an unchanged file is not read again, a changed one is', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'meta.json');
  await fsp.writeFile(file, JSON.stringify({ title: 'aaaa' }));
  await setMtime(file, 1_700_000_000);
  const w = new SidecarWatcher(() => [jsonSpec(file)]);
  const ref = { path: path.join(dir, 'log.jsonl') };
  const opens = countOpens(file);
  try {
    assert.deepEqual(await w.check(ref), { title: 'aaaa' });
    assert.equal(await w.check(ref), null, 'unchanged: nothing new');
    assert.equal(await w.check(ref), null);
    assert.equal(opens.n, 1, 'stat only after the first read');
    // rewritten in place with the same size: only the mtime differs
    await fsp.writeFile(file, JSON.stringify({ title: 'bbbb' }));
    await setMtime(file, 1_700_000_100);
    assert.deepEqual(await w.check(ref), { title: 'bbbb' });
    // same size and mtime, but a new inode (written aside and renamed over)
    const aside = path.join(dir, 'meta.json.tmp');
    await fsp.writeFile(aside, JSON.stringify({ title: 'cccc' }));
    await setMtime(aside, 1_700_000_100);
    await fsp.rename(aside, file);
    assert.deepEqual(await w.check(ref), { title: 'cccc' });
    assert.equal(opens.n, 3);
    // forget: read again from scratch (a detached or moved transcript)
    w.forget(ref.path);
    assert.deepEqual(await w.check(ref), { title: 'cccc' });
  } finally {
    opens.restore();
  }
});

test('SidecarWatcher: size cap, parse errors, missing files, symlinks and broken hooks are ignored', async () => {
  const dir = await tmp();
  const ref = { path: path.join(dir, 'log.jsonl') };
  assert.equal(SIDECAR_MAX_BYTES, 1024 * 1024);
  // over the cap: never opened
  const big = path.join(dir, 'big.json');
  await fsp.writeFile(big, JSON.stringify({ title: 'x'.repeat(SIDECAR_MAX_BYTES) }));
  const opens = countOpens(big);
  try {
    assert.equal(await new SidecarWatcher(() => [jsonSpec(big)]).check(ref), null);
    assert.equal(opens.n, 0);
  } finally {
    opens.restore();
  }
  const small = path.join(dir, 'small.json');
  await fsp.writeFile(small, JSON.stringify({ title: 'fits' }));
  assert.equal(await new SidecarWatcher(() => [jsonSpec(small)], { maxBytes: 5 }).check(ref), null);
  // invalid JSON: ignored, and not re-read until the file changes
  const bad = path.join(dir, 'bad.json');
  await fsp.writeFile(bad, '{"title": "half');
  await setMtime(bad, 1_700_000_000);
  const w = new SidecarWatcher(() => [jsonSpec(bad)]);
  assert.equal(await w.check(ref), null);
  assert.equal(await w.check(ref), null);
  await fsp.writeFile(bad, '{"title":"whole"}');
  await setMtime(bad, 1_700_000_200);
  assert.deepEqual(await w.check(ref), { title: 'whole' });
  // missing, then created; removed, then created again
  const late = path.join(dir, 'late.json');
  const lw = new SidecarWatcher(() => [jsonSpec(late)]);
  assert.equal(await lw.check(ref), null);
  await fsp.writeFile(late, '{"title":"now"}');
  assert.deepEqual(await lw.check(ref), { title: 'now' });
  await fsp.rm(late);
  assert.equal(await lw.check(ref), null, 'gone: keeps nothing new, no error');
  await fsp.writeFile(late, '{"title":"back"}');
  assert.deepEqual(await lw.check(ref), { title: 'back' });
  // a symlink is not followed; a directory is not a sidecar
  const link = path.join(dir, 'link.json');
  await fsp.symlink(small, link);
  assert.equal(await new SidecarWatcher(() => [jsonSpec(link)]).check(ref), null);
  assert.equal(await new SidecarWatcher(() => [jsonSpec(dir)]).check(ref), null);
  // parse returning junk, a throwing hook, a non-array hook, bad specs
  assert.equal(await new SidecarWatcher(() => [{ path: small, parse: () => ['x'] }]).check(ref), null);
  assert.equal(await new SidecarWatcher(() => { throw new Error('boom'); }).check(ref), null);
  assert.equal(await new SidecarWatcher(() => 'nope').check(ref), null);
  assert.equal(await new SidecarWatcher(() => [null, { path: 1 }, { path: small }]).check(ref), null);
  // two sidecars: the fields of every file read now are merged
  const other = path.join(dir, 'other.json');
  await fsp.writeFile(other, '{"branch":"main"}');
  assert.deepEqual(await new SidecarWatcher(() => [jsonSpec(small), jsonSpec(other)]).check(ref), { title: 'fits', branch: 'main' });
});

test('Grok summary.json: title, cwd, branch (+ a subagent\'s agentType) only; another session or a non-object is ignored', () => {
  const id = gid(1);
  const ref = { path: `/r/sessions/g/${id}/updates.jsonl`, sessionId: id };
  const buf = (obj) => Buffer.from(JSON.stringify(obj));
  const bait = { session_summary: 'BAIT_SUMMARY', last_recap: 'BAIT_RECAP', git_remotes: ['https://bait.example.com/r?t=1'], parent_session_id: gid(9) };
  assert.deepEqual(parseSummary(Buffer.from(summaryJson({ id, cwd: '/work/p', title: 'Fix the parser', branch: 'feat/x', extra: bait })), ref),
    { title: 'Fix the parser', cwd: '/work/p', branch: 'feat/x' }, 'a main: its agent_name is the profile, not used');
  for (const kind of ['subagent', 'subagent_resume']) {
    assert.deepEqual(parseSummary(Buffer.from(summaryJson({ id, title: 'Sub', extra: { ...bait, session_kind: kind, agent_name: 'explore' } })), ref),
      { title: 'Sub', agentType: 'explore', subagent: true }, kind);
    // finding 4: the flag alone, even without other fields, so a session attached as main stops sending its task
    assert.deepEqual(parseSummary(buf({ info: { id }, session_kind: kind }), ref), { subagent: true }, `${kind} flag only`);
  }
  assert.equal(parseSummary(buf({ info: { id: gid(2), cwd: '/work/p' }, generated_title: 'Other' }), ref), null);
  assert.deepEqual(parseSummary(buf({ info: { cwd: '/work/p' } }), ref), { cwd: '/work/p' }, 'no info.id: fine');
  assert.equal(parseSummary(buf({ info: { id, cwd: 'relative/dir' }, generated_title: ' ', head_branch: 7 }), ref), null);
  assert.equal(parseSummary(buf([1, 2]), ref), null);
  assert.equal(parseSummary(buf('text'), ref), null);
  assert.throws(() => parseSummary(Buffer.from('{oops'), ref), SyntaxError);
  assert.deepEqual(grokSidecars(ref).map((s) => s.path), [`/r/sessions/g/${id}/summary.json`]);
  assert.deepEqual(grokSidecars({}), []);
  assert.equal(grok.sidecars, grokSidecars);
});

test('SidecarWatcher: the file read is the regular file that was lstat-ed (a swap to a symlink or another file is not read, finding 6)', async () => {
  const dir = await tmp();
  const outside = await tmp('office-sim-sidecar-outside-');
  const ref = { path: path.join(dir, 'log.jsonl') };
  const secret = path.join(outside, 'secret.json');
  await fsp.writeFile(secret, '{"title":"OUTSIDE-BAIT"}');
  const summary = path.join(dir, 'summary.json');
  const orig = fsp.lstat;
  // 1) lstat sees a regular file, then summary.json becomes a symlink before the open (the stub stands in for the race)
  await fsp.symlink(secret, summary);
  fsp.lstat = async function raced(q, ...rest) {
    return q === summary ? fsp.stat(q) : orig.call(this, q, ...rest); // the target's stat: a regular file
  };
  try {
    assert.equal(await new SidecarWatcher(() => [jsonSpec(summary)]).check(ref), null, 'O_NOFOLLOW: the link is not opened');
  } finally {
    fsp.lstat = orig;
  }
  // 2) the file that is opened is not the one that was lstat-ed (another inode): not read
  await fsp.rm(summary);
  await fsp.writeFile(summary, '{"title":"SWAPPED-BAIT"}');
  fsp.lstat = async function swapped(q, ...rest) {
    const st = await orig.call(this, q, ...rest);
    if (q === summary) st.ino += 1;
    return st;
  };
  try {
    assert.equal(await new SidecarWatcher(() => [jsonSpec(summary)]).check(ref), null, 'inode differs: not read');
  } finally {
    fsp.lstat = orig;
  }
  assert.deepEqual(await new SidecarWatcher(() => [jsonSpec(summary)]).check(ref), { title: 'SWAPPED-BAIT' }, 'no race: read');
});

test('Runner: the sidecar hook is used only when the deps have it (Claude has none)', async () => {
  const store = new Store();
  const opts = { root: '/nonexistent-office-sim-root', intervalMs: 50, rescanMs: 100, idleMs: 50, activeMinutes: 30 };
  const claude = new Runner({ opts: { ...opts }, deps: await claudeCode.deps(), store, log: () => {} });
  assert.equal(claude.sidecars, null);
  const g = new Runner({ opts: { ...opts }, deps: await grokTestAdapter().deps(), store, log: () => {} });
  assert.ok(g.sidecars instanceof SidecarWatcher);
  assert.deepEqual([...store.floorRules.keys()], ['grok'], 'only the grok Runner registers a D1 floor rule');
});

test('server: the first session event already has the summary title, cwd and branch; a change sends one session event', async () => {
  const root = await tmp('office-sim-sidecar-srv-');
  const g = groupOf('/work/side');
  const id = gid(1);
  const summaryPath = path.join(sessionDir(root, g, id), 'summary.json');
  const main = await writeSession(root, {
    group: g, id, children: [gid(2)], summary: { cwd: '/work/side', title: 'Sidecar main', branch: 'feat/side' },
    items: [{ k: 'turn_start', id: 'p1' }, { k: 'tool_start', id: 't1', desc: { tool: 'read_file', kind: 'read', path: '/work/side/a.md' } }],
  });
  const child = await writeSession(root, { group: groupOf('/work/side/.worktrees/w'), id: gid(2),
    summary: { cwd: '/work/side/.worktrees/w', title: 'Helper', extra: { session_kind: 'subagent', agent_name: 'explore' } },
    items: [{ k: 'say', text: 'sub work' }] });
  const app = await start({
    port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
    root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root }, adapters: { ...ADAPTERS, grok: grokTestAdapter() },
  });
  let es = null;
  try {
    await app.ready;
    es = await sse(app.port);
    const snap = await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    const sessions = () => [...snap.data.events, ...es.frames.filter((fr) => fr.data && fr.data.type !== 'snapshot').map((fr) => fr.data)]
      .filter((e) => e.type === 'session');
    await until(() => sessions().length >= 2, 4000);
    // never a session event without the summary values: the first read happens before the announce
    const first = sessions().find((e) => e.sessionId === charOf(1));
    assert.deepEqual([first.title, first.project, first.projectLabel, first.branch], ['Sidecar main', '/work/side', 'side', 'feat/side']);
    assert.ok(sessions().filter((e) => e.sessionId === charOf(1)).every((e) => e.title === 'Sidecar main'));
    const sub = sessions().find((e) => e.sessionId === charOf(2));
    assert.deepEqual([sub.title, sub.project, sub.parentSessionId, sub.worktree, sub.agentType], ['Helper', '/work/side', charOf(1), 'w', 'explore']);
    assert.ok(!('agentType' in first), 'a main has no agentType');
    // a rewrite with the same values: no event; a new title: exactly one session event
    const before = es.frames.length;
    await fsp.writeFile(summaryPath, summaryJson({ id, cwd: '/work/side', title: 'Sidecar main', branch: 'feat/side', extra: { updated_at: 'later' } }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!es.frames.slice(before).some((fr) => fr.data?.type === 'session'), 'same values: nothing on the wire');
    await fsp.writeFile(summaryPath, summaryJson({ id, cwd: '/work/elsewhere', title: 'Renamed main', branch: 'feat/next' }));
    const renamed = await es.next((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1) && fr.data.title === 'Renamed main', 4000);
    // the floor stays on the first cwd (4.4); the branch follows
    assert.deepEqual([renamed.data.project, renamed.data.branch], ['/work/side', 'feat/next']);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1) && fr.data.title === 'Renamed main').length, 1);
    // a sub ended by its parent is not revived by a later summary rewrite
    await appendLines(main, [{ k: 'sub_end', childId: charOf(2) }]);
    await es.next((fr) => fr.data?.type === 'session_end' && fr.data.sessionId === charOf(2), 4000);
    await new Promise((r) => setTimeout(r, 5200)); // past the 5 s tail grace of the Store
    const mark = es.frames.length;
    await fsp.writeFile(path.join(path.dirname(child), 'summary.json'), summaryJson({ id: gid(2), cwd: '/work/side/.worktrees/w', title: 'Helper renamed' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!es.frames.slice(mark).some((fr) => fr.data?.sessionId === charOf(2)), 'the ended sub stays ended');
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.deepEqual(st.events.filter((e) => e.type === 'session').map((e) => e.sessionId), [charOf(1)]);
  } finally {
    es?.close();
    await app.close();
  }
});

test('server: a transcript truncated and re-attached gets its summary values again (fresh session object)', async () => {
  const root = await tmp('office-sim-sidecar-trunc-');
  const g = groupOf('/work/trunc');
  const id = gid(1);
  const lines = [{ k: 'turn_start', id: 'p1' }, { k: 'say', text: 'a long first line of invented text' }, { k: 'say', text: 'more invented text' }];
  const main = await writeSession(root, { group: g, id, summary: { cwd: '/work/trunc', title: 'Truncated main', branch: 'b1' }, items: lines });
  const app = await start({
    port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
    root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root }, adapters: { ...ADAPTERS, grok: grokTestAdapter() },
  });
  let es = null;
  try {
    await app.ready;
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.some((e) => e.sessionId === charOf(1)), 4000);
    const mark = es.frames.length;
    await fsp.writeFile(main, `${JSON.stringify({ k: 'turn_start', id: 'p2' })}\n`); // shorter: the Tailer resets, the Runner re-attaches
    await until(() => app.store.entry(main)?.state?.debugState?.().turnId === 'p2', 4000);
    await new Promise((r) => setTimeout(r, 200));
    const after = es.frames.slice(mark).filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1)).map((fr) => fr.data);
    assert.ok(after.every((e) => e.title === 'Truncated main' && e.project === '/work/trunc'), JSON.stringify(after.map((e) => e.title)));
    const st = JSON.parse((await request(app.port, { path: '/state' })).body).events.find((e) => e.type === 'session' && e.sessionId === charOf(1));
    assert.deepEqual([st.title, st.project, st.branch], ['Truncated main', '/work/trunc', 'b1']);
  } finally {
    es?.close();
    await app.close();
  }
});

test('server: a child folder attached as a main (its parent named it too late) never sends its task as a prompt or title (finding 4)', async () => {
  const { createGrokBuilder } = await import('./fixtures/grok.mjs');
  const { createGrokScanner } = await import('../src/adapters/grok/discover.mjs');
  const root = await tmp('office-sim-sidecar-task-');
  const child = gid(5);
  const c = createGrokBuilder({ sessionId: child, startMs: Date.now() - 5000 });
  // the real Grok session class; no parent names this folder, so with no grace it is a main for good
  const adapter = { ...grok, deps: (o = {}) => grok.deps({ scan: createGrokScanner({ linkGraceMs: 0 }), ...o }) };
  const file = await writeSession(root, { group: groupOf('/work/task/.worktrees/w'), id: child,
    summary: { cwd: '/work/task/.worktrees/w', extra: { session_kind: 'subagent', agent_name: 'explore' } },
    items: [c.hook({ event: 'session_start' }), c.hook(), c.userMessage({ text: 'Audit /Users/someone/clients/acme for TASK-BAIT', newTurn: false }),
      c.thought('Reading the code.')] });
  const app = await start({
    port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
    root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root }, adapters: { ...ADAPTERS, grok: adapter },
  });
  let es = null;
  try {
    await app.ready;
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.some((e) => e.sessionId === charOf(5)), 4000);
    await appendLines(file, [c.message('Found the handler.'), c.turnCompleted(), c.userMessage({ text: 'Follow-up TASK-BAIT two' }), c.hook(),
      c.thought('Checking again.')]);
    await es.next((fr) => fr.data?.type === 'thinking' && fr.data.text === 'Checking again.', 4000);
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    const ses = st.events.find((e) => e.type === 'session' && e.sessionId === charOf(5));
    assert.deepEqual([ses.isSubagent, ses.title], [false, child.slice(0, 8)], 'attached as a main, titled by its id');
    assert.equal(es.frames.filter((fr) => fr.data?.type === 'prompt').length, 0, 'no prompt event on the wire');
    assert.doesNotMatch(JSON.stringify([st, es.frames.map((fr) => fr.data)]), /TASK-BAIT|acme/);
  } finally {
    es?.close();
    await app.close();
  }
});
