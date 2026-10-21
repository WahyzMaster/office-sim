// 기록 관찰의 켜고 끄기 (src/observe/control.mjs): 출력 파일과 권한, 겹치지 않는 루프, 상태 객체, onChange 의 빈도,
// stop/close 의 요약. 타이머와 시계는 바꿔 끼운 가짜로 돌린다. 임시 폴더만 쓴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObserveControl, fileStamp } from '../src/observe/control.mjs';
import { nearDays } from '../src/observe/observer.mjs';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-observe-ctl-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// 가짜 타이머: fire() 가 가장 먼저 걸린 콜백을 부르고 그 약속을 기다린다
function fakeTimers() {
  const q = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) {
      const h = { id: ++id, fn, ms, unref() {} };
      q.set(h.id, h);
      return h;
    },
    clearTimeout(h) {
      if (h) q.delete(h.id);
    },
    get pending() { return q.size; },
    get delays() { return [...q.values()].map((h) => h.ms); },
    async fire() {
      const [h] = q.values();
      if (!h) return false;
      q.delete(h.id);
      await h.fn();
      return true;
    },
  };
}

function clock(start = Date.now()) {
  let ms = start;
  const now = () => ms;
  now.add = (d) => { ms += d; };
  return now;
}

async function codexRoot() {
  const root = await tmp('office-sim-observe-codex-');
  const day = path.join(root, 'sessions', ...nearDays(Date.now())[0].split('/'));
  await fsp.mkdir(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-10-20T09-00-00-0199c0de-0000-7000-8000-000000000001.jsonl');
  await fsp.writeFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: {} })}\n`);
  await fsp.writeFile(path.join(root, 'session_index.jsonl'), '');
  return { root, file };
}
const item = (o) => `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message' } })}\n`;

async function setup(over = {}) {
  const { root, file } = await codexRoot();
  const base = await tmp();
  const dir = path.join(base, '.observe');
  const timers = fakeTimers();
  const now = clock();
  const changes = [];
  const ctl = new ObserveControl({ roots: { codex: root }, dir, now, timers, onChange: (s) => changes.push(s), ...over });
  return { ctl, root, file, dir, timers, now, changes };
}
const readRecords = async (dir, name) => (await fsp.readFile(path.join(dir, name), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('start: folder 0700, file 0600 named by the local stamp, the start record first, status running', async () => {
  const { ctl, dir, timers, now, changes } = await setup();
  await fsp.mkdir(dir, { mode: 0o755 });
  const s = await ctl.start();
  assert.equal(s.running, true);
  assert.equal(s.available, true);
  assert.deepEqual(s.agents, { grok: false, codex: true });
  assert.equal(s.startedAt, new Date(now()).toISOString());
  assert.equal(s.elapsedMs, 0);
  assert.deepEqual(s.totals, { files: 0, appends: 0 });
  assert.deepEqual(s.checklist.map((i) => [i.id, i.off]), [['grok-updates', true], ['grok-wait', true], ['grok-active', true], ['codex-rollout', false]]);
  assert.equal(s.last, null);
  const names = await fsp.readdir(dir);
  assert.deepEqual(names, [`observe-${fileStamp(now())}.jsonl`]);
  assert.match(names[0], /^observe-\d{8}-\d{6}\.jsonl$/);
  assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(path.join(dir, names[0]))).mode & 0o777, 0o600);
  const [rec] = await readRecords(dir, names[0]);
  assert.deepEqual(rec, { type: 'start', v: 1, startedAt: s.startedAt, intervalMs: 100, rescanMs: 2000, platform: process.platform, agents: { grok: false, codex: true } });
  assert.equal(changes.length, 1, 'onChange right away on start');
  assert.deepEqual(timers.delays, [0], 'the first tick is due at once');
  assert.deepEqual(await ctl.start(), ctl.status(), 'start while running is a no-op');
  assert.equal((await fsp.readdir(dir)).length, 1);
  await ctl.stop();
});

