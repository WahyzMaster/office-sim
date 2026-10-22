// GrokMeta (src/adapters/grok/meta.mjs, P5g): the Grok metadata watcher reads summary.json (SidecarWatcher) and each
// transcript's events.jsonl (EventsTail) and hands the approval facts to GrokSession through setInfo. Unit checks of the
// watcher, then the real server with the real grok descriptor over temp roots: a wait open at attach (snapshot, /state,
// restart), Last-Event-ID resume, auto-approved prompts, a short wait, and a sub ended by its parent. Invented content,
// temp roots and port 0 only; never a real ~/.grok.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { appendFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GrokMeta } from '../src/adapters/grok/meta.mjs';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { grok, grokSidecars } from '../src/adapters/grok/index.mjs';
import { createGrokScanner } from '../src/adapters/grok/discover.mjs';
import { SidecarWatcher } from '../src/core/sidecar.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { createGrokBuilder, createGrokEventsBuilder, out } from './fixtures/grok.mjs';
import { gid, charOf, groupOf, transcriptOf, writeSession, appendLines, eventsJsonl } from './fixtures/grok-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-grok-meta-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const CWD = '/work/meta';
const G = groupOf(CWD);
const callMs = (rec) => rec.params._meta.agentTimestampMs;
const eventsOf = (file) => path.join(path.dirname(file), 'events.jsonl');
const appendEvents = (file, lines) => fsp.appendFile(eventsOf(file), eventsJsonl(lines));
// the real grok descriptor (GrokSession, GrokMeta) with no link grace, so new folders are classified at once; `over`
// replaces deps parts (one test passes its own GrokMeta with a test clock)
const adapterWith = (over = {}) => ({ ...grok, deps: (o = {}) => grok.deps({ scan: createGrokScanner({ linkGraceMs: 0 }), ...over, ...o }) });
const adapter = adapterWith();
const OPTS = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const serve = (root, over = null) => start({ ...OPTS, root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root },
  adapters: { ...ADAPTERS, grok: over ? adapterWith(over) : adapter } });
const getState = async (port) => JSON.parse((await request(port, { path: '/state' })).body);
const frames = (es, pred = () => true) => es.frames.filter((fr) => fr.data && fr.data.type !== 'snapshot' && fr.data.type !== 'config' && pred(fr.data));
const waitsOf = (list, sid) => list.filter((e) => e.type === 'tool_wait' && e.sessionId === sid);
const brief = (list, sid) => list.filter((e) => e.sessionId === sid && e.type !== 'session').map((e) => [e.type, e.toolUseId, e.waiting]);

// one main with an open turn; `shell` adds an open run_terminal_command started `ago` ms before now
function mainRecords(id, { shell = false, ago = 5000 } = {}) {
  const g = createGrokBuilder({ sessionId: id, startMs: Date.now() - 60_000, stepMs: 10 });
  const items = [g.userMessage({ text: 'Run the checks' }), g.hook()];
  let call = null;
  if (shell) {
    call = g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' }, ms: Date.now() - ago });
    items.push(call);
  }
  return { g, items, call };
}
// the permission prompt of the e-th tool_started (2 ms after the call), its request 4 ms after the call
function promptLines(call, { name = 'run_terminal_command', turn = true } = {}) {
  const ev = createGrokEventsBuilder({ startMs: callMs(call) });
  const lines = [ev.started(name, { ms: callMs(call) + 2 }), ev.phase('permission_prompt'), ev.requested(name, { ms: callMs(call) + 4 })];
  return turn ? [ev.turnStarted({ ms: callMs(call) - 5 }), ...lines] : lines;
}

// ---- the watcher --------------------------------------------------------------------------------------------------

