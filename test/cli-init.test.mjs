// W7 (launch readiness, contract 6.3): `office-sim init` and `office-sim hooks install|uninstall|status`.
// Every run here gets --home (or an injected home) and, where it matters, --settings: all files are under os.tmpdir()
// and the real ~/.claude is never read or written. `status` asks only a server on port 0, a port that was just
// closed, or a throwaway listener. The prompt is a function argument (`ask`), so no test needs a terminal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, isCommand, COMMAND_USAGE, SKILL_MARKER } from '../src/cli-init.mjs';
import { USAGE } from '../src/cli-args.mjs';
import { start } from '../src/server.mjs';
import { HOOK_MARKER, buildHookUrl } from '../src/hooks-receiver.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKILL_SRC = path.join(REPO, 'skills', 'office', 'SKILL.md');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-init-'));
  tmpDirs.push(d);
  return d;
}
const noHome = () => { throw new Error('the real home directory was asked for'); };
const neverAsk = () => { throw new Error('the prompt was shown'); };

/** One in-process run. Never a real home: `--home` is added unless the argv already has one. */
async function cli(argv, { home = null, isTTY = false, ask = neverAsk, root = REPO } = {}) {
  const lines = [];
  const errs = [];
  const full = home && !argv.includes('--home') ? [...argv, '--home', home] : argv;
  const code = await run(full, { root, out: (l) => lines.push(l), err: (l) => errs.push(l), isTTY, ask, homedir: noHome });
  return { code, lines, errs, text: lines.join('\n'), errText: errs.join('\n') };
}
const settingsOf = (home) => path.join(home, '.claude', 'settings.json');
const skillOf = (home) => path.join(home, '.claude', 'skills', 'office');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const url = (port = 4747) => buildHookUrl({ port });
const expectedHooks = (port = 4747) => ({
  PermissionRequest: [{ hooks: [{ type: 'http', url: url(port), timeout: 2 }] }],
  Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'http', url: url(port), timeout: 2 }] }],
});
// every file and folder under a directory, as sorted relative paths (what "nothing was written" compares)
function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('isCommand: only init and hooks are subcommands; the main usage points at them', () => {
  assert.equal(isCommand('init'), true);
  assert.equal(isCommand('hooks'), true);
  for (const a of ['--init', 'hook', 'install', 'status', '', undefined, '--port']) assert.equal(isCommand(a), false, String(a));
  assert.ok(USAGE.startsWith('Usage: office-sim [options]\n'));
  const tail = USAGE.slice(USAGE.indexOf('  -h, --help'));
  assert.match(tail, /\n {2}office-sim init\b.*\n {2}office-sim hooks install\|uninstall\|status\b/);
  assert.ok(tail.includes('office-sim init --help'));
  for (const s of ['office-sim init [options]', 'office-sim hooks install|uninstall|status [options]', '--settings <path>', '--home <dir>',
    '--port <n>', '--dry-run', '--yes', '<home>/.claude/settings.json', '<home>/.claude/skills/office', '<settings>.office-sim.bak']) {
    assert.ok(COMMAND_USAGE.includes(s), s);
  }
});

test('usage errors exit 2 and write nothing; --help prints the subcommand usage', async () => {
  const home = tmpHome();
  for (const [argv, re] of [
    [['hooks'], /hooks needs install, uninstall or status/],
    [['hooks', 'remove'], /hooks needs install, uninstall or status/],
    [['init', '--nope'], /unknown option: --nope/],
    [['init', 'extra'], /unexpected argument: extra/],
    [['hooks', 'status', 'extra'], /unexpected argument: extra/],
    [['hooks', 'install', '--port', '0'], /--port must be an integer in 1\.\.65535/],
    [['hooks', 'install', '--port', '4747.5'], /--port must be an integer/],
    [['hooks', 'install', '--port=abc'], /--port must be an integer/],
    [['hooks', 'install', '--settings'], /--settings needs a value/],
    [['init', '--home', '--yes'], /--home needs a value/],
    [['init', '--yes=1'], /--yes takes no value/],
  ]) {
    const r = await cli(argv, { home });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.errText, re);
    assert.ok(r.errText.endsWith(`\n\n${COMMAND_USAGE.trimEnd()}`), 'the usage follows the message');
    assert.deepEqual(r.lines, []);
  }
  assert.deepEqual(tree(home), [], 'nothing was created');
  for (const argv of [['init', '--help'], ['hooks', '-h'], ['hooks', 'status', '--help'], ['init', '--nope', '--help']]) {
    const r = await cli(argv);
    assert.deepEqual([r.code, r.text, r.errText], [0, COMMAND_USAGE.trimEnd(), ''], argv.join(' '));
  }
});

