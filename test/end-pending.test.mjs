// F4 pending end hints (contract 4.0.1): an agent-scoped end hint for a character that is not announced yet is kept
// (bounded, keyed by agent + charId, cleared when used); when that character is announced it starts ended and is never
// shown. A child that already finished in its parent's file therefore does not appear at server start. Hints for
// already-ended characters stay no-ops. Fake sessions, fake paths and temp roots only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, until } from './fixtures/sse.mjs';
import { fakeAdapter, line } from './fixtures/fake-adapter.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-pending-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function fake(id, { agent = 'grok', kind = 'sub' } = {}) {
  return {
    id, ended: false,
    sessionEvent() {
      return { type: 'session', sessionId: id, ts: 'x', agent, project: '/work/pending', projectLabel: 'pending', title: id,
        branch: null, worktree: null, isSubagent: kind !== 'main', parentSessionId: null };
    },
    snapshotEvents() { return [this.sessionEvent()]; },
  };
}
const MAIN = '/fake/p/main.jsonl';
const childRef = (id, p = `/fake/p/${id}.jsonl`) => ({ path: p, agent: 'grok', kind: 'sub', sid: 'grok-m', charId: id, parentId: 'grok-m' });
function setup(clock = { t: 1_000_000 }) {
  const store = new Store({ ringSize: 5000, now: () => clock.t });
  store.attachFile({ path: MAIN, agent: 'grok', sid: 'grok-m' }, fake('grok-m', { kind: 'main' }));
  store.announce(MAIN);
  return { store, clock };
}
const attachAndAnnounce = (store, id, p) => {
  const ref = childRef(id, p);
  store.attachFile(ref, fake(id));
  return store.announce(ref.path);
};
const eventsOf = (store, id) => store.ring.filter((x) => x.event.sessionId === id).map((x) => x.event);
const live = (store) => store.snapshot().events.filter((e) => e.type === 'session').map((e) => e.sessionId).sort();

test('a hint before the child is attached: the child starts ended, nothing is pushed for it, it never shows', () => {
  const { store } = setup();
  assert.equal(store.endCharacter('grok-c', 'done', 'grok'), false, 'nothing ended yet');
  assert.equal(attachAndAnnounce(store, 'grok-c'), 0, 'announce pushed nothing');
  assert.deepEqual(eventsOf(store, 'grok-c'), []);
  assert.deepEqual(live(store), ['grok-m']);
  assert.equal(store.entry('/fake/p/grok-c.jsonl').ended, true);
  assert.equal(store.endCharacter('grok-c', 'done', 'grok'), false, 'a hint for an already-ended character is a no-op');
  assert.deepEqual(eventsOf(store, 'grok-c'), []);
});

test('a hint while the child is attached but not announced yet (later in the same rescan) works the same', () => {
  const { store } = setup();
  store.attachFile(childRef('grok-c'), fake('grok-c'));
  assert.equal(store.endCharacter('grok-c', 'idle', 'grok'), false);
  assert.equal(store.announce('/fake/p/grok-c.jsonl'), 0);
  assert.deepEqual([eventsOf(store, 'grok-c'), live(store)], [[], ['grok-m']]);
});

test('a pending hint is used once: a later re-attach of the same character shows it', () => {
  const { store } = setup();
  store.endCharacter('grok-c', 'done', 'grok');
  attachAndAnnounce(store, 'grok-c');
  store.detachFile('/fake/p/grok-c.jsonl');
  assert.ok(attachAndAnnounce(store, 'grok-c') > 0, 'announced normally: the hint was cleared when used');
  assert.deepEqual(live(store), ['grok-c', 'grok-m']);
});

test('a hint for an already-ended character is not remembered for a later attach', () => {
  const { store } = setup();
  attachAndAnnounce(store, 'grok-c');
  assert.equal(store.endCharacter('grok-c', 'done', 'grok'), true);
  assert.equal(store.endCharacter('grok-c', 'done', 'grok'), false);
  store.detachFile('/fake/p/grok-c.jsonl');
  assert.ok(attachAndAnnounce(store, 'grok-c') > 0);
  assert.deepEqual(live(store), ['grok-c', 'grok-m']);
});

test('a character that was shown and is attached again ends with the hint reason when it is announced', () => {
  const { store } = setup();
  attachAndAnnounce(store, 'grok-c');
  store.attachFile(childRef('grok-c'), fake('grok-c')); // re-attach (reset): shown before, not announced yet
  store.endCharacter('grok-c', 'idle', 'grok');
  store.announce('/fake/p/grok-c.jsonl');
  const ends = eventsOf(store, 'grok-c').filter((e) => e.type === 'session_end');
  assert.deepEqual(ends.map((e) => e.reason), ['idle']);
  assert.deepEqual(live(store), ['grok-m']);
});

test('direct calls without an agent are not remembered (unscoped behaviour): the character still shows', () => {
  const { store } = setup();
  assert.equal(store.endCharacter('grok-c'), false);
  assert.ok(attachAndAnnounce(store, 'grok-c') > 0);
  assert.deepEqual(live(store), ['grok-c', 'grok-m']);
});

test('pending hints are keyed by agent + charId: a hint of one adapter does not end another adapter\'s character', () => {
  const { store } = setup();
  store.endCharacter('grok-x', 'done', 'grok');
  const claude = '/fake/claude/-p/grok-x.jsonl'; // a Claude main whose file stem happens to look like a grok id
  store.attachFile({ path: claude }, fake('grok-x', { agent: 'claude-code', kind: 'main' }));
  assert.ok(store.announce(claude) > 0);
  assert.ok(live(store).includes('grok-x'));
});

