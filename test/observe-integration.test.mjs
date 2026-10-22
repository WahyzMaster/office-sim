// 기록 관찰의 서버 <-> 페이지 이음매 (observe-spec "Server and HTTP", "Page"). 서버가 보내는 상태(SSE observe 메시지와
// POST /observe 응답)를 페이지의 순수 도우미(readStatus, ObserveModel, observeView, postObserve)가 그대로 받는지,
// 시작 실패 500 이 오류 코드만 들고 패널 문장이 되는지, 실행 파일이 재생 모드에서는 기록 관찰을 켜지 않는지 본다.
// 임시 루트와 지어낸 기록만 쓴다 (실제 ~/.grok, ~/.codex 는 읽지 않는다). 포트 0, 실행 파일은 HOME 을 임시 폴더로 바꾼다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { createGrokBuilder } from './fixtures/grok.mjs';
import { gid, groupOf, writeSession, appendLines } from './fixtures/grok-tree.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { ObserveModel, postObserve, readStatus } from '../public/js/observe-panel.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const REPLAY = fileURLToPath(new URL('./fixtures/replay/7e7e7e7e-1111-4222-8333-444455556666.jsonl', import.meta.url));
const FAST = {
  port: 0, publicDir: PUBLIC, root: '/nonexistent-office-sim-root', intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
  observeTiming: { intervalMs: 20, rescanMs: 100, notifyMs: 50 },
};
const PROJECT = '/work/BAIT_PROJECT_SEAM';
const GROK_ID = gid(81);

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-observe-seam-'));
  tmpDirs.push(d);
  return d;
}

// 페이지의 fetch 자리에 끼우는 작은 어댑터: 같은 출처 요청처럼 Origin 없이 보낸다 (브라우저의 같은 출처 POST 도 통과한다)
const pageFetch = (port) => async (url, init) => {
  const r = await request(port, { method: init.method, path: url, headers: init.headers, body: init.body });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body) };
};

test('the page reads the server status as sent: SSE observe frame, POST start / stop replies, the saved file line', async () => {
  const parent = await tmp();
  const grokRoot = path.join(parent, 'grok');
  const g = createGrokBuilder({ sessionId: GROK_ID, startMs: Date.now() - 5000, stepMs: 20 });
  const updates = await writeSession(grokRoot, {
    group: groupOf(PROJECT), id: GROK_ID, summary: { cwd: PROJECT, title: 'BAIT_TITLE', branch: 'main' },
    items: [g.userMessage({ text: 'BAIT_PROMPT seam' })],
  });
  const app = await start({ ...FAST, agents: ['grok'], roots: { grok: grokRoot }, observeDir: path.join(parent, 'obs') });
  let c = null; // 연결이 실패해도 finally 가 서버를 닫는다 (남은 서버가 테스트 파일을 끝나지 못하게 붙잡는다)
  try {
    c = await sse(app.port);
    const model = new ObserveModel();
    const first = await c.next((fr) => fr.data?.type === 'observe');
    assert.equal(model.apply(first.data), true, 'the connect frame is a status the page accepts');
    let v = model.view();
    assert.equal(v.visible, true);
    assert.equal(v.running, false);
    assert.deepEqual(v.items.map((i) => [i.id, i.off]), [
      ['grok-updates', false], ['grok-wait', false], ['grok-active', false], ['codex-rollout', true],
    ]);
    assert.equal(v.action.kind, 'start');

    assert.equal(await model.send('start', (a) => postObserve(a, pageFetch(app.port))), true);
    assert.equal(model.error, null);
    // SSE 로 온 시작 상태와 POST 응답 중 어느 쪽이 먼저 와도 관찰 중이다
    assert.equal(model.view().running, true);
    // 첫 rescan 이 그 파일을 지금 크기에서 보기 시작한 뒤에 덧붙인다 (start() 는 첫 rescan 을 기다리지 않는다)
    await c.next((fr) => fr.data?.type === 'observe' && fr.data.running && fr.data.totals.files > 0, 5000);
    await appendLines(updates, [g.thought('BAIT_THOUGHT'), g.message('BAIT_SAY')]);
    const progressed = await c.next((fr) => fr.data?.type === 'observe' && fr.data.running && fr.data.totals.appends > 0, 5000);
    model.apply(progressed.data);
    v = model.view();
    assert.match(v.button.text, /^관찰 중 · \d\d:\d\d$/);
    assert.equal(v.items.find((i) => i.id === 'grok-updates').have >= 1, true);
    assert.equal(v.note !== null, true, 'not ready yet: the panel says ending now keeps what was collected');

    assert.equal(await model.send('stop', (a) => postObserve(a, pageFetch(app.port))), true);
    v = model.view();
    assert.equal(v.running, false);
    assert.match(v.last.file, /^observe-\d{8}-\d{6}(-\d+)?\.jsonl$/);
    assert.match(v.last.counts, /^파일 \d+개 · 덧붙음 \d+번 · 체크리스트 0\/3 채움$/);
    assert.match(v.last.claude, /관찰 결과 반영해 줘/);
    const text = JSON.stringify([first.data, progressed.data, v]);
    for (const bad of ['BAIT', parent, GROK_ID, 'updates.jsonl']) assert.ok(!text.includes(bad), bad);
  } finally {
    c?.close();
    await app.close();
  }
});

