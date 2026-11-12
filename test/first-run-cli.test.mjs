// Launch readiness W4a (contract 6): what bin/office-sim.mjs does on a first run. The browser opens by default only when
// stdout is a terminal and CI is unset (D7), --no-open forbids it, --demo opens the printed URL plus #demo (D6), and a
// terminal gets one line when the first rescan attached no session.
// No real browser and no real terminal: PATH holds only a temp folder with fake `open` / `xdg-open` scripts, and the
// terminal is faked in the child by a --require preload written to a temp folder (it defines process.stdout.isTTY), so
// the shipped code has no test hook. Port 0, a temp HOME and a temp Claude root: the real ~/.claude is never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, until } from './fixtures/sse.mjs';

const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const REPLAY = fileURLToPath(new URL('./fixtures/replay/7e7e7e7e-1111-4222-8333-444455556666.jsonl', import.meta.url));
const SID = '1f1a57a0-1111-4222-8333-444455556666';
const unixOnly = { skip: process.platform === 'win32' ? 'fake openers are sh scripts' : false };
const NOTICE = (n) => `office-sim: no agent session in the last ${n} minutes; the page shows a demo until one starts\n`;
const URL_LINE = 'office-sim: http://127\\.0\\.0\\.1:\\d+/\\n';
const READY_MS = 15000;
const STOP_MS = 10000;

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-firstrun-'));
  tmpDirs.push(d);
  return d;
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// fake `open` and `xdg-open`: each call appends "<argc>\n<argv...>" to $OPEN_LOG
async function fakeOpeners() {
  const dir = await tmp();
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const script = '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" >> "$OPEN_LOG"\nexit 0\n';
  for (const name of ['open', 'xdg-open']) await fs.writeFile(path.join(bin, name), script, { mode: 0o755 });
  return { bin, logFile: path.join(dir, 'open.log') };
}
let preloadFile = null;
async function ttyPreload() {
  if (!preloadFile) {
    preloadFile = path.join(await tmp(), 'fake-tty.cjs');
    await fs.writeFile(preloadFile, "Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });\n");
  }
  return preloadFile;
}

/**
 * The bin on port 0 under a temp HOME. `tty`: stdout looks like a terminal to the child (it is still this test's pipe).
 * The child never has CI set unless `env` gives it, and always has DISPLAY, so on every platform and on a CI runner the
 * only things that decide are the flags and `tty`.
 */
async function runBin(args, { tty = false, env = {}, root = null } = {}) {
  const home = await tmp();
  const fake = await fakeOpeners();
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: fake.bin, OPEN_LOG: fake.logFile, DISPLAY: ':99' };
  delete childEnv.CI;
  Object.assign(childEnv, env);
  const pre = tty ? ['--require', await ttyPreload()] : [];
  const child = spawn(process.execPath, [...pre, BIN, '--port', '0', '--agents', 'claude-code', '--claude-root', root ?? home, '--rescan', '200', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code))); // close: stdout is read to its end
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('office-sim: agents')) resolve();
    });
    closed.then((code) => reject(new Error(`office-sim exited (${code}) before the agents line`)));
    child.on('error', reject);
  });
  const killAndThrow = async (e) => {
    child.kill('SIGKILL');
    await within(closed, STOP_MS, 'office-sim exit after SIGKILL').catch(() => {});
    throw new Error(`${e.message}\nstdout: ${out}\nstderr: ${err}`);
  };
  await within(ready, READY_MS, 'office-sim agents line').catch(killAndThrow);
  const url = out.split('\n')[0].replace(/^office-sim: /, '');
  const port = Number(new URL(url).port);
  const cookie = url.includes('?t=') ? await request(port, { path: `/?t=${new URL(url).searchParams.get('t')}` }).then((r) => String(r.headers['set-cookie']).split(';')[0]) : null;
  const health = async () => JSON.parse((await request(port, { path: '/healthz', headers: cookie ? { cookie } : {} })).body);
  // the first rescan is over (so its no-session line, if any, was written) once a second scan has finished: ticks never overlap
  const firstPassDone = async () => {
    try {
      let first = null;
      await until(async () => {
        const at = (await health()).runners['claude-code']?.lastScanAt ?? null;
        first ??= at;
        return at !== null && at !== first;
      }, 8000);
      await settle(100);
    } catch (e) {
      await killAndThrow(e);
    }
  };
  // SIGTERM, exit 0, then everything the bin wrote to stdout
  const stop = async () => {
    child.kill('SIGTERM');
    const code = await within(closed, STOP_MS, 'office-sim exit after SIGTERM').catch(killAndThrow);
    assert.equal(code, 0, err);
    return out;
  };
  const opened = () => fs.readFile(fake.logFile, 'utf8').catch(() => '');
  return { url, out: () => out, err: () => err, health, firstPassDone, stop, opened, killAndThrow };
}

// A Claude root with one live main transcript (synthetic records).
async function rootWithSession() {
  const root = await tmp();
  const dir = path.join(root, '-work-firstrun');
  await fs.mkdir(dir);
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/firstrun', startMs: Date.now() - 5000, stepMs: 10 });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), toJsonl([b.humanPrompt({ text: 'First run demo' }), b.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  return root;
}

test('stdout is not a terminal (node --test, the /office skill): nothing opens and stdout is URL, agents, stopping', unixOnly, async () => {
  const run = await runBin([]);
  await run.firstPassDone();
  const out = await run.stop();
  assert.equal(await run.opened(), '', 'no flag, no terminal: the opener is never called (CI is unset and DISPLAY is set here)');
  assert.match(out, new RegExp(`^${URL_LINE}office-sim: agents claude-code\\noffice-sim: stopping\\n$`), 'no no-session line on a pipe');
  assert.equal(run.err().includes('open failed'), false, run.err());
});