test('GrokMeta: summary fields plus approval facts; open requests on every read, a closing once; no events file: as before', async () => {
  const root = await tmp();
  const { items, call } = mainRecords(gid(1), { shell: true });
  const file = await writeSession(root, { group: G, id: gid(1), items, summary: { cwd: CWD, title: 'Meta main' } });
  const ref = { path: file, sessionId: gid(1) };
  let now = callMs(call) + 3000;
  const meta = new GrokMeta(grokSidecars, { events: { now: () => now } });
  assert.ok(meta instanceof SidecarWatcher);
  assert.deepEqual(await meta.check(ref), { title: 'Meta main', cwd: CWD }, 'no events.jsonl: only the summary');
  assert.equal(await meta.check(ref), null, 'nothing changed: null (the Runner skips setInfo)');
  await appendEvents(file, promptLines(call));
  const first = await meta.check(ref);
  assert.deepEqual(first, { approval: { reset: false, caughtUp: true, seenAt: now,
    facts: [{ e: 1, name: 'run_terminal_command', startMs: callMs(call) + 2, reqMs: callMs(call) + 4, state: 'open' }] } });
  now += 3000;
  assert.deepEqual((await meta.check(ref)).approval.facts.map((f) => f.state), ['open'], 'still open: reported again');
  const ev = createGrokEventsBuilder({ startMs: now });
  await appendEvents(file, [ev.resolved('run_terminal_command', { waitMs: 4000 })]);
  assert.deepEqual((await meta.check(ref)).approval.facts.map((f) => [f.e, f.state]), [[1, 'allow']]);
  assert.equal(await meta.check(ref), null, 'the closing is reported once');
  // forget(): the summary and events.jsonl are read again from the start (a resolved request is never reported; the
  // first caught-up read of the new tail is reported with no facts, P5g review)
  meta.forget(file);
  assert.deepEqual(await meta.check(ref), { title: 'Meta main', cwd: CWD, approval: { facts: [], seenAt: now, reset: false, caughtUp: true } });
  assert.equal(await meta.check(ref), null);
  assert.equal(meta.tails.size, 1);
  meta.forget(file);
  assert.equal(meta.tails.size, 0);
});

test('GrokMeta: only <dir>/updates.jsonl maps to an events file; one tail per transcript; forget mid-check gives no facts', async () => {
  const root = await tmp();
  const a = mainRecords(gid(1), { shell: true });
  const b = mainRecords(gid(2), { shell: true });
  const fa = await writeSession(root, { group: G, id: gid(1), items: a.items, events: promptLines(a.call) });
  const fb = await writeSession(root, { group: G, id: gid(2), items: b.items, events: promptLines(b.call) });
  const meta = new GrokMeta(() => []);
  const odd = path.join(path.dirname(fa), 'other.jsonl');
  assert.equal(await meta.check({ path: odd }), null, 'another basename: no events path at all');
  assert.equal(await meta.check({}), null);
  assert.equal(meta.tails.size, 0);
  assert.equal((await meta.check({ path: fa })).approval.facts.length, 1);
  assert.equal((await meta.check({ path: fb })).approval.facts.length, 1);
  assert.deepEqual([...meta.tails.keys()], [fa, fb]);
  // forget while a check is in flight: that check reports nothing, the next one starts over
  meta.forget(fa);
  const pending = meta.check({ path: fa });
  meta.forget(fa);
  assert.equal(await pending, null);
  assert.equal((await meta.check({ path: fa })).approval.reset, false);
  // a symlinked events.jsonl is never read
  const outside = await tmp('office-sim-grok-meta-out-');
  const secret = path.join(outside, 'events.jsonl');
  await fsp.writeFile(secret, eventsJsonl(promptLines(a.call)));
  const c = mainRecords(gid(3), { shell: true });
  const fc = await writeSession(root, { group: G, id: gid(3), items: c.items });
  await fsp.symlink(secret, eventsOf(fc));
  assert.equal(await meta.check({ path: fc }), null);
});

