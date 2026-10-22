// 재생 모드(P3) 통합: start({ replay }) 가 지어낸 세션(+서브에이전트)을 기록 시각 간격(배속)대로 같은 Store/SSE 로 흘려보낸다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { parseArgs } from '../src/cli-args.mjs';
import { fileEntries, mergeTimeline, schedule } from '../src/replay-timeline.mjs';
// 서버(claude-code 어댑터)가 동적 import 하는 것과 같은 모듈 인스턴스다
import { ReplayRunner } from '../src/replay.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { writeReplayFixture, REPLAY_SID, REPLAY_AGENT, REPLAY_CWD, IDS, LONG_GAP_MS } from './fixtures/replay-fixture.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SPEED = 20;
const TIMING = { maxGapMs: 300, holdMs: 150, restartMs: 150, statusMs: 50 };
const tmpDirs = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.close();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-replay-'));
  tmpDirs.push(dir);
  return writeReplayFixture(dir);
}

// root 는 비어 있는 임시 폴더: 재생 모드는 root 를 보지 않는다
async function launch(mainPath, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-replay-root-'));
  tmpDirs.push(root);
  const app = await start({
    port: 0, root, publicDir: PUBLIC, replay: mainPath, speed: SPEED, intervalMs: 50, idleMs: 50,
    replayTiming: TIMING, ...extra,
  });
  apps.push(app);
  const got = [];
  app.store.subscribe(({ event }) => got.push({ at: Date.now(), ev: event }));
  return { app, got };
}

const getConfig = async (port) => JSON.parse((await request(port, { path: '/config' })).body);
const find = (got, pred) => got.find((g) => pred(g.ev));
const startOf = (got, id) => find(got, (e) => e.type === 'tool_start' && e.toolUseId === id);

// 재생기와 같은 순수 시간표 (시계 없음): 메인 먼저, 그다음 서브에이전트 파일 -> [{ fi, line, t, due }]
async function plannedTimeline({ mainPath, subPath }) {
  const files = [];
  for (const p of [mainPath, subPath]) files.push(fileEntries(await fs.readFile(p, 'utf8')).entries);
  const timeline = mergeTimeline(files);
  schedule(timeline, { speed: SPEED, maxGapMs: TIMING.maxGapMs });
  return timeline;
}

// 그 도구 호출(tool_use 블록)이 실린 줄이 재생 시작 몇 ms 뒤에 나오는지
function dueOf(timeline, id) {
  const e = timeline.find(({ line }) => {
    const content = JSON.parse(line).message?.content;
    return Array.isArray(content) && content.some((b) => b?.type === 'tool_use' && b.id === id);
  });
  assert.ok(e, `no tool_use ${id} in the timeline`);
  return e.due;
}

// 재생기 안을 시계 상한 없이 본다: begin() 이 잡은 시작 시각과 due, poll 마다 낸 줄의 범위 [from, to).
// 원래 메서드를 감싸 기록만 하고 동작은 바꾸지 않는다. restore() 로 되돌린다.
function watchReplay() {
  const P = ReplayRunner.prototype;
  const { begin, pollAll } = P;
  const seen = { startWall: null, dues: null, polls: [] };
  P.begin = function (...args) {
    const r = begin.apply(this, args);
    seen.startWall = this.startWall;
    seen.dues = this.timeline.map((e) => e.due);
    return r;
  };
  P.pollAll = async function (...args) {
    if (this.phase !== 'playing') return pollAll.apply(this, args);
    // lo 는 부르기 전에 잰다: pollAll 이 안에서 언제 시계를 읽든 그 poll 의 경과 시간은 lo 이상이다
    const from = this.cursor;
    const lo = Date.now() - this.startWall;
    await pollAll.apply(this, args);
    seen.polls.push({ from, to: this.cursor, lo });
  };
  return {
    seen,
    restore: () => {
      P.begin = begin;
      P.pollAll = pollAll;
    },
  };
}