test('ticks: rescan when due, poll every tick, records appended as they come, never two ticks at once', async () => {
  const counts = { readdir: 0 };
  let slow = 0;
  const fsImpl = Object.assign(Object.create(null), fsp, {
    readdir: (...a) => { counts.readdir += 1; return fsp.readdir(...a); },
    lstat: async (...a) => { if (slow) await new Promise((r) => setTimeout(r, slow)); return fsp.lstat(...a); },
  });
  const { ctl, file, dir, timers, now } = await setup({ fsImpl });
  await ctl.start();
  await timers.fire(); // rescan + poll
  const afterScan = counts.readdir;
  assert.ok(afterScan > 0);
  assert.deepEqual(timers.delays, [100]);
  await fsp.appendFile(file, item());
  now.add(100);
  await timers.fire(); // poll only
  assert.equal(counts.readdir, afterScan, 'no rescan before rescanMs');
  assert.deepEqual(ctl.status().totals, { files: 2, appends: 1 });
  const name = (await fsp.readdir(dir))[0];
  const recs = await readRecords(dir, name);
  assert.deepEqual(recs.map((r) => r.type), ['start', 'file', 'file', 'append'], 'written before stop');
  now.add(2000);
  slow = 30;
  const running = timers.fire();
  await new Promise((r) => setTimeout(r, 10));
  // 리뷰 수정(PR 3): 다음 tick 은 단계보다 먼저 걸린다 (멈춘 단계가 시간 상한을 붙잡지 않게). 그 tick 은 새 단계를 시작하지 않는다.
  assert.equal(timers.pending, 1, 'the next tick is already set while this step runs');
  const busy = ctl.run.busy;
  await timers.fire();
  assert.equal(ctl.run.busy, busy, 'a tick during a running step does not start a second one');
  assert.equal(timers.pending, 1, 'it only sets the next tick');
  await running;
  assert.ok(counts.readdir > afterScan, 'rescan once rescanMs passed');
  assert.equal(timers.pending, 1);
  slow = 0;
  await ctl.stop();
  assert.equal(timers.pending, 0, 'stop clears the timer');
});

test('onChange: immediate on start and stop, at most once per second while running, only when something changed', async () => {
  const { ctl, file, timers, now, changes } = await setup();
  await ctl.start();
  await timers.fire();
  assert.equal(changes.length, 1, 'the watch records changed the totals, but within a second of the start');
  now.add(1000);
  await timers.fire();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].totals.files, 2);
  now.add(1000);
  await timers.fire();
  assert.equal(changes.length, 2, 'nothing changed (elapsedMs alone does not count)');
  await fsp.appendFile(file, item());
  now.add(100);
  await timers.fire();
  assert.equal(changes.length, 3);
  await fsp.appendFile(file, item());
  now.add(100);
  await timers.fire();
  assert.equal(changes.length, 3, 'throttled');
  now.add(900);
  await timers.fire();
  assert.equal(changes.length, 4);
  assert.equal(changes[3].totals.appends, 2);
  await ctl.stop();
  assert.equal(changes.length, 5);
  assert.equal(changes[4].running, false);
});

