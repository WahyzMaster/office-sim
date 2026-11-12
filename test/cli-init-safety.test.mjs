// W7 (launch readiness, contract 6.3): what `office-sim init` does when something is in its way, and what it leaves
// behind when a write fails. A link inside its own skill folder is never written through; a refusal that only shows
// while the prompt is open still writes nothing; the skill is copied before the settings file is written, and a
// failure says which part is already there. Also `hooks status` on a port that is held but gives no usable answer.
// Every run gets --home (and --settings where it matters) under os.tmpdir(); the real ~/.claude is never used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, SKILL_MARKER } from '../src/cli-init.mjs';
import { MAX_PROBE_BODY } from '../src/port-reuse.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKILL_TEXT = fs.readFileSync(path.join(REPO, 'skills', 'office', 'SKILL.md'));
const OURS = `${JSON.stringify({ installedBy: 'office-sim init', version: '0.0.1' }, null, 2)}\n`;

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-initsafe-'));
  tmpDirs.push(d);
  return d;
}
const noHome = () => { throw new Error('the real home directory was asked for'); };
const neverAsk = () => { throw new Error('the prompt was shown'); };
async function cli(argv, { home, isTTY = false, ask = neverAsk, root = REPO } = {}) {
  const lines = [];
  const errs = [];
  const code = await run([...argv, '--home', home], { root, out: (l) => lines.push(l), err: (l) => errs.push(l), isTTY, ask, homedir: noHome });
  return { code, lines, errs, text: lines.join('\n'), errText: errs.join('\n') };
}
const settingsOf = (home) => path.join(home, '.claude', 'settings.json');
const skillOf = (home) => path.join(home, '.claude', 'skills', 'office');
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
// a skill folder as init leaves it (marker and an older text), for the cases that then put something odd into it
function oursWith(home, extra = () => {}) {
  const dir = skillOf(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_MARKER), OURS);
  extra(dir);
  return dir;
}
const cannotRestrict = process.platform === 'win32' || process.getuid?.() === 0;

test('a link inside init\'s own skill folder is refused: nothing is written through it, and no hooks are installed', async () => {
  const outside = tmpDir();
  const victim = path.join(outside, 'notes.txt');
  fs.writeFileSync(victim, 'not a skill\n');
  const cases = {
    'SKILL.md is a link to a file': (dir) => fs.symlinkSync(victim, path.join(dir, 'SKILL.md')),
    'SKILL.md is a link to nothing': (dir) => fs.symlinkSync(path.join(outside, 'not-there.md'), path.join(dir, 'SKILL.md')),
  };
  for (const [name, make] of Object.entries(cases)) {
    for (const argv of [['init', '--yes'], ['init', '--dry-run'], ['init']]) {
      const home = tmpDir();
      const dir = oursWith(home, make);
      const before = tree(home);
      const r = await cli(argv, { home, isTTY: true, ask: neverAsk });
      const label = `${name}: ${argv.join(' ')}`;
      assert.equal(r.code, 1, label);
      assert.ok(r.errText.includes(`office-sim: refused: ${path.join(dir, 'SKILL.md')} is a symbolic link, and init never writes through a link`), `${label}\n${r.errText}`);
      assert.ok(r.errText.includes('nothing was written'), label);
      assert.ok(r.errText.includes('office-sim hooks install'), `${label}: how to get the hooks alone`);
      assert.match(r.errText, /remove .* yourself and run init again/i, `${label}: how to make room`);
      assert.ok(fs.lstatSync(path.join(dir, 'SKILL.md')).isSymbolicLink(), `${label}: the link stays`);
      assert.deepEqual(tree(home), before, `${label}: no settings file, no backup, nothing added`);
      assert.equal(fs.readFileSync(victim, 'utf8'), 'not a skill\n', `${label}: the file behind the link keeps its content`);
      assert.deepEqual(fs.readdirSync(outside), ['notes.txt'], `${label}: nothing was created behind a dangling link`);
    }
  }
});

test('a marker that is a link does not make a folder ours, and is neither read as ours nor written', async () => {
  const outside = tmpDir();
  const marker = path.join(outside, 'marker.json');
  fs.writeFileSync(marker, OURS); // says "office-sim init", but it is not a file init wrote into the folder
  const home = tmpDir();
  const dir = skillOf(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'mine\n');
  fs.symlinkSync(marker, path.join(dir, SKILL_MARKER));
  const before = tree(home);
  const r = await cli(['init', '--yes'], { home });
  assert.equal(r.code, 1);
  assert.match(r.errText, /office-sim: refused: .* was not made by office-sim init/);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(marker, 'utf8'), OURS);
  assert.deepEqual(tree(home), before);
});