test('hooks install --dry-run: the plan (file, hooks, no backup yet) and not one file', async () => {
  const home = tmpHome();
  const r = await cli(['hooks', 'install', '--dry-run'], { home });
  assert.equal(r.code, 0, r.errText);
  assert.ok(r.lines.every((l) => l.startsWith('office-sim: ')), r.text);
  assert.ok(r.text.includes(`office-sim: settings file ${settingsOf(home)} (will be created)`));
  assert.ok(r.text.includes(`office-sim: add hook PermissionRequest: http POST ${url()}, timeout 2 s`));
  assert.ok(r.text.includes(`office-sim: add hook Notification (matcher permission_prompt): http POST ${url()}, timeout 2 s`));
  assert.ok(r.text.includes('office-sim: backup: none (there is no settings file yet)'));
  assert.equal(r.lines.at(-1), 'office-sim: dry run: nothing written');
  assert.doesNotMatch(r.text, /skill/);
  assert.deepEqual(tree(home), [], 'nothing was created, not even .claude');
});

test('without a terminal and without --yes: the plan, then exit 1 with a line naming --yes, and nothing written', async () => {
  const home = tmpHome();
  for (const argv of [['hooks', 'install'], ['init']]) {
    const r = await cli(argv, { home, isTTY: false });
    assert.equal(r.code, 1, argv.join(' '));
    assert.ok(r.text.includes('office-sim: add hook PermissionRequest'), 'the plan is printed first');
    assert.match(r.errText, /^office-sim: nothing written: .*--yes/);
    assert.ok(r.errText.includes('--dry-run'));
    assert.deepEqual(tree(home), []);
  }
});

test('hooks install --yes: merges, backs up once, keeps the rest; a second run changes nothing and asks nothing', async () => {
  const home = tmpHome();
  const settings = settingsOf(home);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const mine = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }] } };
  const original = `${JSON.stringify(mine)}\n`;
  fs.writeFileSync(settings, original);
  const r = await cli(['hooks', 'install', '--yes'], { home });
  assert.equal(r.code, 0, r.errText);
  assert.ok(r.text.includes(`office-sim: settings file ${settings} (exists)`));
  assert.ok(r.text.includes(`office-sim: backup ${settings}.office-sim.bak (the file as it is now, written once before the first change)`));
  assert.ok(r.text.includes(`office-sim: wrote ${settings}`));
  assert.ok(r.text.indexOf('add hook PermissionRequest') < r.text.indexOf(`wrote ${settings}`), 'the plan comes before the write');
  assert.deepEqual(readJson(settings), { theme: 'dark', hooks: { ...mine.hooks, ...expectedHooks() } });
  assert.equal(fs.readFileSync(`${settings}.office-sim.bak`, 'utf8'), original);
  assert.equal(fs.existsSync(skillOf(home)), false, 'hooks install copies no skill');

  const once = fs.readFileSync(settings, 'utf8');
  const before = fs.statSync(settings).mtimeMs;
  const again = await cli(['hooks', 'install'], { home, isTTY: true, ask: neverAsk });
  assert.equal(again.code, 0);
  assert.ok(again.text.includes(`office-sim: the hooks are already in ${settings}: nothing to change`));
  assert.equal(fs.readFileSync(settings, 'utf8'), once);
  assert.equal(fs.statSync(settings).mtimeMs, before, 'the file was not rewritten');

  // another port replaces the two entries, and says so
  const moved = await cli(['hooks', 'install', '--port', '5055', '--yes'], { home });
  assert.equal(moved.code, 0);
  assert.ok(moved.text.includes('office-sim: replace 2 office-sim hook(s) already in the file'));
  assert.ok(moved.text.includes(`office-sim: backup ${settings}.office-sim.bak is already there and stays as it is`));
  assert.deepEqual(readJson(settings).hooks, { ...mine.hooks, ...expectedHooks(5055) });
  assert.equal(fs.readFileSync(`${settings}.office-sim.bak`, 'utf8'), original, 'the backup is written once');
});

