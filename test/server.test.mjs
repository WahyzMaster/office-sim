// 서버 테스트: 임시 루트 + 합성 기록만 쓴다 (실제 ~/.claude 는 건드리지 않는다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { parseArgs } from '../src/cli-args.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PUBLIC = here('../public');
const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const AGENT = 'a1234567890abcdef';
const BASE = { port: 0, intervalMs: 50, rescanMs: 100, activeMinutes: 30, publicDir: PUBLIC };

const tmpDirs = [];
async function tmpRoot() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-'));
  tmpDirs.push(d);
  return d;
}
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

// ---- fakes -------------------------------------------------------------------------------------

class FakeSession {
  constructor({ id, kind, parentId = null, agentType = null }) {
    Object.assign(this, { id, kind, parentId, agentType, seen: new Set(), _title: id.slice(0, 8) });
  }
  apply(rec, { replay = false } = {}) {
    if (rec.uuid) { if (this.seen.has(rec.uuid)) return []; this.seen.add(rec.uuid); }
    const out = [];
    for (const b of rec.type === 'assistant' ? rec.message?.content ?? [] : []) {
      if (b.type === 'text') out.push({ type: 'say', sessionId: this.id, ts: rec.timestamp, text: b.text.slice(0, 100) });
    }
    return replay ? [] : out;
  }
  idle() { return []; }
  sessionEvent() {
    return { type: 'session', sessionId: this.id, ts: new Date().toISOString(), project: '/work/demo', projectLabel: 'demo',
      title: this._title, branch: 'main', worktree: null, isSubagent: this.kind !== 'main', parentSessionId: this.parentId,
      agentType: this.agentType };
  }
  snapshotEvents() { return [this.sessionEvent()]; }
  get title() { return this._title; }
  get firstCwd() { return '/work/demo'; }
  get lastActivityMs() { return 0; }
  get ended() { return false; }
}
class NullTailer { async readAll() { return { offset: 0 }; } async poll() { return { bytes: 0 }; } forget() {} }
const NO_FILES = { SessionState: FakeSession, Tailer: NullTailer, scan: async () => [], readSubMeta: async () => null, readJournalLabels: async () => new Map() };

// ---- http helpers -------------------------------------------------------------------------------

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const postConfig = (port, obj, ctype = 'application/json') => request(port, {
  method: 'POST', path: '/config', headers: { 'content-type': ctype }, body: typeof obj === 'string' ? obj : JSON.stringify(obj),
});

function parseFrame(raw) {
  const fr = { comment: null, id: null, data: null, retry: null };
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) fr.comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) fr.id = line.slice(4);
    else if (line.startsWith('data: ')) fr.data = JSON.parse(line.slice(6));
    else if (line.startsWith('retry: ')) fr.retry = Number(line.slice(7));
  }
  return fr;
}

function sse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers }, (res) => {
      const c = { res, frames: [], cursor: 0, buf: '', waiters: new Set(), close: () => req.destroy() };
      const check = () => { for (const w of [...c.waiters]) w(); };
      c.next = (pred = () => true, ms = 3000) => new Promise((ok, fail) => {
        const timer = setTimeout(() => { c.waiters.delete(w); fail(new Error('timed out waiting for SSE frame')); }, ms);
        const w = () => {
          while (c.cursor < c.frames.length) {
            const fr = c.frames[c.cursor++];
            if (pred(fr)) { clearTimeout(timer); c.waiters.delete(w); ok(fr); return; }
          }
        };
        c.waiters.add(w);
        w();
      });
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        c.buf += chunk;
        let i;
        while ((i = c.buf.indexOf('\n\n')) >= 0) { c.frames.push(parseFrame(c.buf.slice(0, i))); c.buf = c.buf.slice(i + 2); }
        check();
      });
      resolve(c);
    });
    req.on('error', reject);
  });
}
const dataOf = (type) => (fr) => fr.data?.type === type;

async function until(fn, ms = 3000, step = 20) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await sleep(step);
  }
}

// ---- fixtures -----------------------------------------------------------------------------------

