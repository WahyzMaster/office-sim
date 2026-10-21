// 기록 관찰 결과 폴더의 보관 규칙 (src/observe/retention.mjs, control.mjs 의 start, 유지보수 PR 3): 새 파일을 만든 뒤
// 이름이 observe-<YYYYMMDD>-<HHMMSS>[-n].jsonl 이고 보통 파일인 것 가운데 가장 새 keep 개만 남긴다 (새 파일 포함).
// 링크, 폴더, 다른 이름, 하위 폴더 안의 것, 지금 쓰는 파일은 그대로다. 시작이 실패하면 아무것도 지우지 않고, 지우다 난
// 오류는 시작을 막지 않는다. 임시 폴더만 쓴다 (저장소의 .observe 는 건드리지 않는다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ObserveControl, fileStamp } from '../src/observe/control.mjs';
import { FILE_RE, fileKey, pruneOutputs } from '../src/observe/retention.mjs';
import { tempDirs, fakeTimers, clock, codexRoot, turns } from './fixtures/observe-ctl.mjs';

const T = tempDirs();
after(() => T.cleanup());

const pad = (n) => String(n).padStart(2, '0');
// 오래된 것부터 25개: 000001..000009, 000010, 000010-2, 000010-10, 000011..000023 (-10 은 -2 보다 새것)
const OLD = [
  ...Array.from({ length: 9 }, (_, i) => `observe-20200101-0000${pad(i + 1)}.jsonl`),
  'observe-20200101-000010.jsonl', 'observe-20200101-000010-2.jsonl', 'observe-20200101-000010-10.jsonl',
  ...Array.from({ length: 13 }, (_, i) => `observe-20200101-0000${pad(i + 11)}.jsonl`),
];
const OTHER_NAMES = [
  'notes.txt', 'observe-bad.jsonl', 'observe-20000101-000002.jsonl.bak', 'observe-20000101-000003.json',
  'observe-20000101-000004-100.jsonl', 'Observe-20000101-000005.jsonl', 'observe-2000101-000006.jsonl',
];

// 출력 폴더: OLD 25개 (이름이 오래될수록 mtime 은 새것: 순서는 mtime 이 아니라 이름) 와 미끼들
async function seed(dir, names = OLD) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [i, name] of names.entries()) {
    const p = path.join(dir, name);
    await fsp.writeFile(p, `${name}\n`);
    const t = new Date(Date.UTC(2025, 0, 1) - i * 60_000);
    await fsp.utimes(p, t, t);
  }
  const outside = await T.tmp('office-sim-observe-target-');
  const target = path.join(outside, 'target.jsonl');
  await fsp.writeFile(target, 'TARGET\n');
  const bait = {
    newLink: 'observe-20991231-235959.jsonl', // 세면 보통 파일이 19개만 남는다
    oldLink: 'observe-20000101-000000.jsonl', // 지우면 링크가 사라진다
    folder: 'observe-20000101-000001.jsonl',
  };
  await fsp.symlink(target, path.join(dir, bait.newLink));
  await fsp.symlink(target, path.join(dir, bait.oldLink));
  await fsp.mkdir(path.join(dir, bait.folder));
  await fsp.writeFile(path.join(dir, bait.folder, 'inside.txt'), 'IN\n');
  for (const name of OTHER_NAMES) await fsp.writeFile(path.join(dir, name), 'OTHER\n');
  await fsp.mkdir(path.join(dir, 'sub'));
  await fsp.writeFile(path.join(dir, 'sub', 'observe-20000101-000007.jsonl'), 'SUB\n');
  return { target, bait };
}

async function assertBaitUntouched(dir, { target, bait }) {
  for (const link of [bait.newLink, bait.oldLink]) {
    assert.ok((await fsp.lstat(path.join(dir, link))).isSymbolicLink(), link);
    assert.equal(await fsp.readlink(path.join(dir, link)), target);
  }
  assert.equal(await fsp.readFile(target, 'utf8'), 'TARGET\n', 'a link target is never touched');
  assert.equal(await fsp.readFile(path.join(dir, bait.folder, 'inside.txt'), 'utf8'), 'IN\n');
  for (const name of OTHER_NAMES) assert.equal(await fsp.readFile(path.join(dir, name), 'utf8'), 'OTHER\n', name);
  assert.equal(await fsp.readFile(path.join(dir, 'sub', 'observe-20000101-000007.jsonl'), 'utf8'), 'SUB\n');
}

// 출력 폴더 바로 안의, 이름이 맞는 보통 파일
async function regularOutputs(dir) {
  const out = [];
  for (const name of await fsp.readdir(dir)) {
    if (FILE_RE.test(name) && (await fsp.lstat(path.join(dir, name))).isFile()) out.push(name);
  }
  return out.sort();
}

async function control(dir, over = {}) {
  const { root } = await codexRoot(T.tmp);
  const now = clock();
  return { now, ctl: new ObserveControl({ roots: { codex: root }, dir, now, timers: fakeTimers(), ...over }) };
}

