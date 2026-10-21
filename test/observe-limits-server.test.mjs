// 기록 관찰 상한의 서버 연결 (유지보수 PR 3): 시험 훅 observeLimits { readyGraceMs, maxMs, maxBytes, keep } 이 ObserveControl
// 로 가고 (양수만, keep 은 양의 정수만; 없으면 기본값), 자동 종료는 열린 페이지에 SSE observe 메시지로 바로 알려지며,
// 상태에는 limits, bytes, endsAt, last.reason 이 있고 경로는 없다. 보관 규칙은 서버의 출력 폴더에도 그대로다.
// 임시 루트와 임시 출력 폴더만 쓴다 (저장소의 .observe 와 실제 ~/.codex 는 건드리지 않는다). 포트 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { request, sse } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = {
  port: 0, publicDir: PUBLIC, root: '/nonexistent-office-sim-root', intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
  observeTiming: { intervalMs: 20, rescanMs: 100, notifyMs: 50 },
};
const DEFAULT_LIMITS = { readyGraceMs: 600_000, maxMs: 14_400_000, maxBytes: 52_428_800, keep: 20 };
const JSON_TYPE = { 'content-type': 'application/json' };
const FILE_RE = /^observe-\d{8}-\d{6}(-\d+)?\.jsonl$/;

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function fixture() {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-observe-limsrv-'));
  tmpDirs.push(parent);
  const codexRoot = path.join(parent, 'codex');
  await fsp.mkdir(path.join(codexRoot, 'sessions'), { recursive: true });
  return { parent, codexRoot, obsDir: path.join(parent, 'obs') };
}
const live = (fx, over = {}) => start({ ...FAST, agents: ['codex'], roots: { codex: fx.codexRoot }, observeDir: fx.obsDir, ...over });
const post = async (port, action) => JSON.parse((await request(port, {
  method: 'POST', path: '/observe', headers: JSON_TYPE, body: JSON.stringify({ action }),
})).body);
const statusOf = async (port) => JSON.parse((await request(port, { path: '/observe' })).body);
const isObserve = (pred) => (fr) => fr.data?.type === 'observe' && pred(fr.data);
const summaryOf = async (dir, name) => JSON.parse((await fsp.readFile(path.join(dir, name), 'utf8')).trim().split('\n').at(-1));

test('observeLimits reaches the control: an auto-stop is announced over SSE with its reason; user and close reasons too', async () => {
  const fx = await fixture();
  const app = await live(fx, { observeLimits: { maxMs: 300 } });
  let es = null;
  let closed = false;
  try {
    await app.ready;
    const { port } = app;
    const idle = await statusOf(port);
    assert.deepEqual(idle.limits, { ...DEFAULT_LIMITS, maxMs: 300 });
    assert.deepEqual([idle.bytes, idle.endsAt], [0, null]);
    es = await sse(port);
    const s1 = await post(port, 'start');
    assert.equal(s1.running, true);
    assert.ok(s1.bytes > 0, 'the start record is written');
    assert.equal(Date.parse(s1.endsAt) - Date.parse(s1.startedAt), 300);
    const end = await es.next(isObserve((d) => d.running === false && d.last !== null), 5000);
    const [name] = await fsp.readdir(fx.obsDir);
    assert.match(name, FILE_RE);
    assert.deepEqual([end.data.last.file, end.data.last.reason, end.data.endsAt], [name, 'duration', null]);
    assert.ok(end.data.last.elapsedMs >= 300);
    assert.equal(end.data.last.bytes, (await fsp.stat(path.join(fx.obsDir, name))).size);
    assert.equal((await summaryOf(fx.obsDir, name)).reason, 'duration');
    for (const fr of es.frames.filter(isObserve(() => true))) assert.equal(fr.raw.includes(fx.parent), false, 'no path');

    assert.equal((await post(port, 'start')).running, true);
    const s2 = await post(port, 'stop');
    assert.equal(s2.last.reason, 'user');
    assert.equal((await summaryOf(fx.obsDir, s2.last.file)).reason, 'user');

    const s3 = await post(port, 'start');
    assert.equal(s3.running, true);
    await app.close();
    closed = true;
    const names = (await fsp.readdir(fx.obsDir)).filter((n) => n !== name && n !== s2.last.file);
    assert.equal(names.length, 1);
    assert.equal((await summaryOf(fx.obsDir, names[0])).reason, 'close');
  } finally {
    es?.close();
    if (!closed) await app.close();
  }
});

test('observeLimits: odd values are ignored (defaults stay); keep applies to the server\'s output folder', async () => {
  const fx = await fixture();
  const odd = await live(fx, { observeLimits: { readyGraceMs: NaN, maxMs: -5, maxBytes: '9', keep: 1.5 } });
  try {
    await odd.ready;
    assert.deepEqual((await statusOf(odd.port)).limits, DEFAULT_LIMITS);
  } finally {
    await odd.close();
  }
  const plain = await live(fx);
  try {
    await plain.ready;
    assert.deepEqual((await statusOf(plain.port)).limits, DEFAULT_LIMITS, 'the bin passes no hook');
  } finally {
    await plain.close();
  }

  await fsp.mkdir(fx.obsDir, { recursive: true, mode: 0o700 });
  const old = ['observe-20200101-000001.jsonl', 'observe-20200101-000002.jsonl', 'observe-20200101-000003.jsonl'];
  for (const n of old) await fsp.writeFile(path.join(fx.obsDir, n), '{}\n');
  await fsp.writeFile(path.join(fx.obsDir, 'notes.txt'), 'keep me\n');
  const app = await live(fx, { observeLimits: { keep: 2 } });
  try {
    await app.ready;
    const s = await post(app.port, 'start');
    assert.equal(s.running, true);
    assert.deepEqual(s.limits, { ...DEFAULT_LIMITS, keep: 2 });
    const names = (await fsp.readdir(fx.obsDir)).sort();
    assert.equal(names.length, 3);
    assert.ok(names.includes('notes.txt'));
    assert.ok(names.includes(old[2]), 'the newest old file stays');
    assert.equal(names.filter((n) => FILE_RE.test(n)).length, 2);
    await post(app.port, 'stop');
  } finally {
    await app.close();
  }
});