const TS = () => new Date().toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const human = (uuid, text) => ({ type: 'user', uuid, promptId: `p-${uuid}`, sessionId: SID, timestamp: TS(), cwd: '/work/demo',
  gitBranch: 'main', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const say = (uuid, text, extra = {}) => ({ type: 'assistant', uuid, sessionId: SID, timestamp: TS(), cwd: '/work/demo', isSidechain: false,
  message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], stop_reason: null }, ...extra });
const agentUse = (uuid, id) => ({ type: 'assistant', uuid, sessionId: SID, timestamp: TS(), cwd: '/work/demo', isSidechain: false,
  message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id, name: 'Agent',
    input: { description: 'Survey the parser', prompt: 'INVENTED PROMPT', subagent_type: 'Explore' } }] } });

async function writeSession(root, { main = [], sub = null, meta = null } = {}) {
  const dir = path.join(root, '-work-demo');
  await fs.mkdir(dir, { recursive: true });
  const mainPath = path.join(dir, `${SID}.jsonl`);
  await fs.writeFile(mainPath, main.map(line).join(''));
  let subPath = null;
  if (sub) {
    const sdir = path.join(dir, SID, 'subagents');
    await fs.mkdir(sdir, { recursive: true });
    subPath = path.join(sdir, `agent-${AGENT}.jsonl`);
    await fs.writeFile(subPath, sub.map(line).join(''));
    if (meta) await fs.writeFile(path.join(sdir, `agent-${AGENT}.meta.json`), JSON.stringify(meta));
  }
  return { dir, mainPath, subPath };
}

// ---- CLI ----------------------------------------------------------------------------------------

test('parseArgs reads every flag, expands ~ and rejects bad values', () => {
  assert.deepEqual(parseArgs(['--port', '0', '--host', '127.0.0.1', '--interval', '300', '--active=5', '--rescan', '500', '--root', '~/p']),
    { port: 0, host: '127.0.0.1', intervalMs: 300, activeMinutes: 5, rescanMs: 500, root: path.join(os.homedir(), 'p') });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  for (const bad of [['--interval', '10'], ['--interval', '99999'], ['--port', 'x'], ['--host', '0.0.0.0'], ['--nope', '1'], ['--port'], ['stray']]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(' '));
  }
});

// ---- HTTP ---------------------------------------------------------------------------------------

