// Launch readiness D7 and the flag part of D6 (contract 6): whether the bin opens the browser is one pure decision,
// src/open-policy.mjs. --open forces it, --no-open forbids it, and without either it opens only when stdout is a TTY, CI
// is unset and the platform has an opener (never by default with --auth where xdg-open is the opener). Everything is
// injected here: the result never depends on this machine's terminal, CI variable or platform. Nothing is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shouldOpen, hasOpener, pageUrl, demoLine, noSessionLine, noSessionLineWanted, DEMO_HASH } from '../src/open-policy.mjs';
import { isOpenableUrl } from '../src/open-url.mjs';
import { parseArgs, USAGE } from '../src/cli-args.mjs';

const MAC = { isTTY: true, env: {}, platform: 'darwin' };
const LINUX = { isTTY: true, env: { DISPLAY: ':0' }, platform: 'linux' };

test('default: opens only when stdout is a TTY, CI is unset and the platform has an opener', () => {
  assert.equal(shouldOpen(MAC), true);
  assert.equal(shouldOpen(LINUX), true);
  assert.equal(shouldOpen({ ...MAC, platform: 'win32' }), true);
  for (const isTTY of [false, undefined, null, 0, 1, 'true']) {
    assert.equal(shouldOpen({ ...MAC, isTTY }), false, `isTTY ${String(isTTY)}: only the boolean true is a terminal`);
  }
  for (const CI of ['true', '1', 'false', 'yes']) {
    assert.equal(shouldOpen({ ...MAC, env: { CI } }), false, `CI=${CI}`);
    assert.equal(shouldOpen({ ...LINUX, env: { ...LINUX.env, CI } }), false, `linux CI=${CI}`);
  }
  assert.equal(shouldOpen({ ...MAC, env: { CI: '' } }), true, 'an empty CI is unset');
  assert.equal(shouldOpen({ ...MAC, env: { CIRCLE: '1', NOT_CI: '1' } }), true, 'only the variable named CI');
  assert.equal(shouldOpen({ ...LINUX, env: {} }), false, 'no graphical session: xdg-open has nothing to open');
  assert.equal(shouldOpen({ ...LINUX, env: { WAYLAND_DISPLAY: 'wayland-0' } }), true);
  assert.equal(shouldOpen(), false, 'nothing known: do not open');
  assert.equal(shouldOpen({}), false);
});

test('hasOpener: open on macOS and start on Windows are always there; xdg-open needs DISPLAY or WAYLAND_DISPLAY', () => {
  assert.equal(hasOpener('darwin', {}), true);
  assert.equal(hasOpener('win32', {}), true);
  for (const p of ['linux', 'freebsd', 'openbsd', 'android']) {
    assert.equal(hasOpener(p, {}), false, p);
    assert.equal(hasOpener(p, { DISPLAY: '' }), false, `${p}: an empty DISPLAY is unset`);
    assert.equal(hasOpener(p, { DISPLAY: ':1' }), true, p);
    assert.equal(hasOpener(p, { WAYLAND_DISPLAY: 'wayland-1' }), true, p);
  }
  assert.equal(hasOpener('linux', undefined), false);
});

test('--open forces and --no-open forbids, whatever the terminal, CI and platform say', () => {
  const worst = { isTTY: false, env: { CI: 'true' }, platform: 'linux', auth: true };
  assert.equal(shouldOpen({ ...worst, open: true }), true, '--open: as before, also without a TTY, in CI, with --auth on Linux');
  const best = { ...MAC, auth: false };
  assert.equal(shouldOpen({ ...best, open: false }), false, '--no-open');
  assert.equal(shouldOpen({ ...best, open: undefined }), true);
  // the flags reach the policy through parseArgs as one key: true, false or absent (the last one wins)
  assert.equal(shouldOpen({ ...best, open: parseArgs(['--no-open']).open }), false);
  assert.equal(shouldOpen({ ...worst, open: parseArgs(['--open']).open }), true);
  assert.equal(shouldOpen({ ...best, open: parseArgs(['--port', '0']).open }), true);
  assert.equal(shouldOpen({ ...worst, open: parseArgs(['--port', '0']).open }), false);
});

test('--auth: no default open where xdg-open is the opener (the token would sit in the browser\'s argv); --open still opens', () => {
  for (const platform of ['linux', 'freebsd', 'openbsd']) {
    assert.equal(shouldOpen({ ...LINUX, platform, auth: true }), false, platform);
    assert.equal(shouldOpen({ ...LINUX, platform, auth: true, open: true }), true, `${platform} --open`);
    assert.equal(shouldOpen({ ...LINUX, platform, auth: false }), true, `${platform} without --auth`);
  }
  assert.equal(shouldOpen({ ...MAC, auth: true }), true, 'macOS: open hands the URL to LaunchServices');
  assert.equal(shouldOpen({ ...MAC, platform: 'win32', auth: true }), true);
});

test('pageUrl: --demo adds #demo to the URL that is opened, and the result is still a URL the opener accepts', () => {
  assert.equal(DEMO_HASH, '#demo');
  const plain = 'http://127.0.0.1:4747/';
  const token = 'http://127.0.0.1:50123/?t=AbC_-123xyz';
  assert.equal(pageUrl(plain, false), plain);
  assert.equal(pageUrl(plain, undefined), plain);
  assert.equal(pageUrl(plain, true), 'http://127.0.0.1:4747/#demo');
  assert.equal(pageUrl(token, true), 'http://127.0.0.1:50123/?t=AbC_-123xyz#demo');
  for (const url of [plain, token, 'http://[::1]:65535/']) assert.equal(isOpenableUrl(pageUrl(url, true)), true, url);
});

