// Runner loop regressions (2026-10-19 findings 29, 30, 31): attach rollback, poll timer re-arm, error backoff.
// Fake deps only (fake scan / tailer / SessionState); no transcript file is read, the real ~/.claude is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { request, until } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '29292929-1111-4222-8333-444455556666';
const SID2 = '29292929-2222-4222-8333-444455556666';
const AGENT = 'a0000000000002901';
const ROOT = '/nonexistent-office-sim-root/projects';
const mainRef = (sid) => ({ path: `${ROOT}/-work-demo/${sid}.jsonl`, kind: 'main', stem: sid, sessionId: sid, size: 0, ino: 1 });
const subRef = { path: `${ROOT}/-work-demo/${SID}/subagents/agent-${AGENT}.jsonl`, kind: 'sub', stem: AGENT, sessionId: SID, agentId: AGENT, size: 0, ino: 2 };

// faults armed by a test: { sessionEvent: Set(id), snapshotEvents: Set(id) } throw once for that id
const faults = { sessionEvent: new Set(), snapshotEvents: new Set() };
function fault(kind, id) {
  if (faults[kind].delete(id)) throw new Error(`injected ${kind} failure`);
}
class FakeSession {
  constructor({ id, kind, parentId = null }) { Object.assign(this, { id, kind, parentId }); }
  apply() { return []; }
  idle() { return []; }
  setInfo() { return []; }
  sessionEvent() {
    fault('sessionEvent', this.id);
    return { type: 'session', sessionId: this.id, ts: new Date().toISOString(), project: '/work/demo', projectLabel: 'demo',
      title: this.id.slice(0, 8), branch: 'main', worktree: null, isSubagent: this.kind !== 'main', parentSessionId: this.parentId, agentType: null };
  }
  snapshotEvents() { fault('snapshotEvents', this.id); return [this.sessionEvent()]; }
  get ended() { return false; }
}
class NullTailer { async readAll() { return { offset: 0 }; } async poll() { return { bytes: 0 }; } forget() {} }
const deps = (over) => ({ SessionState: FakeSession, Tailer: NullTailer, readSubMeta: async () => null, readJournalLabels: async () => new Map(), ...over });
const opts = (over) => ({ port: 0, root: ROOT, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60_000, ...over });
const sessionsIn = (app) => app.store.ring.filter((x) => x.event.type === 'session').map((x) => x.event.sessionId);
const eaccess = () => Object.assign(new Error("EACCES: permission denied, open '/x/y.jsonl'"), { code: 'EACCES' });

// ---- 29: a throw inside attach rolls back instead of leaving a zombie file -----------------------------

test('a transient throw while a new sub attaches is rolled back and the next rescan attaches it', async () => {
  let refs = [mainRef(SID)];
  const logs = [];
  const app = await start(opts({ rescanMs: 50, log: (m) => logs.push(m), deps: deps({ scan: async () => refs }) }));
  try {
    await app.ready;
    assert.deepEqual(sessionsIn(app), [SID]);
    faults.sessionEvent.add(SID); // the sub's attachFile -> syncInfo -> mainEvent() throws once
    refs = [mainRef(SID), subRef];
    await until(() => logs.some((m) => /attach failed/.test(m)), 3000);
    await until(() => sessionsIn(app).includes(AGENT), 3000);
    assert.ok(app.store.snapshot().events.some((e) => e.sessionId === AGENT), 'sub is in /state after the retry');
    assert.equal(app.store.entry(subRef.path)?.announced, true);
  } finally {
    faults.sessionEvent.clear();
    await app.close();
  }
});

test('a throw while announcing one session does not skip the other new sessions of the same rescan', async () => {
  faults.snapshotEvents.add(SID);
  const logs = [];
  const app = await start(opts({ rescanMs: 100, log: (m) => logs.push(m), deps: deps({ scan: async () => [mainRef(SID), mainRef(SID2)] }) }));
  try {
    await app.ready;
    assert.ok(sessionsIn(app).includes(SID2), `second session attached in the same rescan: ${sessionsIn(app)}`);
    await until(() => sessionsIn(app).includes(SID), 3000); // the failed one is re-attached by a later rescan
    assert.deepEqual(app.store.snapshot().events.map((e) => e.sessionId).sort(), [SID, SID2].sort());
  } finally {
    faults.snapshotEvents.clear();
    await app.close();
  }
});

