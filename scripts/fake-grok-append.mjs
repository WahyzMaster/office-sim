#!/usr/bin/env node
// Dev helper (not a test): writes a synthetic Grok Build session into a temp Grok root over time, so the live office can
// be watched with the Grok adapter. The records come from test/fixtures/grok.mjs (shaped from
// docs/research/grok-format.json, invented content). It never touches the real ~/.grok: a --root inside it is refused,
// also through a link or in another letter case, and so is a --root with a link into it where the session is written
// (the real paths and the folders' identities are compared, scripts/fake-root-guard.mjs).
// Next to each updates.jsonl it also writes the session's events.jsonl (P5g): every tool call gets tool_started,
// phase_changed permission_prompt and permission_requested with the call's own clock, auto-approved in the same write,
// except one test run per turn whose prompt stays open for --wait-ms before it is allowed (or denied with --deny, or
// left open and its turn cancelled with --cancel).
//
//   node scripts/fake-grok-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--wait-ms <ms>] [--deny | --cancel] [--loop]
//   then, in another terminal:  node bin/office-sim.mjs --grok-root <the printed root>
//
// --root: an empty or earlier fake root (default: a new temp folder, removed again on Ctrl+C or SIGTERM). --cwd: the
// project folder the session works in (default: the current folder, so a Claude session in the same folder shares its
// floor).
// --step-ms: pause between steps (default 1500). --wait-ms: how long the one approval prompt per turn stays open
// (default 6000; 0 answers it at once like the rest). --deny: that prompt is denied instead of allowed, as auto mode
// does in most long real denials (no tool_completed; the call ends with the auto-mode denial line and the turn goes on).
// --cancel: that prompt is never answered; after --wait-ms the turn is cancelled (turn_completed cancelled in
// updates.jsonl, turn_ended cancelled / mid_turn_abort in events.jsonl, no permission_resolved, no tool_completed), so
// the waiting call ends interrupted.
// --loop: start a new turn after the last one, until Ctrl+C.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGrokBuilder, out } from '../test/fixtures/grok.mjs';
import { refuseRealRoot, refuseWrites, stopOnSignals } from './fake-root-guard.mjs';

const USAGE = [
  'usage: node scripts/fake-grok-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--wait-ms <ms>] [--deny | --cancel] [--loop]',
  '  --root     a temp folder for the fake Grok root (default: a new one); never the real ~/.grok',
  '  --cwd      the project folder the session works in (default: the current folder)',
  '  --step-ms  pause between steps (default 1500)',
  '  --wait-ms  how long the test-run permission prompt stays open (default 6000)',
  '  --deny     that prompt is denied instead of allowed',
  '  --cancel   that prompt is never answered: the turn is cancelled after --wait-ms (the call ends interrupted)',
  '  --loop     start a new turn after the last one, until Ctrl+C',
].join('\n');

function parse(argv) {
  const o = { root: null, cwd: process.cwd(), stepMs: 1500, waitMs: 6000, deny: false, cancel: false, loop: false };
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
    else if (a === '--wait-ms') o.waitMs = Number(val());
    else if (a === '--deny') o.deny = true;
    else if (a === '--cancel') o.cancel = true;
    else if (a === '--loop') o.loop = true;
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isFinite(o.stepMs) || o.stepMs < 0) throw new Error('--step-ms must be a number >= 0');
  if (!Number.isFinite(o.waitMs) || o.waitMs < 0) throw new Error('--wait-ms must be a number >= 0');
  if (o.deny && o.cancel) throw new Error('--deny and --cancel do not go together');
  return o;
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
// The real ~/.grok, also through a link or in another letter case: refused, the fake session would mix with real ones.
const realGrok = path.join(os.homedir(), '.grok');
refuseRealRoot(opts.root, realGrok, '~/.grok');
const created = !opts.root;
const root = opts.root ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-fake-grok-'));
const io = stopOnSignals(root, created); // Ctrl+C or SIGTERM: the writes under way finish, then the temp root goes away
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
// A link planted in a temp --root (sessions, the cwd group folder) would lead the writes into ~/.grok.
refuseWrites([mainDir], realGrok, '~/.grok');

