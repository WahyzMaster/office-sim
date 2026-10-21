// F1 late root activation (contract 4.0.1, 6): a selected adapter whose root is missing or unreadable at start is
// re-probed on every rescan (same probe, same time limit) and switched on once the root can be opened. One log line
// without the path, and /healthz agents and app.agents include it from then on. Temp roots and synthetic transcripts
// only; the real ~/.claude is never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, until } from './fixtures/sse.mjs';
import { fakeAdapter, line } from './fixtures/fake-adapter.mjs';
import { assertHealthShape, oldHealth } from './fixtures/healthz.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '1a7e1a7e-1111-4222-8333-444455556666';
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 40, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-late-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const health = async (app) => JSON.parse((await request(app.port, { path: '/healthz' })).body);
const stateEvents = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events;

// A Claude root with one live main transcript, built aside and moved into place in one rename.
async function claudeRootAt(root) {
  const staging = `${root}.staging`;
  const dir = path.join(staging, '-work-late');
  await fs.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: SID, cwd: '/work/late', startMs: Date.now() - 5000, stepMs: 10 });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), toJsonl([mb.humanPrompt({ text: 'Late root demo' }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  await fs.rename(staging, root);
}

test('a Claude root created after start switches claude-code on: one log line, /healthz, app.agents and /state', async () => {
  const parent = await tmp();
  const root = path.join(parent, 'projects');
  const logs = [];
  const app = await start({ ...FAST, root, agents: ['claude-code'], log: (m) => logs.push(m) });
  try {
    await app.ready;
    assert.deepEqual(app.agents, []);
    assert.deepEqual((await health(app)).agents, []);
    await sleep(150); // several rescans with the root still missing: no new log line, still off
    assert.deepEqual(logs, ['claude-code: root not found, adapter off']);
    await claudeRootAt(root);
    await until(() => app.agents.includes('claude-code'), 3000);
    await until(async () => (await health(app)).files === 1, 3000);
    assert.deepEqual(app.agents, ['claude-code']);
    const h = await health(app);
    assert.deepEqual(oldHealth(h), { ok: true, files: 1, sessions: 1, clients: 0, agents: ['claude-code'] });
    assertHealthShape(h); // runners now has the late adapter too
    const session = (await stateEvents(app)).find((e) => e.type === 'session' && e.sessionId === SID);
    assert.equal(session?.agent, 'claude-code');
    await sleep(120);
    assert.deepEqual(logs, ['claude-code: root not found, adapter off', 'claude-code: root found, adapter on']);
    assert.ok(logs.every((l) => !l.includes(parent)), 'no path in the log lines');
  } finally {
    await app.close();
  }
});

test('an unreadable root (a file) stays off across rescans and comes on once it is a directory', async () => {
  const parent = await tmp();
  const root = path.join(parent, 'projects');
  await fs.writeFile(root, 'not a directory');
  const logs = [];
  const app = await start({ ...FAST, root, log: (m) => logs.push(m) });
  try {
    await app.ready;
    await sleep(150);
    assert.deepEqual(app.agents, []);
    assert.deepEqual(logs, ['claude-code: root not readable (ENOTDIR), adapter off']);
    await fs.rm(root);
    await claudeRootAt(root);
    await until(() => app.agents.length === 1, 3000);
    await until(async () => (await stateEvents(app)).some((e) => e.sessionId === SID), 3000);
    assert.deepEqual(logs, ['claude-code: root not readable (ENOTDIR), adapter off', 'claude-code: root found, adapter on']);
  } finally {
    await app.close();
  }
});

test('an adapter left out by --agents is never re-probed or switched on', async () => {
  const parent = await tmp();
  const root = path.join(parent, 'projects');
  const logs = [];
  const probed = [];
  const probe = (r, id) => { probed.push(id); return fs.opendir(r).then((d) => d.close()).then(() => null, (e) => e.code); };
  const app = await start({ ...FAST, root, agents: ['antigravity'], probe, log: (m) => logs.push(m) });
  try {
    await app.ready;
    await claudeRootAt(root);
    await sleep(200);
    // antigravity is implemented since P5e and has no root here: skipped, not reported (only it was selected)
    assert.deepEqual([app.agents, app.notImplemented], [[], []]);
    assert.deepEqual((await health(app)).agents, []);
    assert.deepEqual(probed, [], 'claude-code was not selected, so its root is not checked at all');
    assert.deepEqual(logs, []);
  } finally {
    await app.close();
  }
});

test('a late adapter joins in KNOWN_AGENTS order next to a running one, and its characters flow', async () => {
  const parent = await tmp();
  const root = path.join(parent, 'projects');
  const grokRoot = await tmp('office-sim-late-grok-');
  const mainPath = path.join(grokRoot, 'main.jsonl');
  await fs.writeFile(mainPath, line({ k: 'meta', cwd: '/work/late-grok', title: 'Grok main' }));
  const files = () => [{ path: mainPath, kind: 'main', sid: 'grok-m1', charId: 'grok-m1' }];
  const logs = [];
  const app = await start({
    ...FAST, root, roots: { grok: grokRoot }, adapters: { ...ADAPTERS, grok: fakeAdapter({ id: 'grok', files }) },
    log: (m) => logs.push(m),
  });
  try {
    await app.ready;
    assert.deepEqual(app.agents, ['grok']);
    await claudeRootAt(root);
    await until(() => app.agents.length === 2, 3000);
    assert.deepEqual(app.agents, ['claude-code', 'grok']);
    assert.deepEqual((await health(app)).agents, ['claude-code', 'grok']);
    await until(async () => {
      const ids = (await stateEvents(app)).filter((e) => e.type === 'session').map((e) => `${e.sessionId}:${e.agent}`);
      return ids.includes(`${SID}:claude-code`) && ids.includes('grok-m1:grok');
    }, 3000);
    assert.deepEqual(logs, ['claude-code: root not found, adapter off', 'claude-code: root found, adapter on']);
  } finally {
    await app.close();
  }
});

test('a stalled re-probe times out, is not stacked while it hangs, and a later answer still switches the adapter on', async () => {
  const root = await tmp();
  const logs = [];
  let calls = 0;
  let release = null;
  const probe = () => {
    calls += 1;
    if (calls === 1) return 'ENOENT'; // at start
    if (calls === 2) return new Promise((resolve) => { release = resolve; }); // a stalled mount
    return null; // readable now
  };
  const app = await start({ ...FAST, root, probe, probeTimeoutMs: 30, log: (m) => logs.push(m) });
  try {
    await app.ready;
    await until(() => release !== null, 3000);
    await sleep(250); // many rescans while the second check still hangs
    assert.equal(calls, 2, 'no new check is started while the previous one has not answered');
    assert.deepEqual(app.agents, []);
    release('ENOENT');
    await until(() => app.agents.length === 1, 3000);
    assert.equal(calls, 3);
    assert.deepEqual(logs, ['claude-code: root not found, adapter off', 'claude-code: root found, adapter on']);
  } finally {
    await app.close();
  }
});

test('closing the server stops the re-probe loop', async () => {
  const parent = await tmp();
  const root = path.join(parent, 'projects');
  let calls = 0;
  const probe = () => { calls += 1; return 'ENOENT'; };
  const app = await start({ ...FAST, root, probe });
  try {
    await app.ready;
    await until(() => calls >= 3, 3000);
  } finally {
    await app.close();
  }
  const n = calls;
  await sleep(150);
  assert.equal(calls, n);
  await claudeRootAt(root);
  assert.deepEqual(app.agents, []);
});