test('demoLine (D19): one office-sim: line with the demo URL, for a --demo run that opens no browser', () => {
  assert.equal(demoLine('http://127.0.0.1:4747/'), 'office-sim: demo http://127.0.0.1:4747/#demo\n');
  assert.equal(demoLine('http://127.0.0.1:50123/?t=AbC_-123xyz'), 'office-sim: demo http://127.0.0.1:50123/?t=AbC_-123xyz#demo\n');
  assert.equal(demoLine('http://[::1]:4747/'), `office-sim: demo ${pageUrl('http://[::1]:4747/', true)}\n`, 'the URL --demo would have opened');
  assert.equal(demoLine('http://127.0.0.1:4747/').split('\n').length, 2, 'exactly one line');
});

test('noSessionLine: one office-sim: line that names the active window', () => {
  assert.equal(noSessionLine(30), 'office-sim: no agent session in the last 30 minutes; the page shows a demo until one starts\n');
  assert.equal(noSessionLine(5), 'office-sim: no agent session in the last 5 minutes; the page shows a demo until one starts\n');
  assert.equal(noSessionLine(0.5), 'office-sim: no agent session in the last 0.5 minutes; the page shows a demo until one starts\n');
  assert.equal(noSessionLine(1440).split('\n').length, 2, 'exactly one line');
});

test('noSessionLineWanted: only for a terminal, and not in replay or demo mode', () => {
  assert.equal(noSessionLineWanted({ isTTY: true }), true);
  assert.equal(noSessionLineWanted({ isTTY: true, replay: false, demo: false }), true);
  // a pipe or a file (node --test, the /office skill's output file): the stdout lines stay URL, agents, stopping
  for (const isTTY of [false, undefined, null]) assert.equal(noSessionLineWanted({ isTTY }), false, String(isTTY));
  assert.equal(noSessionLineWanted({ isTTY: true, replay: true }), false, 'replay shows the replayed session, not the demo');
  assert.equal(noSessionLineWanted({ isTTY: true, demo: true }), false, '--demo: the demo was asked for');
  assert.equal(noSessionLineWanted(), false);
});

test('parseArgs: --no-open and --demo are switches; --open and --no-open share one key and the last one wins', () => {
  assert.deepEqual(parseArgs(['--no-open']), { open: false });
  assert.deepEqual(parseArgs(['--open']), { open: true });
  assert.deepEqual(parseArgs(['--open', '--no-open']), { open: false });
  assert.deepEqual(parseArgs(['--no-open', '--open']), { open: true });
  assert.deepEqual(parseArgs(['--demo']), { demo: true });
  assert.deepEqual(parseArgs(['--demo', '--no-open', '--port', '0']), { demo: true, open: false, port: 0 });
  assert.equal('demo' in parseArgs(['--port', '0']), false);
  assert.equal('open' in parseArgs(['--demo']), false);
  assert.throws(() => parseArgs(['--no-open=1']), /--no-open takes no value/);
  assert.throws(() => parseArgs(['--demo=1']), /--demo takes no value/);
  assert.throws(() => parseArgs(['--demo', 'yes']), /unexpected argument: yes/);
  assert.throws(() => parseArgs(['--noopen']), /unknown option: --noopen/);
});

test('USAGE lists --open, --no-open and --demo together, after --auth and --cdn, and says when the default opens', () => {
  const at = (flag) => USAGE.indexOf(`\n  ${flag} `);
  const order = ['--auth', '--cdn', '--open', '--no-open', '--demo', '--notify'].map(at);
  assert.ok(order.every((i) => i >= 0), order.join(','));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'auth, cdn, open, no-open, demo, then notify');
  assert.match(USAGE, /\n {2}--no-open {12}\S/, '--no-open in the option column');
  assert.match(USAGE, /\n {2}--demo {15}\S/, '--demo in the option column');
  const openText = USAGE.slice(at('--open'), at('--no-open'));
  for (const s of ['TTY', 'CI']) assert.ok(openText.includes(s), `the --open text names ${s}`);
  assert.ok(USAGE.slice(at('--demo'), at('--notify')).includes('#demo'));
  for (const l of USAGE.split('\n')) assert.ok(l.length <= 120, `USAGE line fits 120 columns: ${l}`);
});

// ---- the tests themselves never open a browser ---------------------------------------------------------------

test('under node --test a spawned bin has no TTY on stdout, so the default never opens there', () => {
  // what a child sees when its stdout is a pipe (spawn's default, and what every test that starts the bin uses)
  const piped = spawnSync(process.execPath, ['-p', 'String(process.stdout.isTTY)'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(piped.stdout.trim(), 'undefined');
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(shouldOpen({ open: undefined, auth: false, isTTY: undefined, env: { DISPLAY: ':0' }, platform }), false, platform);
  }
  // no test hands its own stdout (a terminal when the suite is run by hand) to a child
  const quoted = new RegExp(`(['"\`])${'inh'}${'erit'}\\1`);
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const names = fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith('.mjs'));
  assert.ok(names.length > 100, `${names.length} test and fixture files read`);
  for (const name of names) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, name), 'utf8'), quoted, `${name} passes its stdio on to a child`);
  }
});
