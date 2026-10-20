// F2 D2 id guard at the Store boundary (contract 4.0.1): a non-Claude ref attaches only when its charId (and its
// parentId, when present) fits the id rule [A-Za-z0-9][A-Za-z0-9_-]{0,63} and starts with '<agent>-'. A rejected ref
// is not attached, is logged once per path without the path, and is counted in stats().rejectedRefs. Claude refs are
// untouched. Fake sessions, fake paths and temp roots only.
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
import { FakeAgentSession, fakeAdapter, line } from './fixtures/fake-adapter.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '9e9e9e9e-1111-4222-8333-444455556666';
const A1 = 'a0000000000009e01';
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-guard-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const state = (id, kind = 'main') => new FakeAgentSession({ id, kind, agent: 'grok' });
const LONG = `grok-${'x'.repeat(60)}`; // 65 characters: over the 64 cap

test('Store.attachFile: non-Claude ids must fit the id rule and the <agent>- prefix (charId, and parentId when present)', () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  const ok = [
    { path: '/fake/grok/ok-main.jsonl', agent: 'grok', sid: 'grok-m1' },
    { path: '/fake/grok/ok-sub.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' },
    { path: '/fake/grok/ok-orphan.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c2', parentId: null },
    { path: '/fake/codex/ok.jsonl', agent: 'codex', sid: 'codex-019a_b-2' },
  ];
  const bad = [
    { path: '/fake/grok/no-prefix.jsonl', agent: 'grok', sid: 'm1' },
    { path: '/fake/grok/other-prefix.jsonl', agent: 'grok', sid: 'codex-m1' },
    { path: '/fake/grok/colon.jsonl', agent: 'grok', sid: 'grok:m1' },
    { path: '/fake/grok/space.jsonl', agent: 'grok', sid: 'grok-m1', charId: 'grok c1' },
    { path: '/fake/grok/slash.jsonl', agent: 'grok', sid: 'grok-m1', charId: 'grok-../c1' },
    { path: '/fake/grok/long.jsonl', agent: 'grok', sid: 'grok-m1', charId: LONG },
    { path: '/fake/grok/no-id.jsonl', agent: 'grok' },
    { path: '/fake/grok/bad-parent.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c3', parentId: 'm1' },
    { path: '/fake/grok/foreign-parent.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c4', parentId: 'codex-m1' },
    { path: '/fake/grok/empty-parent.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c5', parentId: '' },
  ];
  for (const ref of ok) {
    const id = ref.charId ?? ref.sid;
    assert.ok(store.attachFile(ref, state(id, ref.kind)), `accepted ${ref.path}`);
    assert.equal(store.entry(ref.path)?.charId, id);
  }
  for (const ref of bad) {
    assert.equal(store.attachFile(ref, state(ref.charId ?? ref.sid ?? 'x', ref.kind)), null, `rejected ${ref.path}`);
    assert.equal(store.entry(ref.path), null);
  }
  assert.equal(store.fileCount, ok.length);
  assert.equal(logs.length, bad.length, 'one log line per rejected path');
  assert.ok(logs.every((l) => l === 'grok: rejected ref with invalid id'), 'no path, no id in the log line');
  assert.deepEqual(store.stats(), { rejectedRefs: bad.length });
  // the same paths again: no new log line, the counter counts paths, not attempts
  for (const ref of bad) store.attachFile(ref, state('x'));
  assert.equal(logs.length, bad.length);
  assert.equal(store.stats().rejectedRefs, bad.length);
});

test('Store guard: Claude refs keep their own ids (no prefix needed), with or without an explicit agent', () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  const main = `/fake/claude/-p/${SID}.jsonl`;
  const sub = `/fake/claude/-p/${SID}/subagents/agent-${A1}.jsonl`;
  assert.ok(store.attachFile({ path: main }, state(SID)));
  assert.ok(store.attachFile({ path: sub, agent: 'claude-code', kind: 'sub' }, state(A1, 'sub')));
  assert.deepEqual([store.entry(main).charId, store.entry(sub).charId], [SID, A1]);
  assert.deepEqual([logs, store.stats()], [[], { rejectedRefs: 0 }]);
});

test('Store.rekey refuses a move onto a ref whose parentId breaks the rule', () => {
  const store = new Store();
  const from = '/fake/grok/a.jsonl';
  store.attachFile({ path: from, agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' }, state('grok-c1', 'sub'));
  assert.equal(store.rekey(from, { path: '/fake/grok/b.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'x y' }), false);
  assert.ok(store.entry(from));
  assert.equal(store.rekey(from, { path: '/fake/grok/c.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' }), true);
});

test('server: refs with invalid ids are never attached or read; one log line per path; stats().rejectedRefs', async () => {
  const root = await tmp();
  const p = (name) => path.join(root, name);
  const body = line({ k: 'meta', cwd: '/work/guard', title: 'T' }) + line({ k: 'tool', id: 't1', tool: 'read_file', summary: 'a.txt' });
  for (const name of ['main', 'sub', 'bad1', 'bad2', 'bad3']) await fs.writeFile(p(`${name}.jsonl`), body);
  const files = () => [
    { path: p('main.jsonl'), kind: 'main', sid: 'grok-m1', charId: 'grok-m1' },
    { path: p('sub.jsonl'), kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' },
    { path: p('bad1.jsonl'), kind: 'main', sid: 'm2', charId: 'm2' },
    { path: p('bad2.jsonl'), kind: 'sub', sid: 'grok-m1', charId: 'grok-c2', parentId: `../${root}` },
    { path: p('bad3.jsonl'), kind: 'sub', sid: 'grok-m1', charId: `${SID}`, parentId: 'grok-m1' },
  ];
  let made = 0;
  const adapter = fakeAdapter({ id: 'grok', files });
  const counting = { ...adapter, async deps() {
    const deps = await adapter.deps();
    return { ...deps, SessionState: class extends deps.SessionState { constructor(o) { super(o); made += 1; } } };
  } };
  const logs = [];
  const app = await start({
    port: 0, root: path.join(root, 'no-claude'), roots: { grok: root }, adapters: { ...ADAPTERS, grok: counting },
    publicDir: PUBLIC, intervalMs: 50, rescanMs: 40, idleMs: 50, activeMinutes: 30, log: (m) => logs.push(m),
  });
  try {
    await app.ready;
    await sleep(200); // several rescans
    await until(() => app.stats().files === 2, 3000);
    const rejected = logs.filter((l) => l.includes('rejected'));
    assert.deepEqual(rejected, Array(3).fill('grok: rejected ref with invalid id'));
    assert.ok(logs.every((l) => !l.includes(root)), 'no path in any log line');
    assert.equal(app.stats().rejectedRefs, 3);
    assert.equal(made, 2, 'no session object is built for a rejected ref, on any rescan');
    for (const name of ['bad1', 'bad2', 'bad3']) assert.equal(app.store.entry(p(`${name}.jsonl`)), null);
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.deepEqual([...new Set(st.events.map((e) => e.sessionId))].sort(), ['grok-c1', 'grok-m1']);
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.deepEqual([health.files, health.sessions], [2, 2]);
  } finally {
    await app.close();
  }
});
