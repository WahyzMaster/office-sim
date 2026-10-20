// session.agent: every `session` event names the coding agent the character comes from (today always 'claude-code').
// Checked live, in snapshotEvents(), through the real Store and over GET /state. Every record is invented
// (test/fixtures/records.mjs); the real ~/.claude is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionState } from '../src/session.mjs';
import { Store } from '../src/store.mjs';
import { buildSessionEvent, CLAUDE_CODE_AGENT } from '../src/session-identity.mjs';
import { start } from '../src/server.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '17171717-2222-4333-8444-555555555555';
const A1 = 'a0000000000001701';
const ROOT = '/tmp-fake/projects/-proj-agent';
const MAIN = `${ROOT}/${SID}.jsonl`;
const SUB = `${ROOT}/${SID}/subagents/agent-${A1}.jsonl`;
const CWD = '/work/agent-demo';
const META = { agentType: 'Explore', description: 'Look around', toolUseId: 'toolu_ag' };

const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

const sessions = (evs) => evs.filter((e) => e?.type === 'session');
const agentUse = (b) => b.assistantToolUse({ msgId: 'msg_m1', id: 'toolu_ag', name: 'Agent',
  input: { description: 'Look around', prompt: 'INVENTED PROMPT', subagent_type: 'Explore' } });
const readUse = (b) => b.assistantToolUse({ msgId: 'msg_s1', id: 'toolu_r', name: 'Read', input: { file_path: `${CWD}/a.mjs` } });

test('agent id: claude-code is the stable source id', () => {
  assert.equal(CLAUDE_CODE_AGENT, 'claude-code');
  const ev = buildSessionEvent({ id: SID, kind: 'main', stem: SID, info: {}, meta: {}, firstCwd: CWD, ts: 'x' });
  assert.equal(ev.agent, 'claude-code');
});

test('SessionState: live session events and snapshotEvents() carry agent claude-code (main and sub)', () => {
  const mb = createRecordBuilder({ sessionId: SID, cwd: CWD });
  const main = new SessionState({ id: SID, kind: 'main', stem: SID });
  const live = [mb.humanPrompt({ text: 'go' }), agentUse(mb)].flatMap((r) => main.apply(r));
  assert.ok(sessions(live).length >= 1, 'a live session event is emitted');
  for (const ev of sessions(live)) assert.equal(ev.agent, 'claude-code');
  assert.equal(main.sessionEvent().agent, 'claude-code');
  assert.deepEqual(sessions(main.snapshotEvents()).map((e) => e.agent), ['claude-code']);

  const sb = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: A1 });
  const sub = new SessionState({ id: A1, kind: 'sub', stem: SID, parentId: SID, agentType: 'Explore', subMeta: META });
  const subLive = [sb.subagentPrompt(), readUse(sb)].flatMap((r) => sub.apply(r));
  assert.ok(sessions(subLive).length >= 1);
  for (const ev of sessions(subLive)) assert.equal(ev.agent, 'claude-code');
  assert.deepEqual(sessions(sub.snapshotEvents()).map((e) => e.agent), ['claude-code']);
});

