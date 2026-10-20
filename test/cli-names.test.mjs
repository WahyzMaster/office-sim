// office-sim 이름: CLI 도움말과 접두어, --claude-root (--root 는 별칭), --auth 쿠키 이름 osim_<port>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { createAuth } from '../src/server-guard.mjs';

const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));

test('USAGE starts with "Usage: office-sim" and lists --claude-root first, --root as its alias', () => {
  assert.ok(USAGE.startsWith('Usage: office-sim [options]\n'), USAGE.split('\n')[0]);
  const canonical = USAGE.indexOf('--claude-root <dir>');
  const alias = USAGE.indexOf('--root <dir>');
  assert.ok(canonical >= 0 && alias >= 0 && canonical < alias, 'claude-root is listed before root');
  assert.match(USAGE, /--claude-root <dir>\s+Claude Code transcripts root \(default ~\/\.claude\/projects\)/);
  assert.match(USAGE, /\n {2}--root <dir>\s+alias of --claude-root\n/);
  assert.doesNotMatch(USAGE, /claude-office/);
});

test('parseArgs: --claude-root and --root set the same option (root)', () => {
  assert.deepEqual(parseArgs(['--claude-root', '/x/projects']), { root: '/x/projects' });
  assert.deepEqual(parseArgs(['--root', '/x/projects']), { root: '/x/projects' });
  assert.deepEqual(parseArgs(['--claude-root=~/p']), { root: path.join(os.homedir(), 'p') });
  assert.deepEqual(parseArgs(['--root=~/p']), parseArgs(['--claude-root=~/p']));
  // 같은 옵션이라 나중 것이 이긴다
  assert.deepEqual(parseArgs(['--root', '/a', '--claude-root', '/b']), { root: '/b' });
  assert.deepEqual(parseArgs(['--claude-root', '/a', '--root', '/b']), { root: '/b' });
  assert.throws(() => parseArgs(['--claude-root']), /--claude-root needs a value/);
  assert.throws(() => parseArgs(['--claude-root=']), /--claude-root needs a directory/);
  assert.throws(() => parseArgs(['--claude-root', '--port']), /--claude-root needs a value/);
});

test('--auth cookie is named osim_<port>', () => {
  const auth = createAuth('tok', () => 4317);
  assert.equal(auth.setCookie(), 'osim_4317=tok; HttpOnly; SameSite=Strict; Path=/');
  assert.equal(auth.allowed({ headers: { cookie: 'osim_4317=tok' } }), true);
  assert.equal(auth.allowed({ headers: { cookie: 'co_4317=tok' } }), false, 'the old cookie name no longer opens the API');
  assert.equal(auth.allowed({ headers: { cookie: 'osim_4318=tok' } }), false, 'another port');
});

test('bin/office-sim.mjs: --help prints the usage, a bad option is reported with the office-sim: prefix', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, USAGE);
  const bad = spawnSync(process.execPath, [BIN, '--nope'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.startsWith('office-sim: unknown option: --nope\n\nUsage: office-sim'), bad.stderr);
});