test('GET / wraps office.html; /js serves modules and rejects traversal; Host and Origin guards', async () => {
  const app = await start({ ...BASE, root: await tmpRoot(), deps: NO_FILES });
  try {
    const { port } = app;
    const index = await request(port);
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.ok(index.body.startsWith('<!doctype html><html lang="ko"><head><meta charset="utf-8">'));
    assert.ok(index.body.includes('viewport-fit=cover'));
    assert.ok(index.body.includes('<script type="importmap">'));
    assert.ok(index.body.endsWith('</body></html>'));
    assert.equal(index.headers['access-control-allow-origin'], undefined);
    const js = await request(port, { path: '/js/main.js' });
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.ok(js.body.includes('LiveSource'));
    for (const p of ['/js/../package.json', '/js/..%2fpackage.json', '/js/%2e%2e/main.js', '/js/x.css', '/js/Main.js', '/js/nope.js', '/package.json']) {
      const r = await request(port, { path: p });
      assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
    }
    assert.equal((await request(port, { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await request(port, { headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await request(port, { headers: { host: '127.0.0.1' } })).status, 403);
    assert.equal((await request(port, { headers: { host: `localhost:${port}` } })).status, 200);
    assert.equal((await request(port, { headers: { host: `[::1]:${port}` } })).status, 200);
    assert.equal((await request(port, { path: '/state', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(port, { path: '/state', headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.equal((await request(port, { method: 'PUT' })).status, 405);
  } finally {
    await app.close();
  }
});

test('POST /config validates, applies and broadcasts; /state and /healthz answer', async () => {
  const app = await start({ ...BASE, root: await tmpRoot(), deps: NO_FILES });
  try {
    const { port } = app;
    const es = await sse(port);
    await es.next(dataOf('config'));
    assert.equal((await postConfig(port, { intervalMs: 10 })).status, 400);
    assert.equal((await postConfig(port, { intervalMs: 99999 })).status, 400);
    assert.equal((await postConfig(port, { intervalMs: '500' })).status, 400);
    assert.equal((await postConfig(port, '{nope')).status, 400);
    assert.equal((await postConfig(port, { intervalMs: 500 }, 'text/plain')).status, 415);
    const ok = await postConfig(port, { intervalMs: 500 });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { type: 'config', intervalMs: 500, activeMinutes: 30 });
    const fr = await es.next(dataOf('config'));
    assert.deepEqual(fr.data, { type: 'config', intervalMs: 500, activeMinutes: 30 });
    assert.ok(fr.id !== null);
    assert.equal(JSON.parse((await request(port, { path: '/config' })).body).intervalMs, 500);
    const state = JSON.parse((await request(port, { path: '/state' })).body);
    assert.equal(state.type, 'snapshot');
    assert.ok(Array.isArray(state.events));
    const health = JSON.parse((await request(port, { path: '/healthz' })).body);
    assert.deepEqual(health, { ok: true, files: 0, sessions: 0, clients: 1, agents: ['claude-code'] });
    es.close();
  } finally {
    await app.close();
  }
});

test('SSE: retry, snapshot first, id lines, Last-Event-ID resume, ping, cleanup', async () => {
  const app = await start({ ...BASE, root: await tmpRoot(), deps: NO_FILES, pingMs: 60 });
  try {
    const { port, store } = app;
    const ref = { path: path.join(os.tmpdir(), 'nowhere', `${SID}.jsonl`), kind: 'main' };
    store.attachFile(ref, new FakeSession({ id: SID, kind: 'main' }));
    store.announce(ref.path);
    const a = await sse(port);
    const first = await a.next();
    assert.equal(first.retry, 2000);
    const snap = await a.next();
    assert.equal(snap.data.type, 'snapshot');
    assert.equal(snap.id, String(store.seq));
    assert.deepEqual(snap.data.events.map((e) => `${e.type}:${e.sessionId}`), [`session:${SID}`]);
    assert.equal((await a.next()).data.type, 'config');
    const say1 = { type: 'say', sessionId: SID, ts: TS(), text: 'one' };
    store.ingest(ref.path, [say1, { ...say1, text: 'two' }, { ...say1, text: 'three' }]);
    const e1 = await a.next(dataOf('say'));
    assert.equal(e1.id, String(Number(snap.id) + 1));
    assert.equal(e1.data.text, 'one');
    const e2 = await a.next(dataOf('say'));
    await a.next(dataOf('say'));
    assert.ok((await a.next((fr) => fr.comment === 'ping', 1000)).comment === 'ping');
    a.close();
    // 놓친 것만 다시 받는다 (스냅샷 없이)
    const b = await sse(port, { 'last-event-id': e2.id });
    assert.equal((await b.next()).retry, 2000);
    const replay = await b.next();
    assert.equal(replay.data.type, 'say');
    assert.equal(replay.data.text, 'three');
    assert.equal(replay.id, String(Number(e2.id) + 1));
    assert.equal((await b.next()).data.type, 'config');
    b.close();
    // 링 밖이거나 엉뚱한 id 면 스냅샷
    const c = await sse(port, { 'last-event-id': '1' });
    await c.next();
    assert.equal((await c.next()).data.type, 'snapshot');
    await until(async () => JSON.parse((await request(port, { path: '/healthz' })).body).clients === 1);
    c.close();
    await until(async () => JSON.parse((await request(port, { path: '/healthz' })).body).clients === 0);
    assert.equal(store.listeners.size, 0);
  } finally {
    await app.close();
  }
});

test('loops never overlap: a slow scan or poll skips ticks instead of stacking', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const slow = async () => { calls++; active++; maxActive = Math.max(maxActive, active); await sleep(120); active--; };
  let pollActive = 0;
  let pollMax = 0;
  const root = await tmpRoot();
  const ref = { path: path.join(root, 'p', `${SID}.jsonl`), kind: 'main', stem: SID, sessionId: SID };
  class SlowTailer extends NullTailer {
    async poll() { pollActive++; pollMax = Math.max(pollMax, pollActive); await sleep(80); pollActive--; return { bytes: 0 }; }
  }
  const deps = { ...NO_FILES, Tailer: SlowTailer, scan: async () => { await slow(); return [ref]; } };
  const app = await start({ ...BASE, root, deps, rescanMs: 20, intervalMs: 50 });
  try {
    await sleep(500);
    assert.ok(calls >= 2, `scan ran ${calls} times`);
    assert.equal(maxActive, 1);
    assert.equal(pollMax, 1);
  } finally {
    await app.close();
  }
});

// ---- wiring with the real tailer + discover (fake SessionState) ---------------------------------

test('attach, live tail, subagent link, late meta, and idle detach', async () => {
  const root = await tmpRoot();
  const { mainPath, subPath } = await writeSession(root, {
    main: [human('u1', 'Make an invented thing'), agentUse('u2', 'toolu_A1')],
    sub: [{ type: 'user', uuid: 's1', sessionId: SID, agentId: AGENT, isSidechain: true, timestamp: TS(), message: { role: 'user', content: 'INVENTED PROMPT' } }],
  });
  const app = await start({ ...BASE, root, deps: { SessionState: FakeSession } });
  try {
    const { port } = app;
    await app.ready;
    const es = await sse(port);
    const snap = (await es.next(dataOf('snapshot'))).data.events;
    const subEv = snap.find((e) => e.sessionId === AGENT);
    assert.equal(snap[0].sessionId, SID);
    assert.equal(subEv.parentSessionId, SID); // meta 가 아직 없다: 메인으로 폴백
    assert.equal(subEv.title, AGENT);
    assert.equal(subEv.isSubagent, true);
    // 라이브 꼬리 읽기
    await fs.appendFile(mainPath, line(say('u3', 'Invented progress note')));
    const live = await es.next(dataOf('say'));
    assert.equal(live.data.text, 'Invented progress note');
    assert.match(live.id, /^\d+$/);
    // 잘린 줄은 줄바꿈이 올 때까지 기다린다
    const partial = line(say('u4', 'Second invented note'));
    await fs.appendFile(mainPath, partial.slice(0, 20));
    await sleep(150);
    await fs.appendFile(mainPath, partial.slice(20));
    assert.equal((await es.next(dataOf('say'))).data.text, 'Second invented note');
    // meta 가 늦게 생긴다 -> 다음 rescan 에 다시 연결
    await fs.writeFile(subPath.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Survey the parser', toolUseId: 'toolu_A1' }));
    const relinked = await es.next((fr) => fr.data?.type === 'session' && fr.data.sessionId === AGENT);
    assert.equal(relinked.data.title, 'Survey the parser');
    assert.equal(relinked.data.agentType, 'Explore');
    assert.equal(relinked.data.parentSessionId, SID);
    // 활성 창을 벗어난 파일은 떼어 내고 session_end idle
    const old = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(subPath, old, old);
    const end = await es.next(dataOf('session_end'));
    assert.deepEqual([end.data.sessionId, end.data.reason], [AGENT, 'idle']);
    const health = JSON.parse((await request(port, { path: '/healthz' })).body);
    assert.equal(health.files, 1);
    es.close();
  } finally {
    await app.close();
  }
});

test('a parent sync Agent completion ends the subagent', async () => {
  const root = await tmpRoot();
  const meta = { agentType: 'Explore', name: 'scout', toolUseId: 'toolu_A1' };
  const { mainPath } = await writeSession(root, {
    main: [human('u1', 'Invented request'), agentUse('u2', 'toolu_A1')],
    sub: [{ type: 'user', uuid: 's1', sessionId: SID, agentId: AGENT, isSidechain: true, timestamp: TS(), message: { role: 'user', content: 'x' } }],
    meta,
  });
  const app = await start({ ...BASE, root, deps: { SessionState: FakeSession } });
  try {
    await app.ready;
    const es = await sse(app.port);
    const snap = (await es.next(dataOf('snapshot'))).data.events;
    assert.equal(snap.find((e) => e.sessionId === AGENT).title, 'scout');
    await fs.appendFile(mainPath, line({ type: 'user', uuid: 'u5', sessionId: SID, timestamp: TS(), isSidechain: false,
      message: { role: 'user', content: [{ tool_use_id: 'toolu_A1', type: 'tool_result', content: [{ type: 'text', text: 'invented report' }] }] },
      toolUseResult: { status: 'completed', agentId: AGENT, agentType: 'Explore' } }));
    const end = await es.next(dataOf('session_end'));
    assert.deepEqual([end.data.sessionId, end.data.reason], [AGENT, 'done']);
    const state = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.equal(state.events.some((e) => e.sessionId === AGENT), false);
    es.close();
  } finally {
    await app.close();
  }
});

// ---- full stack (real SessionState) -------------------------------------------------------------

test('full stack: real SessionState builds the snapshot and streams live events', async () => {
  const root = await tmpRoot();
  const { mainPath } = await writeSession(root, { main: [human('u1', 'Build the invented widget'), say('u2', 'Starting on it.')] });
  const app = await start({ ...BASE, root });
  try {
    await app.ready;
    const es = await sse(app.port);
    const snap = (await es.next(dataOf('snapshot'))).data.events;
    const session = snap.find((e) => e.type === 'session' && e.sessionId === SID);
    assert.ok(session, 'main session in snapshot');
    assert.equal(session.isSubagent, false);
    assert.equal(session.projectLabel, 'demo');
    await fs.appendFile(mainPath, line(say('u3', 'Invented live remark.')));
    const live = await es.next(dataOf('say'), 4000);
    assert.equal(live.data.sessionId, SID);
    assert.match(live.id, /^\d+$/);
    es.close();
  } finally {
    await app.close();
  }
});

test('full stack: subagent is linked, inherits the floor, and never leaks a prompt', async () => {
  const root = await tmpRoot();
  const subRec = (uuid, extra) => ({ uuid, sessionId: SID, agentId: AGENT, isSidechain: true, timestamp: TS(), cwd: '/work/demo/.worktrees/w1', ...extra });
  const { subPath } = await writeSession(root, {
    main: [human('u1', 'Build the invented widget'), agentUse('u2', 'toolu_A1')],
    sub: [subRec('s1', { type: 'user', message: { role: 'user', content: 'INVENTED PROMPT' } })],
    meta: { agentType: 'Explore', description: 'Survey the parser', toolUseId: 'toolu_A1', spawnDepth: 1 },
  });
  const app = await start({ ...BASE, root });
  try {
    await app.ready;
    const es = await sse(app.port);
    const snap = (await es.next(dataOf('snapshot'))).data.events;
    const main = snap.find((e) => e.type === 'session' && e.sessionId === SID);
    const sub = snap.find((e) => e.type === 'session' && e.sessionId === AGENT);
    assert.ok(main && sub);
    assert.ok(snap.indexOf(main) < snap.indexOf(sub));
    assert.equal(sub.parentSessionId, SID);
    assert.equal(sub.title, 'Survey the parser');
    assert.equal(sub.agentType, 'Explore');
    assert.equal(sub.project, main.project);
    assert.equal(JSON.stringify(snap).includes('INVENTED PROMPT'), false);
    await fs.appendFile(subPath, line(subRec('s2', { type: 'user', message: { role: 'user', content: 'ANOTHER INVENTED PROMPT' } }))
      + line({ ...subRec('s3', {}), type: 'assistant', message: { id: 'msg-s3', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: 'Invented sub remark.' }], stop_reason: null } }));
    const said = await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === AGENT, 4000);
    assert.equal(said.data.text, 'Invented sub remark.');
    const leaked = es.frames.some((fr) => fr.data?.type === 'prompt' || JSON.stringify(fr.data ?? '').includes('INVENTED PROMPT'));
    assert.equal(leaked, false);
    es.close();
  } finally {
    await app.close();
  }
});

test('bin prints the URL and exits cleanly on SIGINT', async () => {
  const root = await tmpRoot();
  // HOME = the temp root: the bin's default roots (~/.grok since P5c) never reach the real folders
  const child = spawn(process.execPath, [here('../bin/office-sim.mjs'), '--port', '0', '--root', root, '--rescan', '200'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const url = await until(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out), 5000);
  const r = await request(Number(url[1]), { path: '/healthz' });
  assert.equal(r.status, 200);
  child.kill('SIGINT');
  const { code } = await exited;
  assert.equal(code, 0);
});
