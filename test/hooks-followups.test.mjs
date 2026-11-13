// Follow-up fixes to the Claude Code hook path and the setup commands (launch readiness W6, W7; contract 5, 6.3, 7.2):
// - `hooks uninstall` treats an empty settings file like `hooks install` and `hooks status` do: no hooks, no error;
// - the bridge's sent waits leave with the character or tool that leaves its open list, so they stay bounded;
// - a session only hooks report sends no text of `stop_reason` and no free text of `agent_type`;
// - the public mcp.log parser hands out a request id only in the shape of a name, else as a digest;
// - a settings write that fails after its backup was written says that the backup stays;
// - `init` follows a link above its skill folder as the user set it up (only the skill folder itself is never a link).
// Every file is under os.tmpdir(); no socket is opened and the real ~/.claude is never used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli-init.mjs';
import { parseClaudeHookPayload, planClaudeUnhook, uninstallClaudeHooks } from '../src/hooks-receiver.mjs';
import { parseMcpLogLine } from '../src/desktop-claude.mjs';
import { setup, permission, SID } from './fixtures/hooks-bridge.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-followups-'));
  tmpDirs.push(d);
  return d;
}
const noHome = () => { throw new Error('the real home directory was asked for'); };
const neverAsk = () => { throw new Error('the prompt was shown'); };
async function cli(argv, { home }) {
  const lines = [];
  const errs = [];
  const code = await run([...argv, '--home', home], { root: REPO, out: (l) => lines.push(l), err: (l) => errs.push(l), isTTY: false, ask: neverAsk, homedir: noHome });
  return { code, text: lines.join('\n'), errText: errs.join('\n') };
}
const settingsOf = (home) => path.join(home, '.claude', 'settings.json');
const cannotRestrict = process.platform === 'win32' || process.getuid?.() === 0;

test('uninstall on an empty or whitespace-only settings file: nothing to remove, no error, the file stays', async () => {
  for (const content of ['', '  \n', '\n\n\t']) {
    const home = tmpDir();
    fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
    fs.writeFileSync(settingsOf(home), content);
    const settingsPath = settingsOf(home);
    assert.deepEqual(planClaudeUnhook({ settingsPath }), { settingsPath, removedCount: 0, byEvent: {}, text: null });
    assert.deepEqual(uninstallClaudeHooks({ settingsPath }), { removed: false, removedCount: 0, settingsPath });
    const r = await cli(['hooks', 'uninstall', '--yes'], { home });
    assert.equal(r.code, 0, r.errText);
    assert.match(r.text, /nothing to remove/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), content, 'not rewritten');
    assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ['settings.json'], 'no backup');
  }
});

const sidOf = (i) => `0a1b2c3d-1111-4222-8333-${String(i).padStart(12, '0')}`;

test('sent waits leave with a character that is dropped from the open list (never more waits than open tools)', () => {
  const { bridge, store, clock } = setup({ chars: {} }); // sessions only hooks report: the Store has no entry
  const total = 1003;
  for (let i = 0; i < total; i += 1) {
    const sessionId = sidOf(i);
    store.push({ type: 'tool_start', sessionId, ts: new Date(clock.ms).toISOString(), toolUseId: `toolu_${i}`, tool: 'Bash', summary: 'Bash' });
    bridge.handle(permission({ session_id: sessionId, transcript_path: undefined }));
  }
  assert.equal(bridge.stats().waits, total, 'every prompt was shown');
  assert.equal(bridge.open.size, 1000);
  assert.equal(bridge.stats().openWaits, 1000, 'the three oldest characters took their waits with them');
  assert.equal(bridge.hasWait(sidOf(0)), false);
  assert.equal(bridge.hasWait(sidOf(total - 1)), true);
});

test('sent waits leave with a tool that is dropped from a character\'s open list', () => {
  const { bridge, start, clock } = setup();
  const total = 258;
  for (let i = 0; i < total; i += 1) {
    start(`toolu_${i}`);
    bridge.handle(permission());
    clock.ms += 2000; // past the repeat window: the next body is a new prompt
  }
  assert.equal(bridge.stats().waits, total);
  assert.equal(bridge.open.get(SID).size, 256);
  assert.equal(bridge.stats().openWaits, 256);
});