// P5g review: the Runner forgets the events tail on a same-inode move (carryOver) and EventsTail restarts on a replaced
// file. The first caught-up read of such a tail is reported even with no facts, so a wait shown before (whose allow the
// new tail never reports) is closed instead of staying on /state until tool_end.
test('GrokMeta: the first caught-up read of a new tail is reported without facts; a move or a replaced file closes a shown wait', async () => {
  const root = await tmp();
  let now = Date.now();
  const setup = async (n) => {
    const { items, call } = mainRecords(gid(n), { shell: true });
    const file = await writeSession(root, { group: G, id: gid(n), items, events: promptLines(call) });
    const s = new GrokSession({ id: charOf(n), now: () => now });
    for (const r of items) s.apply(r);
    return { file, s, id: call.params.update.toolCallId };
  };
  const meta = new GrokMeta(grokSidecars, { events: { now: () => now } });
  const sync = async (s, file) => {
    const info = await meta.check({ path: file });
    return info ? s.setInfo(info).map((e) => [e.type, e.toolUseId, e.waiting]) : null;
  };
  const allow = (file) => appendEvents(file, [createGrokEventsBuilder({ startMs: now }).resolved('run_terminal_command', { waitMs: 3000 })]);
  // a same-inode move: the allow is written, the folder moves, the Runner forgets the old path's tail
  const a = await setup(1);
  assert.deepEqual(await sync(a.s, a.file), [['tool_wait', a.id, true]]);
  await allow(a.file);
  const moved = transcriptOf(root, groupOf('/work/meta-moved'), gid(1));
  await fsp.mkdir(path.dirname(path.dirname(moved)), { recursive: true });
  await fsp.rename(path.dirname(a.file), path.dirname(moved));
  meta.forget(a.file);
  now += 3000;
  const info = await meta.check({ path: moved });
  assert.deepEqual(info, { approval: { facts: [], seenAt: now, reset: false, caughtUp: true } });
  assert.deepEqual(a.s.setInfo(info).map((e) => [e.type, e.toolUseId, e.waiting]), [['tool_wait', a.id, false]]);
  assert.deepEqual(a.s.debugState().waiting, []);
  assert.equal(await meta.check({ path: moved }), null, 'only the first caught-up read of that tail');
  // events.jsonl replaced by a copy that already holds the allow (new inode): reset, no facts, the wait closes
  const b = await setup(2);
  assert.deepEqual(await sync(b.s, b.file), [['tool_wait', b.id, true]]);
  const copy = path.join(path.dirname(b.file), 'events.copy');
  await fsp.copyFile(eventsOf(b.file), copy);
  await fsp.appendFile(copy, eventsJsonl([createGrokEventsBuilder({ startMs: now }).resolved('run_terminal_command', { waitMs: 3000 })]));
  await fsp.rename(copy, eventsOf(b.file));
  now += 3000;
  assert.deepEqual(await sync(b.s, b.file), [['tool_wait', b.id, false]]);
  assert.equal(await meta.check({ path: b.file }), null);
});

// ---- the real server ----------------------------------------------------------------------------------------------

test('server: a wait open 5 s at attach is in the first snapshot and /state right after its tool_start; again after a restart', async () => {
  const root = await tmp();
  const { items, call } = mainRecords(gid(1), { shell: true, ago: 5000 });
  await writeSession(root, { group: G, id: gid(1), items, summary: { cwd: CWD, title: 'Waiting main' }, events: promptLines(call) });
  const id = call.params.update.toolCallId;
  for (const round of ['first start', 'restart']) {
    const app = await serve(root);
    let es = null;
    try {
      await app.ready;
      await until(async () => (await getState(app.port)).events.some((e) => e.type === 'session' && e.sessionId === charOf(1)), 4000);
      const st = await getState(app.port);
      assert.deepEqual(brief(st.events, charOf(1)), [['tool_start', id, undefined], ['tool_wait', id, true]], `${round}: /state`);
      assert.equal(waitsOf(st.events, charOf(1))[0].ts, new Date(callMs(call) + 4).toISOString(), 'ts = the request ts');
      es = await sse(app.port);
      const snap = await es.next((fr) => fr.data?.type === 'snapshot', 4000);
      assert.deepEqual(brief(snap.data.events, charOf(1)), [['tool_start', id, undefined], ['tool_wait', id, true]], `${round}: snapshot`);
      assert.equal(JSON.stringify(waitsOf(snap.data.events, charOf(1))), JSON.stringify(waitsOf(st.events, charOf(1))));
      await sleep(200); // more rescans: the open request is reported again, nothing new on the wire
      assert.deepEqual(frames(es, (e) => e.type === 'tool_wait'), []);
      assert.ok(!JSON.stringify(st).includes('BAIT_EV_'), 'never-read events fields stay off the wire');
    } finally {
      es?.close();
      await app.close();
    }
  }
});

test('server: the allow written right before a same-inode move of the session folder still clears the wait (P5g review)', async () => {
  const root = await tmp();
  const { items, call } = mainRecords(gid(1), { shell: true, ago: 5000 });
  const file = await writeSession(root, { group: G, id: gid(1), items, summary: { cwd: CWD, title: 'Moving main' }, events: promptLines(call) });
  const id = call.params.update.toolCallId;
  const moved = transcriptOf(root, groupOf('/work/meta-moved'), gid(1));
  await fsp.mkdir(path.dirname(path.dirname(moved)), { recursive: true });
  const app = await serve(root);
  let es = null;
  try {
    await app.ready;
    await until(async () => waitsOf((await getState(app.port)).events, charOf(1)).length === 1, 4000);
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    const state = app.store.entry(file).state;
    // in one synchronous step, so no rescan reads the allow through the old path's tail
    appendFileSync(eventsOf(file), eventsJsonl([createGrokEventsBuilder({ startMs: Date.now() }).resolved('run_terminal_command', { waitMs: 5000 })]));
    renameSync(path.dirname(file), path.dirname(moved));
    const off = await es.next((fr) => fr.data?.type === 'tool_wait' && fr.data.toolUseId === id, 4000);
    assert.equal(off.data.waiting, false);
    assert.equal(app.store.entry(moved)?.state, state, 'carried over (same session object), not attached again');
    assert.deepEqual(brief((await getState(app.port)).events, charOf(1)), [['tool_start', id, undefined]], '/state: the tool, no wait');
  } finally {
    es?.close();
    await app.close();
  }
});