test('a folder that is a link, or a folder where a file belongs, inside our skill folder is refused the same way', async () => {
  // a package whose skill has a file in a subfolder (today's has SKILL.md alone; the copy is recursive)
  const pkg = tmpDir();
  fs.mkdirSync(path.join(pkg, 'skills', 'office', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills', 'office', 'SKILL.md'), 'skill\n');
  fs.writeFileSync(path.join(pkg, 'skills', 'office', 'docs', 'more.md'), 'more\n');
  const outside = tmpDir();
  const home = tmpDir();
  const dir = oursWith(home, (d) => fs.symlinkSync(outside, path.join(d, 'docs'), 'dir'));
  const linked = await cli(['init', '--yes'], { home, root: pkg });
  assert.equal(linked.code, 1);
  assert.ok(linked.errText.includes(`office-sim: refused: ${path.join(dir, 'docs')} is a symbolic link, and init never writes through a link`), linked.errText);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written into the folder behind the link');
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), false, 'and nothing beside it: the refusal comes before any write');
  assert.equal(fs.existsSync(settingsOf(home)), false);

  const home2 = tmpDir();
  const dir2 = oursWith(home2, (d) => fs.mkdirSync(path.join(d, 'SKILL.md')));
  const folder = await cli(['init', '--yes'], { home: home2 });
  assert.equal(folder.code, 1);
  assert.ok(folder.errText.includes(`office-sim: refused: ${path.join(dir2, 'SKILL.md')} is not a regular file, and init does not replace it`), folder.errText);
  assert.ok(fs.lstatSync(path.join(dir2, 'SKILL.md')).isDirectory());
  assert.equal(fs.existsSync(settingsOf(home2)), false);

  // without the odd entry the same package copies fine, subfolder included
  const home3 = tmpDir();
  const ok = await cli(['init', '--yes'], { home: home3, root: pkg });
  assert.equal(ok.code, 0, ok.errText);
  assert.deepEqual(fs.readdirSync(skillOf(home3), { recursive: true }).map(String).sort(), [SKILL_MARKER, 'SKILL.md', 'docs', 'docs/more.md'].sort());
});

test('a skill target that cannot be looked at is a refusal, not a crash', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'skills'), 'a file where the skills folder belongs\n');
  const r = await cli(['init', '--yes'], { home });
  assert.equal(r.code, 1);
  assert.ok(r.errText.includes(`office-sim: refused: ${skillOf(home)} cannot be looked at (ENOTDIR)`), r.errText);
  assert.ok(r.errText.includes('nothing was written'));
  assert.deepEqual(tree(home), ['.claude', '.claude/skills']);
});

test('init copies the skill before it writes the settings file, and the marker before the skill', async () => {
  const home = tmpDir();
  const r = await cli(['init', '--yes'], { home });
  assert.equal(r.code, 0, r.errText);
  const copied = r.lines.indexOf(`office-sim: copied the skill to ${skillOf(home)}`);
  const wrote = r.lines.indexOf(`office-sim: wrote ${settingsOf(home)}`);
  assert.ok(copied >= 0 && wrote > copied, r.text);
  // a copy that stopped half way (the marker is there, the skill is not) is ours: the next init completes it
  const half = tmpDir();
  const dir = oursWith(half);
  const again = await cli(['init', '--yes'], { home: half });
  assert.equal(again.code, 0, again.errText);
  assert.ok(again.text.includes(`office-sim: skill folder ${dir} (will be updated)`));
  assert.ok(fs.readFileSync(path.join(dir, 'SKILL.md')).equals(SKILL_TEXT));
});

test('a refusal that only shows while the prompt is open still writes nothing', async () => {
  // somebody makes a skill folder of their own while init waits for the answer
  const home = tmpDir();
  const foreign = await cli(['init'], { home, isTTY: true, ask: async () => {
    fs.mkdirSync(skillOf(home), { recursive: true });
    fs.writeFileSync(path.join(skillOf(home), 'SKILL.md'), 'mine\n');
    return 'y';
  } });
  assert.equal(foreign.code, 1);
  assert.match(foreign.errText, /office-sim: refused: .* was not made by office-sim init/);
  assert.ok(foreign.errText.includes('nothing was written'));
  assert.equal(fs.existsSync(settingsOf(home)), false, 'the hooks were not installed either');
  assert.equal(fs.readFileSync(path.join(skillOf(home), 'SKILL.md'), 'utf8'), 'mine\n');
  // the settings file stops being mergeable while init waits: no skill folder is made
  const home2 = tmpDir();
  const broken = await cli(['init'], { home: home2, isTTY: true, ask: async () => {
    fs.mkdirSync(path.dirname(settingsOf(home2)), { recursive: true });
    fs.writeFileSync(settingsOf(home2), '{ nope');
    return 'y';
  } });
  assert.equal(broken.code, 1);
  assert.match(broken.errText, /unparseable/);
  assert.ok(broken.errText.includes('nothing was written'));
  assert.deepEqual(tree(home2), ['.claude', '.claude/settings.json']);
  assert.equal(fs.readFileSync(settingsOf(home2), 'utf8'), '{ nope');
});

