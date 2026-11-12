// W7 (launch readiness, contract 6.3): plugin/.claude-plugin/plugin.json carries the version of package.json. When
// publish.yml bumps the version by itself (a real release whose package.json still has the version that is on npm),
// the four lines after `npm version` put the manifest into the release commit and move the tag onto it. These tests
// take those lines out of the workflow file and run them as written: the node line on copies of the two files, and all
// four in a throwaway git repository that stands at the point right after `npm version` (npm itself is not run: no
// network, no registry). Everything is under os.tmpdir(); this checkout's git state is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = 'plugin/.claude-plugin/plugin.json';
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const MANIFEST_TEXT = fs.readFileSync(path.join(REPO, MANIFEST), 'utf8');
const NEXT = '97.98.99';

const wfLines = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8').split('\n').map((l) => l.trim());
const bumpAt = wfLines.indexOf('NEW_VER=$(npm version "$BUMP" -m "chore(release): v%s [skip ci]")');
// what follows the bump up to the end of that branch, without comment lines
const SYNC_LINES = wfLines.slice(bumpAt + 1, wfLines.indexOf('fi', bumpAt)).filter((l) => l && !l.startsWith('#'));
const NODE_LINE = SYNC_LINES[0] ?? '';
const SYNC_JS = NODE_LINE.slice("node -e '".length, -1);

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
// a folder that holds what the workflow's checkout holds for these lines: package.json (bumped or not) and the manifest
function tmpCheckout(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-release-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, path.dirname(MANIFEST)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ ...PKG, version }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, MANIFEST), MANIFEST_TEXT);
  return dir;
}
const changedLines = (before, now) => {
  const a = before.split('\n');
  const b = now.split('\n');
  assert.equal(b.length, a.length, 'the same number of lines');
  return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]]]));
};

test('the lines after the bump are the manifest write, git add, an amend and the tag move', () => {
  assert.ok(bumpAt > 0, 'the real-release bump line is in publish.yml');
  assert.equal(SYNC_LINES.length, 4, SYNC_LINES.join('\n'));
  assert.ok(NODE_LINE.startsWith("node -e '") && NODE_LINE.endsWith("'"), NODE_LINE);
  assert.equal(SYNC_JS.includes("'"), false, 'the script is one single-quoted shell word');
  assert.deepEqual(SYNC_LINES.slice(1), [`git add ${MANIFEST}`, 'git commit --amend --no-edit',
    'git tag -f -a "$NEW_VER" -m "chore(release): $NEW_VER [skip ci]"']);
});

test('the manifest line, run as written: plugin.json gets the version of package.json and no other byte changes', () => {
  const dir = tmpCheckout(NEXT);
  const run = () => spawnSync(process.execPath, ['-e', SYNC_JS], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '', 'it prints nothing (the step captures no output of it, but a release log stays short)');
  const now = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
  assert.deepEqual(changedLines(MANIFEST_TEXT, now), [[`  "version": "${PKG.version}",`, `  "version": "${NEXT}",`]]);
  assert.equal(JSON.parse(now).version, NEXT);
  assert.ok(now.endsWith('}\n'));
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), `${JSON.stringify({ ...PKG, version: NEXT }, null, 2)}\n`, 'package.json is only read');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'), now, 'a second run changes nothing');
  // the same version: the file keeps its bytes (so the committed manifest is in the form the line writes)
  const same = tmpCheckout(PKG.version);
  assert.equal(spawnSync(process.execPath, ['-e', SYNC_JS], { cwd: same, encoding: 'utf8' }).status, 0);
  assert.equal(fs.readFileSync(path.join(same, MANIFEST), 'utf8'), MANIFEST_TEXT);
  // no manifest: the line fails, and with it the step (the runner's shell stops at the first failing line)
  const bare = tmpCheckout(NEXT);
  fs.rmSync(path.join(bare, MANIFEST));
  assert.notEqual(spawnSync(process.execPath, ['-e', SYNC_JS], { cwd: bare, encoding: 'utf8' }).status, 0);
  assert.equal(fs.existsSync(path.join(bare, MANIFEST)), false, 'and writes no file');
});

test('the four lines, run as written right after a bump: one release commit with both files, the tag on it, a clean tree', (t) => {
  if (process.platform === 'win32') return t.skip('the workflow runs these lines in a POSIX shell');
  const repo = tmpCheckout(PKG.version);
  // git without the caller's GIT_* variables, user config, hooks or signing
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: repo, XDG_CONFIG_HOME: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'office-sim-test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'office-sim-test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    NEW_VER: `v${NEXT}`,
  };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return r.stdout.trim();
  };
  if (spawnSync('git', ['init', '-q'], { cwd: repo, env }).status !== 0) return t.skip('git is not available');
  git('add', '-A');
  git('commit', '-q', '-m', 'the commit before the release');
  // where `npm version <bump> -m "chore(release): v%s [skip ci]"` leaves the checkout: package.json bumped and
  // committed alone, and an annotated tag on that commit
  const message = `chore(release): v${NEXT} [skip ci]`;
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ ...PKG, version: NEXT }, null, 2)}\n`);
  git('commit', '-q', '-am', message);
  git('tag', '-m', message, `v${NEXT}`);
  const bumpOnly = git('rev-parse', 'HEAD');
  assert.equal(JSON.parse(git('show', `HEAD:${MANIFEST}`)).version, PKG.version, 'the bump alone leaves the manifest behind');

  const r = spawnSync('sh', ['-e', '-c', SYNC_LINES.join('\n')], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const head = git('rev-parse', 'HEAD');
  assert.notEqual(head, bumpOnly, 'the release commit was amended');
  assert.equal(git('rev-list', '--count', 'HEAD'), '2', 'still one release commit on top: nothing was added beside it');
  assert.deepEqual(git('show', '--format=', '--name-only', 'HEAD').split('\n').sort(), ['package.json', MANIFEST]);
  assert.equal(git('log', '-1', '--format=%s'), message, 'the message is kept ([skip ci] included)');
  assert.equal(JSON.parse(git('show', 'HEAD:package.json')).version, NEXT);
  assert.equal(JSON.parse(git('show', `HEAD:${MANIFEST}`)).version, NEXT);
  assert.equal(git('rev-parse', `v${NEXT}^{commit}`), head, 'the tag names the amended commit, not the one npm tagged');
  assert.deepEqual(git('tag', '--list').split('\n'), [`v${NEXT}`]);
  assert.equal(git('cat-file', '-t', `v${NEXT}`), 'tag', 'still an annotated tag, as npm made it');
  assert.equal(git('tag', '--list', '--format=%(contents:subject)', `v${NEXT}`), message, 'with the message npm gives it');
  assert.equal(git('status', '--porcelain'), '', 'nothing is left uncommitted for the publish step');
});
