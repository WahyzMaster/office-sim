// D3 (contract 0, 6): bin/office-sim.mjs is a stub. It imports no project module statically, prints one warning line on a
// Node below the supported floor (22), then runs src/cli-main.mjs. The old Node is faked in a child process by a
// --require preload written to a temp folder (it redefines process.versions.node), so the shipped code has no test hook.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { USAGE } from '../src/cli-args.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const BIN = here('../bin/office-sim.mjs');
const read = (rel) => fs.readFile(here(rel), 'utf8');
const warning = (v) => `office-sim: Node ${v} is older than the supported floor (22); continuing\n`;

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-stub-'));
  tmpDirs.push(d);
  return d;
}
let preloadFile = null;
async function preload() {
  if (!preloadFile) {
    preloadFile = path.join(await tmp(), 'fake-node-version.cjs');
    await fs.writeFile(preloadFile,
      "Object.defineProperty(process.versions, 'node', { value: process.env.OFFICE_SIM_TEST_NODE, enumerable: true, configurable: true });\n");
  }
  return preloadFile;
}
// the bin under a faked process.versions.node (null: the real one)
async function run(args, fakeVersion = null) {
  const pre = fakeVersion === null ? [] : ['--require', await preload()];
  const env = { ...process.env, HOME: await tmp() };
  if (fakeVersion !== null) env.OFFICE_SIM_TEST_NODE = fakeVersion;
  return spawnSync(process.execPath, [...pre, BIN, ...args], { encoding: 'utf8', timeout: 20_000, env });
}

test('the stub is short and has no static import: the warning comes before any project module is read', async () => {
  const src = await read('../bin/office-sim.mjs');
  assert.ok(src.startsWith('#!/usr/bin/env node\n'));
  assert.ok(src.split('\n').length <= 40, `${src.split('\n').length} lines`);
  assert.doesNotMatch(src, /^\s*import\s*(?!\()/m, 'no static import statement');
  assert.doesNotMatch(src, /^\s*export\s/m);
  assert.ok(src.includes("import('../src/cli-main.mjs')"), 'the real entry is loaded lazily');
  const check = src.indexOf('process.versions.node');
  const warn = src.indexOf('process.stderr.write(');
  assert.ok(check >= 0 && warn > check && src.indexOf('import(') > warn, 'version check, then the warning, then the first lazy import');
  const main = await read('../src/cli-main.mjs');
  assert.match(main, /^export async function main\(/m);
  assert.doesNotMatch(main, /import\.meta\.url/, 'paths come from the stub\'s own location, not from src/');
});

test('on a supported Node the stub prints no warning (--help: usage on stdout, empty stderr)', async () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'the suite runs on a supported Node');
  const real = await run(['--help']);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(real.stdout, USAGE);
  assert.equal(real.stderr, '');
  for (const v of ['22.0.0', '22.23.2', '24.13.0', '100.0.0']) {
    const r = await run(['--help'], v);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, USAGE, ''], v);
  }
});

test('below the floor the stub prints exactly one warning line to stderr and continues', async () => {
  for (const v of ['21.7.3', '20.11.1', '18.20.4', '9.11.2']) {
    const r = await run(['--help'], v);
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
    assert.equal(r.stdout, USAGE, `${v}: the real entry still ran`);
    assert.equal(r.stderr, warning(v), v);
  }
  // it is a warning, not a gate: the usual error handling follows it, once
  const bad = await run(['--nope'], '20.11.1');
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.startsWith(`${warning('20.11.1')}office-sim: unknown option: --nope\n\nUsage: office-sim`), bad.stderr);
  assert.equal(bad.stderr.split('older than the supported floor').length - 1, 1);
});

test('below the floor the server still starts, serves /healthz and stops on SIGTERM', {
  skip: process.platform === 'win32' ? 'POSIX signals' : false,
}, async () => {
  const home = await tmp();
  const args = ['--require', await preload(), BIN, '--port', '0', '--agents', 'claude-code', '--claude-root', home];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, OFFICE_SIM_TEST_NODE: '20.11.1' } });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no agents line within 15 s\nstderr: ${err}`)), 15_000);
      child.stdout.on('data', (c) => { out += c; if (out.includes('office-sim: agents')) resolve(); });
      exited.then((code) => reject(new Error(`exited (${code}) before the agents line\nstderr: ${err}`)));
    });
    const url = /^office-sim: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(out)?.[1];
    assert.ok(url, out);
    const res = await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    child.kill('SIGTERM');
    assert.equal(await exited, 0, err);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  assert.equal(err.split('\n')[0], warning('20.11.1').trimEnd(), err);
  assert.equal(err.split('older than the supported floor').length - 1, 1, 'printed once');
});

test('the Node floor reads the same everywhere: 22 supported, 22 and 24 tested, .nvmrc 24 for development', async () => {
  assert.equal(JSON.parse(await read('../package.json')).engines.node, '>=22');
  assert.equal((await read('../.nvmrc')).trim(), '24');
  const workflow = await read('../.github/workflows/test.yml');
  assert.match(workflow, /^ {8}node: \[22, 24\]$/m);
  const head = workflow.slice(0, workflow.indexOf('\nname:'));
  assert.match(head, /지원 하한은 Node 22/);
  assert.match(head, /\.nvmrc.*24.*개발/);
  assert.doesNotMatch(head, /하한은 Node 24/);
  const contract = await read('../docs/CONTRACT.md');
  const rules = contract.slice(contract.indexOf('## 0. Ground rules'), contract.indexOf('## 1. Layout'));
  assert.match(rules, /Node 22 or later/);
  assert.match(rules, /CI runs Node 22 and 24/);
  assert.match(rules, /`\.nvmrc` \(24\) is the development default/);
  assert.doesNotMatch(rules, /Node 24 or later/);
  // the skill and the READMEs are reworded by other work: only the fact is checked, a floor of 22 and never 24
  const asFloor = /Node(?:\.js)? 24(?:\+| or later| server| 이상)/;
  for (const rel of ['../skills/office/SKILL.md', '../README.md', '../README.ko.md']) {
    const text = await read(rel);
    assert.match(text, /Node(?:\.js)? 22/, rel);
    assert.doesNotMatch(text, asFloor, rel);
  }
});