async function writeSummary(dir, id, { title = null, kind = null, agent = 'grok-build-plan' } = {}) {
  const body = {
    info: { id, cwd: opts.cwd }, ...(title ? { generated_title: title, session_summary: title } : {}), head_branch: 'fake/grok-demo',
    current_model_id: 'grok-4.6', agent_name: agent, ...(kind ? { session_kind: kind } : {}), chat_format_version: 1,
  };
  await io(() => fsp.writeFile(path.join(dir, 'summary.json'), JSON.stringify(body)));
}
const append = (file, recs) => io(() => fsp.appendFile(file, recs.map((r) => `${JSON.stringify(r)}\n`).join('')));

const now = () => Date.now();
const m = createGrokBuilder({ sessionId: mainId, startMs: now(), stepMs: 1 });
const mainFile = path.join(mainDir, 'updates.jsonl');
const p = (rel) => path.join(opts.cwd, rel);

// events.jsonl sits next to updates.jsonl. Per file: the open calls (id -> { name, ms }; the builders number their call
// ids per session, so ids repeat across files) and the turn count.
const eventsFile = (file) => path.join(path.dirname(file), 'events.jsonl');
const eventState = new Map();
const iso = (ms) => new Date(ms).toISOString();
const isCall = (r) => r.params?.update?.sessionUpdate === 'tool_call' && !!r.params.update._meta?.['x.ai/tool'];
const TURN_OUTCOMES = { end_turn: 'completed', cancelled: 'cancelled' };
// a cancelled turn's events.jsonl record carries its category (the real logs: mid_turn_abort for a prompt left open)
const turnEnded = (ts, outcome) => ({ type: 'turn_ended', ts, outcome, ...(outcome === 'cancelled' ? { cancellation_category: 'mid_turn_abort' } : {}) });

function resolved(name, decision, askedMs) {
  const t = now();
  return { type: 'permission_resolved', ts: iso(t), tool_name: name, decision, wait_ms: t - askedMs };
}

// The events.jsonl lines for one step's records, with the records' own clock (the adapter pairs a prompt with its call
// by order, name and that clock). Every call's prompt is answered in the same write, except the step's last call when
// `prompt.wait` > 0 or `prompt.cancel`: its name comes back as `held`. A denied call (failed, no rawOutput) and a call
// still open when its turn is cancelled never get a tool_completed.
function eventsOf(file, recs, t, prompt) {
  const s = eventState.get(file) ?? { open: new Map(), turns: 0 };
  eventState.set(file, s);
  const ts = iso(t);
  const last = prompt ? recs.findLastIndex(isCall) : -1;
  const lines = [];
  let held = null;
  recs.forEach((r, i) => {
    const u = r.params?.update ?? {};
    if (isCall(r)) {
      const name = u._meta['x.ai/tool'].name;
      s.open.set(u.toolCallId, { name, ms: t });
      lines.push({ type: 'tool_started', ts, tool_name: name }, { type: 'phase_changed', ts, phase: 'permission_prompt' },
        { type: 'permission_requested', ts, tool_name: name });
      if (i === last && (prompt.wait > 0 || prompt.cancel)) held = name;
      else lines.push(resolved(name, i === last && prompt.deny ? 'deny' : 'allow', t));
    } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed') && s.open.has(u.toolCallId)) {
      const call = s.open.get(u.toolCallId);
      s.open.delete(u.toolCallId);
      if (u.status === 'failed' && u.rawOutput === undefined) return;
      const exit = u.rawOutput?.Bash?.exit_code;
      lines.push({ type: 'tool_completed', ts, tool_name: call.name, tool_call_id: u.toolCallId,
        outcome: u.status === 'failed' || (exit !== undefined && exit !== 0) ? 'error' : 'success', duration_ms: t - call.ms });
    } else if (u.sessionUpdate === 'user_message_chunk') {
      lines.push({ type: 'turn_started', ts, session_id: r.params.sessionId, turn_number: ++s.turns });
    } else if (u.sessionUpdate === 'turn_completed') {
      lines.push(turnEnded(ts, TURN_OUTCOMES[u.stop_reason] ?? 'error'));
    }
  });
  return { lines, held };
}

