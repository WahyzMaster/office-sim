// scripts/fake-grok-append.mjs (dev helper, P5g review): it refuses the real Grok root also through a link, a path under
// a link or another letter case (real paths are compared), and --cancel leaves the test-run prompt open, then cancels
// its turn (turn_completed cancelled, turn_ended cancelled / mid_turn_abort, no permission_resolved, no tool_completed).
// The script runs with HOME set to a temp folder, into temp roots; the live check uses a server on port 0. Never the
// real ~/.grok.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grok } from '../src/adapters/grok/index.mjs';
import { createGrokScanner } from '../src/adapters/grok/discover.mjs';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { sse, until } from './fixtures/sse.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/fake-grok-append.mjs', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function runScript(args, home) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const readJsonl = async (file) => (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function sessionFiles(root) {
  const out = [];
  for (const group of await fsp.readdir(path.join(root, 'sessions'))) {
    for (const id of await fsp.readdir(path.join(root, 'sessions', group))) out.push(path.join(root, 'sessions', group, id));
  }
  return out;
}

test('fake-grok-append refuses the real Grok root through a link, a path under the link and another letter case', async () => {
  const home = await tmp('office-sim-fake-home-');
  const grokDir = path.join(home, '.grok');
  await fsp.mkdir(grokDir);
  const link = path.join(await tmp('office-sim-fake-link-'), 'root');
  await fsp.symlink(grokDir, link);
  const roots = [grokDir, link, path.join(link, 'not-yet')];
  if (existsSync(path.join(home, '.GROK'))) roots.push(path.join(home, '.GROK'), path.join(home, '.Grok', 'x')); // APFS
  for (const root of roots) {
    const r = await runScript(['--root', root, '--cwd', '/work/fake', '--step-ms', '0', '--wait-ms', '0'], home);
    assert.equal(r.code, 2, `${root}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /refusing to write into the real ~\/\.grok/);
  }
  assert.deepEqual(await fsp.readdir(grokDir), [], 'nothing was written');
  const bad = await runScript(['--deny', '--cancel'], home);
  assert.equal(bad.code, 2, 'a prompt is denied or its turn cancelled, not both');
});

test('fake-grok-append --cancel: the open prompt shows, then the cancelled turn ends the tool interrupted, no allow', async () => {
  const root = await tmp('office-sim-fake-root-');
  const home = await tmp('office-sim-fake-home-');
  const adapter = { ...grok, deps: (o = {}) => grok.deps({ scan: createGrokScanner({ linkGraceMs: 0 }), ...o }) };
  const app = await start({ port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30,
    root: path.join(root, 'no-claude'), agents: ['grok'], roots: { grok: root }, adapters: { ...ADAPTERS, grok: adapter } });
  let es = null;
  try {
    await app.ready;
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    const r = await runScript(['--root', root, '--cwd', '/work/fake-cancel', '--step-ms', '0', '--wait-ms', '1600', '--cancel'], home);
    assert.equal(r.code, 0, r.stderr);
    const wire = () => es.frames.map((fr) => fr.data).filter((e) => e && e.type !== 'snapshot' && e.type !== 'config');
    const runs = () => wire().filter((e) => e.type === 'tool_start' && e.tool === 'run_terminal_command');
    await until(() => runs().length === 2 && wire().some((e) => e.type === 'tool_end' && e.toolUseId === runs()[1].toolUseId), 6000);
    const id = runs()[1].toolUseId; // the second test run: its prompt stays open
    const mine = wire().filter((e) => e.toolUseId === id).map((e) => [e.type, e.waiting ?? e.errorKind ?? null]);
    assert.deepEqual(mine, [['tool_start', null], ['tool_wait', true], ['tool_end', 'interrupted']]);
    assert.deepEqual(wire().filter((e) => e.type === 'tool_wait').map((e) => [e.toolUseId, e.waiting]), [[id, true]], 'no waiting:false');
    // the files: the prompt has no resolution and its call no completion; the turn ends cancelled in both logs
    const [main] = (await sessionFiles(root)).filter((d) => existsSync(path.join(d, 'subagents')));
    const updates = await readJsonl(path.join(main, 'updates.jsonl'));
    assert.deepEqual(updates.at(-1).params.update, { sessionUpdate: 'turn_completed', ...updates.at(-1).params.update, stop_reason: 'cancelled' });
    const events = await readJsonl(path.join(main, 'events.jsonl'));
    const lastReq = events.findLastIndex((e) => e.type === 'permission_requested');
    assert.deepEqual(events.slice(lastReq + 1).map((e) => e.type), ['turn_ended']);
    assert.deepEqual([events.at(-1).outcome, events.at(-1).cancellation_category], ['cancelled', 'mid_turn_abort']);
    assert.ok(!events.some((e) => e.type === 'tool_completed' && e.tool_call_id === id));
  } finally {
    es?.close();
    await app.close();
  }
});
