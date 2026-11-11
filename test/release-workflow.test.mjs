// 배포 워크플로 (.github/workflows): 릴리스는 수동 실행만 (plan D17), Pages 데모는 scripts/build-demo.mjs 로 만든다.
// YAML 파서 없이 글자로만 확인한다 (의존성 없음). 파일만 읽고 아무것도 실행하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.doesNotMatch(jobs, /^ {4}if:/m, 'no job-level condition');
  // 단계별 블록: "      - " 로 시작한다
  const steps = jobs.split(/\n(?= {6}- )/).slice(1);
  const named = (name) => steps.find((s) => s.includes(`name: ${name}`));
  for (const name of ['Publish package to npm', 'Push release commit and tag to master', 'Create GitHub Release']) {
    const step = named(name);
    assert.ok(step, name);
    assert.match(step, /\n {8}if: inputs\.dry_run == false\n/, `${name} is gated on dry_run == false`);
  }
  const ifs = jobs.match(/^\s+if: .*$/gm) ?? [];
  assert.equal(ifs.length, 3, 'exactly the three gated steps carry a condition');
  // 테스트와 버전 계산, pack 미리보기는 언제나 돈다
  assert.match(jobs, /\n {6}- run: npm test\n/);
  assert.match(jobs, /\n {6}- run: npm pack --dry-run\n/);
  const version = named('Determine version bump from git changes');
  assert.match(version, /if \[ "\$\{\{ inputs\.dry_run \}\}" = "true" \]; then/);
  assert.match(version, /npm version "\$BUMP" --no-git-tag-version/);
  assert.match(version, /npm version "\$BUMP" -m "chore\(release\): v%s \[skip ci\]"/);
  assert.match(version, /BUMP="manual"/);
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