const hookOnly = (extra) => parseClaudeHookPayload({ session_id: SID, cwd: '/work/demo', ...extra }, { now: () => Date.parse('2026-01-01T00:00:00.000Z') });
const BAIT = 'BAITXYZ reason password=BAITXYZ /Users/someone/secret.txt';

test('a hook-only StopFailure sends a fixed line: stop_reason is not read', () => {
  const { events } = hookOnly({ hook_event_name: 'StopFailure', stop_reason: BAIT });
  assert.deepEqual(events.map((e) => e.type), ['system', 'turn_end']);
  assert.equal(events[0].text, 'API error / rate limit');
  assert.equal(JSON.stringify(events).includes('BAITXYZ'), false);
  assert.equal(hookOnly({ hook_event_name: 'StopFailure' }).events[0].text, 'API error / rate limit');
});

test('a hook-only SubagentStart shows agent_type only when it has the shape of a name', () => {
  const summary = (agent_type) => hookOnly({ hook_event_name: 'SubagentStart', agent_type }).events[0].summary;
  for (const name of ['Explore', 'general-purpose', 'codex:codex-rescue', 'a.b_c-1', 'x'.repeat(64)]) assert.equal(summary(name), name);
  for (const odd of [BAIT, 'two words', 'bob@example.com', '/Users/x', 'x'.repeat(65), '', 7, null, undefined, { name: 'Explore' }]) {
    assert.equal(summary(odd), 'subagent', util(odd));
  }
});
function util(v) { return typeof v === 'string' ? JSON.stringify(v) : String(v); }

test('parseMcpLogLine: a request id is handed out as a name-shaped id or as a digest, never as free text', () => {
  const T = '2026-10-23T05:01:00.000Z';
  const client = (rest) => `${T} [info] [Filesystem] Message from client: ${rest}`;
  const server = (rest) => `${T} [info] [Filesystem] Message from server: ${rest}`;
  const call = (id) => parseMcpLogLine(client(JSON.stringify({ method: 'tools/call', params: { name: 'read_file', arguments: {} }, jsonrpc: '2.0', id })));
  const result = (id) => parseMcpLogLine(server(JSON.stringify({ jsonrpc: '2.0', id, result: {} })));
  assert.equal(call(7).reqId, '7');
  assert.equal(call('req-9').reqId, 'req-9');
  for (const odd of ['BAIT /Users/x', 'bob@example.com', 'x'.repeat(65), 'two words']) {
    assert.match(call(odd).reqId, /^#[0-9a-f]{16}$/, odd);
    assert.equal(call(odd).reqId, result(odd).reqId, 'a call and its result still share the id');
    assert.equal(JSON.stringify([call(odd), result(odd)]).includes(odd), false, odd);
  }
});

test('a settings write that fails after the backup was written says that the backup stays', { skip: cannotRestrict && 'a read-only file stops no write here' }, async () => {
  const home = tmpDir();
  const settingsPath = settingsOf(home);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const mine = '{"theme":"dark"}\n';
  fs.writeFileSync(settingsPath, mine);
  fs.chmodSync(settingsPath, 0o444);
  try {
    const r = await cli(['hooks', 'install', '--yes'], { home });
    const backup = `${settingsPath}.office-sim.bak`;
    assert.equal(r.code, 1);
    assert.ok(r.errText.includes(`office-sim: failed: EACCES while writing ${settingsPath}`), r.errText);
    assert.ok(r.errText.includes(`the backup ${backup} was written before the failure and stays`), r.errText);
    assert.equal(fs.readFileSync(backup, 'utf8'), mine, 'the backup is the file as it was');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), mine, 'the settings file is unchanged');
    assert.doesNotMatch(r.text, /^office-sim: wrote /m, 'no line claims a write');
  } finally {
    fs.chmodSync(settingsPath, 0o644);
  }
});

