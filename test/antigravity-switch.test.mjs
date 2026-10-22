// P5e review finding 6: after a character moves to another file (Antigravity's transcript_full.jsonl / transcript.jsonl
// switch: a new inode, re-attached and replayed from byte 0), the open page must hold exactly the server's open tools.
// Antigravity tool ids carry the line's byte position, which differs between the two files, so the Store closes every
// tool that was open under the old file and is not open under the new one (tool_end abandoned, the core's shape); for
// adapters with stable ids the same ids come back and nothing is sent. A Store unit test with fake sessions, then the
// real adapter on a real server. Invented content and temp roots only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { createAntigravityBuilder, call, linePositions, toJsonl, toolId } from './fixtures/antigravity.mjs';
import { aid, charOf, writeConversation, fullOf, plainOf } from './fixtures/antigravity-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-agy-switch-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------------------------- Store unit

const CH = charOf(1);
const ref = (p) => ({ path: p, agent: 'antigravity', kind: 'main', sid: CH, charId: CH, stem: CH, sessionId: aid(1) });
function fakeState(open, { ended = false } = {}) {
  return {
    ended,
    sessionEvent() {
      return { type: 'session', sessionId: CH, ts: 't', agent: 'antigravity', project: '/work/sw', projectLabel: 'sw', title: 'sw',
        branch: null, worktree: null, isSubagent: false, parentSessionId: null };
    },
    snapshotEvents() {
      return ended ? [] : [this.sessionEvent(), ...open.map((id) => ({ type: 'tool_start', sessionId: CH, toolUseId: id, ts: 't', tool: 'x', summary: 'x' }))];
    },
  };
}
function moveScenario({ oldOpen, newOpen, newEnded = false, moved = true }) {
  const store = new Store({ now: () => Date.UTC(2026, 9, 20, 12) });
  store.attachFile(ref('/fake/a/transcript.jsonl'), fakeState(oldOpen));
  store.announce('/fake/a/transcript.jsonl');
  const before = store.seq;
  store.detachFile('/fake/a/transcript.jsonl', { moved });
  store.attachFile(ref('/fake/a/transcript_full.jsonl'), fakeState(newOpen, { ended: newEnded }));
  store.announce('/fake/a/transcript_full.jsonl');
  return { store, after: store.since(before).map((it) => it.event) };
}
const ends = (evs) => evs.filter((e) => e.type === 'tool_end').map(({ ts, ...e }) => e);

test('finding 6 (Store): a moved character re-announced with other tool ids gets abandoned ends for the old ones', () => {
  const { after: evs, store } = moveScenario({ oldOpen: ['c:10:0', 'c:10:1'], newOpen: ['c:12:0', 'c:12:1'] });
  assert.deepEqual(ends(evs), ['c:10:0', 'c:10:1'].map((id) => ({
    type: 'tool_end', sessionId: CH, toolUseId: id, ok: false, errorKind: 'abandoned', error: 'no result',
  })));
  assert.deepEqual(evs.filter((e) => e.type === 'tool_start').map((e) => e.toolUseId), ['c:12:0', 'c:12:1'], 'the new snapshot');
  assert.equal(store.movedOpen.size, 0, 'the stash is used once');
});

test('finding 6 (Store): stable ids (Claude, Codex, Grok) come back unchanged: no tool_end at all', () => {
  assert.deepEqual(ends(moveScenario({ oldOpen: ['call_1', 'call_2'], newOpen: ['call_1', 'call_2'] }).after), []);
  assert.deepEqual(ends(moveScenario({ oldOpen: [], newOpen: ['call_3'] }).after), []);
});

test('finding 6 (Store): an ended character only gets session_end; a detach that is not a move keeps nothing', () => {
  const ended = moveScenario({ oldOpen: ['c:1:0'], newOpen: [], newEnded: true });
  assert.deepEqual(ended.after.map((e) => e.type), ['session_end']);
  assert.equal(ended.store.movedOpen.size, 0);
  const notMoved = moveScenario({ oldOpen: ['c:1:0'], newOpen: ['c:2:0'], moved: false });
  assert.deepEqual(ends(notMoved.after), [], 'a plain detach ended the character (idle); nothing to close later');
  assert.equal(notMoved.store.movedOpen.size, 0);
});

