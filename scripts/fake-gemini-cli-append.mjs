#!/usr/bin/env node
// Synthetic Gemini CLI session writer for local testing (`--plugins gemini-cli --gemini-cli-root <dir>`).
// Guarded by `scripts/fake-root-guard.mjs`: refuses any `--root` inside real `~/.gemini` (direct, symlink, firmlink, or case-folded).
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { refuseRealRoot, refuseWrites, stopOnSignals } from './fake-root-guard.mjs';

const REAL_GEMINI = path.join(os.homedir(), '.gemini');
const SESSION_UUID = '9c4e2a10-7b31-4d88-9a12-55e0c1a2b3d4';

function parseCli(argv) {
  let root = null;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') once = true;
    else if (a === '--root') root = argv[++i] ?? '';
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/fake-gemini-cli-append.mjs [--root <temp-dir>] [--once]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return { root: root ? path.resolve(root) : null, once };
}

const { root: givenRoot, once } = parseCli(process.argv.slice(2));
if (givenRoot) refuseRealRoot(givenRoot, REAL_GEMINI, '~/.gemini');

const created = !givenRoot;
const root = givenRoot ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-fake-gemini-cli-'));
refuseRealRoot(root, REAL_GEMINI, '~/.gemini');

const projDir = path.join(root, 'synthetic-proj-01');
const chatsDir = path.join(projDir, 'chats');
const sessionFile = path.join(chatsDir, `session-${SESSION_UUID}.jsonl`);
const markerFile = path.join(projDir, '.project_root');
refuseWrites([projDir, chatsDir, sessionFile, markerFile], REAL_GEMINI, '~/.gemini');

const io = stopOnSignals(root, created);

await io(async () => {
  await fsp.mkdir(chatsDir, { recursive: true });
  await fsp.writeFile(markerFile, '/work/synthetic-gemini-app\n', 'utf8');
});

const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const STEPS = [
  () => ({
    type: 'session_metadata',
    timestamp: nowIso(0),
    cwd: '/work/synthetic-gemini-app',
    branch: 'feat/synthetic-plugin',
    title: 'Synthetic Gemini CLI session',
  }),
  () => ({
    type: 'user',
    timestamp: nowIso(200),
    content: 'Inspect the router module and run the unit test suite',
  }),
  () => ({
    type: 'gemini',
    timestamp: nowIso(600),
    thoughts: [{ subject: 'Inspecting router', description: 'Check router.mjs before running tests.' }],
    toolCalls: [
      {
        id: 'call_plan_1',
        name: 'write_todos',
        args: {
          todos: [
            { description: 'Inspect router module', status: 'in_progress' },
            { description: 'Run unit tests', status: 'pending' },
          ],
        },
        status: 'success',
      },
      {
        id: 'call_read_1',
        name: 'read_file',
        args: { file_path: '/work/synthetic-gemini-app/src/router.mjs' },
        status: 'executing',
      },
    ],
  }),
  () => ({
    type: 'tool_result',
    timestamp: nowIso(1200),
    id: 'call_read_1',
    status: 'success',
  }),
  () => ({
    type: 'gemini',
    timestamp: nowIso(1500),
    toolCalls: [
      {
        id: 'call_sh_1',
        name: 'run_shell_command',
        args: { command: 'npm test' },
        status: 'executing',
      },
    ],
  }),
  () => ({
    type: 'tool_result',
    timestamp: nowIso(2300),
    id: 'call_sh_1',
    status: 'success',
  }),
  () => ({
    type: 'gemini',
    timestamp: nowIso(2600),
    content: 'Router inspection and unit tests passed cleanly.',
    toolCalls: [
      {
        id: 'call_plan_2',
        name: 'write_todos',
        args: {
          todos: [
            { description: 'Inspect router module', status: 'completed' },
            { description: 'Run unit tests', status: 'completed' },
          ],
        },
        status: 'success',
      },
    ],
  }),
];

async function appendLine(obj) {
  refuseWrites([sessionFile], REAL_GEMINI, '~/.gemini');
  await io(() => fsp.appendFile(sessionFile, `${JSON.stringify(obj)}\n`, 'utf8'));
}

console.log(`fake gemini-cli root: ${root}`);
console.log(`run: node bin/office-sim.mjs --plugins gemini-cli --gemini-cli-root "${root}"`);

for (const makeStep of STEPS) {
  await appendLine(makeStep());
  if (!once) await new Promise((r) => setTimeout(r, 700));
}

if (once) {
  if (created) await fsp.rm(root, { recursive: true, force: true });
  process.exit(0);
}

let tick = 0;
while (true) {
  await new Promise((r) => setTimeout(r, 2500));
  tick += 1;
  await appendLine({
    type: 'user',
    timestamp: nowIso(),
    content: `Synthetic follow-up check #${tick}`,
  });
  await new Promise((r) => setTimeout(r, 600));
  await appendLine({
    type: 'gemini',
    timestamp: nowIso(),
    content: `Completed synthetic check #${tick}.`,
  });
}
