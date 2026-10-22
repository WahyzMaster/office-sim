// 기록 관찰의 자동 종료 (src/observe/control.mjs, 유지보수 PR 3): 다 모인 뒤 readyGraceMs, 시작 뒤 maxMs, 파일 maxBytes 중
// 먼저 오는 때 stop() 과 똑같이 끝나고 (요약, 닫기, status.last, 바로 알림) 까닭(reason)을 남긴다. 상태의 bytes, endsAt,
// limits. 타이머와 시계는 바꿔 끼운 가짜로 돌리고, 임시 폴더만 쓴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ObserveControl, READY_GRACE_MS, MAX_MS, MAX_BYTES, KEEP_FILES, STOP_REASONS,
} from '../src/observe/control.mjs';
import { Tally, summarize } from '../src/observe/summary.mjs';
import {
  tempDirs, fakeTimers, clock, codexRoot, item, readRecords, turns, outputHooks,
} from './fixtures/observe-ctl.mjs';
import { until } from './fixtures/sse.mjs';

const T = tempDirs();
after(() => T.cleanup());

async function setup(over = {}) {
  const { root, file } = await codexRoot(T.tmp);
  const dir = path.join(await T.tmp(), '.observe');
  const timers = fakeTimers();
  const now = clock();
  const changes = [];
  const ctl = new ObserveControl({ roots: { codex: root }, dir, now, timers, onChange: (s) => changes.push(s), ...over });
  return { ctl, file, dir, timers, now, changes };
}
const iso = (ms) => new Date(ms).toISOString();
const sizeOf = async (dir, name) => (await fsp.stat(path.join(dir, name))).size;

// 20번 덧붙여 codex-rollout 을 채운다 (Grok 은 꺼져 있다). 다 찬 tick 의 시각을 돌려준다.
async function fill({ ctl, file, timers, now }) {
  let readyAt = null;
  for (let i = 0; i < 20; i++) {
    await fsp.appendFile(file, item());
    now.add(100);
    await timers.fire();
    if (readyAt === null && ctl.status().ready) readyAt = now();
  }
  return readyAt;
}

test('limits: the user\'s numbers are the defaults; status always carries them, bytes and endsAt only while running', async () => {
  assert.deepEqual([READY_GRACE_MS, MAX_MS, MAX_BYTES, KEEP_FILES], [10 * 60_000, 4 * 3_600_000, 50 * 1024 * 1024, 20]);
  assert.deepEqual(STOP_REASONS, ['user', 'ready', 'duration', 'bytes', 'close']);
  const { ctl, dir, timers, now } = await setup();
  const idle = ctl.status();
  assert.deepEqual(idle.limits, { readyGraceMs: 600_000, maxMs: 14_400_000, maxBytes: 52_428_800, keep: 20 });
  assert.deepEqual([idle.bytes, idle.endsAt], [0, null]);
  const s = await ctl.start();
  const [name] = await fsp.readdir(dir);
  assert.equal(s.bytes, await sizeOf(dir, name), 'the start record');
  assert.equal(s.endsAt, iso(now() + MAX_MS), 'not ready yet: the 4-hour cap');
  assert.deepEqual(s.limits, idle.limits);
  s.limits.maxMs = 1;
  assert.equal(ctl.status().limits.maxMs, MAX_MS, 'a fresh copy each call');
  await timers.fire();
  assert.equal(ctl.status().bytes, await sizeOf(dir, name), 'bytes written so far');
  const end = await ctl.stop();
  assert.deepEqual([end.bytes, end.endsAt], [0, null]);
  assert.equal(end.last.reason, 'user');
  assert.equal(end.last.bytes, await sizeOf(dir, name), 'last.bytes counts the summary too');
  const recs = await readRecords(dir, name);
  assert.equal(recs.at(-1).reason, 'user');
  assert.deepEqual(Object.keys(recs.at(-1)).slice(0, 4), ['type', 't', 'endedAt', 'reason']);
});

