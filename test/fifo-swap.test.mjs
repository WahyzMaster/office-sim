// A FIFO renamed over a file between its lstat and its open (P5g review finding 9). Without O_NONBLOCK, open(2) of a
// FIFO that has no writer blocks in the libuv threadpool and the reader never settles: GrokMeta.check (events.jsonl and
// summary.json), and with it the Runner's rescan loop and close(), would hang. Every reader that lstat-s, opens with
// O_NOFOLLOW and re-checks the opened file must settle at once with "not read". Temp folders only; skipped on Windows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { closeSync, constants as FS, openSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { EventsTail, EVENTS_FILE } from '../src/adapters/grok/events.mjs';
import { SidecarWatcher } from '../src/core/sidecar.mjs';
import { SessionIndex, INDEX_FILE } from '../src/adapters/codex/titles.mjs';
import { readLine0 } from '../src/adapters/codex/line0.mjs';
import { createLineCounter } from '../src/adapters/antigravity/discover.mjs';

const SKIP = process.platform === 'win32' ? 'no mkfifo on Windows' : false;
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});

// target: a regular file with a line in it, and a FIFO next to it that is renamed over it on demand
async function setup(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-fifo-'));
  tmpDirs.push(dir);
  const target = path.join(dir, name);
  writeFileSync(target, '{"type":"tool_started","tool_name":"grep"}\n');
  const fifo = path.join(dir, 'swap.fifo');
  execFileSync('mkfifo', [fifo]);
  const st = await fsp.lstat(target);
  return { target, st, swap: () => renameSync(fifo, target) };
}

// the reader lstat-s the target, then the FIFO takes its place before the open
function swapAfterLstat(target, swap) {
  const orig = fsp.lstat;
  let done = false;
  fsp.lstat = async function raced(q, ...rest) {
    const st = await orig.call(this, q, ...rest);
    if (q === target && !done) {
      done = true;
      swap();
    }
    return st;
  };
  return () => { fsp.lstat = orig; };
}

// settles within 1 s, or 'blocked'. A blocked open is released afterwards by a writer, so the test process can exit.
async function settles(target, run) {
  let timer;
  const blocked = new Promise((resolve) => { timer = setTimeout(() => resolve('blocked'), 1000); });
  const p = run();
  try {
    return await Promise.race([p, blocked]);
  } finally {
    clearTimeout(timer);
    try {
      closeSync(openSync(target, FS.O_WRONLY | FS.O_NONBLOCK)); // ENXIO when no reader is waiting (the fixed case)
    } catch {}
    await p.catch(() => {});
  }
}

test('EventsTail: a FIFO swapped in between lstat and open is not read and does not block', { skip: SKIP }, async () => {
  const { target, swap } = await setup(EVENTS_FILE);
  const restore = swapAfterLstat(target, swap);
  try {
    assert.equal(await settles(target, () => new EventsTail().check(target)), null);
  } finally {
    restore();
  }
});

test('SidecarWatcher (summary.json, also on GrokMeta.check): a swapped-in FIFO is not read and does not block', { skip: SKIP }, async () => {
  const { target, swap } = await setup('summary.json');
  const w = new SidecarWatcher(() => [{ path: target, parse: () => ({ title: 'x' }) }]);
  const restore = swapAfterLstat(target, swap);
  try {
    assert.equal(await settles(target, () => w.check({ path: path.join(path.dirname(target), 'updates.jsonl') })), null);
  } finally {
    restore();
  }
});

test('Codex SessionIndex, readLine0 and the Antigravity line counter: a swapped-in FIFO does not block', { skip: SKIP }, async () => {
  const idx = await setup(INDEX_FILE);
  const restore = swapAfterLstat(idx.target, idx.swap);
  try {
    assert.equal(await settles(idx.target, () => new SessionIndex(idx.target).refresh()), false);
  } finally {
    restore();
  }
  const l0 = await setup('rollout.jsonl');
  l0.swap();
  assert.equal(await settles(l0.target, () => readLine0(l0.target, l0.st)), null);
  const lc = await setup('transcript.jsonl');
  lc.swap();
  assert.deepEqual(await settles(lc.target, () => createLineCounter().count(lc.target, lc.st, 1024)), { lines: null, used: 0 });
});
