#!/usr/bin/env node
// Dev helper (not a test): writes a synthetic Grok Build session into a temp Grok root over time, so the live office can
// be watched with the Grok adapter. The records come from test/fixtures/grok.mjs (shaped from
// docs/research/grok-format.json, invented content). It never touches the real ~/.grok.
//
//   node scripts/fake-grok-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--loop]
//   then, in another terminal:  node bin/office-sim.mjs --grok-root <the printed root>
//
// --root: an empty or earlier fake root (default: a new temp folder, removed again on Ctrl+C). --cwd: the project folder
// the session works in (default: the current folder, so a Claude session in the same folder shares its floor).
// --step-ms: pause between steps (default 1500). --loop: start a new turn after the last one, until Ctrl+C.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGrokBuilder, out } from '../test/fixtures/grok.mjs';

const USAGE = 'usage: node scripts/fake-grok-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--loop]';

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
const realGrok = path.join(os.homedir(), '.grok');
if (opts.root && (opts.root === realGrok || opts.root.startsWith(`${realGrok}${path.sep}`))) {
  console.error('refusing to write into the real ~/.grok: pass a temp folder (or no --root)');
  process.exit(2);
}
const created = !opts.root;
const root = opts.root ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-fake-grok-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a UUIDv7-shaped id (Grok names session folders with UUIDv7)
function uuid7() {
  const hex = crypto.randomUUID().replace(/-/g, '').split('');
  const ms = Date.now().toString(16).padStart(12, '0');
  for (let i = 0; i < 12; i++) hex[i] = ms[i];
  hex[12] = '7';
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

const group = encodeURIComponent(opts.cwd);
const mainId = uuid7();
const mainDir = path.join(root, 'sessions', group, mainId);

async function writeSummary(dir, id, { title = null, kind = null, agent = 'grok-build-plan' } = {}) {
  const body = {
    info: { id, cwd: opts.cwd }, ...(title ? { generated_title: title, session_summary: title } : {}), head_branch: 'fake/grok-demo',
    current_model_id: 'grok-4.6', agent_name: agent, ...(kind ? { session_kind: kind } : {}), chat_format_version: 1,
  };
  await fsp.writeFile(path.join(dir, 'summary.json'), JSON.stringify(body));
}
const append = (file, recs) => fsp.appendFile(file, recs.map((r) => `${JSON.stringify(r)}\n`).join(''));

const now = () => Date.now();
const m = createGrokBuilder({ sessionId: mainId, startMs: now(), stepMs: 1 });
const mainFile = path.join(mainDir, 'updates.jsonl');
const p = (rel) => path.join(opts.cwd, rel);

// One step = some records for one file, then a pause (the clock of every record is "now").
async function step(file, b, make) {
  const recs = make(b);
  const t = now();
  for (const r of recs) {
    r.timestamp = Math.floor(t / 1000);
    if (r.params?._meta) r.params._meta.agentTimestampMs = t;
  }
  await append(file, recs);
  await sleep(opts.stepMs);
}

async function subagent(type, title) {
  const childId = uuid7();
  await fsp.mkdir(path.join(mainDir, 'subagents', childId), { recursive: true }); // the link first: never a main
  const dir = path.join(root, 'sessions', group, childId);
  await fsp.mkdir(dir, { recursive: true });
  await writeSummary(dir, childId, { title, kind: 'subagent', agent: type });
  const file = path.join(dir, 'updates.jsonl');
  await fsp.writeFile(file, '');
  return { childId, file, b: createGrokBuilder({ sessionId: childId, startMs: now(), stepMs: 1 }) };
}

async function turn(n) {
  m.newPrompt();
  await step(mainFile, m, (b) => [b.hook(), b.userMessage({ text: n === 1 ? 'Tidy the demo module and add a test' : `Round ${n}: polish the demo`, newTurn: false })]);
  if (n === 1) await writeSummary(mainDir, mainId, { title: 'Tidy the demo module' }); // Grok titles the session after the first prompt
  await step(mainFile, m, (b) => [b.thought('Look at the module layout first, then plan the edits.')]);
  await step(mainFile, m, (b) => [b.toolCall({ name: 'todo_write', input: { merge: false, todos: [] } }),
    b.plan([{ content: 'Read the module', status: 'in_progress' }, { content: 'Edit the helpers', status: 'pending' },
      { content: 'Run the tests', status: 'pending' }]), b.toolDone({ output: out.todos() })]);
  await step(mainFile, m, (b) => [b.toolCall({ name: 'read_file', input: { target_file: p('src/demo.mjs') } })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.readFile() }),
    b.toolCall({ name: 'grep', input: { pattern: 'export function', path: p('src') } })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.grep() }),
    b.toolCall({ name: 'search_replace', input: { file_path: p('src/demo.mjs'), old_string: 'a', new_string: 'b' } })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.edits() }),
    b.plan([{ content: 'Read the module', status: 'completed' }, { content: 'Edit the helpers', status: 'completed' },
      { content: 'Run the tests', status: 'in_progress' }]),
    b.toolCall({ name: 'run_terminal_command', input: { command: 'npm test', description: 'Run the tests' } })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.bash({ exitCode: 1, output: 'invented failure' }) }), // a failed shell
    b.thought('One test fails; check the docs for the expected format.'),
    b.toolCall({ name: 'web_fetch', input: { url: 'https://docs.example.com/format' } })]);
  await step(mainFile, m, (b) => [b.toolDenied({ text: 'Tool web_fetch was not executed: Denied by permission policy' }), // a denial
    b.toolCall({ name: 'use_tool', input: { tool_name: 'github__search_code', tool_input: { q: 'format' } } })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.mcp({ tool: 'search_code' }) })]);
  // a subagent: the parent's spawn call, the child's own session in the same cwd group, then the parent waits
  const child = await subagent('explore', 'Find the format callers');
  await step(mainFile, m, (b) => [b.toolCall({ name: 'spawn_subagent', input: { prompt: 'invented', description: 'Find callers', subagent_type: 'explore' } }),
    b.subagentSpawned({ child: child.childId, type: 'explore' }), b.toolDone({ output: out.text('Spawned') })]);
  child.b.newPrompt();
  await step(child.file, child.b, (b) => [b.hook(), b.userMessage({ text: 'Find every caller of format()', newTurn: false }),
    b.thought('Search the source tree.')]);
  await step(child.file, child.b, (b) => [b.toolCall({ name: 'grep', input: { pattern: 'format(', path: p('src') } })]);
  await step(child.file, child.b, (b) => [b.toolDone({ output: out.grep() }), b.toolCall({ name: 'read_file', input: { target_file: p('src/format.mjs') } })]);
  await step(child.file, child.b, (b) => [b.toolDone({ output: out.readFile() }), b.message('Three callers, all in src/.'), b.turnCompleted()]);
  await step(mainFile, m, (b) => [b.subagentFinished({ child: child.childId }), b.toolCall({ name: 'ask_user_question', input: { questions: [{
    question: 'Keep the old format as a fallback?', options: [{ label: 'Yes', description: 'keep' }, { label: 'No', description: 'drop' }] }] } })]);
  await sleep(opts.stepMs * 2); // the character waits at the desk
  await step(mainFile, m, (b) => [b.toolDone({ output: out.answered() }), b.toolCall({ name: 'exit_plan_mode', input: {} })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.planReady('# Fix the format\n- Keep the fallback\n- Update the tests') }),
    b.toolCall({ name: 'run_terminal_command', input: { command: 'npm test', description: 'Run the tests again' } })]);
  await step(mainFile, m, (b) => [b.toolDone({ output: out.bash({ exitCode: 0 }) }),
    b.plan([{ content: 'Read the module', status: 'completed' }, { content: 'Edit the helpers', status: 'completed' },
      { content: 'Run the tests', status: 'completed' }]),
    b.message('Done: the helpers are tidied and the tests pass.'), b.turnCompleted(), b.hook({ event: 'stop' })]);
}

process.on('SIGINT', async () => {
  if (created) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(created ? '\nstopped; the temp root was removed' : '\nstopped');
  process.exit(0);
});

await fsp.mkdir(mainDir, { recursive: true });
await writeSummary(mainDir, mainId);
await fsp.writeFile(mainFile, `${JSON.stringify(m.hook({ event: 'session_start' }))}\n`);
console.log(`fake Grok root: ${root}`);
console.log(`run:  node bin/office-sim.mjs --grok-root ${root}`);
console.log(`(session grok-${mainId} in ${opts.cwd}; step ${opts.stepMs} ms${opts.loop ? ', looping' : ''}; Ctrl+C to stop)`);
await sleep(Math.max(opts.stepMs, 1500)); // time to start office-sim
for (let n = 1; ; n++) {
  await turn(n);
  console.log(`turn ${n} written`);
  if (!opts.loop) break;
  await sleep(opts.stepMs * 2);
}
console.log(created ? `done; the files stay in ${root} until you delete them` : 'done');