test('replay: events follow the recorded order, the subagent joins when its file starts, gaps scale with --speed', async (t) => {
  const watch = watchReplay();
  t.after(watch.restore); // 이 파일의 다음 테스트(--loop 의 두 번째 begin 등)와 아직 도는 이 앱은 원래 메서드로
  const fx = await fixture();
  const plan = await plannedTimeline(fx);
  const { app, got } = await launch(fx.mainPath);
  await app.ready;
  await until(async () => (await getConfig(app.port)).replay.state === 'done', 8000);

  const types = got.map((g) => g.ev.type);
  assert.equal(got[0].ev.type, 'session');
  assert.equal(got[0].ev.sessionId, REPLAY_SID);
  const main = got.filter((g) => g.ev.type === 'session' && g.ev.sessionId === REPLAY_SID).pop().ev;
  assert.equal(main.project, REPLAY_CWD);
  assert.equal(main.title, '지어낸 파서 정리');
  assert.ok(types.includes('prompt') && types.includes('thinking') && types.includes('plan'));

  // 서브에이전트: 부모의 Agent 호출 뒤에 출근하고, 부모가 결과를 받으면 끝난다
  const agentStart = startOf(got, IDS.agent);
  const subSession = find(got, (e) => e.type === 'session' && e.sessionId === REPLAY_AGENT);
  const subEnd = find(got, (e) => e.type === 'session_end' && e.sessionId === REPLAY_AGENT);
  assert.ok(agentStart && subSession && subEnd);
  assert.ok(got.indexOf(agentStart) < got.indexOf(subSession));
  assert.equal(subSession.ev.parentSessionId, REPLAY_SID);
  assert.equal(subSession.ev.project, REPLAY_CWD);
  assert.equal(subEnd.ev.reason, 'done');
  // 재생도 라이브와 같은 session 이벤트: 메인과 서브 모두 agent 가 붙는다
  for (const g of got.filter((x) => x.ev.type === 'session')) assert.equal(g.ev.agent, 'claude-code', JSON.stringify(g.ev));
  assert.ok(startOf(got, IDS.subRead) && got.indexOf(startOf(got, IDS.subRead)) < got.indexOf(subEnd));

  // 기록 간격 19 s (Read 4 s -> 승인 대기 Bash 23 s) / 20배속 = 950 ms. 배속 계산은 시계 없이 시간표로 정확히 본다
  // (픽스처의 시각 차는 모두 100 ms 의 배수라 20 으로 나눠도 정수다)
  const dueRead = dueOf(plan, IDS.read);
  const dueApproved = dueOf(plan, IDS.approved);
  assert.equal(dueApproved - dueRead, 950);
  // 한 시간 비운 그 한 칸만 maxGapMs(300 ms)로 줄어든다 (20배속 그대로면 180 s)
  const back = plan.findIndex((e, i) => i > 0 && e.t - plan[i - 1].t === LONG_GAP_MS);
  assert.ok(back > 0, 'the one-hour gap is in the timeline');
  assert.equal(plan[back].due - plan[back - 1].due, TIMING.maxGapMs);
  // 재생기도 이 시간표 그대로다: 배속이나 상한을 잘못 넘기면 due 가 달라진다
  // (마지막 poll 기록은 done 이 된 poll 바로 뒤 마이크로태스크에 쌓이고, 위의 /config 왕복이 그 뒤라 여기서 다 보인다)
  const { startWall, dues, polls } = watch.seen;
  assert.ok(dues && startWall, 'the replay runner began');
  assert.deepEqual(dues, plan.map((e) => e.due));
  // poll 마다: 그 poll 이 시작할 때 이미 때가 된 줄은 그 poll 에서 모두 나온다 (붙잡아 두었다가 몰아 내지 않는다).
  // 부하는 poll 을 늦출 뿐이고 lo 를 키우는 쪽이라, 이 검사는 시계 상한 없이도 부하로 깨지지 않는다
  assert.ok(polls.length > 0 && polls[0].from === 0 && polls.at(-1).to === dues.length, JSON.stringify(polls.slice(-3)));
  for (const [i, p] of polls.entries()) {
    if (i > 0) assert.equal(p.from, polls[i - 1].to, `poll ${i} starts where the last one stopped`);
    assert.ok(p.to === dues.length || dues[p.to] > p.lo, `poll ${i} at ${p.lo} ms held back a line due at ${dues[p.to]} ms`);
  }
  // 실제 이벤트: 줄은 startWall + due 보다 일찍 나오지 않는다. 부하는 늦출 수만 있어서 이 하한은 부하로 깨지지 않는다
  const readStart = startOf(got, IDS.read);
  const approvedStart = startOf(got, IDS.approved);
  assert.ok(got.indexOf(readStart) < got.indexOf(approvedStart));
  for (const id of [IDS.read, IDS.approved, IDS.rejected, IDS.lint]) {
    const at = startOf(got, id).at - startWall;
    assert.ok(at >= dueOf(plan, id), `${id} released ${at} ms after start, due ${dueOf(plan, id)} ms`);
  }

  // 사람이 권한 창에 답한 호출만 awaitsApproval (재생에서만 결과를 미리 안다)
  assert.equal(startOf(got, IDS.approved).ev.awaitsApproval, true);
  assert.equal(startOf(got, IDS.rejected).ev.awaitsApproval, true);
  for (const id of [IDS.read, IDS.grep, IDS.edit, IDS.lint, IDS.agent, IDS.subRead]) {
    assert.equal(startOf(got, id).ev.awaitsApproval, undefined, id);
  }
  const rejectedEnd = find(got, (e) => e.type === 'tool_end' && e.toolUseId === IDS.rejected);
  assert.equal(rejectedEnd.ev.errorKind, 'denied');

  // 요약만 나간다 (파일 내용, 전체 경로는 없다)
  const wire = JSON.stringify(got.map((g) => ({ ...g.ev, project: undefined })));
  assert.ok(!wire.includes('invented file body') && !wire.includes(`${REPLAY_CWD}/src`));

  const cfg = await getConfig(app.port);
  assert.deepEqual(cfg.replay, { state: 'done', speed: 20, loop: false, round: 1, progress: 1 });
  const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
  assert.equal(health.files, 2);
});