test('a skill copy that fails leaves the settings file as it was, and says so', { skip: cannotRestrict && 'a read-only folder stops no write here' }, async () => {
  const home = tmpDir();
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  const mine = '{"theme":"dark"}\n';
  fs.writeFileSync(settingsOf(home), mine);
  fs.chmodSync(skills, 0o555);
  try {
    const r = await cli(['init', '--yes'], { home });
    assert.equal(r.code, 1);
    assert.ok(r.errText.includes(`office-sim: failed: EACCES while copying the skill to ${skillOf(home)}`), r.errText);
    assert.ok(r.errText.includes('the settings file was not changed'), r.errText);
    assert.ok(r.errText.includes('run init again'), 'how to go on');
    assert.doesNotMatch(r.text, /wrote /, 'no line claims a write');
    assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), mine);
    assert.deepEqual(tree(home), ['.claude', '.claude/settings.json', '.claude/skills'], 'no backup, no skill folder');
  } finally {
    fs.chmodSync(skills, 0o755);
  }
});

test('a settings write that fails after the copy says that the skill is already there, and how to go on', async () => {
  const home = tmpDir();
  const blocker = path.join(home, 'a-file');
  fs.writeFileSync(blocker, 'x\n');
  const settings = path.join(blocker, 'settings.json'); // its folder cannot be made: a file is in the way
  const r = await cli(['init', '--yes', '--settings', settings], { home });
  assert.equal(r.code, 1);
  assert.match(r.errText, new RegExp(`office-sim: failed: E[A-Z]+ while writing ${settings.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(r.errText.includes(`the skill was already copied to ${skillOf(home)} and stays there`), r.errText);
  assert.ok(r.errText.includes('office-sim hooks install'), 'how to get the hooks');
  assert.ok(r.text.includes(`office-sim: copied the skill to ${skillOf(home)}`));
  assert.doesNotMatch(r.text, /office-sim: (wrote|done)/, 'it does not claim the settings file or the whole');
  assert.ok(fs.readFileSync(path.join(skillOf(home), 'SKILL.md')).equals(SKILL_TEXT), 'the copy is whole');
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x\n');
  // hooks install alone: the same failure line, and no word about a skill
  const alone = await cli(['hooks', 'install', '--yes', '--settings', settings], { home: tmpDir() });
  assert.equal(alone.code, 1);
  assert.match(alone.errText, /^office-sim: failed: E[A-Z]+ while writing .*settings\.json$/);
  // the next init with a file that can be written finds the skill up to date and adds the hooks
  const next = await cli(['init', '--yes'], { home });
  assert.equal(next.code, 0, next.errText);
  assert.ok(next.text.includes(`office-sim: skill folder ${skillOf(home)} (is up to date)`));
  assert.ok(next.text.includes(`office-sim: wrote ${settingsOf(home)}`));
});

test('hooks status: a port that is held but gives no usable /healthz answer is not called free', async () => {
  const home = tmpDir();
  const big = http.createServer((req, res) => res.end('x'.repeat(MAX_PROBE_BODY + 1)));
  await new Promise((r) => big.listen(0, '127.0.0.1', r));
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const closed = free.address().port;
  await new Promise((r) => free.close(r));
  try {
    const line = (port) => `office-sim: server http://127.0.0.1:${port}/: no office-sim answers (nothing listens there, or a program holds the port and gave no usable /healthz answer in 1 s)`;
    const held = await cli(['hooks', 'status', '--port', String(big.address().port)], { home });
    assert.equal(held.code, 0);
    assert.ok(held.text.includes(line(big.address().port)), held.text);
    assert.doesNotMatch(held.text, /not running/, 'the port is taken: nothing says it is free');
    const none = await cli(['hooks', 'status', '--port', String(closed)], { home });
    assert.ok(none.text.includes(line(closed)), none.text);
  } finally {
    await new Promise((r) => big.close(r));
  }
});