test('stop writes the summary last, closes the file and fills status.last; a stop while stopped is a no-op', async () => {
  const { ctl, file, dir, timers, now } = await setup();
  const before = ctl.status();
  assert.deepEqual(await ctl.stop(), before);
  await ctl.start();
  await timers.fire();
  for (let i = 0; i < 20; i++) {
    await fsp.appendFile(file, item());
    now.add(100);
    await timers.fire();
  }
  assert.equal(ctl.status().ready, true, 'codex-rollout reached 20 with grok off');
  now.add(500);
  const s = await ctl.stop();
  assert.deepEqual([s.running, s.startedAt, s.elapsedMs, s.totals], [false, null, 0, { files: 0, appends: 0 }]);
  const name = (await fsp.readdir(dir))[0];
  assert.equal(s.last.file, name);
  assert.equal(s.last.endedAt, new Date(now()).toISOString());
  assert.equal(s.last.elapsedMs, 2500);
  assert.deepEqual(s.last.totals, { files: 2, appends: 20 });
  assert.equal(s.last.ready, true);
  assert.deepEqual(s.last.checklist.find((i) => i.id === 'codex-rollout'), { id: 'codex-rollout', have: 20, need: 20, done: true, off: false });
  const recs = await readRecords(dir, name);
  const summary = recs.at(-1);
  assert.equal(summary.type, 'summary');
  assert.equal(recs.filter((r) => r.type === 'summary').length, 1);
  assert.deepEqual([summary.t, summary.endedAt, summary.ready], [2500, s.last.endedAt, true]);
  assert.equal(summary.kinds['codex-rollout'].appends, 20);
  assert.equal(timers.pending, 0);
  now.add(1000);
  await ctl.start();
  assert.equal((await fsp.readdir(dir)).length, 2, 'a new observation is a new file');
  assert.equal(ctl.status().last.file, name, 'last stays until the next stop');
  await ctl.stop();
});

test('two starts in the same second get distinct names', async () => {
  const { ctl, dir } = await setup();
  await ctl.start();
  await ctl.stop();
  await ctl.start();
  await ctl.stop();
  const names = await fsp.readdir(dir);
  assert.equal(names.length, 2);
  assert.equal(names.filter((n) => /^observe-\d{8}-\d{6}\.jsonl$/.test(n)).length, 1);
  assert.equal(names.filter((n) => /^observe-\d{8}-\d{6}-2\.jsonl$/.test(n)).length, 1);
});

test('close() while running writes the summary; later starts do nothing', async () => {
  const { ctl, file, dir, timers, now } = await setup();
  await ctl.start();
  await timers.fire();
  await fsp.appendFile(file, item());
  now.add(100);
  await timers.fire();
  await ctl.close();
  assert.equal(ctl.running, false);
  const name = (await fsp.readdir(dir))[0];
  const recs = await readRecords(dir, name);
  assert.equal(recs.at(-1).type, 'summary');
  assert.equal(recs.at(-1).totals.appends, 1);
  const s = await ctl.start();
  assert.equal(s.running, false);
  assert.equal((await fsp.readdir(dir)).length, 1);
  await ctl.close();
});

test('no Grok or Codex root: available false, start is a no-op and creates nothing; roots may be a function', async () => {
  const base = await tmp();
  const dir = path.join(base, '.observe');
  let roots = {};
  const ctl = new ObserveControl({ roots: () => roots, dir, timers: fakeTimers() });
  const s = await ctl.start();
  assert.deepEqual([s.available, s.running, s.ready, s.agents], [false, false, false, { grok: false, codex: false }]);
  assert.ok(s.checklist.every((i) => i.off));
  await assert.rejects(fsp.stat(dir), { code: 'ENOENT' });
  const { root } = await codexRoot();
  roots = { codex: root };
  assert.equal(ctl.status().available, true);
  assert.equal((await ctl.start()).running, true);
  await ctl.close();
});

test('an output folder that is a file or a link refuses the start with a code and no path', async () => {
  const { root } = await codexRoot();
  const base = await tmp();
  const asFile = path.join(base, 'file');
  await fsp.writeFile(asFile, 'x');
  const target = await tmp();
  const asLink = path.join(base, 'link');
  await fsp.symlink(target, asLink);
  for (const dir of [asFile, asLink]) {
    const ctl = new ObserveControl({ roots: { codex: root }, dir, timers: fakeTimers() });
    const err = await ctl.start().then(() => null, (e) => e);
    assert.ok(err, dir);
    assert.match(err.code, /^E[A-Z]+$/);
    assert.equal(err.message.includes(base), false, err.message);
    assert.equal(ctl.status().running, false);
  }
  assert.deepEqual(await fsp.readdir(target), []);
});

