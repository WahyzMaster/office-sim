// `office-sim init` and `office-sim hooks install|uninstall|status` (contract 6.3): the setup commands of the bin.
// They start no server. src/cli-main.mjs hands them the argv before it parses any server option.
// What they may write: the Claude Code settings file (through src/hooks-receiver.mjs: merge, one backup) and, for init,
// a copy of skills/office in <home>/.claude/skills/office. Every change is printed first and written only with --yes or
// after a y at the prompt of a terminal. With --home (and --settings) no path of the real home directory is used.
// Inside the skill folder nothing is read or written through a link (lstat first, O_NOFOLLOW on the open).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULTS } from './server.mjs';
import { HOOK_EVENTS, buildHookUrl, planClaudeHooks, installClaudeHooks, planClaudeUnhook, uninstallClaudeHooks, findClaudeHooks } from './hooks-receiver.mjs';
import { probeHealthz, isOfficeSimHealth, baseUrl, PROBE_TIMEOUT_MS } from './port-reuse.mjs';

/** The first argv element that makes the bin run a setup command instead of the server. */
export const COMMANDS = Object.freeze(['init', 'hooks']);
export const isCommand = (arg) => COMMANDS.includes(arg);
const HOOK_ACTIONS = Object.freeze(['install', 'uninstall', 'status']);
/** The file that marks a skill folder as made by `office-sim init` (only such a folder is ever updated). */
export const SKILL_MARKER = '.office-sim-init.json';
const MADE_BY = 'office-sim init';
const AUTH_BODY = 'unauthorized: open the URL printed by office-sim'; // the 401 body of a server started with --auth
const HOOKS_ONLY = 'For the hooks alone run: office-sim hooks install';
const FS = fs.constants;
const NOFOLLOW = FS.O_NOFOLLOW ?? 0; // absent on Windows: there the lstat before each open is the whole check

export const COMMAND_USAGE = `Usage: office-sim init [options]
       office-sim hooks install|uninstall|status [options]

  init               hooks install, plus a copy of the /office skill in <home>/.claude/skills/office
  hooks install      add the two office-sim hooks (${HOOK_EVENTS.join(', ')}) to the Claude Code settings
                     file; they POST a permission prompt to http://127.0.0.1:<port>/api/hooks/claude
  hooks uninstall    remove the office-sim hooks from the settings file
  hooks status       say whether the hooks are in the settings file and whether an office-sim answers on the port

  --settings <path>  Claude Code settings file (default <home>/.claude/settings.json)
  --home <dir>       home directory (default: the user's home directory)
  --port <n>         the port in the hook URL, and the port status asks (default ${DEFAULTS.port})
  --dry-run          print what would change and write nothing
  --yes              write without asking
  -h, --help         show this help

  init, hooks install and hooks uninstall print what they would change first. They write only with --yes, or
  after a y at the prompt in a terminal; without a terminal and without --yes they write nothing and exit 1.
  The settings file is copied once to <settings>.office-sim.bak before its first change. init copies the skill
  (it makes no link) and never replaces a skill folder it did not make. The copy runs the server with npx;
  from a clone, npm run skill:install links the skill to the checkout instead.
`;

const FLAGS = { '--dry-run': 'dryRun', '--yes': 'yes' };
const VALUES = { '--settings': 'settings', '--home': 'home', '--port': 'port' };

