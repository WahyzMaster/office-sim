// Interactive `--replay` timeline scrubber tests: marker extraction, `GET/POST /api/replay` HTTP controls,
// deterministic forward/backward `seek` (including multi-session main + subagent + plan rollback), SSE `reset: true`
// snapshot broadcast, and pure UI helpers in `public/js/replay-scrubber.js`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { fileEntries, mergeTimeline, schedule, extractReplayMarkers } from '../src/replay-timeline.mjs';
import {
  scrubberText, formatReplayTime, mergeReplayBookmarks, nearestMarker,
} from '../public/js/replay-scrubber.js';
import { request, sse, until } from './fixtures/sse.mjs';
import { writeReplayFixture, REPLAY_SID, REPLAY_AGENT, REPLAY_CWD, IDS } from './fixtures/replay-fixture.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const TIMING = { maxGapMs: 400, holdMs: 200, restartMs: 200, statusMs: 40 };

const tmpDirs = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.close();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function makeTemp(prefix) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function postReplay(port, body) {
  const res = await request(port, {
    method: 'POST',
    path: '/api/replay',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: JSON.parse(res.body) };
}

test('extractReplayMarkers extracts prompt, plan, subagent, error and turn_end markers without leaking paths or bodies', async () => {
  const dir = await makeTemp('office-sim-markers-');
  const { mainPath, subPath } = await writeReplayFixture(dir);
  const files = [
    fileEntries(await fs.readFile(mainPath, 'utf8')).entries,
    fileEntries(await fs.readFile(subPath, 'utf8')).entries,
  ];
  const merged = mergeTimeline(files);
  schedule(merged, { speed: 10, maxGapMs: 300 });
  const markers = extractReplayMarkers(merged);

  const kinds = new Set(markers.map((m) => m.kind));
  assert.deepEqual([...kinds].sort(), ['error', 'plan', 'prompt', 'subagent', 'turn_end']);
  assert.ok(markers.some((m) => m.kind === 'prompt' && m.label.includes('파서를 정리해 줘')));
  assert.ok(markers.some((m) => m.kind === 'plan' && m.label === 'Plan (3)'));
  assert.ok(markers.some((m) => m.kind === 'subagent' && m.label === '사용처 조사'));
  assert.ok(markers.some((m) => m.kind === 'error' && m.label === 'Permission denied'));

  const serialized = JSON.stringify(markers);
  assert.ok(!serialized.includes(REPLAY_CWD), 'full project path must not appear in markers');
  assert.ok(!serialized.includes('invented file body'), 'tool output body must not appear in markers');

  const capped = extractReplayMarkers(merged, { maxMarkers: 3 });
  assert.equal(capped.length, 3);
  assert.ok(capped[0].cursor < capped[1].cursor && capped[1].cursor < capped[2].cursor, 'preserves chronological order');

  // Verify system-reminder, task-notification, compact-summary, and fork-prefix user records never leak into prompt markers
  const synthetic = [
    {
      fi: 0, t: 1000, due: 0,
      line: JSON.stringify({
        type: 'user', sessionId: 'other-fork-sid', origin: { kind: 'human' },
        message: { role: 'user', content: 'FORK_PREFIX_SECRET_PROMPT' },
      }),
    },
    {
      fi: 0, t: 2000, due: 100,
      line: JSON.stringify({
        type: 'user', sessionId: REPLAY_SID, origin: { kind: 'task-notification' },
        message: { role: 'user', content: '<task-notification><result>SUBAGENT_BODY_BAIT</result></task-notification>' },
      }),
    },
    {
      fi: 0, t: 3000, due: 200,
      line: JSON.stringify({
        type: 'user', sessionId: REPLAY_SID, isCompactSummary: true, origin: { kind: 'human' },
        message: { role: 'user', content: 'COMPACT_SUMMARY_BAIT' },
      }),
    },
    {
      fi: 0, t: 4000, due: 300,
      line: JSON.stringify({
        type: 'user', sessionId: REPLAY_SID, origin: { kind: 'human' },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>SECRET_CLAUDE_MD_REMINDER</system-reminder>' },
            { type: 'text', text: 'Real scrubbed prompt text' },
          ],
        },
      }),
    },
  ];
  const scrubbedMarkers = extractReplayMarkers(synthetic, { mainStem: REPLAY_SID });
  assert.equal(scrubbedMarkers.length, 1);
  assert.equal(scrubbedMarkers[0].label, 'Real scrubbed prompt text');
  assert.ok(!JSON.stringify(scrubbedMarkers).includes('SECRET_CLAUDE_MD_REMINDER'));
  assert.ok(!JSON.stringify(scrubbedMarkers).includes('SUBAGENT_BODY_BAIT'));
});

