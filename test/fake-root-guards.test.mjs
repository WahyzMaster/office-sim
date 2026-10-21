// The fake-*-append dev helpers (maintenance PR 4): fake-codex-append and fake-antigravity-append now refuse the agent's
// real root like fake-grok-append does (scripts/fake-root-guard.mjs): through a link, a path under the link, a path that
// does not exist yet, a link to the home folder and another letter case where the file system ignores it. All three
// stop on SIGTERM as on Ctrl+C: the temp root they made is removed, a given --root stays.
// Every run has HOME (and TMPDIR) set to a temp folder, so the scripts' real roots are folders of a fake home; never the
// real ~/.codex, ~/.gemini or ~/.grok.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideRealRoot } from '../scripts/fake-root-guard.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const GROUP = encodeURIComponent('/work/fake'); // fake-grok's session group folder for --cwd /work/fake
// links: paths in a temp --root the script writes through, each tried as a link to the same path in the real root
// (a dangling one where the real path is missing); extra: arguments that keep one turn short
const SCRIPTS = {
  codex: { file: script('fake-codex-append.mjs'), dir: '.codex', links: ['sessions', 'session_index.jsonl'], extra: [] },
  antigravity: { file: script('fake-antigravity-append.mjs'), dir: '.gemini', links: ['antigravity-cli', 'antigravity-cli/brain'], extra: [] },
  grok: { file: script('fake-grok-append.mjs'), dir: '.grok', links: ['sessions', `sessions/${GROUP}`], extra: ['--wait-ms', '0'] },
};
// what a fake home's real root holds before a run: every file and folder with the files' bytes
async function tree(dir) {
  const out = {};
  for (const e of await fsp.readdir(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    out[path.relative(dir, p)] = e.isFile() ? await fsp.readFile(p, 'utf8') : e.isDirectory() ? 'dir' : 'other';
  }
  return out;
}
// macOS: /System/Volumes/Data<path> is the same folder as <path> under the firmlinked /Users and /private (null elsewhere)
function firmlinkAlias(dir) {
  const real = realpathSync.native(dir);
  const alias = path.join('/System/Volumes/Data', real);
  if (process.platform !== 'darwin' || !existsSync(alias)) return null;
  const [a, b] = [statSync(real), statSync(alias)];
  return a.dev === b.dev && a.ino === b.ino ? alias : null;
}
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
// HOME (and USERPROFILE) is the fake home: os.homedir() in the script, so its "real root" is <home>/<dir>
const envOf = (home, tmpDir = home) => ({ ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmpDir });
const capital = (dir) => `.${dir[1].toUpperCase()}${dir.slice(2)}`; // .codex -> .Codex

function runScript(file, args, home) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { env: envOf(home), timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// Starts a script, waits for its printed root (its first files are written and the signal handlers are on; it then
// sleeps --step-ms) or, with `when`, for that stdout line too, then `delayMs` more and `before(root)`, sends the signal
// and waits for the exit. A script that never prints or never exits is killed.
async function stopAfterRoot(file, args, { home, tmpDir, signal = 'SIGTERM', when = null, delayMs = 0, before = null }) {
  const child = spawn(process.execPath, [file, ...args], { env: envOf(home, tmpDir), stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, signal: sig })));
  try {
    const root = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        out += d;
        const m = /^fake \w+ root: (.+)\n/m.exec(out);
        if (m && (!when || when.test(out))) resolve(m[1]);
      });
      exited.then(() => reject(new Error(`exited before printing its root\n${out}${err}`)));
    });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const written = existsSync(root) ? await fsp.readdir(root) : [];
    await before?.(root);
    child.kill(signal);
    return { root, written, ...(await exited), out, err };
  } finally {
    clearTimeout(kill);
  }
}

