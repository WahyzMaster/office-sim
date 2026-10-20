// P4 scripts/install-skill.mjs: <skills dir>/office becomes a symlink to the repo's skills/office. Every case runs in
// its own temp HOME / skills dir (asserted before each run), so the real ~/.claude is never read or written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, parseInstallArgs, inspectTarget, SOURCE_DIR, USAGE } from '../scripts/install-skill.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/install-skill.mjs', import.meta.url));
const NOW = () => new Date('2026-10-20T11:30:00.123Z');
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-skill-'));
  tmpDirs.push(d);
  return d;
}

// one temp home per case; `install(...args)` runs the installer against it and returns { code, lines }
async function sandbox() {
  const home = await tmp();
  const skills = path.join(home, '.claude', 'skills');
  const target = path.join(skills, 'office');
  const install = async (...args) => {
    const lines = [];
    assert.ok(target.startsWith(home + path.sep) && !target.startsWith(path.join(os.homedir(), '.claude')), 'temp target only');
    const code = await run(['--home', home, ...args], { env: { HOME: home }, out: (l) => lines.push(l), now: NOW });
    return { code, lines };
  };
  return { home, skills, target, install };
}
const real = (p) => fs.realpath(p);
const exists = (p) => fs.lstat(p).then(() => true, () => false);

test('install into a fresh home: creates <home>/.claude/skills and the office symlink to the repo skill, nothing else', async () => {
  const s = await sandbox();
  const { code, lines } = await s.install();
  assert.equal(code, 0);
  const src = await real(SOURCE_DIR);
  assert.deepEqual(lines, [`install-skill: create directory ${s.skills}`, `install-skill: link ${s.target} -> ${src}`]);
  assert.ok((await fs.lstat(s.target)).isSymbolicLink());
  assert.equal(await real(s.target), src);
  assert.ok(await exists(path.join(s.target, 'SKILL.md')), 'the skill is readable through the link');
  assert.deepEqual(await fs.readdir(path.join(s.home, '.claude')), ['skills']);
  assert.deepEqual(await fs.readdir(s.skills), ['office']);
});

test('install is idempotent: an existing correct symlink is left as it is', async () => {
  const s = await sandbox();
  await s.install();
  const before = await fs.lstat(s.target);
  const { code, lines } = await s.install();
  assert.equal(code, 0);
  assert.deepEqual(lines, [`install-skill: already installed: ${s.target} -> ${await real(SOURCE_DIR)}`]);
  const afterSt = await fs.lstat(s.target);
  assert.equal(afterSt.ino, before.ino, 'the same link, not recreated');
});

test('a relative symlink, or one through a non-canonical path, to the repo skill also counts as ours', async () => {
  const s = await sandbox();
  await fs.mkdir(s.skills, { recursive: true });
  await fs.symlink(path.relative(s.skills, SOURCE_DIR), s.target);
  assert.equal((await inspectTarget(s.target, await real(SOURCE_DIR))).kind, 'ours');
  assert.equal((await s.install()).code, 0);
  // a fake repo reached through a symlinked folder (like /var -> /private/var on macOS)
  const base = await tmp();
  const repo = path.join(base, 'repo', 'skills', 'office');
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'SKILL.md'), '---\nname: office\n---\n');
  await fs.symlink(path.join(base, 'repo'), path.join(base, 'alias'));
  const viaAlias = path.join(base, 'alias', 'skills', 'office');
  const t2 = path.join(base, 'skills', 'office');
  await fs.mkdir(path.dirname(t2));
  await fs.symlink(viaAlias, t2);
  assert.equal((await inspectTarget(t2, await real(repo))).kind, 'ours');
  const lines = [];
  assert.equal(await run(['--skills-dir', path.dirname(t2)], { out: (l) => lines.push(l), source: viaAlias }), 0);
  assert.match(lines[0], /already installed/);
});

test('refuses an existing directory, file or foreign symlink without --force, and leaves it untouched', async () => {
  const s = await sandbox();
  await fs.mkdir(s.target, { recursive: true });
  await fs.writeFile(path.join(s.target, 'SKILL.md'), 'mine');
  let r = await s.install();
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^install-skill: refused: .* is a directory; rerun with --force to move it aside \(it is never deleted\)$/);
  assert.equal(await fs.readFile(path.join(s.target, 'SKILL.md'), 'utf8'), 'mine');

  const f = await sandbox();
  await fs.mkdir(f.skills, { recursive: true });
  await fs.writeFile(f.target, 'a file');
  r = await f.install();
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /is a file;/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'a file');

  const l = await sandbox();
  const other = await tmp();
  await fs.mkdir(l.skills, { recursive: true });
  await fs.symlink(other, l.target);
  r = await l.install();
  assert.equal(r.code, 1);
  assert.ok(r.lines[0].includes(`is a symlink to ${other};`), r.lines[0]);
  assert.equal(await fs.readlink(l.target), other);
});

