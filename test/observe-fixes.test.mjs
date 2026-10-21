// 기록 관찰 리뷰 수정의 회귀 테스트 (src/observe/observer.mjs, records.mjs): 시작한 뒤 링크로 바뀐 상위 폴더를 따라가지
// 않는 것, 시작 훑기 전에 생긴 파일은 0 부터 읽는 것, Grok updates 의 지연은 기록 시각(timestamp)으로 재는 것.
// 지어낸 Grok/Codex 폴더를 임시 폴더에 만들고 rescan()/poll() 을 직접 돌린다. 실제 ~/.grok, ~/.codex 는 읽지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Observer, nearDays } from '../src/observe/observer.mjs';
import { recordMs } from '../src/observe/records.mjs';

const SKIP_LINK = process.platform === 'win32' ? 'folder links need extra rights on Windows' : false;
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-observe-fix-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const upd = (sessionUpdate, ms = Date.now(), ts = Math.floor(ms / 1000)) => ({
  method: 'session/update',
  params: { sessionId: 'x', update: { sessionUpdate }, _meta: { agentTimestampMs: ms } },
  timestamp: ts,
});
const line = (o) => `${JSON.stringify(o)}\n`;

async function grokSession(root, group, id, updates = '') {
  const dir = path.join(root, 'sessions', group, id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'updates.jsonl');
  await fsp.writeFile(file, updates);
  return { dir, file };
}

function observe(roots, opts = {}) {
  const recs = [];
  const ob = new Observer({ roots, startMs: Date.now(), emit: (r) => recs.push(r), ...opts });
  return { ob, recs };
}
const appendsOf = (recs) => recs.filter((r) => r.type === 'append');
const filesOf = (recs, event) => recs.filter((r) => r.type === 'file' && (!event || r.event === event));

// every fsp.open path while fn runs
async function opensDuring(fn) {
  const orig = fsp.open;
  const opened = [];
  fsp.open = function spied(p, ...rest) {
    opened.push(String(p));
    return orig.call(this, p, ...rest);
  };
  try {
    await fn();
  } finally {
    fsp.open = orig;
  }
  return opened;
}

test('Grok: a session folder or a group folder swapped for a link after the start scan is never read through it', { skip: SKIP_LINK }, async () => {
  const root = await tmp();
  const outside = await tmp();
  const a = await grokSession(root, 'g1', '01920000-0000-7000-8000-00000000000a');
  const b = await grokSession(root, 'g2', '01920000-0000-7000-8000-00000000000b');
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  assert.deepEqual(filesOf(recs).map((r) => r.event), ['watch', 'watch']);
  // 바깥에 같은 이름의 파일을 두고, 진짜 폴더는 루트 밖으로 옮긴 뒤 그 이름을 바깥으로 가는 링크로 바꾼다
  const outSession = path.join(outside, 'sess');
  await fsp.mkdir(outSession);
  await fsp.writeFile(path.join(outSession, 'updates.jsonl'), line(upd('outside')).repeat(3));
  await fsp.rename(a.dir, path.join(outside, 'moved-session'));
  await fsp.symlink(outSession, a.dir);
  const outGroup = path.join(outside, 'grp');
  await fsp.mkdir(path.join(outGroup, path.basename(b.dir)), { recursive: true });
  await fsp.writeFile(path.join(outGroup, path.basename(b.dir), 'updates.jsonl'), line(upd('outside')).repeat(3));
  await fsp.rename(path.dirname(b.dir), path.join(outside, 'moved-group'));
  await fsp.symlink(outGroup, path.dirname(b.dir));
  const opened = await opensDuring(async () => {
    await ob.poll();
    await ob.rescan();
    await fsp.appendFile(path.join(outSession, 'updates.jsonl'), line(upd('outside')));
    await ob.poll();
  });
  assert.deepEqual(opened, [], 'nothing is opened through a linked folder');
  assert.deepEqual(appendsOf(recs), []);
  assert.deepEqual(filesOf(recs, 'reset'), []);
  assert.deepEqual(filesOf(recs, 'gone').map((r) => r.file).sort(), ['f1', 'f2']);
});