test('insideRealRoot: the same path or under it by whole parts, as written or through links, letter case folded', async () => {
  const home = await tmp('office-sim-fake-home-');
  const real = path.join(home, '.codex');
  await fsp.mkdir(real);
  const link = path.join(await tmp('office-sim-fake-link-'), 'root');
  await fsp.symlink(real, link);
  for (const p of [real, path.join(real, 'a'), path.join(real, 'not', 'yet'), link, path.join(link, 'not-yet')]) {
    assert.equal(insideRealRoot(p, real), true, p);
  }
  for (const p of [home, path.join(home, '.codex-old'), path.join(home, '.codexx', 'a'), path.join(home, 'x', '.codex')]) {
    assert.equal(insideRealRoot(p, real), false, p);
  }
  if (existsSync(path.join(home, '.CODEX'))) { // a case-insensitive file system (APFS, NTFS)
    assert.equal(insideRealRoot(path.join(home, '.CODEX'), real), true);
    assert.equal(insideRealRoot(path.join(home, '.Codex', 'not-yet'), real), true);
    assert.equal(insideRealRoot(path.join(home, '.CODEX-old'), real), false);
  }
  // a real root that does not exist yet: still matched through its nearest existing folder (and in another letter case
  // where the file system ignores it: there realpath cannot give the stored case, the fold does)
  const later = path.join(home, '.gemini');
  assert.equal(insideRealRoot(path.join(later, 'antigravity-cli'), later), true);
  assert.equal(insideRealRoot(path.join(home, '.gemini2'), later), false);
  if (existsSync(path.join(home, '.CODEX'))) assert.equal(insideRealRoot(path.join(home, '.GEMINI', 'x'), later), true);
});

test('insideRealRoot: a link inside a temp folder, a real root that is a dangling link and a firmlink alias', async () => {
  const home = await tmp('office-sim-fake-home-');
  const real = path.join(home, '.codex');
  await fsp.mkdir(path.join(real, 'sessions'), { recursive: true });
  // a temp root whose write folder is a link into the real root (also a dangling one): what is written below follows it
  const root = await tmp('office-sim-fake-root-');
  await fsp.symlink(path.join(real, 'sessions'), path.join(root, 'sessions'));
  await fsp.symlink(path.join(real, 'session_index.jsonl'), path.join(root, 'session_index.jsonl'));
  for (const p of [path.join(root, 'sessions'), path.join(root, 'sessions', '2026', '10', '21'), path.join(root, 'session_index.jsonl')]) {
    assert.equal(insideRealRoot(p, real), true, p);
  }
  assert.equal(insideRealRoot(root, real), false, 'the temp root itself is not inside');
  // the real root is a dangling link (a dotfiles link to a folder not made yet): its target is the real root, with an
  // absolute or a relative target (relative to the link's own folder, also when that folder is reached through a link)
  const store = await tmp('office-sim-fake-store-');
  const absHome = await tmp('office-sim-fake-home-');
  await fsp.symlink(path.join(store, 'abs', 'codex'), path.join(absHome, '.codex'));
  const relHome = path.join(store, 'home');
  await fsp.mkdir(relHome);
  await fsp.symlink(path.join('..', 'rel', 'codex'), path.join(relHome, '.codex'));
  const homeLink = path.join(await tmp('office-sim-fake-link-'), 'home');
  await fsp.symlink(relHome, homeLink);
  for (const [realRoot, target] of [[path.join(absHome, '.codex'), path.join(store, 'abs', 'codex')],
    [path.join(relHome, '.codex'), path.join(store, 'rel', 'codex')], [path.join(homeLink, '.codex'), path.join(store, 'rel', 'codex')]]) {
    assert.equal(insideRealRoot(target, realRoot), true, `${realRoot} -> ${target}`);
    assert.equal(insideRealRoot(path.join(target, 'sub'), realRoot), true, `${realRoot} -> ${target}/sub`);
    assert.equal(insideRealRoot(path.join(path.dirname(target), 'codex-other'), realRoot), false, realRoot);
  }
  // macOS firmlinks: /System/Volumes/Data<home> is the same folder as <home>, but realpath keeps the alias
  const alias = firmlinkAlias(home);
  if (alias) {
    for (const p of [path.join(alias, '.codex'), path.join(alias, '.codex', 'not-yet'), path.join(alias, '.CODEX', 'x'),
      path.join(alias, '.gemini', 'x')]) {
      assert.equal(insideRealRoot(p, p.includes('.gemini') ? path.join(home, '.gemini') : real), true, p);
    }
    for (const p of [alias, path.join(alias, '.codex-old'), path.join(alias, 'x', '.codex')]) assert.equal(insideRealRoot(p, real), false, p);
    assert.equal(insideRealRoot(path.join(alias, '.gemini2'), path.join(home, '.gemini')), false);
  }
});