test('server: Last-Event-ID inside the ring gets only the missed tool_wait; no id or a too-old id gets the snapshot order', async () => {
  const root = await tmp();
  const { g, items } = mainRecords(gid(1));
  const file = await writeSession(root, { group: G, id: gid(1), items, summary: { cwd: CWD, title: 'Resume main' } });
  const app = await serve(root);
  const clients = [];
  try {
    await app.ready;
    await until(async () => (await getState(app.port)).events.some((e) => e.type === 'session' && e.sessionId === charOf(1)), 4000);
    const a = await sse(app.port);
    clients.push(a);
    await a.next((fr) => fr.data?.type === 'snapshot', 4000);
    const call = g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' }, ms: Date.now() - 2000 });
    const id = call.params.update.toolCallId;
    await appendLines(file, [call]);
    const started = await a.next((fr) => fr.data?.type === 'tool_start' && fr.data.toolUseId === id, 4000);
    await appendEvents(file, promptLines(call));
    const on = await a.next((fr) => fr.data?.type === 'tool_wait' && fr.data.toolUseId === id, 4000);
    assert.deepEqual([on.data.waiting, on.data.ts], [true, new Date(callMs(call) + 4).toISOString()]);
    a.close();
    const b = await sse(app.port, { 'last-event-id': started.id });
    clients.push(b);
    await b.next((fr) => fr.data?.type === 'config', 4000);
    const missed = b.frames.filter((fr) => fr.data && fr.data.type !== 'config');
    assert.deepEqual(missed.map((fr) => [fr.id, fr.data.type, fr.data.toolUseId]), [[on.id, 'tool_wait', id]]);
    for (const headers of [{ 'last-event-id': '1' }, {}]) {
      const c = await sse(app.port, headers);
      clients.push(c);
      const snap = await c.next((fr) => fr.data?.type === 'snapshot', 4000);
      assert.deepEqual(brief(snap.data.events, charOf(1)), [['tool_start', id, undefined], ['tool_wait', id, true]]);
    }
  } finally {
    for (const c of clients) c.close();
    await app.close();
  }
});