test('ready: ends readyGraceMs after the checklist first became ready, not a tick before; endsAt moves to that time', async () => {
  const env = await setup({ readyGraceMs: 1000 });
  const { ctl, dir, timers, now, changes } = env;
  await ctl.start();
  const startMs = now();
  await timers.fire();
  const readyAt = await fill(env);
  assert.ok(readyAt !== null, 'ready');
  assert.equal(ctl.status().endsAt, iso(readyAt + 1000));
  now.add(400);
  await timers.fire();
  now.add(599);
  await timers.fire();
  assert.equal(ctl.running, true, 'not before the grace ends');
  const n = changes.length;
  now.add(1);
  await timers.fire();
  assert.equal(ctl.running, false);
  assert.equal(timers.pending, 0, 'no tick after the auto-stop');
  assert.equal(changes.length, n + 1, 'onChange right away, like a user stop');
  const s = changes.at(-1);
  assert.deepEqual([s.running, s.endsAt, s.last.reason, s.last.ready], [false, null, 'ready', true]);
  assert.equal(s.last.elapsedMs, now() - startMs);
  const recs = await readRecords(dir, s.last.file);
  assert.equal(recs.filter((r) => r.type === 'summary').length, 1);
  assert.deepEqual([recs.at(-1).type, recs.at(-1).reason, recs.at(-1).t], ['summary', 'ready', now() - startMs]);
  assert.equal(s.last.bytes, await sizeOf(dir, s.last.file));
  assert.equal((await ctl.stop()).last.reason, 'ready', 'a later stop is a no-op');
});

test('duration: ends maxMs after the start even when never ready', async () => {
  const { ctl, dir, timers, now, changes } = await setup({ maxMs: 1000 });
  const s0 = await ctl.start();
  assert.equal(s0.endsAt, iso(now() + 1000));
  await timers.fire();
  now.add(999);
  await timers.fire();
  assert.equal(ctl.running, true);
  now.add(1);
  await timers.fire();
  assert.equal(ctl.running, false);
  const s = changes.at(-1);
  assert.deepEqual([s.running, s.last.reason, s.last.ready, s.last.elapsedMs], [false, 'duration', false, 1000]);
  const recs = await readRecords(dir, s.last.file);
  assert.deepEqual([recs.at(-1).type, recs.at(-1).reason, recs.at(-1).t], ['summary', 'duration', 1000]);
  assert.equal(timers.pending, 0);
});

test('ready late: the grace cannot pass the cap, so endsAt stays at start + maxMs and the reason is duration', async () => {
  const env = await setup({ readyGraceMs: 5000, maxMs: 3000 });
  const { ctl, timers, now } = env;
  await ctl.start();
  const startMs = now();
  await timers.fire();
  const readyAt = await fill(env);
  assert.ok(readyAt + 5000 > startMs + 3000);
  assert.equal(ctl.status().endsAt, iso(startMs + 3000));
  now.add(startMs + 3000 - now());
  await timers.fire();
  assert.equal(ctl.status().last.reason, 'duration');
});

test('bytes: the tick whose write reaches maxBytes stops; the summary still goes in after (the file ends a little over)', async () => {
  const MAXB = 1500;
  const { ctl, file, dir, timers, now } = await setup({ maxBytes: MAXB });
  await ctl.start();
  await timers.fire();
  for (let tick = 0; ctl.running; tick++) {
    assert.ok(ctl.status().bytes < MAXB, 'still under the limit while running');
    assert.ok(tick < 50, 'stops');
    await fsp.appendFile(file, item());
    now.add(100);
    await timers.fire();
  }
  const s = ctl.status();
  assert.equal(s.last.reason, 'bytes');
  const text = await fsp.readFile(path.join(dir, s.last.file), 'utf8');
  const lines = text.trim().split('\n');
  const summary = JSON.parse(lines.at(-1));
  assert.deepEqual([summary.type, summary.reason], ['summary', 'bytes']);
  assert.equal(s.last.bytes, Buffer.byteLength(text));
  assert.ok(Buffer.byteLength(text) - Buffer.byteLength(lines.at(-1)) - 1 >= MAXB, 'the records reached the limit');
  assert.ok(s.last.bytes > MAXB);
  assert.equal(timers.pending, 0);
});

test('close() ends with reason close; a stop that came first wins over a limit reached in the same tick', async () => {
  const a = await setup();
  await a.ctl.start();
  await a.timers.fire();
  await a.ctl.close();
  const last = a.ctl.status().last;
  assert.equal(last.reason, 'close');
  assert.equal((await readRecords(a.dir, last.file)).at(-1).reason, 'close');

  const b = await setup({ maxMs: 1000 });
  await b.ctl.start();
  await b.timers.fire();
  b.now.add(1000);
  const tick = b.timers.fire(); // 이 tick 은 상한에 닿았지만, 그 단계가 도는 동안 stop 이 먼저 들어왔다
  const stopped = b.ctl.stop();
  await tick;
  const s = await stopped;
  assert.equal(s.last.reason, 'user');
  const recs = await readRecords(b.dir, s.last.file);
  assert.equal(recs.filter((r) => r.type === 'summary').length, 1);
  assert.equal(recs.at(-1).reason, 'user');
  assert.equal(b.timers.pending, 0);
});