test('the pending map is bounded: at most 1000 hints, the oldest is dropped first', () => {
  const { store } = setup();
  for (let i = 0; i <= 1000; i++) store.endCharacter(`grok-p${i}`, 'done', 'grok');
  assert.ok(attachAndAnnounce(store, 'grok-p0') > 0, 'the oldest hint was dropped');
  assert.equal(attachAndAnnounce(store, 'grok-p1'), 0);
  assert.equal(attachAndAnnounce(store, 'grok-p1000'), 0);
  assert.deepEqual(live(store), ['grok-m', 'grok-p0']);
});

test('a hint with an id that does not fit its agent is not remembered', () => {
  const { store } = setup();
  for (const id of ['codex-c', 'grok c', `grok-${'x'.repeat(70)}`]) store.endCharacter(id, 'done', 'grok');
  // codex-c attached under its own agent: no grok hint applies to it
  store.attachFile({ path: '/fake/c/c.jsonl', agent: 'codex', sid: 'codex-c' }, fake('codex-c', { agent: 'codex', kind: 'main' }));
  assert.ok(store.announce('/fake/c/c.jsonl') > 0);
});

test('a child that started ended drops its tail lines for the grace period, then real new work shows it', () => {
  const { store, clock } = setup();
  store.endCharacter('grok-c', 'done', 'grok');
  attachAndAnnounce(store, 'grok-c');
  const tool = (id) => ({ type: 'tool_start', sessionId: 'grok-c', ts: 'x', toolUseId: id, tool: 't', summary: 's' });
  clock.t += 1000;
  assert.equal(store.ingest('/fake/p/grok-c.jsonl', [tool('tail')]), 0);
  clock.t += 6000;
  assert.ok(store.ingest('/fake/p/grok-c.jsonl', [tool('new')]) > 0);
  assert.deepEqual(live(store), ['grok-c', 'grok-m']);
});

// ---- server: a child that already finished in its parent's file -----------------------------------------------

async function layout({ childFirst = false } = {}) {
  const root = await tmp();
  const mainPath = path.join(root, 'main.jsonl');
  const childPath = path.join(root, 'child.jsonl');
  await fs.writeFile(mainPath, line({ k: 'meta', cwd: '/work/pending', title: 'Grok main' }) + line({ k: 'tool', id: 'g1', tool: 'spawn', summary: 'helper' })
    + line({ k: 'sub_end', child: 'grok-c1' }) + line({ k: 'done', id: 'g1' }));
  await fs.writeFile(childPath, line({ k: 'meta', cwd: '/work/pending', title: 'Finished helper' }) + line({ k: 'tool', id: 'g2', tool: 'search', summary: 'x' }));
  const main = { path: mainPath, kind: 'main', sid: 'grok-m1', charId: 'grok-m1' };
  const child = { path: childPath, kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' };
  return { root, mainPath, childPath, main, child, refs: childFirst ? [child, main] : [main, child] };
}

async function startWith(root, files) {
  return start({
    port: 0, root: path.join(root, 'no-claude'), roots: { grok: root },
    adapters: { ...ADAPTERS, grok: fakeAdapter({ id: 'grok', files, replayHints: true }) },
    publicDir: PUBLIC, intervalMs: 50, rescanMs: 40, idleMs: 50, activeMinutes: 30,
  });
}

async function assertNeverShown(app, childPath) {
  const st = JSON.parse((await request(app.port, { path: '/state' })).body);
  assert.deepEqual([...new Set(st.events.map((e) => e.sessionId))], ['grok-m1']);
  assert.deepEqual(app.store.ring.filter((x) => x.event.sessionId === 'grok-c1'), [], 'no event at all for the child');
  assert.equal(app.store.entry(childPath)?.ended, true, 'attached, but ended');
}

for (const childFirst of [false, true]) {
  test(`server start: a child whose end is already in its parent's file never appears (scan order ${childFirst ? 'child, main' : 'main, child'})`, async () => {
    const l = await layout({ childFirst });
    const app = await startWith(l.root, () => l.refs);
    try {
      await app.ready;
      await until(() => app.stats().files === 2, 3000);
      await sleep(150);
      await assertNeverShown(app, l.childPath);
    } finally {
      await app.close();
    }
  });
}

test('server: a child that shows up in a later rescan after its end was read never appears', async () => {
  const l = await layout();
  let withChild = false;
  const app = await startWith(l.root, () => (withChild ? [l.main, l.child] : [l.main]));
  try {
    await app.ready;
    // and one more end read live while the child is still unknown (the same hint again: still one pending entry)
    await fs.appendFile(l.mainPath, line({ k: 'sub_end', child: 'grok-c1' }) + line({ k: 'meta', title: 'marker' }));
    await until(() => app.store.ring.some((x) => x.event.type === 'session' && x.event.title === 'marker'), 3000);
    withChild = true;
    // files === 2 only means attached: the child is announced (and ended from the hint) after its readAll
    await until(() => app.store.entry(l.childPath)?.announced === true, 3000);
    await sleep(150);
    await assertNeverShown(app, l.childPath);
  } finally {
    await app.close();
  }
});