// One step = some records for one file (plus its events.jsonl lines), then a pause (the clock of every record is "now").
// prompt { wait, deny, cancel }: the step's last tool call keeps its permission prompt open for `wait` ms, then it is
// allowed and runs for one more pause, or denied and the denial record follows at once, or (cancel) left unanswered for
// the caller to cancel the turn.
async function step(file, b, make, prompt = null) {
  const recs = make(b);
  const t = now();
  for (const r of recs) {
    r.timestamp = Math.floor(t / 1000);
    if (r.params?._meta) r.params._meta.agentTimestampMs = t;
  }
  const { lines, held } = eventsOf(file, recs, t, prompt);
  await append(file, recs);
  await append(eventsFile(file), lines);
  if (held) {
    await sleep(prompt.wait);
    if (prompt.cancel) return; // 답하지 않는다: 부른 쪽이 턴을 취소한다
    await append(eventsFile(file), [resolved(held, prompt.deny ? 'deny' : 'allow', t)]);
    if (prompt.deny) return;
  }
  await sleep(opts.stepMs);
}

async function subagent(type, title) {
  const childId = uuid7();
  await io(() => fsp.mkdir(path.join(mainDir, 'subagents', childId), { recursive: true })); // the link first: never a main
  const dir = path.join(root, 'sessions', group, childId);
  await io(() => fsp.mkdir(dir, { recursive: true }));
  await writeSummary(dir, childId, { title, kind: 'subagent', agent: type });
  const file = path.join(dir, 'updates.jsonl');
  await io(() => fsp.writeFile(file, ''));
  await io(() => fsp.writeFile(eventsFile(file), ''));
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
    b.toolCall({ name: 'web_fetch', input: { url: 'https://docs.example.com/format' } })], { wait: 0, deny: true }); // denied at once
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
  // the approval wait: the prompt for this test run stays open for --wait-ms, then it is allowed (or denied with --deny,
  // or never answered and the turn cancelled with --cancel: the call ends interrupted, the next turn starts fresh)
  await step(mainFile, m, (b) => [b.toolDone({ output: out.planReady('# Fix the format\n- Keep the fallback\n- Update the tests') }),
    b.toolCall({ name: 'run_terminal_command', input: { command: 'npm test', description: 'Run the tests again' } })],
  { wait: opts.waitMs, deny: opts.deny, cancel: opts.cancel });
  if (opts.cancel) {
    await step(mainFile, m, (b) => [b.turnCompleted({ stopReason: 'cancelled' })]);
    return;
  }
  const ran = !opts.deny;
  await step(mainFile, m, (b) => [ran ? b.toolDone({ output: out.bash({ exitCode: 0 }) }) : b.toolDenied(),
    b.plan([{ content: 'Read the module', status: 'completed' }, { content: 'Edit the helpers', status: 'completed' },
      { content: 'Run the tests', status: ran ? 'completed' : 'in_progress' }]),
    b.message(ran ? 'Done: the helpers are tidied and the tests pass.' : 'The helpers are tidied; the test run was not approved.'),
    b.turnCompleted(), b.hook({ event: 'stop' })]);
}

await io(() => fsp.mkdir(mainDir, { recursive: true }));
await writeSummary(mainDir, mainId);
await io(() => fsp.writeFile(mainFile, `${JSON.stringify(m.hook({ event: 'session_start' }))}\n`));
await io(() => fsp.writeFile(eventsFile(mainFile), ''));
console.log(`fake Grok root: ${root}`);
console.log(`run:  node bin/office-sim.mjs --grok-root ${root}`);
const waitNote = `test-run prompt open ${opts.waitMs} ms, then ${opts.cancel ? 'its turn cancelled' : opts.deny ? 'denied' : 'allowed'}`;
console.log(`(session grok-${mainId} in ${opts.cwd}; step ${opts.stepMs} ms; ${waitNote}${opts.loop ? '; looping' : ''}; Ctrl+C to stop)`);
await sleep(Math.max(opts.stepMs, 1500)); // time to start office-sim
for (let n = 1; ; n++) {
  await turn(n);
  console.log(`turn ${n} written`);
  if (!opts.loop) break;
  await sleep(opts.stepMs * 2);
}
console.log(created ? `done; the files stay in ${root} until you delete them` : 'done');