test('names: only observe-<YYYYMMDD>-<HHMMSS>[-1..99].jsonl count, ordered by the stamp then the suffix', () => {
  for (const ok of ['observe-20261021-153000.jsonl', 'observe-20261021-153000-2.jsonl', 'observe-20261021-153000-99.jsonl']) {
    assert.ok(fileKey(ok), ok);
  }
  for (const bad of [...OTHER_NAMES, 'observe-20261021-153000.jsonl/', 'x/observe-20261021-153000.jsonl', '', null, 7]) {
    assert.equal(fileKey(bad), null, String(bad));
  }
  assert.deepEqual(fileKey('observe-20261021-153000.jsonl'), { stamp: '20261021153000', n: 1 });
  assert.deepEqual(fileKey('observe-20261021-153000-10.jsonl'), { stamp: '20261021153000', n: 10 });
});

test('start keeps the 20 newest observation files, the new one included; links, folders, other names and subfolders stay', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  const seeded = await seed(dir);
  const { ctl, now } = await control(dir);
  const s = await ctl.start();
  assert.equal(s.running, true);
  const current = `observe-${fileStamp(now())}.jsonl`;
  const kept = await regularOutputs(dir);
  assert.equal(kept.length, 20);
  assert.ok(kept.includes(current), 'the new file is kept');
  const deleted = OLD.slice(0, 6); // 000001..000006
  assert.deepEqual(kept, [...OLD.slice(6), current].sort());
  for (const name of deleted) await assert.rejects(fsp.lstat(path.join(dir, name)), { code: 'ENOENT' });
  await assertBaitUntouched(dir, seeded);
  assert.deepEqual(ctl.pruned, { removed: 6, failed: 0 });
  assert.equal(JSON.stringify(ctl.status()).includes(dir), false, 'no path in the status');
  await ctl.stop();
  assert.equal((await regularOutputs(dir)).length, 20, 'a stop deletes nothing');
});

test('the running file is never deleted even when older names sort after it; keep counts it', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  const future = Array.from({ length: 25 }, (_, i) => `observe-20990101-0000${pad(i + 1)}.jsonl`);
  await seed(dir, future);
  const { ctl, now } = await control(dir, { keep: 5 });
  await ctl.start();
  const current = `observe-${fileStamp(now())}.jsonl`;
  assert.deepEqual(await regularOutputs(dir), [...future.slice(-4), current].sort());
  await ctl.stop();
});

test('a failed start deletes nothing', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  const seeded = await seed(dir);
  const fsImpl = Object.assign(Object.create(null), fsp, {
    open: async (p, ...a) => {
      if (path.dirname(String(p)) === dir) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
      return fsp.open(p, ...a);
    },
  });
  const { ctl } = await control(dir, { fsImpl, keep: 1 });
  const err = await ctl.start().then(() => null, (e) => e);
  assert.equal(err?.code, 'EACCES');
  assert.equal(ctl.running, false);
  assert.deepEqual(await regularOutputs(dir), [...OLD].sort());
  await assertBaitUntouched(dir, seeded);
});

test('deletion errors are skipped per file and never break the start; a folder listing error deletes nothing', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  const seeded = await seed(dir);
  const stuck = new Set(['observe-20200101-000002.jsonl', 'observe-20200101-000004.jsonl']);
  const fsImpl = Object.assign(Object.create(null), fsp, {
    unlink: async (p) => {
      if (stuck.has(path.basename(String(p)))) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' });
      return fsp.unlink(p);
    },
  });
  const { ctl, now } = await control(dir, { fsImpl });
  assert.equal((await ctl.start()).running, true);
  const current = `observe-${fileStamp(now())}.jsonl`;
  assert.deepEqual(await regularOutputs(dir), [...OLD.slice(6), ...stuck, current].sort());
  assert.deepEqual(ctl.pruned, { removed: 4, failed: 2 });
  await assertBaitUntouched(dir, seeded);
  await ctl.stop();

  const dir2 = path.join(await T.tmp(), '.observe');
  await seed(dir2);
  const noList = Object.assign(Object.create(null), fsp, {
    readdir: async (p, ...a) => {
      if (String(p) === dir2) throw Object.assign(new Error(`EIO: ${p}`), { code: 'EIO' });
      return fsp.readdir(p, ...a);
    },
  });
  const b = await control(dir2, { fsImpl: noList });
  assert.equal((await b.ctl.start()).running, true);
  assert.equal((await regularOutputs(dir2)).length, 26);
  assert.deepEqual(b.ctl.pruned, { removed: 0, failed: 1 });
  await b.ctl.stop();
});