/** argv (starting at `init` or `hooks`) -> { command, help, settings, home, port, dryRun, yes }. Throws Error on a bad argument. */
export function parseCommand(argv) {
  const out = { command: null, help: false, settings: null, home: null, port: DEFAULTS.port, dryRun: false, yes: false };
  let rest = argv.slice(1);
  const wantsHelp = rest.includes('-h') || rest.includes('--help');
  if (argv[0] === 'init') out.command = 'init';
  else if (HOOK_ACTIONS.includes(rest[0])) {
    out.command = rest[0];
    rest = rest.slice(1);
  } else if (!wantsHelp) throw new Error('hooks needs install, uninstall or status');
  if (wantsHelp) return { ...out, help: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    if (FLAGS[name]) {
      if (eq >= 0) throw new Error(`${name} takes no value`);
      out[FLAGS[name]] = true;
    } else if (VALUES[name]) {
      const raw = eq < 0 ? rest[++i] : a.slice(eq + 1);
      if (raw === undefined || raw === '' || (eq < 0 && raw.startsWith('--'))) throw new Error(`${name} needs a value`);
      out[VALUES[name]] = raw;
    } else throw new Error(`unknown option: ${name}`);
  }
  if (out.port !== DEFAULTS.port) {
    const n = Number(out.port);
    // 0 is no port for a hook URL: the URL is written into a file and must name the port the server listens on
    if (!/^\d+$/.test(String(out.port).trim()) || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be an integer in 1..65535');
    out.port = n;
  }
  return out;
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, child));
    else if (e.isFile()) out.push(child); // links and anything else are not copied
  }
  return out.sort();
}

/** The bytes of a regular file, or null for anything else (nothing there, a folder, a link: a link is not followed). */
function readPlain(file) {
  let fd = null;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, FS.O_RDONLY | NOFOLLOW | (FS.O_NONBLOCK ?? 0));
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Create or replace a regular file. A link at that path is not followed: the open fails (ELOOP) and nothing is written. */
function writePlain(file, data) {
  const fd = fs.openSync(file, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | NOFOLLOW, 0o666);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

const sameBytes = (from, to) => {
  const there = readPlain(to);
  try { return there !== null && fs.readFileSync(from).equals(there); } catch { return false; }
};

/**
 * The first thing in the way of a copy of `files` (and the marker) into `target`: on the way to a file, a path that is
 * there and is no real folder; at its end, one that is there and is no regular file. A symbolic link is always in the
 * way (lstat does not follow it, so a link to a folder or to nothing counts too). null when nothing is.
 * @returns {{ at: string, what: 'link'|'file'|'folder' }|null} `what`: a link, or what should have been there
 */
function inTheWay(target, files) {
  for (const rel of [SKILL_MARKER, ...files]) {
    const parts = rel.split('/');
    let at = target;
    for (let i = 0; i < parts.length; i++) {
      at = path.join(at, parts[i]);
      let st;
      try { st = fs.lstatSync(at); } catch { break; } // nothing there yet: the copy makes it
      const last = i === parts.length - 1;
      if (st.isSymbolicLink()) return { at, what: 'link' };
      if (last ? !st.isFile() : !st.isDirectory()) return { at, what: last ? 'file' : 'folder' };
    }
  }
  return null;
}

/**
 * What init would do with the skill folder, without writing. `state`: 'create' (nothing is there), 'update' or 'same'
 * (a folder with our marker), or 'refuse' with `reason` and `how`: a missing source, a target that cannot be looked
 * at, a target that init did not make (a link, a file, a folder without the marker as a regular file), or a folder of
 * ours with a link (or a folder where a file belongs, or the reverse) at a path the copy would write. Nothing of a
 * refused target is written to, moved or removed.
 * @returns {{ state: 'create'|'update'|'same'|'refuse', source: string, target: string, files: string[], reason?: string, how?: string }}
 */
export function planSkill({ source, target }) {
  const base = { source, target, files: [] };
  let files;
  try {
    files = listFiles(source);
  } catch {
    files = [];
  }
  if (!files.includes('SKILL.md')) {
    return { ...base, state: 'refuse', reason: `skill source not found: ${path.join(source, 'SKILL.md')}`, how: 'This office-sim package is incomplete: install it again.' };
  }
  const plan = { ...base, files };
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return { ...plan, state: 'create' };
    return {
      ...plan, state: 'refuse', reason: `refused: ${target} cannot be looked at (${err.code ?? 'error'})`,
      how: `Something on the way to it is not a folder, or may not be read. ${HOOKS_ONLY}`,
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ...plan, state: 'refuse', reason: `refused: ${target} is a symbolic link, and init never writes through a link`,
      how: `It is probably the clone install (npm run skill:install), which already gives you /office. To have the copy instead, remove the link first (npm run skill:uninstall in that checkout) and run init again. ${HOOKS_ONLY}`,
    };
  }
  let marker = null;
  if (st.isDirectory()) {
    try {
      marker = JSON.parse(readPlain(path.join(target, SKILL_MARKER)) ?? 'null');
    } catch { /* not JSON: not ours. No marker, or a marker that is a link, is null: not ours either */ }
  }
  if (marker?.installedBy !== MADE_BY) {
    return {
      ...plan, state: 'refuse', reason: `refused: ${target} exists and was not made by office-sim init`,
      how: `It is left as it is. To have the copy, rename or remove it yourself and run init again. ${HOOKS_ONLY}`,
    };
  }
  const odd = inTheWay(target, files);
  if (odd) {
    const why = odd.what === 'link' ? 'is a symbolic link, and init never writes through a link' : `is not a ${odd.what === 'file' ? 'regular file' : 'folder'}, and init does not replace it`;
    return {
      ...plan, state: 'refuse', reason: `refused: ${odd.at} ${why}`,
      how: `The folder ${target} is left as it is. Remove or rename ${odd.at} yourself and run init again. ${HOOKS_ONLY}`,
    };
  }
  const same = files.every((f) => sameBytes(path.join(source, f), path.join(target, f)));
  return { ...plan, state: same ? 'same' : 'update' };
}

