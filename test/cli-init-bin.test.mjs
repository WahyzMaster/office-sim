// W7 (launch readiness, contract 6.3): the setup commands through the real bin. bin/office-sim.mjs hands `init` and
// `hooks` to src/cli-init.mjs before any server option is parsed, so no server starts. Each child gets pipes for stdio
// (never a terminal, so nothing can be asked) and a HOME that does not exist: with --home given, nothing may be read
// from or written to the directory HOME names. All files are under os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { USAGE } from '../src/cli-args.mjs';
import { COMMAND_USAGE, SKILL_MARKER } from '../src/cli-init.mjs';
import { buildHookUrl } from '../src/hooks-receiver.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO, 'bin', 'office-sim.mjs');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-initbin-'));
  tmpDirs.push(d);
  return d;
}
// a HOME that does not exist: anything written "to the home directory" would create it, and the tests look for that
function ghostHome() {
  return path.join(tmp(), 'no-such-home');
}
function bin(args, home = ghostHome()) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env });
}
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : null);
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
const expected = (port = 4747) => {
  const handler = { type: 'http', url: buildHookUrl({ port }), timeout: 2 };
  return { hooks: { PermissionRequest: [{ hooks: [handler] }], Notification: [{ matcher: 'permission_prompt', hooks: [handler] }] } };
};

test('the bin dispatches on its first argument only: init and hooks get their own usage, the server usage points at them', () => {
  for (const args of [['init', '--help'], ['hooks', '--help'], ['hooks', 'status', '-h']]) {
    const r = bin(args);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, COMMAND_USAGE, ''], args.join(' '));
  }
  const help = bin(['--help']);
  assert.deepEqual([help.status, help.stdout, help.stderr], [0, USAGE, '']);
  assert.ok(help.stdout.includes('office-sim init --help'));
  // a setup command's own option errors, with its own usage (exit 2)
  const bad = bin(['init', '--port', '0']);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, `office-sim: --port must be an integer in 1..65535\n\n${COMMAND_USAGE}`);
  const noAction = bin(['hooks']);
  assert.equal(noAction.status, 2);
  assert.ok(noAction.stderr.startsWith('office-sim: hooks needs install, uninstall or status\n\nUsage: office-sim init [options]\n'));
  // not the first argument: the server's parser sees it, as before
  for (const args of [['--no-open', 'init'], ['--port', '0', 'hooks', 'status']]) {
    const r = bin(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^office-sim: unexpected argument: (init|hooks)\n\nUsage: office-sim \[options\]\n/);
  }
  for (const word of ['initx', 'hook', 'install']) {
    const r = bin([word]);
    assert.equal(r.status, 2, word);
    assert.ok(r.stderr.startsWith(`office-sim: unexpected argument: ${word}\n`), r.stderr);
  }
});

test('no terminal, no --yes: the bin prints the plan, names --yes on stderr, exits 1 and writes nothing', () => {
  for (const command of [['init'], ['hooks', 'install']]) {
    const home = tmp();
    const ghost = ghostHome();
    const r = bin([...command, '--home', home], ghost);
    assert.equal(r.status, 1, command.join(' '));
    assert.ok(r.stdout.includes(`office-sim: settings file ${path.join(home, '.claude', 'settings.json')} (will be created)\n`), r.stdout);
    assert.ok(r.stdout.includes('office-sim: add hook PermissionRequest: http POST '));
    assert.equal(r.stdout.includes('office-sim: skill folder '), command[0] === 'init');
    assert.match(r.stderr, /^office-sim: nothing written: .*--yes.*\n$/);
    assert.doesNotMatch(r.stdout, /office-sim: http:\/\//, 'no server was started');
    assert.deepEqual(tree(home), []);
    assert.equal(fs.existsSync(ghost), false);
  }
});

test('with --home no subcommand touches the directory HOME names (a HOME that does not exist stays that way)', async () => {
  const ghost = ghostHome();
  const home = tmp();
  const closed = String(await freePort());
  const settings = path.join(home, '.claude', 'settings.json');
  const skill = path.join(home, '.claude', 'skills', 'office');
  const step = (args, want = 0) => {
    const r = bin([...args, '--home', home], ghost);
    assert.equal(r.status, want, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(ghost), false, `${args.join(' ')}: HOME was created`);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(ghost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${args.join(' ')}: HOME is not even named`);
    return r;
  };
  step(['init', '--dry-run']);
  assert.deepEqual(tree(home), []);
  step(['hooks', 'status', '--port', closed]);
  assert.deepEqual(tree(home), []);
  step(['hooks', 'uninstall', '--yes']);
  assert.deepEqual(tree(home), []);

  const init = step(['init', '--yes']);
  assert.ok(init.stdout.includes(`office-sim: wrote ${settings}\n`));
  assert.ok(init.stdout.includes(`office-sim: copied the skill to ${skill}\n`));
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), expected());
  assert.deepEqual(tree(home), ['.claude', '.claude/settings.json', '.claude/skills', '.claude/skills/office',
    `.claude/skills/office/${SKILL_MARKER}`, '.claude/skills/office/SKILL.md']);
  assert.ok(fs.readFileSync(path.join(skill, 'SKILL.md')).equals(fs.readFileSync(path.join(REPO, 'skills', 'office', 'SKILL.md'))));
  assert.equal(fs.lstatSync(skill).isSymbolicLink(), false, 'a copy, not a link');

  const status = step(['hooks', 'status', '--port', closed]);
  assert.ok(status.stdout.includes(`office-sim: hook PermissionRequest: installed for port 4747, not ${closed}\n`));
  assert.ok(status.stdout.includes(`office-sim: server http://127.0.0.1:${closed}/: no office-sim answers (nothing listens there, or a program holds the port and gave no usable /healthz answer in 1 s)\n`));
  step(['hooks', 'install', '--yes', '--port', closed]);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), expected(Number(closed)));
  assert.ok(step(['hooks', 'status', '--port', closed]).stdout.includes('office-sim: hooks installed: yes\n'));
  const un = step(['hooks', 'uninstall', '--yes']);
  assert.ok(un.stdout.includes(`office-sim: removed 2 office-sim hook(s) from ${settings}\n`));
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
  // --settings elsewhere: the default file under --home is left alone
  const custom = path.join(tmp(), 'settings.json');
  step(['hooks', 'install', '--yes', '--settings', custom]);
  assert.deepEqual(JSON.parse(fs.readFileSync(custom, 'utf8')), expected());
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
  assert.equal(fs.existsSync(ghost), false);
});
