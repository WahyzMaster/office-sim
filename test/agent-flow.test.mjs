// P5a agent id flow (contract 4.0.1): ref.agent -> Store entry -> session events (live, snapshot, /state), and the
// identity of a non-Claude ref taken from the ref as-is (the path is never parsed). Synthetic data and temp roots only;
// the second adapter is a fake (test/fixtures/fake-adapter.mjs), not a real Codex/Grok/Antigravity format.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { SessionState } from '../src/session.mjs';
import { refIdentity, refAgent } from '../src/store-link.mjs';
import { buildSessionEvent, CLAUDE_CODE_AGENT } from '../src/session-identity.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { FakeAgentSession, fakeAdapter, line } from './fixtures/fake-adapter.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '5a5a5a5a-1111-4222-8333-444455556666';
const A1 = 'a0000000000005a01';
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const sessions = (evs) => evs.filter((e) => e.type === 'session');

// ---- refIdentity / refAgent ------------------------------------------------------------------------------

test('refAgent: ref.agent, else claude-code', () => {
  assert.equal(refAgent({ path: '/x.jsonl' }), CLAUDE_CODE_AGENT);
  assert.equal(refAgent({ path: '/x.jsonl', agent: '' }), CLAUDE_CODE_AGENT);
  assert.equal(refAgent({ path: '/x.jsonl', agent: 'codex' }), 'codex');
});