// ---- 30: POST /config never starves the poll loop ------------------------------------------------------

test('repeated POST /config (same or stepping values) keeps polling', async () => {
  let polls = 0;
  class CountingTailer extends NullTailer { async poll() { polls += 1; return { bytes: 0 }; } }
  const app = await start(opts({ intervalMs: 100, deps: deps({ Tailer: CountingTailer, scan: async () => [mainRef(SID)] }) }));
  const post = (ms) => request(app.port, { method: 'POST', path: '/config', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intervalMs: ms }) });
  try {
    await app.ready;
    const hammer = async (valueAt) => {
      const before = polls;
      const t0 = Date.now();
      for (let i = 0; Date.now() - t0 < 600; i++) {
        assert.equal((await post(valueAt(i))).status, 200);
        await sleep(30);
      }
      return polls - before;
    };
    const same = await hammer(() => 100);
    assert.ok(same >= 2, `same value: ${same} polls in 600 ms`); // before the fix: 0
    const stepping = await hammer((i) => 100 + 10 * ((i % 5) + 1));
    assert.ok(stepping >= 2, `stepping values: ${stepping} polls in 600 ms`);
    // the verdict's case: a value that keeps growing (150, 200, 250, ... every 30 ms, a held spinner) never pushes the
    // pending poll out; before the integrator fix this gave 0 polls
    await post(100);
    await sleep(150);
    const growing = await hammer((i) => 150 + 50 * i);
    assert.ok(growing >= 1, `growing values: ${growing} polls in 600 ms`);
    // a shorter interval takes effect without waiting out the old one
    await post(5000);
    await sleep(150);
    const b = polls;
    await post(50);
    await until(() => polls > b, 1000);
  } finally {
    await app.close();
  }
});

// ---- 31: an unreadable attached file backs off and logs once per state change ---------------------------

test('a poll that keeps failing is logged once, backs off, and recovers', async () => {
  let failing = true;
  let polls = 0;
  class FlakyTailer extends NullTailer {
    async poll() { polls += 1; if (failing) throw eaccess(); return { bytes: 0 }; }
  }
  const logs = [];
  const app = await start(opts({ intervalMs: 50, log: (m) => logs.push(m), deps: deps({ Tailer: FlakyTailer, scan: async () => [mainRef(SID)] }) }));
  try {
    await app.ready;
    await sleep(1200);
    const failed = logs.filter((m) => /poll failed/.test(m));
    assert.equal(failed.length, 1, failed.join('\n'));
    assert.match(failed[0], /EACCES/);
    assert.ok(polls <= 8, `backed off: ${polls} attempts in 1.2 s at 50 ms`);
    failing = false;
    const p0 = polls;
    await until(() => polls >= p0 + 3, 5000); // readable again: polled at the normal rate
    assert.equal(logs.filter((m) => /poll recovered/.test(m)).length, 1);
    failing = true;
    await until(() => logs.filter((m) => /poll failed/.test(m)).length === 2, 3000); // a new failure is logged again
  } finally {
    await app.close();
  }
});

test('a file that can never be read is logged once across rescans', async () => {
  let reads = 0;
  class UnreadableTailer extends NullTailer { async readAll() { reads += 1; throw eaccess(); } }
  const logs = [];
  const app = await start(opts({ rescanMs: 50, log: (m) => logs.push(m), deps: deps({ Tailer: UnreadableTailer, scan: async () => [mainRef(SID)] }) }));
  try {
    await app.ready;
    await until(() => reads >= 6, 3000);
    const failed = logs.filter((m) => /attach failed/.test(m));
    assert.equal(failed.length, 1, failed.join('\n'));
    assert.match(failed[0], /EACCES/);
  } finally {
    await app.close();
  }
});
