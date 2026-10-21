// P4: the shell snippets in skills/office/SKILL.md really work. Each fenced bash block is run as written, with only
// its placeholders (<base>, <root>, <port>, <flags>, <out>) and the probe's port replaced. Servers run on port 0 under
// a temp HOME; the stop snippet runs against a fake repo root, so it can never stop a real office-sim.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { until } from './fixtures/sse.mjs';
import { assertHealthShape } from './fixtures/healthz.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKILL = readFileSync(new URL('../skills/office/SKILL.md', import.meta.url), 'utf8');
const unixOnly = { skip: process.platform === 'win32' ? 'the snippets are POSIX shell' : false };
const tmpDirs = [];
const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-skillcmd-'));
  tmpDirs.push(d);
  return d;
}

// fenced ```bash blocks, dedented by their fence's indent
const BLOCKS = [...SKILL.matchAll(/^( *)```bash\n([\s\S]*?)^\1```$/gm)].map(([, indent, code]) =>
  code.split('\n').map((l) => l.slice(indent.length)).join('\n').trim());
function block(marker) {
  const found = BLOCKS.filter((b) => b.includes(marker));
  assert.equal(found.length, 1, `exactly one bash block contains ${marker}`);
  return found[0];
}
function sh(cmd, env = {}) {
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
// async version for servers running in this process (spawnSync would block their event loop)
function shAsync(cmd) {
  return new Promise((resolve, reject) => {
    const c = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err}`))));
  });
}
const fill = (code, values) => Object.entries(values).reduce((c, [k, v]) => c.split(k).join(v), code);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('SKILL.md has the seven bash snippets this file runs', () => {
  assert.equal(BLOCKS.length, 7, BLOCKS.join('\n---\n'));
});

test('root snippet: the realpath of <base> two levels up, or MISSING when there is no bin/office-sim.mjs', unixOnly, async () => {
  const code = block('realpathSync');
  const dir = await tmp();
  const base = path.join(dir, 'skills', 'office'); // like ~/.claude/skills/office: a symlink into the repo
  await fs.mkdir(path.dirname(base), { recursive: true });
  await fs.symlink(path.join(REPO, 'skills', 'office'), base);
  assert.equal(sh(fill(code, { '<base>': base })), await fs.realpath(REPO));
  await fs.mkdir(path.join(dir, 'x', 'y', 'z'), { recursive: true });
  assert.equal(sh(fill(code, { '<base>': path.join(dir, 'x', 'y', 'z') })), 'MISSING');
});

test('probe snippet: 200 office-sim JSON, 401 with --auth, down ECONNREFUSED, and another program as is', unixOnly, async () => {
  const code = block('127.0.0.1:4317/healthz');
  const probe = (port) => shAsync(code.replace('127.0.0.1:4317', `127.0.0.1:${port}`));
  const root = await tmp();
  const open = await start({ port: 0, root, rescanMs: 60_000 });
  const auth = await start({ port: 0, root, rescanMs: 60_000, auth: true });
  const other = http.createServer((req, res) => res.end('hello'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const ok = await probe(open.port);
    assert.match(ok, /^200 \{"ok":true,/);
    const body = JSON.parse(ok.slice(4)); // the whole body fits in the probe's slice: it parses
    assertHealthShape(body); // the old five keys first, then version, commit, counters and runners
    assert.equal(body.commit, null, 'start() without build: commit unknown');
    assert.equal(await probe(auth.port), '401 unauthorized: open the URL printed by office-sim');
    assert.equal(await probe(other.address().port), '200 hello');
  } finally {
    await open.close();
    await auth.close();
    await new Promise((r) => other.close(r));
  }
  assert.equal(await probe(open.port), 'down ECONNREFUSED');
});

test('mktemp, start and wait snippets: a private output file, the URL and agents lines, healthz answers', unixOnly, async () => {
  const home = await tmp();
  const out = sh(block('mktemp'), { TMPDIR: home });
  assert.ok(out.startsWith(home), out);
  assert.equal(statSync(out).mode & 0o777, 0o600, 'only the user can read the token URL');
  const startCmd = fill(block('--port <port> <flags>'), { '<root>': REPO, '<port>': '0', '<flags>': '--auth', '<out>': out });
  // HOME is a temp dir: the default roots (~/.claude/projects, ~/.codex, ~/.grok, ~/.gemini) do not exist there
  const child = spawn('/bin/sh', ['-c', startCmd], { detached: true, stdio: 'ignore', env: { ...process.env, HOME: home } });
  const stopGroup = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  cleanups.push(stopGroup);
  try {
    const lines = sh(fill(block('--input-type=module'), { '<out>': out })).split('\n');
    assert.match(lines[0], /^office-sim: http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
    assert.equal(lines[1], 'office-sim: agents none');
    assert.equal(lines.at(-1), 'healthz 401');
  } finally {
    stopGroup();
  }
  await until(() => !alive(child.pid), 5000);
});

test('wait snippet without a server: gives up after its poll budget and says so (budget cut to 4 polls here)', unixOnly, async () => {
  const out = path.join(await tmp(), 'never.out');
  const code = block('--input-type=module');
  assert.ok(code.includes('i < 40 &&') && code.includes('setTimeout(r, 250)'), '40 polls of 250 ms = 10 s');
  const t0 = Date.now();
  assert.equal(sh(fill(code, { '<out>': out, 'i < 40 &&': 'i < 4 &&' })), 'office-sim: no output after 10 s');
  assert.ok(Date.now() - t0 < 5000);
});

test('stop snippet: SIGTERMs only node <root>/bin/office-sim.mjs, not shells, other args or other roots', unixOnly, async () => {
  const dir = await tmp();
  const fakeBin = (root) => path.join(dir, root, 'bin', 'office-sim.mjs');
  for (const root of ['repo', 'other']) {
    await fs.mkdir(path.dirname(fakeBin(root)), { recursive: true });
    await fs.writeFile(fakeBin(root), "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
  }
  const spawned = [];
  const run = (cmd, args) => {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true }); // own group: cleanup also ends a shell's child
    const exited = new Promise((r) => c.on('exit', (code, signal) => r({ code, signal })));
    spawned.push(c);
    return { c, exited };
  };
  cleanups.push(async () => {
    for (const c of spawned) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  const target = run(process.execPath, [fakeBin('repo'), '--port', '0']);
  const shellWrapper = run('/bin/sh', ['-c', `"${process.execPath}" -e "setInterval(() => {}, 1000)" "${fakeBin('repo')}"; true`]);
  const otherRoot = run(process.execPath, [fakeBin('other'), '--port', '0']);
  await new Promise((r) => setTimeout(r, 300));
  const code = fill(block('"ps"'), { '<root>': path.join(dir, 'repo') });
  assert.equal(sh(code), `stopped pid ${target.c.pid}`);
  assert.deepEqual(await target.exited, { code: 0, signal: null }, 'SIGTERM, handled by the server');
  assert.ok(alive(shellWrapper.c.pid) && alive(otherRoot.c.pid), 'the shell wrapper and the other root keep running');
  assert.equal(sh(code), 'no office-sim from this repo is running');
});

// ---- review fixes (P4 findings 1-4, 6) -----------------------------------------------------------------------

// fake servers under a fake repo root: `node <dir>/<root>/bin/office-sim.mjs <args>` that exit 0 on SIGTERM
async function fakeServers() {
  const dir = await tmp();
  const bin = (root) => path.join(dir, root, 'bin', 'office-sim.mjs');
  for (const root of ['repo', 'other']) {
    await fs.mkdir(path.dirname(bin(root)), { recursive: true });
    await fs.writeFile(bin(root), "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
  }
  const spawned = [];
  cleanups.push(async () => {
    for (const c of spawned) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  const run = (root, args = []) => {
    const c = spawn(process.execPath, [bin(root), ...args], { stdio: 'ignore', detached: true });
    spawned.push(c);
    return { pid: c.pid, exited: new Promise((r) => c.on('exit', (code, signal) => r({ code, signal }))) };
  };
  return { dir, run, stopCode: fill(block('"ps"'), { '<root>': path.join(dir, 'repo') }) };
}
const pidSet = (line, prefix) => new Set(line.slice(prefix.length).split(', ').map(Number));

test('probe snippet prints exactly one line even when the listener closes at once or fetch never settles (finding 3)', unixOnly, async () => {
  const code = block('127.0.0.1:4317/healthz');
  assert.ok(code.includes('setTimeout(()=>{console.log("down Timeout");process.exit(0)},1500)'), 'a ref-ed fallback timer');
  const closer = net.createServer((c) => c.destroy());
  await new Promise((r) => closer.listen(0, '127.0.0.1', r));
  try {
    const out = await shAsync(code.replace('127.0.0.1:4317', `127.0.0.1:${closer.address().port}`));
    assert.match(out, /^down \S+$/, out);
  } finally {
    await new Promise((r) => closer.close(r));
  }
  // a fetch that never settles and holds no handle: without the fallback timer node would exit with no output
  const preload = path.join(await tmp(), 'hang-fetch.cjs');
  await fs.writeFile(preload, 'globalThis.fetch = () => new Promise(() => {});\n');
  const t0 = Date.now();
  assert.equal(sh(code, { NODE_OPTIONS: `--require=${preload}` }), 'down Timeout');
  assert.ok(Date.now() - t0 < 5000);
});

test('wait snippet returns at once when the server fails to start (EADDRINUSE), without a healthz line (finding 4)', unixOnly, async () => {
  const home = await tmp();
  const out = path.join(home, 'office-sim.out');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  try {
    const port = String(blocker.address().port);
    const startCmd = fill(block('--port <port> <flags>'), { '<root>': REPO, '<port>': port, '<flags>': '', '<out>': out });
    const child = spawn('/bin/sh', ['-c', startCmd], { stdio: 'ignore', env: { ...process.env, HOME: home } });
    const exited = new Promise((r) => child.on('exit', r));
    const t0 = Date.now();
    const lines = (await shAsync(fill(block('--input-type=module'), { '<out>': out }))).split('\n');
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^office-sim: .*EADDRINUSE.*\(port in use: try --port 0 or another port\)$/);
    await exited;
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('wait snippet reads only complete lines: a half-written line neither ends the wait nor shows (finding 4)', unixOnly, async () => {
  const out = path.join(await tmp(), 'partial.out');
  const closed = net.createServer(); // a port that was just free: nothing listens there now
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await fs.writeFile(out, `office-sim: http://127.0.0.1:${port}/\noffice-sim: ag`);
  const code = fill(block('--input-type=module'), { '<out>': out, 'i < 40 &&': 'i < 4 &&' });
  const t0 = Date.now();
  assert.equal(sh(code), `office-sim: http://127.0.0.1:${port}/\nhealthz down ECONNREFUSED`);
  assert.ok(Date.now() - t0 >= 900, 'kept polling through its budget');
});

test('stop snippet with a port argument only reports: ours pid <n> for this repo on that port, else not ours (finding 2)', unixOnly, async () => {
  const f = await fakeServers();
  const onZero = f.run('repo', ['--port', '0']);
  f.run('other');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sh(`${f.stopCode} 4317`), 'not ours', 'another root on 4317 and ours on port 0 are not it');
  assert.equal(sh(`${f.stopCode} 0`), `ours pid ${onZero.pid}`);
  const plain = f.run('repo'); // no --port: the default 4317
  const eq = f.run('repo', ['--port=4317', '--auth']);
  await new Promise((r) => setTimeout(r, 300));
  const line = sh(`${f.stopCode} 4317`);
  assert.ok(line.startsWith('ours pid '), line);
  assert.deepEqual(pidSet(line, 'ours pid '), new Set([plain.pid, eq.pid]));
  for (const p of [onZero.pid, plain.pid, eq.pid]) assert.ok(alive(p), 'the check stops nothing');
});

