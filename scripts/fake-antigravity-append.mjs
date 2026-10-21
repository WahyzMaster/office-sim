#!/usr/bin/env node
// Dev helper (not a test): writes a synthetic Antigravity CLI (`agy`) conversation into a temp Antigravity root over
// time, so the live office can be watched with the Antigravity adapter. The steps come from test/fixtures/antigravity.mjs
// (shaped from docs/research/antigravity-format.json, invented content). It never touches the real ~/.gemini: a --root
// inside it is refused, also through a link or in another letter case, and so is a --root with a link into it where the
// conversation is written (the real paths and the folders' identities are compared, scripts/fake-root-guard.mjs).
//
//   node scripts/fake-antigravity-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--loop]
//   then, in another terminal:  node bin/office-sim.mjs --antigravity-root <the printed root>
//
// --root: an empty or earlier fake root (default: a new temp folder, removed again on Ctrl+C or SIGTERM). --cwd: the
// project folder the conversation works in (default: the current folder, so a Claude session in the same folder shares
// its floor).
// --step-ms: the model's think time before each planner step (default 1500). --loop: start a new turn after the last
// one, until Ctrl+C.
// Like the real tool, a step's line is written when the step completes: a planner line after the think time, its result
// lines 0-2 s later. Both transcripts are written (transcript_full.jsonl with native arguments and transcript.jsonl
// with JSON-encoded ones; the adapter reads the full one), and the summaries protobuf (jetbox_summaries_proto.pb) names
// the title and the workspace and says running during a turn, idle at its quiet end. One turn: a prompt, reads and a
// search, an edit and a failed test, a web search, an ask at the desk, a checkpoint (compaction), a passing test, the
// closing answer.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAntigravityBuilder, call } from '../test/fixtures/antigravity.mjs';
import { summariesProto } from '../test/fixtures/antigravity-tree.mjs';
import { refuseRealRoot, refuseWrites, stopOnSignals } from './fake-root-guard.mjs';