const settle = () => new Promise((r) => setImmediate(r));

test('stop waits a bounded time for a step stuck on a stalled mount: the summary is written, later steps write nothing', async () => {
  let hang = false;
  let stuck;
  const stalled = new Promise((r) => { stuck = r; });
  let release;
  const fsImpl = Object.assign(Object.create(null), fsp, {
    lstat: async (p, ...a) => {
      if (hang && /^rollout-.*\.jsonl$/.test(path.basename(String(p)))) {
        stuck();
        await new Promise((r) => { release = r; });
      }
      return fsp.lstat(p, ...a);
    },
  });
  const { ctl, file, dir, timers, now } = await setup({ fsImpl });
  await ctl.start();
  await timers.fire();
  await fsp.appendFile(file, item());
  hang = true;
  now.add(100);
  const tick = timers.fire(); // 이 poll 은 rollout 의 lstat 에서 멈춘다
  await stalled;
  const stopping = ctl.stop();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(timers.pending, 1, 'stop waits for the stuck step only up to a time limit');
  await timers.fire();
  const s = await stopping;
  assert.equal(s.running, false);
  const name = (await fsp.readdir(dir))[0];
  assert.equal(s.last.file, name);
  let recs = await readRecords(dir, name);
  assert.equal(recs.at(-1).type, 'summary');
  hang = false;
  release(); // 멈췄던 단계가 늦게 깨어나 덧붙이기를 읽는다
  await tick;
  recs = await readRecords(dir, name);
  assert.equal(recs.at(-1).type, 'summary', 'nothing is written after the summary');
  assert.equal(recs.filter((r) => r.type === 'append').length, 0);
  assert.equal((await ctl.start()).running, true, 'start and stop still answer');
  assert.equal((await ctl.stop()).running, false);
});

test('a failed output write is retried from the first unwritten byte: no record lost, cut or doubled', async () => {
  let fail = null;
  const ENOSPC = () => Object.assign(new Error('no space'), { code: 'ENOSPC' });
  const wrap = (fh) => ({
    chmod: (...a) => fh.chmod(...a),
    close: () => fh.close(),
    // 쓰기가 반쯤 들어간 뒤에 실패한다 (디스크가 찼을 때처럼)
    async write(buf, ...a) {
      if (fail === 'half') {
        fail = 'error';
        return fh.write(buf, 0, Math.floor(buf.length / 2));
      }
      if (fail === 'error') {
        fail = null;
        throw ENOSPC();
      }
      return fh.write(buf, ...a);
    },
    async appendFile(data) {
      if (!fail) return fh.appendFile(data);
      fail = null;
      const b = Buffer.from(data);
      await fh.write(b, 0, Math.floor(b.length / 2));
      throw ENOSPC();
    },
  });
  const fsImpl = Object.assign(Object.create(null), fsp, {
    open: async (p, ...a) => {
      const fh = await fsp.open(p, ...a);
      return path.basename(path.dirname(String(p))) === '.observe' ? wrap(fh) : fh;
    },
  });
  const { ctl, file, dir, timers, now } = await setup({ fsImpl });
  await ctl.start();
  await timers.fire();
  fail = 'half';
  await fsp.appendFile(file, item());
  now.add(100);
  await timers.fire(); // 이 tick 의 쓰기가 반쯤 들어가고 실패한다
  await fsp.appendFile(file, item());
  now.add(100);
  await timers.fire();
  await ctl.stop();
  const text = await fsp.readFile(path.join(dir, (await fsp.readdir(dir))[0]), 'utf8');
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'the file ends with a whole line');
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), l);
  assert.deepEqual(lines.map((l) => JSON.parse(l).type), ['start', 'file', 'file', 'append', 'append', 'summary']);
  assert.equal(JSON.parse(lines.at(-1)).totals.appends, 2);
});