test('--force moves the old entry aside to office.bak-<time> (never deleted) and links ours; a second backup gets -2', async () => {
  const s = await sandbox();
  await fs.mkdir(s.target, { recursive: true });
  await fs.writeFile(path.join(s.target, 'SKILL.md'), 'mine');
  const { code, lines } = await s.install('--force');
  assert.equal(code, 0);
  const backup = path.join(s.skills, 'office.bak-20261020T113000Z');
  assert.equal(lines[0], `install-skill: move ${s.target} to ${backup}`);
  assert.match(lines[1], /^install-skill: note: Claude Code reads every folder in .*; remove office\.bak-20261020T113000Z when/);
  assert.equal(lines[2], `install-skill: link ${s.target} -> ${await real(SOURCE_DIR)}`);
  assert.equal(await fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'), 'mine');
  assert.equal(await real(s.target), await real(SOURCE_DIR));

  // a foreign symlink is moved as the link itself (its target is not touched)
  const other = await tmp();
  await fs.writeFile(path.join(other, 'keep'), 'x');
  await fs.unlink(s.target);
  await fs.symlink(other, s.target);
  const again = await s.install('--force');
  assert.equal(again.code, 0);
  const backup2 = `${backup}-2`;
  assert.equal(again.lines[0], `install-skill: move ${s.target} to ${backup2}`);
  assert.ok((await fs.lstat(backup2)).isSymbolicLink());
  assert.equal(await fs.readlink(backup2), other);
  assert.equal(await fs.readFile(path.join(other, 'keep'), 'utf8'), 'x');
  assert.deepEqual((await fs.readdir(s.skills)).sort(), ['office', 'office.bak-20261020T113000Z', 'office.bak-20261020T113000Z-2']);
});

test('--uninstall removes only our symlink; the repo skill stays; foreign entries are left alone even with --force', async () => {
  const s = await sandbox();
  await s.install();
  let r = await s.install('--uninstall');
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [`install-skill: remove symlink ${s.target}`]);
  assert.equal(await exists(s.target), false);
  assert.ok(await exists(path.join(SOURCE_DIR, 'SKILL.md')), 'the repo skill itself is untouched');
  assert.ok(await exists(s.skills), 'the skills folder stays');

  r = await s.install('--uninstall');
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [`install-skill: nothing to remove: ${s.target} does not exist`]);

  await fs.mkdir(s.target);
  await fs.writeFile(path.join(s.target, 'SKILL.md'), 'mine');
  r = await s.install('--uninstall', '--force');
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^install-skill: left alone: .* is a directory, not our symlink to /);
  assert.equal(await fs.readFile(path.join(s.target, 'SKILL.md'), 'utf8'), 'mine');

  const l = await sandbox();
  const other = await tmp();
  await fs.mkdir(l.skills, { recursive: true });
  await fs.symlink(other, l.target);
  r = await l.install('--uninstall');
  assert.equal(r.code, 1);
  assert.equal(await fs.readlink(l.target), other);
});

test('--dry-run prints the plan and changes nothing (install, --force, --uninstall)', async () => {
  const s = await sandbox();
  let r = await s.install('--dry-run');
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [`install-skill: would create directory ${s.skills}`,
    `install-skill: would link ${s.target} -> ${await real(SOURCE_DIR)}`]);
  assert.equal(await exists(path.join(s.home, '.claude')), false);

  await fs.mkdir(s.target, { recursive: true });
  r = await s.install('--dry-run', '--force');
  assert.equal(r.code, 0);
  assert.equal(r.lines[0], `install-skill: would move ${s.target} to ${path.join(s.skills, 'office.bak-20261020T113000Z')}`);
  assert.ok((await fs.lstat(s.target)).isDirectory(), 'not moved');
  assert.deepEqual(await fs.readdir(s.skills), ['office']);
  r = await s.install('--dry-run');
  assert.equal(r.code, 1, 'a dry run reports the same refusal');

  await fs.rmdir(s.target);
  await s.install();
  r = await s.install('--dry-run', '--uninstall');
  assert.deepEqual(r.lines, [`install-skill: would remove symlink ${s.target}`]);
  assert.ok((await fs.lstat(s.target)).isSymbolicLink(), 'still there');
});

test('a missing skill source is reported and nothing is created', async () => {
  const s = await sandbox();
  const lines = [];
  const empty = await tmp();
  assert.equal(await run(['--home', s.home], { out: (l) => lines.push(l), source: empty }), 1);
  assert.deepEqual(lines, [`install-skill: skill source not found: ${path.join(empty, 'SKILL.md')}`]);
  assert.equal(await exists(path.join(s.home, '.claude')), false);
});