test('Codex: a day folder swapped for a link after the start scan is never read through it', { skip: SKIP_LINK }, async () => {
  const root = await tmp();
  const outside = await tmp();
  const [y, m, d] = nearDays(Date.now())[0].split('/');
  const day = path.join(root, 'sessions', y, m, d);
  await fsp.mkdir(day, { recursive: true });
  const name = 'rollout-2026-10-20T09-00-00-0199c0de-0000-7000-8000-00000000000c.jsonl';
  const meta = line({ timestamp: new Date().toISOString(), type: 'session_meta', payload: {} });
  await fsp.writeFile(path.join(day, name), meta);
  const { ob, recs } = observe({ codex: root });
  await ob.rescan();
  assert.deepEqual(filesOf(recs).map((r) => [r.kind, r.event]), [['codex-rollout', 'watch']]);
  const outDay = path.join(outside, 'day');
  await fsp.mkdir(outDay);
  await fsp.writeFile(path.join(outDay, name), meta.repeat(4));
  await fsp.rename(day, path.join(outside, 'moved-day'));
  await fsp.symlink(outDay, day);
  const opened = await opensDuring(async () => {
    await ob.poll();
    await ob.rescan();
    await fsp.appendFile(path.join(outDay, name), meta);
    await ob.poll();
  });
  assert.deepEqual(opened, [], 'nothing is opened through a linked folder');
  assert.deepEqual(appendsOf(recs), []);
  assert.deepEqual(filesOf(recs, 'reset'), []);
  assert.deepEqual(filesOf(recs, 'gone').map((r) => r.kind), ['codex-rollout']);
});

test('a file born after the start but before the start scan reaches it is new: read from 0', async (t) => {
  const root = await tmp();
  await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
  const { ob, recs } = observe({ grok: root });
  await sleep(5);
  const first = line(upd('user_message_chunk'));
  const s = await grokSession(root, 'g', '01920000-0000-7000-8000-00000000000d', first);
  if (!((await fsp.lstat(s.file)).birthtimeMs > 0)) return t.skip('no birth time on this file system');
  await ob.rescan();
  assert.deepEqual(filesOf(recs).map((r) => r.event), ['new']);
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.equal(a.bytes, Buffer.byteLength(first));
  assert.deepEqual(a.kinds, { 'method:session/update': 1, 'sessionUpdate:user_message_chunk': 1 });
});

test('without a birth time an old file appended to before the start scan is watched from its size, not reread', async () => {
  const root = await tmp();
  const s = await grokSession(root, 'g', '01920000-0000-7000-8000-00000000000e', line(upd('a')));
  const lstat = async (...a) => Object.assign(await fsp.lstat(...a), { birthtimeMs: 0 });
  const { ob, recs } = observe({ grok: root }, { fsImpl: Object.assign(Object.create(null), fsp, { lstat }) });
  await sleep(5);
  await fsp.appendFile(s.file, line(upd('b')));
  await ob.rescan();
  assert.deepEqual(filesOf(recs).map((r) => r.event), ['watch']);
  await ob.poll();
  assert.deepEqual(appendsOf(recs), []);
});

test('Grok updates lag is measured from the write-time timestamp (agent clock only as a fallback)', async () => {
  const root = await tmp();
  const s = await grokSession(root, 'g', '01920000-0000-7000-8000-00000000000f');
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  const now = Date.now();
  // 권한 창 뒤의 첫 tool_call_update: 에이전트 시계는 18.8초 전, 기록 시각(초)은 지금
  await fsp.appendFile(s.file, line(upd('tool_call_update', now - 18_800, Math.floor(now / 1000))));
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.ok(a.lagMs.min >= 0 && a.lagMs.max < 1500, JSON.stringify(a.lagMs));
  const ms = 1_760_000_000_500;
  const meta = (agentTimestampMs) => ({ params: { _meta: { agentTimestampMs } } });
  assert.equal(recordMs('grok-updates', { timestamp: 1_760_000_000, ...meta(ms - 18_800) }), 1_760_000_000_000);
  assert.equal(recordMs('grok-updates', { timestamp: ms, ...meta(ms - 18_800) }), ms, 'a timestamp in ms is kept as it is');
  assert.equal(recordMs('grok-updates', meta(ms - 300)), ms - 300, 'no timestamp: the agent clock');
  assert.equal(recordMs('grok-updates', { timestamp: 'soon', ...meta(ms) }), ms);
  assert.equal(recordMs('grok-updates', { timestamp: -1, ...meta(42) }), null, 'neither is a time');
});