test('init follows a link above its skill folder: the copy lands where <home>/.claude/skills points', { skip: process.platform === 'win32' && 'links need a privilege here' }, async () => {
  const home = tmpDir();
  const elsewhere = tmpDir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(home, '.claude', 'skills'));
  const r = await cli(['init', '--yes'], { home });
  assert.equal(r.code, 0, r.errText);
  assert.ok(fs.lstatSync(path.join(home, '.claude', 'skills')).isSymbolicLink(), 'the link stays a link');
  assert.deepEqual(fs.readFileSync(path.join(elsewhere, 'office', 'SKILL.md')), fs.readFileSync(path.join(REPO, 'skills', 'office', 'SKILL.md')));
  assert.equal(fs.lstatSync(path.join(elsewhere, 'office')).isDirectory(), true, 'the skill folder itself is a real folder');
});

// ---- second round: what the independent review of the fixes above found untested ----

test('status and install agree with uninstall on an empty settings file: no hooks, and install treats it as {}', async () => {
  for (const content of ['', '  \n']) {
    const home = tmpDir();
    fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
    fs.writeFileSync(settingsOf(home), content);
    const status = await cli(['hooks', 'status', '--port', '1'], { home });
    assert.equal(status.code, 0, status.errText);
    assert.match(status.text, /hooks installed: no/);
    assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), content, 'status writes nothing');
    const install = await cli(['hooks', 'install', '--yes'], { home });
    assert.equal(install.code, 0, install.errText);
    const hooks = JSON.parse(fs.readFileSync(settingsOf(home), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PermissionRequest']);
    assert.equal(fs.readFileSync(`${settingsOf(home)}.office-sim.bak`, 'utf8'), content, 'the backup is the empty file as it was');
  }
});

test('the hook-only parser hands out no stop reason, and a SessionStart title is scrubbed and capped', () => {
  assert.equal('stopReason' in hookOnly({ hook_event_name: 'StopFailure', stop_reason: BAIT }), false);
  const title = (cwd) => hookOnly({ hook_event_name: 'SessionStart', cwd }).events[0].title;
  assert.equal(title('/work/demo'), 'demo');
  assert.ok(title(`/work/${'x'.repeat(300)}`).length <= 80, 'a long folder name is cut to the title cap');
  assert.equal(title('/work/bob@example.com').includes('bob@example.com'), false, 'an address in a folder name is masked');
});

test('forget goes by the character id, not by a key prefix: an id that starts like another keeps its wait', () => {
  const A = '0a1b2c3d-1111-4222-8333-444455556666';
  const B = `${A}-b`;
  const { bridge, store, clock } = setup({ chars: {} });
  const ts = () => new Date(clock.ms).toISOString();
  for (const sessionId of [A, B]) {
    store.push({ type: 'tool_start', sessionId, ts: ts(), toolUseId: 'T|1', tool: 'Bash', summary: 'Bash' });
    bridge.handle(permission({ session_id: sessionId, transcript_path: undefined }));
  }
  assert.equal(bridge.stats().openWaits, 2);
  // an id that only looks like a key of A ("<A>|T") must not take A's wait with it
  store.push({ type: 'session_end', sessionId: `${A}|T`, ts: ts(), reason: 'done' });
  assert.equal(bridge.stats().openWaits, 2);
  store.push({ type: 'session_end', sessionId: A, ts: ts(), reason: 'done' });
  assert.equal(bridge.hasWait(A), false);
  assert.equal(bridge.hasWait(B), true, 'the other character keeps its wait');
});