test('limits must be positive numbers (keep a positive integer); absent means the defaults', () => {
  for (const k of ['readyGraceMs', 'maxMs', 'maxBytes', 'keep']) {
    for (const bad of [0, -1, NaN, Infinity, '10', null]) {
      assert.throws(() => new ObserveControl({ dir: '/nonexistent-office-sim-obs', [k]: bad }), RangeError, `${k}=${bad}`);
    }
  }
  assert.throws(() => new ObserveControl({ dir: '/nonexistent-office-sim-obs', keep: 1.5 }), RangeError);
  const ctl = new ObserveControl({ dir: '/nonexistent-office-sim-obs', readyGraceMs: 50, maxMs: 2.5, keep: 1 });
  assert.deepEqual(ctl.status().limits, { readyGraceMs: 50, maxMs: 2.5, maxBytes: MAX_BYTES, keep: 1 });
});

test('summary reason: as given, null when unknown (a summary rebuilt from the records)', () => {
  assert.equal(summarize([]).reason, null);
  assert.equal(summarize([], { reason: 'bytes' }).reason, 'bytes');
  assert.equal(new Tally().summary({ t: 1, endedAt: null, reason: 'close' }).reason, 'close');
});

// ---- 리뷰 수정 ----

test('ready and endsAt always agree: a status taken while the completing tick still writes already counts the grace', async () => {
  let ctl = null;
  const seen = [];
  const fsImpl = outputHooks({
    write: () => {
      const s = ctl?.status();
      if (s?.running && s.ready) seen.push(s);
    },
  });
  const env = await setup({ fsImpl, readyGraceMs: 1000 });
  ctl = env.ctl;
  await ctl.start();
  await env.timers.fire();
  const readyAt = await fill(env);
  assert.ok(readyAt !== null, 'ready');
  assert.ok(seen.length > 0, 'a status was taken during a write after the checklist filled');
  for (const s of seen) assert.equal(s.endsAt, iso(readyAt + 1000), 'once ready, endsAt is the grace (never the 4-hour cap)');
  await ctl.stop();
});

// poll 의 rollout lstat 에서 멈추는 fs (멈춘 마운트). hang.on 을 켜면 그다음 lstat 이 release() 까지 멈춘다.
function stallingLstat() {
  const hang = { on: false, release: null };
  hang.stalled = new Promise((stuck) => {
    hang.fsImpl = Object.assign(Object.create(null), fsp, {
      lstat: async (p, ...a) => {
        if (hang.on && /^rollout-.*\.jsonl$/.test(path.basename(String(p)))) {
          hang.on = false;
          stuck();
          await new Promise((r) => { hang.release = r; });
        }
        return fsp.lstat(p, ...a);
      },
    });
  });
  return hang;
}

// 출력 파일(observe-*.jsonl) 의 핸들을 감싸, close 가 끝난 (성공이든 실패든) 파일 이름을 closed 에 모은다. 끝내기에서 닫기는
// 요약 쓰기 뒤의 마지막 fs 일이라, 그 뒤로 stop 에 남은 것은 약속 콜백뿐이다. 원본 기록 파일은 이름으로 가린다.
function watchClose(base) {
  const closed = new Set();
  const fsImpl = Object.assign(Object.create(null), base, {
    open: async (p, ...a) => {
      const fh = await base.open(p, ...a);
      const name = path.basename(String(p));
      if (!/^observe-.*\.jsonl$/.test(name)) return fh;
      return {
        chmod: (...x) => fh.chmod(...x),
        write: (...x) => fh.write(...x),
        close: () => fh.close().finally(() => closed.add(name)),
      };
    },
  });
  return { fsImpl, closed };
}