test('stop snippet keeps going past a pid it cannot signal and reports it (finding 6)', unixOnly, async () => {
  const f = await fakeServers();
  const a = f.run('repo', ['--port', '0']);
  const b = f.run('repo', ['--port', '0']);
  await new Promise((r) => setTimeout(r, 300));
  const preload = path.join(f.dir, 'eperm.cjs');
  await fs.writeFile(preload, [
    'const kill = process.kill;',
    "process.kill = (pid, sig) => { if (String(pid) === process.env.FAIL_PID) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return kill.call(process, pid, sig); };",
  ].join('\n'));
  const out = sh(f.stopCode, { NODE_OPTIONS: `--require=${preload}`, FAIL_PID: String(a.pid) });
  assert.deepEqual(out.split('\n'), [`stopped pid ${b.pid}`, `could not stop pid ${a.pid} (EPERM)`]);
  assert.deepEqual(await b.exited, { code: 0, signal: null });
  assert.ok(alive(a.pid));
});

test('open snippet: one classified line for success, a failing or missing opener, and one that keeps running (findings 1, 7)', unixOnly, async () => {
  const code = block('opener still running');
  const dir = await tmp();
  const withOpener = path.join(dir, 'with');
  const without = path.join(dir, 'without');
  // PATH holds only these folders (node plus fake openers), so no real browser can open
  for (const d of [withOpener, without]) {
    await fs.mkdir(d);
    await fs.symlink(process.execPath, path.join(d, 'node'));
  }
  const log = path.join(dir, 'open.log');
  const script = '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" >> "$OPEN_LOG"\nif [ -n "$OPEN_SLEEP" ]; then exec /bin/sleep "$OPEN_SLEEP"; fi\nexit "${OPEN_EXIT:-0}"\n';
  for (const name of ['open', 'xdg-open']) await fs.writeFile(path.join(withOpener, name), script, { mode: 0o755 });
  const page = 'http://127.0.0.1:4317/?t=AbC_-123xyz#demo';
  const run = (PATH, extra = {}) => sh(fill(code, { '<page>': page }), { PATH, OPEN_LOG: log, ...extra });
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  assert.equal(run(withOpener), 'opened');
  assert.equal(await fs.readFile(log, 'utf8'), `1\n${page}\n`, 'the page is one argument');
  assert.equal(run(withOpener, { OPEN_EXIT: '3' }), `open failed ${cmd} exit 3`);
  assert.equal(run(without), `open failed ${cmd} ENOENT`);
  const t0 = Date.now();
  assert.equal(run(withOpener, { OPEN_SLEEP: '5' }), 'opener still running');
  assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms`);
});
