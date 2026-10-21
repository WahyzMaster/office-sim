#!/usr/bin/env node
// Dev helper (not a test): writes a synthetic Codex thread (code mode) into a temp Codex root over time, so the live
// office can be watched with the Codex adapter. The records come from test/fixtures/codex.mjs (shaped from
// docs/research/codex-format.json, invented content). It never touches the real ~/.codex: a --root inside it is refused,
// also through a link or in another letter case, and so is a --root with a link into it where the thread is written
// (the real paths and the folders' identities are compared, scripts/fake-root-guard.mjs).
//
//   node scripts/fake-codex-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--loop]
//   then, in another terminal:  node bin/office-sim.mjs --codex-root <the printed root>
//
// --root: an empty or earlier fake root (default: a new temp folder, removed again on Ctrl+C or SIGTERM). --cwd: the
// project folder the thread works in (default: the current folder, so a Claude session in the same folder shares its
// floor).
// --step-ms: pause between steps (default 1500). --loop: start a new turn after the last one, until Ctrl+C.
// One turn: a prompt, a thought, a plan proposal, code-mode exec calls whose inner commands visit several rooms (a read,
// an edit, a failed test, a web search, a declined command), a subagent with its own file that the parent reports
// completed, an ask at the desk, a passing test and the closing answer.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexBuilder, out, NEW_VERSION } from '../test/fixtures/codex.mjs';
import { dayKey } from '../src/adapters/codex/discover.mjs';
import { refuseRealRoot, refuseWrites, stopOnSignals } from './fake-root-guard.mjs';

const USAGE = [
  'usage: node scripts/fake-codex-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--loop]',
  '  --root     a temp folder for the fake Codex root (default: a new one); never the real ~/.codex,',
  '             also not through a link or in another letter case',
  '  --cwd      the project folder the thread works in (default: the current folder)',
  '  --step-ms  pause between steps (default 1500)',
  '  --loop     start a new turn after the last one, until Ctrl+C',
].join('\n');

function parse(argv) {
  const o = { root: null, cwd: process.cwd(), stepMs: 1500, loop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--root') o.root = path.resolve(val());
    else if (a === '--cwd') o.cwd = path.resolve(val());
    else if (a === '--step-ms') o.stepMs = Number(val());
    else if (a === '--loop') o.loop = true;
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isFinite(o.stepMs) || o.stepMs < 0) throw new Error('--step-ms must be a number >= 0');
  return o;
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}

// The real ~/.codex, also through a link or in another letter case: refused, the fake thread would mix with real ones.
const realCodex = path.join(os.homedir(), '.codex');
refuseRealRoot(opts.root, realCodex, '~/.codex');
const created = !opts.root;
const root = opts.root ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-fake-codex-'));
const io = stopOnSignals(root, created); // Ctrl+C or SIGTERM: the writes under way finish, then the temp root goes away
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a UUIDv7-shaped id (Codex thread ids are UUIDv7)
function uuid7() {
  const hex = crypto.randomUUID().replace(/-/g, '').split('');
  const ms = Date.now().toString(16).padStart(12, '0');
  for (let i = 0; i < 12; i++) hex[i] = ms[i];
  hex[12] = '7';
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

// <root>/sessions/<YYYY>/<MM>/<DD>/rollout-<local YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl (folder date and name are local time)
function rolloutFile(id) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return path.join(root, 'sessions', ...dayKey(d.getTime()).split('/'), `rollout-${ts}-${id}.jsonl`);
}

// Every record is stamped "now" when it is written (ordinals stay the builder's line index).
function stamp(rec) {
  const t = Date.now();
  rec.timestamp = new Date(t).toISOString();
  const p = rec.payload;
  if (p?.type === 'item_completed') {
    if (typeof p.started_at_ms === 'number') p.started_at_ms = t - (p.completed_at_ms - p.started_at_ms);
    p.completed_at_ms = t;
  }
  return rec;
}
const append = (file, recs) => io(() => fsp.appendFile(file, recs.map((r) => `${JSON.stringify(stamp(r))}\n`).join('')));
const indexFile = path.join(root, 'session_index.jsonl');
const indexTitle = (id, name) => io(() => fsp.appendFile(indexFile,
  `${JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() })}\n`));

const mainId = uuid7();
const mainFile = rolloutFile(mainId);
const m = createCodexBuilder({ threadId: mainId, cliVersion: NEW_VERSION, cwd: opts.cwd, branch: 'fake/codex-demo', stepMs: 1 });
const rel = (p) => path.join(opts.cwd, p);

// One step = some records for one file, then a pause.
async function step(file, recs) {
  await append(file, recs);
  await sleep(opts.stepMs);
}

// One code-mode exec call: the outer call, its inner items (visits), its output.
async function exec(script, inner = [], output = out.script('Script completed')) {
  await step(mainFile, [m.exec(script)]);
  for (const it of inner) await step(mainFile, [it()]);
  await step(mainFile, [m.execOutput(output)]);
}