// Codex 전체 훑기 (codex-walk.mjs, Codex 어댑터의 FULL_WALK_MS 와 같은 30초): 오늘/어제가 아닌 날 폴더의 오래된 스레드를
// 이어 쓰면 다음 전체 훑기에서 찾아 그때 크기부터 본다. 시작 뒤에 다시 풀린(.zst -> .jsonl) 오래된 rollout 도 0 부터
// 읽지 않는다.
const cx = (type = 'response_item', ms = Date.now()) => ({ timestamp: new Date(ms).toISOString(), type, payload: { type: 'message' } });

async function oldCodexDay(root) {
  const day = path.join(root, 'sessions', '2025', '01', '02');
  await fsp.mkdir(day, { recursive: true });
  return day;
}

test('Codex: an old thread in a day folder outside today/yesterday is found by the 30 s full walk, from its size then', async () => {
  const root = await tmp();
  const day = await oldCodexDay(root);
  const file = path.join(day, 'rollout-2025-01-02T10-00-00-old.jsonl');
  await fsp.writeFile(file, line(cx()) + line(cx()));
  const old = new Date(Date.now() - 30 * 86_400_000);
  await fsp.utimes(file, old, old);
  const clock = { t: Date.now() };
  const { ob, recs } = observe({ codex: root }, { startMs: clock.t, now: () => clock.t });
  await ob.rescan();
  assert.equal(filesOf(recs).filter((r) => r.kind === 'codex-rollout').length, 0, 'an old day is not watched at the start');
  await fsp.appendFile(file, line(cx())); // the thread is resumed
  clock.t += 5000;
  await ob.rescan();
  assert.equal(filesOf(recs).filter((r) => r.kind === 'codex-rollout').length, 0, 'no full walk before 30 s');
  clock.t += 30_000;
  await ob.rescan();
  const rolls = filesOf(recs).filter((r) => r.kind === 'codex-rollout');
  assert.deepEqual(rolls.map((r) => r.event), ['watch'], 'found by the full walk, watched from its size (not new)');
  await ob.poll();
  assert.equal(appendsOf(recs).length, 0, 'the bytes written before the walk are not one append');
  await fsp.appendFile(file, line(cx()) + line(cx()));
  await ob.poll();
  assert.deepEqual(appendsOf(recs).map((r) => r.lines), [2]);
  // the day is hot now: later rescans list it without waiting for the next full walk
  const next = path.join(day, 'rollout-2025-01-02T11-00-00-next.jsonl');
  await fsp.writeFile(next, line(cx()));
  clock.t += 2000;
  await ob.rescan();
  assert.ok(filesOf(recs).some((r) => r.kind === 'codex-rollout' && r.event === 'new'), 'a new file in the hot day is new');
});

test('Codex: an old rollout decompressed again after the start is not read from 0 when the full walk finds it', async () => {
  const root = await tmp();
  const day = await oldCodexDay(root);
  const clock = { t: Date.now() };
  const { ob, recs } = observe({ codex: root }, { startMs: clock.t - 1000, now: () => clock.t });
  await ob.rescan();
  const file = path.join(day, 'rollout-2025-01-02T10-00-00-unzipped.jsonl');
  await fsp.writeFile(file, line(cx()) + line(cx()) + line(cx()) + line(cx()) + line(cx())); // born after the start
  clock.t += 31_000;
  await ob.rescan();
  await ob.poll();
  assert.deepEqual(filesOf(recs).filter((r) => r.kind === 'codex-rollout').map((r) => r.event), ['watch']);
  assert.equal(appendsOf(recs).length, 0, 'the old content is not counted as an append');
  await fsp.appendFile(file, line(cx()));
  await ob.poll();
  assert.deepEqual(appendsOf(recs).map((r) => r.lines), [1]);
});