test('GET and POST /api/replay return 404 when server is not running in --replay mode', async () => {
  const root = await makeTemp('office-sim-live-no-replay-');
  const app = await start({ port: 0, root, publicDir: PUBLIC, agents: ['claude-code'], intervalMs: 100 });
  apps.push(app);
  await app.ready;

  const getRes = await request(app.port, { path: '/api/replay' });
  assert.equal(getRes.status, 404);
  assert.equal(JSON.parse(getRes.body).active, false);

  const postRes = await postReplay(app.port, { action: 'pause' });
  assert.equal(postRes.status, 404);
});

test('Interactive /api/replay pause, speed, forward/backward seek and SSE reset snapshot rebuild main + subagent + plan state deterministically', async () => {
  const fixDir = await makeTemp('office-sim-scrubber-fix-');
  const { mainPath, subPath } = await writeReplayFixture(fixDir);
  const root = await makeTemp('office-sim-scrubber-root-');

  const files = [
    fileEntries(await fs.readFile(mainPath, 'utf8')).entries,
    fileEntries(await fs.readFile(subPath, 'utf8')).entries,
  ];
  const merged = mergeTimeline(files);
  const cursorOfToolResult = (id) => {
    const idx = merged.findIndex(({ line }) => {
      const c = JSON.parse(line).message?.content;
      return Array.isArray(c) && c.some((b) => b?.type === 'tool_result' && b.tool_use_id === id);
    });
    assert.ok(idx >= 0, `tool_result ${id} must exist`);
    return idx + 1;
  };
  const midSubCursor = cursorOfToolResult(IDS.subRead); // Subagent is active & plan step 1 is in_progress
  const latePlanCursor = cursorOfToolResult('toolu_p02'); // Subagent finished & plan steps 1-2 completed, step 3 in_progress

  // Start slow (speed: 0.5) so we can pause immediately and drive timeline deterministically via seek()
  const app = await start({
    port: 0, root, publicDir: PUBLIC, replay: mainPath, speed: 0.5, intervalMs: 50, idleMs: 50, replayTiming: TIMING,
  });
  apps.push(app);
  await until(async () => {
    const r = await request(app.port, { path: '/api/replay' });
    const body = JSON.parse(r.body);
    return body.state !== 'loading' && body.total === merged.length;
  }, 4000);

  const es = await sse(app.port);
  try {
    await es.next((fr) => fr.data?.type === 'snapshot', 3000);

    // 1. Pause playback and verify `/config` keeps its strict 5-key shape while `/api/replay` returns full detail
    const paused = await postReplay(app.port, { action: 'pause' });
    assert.equal(paused.status, 200);
    assert.equal(paused.json.state, 'paused');
    assert.equal(paused.json.paused, true);
    assert.ok(Array.isArray(paused.json.markers) && paused.json.markers.length >= 5);

    const cfg = JSON.parse((await request(app.port, { path: '/config' })).body);
    assert.deepEqual(Object.keys(cfg.replay).sort(), ['loop', 'progress', 'round', 'speed', 'state']);
    assert.equal(cfg.replay.state, 'paused');

    // 2. Seek forward to mid-subagent cursor: both main + subagent sessions and 3-item initial plan must be live
    const seekSub = await postReplay(app.port, { action: 'seek', cursor: midSubCursor, paused: true });
    assert.equal(seekSub.status, 200);
    assert.equal(seekSub.json.cursor, midSubCursor);

    const snapSub = await es.next((fr) => fr.data?.type === 'snapshot' && fr.data.reset === true, 3000);
    const subSessions = snapSub.data.events.filter((e) => e.type === 'session').map((e) => e.sessionId);
    assert.deepEqual(subSessions, [REPLAY_SID, REPLAY_AGENT], 'both main and active subagent appear at midSubCursor');
    const planAtSub = snapSub.data.events.find((e) => e.type === 'plan' && e.sessionId === REPLAY_SID);
    assert.deepEqual(planAtSub?.items.map((i) => i.status), ['in_progress', 'pending', 'pending']);

    // 3. Seek forward to late plan cursor: subagent has completed & exited; plan steps 1-2 completed, step 3 in_progress
    const seekLate = await postReplay(app.port, { action: 'seek', cursor: latePlanCursor, paused: true });
    assert.equal(seekLate.status, 200);
    const stateLate = JSON.parse((await request(app.port, { path: '/state' })).body).events;
    assert.deepEqual(stateLate.filter((e) => e.type === 'session').map((e) => e.sessionId), [REPLAY_SID]);
    const planLate = stateLate.find((e) => e.type === 'plan' && e.sessionId === REPLAY_SID);
    assert.deepEqual(planLate?.items.map((i) => i.status), ['completed', 'completed', 'in_progress']);

    // 4. Seek backward to cursor 0 (clean slate) and then back to midSubCursor (verifies deterministic rollback with zero UUID collisions)
    const seekZero = await postReplay(app.port, { action: 'seek', cursor: 0, paused: true });
    assert.equal(seekZero.status, 200);
    assert.equal(seekZero.json.progress, 0);
    const stateZero = JSON.parse((await request(app.port, { path: '/state' })).body).events;
    assert.deepEqual(stateZero, []);

    const seekSubAgain = await postReplay(app.port, { action: 'seek', cursor: midSubCursor, paused: true });
    assert.equal(seekSubAgain.status, 200);
    const stateSubAgain = JSON.parse((await request(app.port, { path: '/state' })).body).events;
    assert.deepEqual(stateSubAgain.filter((e) => e.type === 'session').map((e) => e.sessionId), [REPLAY_SID, REPLAY_AGENT]);

    // 5. Update speed + resume to completion; invalid inputs return 400
    const badSeek = await postReplay(app.port, { action: 'seek', progress: 2.5 });
    assert.equal(badSeek.status, 400);
    const badSpeed = await postReplay(app.port, { action: 'speed', speed: 0 });
    assert.equal(badSpeed.status, 400);
    const nonNumericSpeed = await postReplay(app.port, { action: 'speed', speed: '4' });
    assert.equal(nonNumericSpeed.status, 400);
    const boolSpeed = await postReplay(app.port, { action: 'speed', speed: true });
    assert.equal(boolSpeed.status, 400);

    const fast = await postReplay(app.port, { action: 'speed', speed: 50 });
    assert.equal(fast.status, 200);
    assert.equal(fast.json.speed, 50);

    const resumed = await postReplay(app.port, { action: 'resume' });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.paused, false);

    await until(async () => {
      const r = JSON.parse((await request(app.port, { path: '/api/replay' })).body);
      return r.state === 'done' && r.progress === 1;
    }, 5000);
  } finally {
    es.close();
  }
});

test('public/js/replay-scrubber.js pure helpers format time, localize labels, merge pins and step markers', () => {
  assert.equal(formatReplayTime(0), '0:00');
  assert.equal(formatReplayTime(65_400), '1:05');
  assert.equal(scrubberText('ko').pause, '일시정지');
  assert.equal(scrubberText('en').pause, 'Pause');

  const merged = mergeReplayBookmarks(
    [
      { cursor: 3, progress: 0.2, dueMs: 400, kind: 'prompt', label: 'Start' },
      { cursor: 12, progress: 0.8, dueMs: 1600, kind: 'plan', label: 'Plan (3)' },
    ],
    [{ cursor: 7, progress: 0.5, dueMs: 1000, label: '@50%' }],
  );
  assert.deepEqual(merged.map((m) => m.kind), ['prompt', 'pin', 'plan']);
  assert.equal(nearestMarker(merged, 0.21, 1)?.kind, 'pin');
  assert.equal(nearestMarker(merged, 0.5, -1)?.kind, 'prompt');
  assert.equal(nearestMarker(merged, 0.95, 1)?.kind, 'plan');
});