test('a start that cannot make the output file: the panel shows the error code only', async () => {
  const parent = await tmp();
  const grokRoot = path.join(parent, 'grok');
  await fsp.mkdir(path.join(grokRoot, 'sessions'), { recursive: true });
  const blocker = path.join(parent, 'obs-is-a-file');
  await fsp.writeFile(blocker, 'x');
  const app = await start({ ...FAST, agents: ['grok'], roots: { grok: grokRoot }, observeDir: blocker });
  try {
    const model = new ObserveModel();
    const s = JSON.parse((await request(app.port, { path: '/observe' })).body);
    assert.notEqual(readStatus(s), null);
    assert.equal(model.apply(s), true);
    assert.equal(await model.send('start', (a) => postObserve(a, pageFetch(app.port))), false);
    assert.match(model.error, /^관찰을 시작하지 못했어요\. 결과 파일을 만들지 못했어요 \(E[A-Z0-9_]+\)\. \.observe 폴더를 쓸 수 있는지 확인해 주세요\.$/);
    assert.ok(!model.error.includes(parent));
    assert.equal(model.view().error, model.error);
  } finally {
    await app.close();
  }
});

test('postObserve 500: a code that is not a plain E... code is dropped; a failed stop gets its own line', async () => {
  const reply = (body) => async () => ({ ok: false, status: 500, json: async () => body });
  assert.equal((await postObserve('start', reply({ error: 'x', code: '/secret/path' }))).error,
    '관찰을 시작하지 못했어요. 결과 파일을 만들지 못했어요. .observe 폴더를 쓸 수 있는지 확인해 주세요.');
  assert.equal((await postObserve('start', async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('x'); } }))).error,
    '관찰을 시작하지 못했어요. 결과 파일을 만들지 못했어요. .observe 폴더를 쓸 수 있는지 확인해 주세요.');
  assert.equal((await postObserve('stop', reply({ error: 'observe stop failed', code: 'EIO' }))).error,
    '관찰을 끝내지 못했어요. 서버에서 오류가 났어요 (EIO).');
});

// ---- bin ----------------------------------------------------------------------------------------------------

// node 를 띄우고 서버가 서기까지 (느린 러너나 느린 fs 에서는 몇 초): 넉넉한 상한
const START_MS = 15_000;
// 신호를 받은 실행 파일이 끝나기까지의 상한. 실행 파일의 3초 강제 종료는 이벤트 루프가 멈추면 돌지 않으므로 그것만 믿지 않는다
const EXIT_MS = 10_000;
const LATE = Symbol('late');

// exited 를 EXIT_MS 까지만 기다린다. 넘으면 SIGKILL 하고 실패한다 (남겨 두면 자식과 그 파이프가 테스트 파일을 끝나지 못하게
// 붙잡는다). 타이머는 ref: false: 자식이 먼저 끝나면 남은 타이머가 파일을 붙잡지 않고, 자식이 사는 동안은 그 핸들이 루프를 붙잡는다.
async function exitWithin(child, exited, ms = EXIT_MS) {
  const code = await Promise.race([exited, sleep(ms, LATE, { ref: false })]);
  if (code === LATE) {
    child.kill('SIGKILL');
    throw new Error(`bin did not exit within ${ms} ms of the signal`);
  }
  return code;
}