const USAGE = [
  'usage: node scripts/fake-antigravity-append.mjs [--root <dir>] [--cwd <project dir>] [--step-ms <ms>] [--loop]',
  '  --root     a temp folder for the fake Antigravity root (default: a new one); never the real ~/.gemini,',
  '             also not through a link or in another letter case',
  '  --cwd      the project folder the conversation works in (default: the current folder)',
  "  --step-ms  the model's think time before each planner step (default 1500)",
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

// The real ~/.gemini, also through a link or in another letter case: refused, the fake conversation would mix with real
// ones (and ~/.gemini holds the Gemini CLI's credentials).
const realGemini = path.join(os.homedir(), '.gemini');
refuseRealRoot(opts.root, realGemini, '~/.gemini');
const created = !opts.root;
const root = opts.root ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-fake-agy-'));
const io = stopOnSignals(root, created); // Ctrl+C or SIGTERM: the writes under way finish, then the temp root goes away
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

const base = path.join(root, 'antigravity-cli');
const id = crypto.randomUUID(); // brain folder names are conversation uuids
const logs = path.join(base, 'brain', id, '.system_generated', 'logs');
const fullFile = path.join(logs, 'transcript_full.jsonl');
const plainFile = path.join(logs, 'transcript.jsonl');
const summaryFile = path.join(base, 'jetbox_summaries_proto.pb');
// A link planted in a temp --root (antigravity-cli, its brain folder, the summaries file) would lead the writes into
// ~/.gemini, and the summaries file there (the real conversations' titles) would be replaced.
refuseWrites([logs, summaryFile, `${summaryFile}.tmp`], realGemini, '~/.gemini');
const full = createAntigravityBuilder({ format: 'full', stepMs: 0 });
const plain = createAntigravityBuilder({ format: 'truncated', stepMs: 0 });
const rel = (p) => path.join(opts.cwd, p);
let steps = 0;

// The summaries file is replaced whole, as the app does it (written aside, then renamed over the old one).
async function summary(status) {
  const title = 'Tidy the demo module';
  await io(async () => {
    await fsp.writeFile(`${summaryFile}.tmp`, summariesProto([{ id, title, status, cwd: opts.cwd, branch: 'fake/agy-demo', steps }]));
    await fsp.rename(`${summaryFile}.tmp`, summaryFile);
  });
}

// One step, written when it completes: the same step in both transcripts, created_at = its start (now - took).
async function write(make, took = 0) {
  const at = new Date(Date.now() - took).toISOString();
  const line = (b) => `${JSON.stringify({ ...make(b), created_at: at })}\n`;
  await io(async () => {
    await fsp.appendFile(fullFile, line(full));
    await fsp.appendFile(plainFile, line(plain));
  });
  steps += 1;
}
// The model thinks (nothing is written), then the planner line lands; each result lands 0-2 s after the previous line.
async function planner(o) {
  await sleep(opts.stepMs);
  await write((b) => b.planner(o), opts.stepMs);
}
async function result(make) {
  await sleep(jitter(250, 2000));
  await write(make);
}

async function turn(n) {
  await summary(2);
  await write((b) => b.userInput(n === 1 ? 'Tidy the demo module and add a test' : `Round ${n}: polish the demo`));
  await planner({ thinking: 'Look at the module layout first, then plan the edits.', calls: [call.viewFile(rel('src/demo.mjs')), call.grep('export function', rel('src'))] });
  await result((b) => b.result({ type: 'VIEW_FILE', content: 'invented file body' }));
  await result((b) => b.result({ type: 'GREP_SEARCH', content: 'invented matches' }));
  await planner({ content: 'Tidying the helpers.', calls: [call.replace(rel('src/demo.mjs')), call.runCommand('npm test', opts.cwd)] });
  await result((b) => b.result({ type: 'CODE_ACTION', content: 'invented diff' }));
  await result((b) => b.runResult({ exitCode: 1, content: 'invented failure' })); // a failed command
  await planner({ thinking: 'One test fails; check the docs for the expected format.', calls: [call.searchWeb('demo module format spec')] });
  await result((b) => b.result({ type: 'SEARCH_WEB', content: 'invented results' }));
  await planner({ calls: [call.askQuestion([{ question: 'Keep the old format as a fallback?', options: ['Yes', 'No'], is_multi_select: false }])] });
  await sleep(opts.stepMs * 2); // the character waits at the desk
  await write((b) => b.result({ type: 'ASK_QUESTION', content: 'invented answer' }));
  await write((b) => b.checkpoint({ content: 'invented compaction summary' })); // the conversation is compacted
  await planner({ calls: [call.runCommand('npm test', opts.cwd)] });
  await result((b) => b.runResult({ exitCode: 0, content: 'invented pass' }));
  await planner({ content: 'Done: the helpers are tidied and the tests pass.' }); // the closing answer: no calls
  await sleep(1000);
  await write((b) => b.systemMessage({ content: 'invented system message' }));
  await summary(1); // idle: the turn ends at once (else after 20 s of quiet)
}

await io(async () => {
  await fsp.mkdir(logs, { recursive: true });
  await fsp.writeFile(fullFile, '');
  await fsp.writeFile(plainFile, '');
});
await summary(1);
console.log(`fake Antigravity root: ${root}`);
console.log(`run:  node bin/office-sim.mjs --antigravity-root ${root}`);
console.log(`(conversation antigravity-${id} in ${opts.cwd}; think ${opts.stepMs} ms${opts.loop ? ', looping' : ''}; Ctrl+C to stop)`);
await sleep(Math.max(opts.stepMs, 1500)); // time to start office-sim
for (let n = 1; ; n++) {
  await turn(n);
  console.log(`turn ${n} written`);
  if (!opts.loop) break;
  await sleep(opts.stepMs * 2);
}
console.log(created ? `done; the files stay in ${root} until you delete them` : 'done');