async function subagent(round) {
  const childId = uuid7();
  const file = rolloutFile(childId);
  const c = createCodexBuilder({ threadId: childId, cliVersion: NEW_VERSION, cwd: opts.cwd, branch: 'fake/codex-demo', stepMs: 1 });
  await exec('await tools.spawn_agent({ agent_type: "explorer", message: "invented task" });', [],
    out.script(`spawned ${childId}`));
  refuseWrites([path.dirname(file)], realCodex, '~/.codex'); // a new day's folder
  await io(() => fsp.mkdir(path.dirname(file), { recursive: true }));
  await append(file, [c.sessionMeta({ sub: { parent: mainId, role: 'explorer', nickname: `Scout ${round}`, path: '/root/scout' } })]);
  await step(file, [c.taskStarted(), c.userMessage('Find every caller of format()'), ...c.think('Search the source tree.')]);
  await step(file, [c.exec('await tools.exec_command({ cmd: "rg -n format src" });')]);
  await step(file, [c.commandItem({ script: 'rg -n format src', parsed: 'rg -n format src' })]);
  await step(file, [c.execOutput(), ...c.say('Three callers, all in src/.', { phase: 'final_answer' }), c.taskComplete()]);
  await step(mainFile, [m.subAgentActivity({ child: childId, kind: 'completed' })]);
}

async function turn(n) {
  await step(mainFile, [m.taskStarted(), m.userMessage(n === 1 ? 'Tidy the demo module and add a test' : `Round ${n}: polish the demo`)]);
  if (n === 1) await indexTitle(mainId, 'Tidy the demo module'); // Codex names the thread after the first prompt
  await step(mainFile, [...m.think('Look at the module layout first, then plan the edits.')]);
  await step(mainFile, [m.planItem('# Tidy the demo\n\n1. Read the module\n2. Edit the helpers\n3. Run the tests')]);
  await exec('const r = await tools.exec_command({ cmd: "rg -n export src" });\ntext(r.output);', [
    () => m.commandItem({ script: 'rg -n export src', parsed: 'rg -n export src' }),
    () => m.imageViewItem({ path: rel('docs/layout.png') }),
  ]);
  await exec('await tools.apply_patch("*** Begin Patch\\n*** Update File: src/demo.mjs\\n*** End Patch");', [
    () => m.fileChangeItem({ paths: [rel('src/demo.mjs'), rel('src/helpers.mjs')] }),
  ]);
  await exec('await tools.exec_command({ cmd: "npm test" });', [
    () => m.commandItem({ script: 'npm test', parsed: 'npm test', exitCode: 1 }), // a failed command
  ]);
  await exec('await tools.web_search({ query: "format spec" });', [() => m.webSearchItem({ query: 'format spec' })]);
  await exec('await tools.exec_command({ cmd: "curl -X POST https://example.com/hook" });', [
    () => m.commandItem({ script: 'curl -X POST https://example.com/hook', parsed: null, status: 'declined' }), // a denial
  ], out.script('exec rejected by user'));
  await subagent(n);
  await step(mainFile, [m.requestUserInput([{ id: 'q1', header: 'Format', question: 'Keep the old format as a fallback?',
    options: [{ label: 'Yes', description: 'keep' }, { label: 'No', description: 'drop' }] }])]);
  await sleep(opts.stepMs * 2); // the character waits at the desk
  await step(mainFile, [m.functionOutput({ output: out.answers() })]);
  await exec('await tools.exec_command({ cmd: "npm test" });', [() => m.commandItem({ script: 'npm test', parsed: 'npm test' })]);
  await step(mainFile, [...m.say('Done: the helpers are tidied and the tests pass.', { phase: 'final_answer' }), m.taskComplete()]);
}

// A link planted in a temp --root (sessions, a day folder, session_index.jsonl) would lead the writes into ~/.codex.
refuseWrites([path.dirname(mainFile), indexFile], realCodex, '~/.codex');
await io(() => fsp.mkdir(path.dirname(mainFile), { recursive: true }));
await append(mainFile, [m.sessionMeta(), m.turnContext()]);
console.log(`fake Codex root: ${root}`);
console.log(`run:  node bin/office-sim.mjs --codex-root ${root}`);
console.log(`(thread codex-${mainId} in ${opts.cwd}; step ${opts.stepMs} ms${opts.loop ? ', looping' : ''}; Ctrl+C to stop)`);
await sleep(Math.max(opts.stepMs, 1500)); // time to start office-sim
for (let n = 1; ; n++) {
  await turn(n);
  console.log(`turn ${n} written`);
  if (!opts.loop) break;
  await sleep(opts.stepMs * 2);
}
console.log(created ? `done; the files stay in ${root} until you delete them` : 'done');