test('arguments: --skills-dir wins over --home; usage errors exit 2; --help exits 0', async () => {
  assert.deepEqual(parseInstallArgs(['--force', '--dry-run', '--home=/h', '--skills-dir', '/s']),
    { uninstall: false, force: true, dryRun: true, help: false, home: '/h', skillsDir: '/s' });
  assert.throws(() => parseInstallArgs(['--home']), /--home needs a directory/);
  assert.throws(() => parseInstallArgs(['--skills-dir', '--force']), /--skills-dir needs a directory/);
  assert.throws(() => parseInstallArgs(['--nope']), /unknown argument: --nope/);
  const out = [];
  assert.equal(await run(['--nope'], { out: (l) => out.push(l) }), 2);
  assert.ok(out[0].startsWith('install-skill: unknown argument: --nope\n\nUsage:'), out[0]);
  const help = [];
  assert.equal(await run(['--help'], { out: (l) => help.push(l) }), 0);
  assert.equal(help[0], USAGE);
  const home = await tmp();
  const custom = path.join(home, 'elsewhere');
  const lines = [];
  assert.equal(await run(['--home', home, '--skills-dir', custom], { out: (l) => lines.push(l) }), 0);
  assert.ok((await fs.lstat(path.join(custom, 'office'))).isSymbolicLink());
  assert.equal(await exists(path.join(home, '.claude')), false);
});

test('CLI (the npm scripts run this file): HOME from the environment, install then --uninstall', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-sim-skill-cli-'));
  tmpDirs.push(dir);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  delete env.CLAUDE_CONFIG_DIR;
  const target = path.join(dir, '.claude', 'skills', 'office');
  const a = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, new RegExp(`install-skill: link ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -> `));
  const b = spawnSync(process.execPath, [SCRIPT, '--uninstall'], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.equal(b.stdout, `install-skill: remove symlink ${target}\n`);
  const c = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(c.status, 2);
});

// ---- review fix (P4 finding 5): the target is the skill source or a checkout that holds it ------------------

// a fake office-sim checkout at `root` with skills/office/SKILL.md; returns the skill source path
async function fakeCheckout(root) {
  const source = path.join(root, 'skills', 'office');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: office\n---\n');
  await fs.mkdir(path.join(root, 'bin'));
  await fs.writeFile(path.join(root, 'bin', 'office-sim.mjs'), '');
  return source;
}
async function runWith(args, source) {
  const lines = [];
  const code = await run(args, { out: (l) => lines.push(l), source, now: NOW });
  return { code, lines };
}

test('a checkout cloned into <skills>/office is refused even with --force, and nothing is moved (finding 5a)', async () => {
  const base = await tmp();
  const skills = path.join(base, 'skills');
  const target = path.join(skills, 'office');
  const source = await fakeCheckout(target); // the repo itself sits where the link would go
  for (const args of [[], ['--force'], ['--force', '--dry-run']]) {
    const r = await runWith(['--skills-dir', skills, ...args], source);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.lines.length, 1, r.lines.join('\n'));
    assert.match(r.lines[0], /^install-skill: refused: .* contains this repo's skill source .*, so it is never moved\. Move the office-sim checkout out of /);
    assert.doesNotMatch(r.lines[0], /--force/, 'the refusal does not suggest --force');
    assert.deepEqual(await fs.readdir(skills), ['office'], 'no backup, no link');
    assert.ok((await fs.lstat(target)).isDirectory());
    assert.ok(await exists(path.join(source, 'SKILL.md')));
  }
  const u = await runWith(['--skills-dir', skills, '--uninstall'], source);
  assert.equal(u.code, 1);
  assert.match(u.lines[0], /^install-skill: left alone: .* contains the skill source .*, not a symlink$/);
  assert.ok(await exists(path.join(source, 'SKILL.md')));
});

test('a skills dir that is the repo\'s own skills/ folder, directly or through a symlink, counts as installed (finding 5b, 5c)', async () => {
  const base = await tmp();
  const repo = path.join(base, 'repo');
  const source = await fakeCheckout(repo);
  let r = await runWith(['--skills-dir', path.join(repo, 'skills'), '--force'], source);
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [`install-skill: already installed: ${path.join(repo, 'skills', 'office')} is the skill source ${await real(source)}`]);
  assert.deepEqual(await fs.readdir(path.join(repo, 'skills')), ['office'], 'nothing moved or linked');

  // <home>/.claude/skills is itself a symlink to <repo>/skills
  const home = path.join(base, 'home');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.symlink(path.join(repo, 'skills'), path.join(home, '.claude', 'skills'));
  r = await runWith(['--home', home, '--force'], source);
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /^install-skill: already installed: .* is the skill source /);
  assert.deepEqual(await fs.readdir(path.join(repo, 'skills')), ['office']);
  assert.ok(await exists(path.join(source, 'SKILL.md')));
  r = await runWith(['--home', home, '--uninstall'], source);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^install-skill: left alone: .* is the skill source itself, not a symlink$/);
  assert.ok(await exists(path.join(source, 'SKILL.md')));
});