test('real Store: announce, live ingest, sub patch and snapshot() keep agent claude-code', () => {
  const store = new Store({ ringSize: 200 });
  const got = [];
  store.subscribe((item) => got.push(item.event));
  const feed = (p, state, recs) => { for (const r of recs) { store.observe(p, r); store.ingest(p, state.apply(r)); } };

  const mb = createRecordBuilder({ sessionId: SID, cwd: CWD });
  const main = new SessionState({ id: SID, kind: 'main', stem: SID });
  store.attachFile({ path: MAIN, kind: 'main' }, main);
  store.announce(MAIN);
  const announced = got.length;
  feed(MAIN, main, [mb.humanPrompt({ text: 'go' }), agentUse(mb)]);
  assert.ok(sessions(got.slice(announced)).some((e) => e.sessionId === SID), 'main session event sent live');

  // wired the way server-runner.mjs prepare() wires a subagent file
  const ref = { path: SUB, kind: 'sub' };
  const sub = new SessionState({ id: A1, kind: 'sub', stem: SID, parentId: store.parentFor(ref, META), agentType: META.agentType, subMeta: META });
  store.attachFile(ref, sub, { meta: META });
  store.announce(SUB);
  const subAnnounced = got.length;
  const sb = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: A1 });
  feed(SUB, sub, [sb.subagentPrompt(), readUse(sb)]);
  store.setMeta(SUB, { ...META, description: 'Look again' }); // Store-built patch of the sub session event
  assert.ok(sessions(got.slice(subAnnounced)).some((e) => e.sessionId === A1), 'sub session event sent live');

  const all = sessions(got);
  assert.deepEqual([...new Set(all.map((e) => e.sessionId))].sort(), [A1, SID].sort());
  for (const ev of all) assert.equal(ev.agent, 'claude-code', JSON.stringify(ev));
  const snap = sessions(store.snapshot().events);
  assert.deepEqual(snap.map((e) => `${e.sessionId}:${e.agent}`), [`${SID}:claude-code`, `${A1}:claude-code`]);
});

test('Store.patch keeps an agent id it was given and fills claude-code only when it is missing', () => {
  const store = new Store({ ringSize: 50 });
  const fake = (id, agent) => ({
    id, ended: false,
    sessionEvent() {
      return { type: 'session', sessionId: id, ts: 'x', ...(agent ? { agent } : {}), project: CWD, projectLabel: 'agent-demo',
        title: 't', branch: null, worktree: null, isSubagent: false, parentSessionId: null };
    },
    snapshotEvents() { return [this.sessionEvent()]; },
  });
  store.attachFile({ path: MAIN, kind: 'main' }, fake(SID, 'codex'));
  store.announce(MAIN);
  store.attachFile({ path: SUB, kind: 'sub' }, fake(A1, 'codex'), { meta: META });
  store.announce(SUB);
  const A2 = 'a0000000000001702';
  const SUB2 = `${ROOT}/${SID}/subagents/agent-${A2}.jsonl`;
  store.attachFile({ path: SUB2, kind: 'sub' }, fake(A2, null), { meta: { agentType: 'Plan' } });
  store.announce(SUB2);
  const byId = Object.fromEntries(sessions(store.snapshot().events).map((e) => [e.sessionId, e.agent]));
  assert.deepEqual(byId, { [SID]: 'codex', [A1]: 'codex', [A2]: 'claude-code' });
});

test('GET /state: every session event (main and subagent) carries agent claude-code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-agent-'));
  tmpDirs.push(root);
  const dir = path.join(root, '-work-agent-demo');
  const subDir = path.join(dir, SID, 'subagents');
  await fs.mkdir(subDir, { recursive: true });
  const t0 = Date.now() - 5000; // recent: replayed growth must not trip the idle timers
  const mb = createRecordBuilder({ sessionId: SID, cwd: CWD, startMs: t0, stepMs: 10 });
  const sb = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: A1, startMs: t0, stepMs: 10 });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), toJsonl([mb.humanPrompt({ text: 'Build the agent demo' }), agentUse(mb)]));
  await fs.writeFile(path.join(subDir, `agent-${A1}.jsonl`), toJsonl([sb.subagentPrompt({ text: 'INVENTED PROMPT' }), readUse(sb)]));
  await fs.writeFile(path.join(subDir, `agent-${A1}.meta.json`), JSON.stringify({ ...META, spawnDepth: 1 }));
  const app = await start({ port: 0, intervalMs: 50, rescanMs: 200, activeMinutes: 30, root, publicDir: PUBLIC });
  try {
    await app.ready;
    const res = await request(app.port, { path: '/state' });
    assert.equal(res.status, 200);
    const st = JSON.parse(res.body);
    assert.equal(st.type, 'snapshot');
    const got = sessions(st.events).map((e) => `${e.sessionId}:${e.isSubagent}:${e.agent}`);
    assert.deepEqual(got, [`${SID}:false:claude-code`, `${A1}:true:claude-code`]);
  } finally {
    await app.close();
  }
});