test('the prompt: y writes, anything else writes nothing and exits 1', async () => {
  const home = tmpHome();
  const asked = [];
  const no = await cli(['hooks', 'install'], { home, isTTY: true, ask: async (q) => { asked.push(q); return 'n'; } });
  assert.equal(no.code, 1);
  assert.match(no.errText, /^office-sim: nothing written$/);
  assert.deepEqual(tree(home), []);
  const enter = await cli(['hooks', 'install'], { home, isTTY: true, ask: async () => '' });
  assert.equal(enter.code, 1, 'Enter alone is no');
  assert.deepEqual(tree(home), []);
  for (const answer of ['y', 'Y', ' yes ']) {
    const h = tmpHome();
    const yes = await cli(['hooks', 'install'], { home: h, isTTY: true, ask: async (q) => { asked.push(q); return answer; } });
    assert.equal(yes.code, 0, answer);
    assert.deepEqual(readJson(settingsOf(h)), { hooks: expectedHooks() });
  }
  assert.ok(asked.length === 4 && asked.every((q) => q === 'office-sim: write these changes? [y/N] '), asked.join('|'));
  // --dry-run never asks, --yes never asks
  assert.equal((await cli(['hooks', 'install', '--dry-run'], { home, isTTY: true, ask: neverAsk })).code, 0);
  assert.equal((await cli(['hooks', 'install', '--yes'], { home: tmpHome(), isTTY: true, ask: neverAsk })).code, 0);
});

test('--settings names the file; the default home is asked only when --home is absent', async () => {
  const home = tmpHome();
  const custom = path.join(home, 'elsewhere', 'my-settings.json');
  const r = await cli(['hooks', 'install', '--yes', '--settings', custom], { home });
  assert.equal(r.code, 0, r.errText);
  assert.deepEqual(readJson(custom), { hooks: expectedHooks() });
  assert.deepEqual(tree(home), ['elsewhere', 'elsewhere/my-settings.json'], 'no .claude was made under --home');
  // --settings= form, and no --home at all: with --settings given, hooks commands never need the home directory
  const eq = await cli(['hooks', 'uninstall', '--yes', `--settings=${custom}`]);
  assert.equal(eq.code, 0, eq.errText);
  assert.deepEqual(readJson(custom), {});
  // without --home the home directory comes from the injected function (never the real one in a test)
  const injected = tmpHome();
  const lines = [];
  const code = await run(['hooks', 'install', '--yes'], { root: REPO, out: (l) => lines.push(l), err: () => {}, isTTY: false, ask: neverAsk, homedir: () => injected });
  assert.equal(code, 0);
  assert.deepEqual(readJson(settingsOf(injected)), { hooks: expectedHooks() });
});

test('a settings file that cannot be merged is refused before anything is written, also by init', async () => {
  for (const [content, re] of [['{ not json', /unparseable/], ['[1]', /non-object/], ['{"hooks":[1]}', /hooks field is not an object/],
    ['{"hooks":{"PermissionRequest":"x"}}', /hooks\.PermissionRequest is not an array/], ['{"hooks":{"Notification":{"a":1}}}', /hooks\.Notification is not an array/]]) {
    for (const argv of [['hooks', 'install', '--yes'], ['init', '--yes'], ['hooks', 'install', '--dry-run']]) {
      const home = tmpHome();
      fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
      fs.writeFileSync(settingsOf(home), content);
      const r = await cli(argv, { home });
      assert.equal(r.code, 1, `${argv.join(' ')} on ${content}`);
      assert.match(r.errText, re);
      assert.ok(r.errText.includes(settingsOf(home)), 'the message names the file');
      assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), content);
      assert.deepEqual(tree(home), ['.claude', '.claude/settings.json'], 'no backup, no skill folder');
    }
  }
  const home = tmpHome();
  fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
  fs.writeFileSync(settingsOf(home), '{ nope');
  const un = await cli(['hooks', 'uninstall', '--yes'], { home });
  assert.equal(un.code, 1);
  assert.match(un.errText, /unparseable/);
  assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), '{ nope');
});