test('a step stuck on a stalled mount does not hold the time limits: the next tick still comes and starts the stop', async () => {
  const hang = stallingLstat();
  const out = watchClose(hang.fsImpl);
  const { ctl, file, dir, timers, now } = await setup({ fsImpl: out.fsImpl, maxMs: 1000 });
  await ctl.start();
  const startMs = now();
  const name = ctl.run.file;
  await timers.fire();
  await fsp.appendFile(file, item());
  hang.on = true;
  now.add(100);
  const tick = timers.fire(); // 이 poll 은 rollout 의 lstat 에서 멈춘다
  await hang.stalled;
  now.add(900);
  assert.equal(timers.pending, 1, 'the next tick is due even while the step is stuck');
  const busy = ctl.run.busy;
  await timers.fire(); // 시간 상한에 닿았다: 끝내기를 시작한다 (멈춘 단계는 stopWaitMs 까지만 기다린다)
  assert.equal(ctl.run?.busy, busy, 'that tick did not start a second step');
  await turns();
  assert.deepEqual(timers.delays, [1500], 'only the bounded wait for the stuck step');
  await timers.fire(); // 멈춘 단계를 기다리는 시간의 끝: 요약을 쓰고 출력 파일을 닫는다 (진짜 fs 라 몇 바퀴로 셀 수 없다)
  await until(() => out.closed.has(name));
  await turns(); // 닫기 뒤로 남은 것은 약속 콜백뿐
  assert.equal(ctl.running, false);
  const s = ctl.status();
  assert.deepEqual([s.last.reason, s.last.elapsedMs], ['duration', 1000]);
  assert.equal(timers.pending, 0);
  hang.release();
  await tick;
  const recs = await readRecords(dir, s.last.file);
  assert.deepEqual([recs.at(-1).type, recs.at(-1).reason], ['summary', 'duration'], 'nothing after the summary');
  assert.equal(recs.at(-1).t, now() - startMs);
});

test('a step stuck past the ready grace ends with reason ready at most one tick late (the countdown never sits at 00:00)', async () => {
  const hang = stallingLstat();
  const out = watchClose(hang.fsImpl);
  const env = await setup({ fsImpl: out.fsImpl, readyGraceMs: 1000 });
  const { ctl, file, timers, now } = env;
  await ctl.start();
  const name = ctl.run.file;
  await timers.fire();
  const readyAt = await fill(env);
  await fsp.appendFile(file, item());
  hang.on = true;
  now.add(100);
  const tick = timers.fire();
  await hang.stalled;
  for (let i = 0; i < 8; i++) {
    now.add(100);
    await timers.fire();
    assert.equal(ctl.running, true, 'still within the grace');
  }
  assert.equal(now(), readyAt + 900);
  now.add(100);
  assert.equal(timers.pending, 1, 'the ticks go on while the step is stuck');
  await timers.fire();
  await turns();
  await timers.fire(); // 멈춘 단계를 기다리는 시간의 끝: 요약을 쓰고 출력 파일을 닫는다 (진짜 fs)
  await until(() => out.closed.has(name));
  await turns(); // 닫기 뒤로 남은 것은 약속 콜백뿐
  assert.equal(ctl.status().last?.reason, 'ready');
  hang.release();
  await tick;
});

test('a stalled output write holds stop at most stopWaitMs; a start queued behind it answers; the summary goes in later', async () => {
  let stalledName = null;
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const out = watchClose(outputHooks({ write: (name) => (name === stalledName ? gate : null) }));
  const { ctl, dir, timers, now } = await setup({ fsImpl: out.fsImpl });
  const first = (await ctl.start()) && (await fsp.readdir(dir))[0];
  stalledName = first; // 결과 폴더의 마운트가 멈췄다: 이 파일에 쓰는 것은 release() 까지 돌아오지 않는다
  let stopped = false;
  const stopping = ctl.stop().then((s) => { stopped = true; return s; });
  now.add(1000);
  const starting = ctl.start();
  await turns();
  assert.equal(stopped, false);
  assert.deepEqual(timers.delays, [1500], 'the summary write is waited for only up to a time limit');
  await timers.fire();
  const s = await stopping;
  assert.deepEqual([s.running, s.last.file, s.last.reason], [false, first, 'user']);
  const s2 = await starting;
  assert.equal(s2.running, true, 'a start queued behind the stop still answers');
  await ctl.stop();
  release();
  await until(() => out.closed.has(first)); // 닫기는 늘 요약 쓰기 뒤다: 닫혔으면 요약은 이미 파일에 있다
  const recs = await readRecords(dir, first);
  assert.deepEqual([recs.at(-1).type, recs.at(-1).reason], ['summary', 'user'], 'the summary goes in once the mount answers');
  assert.equal(recs.filter((r) => r.type === 'summary').length, 1);
});
