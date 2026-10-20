// F3 agent-scoped end hints (contract 4.0.1): the Runner forwards each { hint: 'end', charId } with its adapter id,
// and Store.endCharacter(charId, reason, agent) only ends a character whose entry agent is that id. A mismatch is a
// no-op; a direct call without an agent keeps the unscoped behaviour. Fake sessions, fake paths and temp roots only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, until } from './fixtures/sse.mjs';
import { fakeAdapter, line } from './fixtures/fake-adapter.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '3f3f3f3f-1111-4222-8333-444455556666';
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function fake(id, agent, kind = 'main') {
  return {
    id, ended: false, out: [],
    apply() { return this.out.splice(0); },
    idle() { return []; },
    sessionEvent() {
      return { type: 'session', sessionId: id, ts: 'x', agent, project: '/work/scope', projectLabel: 'scope', title: id,
        branch: null, worktree: null, isSubagent: kind !== 'main', parentSessionId: null };
    },
    snapshotEvents() { return [this.sessionEvent()]; },
  };
}

// grok main + grok child, a codex main, a Claude main: all announced and live
function setup() {
  const store = new Store({ ringSize: 200, now: () => 1_000_000 });
  const add = (p, ref, st) => { store.attachFile({ path: p, ...ref }, st); store.announce(p); return st; };
  const grokMain = add('/fake/g/main.jsonl', { agent: 'grok', sid: 'grok-m' }, fake('grok-m', 'grok'));
  add('/fake/g/child.jsonl', { agent: 'grok', kind: 'sub', sid: 'grok-m', charId: 'grok-c', parentId: 'grok-m' }, fake('grok-c', 'grok', 'sub'));
  add('/fake/c/main.jsonl', { agent: 'codex', sid: 'codex-z' }, fake('codex-z', 'codex'));
  add(`/fake/claude/-p/${SID}.jsonl`, {}, fake(SID, 'claude-code'));
  return { store, grokMain };
}
const ended = (store, id) => store.ring.filter((x) => x.event.type === 'session_end' && x.event.sessionId === id).length;
const live = (store) => store.snapshot().events.filter((e) => e.type === 'session').map((e) => e.sessionId).sort();

test('Store.endCharacter with an agent ends only a character of that agent; a mismatch is a no-op', () => {
  const { store } = setup();
  const seq = store.seq;
  assert.equal(store.endCharacter('codex-z', 'done', 'grok'), false);
  assert.equal(store.endCharacter(SID, 'done', 'grok'), false);
  assert.equal(store.endCharacter('grok-c', 'idle', 'codex'), false);
  assert.equal(store.endCharacter('grok-c', 'done', 'claude-code'), false);
  assert.equal(store.seq, seq, 'nothing was pushed');
  assert.deepEqual(live(store), [SID, 'codex-z', 'grok-c', 'grok-m'].sort());
  assert.equal(store.endCharacter('grok-c', 'idle', 'grok'), true);
  assert.equal(store.endCharacter(SID, 'done', 'claude-code'), true);
  assert.deepEqual([ended(store, 'grok-c'), ended(store, SID), ended(store, 'codex-z')], [1, 1, 0]);
});

test('Store.endCharacter without an agent keeps the unscoped behaviour (null and undefined alike)', () => {
  const { store } = setup();
  assert.equal(store.endCharacter('codex-z'), true);
  assert.equal(store.endCharacter('grok-c', 'done', null), true);
  assert.equal(store.endCharacter(SID, undefined, undefined), true);
  assert.deepEqual(live(store), ['grok-m']);
});

test('Runner forwards hints with its adapter id: a grok file cannot end a codex or Claude character', () => {
  const { store, grokMain } = setup();
  class NullTailer { forget() {} }
  const runner = (agent) => new Runner({ opts: { intervalMs: 50 }, deps: { agent, Tailer: NullTailer, scan: async () => [] }, store, log: () => {} });
  const g = runner('grok');
  const f = { ref: { path: '/fake/g/main.jsonl' }, state: grokMain, charId: 'grok-m', kind: 'main', ready: true };
  grokMain.out = [{ hint: 'end', charId: 'codex-z' }, { hint: 'end', charId: SID }];
  g.onLine(f, '{"k":"x"}', false);
  grokMain.out = [{ hint: 'end', charId: 'codex-z' }]; // replayed lines forward hints too, scoped the same way
  g.onLine(f, '{"k":"x"}', true);
  assert.deepEqual([ended(store, 'codex-z'), ended(store, SID)], [0, 0]);
  grokMain.out = [{ hint: 'end', charId: 'grok-c' }];
  g.onLine(f, '{"k":"x"}', false);
  assert.equal(ended(store, 'grok-c'), 1);
  // a Runner without deps.agent forwards unscoped hints (the behaviour before F3)
  const bare = runner(undefined);
  grokMain.out = [{ hint: 'end', charId: 'codex-z' }];
  bare.onLine(f, '{"k":"x"}', false);
  assert.equal(ended(store, 'codex-z'), 1);
});

test('server: an end hint in a grok file for a live Claude session id leaves the Claude session alone', async () => {
  const claudeRoot = await tmp('office-sim-scope-claude-');
  const dir = path.join(claudeRoot, '-work-scope');
  await fs.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: SID, cwd: '/work/scope', startMs: Date.now() - 5000, stepMs: 10 });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), toJsonl([mb.humanPrompt({ text: 'Scoped ends' }), mb.assistantText({ msgId: 'msg_1', text: 'Sure.' })]));
  const grokRoot = await tmp('office-sim-scope-grok-');
  const mainPath = path.join(grokRoot, 'main.jsonl');
  await fs.writeFile(mainPath, line({ k: 'meta', cwd: '/work/scope', title: 'Grok main' }));
  const files = () => [{ path: mainPath, kind: 'main', sid: 'grok-m1', charId: 'grok-m1' }];
  const app = await start({
    port: 0, root: claudeRoot, roots: { grok: grokRoot }, adapters: { ...ADAPTERS, grok: fakeAdapter({ id: 'grok', files }) },
    publicDir: PUBLIC, intervalMs: 50, rescanMs: 100, idleMs: 50, activeMinutes: 30,
  });
  try {
    await app.ready;
    assert.deepEqual(app.agents, ['claude-code', 'grok']);
    await fs.appendFile(mainPath, line({ k: 'sub_end', child: SID }) + line({ k: 'meta', title: 'marker' }));
    await until(() => app.store.ring.some((x) => x.event.type === 'session' && x.event.title === 'marker'), 3000);
    assert.equal(ended(app.store, SID), 0, 'no session_end for the Claude session');
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.ok(st.events.some((e) => e.type === 'session' && e.sessionId === SID && e.agent === 'claude-code'));
  } finally {
    await app.close();
  }
});