test('hooks uninstall: removes only our hooks (old curl ones too), reports when there is nothing, asks like install', async () => {
  const empty = tmpHome();
  const nothing = await cli(['hooks', 'uninstall'], { home: empty, isTTY: true, ask: neverAsk });
  assert.equal(nothing.code, 0);
  assert.ok(nothing.text.includes(`office-sim: no settings file at ${settingsOf(empty)}: nothing to remove`));
  assert.deepEqual(tree(empty), [], 'nothing is created');

  const home = tmpHome();
  const settings = settingsOf(home);
  const oldCommand = `curl -sS -m 1 -X POST --data-binary @- "http://127.0.0.1:4317/api/hooks/claude" || true # ${HOOK_MARKER}`;
  const mine = { model: 'x', hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }, { hooks: [{ type: 'command', command: oldCommand }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: oldCommand }] }],
  } };
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(mine));
  const noneOfOurs = tmpHome();
  fs.mkdirSync(path.dirname(settingsOf(noneOfOurs)), { recursive: true });
  fs.writeFileSync(settingsOf(noneOfOurs), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}');
  const clean = await cli(['hooks', 'uninstall', '--yes'], { home: noneOfOurs });
  assert.equal(clean.code, 0);
  assert.ok(clean.text.includes(`office-sim: no office-sim hooks in ${settingsOf(noneOfOurs)}: nothing to remove`));
  assert.equal(fs.readFileSync(settingsOf(noneOfOurs), 'utf8'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}', 'not rewritten');

  const before = fs.readFileSync(settings, 'utf8');
  const dry = await cli(['hooks', 'uninstall', '--dry-run'], { home });
  assert.equal(dry.code, 0);
  assert.ok(dry.text.includes('office-sim: remove 2 office-sim hook(s): Stop 1, PreToolUse 1'), dry.text);
  assert.equal(dry.lines.at(-1), 'office-sim: dry run: nothing written');
  const piped = await cli(['hooks', 'uninstall'], { home, isTTY: false });
  assert.equal(piped.code, 1);
  assert.match(piped.errText, /--yes/);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);

  const r = await cli(['hooks', 'uninstall'], { home, isTTY: true, ask: async () => 'y' });
  assert.equal(r.code, 0, r.errText);
  assert.ok(r.text.includes(`office-sim: removed 2 office-sim hook(s) from ${settings}`));
  assert.deepEqual(readJson(settings), { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  assert.equal(fs.existsSync(`${settings}.office-sim.bak`), false, 'uninstall writes no backup');
});

