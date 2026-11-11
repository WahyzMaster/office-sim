// 배포 워크플로 (.github/workflows): 릴리스는 수동 실행만 (plan D17), Pages 데모는 scripts/build-demo.mjs 로 만든다.
// YAML 파서 없이 글자로만 확인한다 (의존성 없음). 파일만 읽고 아무것도 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// 최상위 키 하나의 블록 (다음 최상위 키 전까지)
function topBlock(yaml, key) {
  const lines = yaml.split('\n');
  const from = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  assert.notEqual(from, -1, `top-level key ${key}`);
  let to = from + 1;
  while (to < lines.length && (lines[to] === '' || /^[\s#]/.test(lines[to]))) to += 1;
  return lines.slice(from, to).join('\n');
}

// 주석이 아닌 줄만
const code = (yaml) => yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('publish.yml runs on workflow_dispatch only, with dry_run defaulting to true', () => {
  const wf = code(read('.github/workflows/publish.yml'));
  const on = topBlock(wf, 'on');
  const triggers = on.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
  assert.deepEqual(triggers, ['workflow_dispatch:'], 'the only trigger');
  assert.match(on, /\n {6}dry_run:\n(?: {8}.*\n)*? {8}default: true\n/);
  assert.match(on, /\n {8}type: boolean/);
  assert.doesNotMatch(wf, /^\s*push:/m, 'no push trigger');
  assert.doesNotMatch(wf, /head_commit/, 'nothing reads a push payload');
  assert.doesNotMatch(wf, /github\.event_name/, 'nothing branches on the event name');
  assert.doesNotMatch(wf, /\[skip release\]/, 'the push-era opt-out marker is gone');
});

test('publish.yml publishes, pushes and releases only when dry_run is false', () => {
  const wf = code(read('.github/workflows/publish.yml'));
  const jobs = topBlock(wf, 'jobs');
  // 단계별 블록: "      - " 로 시작한다
  const steps = jobs.split(/\n(?= {6}- )/).slice(1);
  const named = (name) => steps.find((s) => s.includes(`name: ${name}`));
  for (const name of ['Publish package to npm', 'Push release commit and tag to master', 'Create GitHub Release']) {
    const step = named(name);
    assert.ok(step, name);
    assert.match(step, /\n {8}if: inputs\.dry_run == false\n/, `${name} is gated on dry_run == false`);
  }
  const ifs = jobs.match(/^\s+if: .*$/gm) ?? [];
  assert.equal(ifs.length, 4, 'the job condition (D23, below) and exactly the three gated steps');
  assert.equal(ifs.filter((l) => /^ {8}if: /.test(l)).length, 3, 'three step conditions');
  // 테스트와 버전 계산, pack 미리보기는 언제나 돈다
  assert.match(jobs, /\n {6}- run: npm test\n/);
  assert.match(jobs, /\n {6}- run: npm pack --dry-run\n/);
  const version = named('Determine version bump from git changes');
  assert.match(version, /if \[ "\$\{\{ inputs\.dry_run \}\}" = "true" \]; then/);
  assert.match(version, /npm version "\$BUMP" --no-git-tag-version/);
  assert.match(version, /npm version "\$BUMP" -m "chore\(release\): v%s \[skip ci\]"/);
  assert.match(version, /BUMP="manual"/);
});

test('publish.yml (D23): a real release runs only on refs/heads/master; a dry run may run on any ref', () => {
  const raw = read('.github/workflows/publish.yml');
  const jobs = topBlock(code(raw), 'jobs');
  // one job, one job-level condition, written before the steps
  assert.deepEqual(jobs.split('\n').filter((l) => /^ {2}\S/.test(l)), ['  publish:']);
  const jobIfs = jobs.match(/^ {4}if: .*$/gm) ?? [];
  assert.deepEqual(jobIfs, ["    if: inputs.dry_run != false || github.ref == 'refs/heads/master'"]);
  assert.ok(jobs.indexOf(jobIfs[0]) < jobs.indexOf('\n    steps:\n'), 'the condition is on the job, not on a step');
  // the condition is the complement of the step gate (inputs.dry_run == false) unless the ref is master: evaluated
  // here as written (the operators and quoting it uses read the same in JavaScript)
  const expr = jobIfs[0].replace(/^ {4}if: /, '');
  const runs = (dryRun, ref) => vm.runInNewContext(expr, { inputs: { dry_run: dryRun }, github: { ref } });
  for (const ref of ['refs/heads/master', 'refs/heads/feat/x', 'refs/heads/main', 'refs/tags/v0.12.0', 'refs/pull/7/merge']) {
    assert.equal(runs(true, ref), true, `a dry run on ${ref}`);
  }
  assert.equal(runs(false, 'refs/heads/master'), true, 'a real release on master');
  for (const ref of ['refs/heads/feat/x', 'refs/heads/main', 'refs/heads/master-2', 'refs/heads/x/master', 'refs/tags/master', 'refs/tags/v0.12.0', 'master', '']) {
    assert.equal(runs(false, ref), false, `a real release on ${ref || 'no ref'} must not run`);
  }
  // so no publishing step can run off master: each is gated on dry_run == false, which the job allows only there
  assert.doesNotMatch(jobs, /github\.ref_name|github\.head_ref|github\.base_ref/, 'the full ref is compared, not a short name');
  // the header says so, and no longer says the ref is not checked
  const header = raw.split('\nname: ')[0];
  assert.match(header, /dry_run=false[^\n]*\n?[^\n]*refs\/heads\/master/);
  assert.doesNotMatch(header, /does not check which ref/);
});

// Contract 6.3: plugin/.claude-plugin/plugin.json carries the version of package.json (test/plugin-files.test.mjs pins
// it). The automatic bump of a real release therefore puts the manifest into the release commit, before anything is
// published or pushed. test/release-plugin-version.test.mjs runs these lines as written.
test('publish.yml: the auto-bump release commit carries the plugin manifest, and the tag moves onto that commit', () => {
  const raw = read('.github/workflows/publish.yml');
  const steps = topBlock(code(raw), 'jobs').split(/\n(?= {6}- )/).slice(1);
  const stepAt = (name) => steps.findIndex((s) => s.includes(name));
  const lines = steps[stepAt('name: Determine version bump from git changes')].split('\n').map((l) => l.trim());
  const once = (what) => {
    const hits = lines.flatMap((l, i) => ((typeof what === 'string' ? l === what : what.test(l)) ? [i] : []));
    assert.equal(hits.length, 1, `${what}: exactly once in the version step`);
    return hits[0];
  };
  const dryIf = once('if [ "${{ inputs.dry_run }}" = "true" ]; then');
  const dryBump = once('NEW_VER=$(npm version "$BUMP" --no-git-tag-version)');
  const realElse = lines.indexOf('else', dryIf);
  const realBump = once('NEW_VER=$(npm version "$BUMP" -m "chore(release): v%s [skip ci]")');
  const manifest = once(/^node -e '[^']*'$/);
  const add = once('git add plugin/.claude-plugin/plugin.json');
  const amend = once('git commit --amend --no-edit');
  const tag = once('git tag -f -a "$NEW_VER" -m "chore(release): $NEW_VER [skip ci]"');
  assert.ok(dryIf < dryBump && dryBump < realElse && realElse < realBump, 'the dry-run branch, then the real one');
  assert.deepEqual([manifest, add, amend, tag], [realBump + 1, realBump + 2, realBump + 3, realBump + 4], 'directly after the bump, in this order');
  assert.equal(lines[tag + 1], 'fi', 'they end the real-release branch');
  // the manifest line names both files and takes the version from package.json, not from a shell or workflow value
  assert.ok(lines[manifest].includes('"plugin/.claude-plugin/plugin.json"'));
  assert.ok(lines[manifest].includes('"package.json"'));
  assert.doesNotMatch(lines[manifest], /\$[A-Z_{]/, 'no shell variable and no workflow expression inside the script');
  // a dry run changes no manifest, no commit and no tag
  for (const l of lines.slice(dryIf, realElse)) assert.doesNotMatch(l, /plugin\.json|--amend|git add|git tag/, l);
  // all of it happens before the package is published (so the published gitHead is the commit that is pushed) and
  // before the push; no other step touches the manifest
  assert.ok(stepAt('name: Determine version bump from git changes') < stepAt('name: Publish package to npm'));
  assert.ok(stepAt('name: Publish package to npm') < stepAt('name: Push release commit and tag to master'));
  assert.equal(steps.filter((s) => s.includes('plugin.json')).length, 1);
  // the header says so
  assert.match(raw.split('\nname: ')[0], /plugin\/\.claude-plugin\/plugin\.json/);
});

test('pages.yml builds the demo site with scripts/build-demo.mjs on Node 24', () => {
  const wf = code(read('.github/workflows/pages.yml'));
  assert.match(wf, /run: node scripts\/build-demo\.mjs --out _site\n/);
  assert.match(wf, /uses: actions\/setup-node@v\d+\n\s+with:\n\s+node-version: 24\n/);
  assert.ok(wf.indexOf('actions/checkout@') < wf.indexOf('actions/setup-node@'), 'checkout first');
  assert.ok(wf.indexOf('actions/setup-node@') < wf.indexOf('scripts/build-demo.mjs'), 'Node before the build');
  assert.ok(wf.indexOf('scripts/build-demo.mjs') < wf.indexOf('actions/upload-pages-artifact@'), 'build before upload');
  assert.match(wf, /uses: actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: _site\n/);
  assert.doesNotMatch(wf, /cp -R public|cp _site\/office\.html/, 'the bare fragment is no longer copied as index.html');
});