async function runBin(args) {
  const env = { ...process.env, HOME: await tmp() }; // 기본 루트(~/.grok, ~/.codex, ~/.gemini)가 실제 폴더에 닿지 않게
  const child = spawn(process.execPath, [BIN, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    await until(() => /office-sim: agents /.test(out), START_MS);
  } catch (err) {
    child.kill('SIGKILL'); // 남겨 두면 그 파이프가 테스트 파일을 끝나지 못하게 붙잡는다 (느린 러너에서 멈춤)
    throw err;
  }
  const port = Number(/^office-sim: http:\/\/127\.0\.0\.1:(\d+)\//m.exec(out)[1]);
  return { port, stop: async () => { child.kill('SIGINT'); return exitWithin(child, exited); } };
}

test('bin: live mode turns the observation on (here unavailable: no Grok or Codex root); replay mode leaves it off', async () => {
  const liveRun = await runBin(['--claude-root', await tmp()]);
  try {
    const r = await request(liveRun.port, { path: '/observe' });
    assert.equal(r.status, 200);
    const s = JSON.parse(r.body);
    assert.equal(s.type, 'observe');
    assert.equal(s.available, false);
    assert.equal(s.running, false);
  } finally {
    assert.equal(await liveRun.stop(), 0);
  }
  const replayRun = await runBin(['--replay', REPLAY, '--speed', '50']);
  try {
    assert.equal((await request(replayRun.port, { path: '/observe' })).status, 404);
    const c = await sse(replayRun.port);
    try {
      await c.next((fr) => fr.data?.type === 'config');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(c.frames.some((fr) => fr.data?.type === 'observe'), false);
    } finally {
      c.close();
    }
  } finally {
    assert.equal(await replayRun.stop(), 0);
  }
});

// npm start 의 Ctrl-C 는 신호 두 개다 (터미널이 프로세스 묶음에, npm 이 자식에게 한 번 더, 1~2 ms 사이). 두 번째가 요약을
// 쓰기 전에 끝내 버리지 않는지 본다. 저장소의 .observe 에 쓰지 않도록 실행 파일을 임시 폴더에 복사하고 (src 는 저장소로
// 가는 링크), 관찰의 첫 rescan 이 멈춘 마운트처럼 오래 걸리도록 sessions 폴더의 readdir 을 늦추는 preload 를 끼운다.
// preload 는 관찰(observer.mjs)이 그 늦춘 readdir 에 들어설 때 stderr 에 표시를 남긴다 (Grok 어댑터의 스캔도 같은 폴더를
// 읽으므로 부른 쪽으로 가린다). 테스트는 그 표시를 보고 Ctrl-C 를 보내므로, 두 신호는 늦춘 600 ms 안에 닿는다.
const SLOW_MARK = 'office-sim-test: observer readdir stalled\n';
test('bin: a Ctrl-C that arrives twice (npm start) is one stop: the summary is written and the exit code is 0', {
  skip: process.platform === 'win32' ? 'POSIX signals' : false,
}, async () => {
  const base = await tmp();
  await fsp.mkdir(path.join(base, 'bin'));
  await fsp.copyFile(BIN, path.join(base, 'bin', 'office-sim.mjs'));
  await fsp.symlink(fileURLToPath(new URL('../src', import.meta.url)), path.join(base, 'src'));
  const grokRoot = path.join(base, 'grok');
  const g = createGrokBuilder({ sessionId: GROK_ID, startMs: Date.now() - 5000, stepMs: 20 });
  await writeSession(grokRoot, { group: groupOf(PROJECT), id: GROK_ID, items: [g.userMessage({ text: 'hi' })] });
  const preload = path.join(base, 'slow-readdir.mjs');
  await fsp.writeFile(preload, [
    "import fsp from 'node:fs/promises';",
    `const slow = ${JSON.stringify(path.join(grokRoot, 'sessions'))};`,
    'const readdir = fsp.readdir;',
    'fsp.readdir = async function slowReaddir(p, ...rest) {',
    '  if (String(p) === slow) {',
    `    if (new Error().stack.includes('/observe/observer.mjs')) process.stderr.write(${JSON.stringify(SLOW_MARK)});`,
    '    await new Promise((r) => setTimeout(r, 600));',
    '  }',
    '  return readdir.call(this, p, ...rest);',
    '};',
  ].join('\n'));
  const args = ['--import', pathToFileURL(preload).href, path.join(base, 'bin', 'office-sim.mjs'), '--port', '0', '--agents', 'grok', '--grok-root', grokRoot];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: await tmp() } });
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { err += b; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    await until(() => /office-sim: agents /.test(out), START_MS);
    const port = Number(/^office-sim: http:\/\/127\.0\.0\.1:(\d+)\//m.exec(out)[1]);
    const r = await request(port, { method: 'POST', path: '/observe', headers: { 'content-type': 'application/json' }, body: '{"action":"start"}' });
    assert.equal(JSON.parse(r.body).running, true);
    // 첫 rescan 이 늦춘 readdir 에 들어섰다 (관찰은 위 POST 로 처음 생기므로 그 전의 표시는 없다)
    await until(() => err.includes(SLOW_MARK), 5000, 5);
    child.kill('SIGINT');
    await sleep(2); // npm 이 보내는 두 번째 신호의 간격 (기다림이 아니라 흉내)
    child.kill('SIGINT');
    assert.equal(await exitWithin(child, exited), 0, 'the repeat is the same keystroke, not a second Ctrl-C');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const obs = path.join(base, '.observe');
  const names = await fsp.readdir(obs);
  assert.equal(names.length, 1);
  const recs = (await fsp.readFile(path.join(obs, names[0]), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([recs[0].type, recs.at(-1).type], ['start', 'summary']);
});