test('hooks status: what is in the file and what answers on the port; it writes nothing', async () => {
  const home = tmpHome();
  const closed = await freePort();
  const none = await cli(['hooks', 'status', '--port', String(closed)], { home });
  assert.equal(none.code, 0, none.errText);
  assert.ok(none.text.includes(`office-sim: settings file ${settingsOf(home)}: no such file`));
  assert.ok(none.text.includes('office-sim: hook PermissionRequest: not installed'));
  assert.ok(none.text.includes('office-sim: hook Notification: not installed'));
  assert.ok(none.text.includes('office-sim: hooks installed: no'));
  assert.ok(none.text.includes(`office-sim: server http://127.0.0.1:${closed}/: no office-sim answers (nothing listens there, or a program holds the port and gave no usable /healthz answer in 1 s)`));
  assert.ok(none.text.includes('Claude Code plugin'), 'plugin hooks are not in the file: the output says they are not checked');
  assert.deepEqual(tree(home), [], 'status creates nothing');

  const root = tmpHome();
  const open = await start({ port: 0, root, agents: ['claude-code'], rescanMs: 60_000 });
  const auth = await start({ port: 0, root, agents: ['claude-code'], rescanMs: 60_000, auth: true });
  const other = http.createServer((req, res) => res.end('hello'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await cli(['hooks', 'install', '--yes', '--port', String(open.port)], { home })).code, 0);
    const text = fs.readFileSync(settingsOf(home), 'utf8');
    const ok = await cli(['hooks', 'status', '--port', String(open.port)], { home });
    assert.equal(ok.code, 0);
    assert.ok(ok.text.includes(`office-sim: settings file ${settingsOf(home)}: 2 office-sim hook(s)`));
    assert.ok(ok.text.includes(`office-sim: hook PermissionRequest: installed, posts to ${url(open.port)}`));
    assert.ok(ok.text.includes(`office-sim: hook Notification: installed, posts to ${url(open.port)}`));
    assert.ok(ok.text.includes('office-sim: hooks installed: yes'));
    assert.ok(ok.text.includes(`office-sim: server http://127.0.0.1:${open.port}/: running (an office-sim answers /healthz)`));
    // the same file, asked about another port: the hooks post elsewhere
    const wrongPort = await cli(['hooks', 'status', '--port', String(auth.port)], { home });
    assert.ok(wrongPort.text.includes(`office-sim: hook PermissionRequest: installed for port ${open.port}, not ${auth.port}`));
    assert.ok(wrongPort.text.includes('office-sim: hooks installed: no'));
    assert.ok(wrongPort.text.includes(`office-sim: server http://127.0.0.1:${auth.port}/: running with --auth`));
    assert.ok(wrongPort.text.includes('401'), 'it says hook requests are refused there');
    const foreign = await cli(['hooks', 'status', '--port', String(other.address().port)], { home });
    assert.ok(foreign.text.includes(`office-sim: server http://127.0.0.1:${other.address().port}/: another program answers there`));
    assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), text, 'status never rewrites the file');
    assert.deepEqual(tree(home), ['.claude', '.claude/settings.json']);
  } finally {
    await open.close();
    await auth.close();
    await new Promise((r) => other.close(r));
  }

  // one event only, plus an older command hook: partly, and the old hooks are counted
  const part = tmpHome();
  fs.mkdirSync(path.dirname(settingsOf(part)), { recursive: true });
  fs.writeFileSync(settingsOf(part), JSON.stringify({ hooks: {
    PermissionRequest: [{ hooks: [{ type: 'http', url: url(closed), timeout: 2 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `curl x # ${HOOK_MARKER}` }] }],
  } }));
  const partly = await cli(['hooks', 'status', '--port', String(closed)], { home: part });
  assert.ok(partly.text.includes('office-sim: hooks installed: partly'));
  assert.ok(partly.text.includes('office-sim: hook Notification: not installed'));
  assert.match(partly.text, /office-sim: 1 older command hook\(s\).*hooks install replaces/);
  const broken = tmpHome();
  fs.mkdirSync(path.dirname(settingsOf(broken)), { recursive: true });
  fs.writeFileSync(settingsOf(broken), '{ nope');
  const bad = await cli(['hooks', 'status', '--port', String(closed)], { home: broken });
  assert.equal(bad.code, 1);
  assert.ok(bad.text.includes(`office-sim: settings file ${settingsOf(broken)}: not JSON, cannot be read`));
});

test('init --dry-run: the hooks, the backup and the skill folder are named, and nothing is written', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
  fs.writeFileSync(settingsOf(home), '{}\n');
  const r = await cli(['init', '--dry-run'], { home });
  assert.equal(r.code, 0, r.errText);
  assert.ok(r.text.includes('office-sim: add hook PermissionRequest'));
  assert.ok(r.text.includes('office-sim: add hook Notification (matcher permission_prompt)'));
  assert.ok(r.text.includes(`office-sim: backup ${settingsOf(home)}.office-sim.bak (`));
  assert.ok(r.text.includes(`office-sim: skill folder ${skillOf(home)} (will be created): a copy of ${path.join(REPO, 'skills', 'office')} (SKILL.md)`), r.text);
  assert.equal(r.lines.at(-1), 'office-sim: dry run: nothing written');
  assert.deepEqual(tree(home), ['.claude', '.claude/settings.json']);
  assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), '{}\n');
});