// The marker goes in first: a copy that stops half way leaves a folder that is ours, and the next init completes it.
function writeSkill({ source, target, files }, version) {
  fs.mkdirSync(target, { recursive: true });
  writePlain(path.join(target, SKILL_MARKER), `${JSON.stringify({ installedBy: MADE_BY, version }, null, 2)}\n`);
  for (const f of files) {
    const to = path.join(target, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    writePlain(to, fs.readFileSync(path.join(source, f)));
  }
}

function packageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function askOnTerminal(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer); });
    rl.on('close', () => { // Ctrl-D or the end of input: no. The newline ends the prompt line the cursor is still on
      if (answered) return;
      process.stdout.write('\n');
      resolve('');
    });
  });
}

/** 'write' to go on, 'dry' for --dry-run (exit 0, nothing written), 'no' for no answer or a refusal (exit 1). --dry-run wins over --yes. */
async function confirm(opts, { say, fail, isTTY, ask }) {
  if (opts.dryRun) {
    say('dry run: nothing written');
    return 'dry';
  }
  if (opts.yes) return 'write';
  if (!isTTY) {
    fail('nothing written: this is not a terminal, so nobody can be asked. Run it again with --yes to write these changes (or with --dry-run to only look)');
    return 'no';
  }
  const answer = String(await ask('office-sim: write these changes? [y/N] ') ?? '').trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return 'write';
  fail('nothing written');
  return 'no';
}

function describeHooks(plan, say) {
  say(`settings file ${plan.settingsPath} (${plan.exists ? 'exists' : 'will be created'})`);
  if (!plan.exists) say('backup: none (there is no settings file yet)');
  else if (plan.backupNeeded) say(`backup ${plan.backupPath} (the file as it is now, written once before the first change)`);
  else say(`backup ${plan.backupPath} is already there and stays as it is`);
  for (const e of plan.entries) {
    say(`add hook ${e.event}${e.matcher ? ` (matcher ${e.matcher})` : ''}: http POST ${e.handler.url}, timeout ${e.handler.timeout} s`);
  }
  if (plan.replaced > 0) say(`replace ${plan.replaced} office-sim hook(s) already in the file`);
}

const SKILL_STATE = { create: 'will be created', update: 'will be updated', same: 'is up to date' };

