// 기록 관찰의 파일 감시 (src/observe/observer.mjs, observe-spec "Tests: Core"). 지어낸 Grok/Codex 폴더를 임시 폴더에
// 만들고 Observer 의 rescan()/poll() 을 직접 돌린다 (타이머 없음). 실제 ~/.grok, ~/.codex 는 읽지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { closeSync, constants as FS, openSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Observer, nearDays } from '../src/observe/observer.mjs';

const SKIP_FIFO = process.platform === 'win32' ? 'no mkfifo on Windows' : false;
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-observe-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const SID = '0198f0a0-1b2c-7d3e-8f40-0123456789ab';
const GROUP = encodeURIComponent('/w/repo');
const upd = (sessionUpdate, ms = Date.now()) => ({
  method: 'session/update',
  params: { sessionId: SID, update: { sessionUpdate, content: { type: 'text', text: 'hello' } }, _meta: { agentTimestampMs: ms } },
  timestamp: Math.floor(ms / 1000),
});
const line = (o) => `${JSON.stringify(o)}\n`;

async function grokSession(root, { id = SID, group = GROUP, updates = '', events = null } = {}) {
  const dir = path.join(root, 'sessions', group, id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'updates.jsonl');
  await fsp.writeFile(file, updates);
  if (events !== null) await fsp.writeFile(path.join(dir, 'events.jsonl'), events);
  return { dir, file, events: path.join(dir, 'events.jsonl') };
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

test('a file existing at start starts at its size; whole-line appends are counted with kinds and lag', async () => {
  const root = await tmp();
  const s = await grokSession(root, { updates: line(upd('user_message_chunk')) + line(upd('agent_message_chunk')) });
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  assert.deepEqual(filesOf(recs).map((r) => [r.file, r.session, r.agent, r.kind, r.event]), [['f1', 's1', 'grok', 'grok-updates', 'watch']]);
  await ob.poll();
  assert.equal(appendsOf(recs).length, 0, 'the content before the start is not observed');
  const one = line(upd('tool_call', Date.now() - 40));
  await fsp.appendFile(s.file, one);
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.equal(a.file, 'f1');
  assert.equal(a.bytes, Buffer.byteLength(one));
  assert.equal(a.lines, 1);
  assert.equal(a.partialTail, false);
  assert.equal(a.midLineStart, false);
  assert.equal(a.maxLineBytes, Buffer.byteLength(one) - 1);
  assert.deepEqual(a.kinds, { 'method:session/update': 1, 'sessionUpdate:tool_call': 1 });
  assert.ok(a.lagMs && a.lagMs.min >= 30 && a.lagMs.max === a.lagMs.min, JSON.stringify(a.lagMs));
  assert.equal(a.bad, 0);
  assert.equal(a.oversize, 0);
  assert.equal('perm' in a, false);
});

test('several lines in one append; empty polls write nothing', async () => {
  const root = await tmp();
  const s = await grokSession(root);
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  const text = line(upd('agent_thought_chunk')) + line(upd('agent_thought_chunk')) + line(upd('tool_call_update'));
  await fsp.appendFile(s.file, text);
  await ob.poll();
  const n = recs.length;
  await ob.poll();
  await ob.poll();
  await ob.rescan();
  assert.equal(recs.length, n, 'nothing new');
  const [a] = appendsOf(recs);
  assert.equal(a.lines, 3);
  assert.equal(a.bytes, Buffer.byteLength(text));
  assert.deepEqual(a.kinds, { 'method:session/update': 3, 'sessionUpdate:agent_thought_chunk': 2, 'sessionUpdate:tool_call_update': 1 });
});

test('a line cut across appends: partialTail, then midLineStart; the line is counted (and parsed) once', async () => {
  const root = await tmp();
  const s = await grokSession(root);
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  const whole = line(upd('tool_call'));
  await fsp.appendFile(s.file, whole.slice(0, 30));
  await ob.poll();
  await fsp.appendFile(s.file, whole.slice(30));
  await ob.poll();
  const [a, b] = appendsOf(recs);
  assert.deepEqual([a.lines, a.partialTail, a.midLineStart, a.kinds, a.lagMs], [0, true, false, {}, null]);
  assert.deepEqual([b.lines, b.partialTail, b.midLineStart], [1, false, true]);
  assert.deepEqual(b.kinds, { 'method:session/update': 1, 'sessionUpdate:tool_call': 1 });
  assert.equal(b.maxLineBytes, Buffer.byteLength(whole) - 1);
});

test('a file ending mid-line at start: the rest is a line counted but never parsed', async () => {
  const root = await tmp();
  const whole = line(upd('tool_call'));
  const s = await grokSession(root, { updates: whole.slice(0, 25) });
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  await fsp.appendFile(s.file, whole.slice(25) + line(upd('agent_message_chunk')));
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.equal(a.midLineStart, true);
  assert.equal(a.lines, 2);
  assert.deepEqual(a.kinds, { 'method:session/update': 1, 'sessionUpdate:agent_message_chunk': 1 });
  assert.equal(a.bad, 0);
});

test('a new file starts at 0; Grok updates and events of one session share the session number', async () => {
  const root = await tmp();
  await grokSession(root, { id: '01920000-0000-7000-8000-000000000001', updates: line(upd('agent_message_chunk')) });
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  await new Promise((r) => setTimeout(r, 5));
  const content = line(upd('user_message_chunk')) + line(upd('tool_call'));
  const evs = line({ type: 'turn_started', ts: new Date().toISOString() });
  const s = await grokSession(root, { id: '01920000-0000-7000-8000-000000000002', updates: content, events: evs });
  await ob.rescan();
  const news = filesOf(recs, 'new');
  assert.deepEqual(news.map((r) => [r.session, r.kind]).sort(), [['s2', 'grok-events'], ['s2', 'grok-updates']]);
  await ob.poll();
  const byFile = new Map(appendsOf(recs).map((a) => [a.file, a]));
  const u = byFile.get(news.find((r) => r.kind === 'grok-updates').file);
  assert.equal(u.bytes, Buffer.byteLength(content));
  assert.equal(u.lines, 2);
  const e = byFile.get(news.find((r) => r.kind === 'grok-events').file);
  assert.deepEqual(e.kinds, { 'type:turn_started': 1 });
  assert.ok(s.dir);
});

test('inode change and truncation -> reset, then reading from 0 of the new file', async () => {
  const root = await tmp();
  const s = await grokSession(root, { updates: line(upd('a')) });
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  const swapped = line(upd('b')) + line(upd('c'));
  await fsp.writeFile(`${s.file}.new`, swapped);
  await fsp.rename(`${s.file}.new`, s.file);
  await ob.poll();
  assert.deepEqual(filesOf(recs, 'reset').map((r) => r.file), ['f1']);
  let [a] = appendsOf(recs);
  assert.equal(a.bytes, Buffer.byteLength(swapped));
  assert.equal(a.lines, 2);
  assert.equal(a.midLineStart, false);
  await fsp.truncate(s.file, 0);
  const short = line(upd('d'));
  await fsp.appendFile(s.file, short);
  await ob.poll();
  assert.equal(filesOf(recs, 'reset').length, 2);
  a = appendsOf(recs)[1];
  assert.equal(a.bytes, Buffer.byteLength(short));
  assert.deepEqual(a.kinds, { 'method:session/update': 1, 'sessionUpdate:d': 1 });
});

test('a vanished watched file is gone; an old file sleeps until it changes, then is read from that size', async () => {
  const root = await tmp();
  const old = await grokSession(root, { id: '01920000-0000-7000-8000-000000000003', updates: line(upd('a')) });
  const gone = await grokSession(root, { id: '01920000-0000-7000-8000-000000000004', updates: line(upd('a')) });
  const longAgo = (Date.now() - 20 * 60 * 1000) / 1000;
  await fsp.utimes(old.file, longAgo, longAgo);
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  assert.equal(filesOf(recs, 'watch').length, 1, 'only the recent file');
  await fsp.rm(gone.file);
  await fsp.appendFile(old.file, line(upd('missed')));
  await ob.poll();
  assert.equal(appendsOf(recs).length, 0, 'the old file is not polled while asleep');
  await ob.rescan();
  assert.deepEqual(filesOf(recs).slice(1).map((r) => r.event).sort(), ['gone', 'watch']);
  await fsp.appendFile(old.file, line(upd('seen')));
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.deepEqual(a.kinds, { 'method:session/update': 1, 'sessionUpdate:seen': 1 });
});

test('Grok events: type, phase and decision kinds, permission markers in line order with lag', async () => {
  const root = await tmp();
  const s = await grokSession(root, { events: '' });
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  const ts = (ms) => new Date(ms).toISOString();
  const t0 = Date.now();
  await fsp.appendFile(s.events, [
    line({ type: 'permission_resolved', ts: ts(t0 - 500), decision: 'allow', tool_name: 'grep' }),
    line({ type: 'phase_changed', ts: ts(t0), phase: 'permission_prompt' }),
    line({ type: 'permission_requested', ts: 'not a time', tool_name: 'grep' }),
  ].join(''));
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.deepEqual(a.kinds, {
    'decision:allow': 1, 'phase:permission_prompt': 1, 'type:permission_requested': 1, 'type:permission_resolved': 1, 'type:phase_changed': 1,
  });
  assert.deepEqual(a.perm.map((p) => p.ev), ['res', 'req']);
  assert.ok(a.perm[0].lagMs >= 500);
  assert.equal(a.perm[1].lagMs, null);
});

test('Codex: today and recent day folders are watched, old days are not; the index is counted, never parsed', async () => {
  const root = await tmp();
  const [today] = nearDays(Date.now());
  const day = (key) => path.join(root, 'sessions', ...key.split('/'));
  await fsp.mkdir(day(today), { recursive: true });
  await fsp.mkdir(day('2020/01/02'), { recursive: true });
  await fsp.mkdir(day('2020/01/03'), { recursive: true });
  const name = (n) => `rollout-2026-10-20T09-00-00-0199c0de-0000-7000-8000-00000000000${n}.jsonl`;
  const meta = line({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'x' } });
  const live = path.join(day(today), name(1));
  const resumed = path.join(day('2020/01/02'), name(2));
  const stale = path.join(day('2020/01/03'), name(3));
  for (const f of [live, resumed, stale]) await fsp.writeFile(f, meta);
  const longAgo = (Date.now() - 60 * 60 * 1000) / 1000;
  await fsp.utimes(stale, longAgo, longAgo);
  await fsp.writeFile(path.join(day(today), 'notes.txt'), 'x');
  const index = path.join(root, 'session_index.jsonl');
  await fsp.writeFile(index, '');
  const { ob, recs } = observe({ codex: root });
  await ob.rescan();
  assert.deepEqual(filesOf(recs, 'watch').map((r) => r.kind).sort(), ['codex-index', 'codex-rollout', 'codex-rollout']);
  const item = line({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec' } });
  for (const f of [live, resumed, stale]) await fsp.appendFile(f, item);
  await fsp.appendFile(index, '{"id":"x","thread_name":"t"}\n{"id":"y"}\n');
  await ob.rescan();
  await ob.poll();
  const appends = appendsOf(recs);
  assert.equal(appends.length, 3, 'two rollouts and the index; the stale day is not walked');
  const rolls = appends.filter((a) => a.kinds['type:response_item']);
  assert.equal(rolls.length, 2);
  assert.deepEqual(rolls[0].kinds, { 'payload.type:function_call': 1, 'type:response_item': 1 });
  const ix = appends.find((a) => a.lines === 2);
  assert.deepEqual([ix.kinds, ix.lagMs, ix.bad], [{}, null, 0]);
  const sessions = new Set(filesOf(recs).filter((r) => r.kind === 'codex-rollout').map((r) => r.session));
  assert.equal(sessions.size, 2, 'each rollout is its own session');
  assert.equal(filesOf(recs).find((r) => r.kind === 'codex-index').session, null);
});

test('active_sessions.json: shape, rows and key types only; read again only when it changes', async () => {
  const root = await tmp();
  await fsp.mkdir(path.join(root, 'sessions'), { recursive: true });
  const file = path.join(root, 'active_sessions.json');
  await fsp.writeFile(file, JSON.stringify([{ session_id: SID, pid: 42, cwd: '/w', opened_at: 1, 'bad key': true }]));
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  await ob.rescan();
  let act = recs.filter((r) => r.type === 'active');
  assert.equal(act.length, 1);
  assert.deepEqual(act[0], {
    type: 'active', t: act[0].t, shape: 'array', rows: 1,
    keys: { '?': 'boolean', cwd: 'string', opened_at: 'number', pid: 'number', session_id: 'string' },
  });
  await fsp.writeFile(file, JSON.stringify({ [SID]: { pid: 1, cwd: null }, other: 3 }));
  await ob.rescan();
  act = recs.filter((r) => r.type === 'active');
  assert.deepEqual([act[1].shape, act[1].rows, act[1].keys], ['object', 2, { cwd: 'null', pid: 'number' }]);
  await fsp.writeFile(file, '[{"pid": 1}, {"pid": "x"}');
  await ob.rescan();
  act = recs.filter((r) => r.type === 'active');
  assert.deepEqual([act[2].shape, act[2].rows], ['other', 0]);
});

test('a line over the limit is counted as oversize, never parsed', async () => {
  const root = await tmp();
  const s = await grokSession(root);
  const { ob, recs } = observe({ grok: root }, { maxLine: 64 });
  await ob.rescan();
  await fsp.appendFile(s.file, `{"method":"session/update","x":"${'y'.repeat(100)}"}\n${line({ method: 'session/update' })}`);
  await ob.poll();
  const [a] = appendsOf(recs);
  assert.deepEqual([a.lines, a.oversize, a.bad], [2, 1, 0]);
  assert.deepEqual(a.kinds, { 'method:session/update': 1 });
});

test('an unreadable file gives one error record (code only) until it reads again', { skip: process.getuid?.() === 0 ? 'root reads anything' : false }, async () => {
  const root = await tmp();
  const s = await grokSession(root);
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  await fsp.appendFile(s.file, line(upd('a')));
  await fsp.chmod(s.file, 0o000);
  await ob.poll();
  await ob.poll();
  assert.deepEqual(recs.filter((r) => r.type === 'error').map((r) => [r.kind, r.file, r.code]), [['grok-updates', 'f1', 'EACCES']]);
  await fsp.chmod(s.file, 0o600);
  await ob.poll();
  assert.equal(appendsOf(recs).length, 1);
});

test('links, link folders and FIFOs are never opened and never block', { skip: SKIP_FIFO }, async () => {
  const root = await tmp();
  const outside = await tmp();
  await fsp.writeFile(path.join(outside, 'updates.jsonl'), line(upd('outside')));
  await fsp.mkdir(path.join(outside, 'sess'), { recursive: true });
  await fsp.writeFile(path.join(outside, 'sess', 'updates.jsonl'), line(upd('outside')));
  const linked = path.join(root, 'sessions', GROUP, '01920000-0000-7000-8000-000000000005');
  await fsp.mkdir(linked, { recursive: true });
  await fsp.symlink(path.join(outside, 'updates.jsonl'), path.join(linked, 'updates.jsonl'));
  execFileSync('mkfifo', [path.join(linked, 'events.jsonl')]);
  await fsp.symlink(path.join(outside, 'sess'), path.join(root, 'sessions', GROUP, '01920000-0000-7000-8000-000000000006'));
  await fsp.symlink(outside, path.join(root, 'sessions', 'linked-group'));
  const real = await grokSession(root);
  const { ob, recs } = observe({ grok: root });
  const opened = await opensDuring(async () => {
    await ob.rescan();
    await fsp.appendFile(real.file, line(upd('a')));
    await fsp.appendFile(path.join(outside, 'updates.jsonl'), line(upd('b')));
    await ob.poll();
    await ob.rescan();
  });
  assert.deepEqual(filesOf(recs).map((r) => r.event), ['watch']);
  assert.equal(appendsOf(recs).length, 1);
  assert.ok(opened.every((p) => p === real.file), opened.join('\n'));
});

test('a FIFO renamed over a watched file between its lstat and open is not read and does not block', { skip: SKIP_FIFO }, async () => {
  const root = await tmp();
  const s = await grokSession(root);
  const fifo = path.join(root, 'swap.fifo');
  execFileSync('mkfifo', [fifo]);
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  await fsp.appendFile(s.file, line(upd('a')));
  const orig = fsp.lstat;
  let done = false;
  fsp.lstat = async function raced(q, ...rest) {
    const st = await orig.call(this, q, ...rest);
    if (q === s.file && !done) {
      done = true;
      renameSync(fifo, s.file);
    }
    return st;
  };
  let timer;
  try {
    const blocked = new Promise((resolve) => { timer = setTimeout(() => resolve('blocked'), 1000); });
    assert.notEqual(await Promise.race([ob.poll(), blocked]), 'blocked');
  } finally {
    clearTimeout(timer);
    fsp.lstat = orig;
    try {
      closeSync(openSync(s.file, FS.O_WRONLY | FS.O_NONBLOCK));
    } catch {}
  }
  assert.equal(appendsOf(recs).length, 0);
  await ob.rescan();
  assert.deepEqual(filesOf(recs).map((r) => r.event), ['watch', 'gone']);
});

test('bait files in the roots are never opened', async () => {
  const grok = await tmp();
  const codex = await tmp();
  const s = await grokSession(grok, { events: '' });
  const baits = [
    path.join(grok, 'prompt_history.jsonl'), path.join(grok, 'chat_history.jsonl'), path.join(grok, 'auth.json'),
    path.join(grok, 'session_search.sqlite'), path.join(s.dir, 'summary.json'), path.join(s.dir, 'chat_history.jsonl'),
    path.join(codex, 'history.jsonl'), path.join(codex, 'auth.json'), path.join(codex, 'state.sqlite'),
    path.join(codex, 'sessions', ...nearDays(Date.now())[0].split('/'), 'summary.json'),
  ];
  for (const b of baits) {
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.writeFile(b, '{"BAIT":"BAIT"}\n');
  }
  await fsp.writeFile(path.join(codex, 'session_index.jsonl'), '');
  await fsp.writeFile(path.join(grok, 'active_sessions.json'), '[]');
  const { ob } = observe({ grok, codex });
  const opened = await opensDuring(async () => {
    await ob.rescan();
    for (const b of baits) await fsp.appendFile(b, '{"BAIT":"more"}\n');
    await fsp.appendFile(s.file, line(upd('a')));
    await fsp.appendFile(s.events, line({ type: 'turn_started' }));
    await ob.poll();
    await ob.rescan();
  });
  const allowed = new Set(['updates.jsonl', 'events.jsonl', 'active_sessions.json', 'session_index.jsonl']);
  assert.ok(opened.length > 0);
  for (const p of opened) assert.ok(allowed.has(path.basename(p)), p);
  for (const b of baits) assert.equal(opened.includes(b), false, b);
});

test('within one poll a session updates.jsonl is read before its events.jsonl', async () => {
  const root = await tmp();
  const s = await grokSession(root, { events: '' });
  const { ob, recs } = observe({ grok: root });
  await ob.rescan();
  await fsp.appendFile(s.events, line({ type: 'permission_requested', ts: new Date().toISOString() }));
  await fsp.appendFile(s.file, line(upd('tool_call')));
  await ob.poll();
  const kinds = new Map(filesOf(recs).map((r) => [r.file, r.kind]));
  assert.deepEqual(appendsOf(recs).map((a) => kinds.get(a.file)), ['grok-updates', 'grok-events']);
});