test('finding 6 (Store): the stash is bounded', () => {
  const store = new Store();
  for (let i = 0; i < 1100; i++) {
    const id = `antigravity-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const r = { path: `/fake/m/${i}.jsonl`, agent: 'antigravity', kind: 'main', sid: id, charId: id, stem: id };
    const st = { ended: false, sessionEvent: () => ({ type: 'session', sessionId: id }), snapshotEvents: () => [{ type: 'tool_start', sessionId: id, toolUseId: `${i}:0:0` }] };
    store.attachFile(r, st);
    store.announce(r.path);
    store.detachFile(r.path, { moved: true });
  }
  assert.ok(store.movedOpen.size <= 1000, String(store.movedOpen.size));
});

// ---------------------------------------------------------------------------------------------- real server

const T = Date.now() - 60_000;
// the same conversation in both files: a finished call (its JSON-encoded arguments make the later lines sit elsewhere in
// transcript.jsonl), then two calls still waiting (a command and a question)
function conversation(format) {
  const b = createAntigravityBuilder({ format, start: T });
  return [b.userInput('Run the tests'), b.planner({ calls: [call.listDir()] }), b.result(),
    b.planner({ content: 'Running them.', calls: [call.runCommand('npm test'), call.askQuestion()] })];
}

test('finding 6 on a real server: open tools and the ask move to the new file ids; the page ends up with exactly the server set', async () => {
  const root = await tmp();
  const plain = conversation('truncated');
  const full = conversation('full');
  const oldPos = linePositions(plain)[3];
  const newPos = linePositions(full)[3];
  assert.notEqual(oldPos, newPos, 'transcript.jsonl args are JSON-encoded: the planner line sits elsewhere');
  const conv = aid(1);
  await writeConversation(root, { id: conv, full: null, plain: plain.map((s) => JSON.stringify(s)) });
  const app = await start({ ...FAST, root: path.join(root, 'no-claude'), agents: ['antigravity'], roots: { antigravity: root }, adapters: ADAPTERS });
  // SSE 연결이 실패해도 서버는 닫는다 (try 밖에서 던지면 열린 서버가 파일 프로세스를 붙잡아 끝나지 않는다)
  let client = null;
  try {
    client = await sse(app.port);
    await app.ready;
    const oldIds = [0, 1].map((i) => toolId(oldPos, i, conv));
    const newIds = [0, 1].map((i) => toolId(newPos, i, conv));
    await until(async () => JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'tool_start').length === 2, 4000);
    assert.deepEqual(JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'tool_start').map((e) => e.toolUseId), oldIds);
    // the full file appears with the same steps: the conversation moves to it
    await fsp.writeFile(fullOf(root, conv), toJsonl(full));
    await client.next((fr) => fr.data?.type === 'tool_end' && fr.data.toolUseId === oldIds[1], 4000);
    const st = JSON.parse((await request(app.port, { path: '/state' })).body).events;
    assert.deepEqual(st.filter((e) => e.type === 'tool_start').map((e) => e.toolUseId), newIds);
    assert.deepEqual(st.find((e) => e.toolUseId === newIds[1]).question, 'Which database should the session store use?');
    // the page: replay every frame it got (state at connect + live) and compare its open tools with the server's
    const open = new Set();
    for (const ev of client.frames.map((fr) => fr.data).filter(Boolean)) {
      if (ev.type === 'tool_start') open.add(ev.toolUseId);
      if (ev.type === 'tool_end') open.delete(ev.toolUseId);
      if (ev.type === 'session_end') open.clear();
    }
    assert.deepEqual([...open].sort(), [...newIds].sort(), 'no duplicate, no stuck tool or ask');
    const oldEnds = client.frames.map((fr) => fr.data).filter((e) => e?.type === 'tool_end' && oldIds.includes(e.toolUseId));
    assert.deepEqual(oldEnds.map((e) => [e.toolUseId, e.errorKind]), oldIds.map((id) => [id, 'abandoned']));
    assert.ok(!client.frames.some((fr) => fr.data?.type === 'session_end'), 'a move is not an end');
    // the new file goes on: its result line ends the new id
    await fsp.appendFile(fullOf(root, conv), toJsonl([createAntigravityBuilder({ format: 'full', start: T + 10_000 }).runResult({ exitCode: 0 })]));
    const end = await client.next((fr) => fr.data?.type === 'tool_end' && fr.data.toolUseId === newIds[0], 4000);
    assert.equal(end.data.ok, true);
    assert.equal(plainOf(root, conv).endsWith('transcript.jsonl'), true);
  } finally {
    client?.close();
    await app.close();
  }
});