test('a terminal, CI unset, no flag: the printed URL is opened once, and one line says no session was found', unixOnly, async () => {
  const run = await runBin([], { tty: true });
  try {
    await until(async () => (await run.opened()).length > 0 && run.out().includes('no agent session'), 8000);
  } catch (e) {
    await run.killAndThrow(e);
  }
  await run.firstPassDone();
  const out = await run.stop();
  assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(await run.opened(), `1\n${run.url}\n`, 'one call, one argument: the printed URL');
  // the default active window is 30 minutes; the line comes once, after the agents line, and later rescans do not repeat it
  assert.match(out, new RegExp(`^${URL_LINE}office-sim: agents claude-code\\n${NOTICE(30)}office-sim: stopping\\n$`));
});

test('a terminal with --no-open, or with CI set: the opener is never called; the line names the --active window', unixOnly, async () => {
  for (const [args, env] of [[['--no-open', '--active', '5'], {}], [['--active', '5'], { CI: 'true' }]]) {
    const run = await runBin(args, { tty: true, env });
    await run.firstPassDone();
    const out = await run.stop();
    assert.equal(await run.opened(), '', `${args.join(' ')} ${JSON.stringify(env)}`);
    assert.ok(out.includes(`office-sim: agents claude-code\n${NOTICE(5)}`), out);
    assert.equal(out.split('no agent session').length, 2, 'the line is printed once');
  }
});

test('--demo opens the printed URL plus #demo; the URL line stays as it is and no no-session line follows', unixOnly, async () => {
  const DEMO_LINE = 'office-sim: demo ';
  // in a terminal (default open), and forced with --open on a pipe; with --auth the token URL gets the same suffix
  for (const [args, tty, urlRe] of [
    [['--demo'], true, /^http:\/\/127\.0\.0\.1:\d+\/$/],
    [['--demo', '--open'], false, /^http:\/\/127\.0\.0\.1:\d+\/$/],
    [['--open', '--auth', '--demo'], false, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/],
  ]) {
    const run = await runBin(args, { tty });
    try {
      await until(async () => (await run.opened()).length > 0, 8000);
    } catch (e) {
      await run.killAndThrow(e);
    }
    await run.firstPassDone();
    const out = await run.stop();
    assert.match(run.url, urlRe, `${args.join(' ')}: the URL line has no #demo`);
    assert.equal(await run.opened(), `1\n${run.url}#demo\n`, args.join(' '));
    assert.equal(out.includes('no agent session'), false, `${args.join(' ')}: the demo was asked for`);
    assert.equal(out.includes(DEMO_LINE) || out.includes('#demo'), false, `${args.join(' ')}: the browser was opened, so stdout has no demo line`);
  }
  // D19: when no browser is opened (--no-open in a terminal, or a pipe without --open), one line gives the demo URL,
  // after the URL and agents lines; with --auth it is the token URL plus #demo
  for (const [args, tty, urlRe] of [
    [['--demo', '--no-open'], true, /^http:\/\/127\.0\.0\.1:\d+\/$/],
    [['--demo'], false, /^http:\/\/127\.0\.0\.1:\d+\/$/],
    [['--demo', '--auth', '--no-open'], true, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/],
  ]) {
    const quiet = await runBin(args, { tty });
    await quiet.firstPassDone();
    const out = await quiet.stop();
    assert.match(quiet.url, urlRe, args.join(' '));
    assert.equal(await quiet.opened(), '', `${args.join(' ')}: --demo opens nothing by itself`);
    assert.equal(out, `office-sim: ${quiet.url}\noffice-sim: agents claude-code\n${DEMO_LINE}${quiet.url}#demo\noffice-sim: stopping\n`, args.join(' '));
  }
});

test('D19 the demo line comes after the replay line, and never without --demo', unixOnly, async () => {
  const run = await runBin(['--demo', '--no-open', '--replay', REPLAY, '--speed', '50'], { tty: true });
  try {
    await until(() => run.out().includes('office-sim: demo '), 8000);
  } catch (e) {
    await run.killAndThrow(e);
  }
  const out = await run.stop();
  const demoRe = 'office-sim: demo http://127\\.0\\.0\\.1:\\d+/#demo\\n';
  assert.match(out, new RegExp(`^${URL_LINE}office-sim: agents claude-code\\noffice-sim: replay 50x\\n${demoRe}office-sim: stopping\\n` + '$'));
  // without --demo the stdout lines are the ones every other test here pins: URL, agents, stopping
  const plain = await runBin(['--no-open']);
  await plain.firstPassDone();
  assert.equal((await plain.stop()).includes('office-sim: demo'), false);
});

test('a terminal with a live session: the page has a real office, so no no-session line', unixOnly, async () => {
  const run = await runBin(['--no-open'], { tty: true, root: await rootWithSession() });
  try {
    await until(async () => (await run.health()).sessions === 1, 8000);
  } catch (e) {
    await run.killAndThrow(e);
  }
  await run.firstPassDone();
  const out = await run.stop();
  assert.match(out, new RegExp(`^${URL_LINE}office-sim: agents claude-code\\noffice-sim: stopping\\n$`));
});

test('a terminal in replay mode: no no-session line (the page shows the replayed session)', unixOnly, async () => {
  const run = await runBin(['--no-open', '--replay', REPLAY, '--speed', '50'], { tty: true });
  try {
    await until(() => run.out().includes('office-sim: replay 50x\n'), 8000);
    await until(async () => (await run.health()).ok === true, 8000);
  } catch (e) {
    await run.killAndThrow(e);
  }
  await settle(500);
  const out = await run.stop();
  assert.equal(out.includes('no agent session'), false, out);
});