async function install(opts, io, { settingsPath, skill = null }) {
  const { say, fail } = io;
  let plan;
  try {
    plan = planClaudeHooks({ settingsPath, port: opts.port });
  } catch (err) {
    fail(`${err.message}: ${settingsPath}`);
    return 1;
  }
  const skillPlan = skill ? planSkill(skill) : null;
  if (skillPlan?.state === 'refuse') {
    fail(skillPlan.reason);
    fail(`nothing was written. ${skillPlan.how}`);
    return 1;
  }
  if (plan.changed) describeHooks(plan, say);
  else say(`the hooks are already in ${settingsPath}: nothing to change`);
  if (skillPlan) say(`skill folder ${skillPlan.target} (${SKILL_STATE[skillPlan.state]})${skillPlan.state === 'same' ? '' : `: a copy of ${skillPlan.source} (${skillPlan.files.join(', ')})`}`);
  const skillTodo = skillPlan && skillPlan.state !== 'same';
  if (!plan.changed && !skillTodo) return 0;
  const go = await confirm(opts, io);
  if (go !== 'write') return go === 'dry' ? 0 : 1;
  // Both plans again, from the files as they are now (the prompt may have been open for a while), and before the
  // first write: what is refused here still leaves nothing written.
  let hooksNow;
  try {
    hooksNow = planClaudeHooks({ settingsPath, port: opts.port });
  } catch (err) {
    fail(`${err.message}: ${settingsPath}`);
    fail('nothing was written');
    return 1;
  }
  const skillNow = skillTodo ? planSkill(skill) : null;
  if (skillNow?.state === 'refuse') {
    fail(skillNow.reason);
    fail(`nothing was written. ${skillNow.how}`);
    return 1;
  }
  // The skill first, the settings file last: a copy that fails leaves the settings file as it was. Two files cannot
  // be written as one step, so a failure line names the part that is already there.
  const code = (err) => err?.code ?? err?.message ?? err;
  let copied = null;
  if (skillNow && skillNow.state !== 'same') {
    try {
      writeSkill(skillNow, skill.version);
    } catch (err) {
      fail(`failed: ${code(err)} while copying the skill to ${skillNow.target}`);
      fail(`the settings file was not changed. When the cause is gone, run init again: a folder this copy left behind is completed then, or refused when its marker file is not whole (then remove ${skillNow.target} yourself first). ${HOOKS_ONLY}`);
      return 1;
    }
    copied = skillNow.target;
    say(`copied the skill to ${copied}`);
  }
  if (hooksNow.changed) {
    try {
      installClaudeHooks({ settingsPath, port: opts.port }); // plans once more from the file, then writes
    } catch (err) {
      fail(`failed: ${code(err)} while writing ${settingsPath}`);
      // the backup is written before the settings file: a failure after it leaves the backup behind
      if (hooksNow.backupNeeded && fs.existsSync(hooksNow.backupPath)) fail(`the backup ${hooksNow.backupPath} was written before the failure and stays: a later install keeps it as it is`);
      if (copied) fail(`the skill was already copied to ${copied} and stays there. When the cause is gone, run init again (or office-sim hooks install) for the hooks; to take the copy back, remove that folder yourself`);
      return 1;
    }
    if (hooksNow.backupNeeded) say(`wrote backup ${hooksNow.backupPath}`);
    say(`wrote ${settingsPath}`);
  }
  say('done. A Claude Code session that is already open may not see the change until it is restarted');
  return 0;
}

async function uninstall(opts, io, { settingsPath }) {
  const { say, fail } = io;
  if (!fs.existsSync(settingsPath)) {
    say(`no settings file at ${settingsPath}: nothing to remove`);
    return 0;
  }
  let plan;
  try {
    plan = planClaudeUnhook({ settingsPath });
  } catch (err) {
    fail(`${err.message}: ${settingsPath}`);
    return 1;
  }
  if (plan.removedCount === 0) {
    say(`no office-sim hooks in ${settingsPath}: nothing to remove`);
    return 0;
  }
  say(`settings file ${settingsPath}`);
  say(`remove ${plan.removedCount} office-sim hook(s): ${Object.entries(plan.byEvent).map(([ev, n]) => `${ev} ${n}`).join(', ')}`);
  const go = await confirm(opts, io);
  if (go !== 'write') return go === 'dry' ? 0 : 1;
  try {
    const done = uninstallClaudeHooks({ settingsPath });
    say(`removed ${done.removedCount} office-sim hook(s) from ${settingsPath}`);
  } catch (err) {
    fail(`failed: ${err?.code ?? err?.message ?? err}`);
    return 1;
  }
  return 0;
}