test('refIdentity: a non-Claude ref is trusted as-is and its path is not parsed', () => {
  // a path shaped like a Claude subagent file: the Claude rules would read sid=<dir> and charId=a…
  const p = `/tmp-fake/grok/${SID}/subagents/agent-${A1}.jsonl`;
  assert.deepEqual(refIdentity({ path: p, agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' }),
    { kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', runId: null, runDir: null, parentId: 'grok-m1' });
  // defaults: kind main, sid from sessionId, charId = sid, parentId null
  assert.deepEqual(refIdentity({ path: p, agent: 'codex', sessionId: 'codex-s1' }),
    { kind: 'main', sid: 'codex-s1', charId: 'codex-s1', runId: null, runDir: null, parentId: null });
  // Claude refs (agent missing or 'claude-code') keep the path rules
  const claude = { kind: 'sub', sid: SID, charId: A1, runId: null, runDir: null };
  assert.deepEqual(refIdentity({ path: p }), claude);
  assert.deepEqual(refIdentity({ path: p, agent: 'claude-code' }), claude);
});

// ---- SessionState / buildSessionEvent ---------------------------------------------------------------------

test('SessionState agent option: default claude-code, otherwise the given id on live and snapshot session events', () => {
  const mb = createRecordBuilder({ sessionId: SID, cwd: '/work/flow' });
  const recs = [mb.humanPrompt({ text: 'go' }), mb.assistantText({ msgId: 'msg_1', text: 'Working.' })];
  const plain = new SessionState({ id: SID, kind: 'main', stem: SID });
  assert.equal(plain.agent, CLAUDE_CODE_AGENT);
  assert.equal(plain.sessionEvent().agent, CLAUDE_CODE_AGENT);
  const other = new SessionState({ id: SID, kind: 'main', stem: SID, agent: 'codex' });
  const live = recs.flatMap((r) => other.apply(r));
  assert.ok(sessions(live).length > 0);
  for (const ev of sessions(live)) assert.equal(ev.agent, 'codex');
  assert.deepEqual(sessions(other.snapshotEvents()).map((e) => e.agent), ['codex']);
});

test('buildSessionEvent writes s.agent, else claude-code', () => {
  const base = { id: SID, kind: 'main', stem: SID, info: {}, meta: {}, firstCwd: '/work/flow', ts: 'x' };
  assert.equal(buildSessionEvent(base).agent, CLAUDE_CODE_AGENT);
  assert.equal(buildSessionEvent({ ...base, agent: null }).agent, CLAUDE_CODE_AGENT);
  assert.equal(buildSessionEvent({ ...base, agent: 'antigravity' }).agent, 'antigravity');
});

// ---- Store ------------------------------------------------------------------------------------------------

function fakeState(id, { agent, kind = 'main', title = 't', cwd = '/work/flow' } = {}) {
  return {
    id, ended: false,
    sessionEvent() {
      return { type: 'session', sessionId: id, ts: 'x', ...(agent ? { agent } : {}), project: cwd, projectLabel: path.basename(cwd),
        title, branch: null, worktree: null, isSubagent: kind !== 'main', parentSessionId: null };
    },
    snapshotEvents() { return [this.sessionEvent()]; },
  };
}

test('Store: entry.agent = ref.agent ?? claude-code; patch fills a missing agent from the entry', () => {
  const store = new Store({ ringSize: 50 });
  const MAIN = '/tmp-fake/grok/main.jsonl';
  const CHILD = `/tmp-fake/grok/${SID}/subagents/agent-${A1}.jsonl`; // Claude-shaped path, not parsed for grok
  store.attachFile({ path: MAIN, agent: 'grok', kind: 'main', sid: 'grok-m1', charId: 'grok-m1' }, fakeState('grok-m1', { agent: 'grok' }));
  store.attachFile({ path: CHILD, agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' },
    fakeState('grok-c1', { kind: 'sub', title: 'Helper', cwd: '/work/flow/deeper' })); // no agent on its events
  const CL = `/tmp-fake/claude/-p/${SID}.jsonl`;
  store.attachFile({ path: CL }, fakeState(SID, { agent: 'claude-code' })); // main events are not patched: the session sets agent
  assert.equal(store.entry(MAIN).agent, 'grok');
  assert.equal(store.entry(CHILD).agent, 'grok');
  assert.equal(store.entry(CHILD).charId, 'grok-c1');
  assert.equal(store.entry(CL).agent, CLAUDE_CODE_AGENT);
  for (const p of [MAIN, CHILD, CL]) store.announce(p);
  const snap = sessions(store.snapshot().events);
  const child = snap.find((e) => e.sessionId === 'grok-c1');
  assert.deepEqual(
    { agent: child.agent, isSubagent: child.isSubagent, parent: child.parentSessionId, title: child.title, project: child.project },
    { agent: 'grok', isSubagent: true, parent: 'grok-m1', title: 'Helper', project: '/work/flow' },
    'parent from ref.parentId, title from the session (not meta.json), floor inherited from the parent');
  assert.equal(snap.find((e) => e.sessionId === SID).agent, 'claude-code');
  assert.equal(store.parentFor({ path: CHILD, agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' }), 'grok-m1');
  assert.equal(store.parentFor({ path: CHILD, agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-c2' }), 'grok-m1');
  assert.equal(store.parentFor({ path: MAIN, agent: 'grok', sid: 'grok-m1' }), null);
});

test('Store: the Claude linkage (observe, setMeta, taskDeltas, pendingMeta) never runs for a non-Claude entry', () => {
  const store = new Store({ ringSize: 50 });
  const MAIN = '/tmp-fake/codex/main.jsonl';
  const SUB = '/tmp-fake/codex/sub.jsonl';
  store.attachFile({ path: MAIN, agent: 'codex', sid: 'codex-m1' }, fakeState('codex-m1', { agent: 'codex' }));
  store.attachFile({ path: SUB, agent: 'codex', kind: 'sub', sid: 'codex-m1', charId: 'codex-c1' }, fakeState('codex-c1', { kind: 'sub' }));
  store.announce(MAIN);
  store.announce(SUB);
  assert.deepEqual(store.pendingMeta(), [], 'no meta.json is awaited for a non-Claude subagent');
  // Claude-shaped spawn + completion records written into a codex file are not linkage facts for the Store
  const mb = createRecordBuilder({ sessionId: 'codex-m1', cwd: '/work/flow' });
  store.observe(MAIN, mb.assistantToolUse({ msgId: 'msg_1', id: 'toolu_x', name: 'Agent', input: { description: 'd' } }));
  store.observe(MAIN, mb.toolResult({ toolUseId: 'toolu_x', toolUseResult: { status: 'completed', agentId: A1 } }));
  assert.equal(store.index('codex-m1').toolOwner.size, 0);
  store.setMeta(SUB, { name: 'Renamed by meta', toolUseId: 'toolu_x' });
  assert.equal(store.entry(SUB).meta, null);
  store.taskDeltas(SUB, [{ toolUseId: 'toolu_t', ts: 'x' }]);
  assert.equal(store.index('codex-m1').taskDeltas.size, 0);
  assert.ok(!store.ring.some((x) => x.event.type === 'session_end'));
  assert.equal(sessions(store.snapshot().events).find((e) => e.sessionId === 'codex-c1').title, 't');
});

// ---- server: two adapters, one Store ---------------------------------------------------------------------

async function grokLayout() {
  const root = await tmp('office-sim-flow-grok-');
  const mainPath = path.join(root, 'proj', 'main.jsonl');
  const childPath = path.join(root, SID, 'subagents', `agent-${A1}.jsonl`); // Claude-shaped on purpose
  await fs.mkdir(path.dirname(mainPath), { recursive: true });
  await fs.mkdir(path.dirname(childPath), { recursive: true });
  await fs.writeFile(mainPath, line({ k: 'meta', cwd: '/work/mixed', title: 'Grok main' }) + line({ k: 'tool', id: 'g1', tool: 'read_file', summary: 'a.txt' }));
  await fs.writeFile(childPath, line({ k: 'meta', cwd: '/work/mixed/sub', title: 'Grok helper' }) + line({ k: 'tool', id: 'g2', tool: 'search', summary: 'needle' }));
  // the scan fills kind/sid/charId/parentId but no agent: the Runner stamps deps.agent
  const files = () => [
    { path: mainPath, kind: 'main', sid: 'grok-m1', charId: 'grok-m1' },
    { path: childPath, kind: 'sub', sid: 'grok-m1', charId: 'grok-c1', parentId: 'grok-m1' },
  ];
  return { root, mainPath, childPath, files };
}

async function claudeLayout() {
  const root = await tmp('office-sim-flow-claude-');
  const dir = path.join(root, '-work-mixed');
  await fs.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: SID, cwd: '/work/mixed', startMs: Date.now() - 5000, stepMs: 10 });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), toJsonl([mb.humanPrompt({ text: 'Build the mixed demo' }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  return root;
}

test('server: a second adapter runs next to claude-code on one Store; agent ids flow live, in the snapshot and in /state', async () => {
  const claudeRoot = await claudeLayout();
  const g = await grokLayout();
  const app = await start({
    port: 0, root: claudeRoot, roots: { grok: g.root }, adapters: { ...ADAPTERS, grok: fakeAdapter({ id: 'grok', files: g.files }) },
    publicDir: PUBLIC, intervalMs: 50, rescanMs: 100, idleMs: 50, activeMinutes: 30,
  });
  let es = null;
  try {
    assert.deepEqual(app.agents, ['claude-code', 'grok']);
    assert.deepEqual(app.notImplemented, []);
    await app.ready;
    assert.equal(app.store.entry(g.childPath).ref.agent, 'grok', 'the Runner stamped deps.agent on the ref');
    assert.equal(app.store.entry(g.childPath).agent, 'grok');

    // /state: both adapters, the grok child linked by ref.parentId and on its parent's floor
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    const got = sessions(st.events).map((e) => `${e.sessionId}:${e.agent}:${e.isSubagent}:${e.parentSessionId}`);
    assert.deepEqual(got.sort(), [`${SID}:claude-code:false:null`, 'grok-c1:grok:true:grok-m1', 'grok-m1:grok:false:null'].sort());
    const child = sessions(st.events).find((e) => e.sessionId === 'grok-c1');
    assert.equal(child.title, 'Grok helper');
    assert.equal(child.project, '/work/mixed');
    assert.ok(st.events.some((e) => e.type === 'tool_start' && e.toolUseId === 'g2' && e.sessionId === 'grok-c1'));

    // live SSE: snapshot first, then appended lines
    es = await sse(app.port);
    const snap = await es.next((fr) => fr.data?.type === 'snapshot');
    assert.deepEqual(sessions(snap.data.events).map((e) => `${e.sessionId}:${e.agent}`).sort(),
      [`${SID}:claude-code`, 'grok-c1:grok', 'grok-m1:grok'].sort());
    await fs.appendFile(g.childPath, line({ k: 'meta', title: 'Grok helper 2' }));
    const renamed = await es.next((fr) => fr.data?.type === 'session' && fr.data.sessionId === 'grok-c1');
    assert.deepEqual([renamed.data.agent, renamed.data.title, renamed.data.isSubagent], ['grok', 'Grok helper 2', true]);
    await fs.appendFile(g.mainPath, line({ k: 'tool', id: 'g3', tool: 'edit_file', summary: 'b.txt' }));
    const t3 = await es.next((fr) => fr.data?.type === 'tool_start' && fr.data.toolUseId === 'g3');
    assert.equal(t3.data.sessionId, 'grok-m1');

    // the parent's file ends the child through the common end hint: one session_end, no hint on the wire
    await fs.appendFile(g.mainPath, line({ k: 'sub_end', child: 'grok-c1' }));
    const end = await es.next((fr) => fr.data?.type === 'session_end' && fr.data.sessionId === 'grok-c1');
    assert.equal(end.data.reason, 'done');
    await fs.appendFile(g.mainPath, line({ k: 'sub_end', child: 'grok-c1' }) + line({ k: 'meta', title: 'after' }));
    await es.next((fr) => fr.data?.type === 'session' && fr.data.sessionId === 'grok-m1' && fr.data.title === 'after');
    assert.equal(app.store.ring.filter((x) => x.event.type === 'session_end' && x.event.sessionId === 'grok-c1').length, 1);
    assert.ok(!es.frames.some((fr) => fr.raw.includes('"hint"')), 'no hint item reaches /events');
    assert.ok(!app.store.ring.some((x) => 'hint' in x.event), 'no hint item reaches the ring');
    const after = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.ok(!after.events.some((e) => e.sessionId === 'grok-c1'), 'the ended child left /state');
    assert.ok(!JSON.stringify(after).includes('"hint"'));

    // RunnerGroup: one count over both Runners
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.deepEqual(health, { ok: true, files: 3, sessions: 3, clients: 1, agents: ['claude-code', 'grok'] });
    assert.deepEqual(app.stats(), { files: 3, badLines: 0, skippedLines: 0, applyErrors: 0, rejectedRefs: 0 });
  } finally {
    es?.close();
    await app.close();
  }
});

test('server: an idle() hint ends a live character; lines of the ended child read right after are dropped', async () => {
  const g = await grokLayout();
  const app = await start({
    port: 0, root: path.join(g.root, 'no-claude-here'), roots: { grok: g.root },
    adapters: { ...ADAPTERS, grok: fakeAdapter({ id: 'grok', files: g.files }) },
    publicDir: PUBLIC, intervalMs: 50, rescanMs: 100, idleMs: 50, activeMinutes: 30,
  });
  try {
    assert.deepEqual(app.agents, ['grok'], 'claude-code is off: its root does not exist');
    await app.ready;
    await fs.appendFile(g.mainPath, line({ k: 'sub_end_later', child: 'grok-c1' }));
    await until(() => app.store.ring.some((x) => x.event.type === 'session_end' && x.event.sessionId === 'grok-c1'), 3000);
    await fs.appendFile(g.childPath, line({ k: 'tool', id: 'g9', tool: 'late', summary: 'tail' })); // within the grace window
    await fs.appendFile(g.mainPath, line({ k: 'meta', title: 'marker' }));
    await until(() => app.store.ring.some((x) => x.event.type === 'session' && x.event.title === 'marker'), 3000);
    await until(() => app.stats().files === 2);
    // the late child line was polled before or with the marker (children poll first), and dropped
    assert.ok(!app.store.ring.some((x) => x.event.toolUseId === 'g9'));
    assert.ok(!app.store.snapshot().events.some((e) => e.sessionId === 'grok-c1'));
  } finally {
    await app.close();
  }
});

test('FakeAgentSession is a SessionLike: replay builds state and returns nothing', () => {
  const s = new FakeAgentSession({ id: 'grok-x', agent: 'grok' });
  assert.deepEqual(s.apply({ k: 'tool', id: 't', tool: 'x', summary: 's' }, { replay: true }), []);
  assert.equal(s.snapshotEvents().filter((e) => e.type === 'tool_start').length, 1);
  assert.equal(s.sessionEvent().agent, 'grok');
});