test('a retention step stuck on a stalled folder is waited for at most stopWaitMs', { timeout: 10_000 }, async () => {
  const dir = path.join(await T.tmp(), '.observe');
  let release;
  let entered;
  const stalled = new Promise((r) => { entered = r; });
  const fsImpl = Object.assign(Object.create(null), fsp, {
    readdir: async (p, ...a) => {
      if (String(p) === dir) {
        entered();
        await new Promise((r) => { release = r; });
      }
      return fsp.readdir(p, ...a);
    },
  });
  const timers = fakeTimers();
  const { ctl } = await control(dir, { fsImpl, timers });
  let done = false;
  const starting = ctl.start().then((s) => { done = true; return s; });
  // 정해진 횟수만큼 돌며 기다리지 않는다 (느린 러너에서는 그 사이 start 의 파일 작업이 끝나지 않는다): 보관 단계가
  // 폴더 목록에 들어온 때를 기다린다. _settle 의 타이머는 그와 같은 동기 흐름에서 걸린다.
  await stalled;
  assert.deepEqual(timers.delays, [1500], 'only the bounded wait: the first tick comes after the retention step');
  assert.equal(done, false);
  await timers.fire(); // 기다림의 끝
  assert.equal((await starting).running, true);
  assert.deepEqual(timers.delays, [0], 'then the first tick');
  release();
  await ctl.stop();
});

test('pruneOutputs never throws and keeps at least the running file', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  await seed(dir);
  const current = OLD[0];
  assert.deepEqual(await pruneOutputs({ dir, current, keep: 1, fsImpl: fsp }), { removed: 24, failed: 0 });
  assert.deepEqual(await regularOutputs(dir), [current], 'the oldest name stays because it is the running one');
  assert.deepEqual(await pruneOutputs({ dir: path.join(dir, 'nope'), current, keep: 1, fsImpl: fsp }), { removed: 0, failed: 1 });
  assert.deepEqual(await pruneOutputs({ dir, current, keep: 1, fsImpl: {} }), { removed: 0, failed: 1 });
});

test('the suffix orders numerically within one second: -10 is newer than -2, which is newer than no suffix', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  const names = ['observe-20200101-000010.jsonl', 'observe-20200101-000010-2.jsonl', 'observe-20200101-000010-10.jsonl'];
  await seed(dir, names);
  const current = 'observe-20200101-000011.jsonl';
  await fsp.writeFile(path.join(dir, current), '{}\n');
  assert.deepEqual(await pruneOutputs({ dir, current, keep: 2, fsImpl: fsp }), { removed: 2, failed: 0 });
  assert.deepEqual(await regularOutputs(dir), ['observe-20200101-000010-10.jsonl', current]);
});

// ---- 리뷰 수정 ----

test('a pass given an aborted signal deletes nothing', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  const seeded = await seed(dir);
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await pruneOutputs({ dir, current: OLD[0], keep: 1, fsImpl: fsp, signal: ac.signal }), { removed: 0, failed: 0 });
  assert.deepEqual(await regularOutputs(dir), [...OLD].sort());
  await assertBaitUntouched(dir, seeded);
});

test('a retention pass that outlives stopWaitMs deletes nothing afterwards: the next observation\'s running file stays', async () => {
  const dir = path.join(await T.tmp(), '.observe');
  let stalls = 1;
  let release = null;
  let released = false;
  const late = [];
  const inDir = (p) => path.dirname(String(p)) === dir;
  const fsImpl = Object.assign(Object.create(null), fsp, {
    // 첫 관찰의 목록 읽기만 멈춘다. 풀린 뒤에 읽으므로 그 목록에는 다음 관찰의 파일이 있다.
    readdir: async (p, ...a) => {
      if (String(p) === dir && stalls > 0) {
        stalls -= 1;
        await new Promise((r) => { release = r; });
      }
      return fsp.readdir(p, ...a);
    },
    lstat: async (p, ...a) => {
      if (released && inDir(p)) late.push(['lstat', path.basename(String(p))]);
      return fsp.lstat(p, ...a);
    },
    unlink: async (p) => {
      if (released && inDir(p)) late.push(['unlink', path.basename(String(p))]);
      return fsp.unlink(p);
    },
  });
  const timers = fakeTimers();
  const { ctl, now } = await control(dir, { fsImpl, timers, keep: 1 });
  const starting = ctl.start();
  for (let i = 0; i < 50 && timers.pending < 1; i++) await turns(1);
  assert.deepEqual(timers.delays, [1500]);
  await timers.fire(); // 첫 관찰의 보관 단계는 기다림을 넘겼다: start() 는 답한다
  assert.equal((await starting).running, true);
  await ctl.stop();
  now.add(1000);
  await ctl.start(); // 둘째 관찰: 제 보관 단계가 첫 파일을 지운다 (keep 1)
  const second = `observe-${fileStamp(now())}.jsonl`;
  assert.deepEqual(await regularOutputs(dir), [second]);
  released = true;
  release();
  for (let i = 0; i < 40 && !late.some(([op]) => op === 'unlink'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(late, [], 'the abandoned pass touches nothing');
  assert.deepEqual(await regularOutputs(dir), [second], 'the running file is never deleted');
  const s = await ctl.stop();
  assert.equal(s.last.file, second);
  assert.ok((await fsp.lstat(path.join(dir, second))).isFile());
});