test('replay: the SSE config message carries the replay status for the HUD', async () => {
  const { mainPath } = await fixture();
  const { app } = await launch(mainPath, { speed: 1 });
  await app.ready;
  const client = await sse(app.port);
  try {
    const cfg = (await client.next((fr) => fr.data?.type === 'config', 3000)).data;
    assert.equal(cfg.replay.state, 'playing');
    assert.equal(cfg.replay.speed, 1);
    assert.ok(cfg.replay.progress >= 0 && cfg.replay.progress < 1);
  } finally {
    client.close();
  }
});

test('replay --loop: everyone leaves, then the session starts again from the first record', async () => {
  const { mainPath } = await fixture();
  const { app, got } = await launch(mainPath, { speed: 40, loop: true });
  await app.ready;
  await until(async () => (await getConfig(app.port)).replay.round === 2, 8000);
  await until(() => got.filter((g) => g.ev.type === 'prompt').length >= 3, 4000);
  const mainEnd = got.findIndex((g) => g.ev.type === 'session_end' && g.ev.sessionId === REPLAY_SID);
  assert.ok(mainEnd > 0, 'the main session left at the end of round 1');
  assert.equal(got[mainEnd].ev.reason, 'done');
  const again = got.findIndex((g, i) => i > mainEnd && g.ev.type === 'session' && g.ev.sessionId === REPLAY_SID);
  assert.ok(again > mainEnd, 'round 2 announces the main session again');
  const prompts = got.filter((g, i) => i > again && g.ev.type === 'prompt');
  assert.ok(prompts.length >= 1, 'round 2 replays the prompts (uuid dedupe starts fresh)');
});

test('replay: a missing transcript reports state error and the server keeps serving', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-replay-missing-'));
  tmpDirs.push(dir);
  const logs = [];
  const { app } = await launch(path.join(dir, 'nope.jsonl'), { log: (m) => logs.push(m) });
  await app.ready;
  assert.equal((await getConfig(app.port)).replay.state, 'error');
  assert.ok(logs.some((m) => m.includes('ENOENT')));
  assert.ok(logs.every((m) => !m.includes(dir)), 'logs carry no path');
  assert.equal((await request(app.port, { path: '/healthz' })).status, 200);
});

test('parseArgs: --replay takes a file, --speed a factor, --loop is a switch; --speed/--loop need --replay', () => {
  const a = parseArgs(['--replay', 'x/session.jsonl', '--speed', '4', '--loop']);
  assert.equal(a.replay, 'x/session.jsonl');
  assert.equal(a.speed, 4);
  assert.equal(a.loop, true);
  assert.equal(parseArgs(['--replay=~/s.jsonl']).replay, path.join(os.homedir(), 's.jsonl'));
  assert.throws(() => parseArgs(['--speed', '4']), /need --replay/);
  assert.throws(() => parseArgs(['--loop']), /need --replay/);
  assert.throws(() => parseArgs(['--replay', 'x.jsonl', '--speed', '0']), /--speed must be a number/);
  assert.throws(() => parseArgs(['--replay', 'x.jsonl', '--loop=yes']), /takes no value/);
  assert.throws(() => parseArgs(['--replay']), /needs a value/);
});

test('start: replay options are validated', async () => {
  await assert.rejects(start({ port: 0, replay: 'x.jsonl', speed: 0 }), /speed/);
  await assert.rejects(start({ port: 0, replay: 'x.jsonl', loop: 'yes' }), /loop/);
});