test('transition from hook-only to transcript-followed Claude session purges open synthetic legacy-hook tools', () => {
  const { bridge, store, events, clock } = setup({ chars: {} });
  const sid = 'hook-only-takeover-1';
  bridge.handle({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
  const startEv = events.find((e) => e.type === 'tool_start');
  assert.ok(startEv?.toolUseId?.startsWith('hook_'), 'pre-takeover hook created synthetic tool');
  assert.equal(bridge.legacyOpen.get(sid)?.size, 1);

  clock.ms += 500;
  store.byChar.set(sid, { agent: 'claude-code', sid });
  store.push({ type: 'session', sessionId: sid, ts: new Date(clock.ms).toISOString(), agent: 'claude-code', project: '/w/app' });

  assert.equal(bridge.legacyOpen.has(sid), false, 'legacyOpen cleared on transcript takeover');
  const endEv = events.find((e) => e.type === 'tool_end' && e.toolUseId === startEv.toolUseId);
  assert.ok(endEv, 'abandoned tool_end emitted for synthetic legacy-hook tool');
  assert.equal(endEv.ok, false);
  assert.equal(endEv.errorKind, 'abandoned');
  assert.equal(bridge.stats().openWaits, 0);
});

test('the backup line is printed only for a backup this run wrote', { skip: cannotRestrict && 'a read-only file stops no write here' }, async () => {
  // the backup is already there: the settings write fails, and no line claims a backup
  const home = tmpDir();
  const settingsPath = settingsOf(home);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
  fs.writeFileSync(`${settingsPath}.office-sim.bak`, 'older backup\n');
  fs.chmodSync(settingsPath, 0o444);
  try {
    const r = await cli(['hooks', 'install', '--yes'], { home });
    assert.equal(r.code, 1);
    assert.ok(r.errText.includes(`office-sim: failed: EACCES while writing ${settingsPath}`), r.errText);
    assert.doesNotMatch(r.errText, /was written before the failure/);
    assert.equal(fs.readFileSync(`${settingsPath}.office-sim.bak`, 'utf8'), 'older backup\n');
  } finally {
    fs.chmodSync(settingsPath, 0o644);
  }
  // the backup cannot be made (a read-only folder): the failure names the backup, and the settings file is unchanged
  const home2 = tmpDir();
  const settings2 = settingsOf(home2);
  fs.mkdirSync(path.dirname(settings2), { recursive: true });
  fs.writeFileSync(settings2, '{"theme":"dark"}\n');
  fs.chmodSync(path.dirname(settings2), 0o555);
  try {
    const r = await cli(['hooks', 'install', '--yes'], { home: home2 });
    assert.equal(r.code, 1);
    assert.ok(r.errText.includes(`office-sim: failed: EACCES while writing the backup ${settings2}.office-sim.bak`), r.errText);
    assert.ok(r.errText.includes('the settings file was not changed'), r.errText);
    assert.doesNotMatch(r.errText, /was written before the failure/);
    assert.equal(fs.readFileSync(settings2, 'utf8'), '{"theme":"dark"}\n');
    assert.equal(fs.existsSync(`${settings2}.office-sim.bak`), false);
  } finally {
    fs.chmodSync(path.dirname(settings2), 0o755);
  }
});

test('install through a settings file that is a link: the target is written and the backup sits beside the link', { skip: process.platform === 'win32' && 'links need a privilege here' }, async () => {
  const home = tmpDir();
  const elsewhere = tmpDir();
  const target = path.join(elsewhere, 'real-settings.json');
  fs.writeFileSync(target, '{"theme":"dark"}\n');
  fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
  fs.symlinkSync(target, settingsOf(home));
  const r = await cli(['hooks', 'install', '--yes'], { home });
  assert.equal(r.code, 0, r.errText);
  assert.ok(fs.lstatSync(settingsOf(home)).isSymbolicLink(), 'the link stays a link');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8'))).sort(), ['hooks', 'theme']);
  assert.equal(fs.readFileSync(`${settingsOf(home)}.office-sim.bak`, 'utf8'), '{"theme":"dark"}\n');
  assert.equal(fs.lstatSync(`${settingsOf(home)}.office-sim.bak`).isFile(), true);
});

test('the marketplace file carries a description (claude plugin validate warns without one)', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(typeof marketplace.metadata?.description, 'string');
  assert.ok(marketplace.metadata.description.length > 20);
});
