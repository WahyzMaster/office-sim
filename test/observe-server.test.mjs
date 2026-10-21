// 기록 관찰의 서버 연결 (observe-spec "Server and HTTP"): observeDir 이 없으면 /observe 도 observe 메시지도 없다 (예전 그대로).
// 있으면 GET/POST /observe (/config 와 같은 방어: Host, Sec-Fetch-Site, Origin, JSON 형식, 크기, --auth 쿠키), SSE 의 observe
// 제어 메시지 (연결할 때 config 다음, 시작과 끝, 진행), /state 에는 섞이지 않는다, close() 는 요약을 쓰고 닫는다,
// 출력 파일 0600 / 폴더 0700, 상태와 프레임에는 경로, 파일 이름, 세션 id, 내용이 없다.
// 임시 루트와 지어낸 기록만 쓴다 (실제 ~/.grok, ~/.codex 는 읽지 않는다). 포트 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { createGrokBuilder } from './fixtures/grok.mjs';
import { gid, groupOf, writeSession, appendLines as appendGrok } from './fixtures/grok-tree.mjs';
import { createCodexBuilder, toJsonl as codexJsonl } from './fixtures/codex.mjs';
import { cid, rolloutPath, today, appendLines as appendCodex } from './fixtures/codex-tree.mjs';
import { request, sse, until } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = {
  port: 0, publicDir: PUBLIC, root: '/nonexistent-office-sim-root', intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
  observeTiming: { intervalMs: 20, rescanMs: 100, notifyMs: 50 },
};
const PROJECT = '/work/BAIT_PROJECT_OBSERVE';
const GROK_ID = gid(71);
const CODEX_ID = cid(71);
const FILE_RE = /^observe-\d{8}-\d{6}(-\d+)?\.jsonl$/;
const JSON_TYPE = { 'content-type': 'application/json' };

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-observe-srv-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const exists = (p) => fsp.lstat(p).then(() => true, () => false);

// Grok 세션 하나 (updates.jsonl) 와 Codex 롤아웃 하나. 자유 글자 자리마다 BAIT.
async function fixture() {
  const parent = await tmp();
  const grokRoot = path.join(parent, 'grok');
  const codexRoot = path.join(parent, 'codex');
  const g = createGrokBuilder({ sessionId: GROK_ID, startMs: Date.now() - 5000, stepMs: 20 });
  const updates = await writeSession(grokRoot, {
    group: groupOf(PROJECT), id: GROK_ID, summary: { cwd: PROJECT, title: 'BAIT_TITLE', branch: 'main' },
    items: [g.userMessage({ text: 'BAIT_PROMPT grok' }), g.hook({ event: 'user_prompt_submit' })],
  });
  const cb = createCodexBuilder({ threadId: CODEX_ID, cwd: PROJECT, startMs: Date.now() - 5000, stepMs: 20 });
  const rollout = rolloutPath(codexRoot, today(), CODEX_ID);
  await fsp.mkdir(path.dirname(rollout), { recursive: true });
  await fsp.writeFile(rollout, codexJsonl([cb.sessionMeta(), cb.taskStarted(), cb.userMessage('BAIT_PROMPT codex')]));
  return { parent, grokRoot, codexRoot, g, cb, updates, rollout, obsDir: path.join(parent, 'obs') };
}

const live = (fx, over = {}) => start({
  ...FAST, agents: ['grok', 'codex'], roots: { grok: fx.grokRoot, codex: fx.codexRoot }, observeDir: fx.obsDir, ...over,
});
const postObserve = (port, action, headers = {}, body = JSON.stringify({ action })) => request(port, {
  method: 'POST', path: '/observe', headers: { ...JSON_TYPE, ...headers }, body,
});
const statusOf = async (port, headers = {}) => JSON.parse((await request(port, { path: '/observe', headers })).body);
const isObserve = (pred = () => true) => (fr) => fr.data?.type === 'observe' && pred(fr.data);

// 상태, 프레임, 출력 파일에 없어야 하는 것: 내용(BAIT), 임시 루트 경로, 세션 id, 기록 파일 이름
function assertClean(text, fx, what) {
  for (const bad of ['BAIT', fx.parent, os.tmpdir(), GROK_ID, CODEX_ID, 'updates.jsonl', path.basename(fx.rollout), groupOf(PROJECT)]) {
    assert.ok(!text.includes(bad), `${what}: must not contain ${bad}`);
  }
}