test('init --yes: hooks plus a real copy of the skill; then nothing to change; a changed copy of ours is updated', async () => {
  const home = tmpHome();
  const r = await cli(['init', '--yes'], { home });
  assert.equal(r.code, 0, r.errText);
  assert.deepEqual(readJson(settingsOf(home)), { hooks: expectedHooks() });
  const dir = skillOf(home);
  assert.ok(fs.lstatSync(dir).isDirectory(), 'a folder, not a link');
  assert.ok(fs.lstatSync(path.join(dir, 'SKILL.md')).isFile());
  assert.ok(fs.readFileSync(path.join(dir, 'SKILL.md')).equals(fs.readFileSync(SKILL_SRC)), 'byte-identical to skills/office/SKILL.md');
  assert.deepEqual(readJson(path.join(dir, SKILL_MARKER)), { installedBy: 'office-sim init', version: VERSION });
  assert.deepEqual(fs.readdirSync(dir).sort(), [SKILL_MARKER, 'SKILL.md'].sort());
  assert.ok(r.text.includes(`office-sim: copied the skill to ${dir}`));
  // the copy has no checkout behind it: the skill's own root test says MISSING there, so it starts the server with npx
  assert.equal(fs.existsSync(path.join(home, 'bin', 'office-sim.mjs')), false);

  const again = await cli(['init'], { home, isTTY: true, ask: neverAsk });
  assert.equal(again.code, 0);
  assert.ok(again.text.includes(`office-sim: the hooks are already in ${settingsOf(home)}: nothing to change`));
  assert.ok(again.text.includes(`office-sim: skill folder ${dir} (is up to date)`));

  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'an older text\n');
  const dry = await cli(['init', '--dry-run'], { home });
  assert.ok(dry.text.includes(`office-sim: skill folder ${dir} (will be updated)`));
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'an older text\n');
  const update = await cli(['init', '--yes'], { home });
  assert.equal(update.code, 0, update.errText);
  assert.ok(fs.readFileSync(path.join(dir, 'SKILL.md')).equals(fs.readFileSync(SKILL_SRC)));
});

test('init never replaces a skill folder it did not make: a folder, a file or a link is refused, nothing is written or moved', async () => {
  const cases = {
    'a folder': (target) => { fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'SKILL.md'), 'mine\n'); },
    'a folder with a broken marker': (target) => { fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, SKILL_MARKER), '{"installedBy":"someone else"}'); },
    'a file': (target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'a file\n'); },
  };
  for (const [name, make] of Object.entries(cases)) {
    const home = tmpHome();
    make(skillOf(home));
    const before = tree(home);
    const r = await cli(['init', '--yes'], { home });
    assert.equal(r.code, 1, name);
    assert.match(r.errText, /office-sim: refused: .* was not made by office-sim init/, name);
    assert.ok(r.errText.includes('nothing was written'), name);
    assert.ok(r.errText.includes('office-sim hooks install'), `${name}: the message says how to get the hooks alone`);
    assert.ok(/rename or remove/i.test(r.errText), `${name}: and how to make room for the copy`);
    assert.deepEqual(tree(home), before, `${name}: no settings file, no backup, nothing moved`);
  }
  // the clone install: <home>/.claude/skills/office is a link into a checkout. Writing through it would change the clone.
  const home = tmpHome();
  const clone = path.join(tmpHome(), 'clone', 'skills', 'office');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'SKILL.md'), 'the clone text\n');
  fs.mkdirSync(path.dirname(skillOf(home)), { recursive: true });
  fs.symlinkSync(clone, skillOf(home), 'dir');
  for (const argv of [['init', '--yes'], ['init', '--dry-run']]) {
    const r = await cli(argv, { home });
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.errText, /office-sim: refused: .* is a symbolic link/);
    assert.ok(r.errText.includes('npm run skill:uninstall'));
    assert.ok(fs.lstatSync(skillOf(home)).isSymbolicLink(), 'the link stays');
    assert.deepEqual(fs.readdirSync(clone), ['SKILL.md'], 'nothing was written through the link');
    assert.equal(fs.readFileSync(path.join(clone, 'SKILL.md'), 'utf8'), 'the clone text\n');
    assert.equal(fs.existsSync(settingsOf(home)), false, 'the hooks were not installed either');
  }
  // a package without the skill (a broken install): refused, nothing written
  const bare = tmpHome();
  const noSkill = await cli(['init', '--yes'], { home: tmpHome(), root: bare });
  assert.equal(noSkill.code, 1);
  assert.match(noSkill.errText, /office-sim: skill source not found/);
});
