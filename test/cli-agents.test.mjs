// P5a CLI (contract 6, 4.0.1): --agents, --codex-root, --grok-root, --antigravity-root, and the agents lines the bin
// prints after the URL. The bin always runs against a temp --claude-root; the other roots are never opened.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { until } from './fixtures/sse.mjs';

const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const HOME = os.homedir();
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-cli-agents-'));
  tmpDirs.push(d);
  return d;
}

// ---- parseArgs ----------------------------------------------------------------------------------------------

test('parseArgs --agents: a comma list of known ids, deduped; = form; spaces around ids are trimmed', () => {
  assert.deepEqual(parseArgs(['--agents', 'claude-code']), { agents: ['claude-code'] });
  assert.deepEqual(parseArgs(['--agents', 'codex,claude-code,codex']), { agents: ['codex', 'claude-code'] });
  assert.deepEqual(parseArgs(['--agents=grok, antigravity']), { agents: ['grok', 'antigravity'] });
  assert.deepEqual(parseArgs(['--agents', 'codex', '--agents', 'grok']), { agents: ['grok'] }, 'the last one wins like other options');
});

test('parseArgs --agents rejects unknown ids, empty items and a missing value', () => {
  assert.throws(() => parseArgs(['--agents', 'cursor']), /--agents: unknown agent "cursor" \(known: claude-code, codex, grok, antigravity\)/);
  assert.throws(() => parseArgs(['--agents', 'claude-code,Cursor']), /unknown agent "Cursor"/);
  for (const bad of [['--agents', ','], ['--agents', 'claude-code,'], ['--agents='], ['--agents', ' ']]) {
    assert.throws(() => parseArgs(bad), /--agents needs agent ids, comma-separated/, bad.join(' '));
  }
  assert.throws(() => parseArgs(['--agents']), /--agents needs a value/);
  assert.throws(() => parseArgs(['--agents', '--port']), /--agents needs a value/);
});

test('parseArgs --codex-root / --grok-root / --antigravity-root: ~ expanded, stored in roots by agent id', () => {
  assert.deepEqual(parseArgs(['--codex-root', '~/c']), { roots: { codex: path.join(HOME, 'c') } });
  assert.deepEqual(parseArgs(['--grok-root=/g', '--antigravity-root', '~', '--codex-root', '/c']),
    { roots: { grok: '/g', antigravity: HOME, codex: '/c' } });
  assert.deepEqual(parseArgs(['--codex-root', '/a', '--codex-root', '/b']), { roots: { codex: '/b' } });
  assert.throws(() => parseArgs(['--grok-root']), /--grok-root needs a value/);
  assert.throws(() => parseArgs(['--antigravity-root=']), /--antigravity-root needs a directory/);
});

test('parseArgs: the new keys appear only when their flags do; --claude-root / --root still set root', () => {
  assert.deepEqual(parseArgs(['--port', '0']), { port: 0 });
  assert.deepEqual(parseArgs(['--claude-root', '/x', '--agents', 'claude-code', '--grok-root', '/g']),
    { root: '/x', agents: ['claude-code'], roots: { grok: '/g' } });
  assert.deepEqual(parseArgs(['--root', '~/p']), { root: path.join(HOME, 'p') });
});

test('USAGE lists --agents and the three adapter roots', () => {
  for (const flag of ['--agents <id,id>', '--codex-root <dir>', '--grok-root <dir>', '--antigravity-root <dir>']) {
    assert.ok(USAGE.includes(flag), flag);
  }
  assert.match(USAGE, /claude-code, codex, grok, antigravity/);
});

// ---- bin ----------------------------------------------------------------------------------------------------

async function runBin(args) {
  // HOME is an empty temp dir: the bin's default roots (~/.grok since P5c) never reach the real folders
  const env = { ...process.env, HOME: await tmp() };
  const child = spawn(process.execPath, [BIN, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out, err: () => err };
}

async function linesUntil(run, pred) {
  try {
    await until(() => pred(run.out().split('\n')), 5000);
  } finally {
    run.child.kill('SIGINT');
  }
  assert.equal(await run.exited, 0, run.err());
  return run.out().split('\n').filter(Boolean);
}

test('bin prints "agents claude-code" right after the URL line', async () => {
  const root = await tmp();
  const run = await runBin(['--claude-root', root]);
  const lines = await linesUntil(run, (ls) => ls.some((l) => l.startsWith('office-sim: agents')));
  assert.match(lines[0], /^office-sim: http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(lines[1], 'office-sim: agents claude-code');
});

test('bin --agents: one "is not implemented yet" line per requested unimplemented id, "agents none" when nothing runs', async () => {
  const root = await tmp();
  const mixed = await runBin(['--claude-root', root, '--agents', 'antigravity,claude-code,codex']);
  let lines = await linesUntil(mixed, (ls) => ls.includes('office-sim: antigravity is not implemented yet'));
  assert.deepEqual(lines.slice(1, 4), ['office-sim: agents claude-code', 'office-sim: codex is not implemented yet', 'office-sim: antigravity is not implemented yet']);
  const none = await runBin(['--claude-root', root, '--agents', 'antigravity', '--antigravity-root', path.join(root, 'nope')]);
  lines = await linesUntil(none, (ls) => ls.includes('office-sim: antigravity is not implemented yet'));
  assert.deepEqual(lines.slice(1, 3), ['office-sim: agents none', 'office-sim: antigravity is not implemented yet']);
});

test('bin with a missing --claude-root: "agents none", one stderr log line without the path, server still up', async () => {
  const parent = await tmp();
  const missing = path.join(parent, 'missing-projects');
  const run = await runBin(['--claude-root', missing]);
  const lines = await linesUntil(run, (ls) => ls.includes('office-sim: agents none'));
  assert.equal(lines[1], 'office-sim: agents none');
  assert.match(run.err(), /\[office-sim\] claude-code: root not found, adapter off\n/);
  assert.ok(!run.err().includes(missing), 'the log line carries no path');
});

test('bin --agents with an unknown id exits 2 with the usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--agents', 'claude-code,cursor'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith('office-sim: --agents: unknown agent "cursor" (known: claude-code, codex, grok, antigravity)\n\nUsage: office-sim'), r.stderr);
  assert.equal(r.stdout, '');
});