for (const [name, s] of Object.entries(SCRIPTS)) {
  test(`fake-${name}-append refuses its real root through a link, a path under it, a new path and another letter case`, async () => {
    const home = await tmp('office-sim-fake-home-');
    const realDir = path.join(home, s.dir);
    await fsp.mkdir(realDir);
    const link = path.join(await tmp('office-sim-fake-link-'), 'root');
    await fsp.symlink(realDir, link);
    const homeLink = path.join(await tmp('office-sim-fake-link-'), 'home');
    await fsp.symlink(home, homeLink);
    const roots = [realDir, link, path.join(link, 'not-yet'), path.join(realDir, 'not-yet', 'deeper'), path.join(homeLink, s.dir)];
    const upper = path.join(home, s.dir.toUpperCase());
    if (existsSync(upper)) { // APFS (case-insensitive): another letter case is the same folder
      roots.push(upper, path.join(home, capital(s.dir), 'x'), path.join(homeLink, s.dir.toUpperCase(), 'not-yet'));
    }
    const line = new RegExp(`refusing to write into the real ~/\\${s.dir}: pass a temp folder \\(or no --root\\)`);
    for (const root of roots) {
      const r = await runScript(s.file, ['--root', root, '--cwd', '/work/fake', '--step-ms', '0'], home);
      assert.equal(r.code, 2, `${root}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, line);
      assert.equal(r.stdout, '', 'nothing started');
    }
    assert.deepEqual(await fsp.readdir(realDir), [], 'nothing was written into the real root');
    if (existsSync(upper)) { // the real root not made yet: a new folder in another letter case would become it
      await fsp.rmdir(realDir);
      const r = await runScript(s.file, ['--root', path.join(home, capital(s.dir), 'x'), '--cwd', '/work/fake', '--step-ms', '0'], home);
      assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, line);
      assert.deepEqual(await fsp.readdir(home), [], 'no root was made');
    }
    const help = await runScript(s.file, ['--help'], home);
    assert.equal(help.code, 0);
    assert.match(help.stdout, new RegExp(`never the real ~/\\${s.dir}`));
    if (name !== 'grok') assert.match(help.stdout, /also not through a link or in another letter case/);
  });

  test(`fake-${name}-append refuses a link in --root into its real root, a dangling real-root link's target and a firmlink alias`, async () => {
    const line = new RegExp(`refusing to write into the real ~/\\${s.dir}`);
    const refused = async (root, home, what) => {
      const r = await runScript(s.file, ['--root', root, '--cwd', '/work/fake', '--step-ms', '0', ...s.extra], home);
      assert.equal(r.code, 2, `${what}: ${root}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, line, what);
      assert.equal(r.stdout, '', `${what}: nothing started`);
    };
    // a link planted in a temp --root (a "mixed" root): the folders and files written below it are in the real root
    const home = await tmp('office-sim-fake-home-');
    const realDir = path.join(home, s.dir);
    for (const rel of s.links) if (!rel.endsWith('.jsonl')) await fsp.mkdir(path.join(realDir, rel), { recursive: true });
    await fsp.writeFile(path.join(realDir, s.links[0], 'REAL'), 'REAL DATA');
    if (name === 'antigravity') await fsp.writeFile(path.join(realDir, 'antigravity-cli', 'jetbox_summaries_proto.pb'), 'REAL SUMMARIES');
    const before = await tree(realDir);
    for (const rel of s.links) {
      const root = await tmp('office-sim-fake-root-');
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.symlink(path.join(realDir, rel), path.join(root, rel)); // codex: session_index.jsonl is a dangling link
      await refused(root, home, `link ${rel}`);
    }
    assert.deepEqual(await tree(realDir), before, 'the real root is as it was');
    // the real root is a dangling link (a dotfiles link to a folder not made yet): its target is not a temp folder
    const linkHome = await tmp('office-sim-fake-home-');
    const target = path.join(await tmp('office-sim-fake-store-'), 'data');
    await fsp.symlink(target, path.join(linkHome, s.dir));
    for (const root of [target, path.join(target, 'sub')]) await refused(root, linkHome, 'dangling real root');
    assert.equal(existsSync(target), false, 'the link target was not made');
    // macOS: the firmlink alias of the fake home (the real root there, also one not made yet)
    const alias = firmlinkAlias(home);
    if (alias) {
      for (const root of [path.join(alias, s.dir), path.join(alias, s.dir, 'new'), path.join(alias, s.dir.toUpperCase(), 'x')]) {
        await refused(root, home, 'alias');
      }
      assert.deepEqual(await tree(realDir), before, 'the real root is as it was');
      const emptyHome = await tmp('office-sim-fake-home-');
      const emptyAlias = firmlinkAlias(emptyHome);
      if (emptyAlias) await refused(path.join(emptyAlias, s.dir, 'x'), emptyHome, 'alias, real root not made yet');
      assert.deepEqual(await fsp.readdir(emptyHome), [], 'no root was made');
    }
  });
}

for (const [name, s] of Object.entries(SCRIPTS)) {
  test(`fake-${name}-append: SIGTERM (and Ctrl+C) remove the temp root it made, SIGTERM leaves a given --root`, async () => {
    const home = await tmp('office-sim-fake-home-');
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const tmpDir = await tmp('office-sim-fake-tmp-');
      const r = await stopAfterRoot(s.file, ['--cwd', '/work/fake', '--step-ms', '5000'], { home, tmpDir, signal });
      assert.equal(path.dirname(r.root), tmpDir, 'the default root is a new temp folder');
      assert.ok(r.written.length > 0, `it had started writing\n${r.out}${r.err}`);
      assert.deepEqual([r.code, r.signal], [0, null], `${signal}\n${r.out}${r.err}`);
      assert.equal(existsSync(r.root), false, `${signal}: the temp root is gone`);
      assert.deepEqual(await fsp.readdir(tmpDir), []);
    }
    // a valid --root (a temp folder that does not exist yet): the script writes there, SIGTERM stops it and keeps it
    const given = path.join(await tmp('office-sim-fake-root-'), 'root');
    const r = await stopAfterRoot(s.file, ['--root', given, '--cwd', '/work/fake', '--step-ms', '5000'],
      { home, tmpDir: await tmp('office-sim-fake-tmp-') });
    assert.equal(r.root, given);
    assert.ok(r.written.length > 0, `it had started writing\n${r.out}${r.err}`);
    assert.deepEqual([r.code, r.signal], [0, null], `${r.out}${r.err}`);
    assert.deepEqual(await fsp.readdir(given), r.written, 'the given root stays as it was');
    assert.equal(existsSync(path.join(home, s.dir)), false, 'the fake home\'s real root was never made');
  });
}

test('a signal during writes (--step-ms 0 --loop): the writes under way finish, then the temp root is removed, exit 0', async () => {
  const runs = [];
  for (const [name, s] of Object.entries(SCRIPTS)) {
    for (const [i, signal] of ['SIGTERM', 'SIGINT', 'SIGTERM'].entries()) {
      runs.push((async () => {
        const tmpDir = await tmp('office-sim-fake-tmp-');
        // codex and grok write without pause once turn 1 is written; agy's results land 0.25-2 s apart (its own jitter),
        // so it is signalled a little after its 1.5 s start pause instead
        const agy = name === 'antigravity';
        const r = await stopAfterRoot(s.file, ['--cwd', '/work/fake', '--step-ms', '0', '--loop', ...s.extra],
          { home: await tmp('office-sim-fake-home-'), tmpDir, signal, when: agy ? null : /^turn 1 written$/m, delayMs: agy ? 1600 + 200 * i : 0 });
        return { at: `${name} ${signal}`, r, tmpDir };
      })());
    }
  }
  for (const { at, r, tmpDir } of await Promise.all(runs)) {
    const log = `${at}\n${r.out}${r.err}`;
    assert.deepEqual([r.code, r.signal], [0, null], log);
    assert.equal(r.err, '', `${log}: no unhandled write error`);
    assert.match(r.out, /\nstopped; the temp root was removed\n$/, log);
    assert.equal(existsSync(r.root), false, `${log}: the temp root is gone`);
    assert.deepEqual(await fsp.readdir(tmpDir), [], log);
  }
});

test('a temp root that could not be removed is named on SIGTERM (exit 1), not reported removed',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'a read-only folder does not stop rm here' }, async () => {
    const tmpDir = await tmp('office-sim-fake-tmp-');
    let locked = null;
    try {
      const r = await stopAfterRoot(SCRIPTS.codex.file, ['--cwd', '/work/fake', '--step-ms', '5000'], {
        home: await tmp('office-sim-fake-home-'), tmpDir, before: async (root) => {
          const [file] = (await fsp.readdir(root, { recursive: true })).filter((p) => p.endsWith('.jsonl'));
          locked = path.dirname(path.join(root, file));
          await fsp.chmod(locked, 0o500); // its rollout file cannot be unlinked
        },
      });
      assert.deepEqual([r.code, r.signal], [1, null], `${r.out}${r.err}`);
      assert.doesNotMatch(r.out, /removed/);
      assert.match(r.err, new RegExp(`stopped; the temp root could not be removed: ${r.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(existsSync(r.root), true);
    } finally {
      if (locked) await fsp.chmod(locked, 0o700);
    }
  });