test('without observeDir: no /observe route, no observe SSE frame, /healthz as before', async () => {
  const fx = await fixture();
  const app = await live(fx, { observeDir: undefined });
  let es = null;
  try {
    await app.ready;
    const { port } = app;
    assert.equal((await request(port, { path: '/observe' })).status, 404);
    assert.equal((await request(port, { path: '/observe', method: 'HEAD' })).status, 404);
    assert.equal((await request(port, { path: '/observe', headers: { 'sec-fetch-site': 'cross-site' } })).status, 404, 'not a data route when off');
    assert.equal((await postObserve(port, 'start')).status, 405, 'like any other unknown path');
    es = await sse(port);
    assert.equal((await es.nextData()).data.type, 'snapshot');
    assert.equal((await es.nextData()).data.type, 'config');
    await sleep(300);
    assert.equal(es.frames.filter(isObserve()).length, 0);
    const health = JSON.parse((await request(port, { path: '/healthz' })).body);
    assert.deepEqual(Object.keys(health), ['ok', 'files', 'sessions', 'agents', 'clients']);
    assert.equal(await exists(fx.obsDir), false);
  } finally {
    es?.close();
    await app.close();
  }
});

test('GET status, POST start/stop, file modes, SSE frames on connect/start/progress/stop, /state unchanged, no content', async () => {
  const fx = await fixture();
  const app = await live(fx);
  let es = null;
  const bodies = [];
  try {
    await app.ready;
    const { port } = app;
    const s0 = await statusOf(port);
    bodies.push(JSON.stringify(s0));
    assert.equal(s0.type, 'observe');
    assert.equal(s0.available, true);
    assert.deepEqual(s0.agents, { grok: true, codex: true });
    assert.equal(s0.running, false);
    assert.equal(s0.startedAt, null);
    assert.equal(s0.last, null);
    assert.deepEqual(s0.checklist.map((i) => [i.id, i.have, i.off]),
      [['grok-updates', 0, false], ['grok-wait', 0, false], ['grok-active', 0, false], ['codex-rollout', 0, false]]);
    assert.deepEqual(s0.totals, { files: 0, appends: 0 });
    assert.equal(await exists(fx.obsDir), false, 'nothing is made before a start');

    // 연결: snapshot, config, observe 차례
    es = await sse(port);
    assert.deepEqual([(await es.nextData()).data.type, (await es.nextData()).data.type], ['snapshot', 'config']);
    const first = await es.nextData();
    assert.equal(first.data.type, 'observe');
    assert.equal(first.data.running, false);
    assert.equal(first.id, es.frames.find((fr) => fr.data?.type === 'config').id, 'same id line as config');

    const r1 = await postObserve(port, 'start', { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
    assert.equal(r1.status, 200);
    assert.match(r1.headers['content-type'], /^application\/json/);
    const s1 = JSON.parse(r1.body);
    bodies.push(r1.body);
    assert.equal(s1.type, 'observe');
    assert.equal(s1.running, true);
    assert.match(s1.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok((await es.next(isObserve((d) => d.running === true))).data.startedAt === s1.startedAt);
    // 폴더 0700, 파일 0600, 이름만
    const names = await fsp.readdir(fx.obsDir);
    assert.equal(names.length, 1);
    assert.match(names[0], FILE_RE);
    assert.equal((await fsp.stat(fx.obsDir)).mode & 0o777, 0o700);
    const outFile = path.join(fx.obsDir, names[0]);
    assert.equal((await fsp.stat(outFile)).mode & 0o777, 0o600);
    // 이미 도는 중의 start 는 아무것도 하지 않는다
    const again = JSON.parse((await postObserve(port, 'start')).body);
    assert.equal(again.running, true);
    assert.equal(again.startedAt, s1.startedAt);
    assert.equal((await fsp.readdir(fx.obsDir)).length, 1);

    // 시작 탐색이 두 파일을 본 뒤에 덧붙인다 (그 전의 바이트는 이미 있던 것으로 센다)
    await until(async () => (await statusOf(port)).totals.files >= 2, 5000);
    await appendGrok(fx.updates, [fx.g.message('BAIT_MESSAGE'), fx.g.toolCall({ name: 'read_file', input: { target_file: `${PROJECT}/BAIT.txt` } })]);
    await appendCodex(fx.rollout, [fx.cb.assistantMessage('BAIT_ANSWER')]);
    const progress = await es.next(isObserve((d) => d.running && d.totals.appends >= 2), 5000);
    const byId = Object.fromEntries(progress.data.checklist.map((i) => [i.id, i]));
    assert.ok(byId['grok-updates'].have >= 1);
    assert.ok(byId['codex-rollout'].have >= 1);
    assert.equal(byId['grok-updates'].need, 20);

    const r2 = await postObserve(port, 'stop');
    assert.equal(r2.status, 200);
    bodies.push(r2.body);
    const s2 = JSON.parse(r2.body);
    assert.equal(s2.running, false);
    assert.equal(s2.startedAt, null);
    assert.equal(s2.last.file, names[0], 'the file NAME only');
    assert.ok(!s2.last.file.includes('/'));
    assert.ok(s2.last.totals.appends >= 2);
    assert.match(s2.last.endedAt, /Z$/);
    const stopped = await es.next(isObserve((d) => d.running === false && d.last !== null));
    assert.equal(stopped.data.last.file, names[0]);
    // 멈춘 상태의 stop 은 아무것도 하지 않는다
    const s3 = JSON.parse((await postObserve(port, 'stop')).body);
    assert.equal(s3.running, false);
    assert.equal(s3.last.file, names[0]);

    // 출력 파일: start 로 시작해 summary 로 끝난다, 내용과 경로는 없다
    const text = await fsp.readFile(outFile, 'utf8');
    const recs = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs[0].type, 'start');
    assert.equal(recs.at(-1).type, 'summary');
    assert.ok(recs.some((r) => r.type === 'append'));
    assertClean(text, fx, 'output file');

    // 제어 메시지라 Store 와 링에 없다
    const state = JSON.parse((await request(port, { path: '/state' })).body);
    assert.ok(!state.events.some((e) => e.type === 'observe'));
    assert.ok(!app.store.snapshot().events.some((e) => e.type === 'observe'));
    for (const fr of es.frames.filter(isObserve())) assertClean(fr.raw, fx, 'observe frame');
    for (const b of bodies) assertClean(b, fx, 'response');
  } finally {
    es?.close();
    await app.close();
  }
});

test('/observe guards: cross-site, cross-origin, content type, bad body, size, method; nothing starts', async () => {
  const fx = await fixture();
  const app = await live(fx);
  try {
    await app.ready;
    const { port } = app;
    const host = { host: `127.0.0.1:${port}` };
    assert.equal((await request(port, { path: '/observe', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await postObserve(port, 'start', { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await postObserve(port, 'start', { ...host, origin: `http://localhost:${port}` })).status, 403);
    assert.equal((await postObserve(port, 'start', { ...host, origin: 'null' })).status, 403);
    assert.equal((await postObserve(port, 'start', { host: 'evil.example' })).status, 403, 'Host guard');
    assert.equal((await postObserve(port, 'start', { 'content-type': 'text/plain' })).status, 415);
    const bad = async (body, status = 400) => {
      const r = await postObserve(port, null, {}, body);
      assert.equal(r.status, status, String(body).slice(0, 40));
      return JSON.parse(r.body);
    };
    assert.deepEqual(await bad('{nope'), { error: 'invalid json' });
    assert.deepEqual(await bad(JSON.stringify({ action: 'pause' })), { error: 'action must be "start" or "stop"' });
    await bad(JSON.stringify({}));
    await bad('null');
    await bad(JSON.stringify('start'));
    await bad(JSON.stringify({ action: ['start'] }));
    assert.deepEqual(await bad(JSON.stringify({ action: 'start', pad: 'x'.repeat(5000) }), 413), { error: 'body too large' });
    const put = await request(port, { method: 'PUT', path: '/observe' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.allow, 'GET, HEAD, POST');
    const head = await request(port, { method: 'HEAD', path: '/observe' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await statusOf(port)).running, false);
    assert.equal(await exists(fx.obsDir), false, 'no refused request made the folder');
    // same-site Sec-Fetch-Site is refused, same-origin and none pass
    assert.equal((await postObserve(port, 'start', { 'sec-fetch-site': 'same-origin', ...host, origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await postObserve(port, 'stop', { 'sec-fetch-site': 'none' })).status, 200);
  } finally {
    await app.close();
  }
});

test('--auth: /observe and its SSE frame need the cookie', async () => {
  const fx = await fixture();
  const app = await live(fx, { auth: true });
  let es = null;
  try {
    await app.ready;
    const { port, token } = app;
    const good = { cookie: `osim_${port}=${token}` };
    assert.equal((await request(port, { path: '/observe' })).status, 401);
    assert.equal((await postObserve(port, 'start')).status, 401);
    assert.equal((await postObserve(port, 'start', { cookie: `osim_${port}=${token}x` })).status, 401);
    assert.equal(await exists(fx.obsDir), false);
    assert.equal((await request(port, { path: '/observe', headers: good })).status, 200);
    es = await sse(port, good);
    assert.deepEqual([(await es.nextData()).data.type, (await es.nextData()).data.type, (await es.nextData()).data.type],
      ['snapshot', 'config', 'observe']);
    const r = await postObserve(port, 'start', good);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).running, true);
    await es.next(isObserve((d) => d.running));
    assert.equal(JSON.parse((await postObserve(port, 'stop', good)).body).running, false);
  } finally {
    es?.close();
    await app.close();
  }
});

test('close() while running writes the summary and tells open pages the observation ended', async () => {
  const fx = await fixture();
  const app = await live(fx);
  let es = null;
  let closed = false;
  try {
    await app.ready;
    const { port } = app;
    es = await sse(port);
    assert.equal(JSON.parse((await postObserve(port, 'start')).body).running, true);
    await until(async () => (await statusOf(port)).totals.files >= 2, 5000);
    await appendGrok(fx.updates, [fx.g.message('BAIT_LATE')]);
    await until(async () => (await statusOf(port)).totals.appends >= 1, 5000);
    const [name] = await fsp.readdir(fx.obsDir);
    await app.close();
    closed = true;
    const end = await es.next(isObserve((d) => d.running === false && d.last?.file === name), 2000);
    assert.ok(end.data.last.totals.appends >= 1);
    const text = await fsp.readFile(path.join(fx.obsDir, name), 'utf8');
    const recs = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs[0].type, 'start');
    const summary = recs.at(-1);
    assert.equal(summary.type, 'summary');
    assert.equal(summary.checklist.length, 4);
    assert.equal(recs.filter((r) => r.type === 'summary').length, 1);
    assertClean(text, fx, 'output file');
  } finally {
    es?.close();
    if (!closed) await app.close();
  }
});

test('a start that cannot make the output answers 500 with the error code only', async () => {
  const fx = await fixture();
  await fsp.writeFile(fx.obsDir, 'not a folder');
  const app = await live(fx);
  try {
    await app.ready;
    const { port } = app;
    const r = await postObserve(port, 'start');
    assert.equal(r.status, 500);
    const body = JSON.parse(r.body);
    assert.deepEqual(Object.keys(body), ['error', 'code']);
    assert.equal(body.error, 'observe start failed');
    assert.match(body.code, /^E[A-Z0-9_]+$/);
    assertClean(r.body, fx, 'error body');
    assert.equal((await statusOf(port)).running, false);
    assert.equal(await fsp.readFile(fx.obsDir, 'utf8'), 'not a folder');
  } finally {
    await app.close();
  }
});

test('no Grok or Codex root: available false and start is a no-op; a late Grok root is announced to open pages', async () => {
  const parent = await tmp();
  const grokRoot = path.join(parent, 'grok-late');
  const obsDir = path.join(parent, 'obs');
  const app = await start({ ...FAST, agents: ['grok'], roots: { grok: grokRoot }, observeDir: obsDir });
  let es = null;
  try {
    await app.ready;
    const { port } = app;
    const s0 = await statusOf(port);
    assert.equal(s0.available, false);
    assert.deepEqual(s0.agents, { grok: false, codex: false });
    assert.ok(s0.checklist.every((i) => i.off && i.have === 0));
    const r = await postObserve(port, 'start');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).running, false);
    assert.equal(await exists(obsDir), false);
    es = await sse(port);
    await es.next(isObserve((d) => d.available === false));
    await fsp.mkdir(path.join(grokRoot, 'sessions'), { recursive: true });
    const on = await es.next(isObserve((d) => d.available === true), 5000);
    assert.deepEqual(on.data.agents, { grok: true, codex: false });
    assert.equal(on.data.running, false);
    const s1 = await statusOf(port);
    assert.equal(s1.available, true);
    assert.deepEqual(s1.checklist.filter((i) => !i.off).map((i) => i.id), ['grok-updates', 'grok-wait', 'grok-active']);
  } finally {
    es?.close();
    await app.close();
  }
});

test('start() rejects a non-string observeDir', async () => {
  await assert.rejects(start({ ...FAST, observeDir: 42 }), /observeDir must be a folder path/);
  await assert.rejects(start({ ...FAST, observeDir: '' }), /observeDir must be a folder path/);
});