async function status(opts, { say }, { settingsPath }) {
  const found = findClaudeHooks({ settingsPath });
  const what = { missing: 'no such file', unreadable: 'not JSON, cannot be read', ok: `${found.hooks.length} office-sim hook(s)` }[found.state];
  say(`settings file ${settingsPath}: ${what}`);
  const want = buildHookUrl({ port: opts.port });
  let hits = 0;
  for (const event of HOOK_EVENTS) {
    const ours = found.hooks.filter((h) => h.event === event && h.type === 'http');
    if (ours.some((h) => h.url === want)) {
      hits += 1;
      say(`hook ${event}: installed, posts to ${want}`);
    } else if (ours.length) {
      let port = '?';
      try { port = new URL(ours[0].url).port || '80'; } catch { /* not a URL we wrote */ }
      say(`hook ${event}: installed for port ${port}, not ${opts.port}`);
    } else say(`hook ${event}: not installed`);
  }
  const old = found.hooks.filter((h) => h.type === 'command').length;
  if (old) say(`${old} older command hook(s) of a version before 0.12.0 are in the file; office-sim hooks install replaces them`);
  say(`hooks installed: ${hits === HOOK_EVENTS.length ? 'yes' : hits === 0 ? 'no' : 'partly'}`);
  const answer = await probeHealthz({ host: DEFAULTS.host, port: opts.port });
  // null: the connection was refused, or what holds the port sent no answer in time or one too large to be /healthz
  let server = `no office-sim answers (nothing listens there, or a program holds the port and gave no usable /healthz answer in ${PROBE_TIMEOUT_MS / 1000} s)`;
  if (answer && isOfficeSimHealth(answer.status, answer.body)) server = 'running (an office-sim answers /healthz)';
  else if (answer?.status === 401 && answer.body.startsWith(AUTH_BODY)) server = 'running with --auth (hook requests carry no cookie and get 401 there, so no permission wait shows)';
  else if (answer) server = 'another program answers there';
  say(`server ${baseUrl(DEFAULTS.host, opts.port)}: ${server}`);
  say('note: hooks that come from the Claude Code plugin are not in this file and are not checked here');
  return found.state === 'unreadable' ? 1 : 0;
}

/**
 * Run one setup command. Returns the exit code: 0 done, nothing to do, or a dry run; 1 refused, declined, failed, or
 * no terminal and no --yes; 2 usage error.
 * @param {string[]} argv starting at `init` or `hooks`
 * @param {{ root: string, out?: (line: string) => void, err?: (line: string) => void, isTTY?: boolean,
 *   ask?: (question: string) => Promise<string>, homedir?: () => string }} deps
 *   root: the package root (the folder above bin/), which holds skills/office. homedir is called only without --home.
 */
export async function run(argv, {
  root, out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`),
  isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true, ask = askOnTerminal, homedir = os.homedir,
} = {}) {
  let opts;
  try {
    opts = parseCommand(argv);
  } catch (e) {
    err(`office-sim: ${e.message}\n\n${COMMAND_USAGE.trimEnd()}`);
    return 2;
  }
  if (opts.help) {
    out(COMMAND_USAGE.trimEnd());
    return 0;
  }
  const io = { say: (line) => out(`office-sim: ${line}`), fail: (line) => err(`office-sim: ${line}`), isTTY, ask };
  // the home directory is looked up only when a path needs it: `hooks ... --settings <path>` never does
  let home = null;
  const homeDir = () => (home ??= path.resolve(opts.home ?? homedir()));
  const settingsPath = path.resolve(opts.settings ?? path.join(homeDir(), '.claude', 'settings.json'));
  if (opts.command === 'status') return status(opts, io, { settingsPath });
  if (opts.command === 'uninstall') return uninstall(opts, io, { settingsPath });
  const skill = opts.command === 'init'
    ? { source: path.join(root, 'skills', 'office'), target: path.join(homeDir(), '.claude', 'skills', 'office'), version: packageVersion(root) }
    : null;
  return install(opts, io, { settingsPath, skill });
}