test('server: 100 auto-approved prompts appended live and a prompt resolved within 300 ms give no tool_wait', async () => {
  const root = await tmp();
  const { g, items } = mainRecords(gid(1));
  const file = await writeSession(root, { group: G, id: gid(1), items, summary: { cwd: CWD, title: 'Busy main' } });
  // the events clock of the server's GrokMeta (only seenAt reads it; a request shows once seenAt - reqMs >= 1 s): real
  // time, except while the 300 ms prompt below is open, so a stalled process cannot make that request 1 s old. `reads`
  // counts its calls (one per read that finds nothing new: EventsTail._read t0; two when bytes were appended)
  let frozen = null;
  let reads = 0;
  const app = await serve(root, { sidecarWatcher: new GrokMeta(grokSidecars, { events: { now: () => (reads++, frozen ?? Date.now()) } }) });
  let es = null;
  try {
    await app.ready;
    await until(async () => (await getState(app.port)).events.some((e) => e.type === 'session' && e.sessionId === charOf(1)), 4000);
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    await appendEvents(file, [createGrokEventsBuilder({ startMs: Date.now() }).turnStarted()]);
    for (let batch = 0; batch < 10; batch++) {
      const recs = [];
      const lines = [];
      for (let i = 0; i < 10; i++) {
        const t = Date.now();
        const call = g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' }, ms: t });
        recs.push(call, g.toolDone({ id: call.params.update.toolCallId, output: out.bash() }));
        const ev = createGrokEventsBuilder({ startMs: t + 1, stepMs: 0 });
        lines.push(...ev.prompt('run_terminal_command', { ms: t + 1, waitMs: 0 }));
      }
      await appendLines(file, recs);
      await appendEvents(file, lines);
      await sleep(30);
    }
    await until(() => frames(es, (e) => e.type === 'tool_end' && e.sessionId === charOf(1)).length === 100, 6000);
    // a prompt resolved 300 ms after its request: rescans see it open, but never 1 s old
    const call = g.toolCall({ name: 'run_terminal_command', input: { command: 'npm run lint' }, ms: Date.now() });
    const id = call.params.update.toolCallId;
    await appendLines(file, [call]);
    await es.next((fr) => fr.data?.type === 'tool_start' && fr.data.toolUseId === id, 4000);
    const approval = () => app.store.entry(file).state.debugState().grok.approval;
    // the clock stops at the request time before the request is written: every read that sees it open is at most 300 ms
    // after it, however long the test or the server stalls
    const reqMs = (frozen = Date.now());
    const ev = createGrokEventsBuilder({ startMs: reqMs });
    await appendEvents(file, [ev.started('run_terminal_command', { ms: callMs(call) + 2 }), ev.phase(), ev.requested('run_terminal_command', { ms: reqMs })]);
    await until(() => approval().pending.length === 1, 4000); // a rescan read it open and paired it, not due yet
    assert.deepEqual(approval().pending, [101], 'the 101st tool_started, paired with the 101st call');
    // 300 ms later, still open. Nothing is appended now, so each read takes the clock once; rescans run one at a time
    // (Runner.tick) and a read's setInfo ends its tick, so two more clock reads mean read r0 + 1 saw it open at
    // reqMs + 300 and the session kept it pending (a show threshold of 300 ms or less would have shown it)
    frozen = reqMs + 300;
    const r0 = reads;
    await until(() => reads >= r0 + 2, 4000);
    assert.deepEqual(approval().pending, [101], 'read open 300 ms after the request: not due yet');
    await appendEvents(file, [ev.resolved('run_terminal_command', { ms: reqMs + 300, waitMs: 300 }), ev.phase('tool_execution')]);
    frozen = null; // the allow is on disk: a read that starts now sees the request closed
    await sleep(1500);
    await appendLines(file, [g.toolDone({ id, output: out.bash() })]);
    await es.next((fr) => fr.data?.type === 'tool_end' && fr.data.toolUseId === id, 4000);
    assert.deepEqual(frames(es, (e) => e.type === 'tool_wait'), []);
    const ap = app.store.entry(file).state.debugState().grok.approval;
    assert.deepEqual([ap.count, ap.stats.shown, ap.shown, ap.held], [101, 0, [], []]);
  } finally {
    es?.close();
    await app.close();
  }
});

test('server: a sub ended by its parent\'s subagent_finished keeps its wait off the wire (Store-ended guard)', async () => {
  const root = await tmp();
  const m = createGrokBuilder({ sessionId: gid(1), startMs: Date.now() - 60_000, stepMs: 10 });
  const main = [m.userMessage({ text: 'Delegate it' }), m.hook(),
    m.toolCall({ name: 'spawn_subagent', input: { subagent_type: 'explore' } }), m.subagentSpawned({ child: gid(2) }), m.toolDone({ output: out.text() })];
  const b = createGrokBuilder({ sessionId: gid(2), startMs: Date.now() - 50_000, stepMs: 10 });
  b.newPrompt();
  const call = b.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' }, ms: Date.now() - 3000 });
  const sub = [b.hook(), b.userMessage({ text: 'Task from the parent', newTurn: false }), call];
  const mainFile = await writeSession(root, { group: G, id: gid(1), items: main, children: [gid(2)], summary: { cwd: CWD, title: 'Parent' } });
  const subFile = await writeSession(root, { group: G, id: gid(2), items: sub });
  const app = await serve(root);
  let es = null;
  try {
    await app.ready;
    await until(async () => (await getState(app.port)).events.filter((e) => e.type === 'session').length === 2, 4000);
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    await appendLines(mainFile, [m.subagentFinished({ child: gid(2) })]);
    await es.next((fr) => fr.data?.type === 'session_end' && fr.data.sessionId === charOf(2), 4000);
    // past the Store's own 5 s grace for lines read right after the end (store.mjs DONE_GRACE_MS): only the Runner guard
    // (server-runner.mjs syncSidecars) keeps the wait off the wire now
    app.store.entry(subFile).doneAt -= 6000;
    await appendEvents(subFile, promptLines(call));
    const state = () => app.store.entry(subFile)?.state.debugState();
    await until(() => state()?.waiting.length === 1, 4000); // the session made the wait ...
    await sleep(200);
    assert.deepEqual(frames(es, (e) => e.sessionId === charOf(2) && e.type !== 'session_end'), [], '... the wire never gets it');
    assert.ok(!(await getState(app.port)).events.some((e) => e.sessionId === charOf(2)), 'the ended sub stays off /state');
  } finally {
    es?.close();
    await app.close();
  }
});
