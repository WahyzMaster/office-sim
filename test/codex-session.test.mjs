// CodexSession (src/adapters/codex/session.mjs): Codex rollout records -> UI events through SessionCore. One test per
// mapping row of ADAPTERS 5.1 / 6.1 / 6.2 (Codex column), named after the row, in both the old (< 0.142.5, per-tool
// calls, response_item text) and the new (code mode, item_completed text) cli_version shapes where they differ; the
// duplicated say / thinking sources; the subagent history start (skip, reset, fallback, live drop); ordinal dedupe; and a
// long mixed scenario that compares replay-mode state with live-mode state. Synthetic records only (test/fixtures/codex.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexSession } from '../src/adapters/codex/session.mjs';
import { END_TURN_IDLE_MS, SUB_IDLE_MS } from '../src/core/session-core.mjs';
import {
  createCodexBuilder, cloneRecord, out, CODEX_THREAD, CODEX_CHILD, CODEX_GRANDCHILD, OLD_VERSION, NEW_VERSION,
} from './fixtures/codex.mjs';

const MAIN_ID = `codex-${CODEX_THREAD}`;
const CHILD_ID = `codex-${CODEX_CHILD}`;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');

function mk({ version = NEW_VERSION, id = MAIN_ID, kind = 'main', threadId = CODEX_THREAD, ...o } = {}) {
  const clock = { t: T0 };
  const s = new CodexSession({ id, agent: 'codex', kind, parentId: kind === 'sub' ? MAIN_ID : null, now: () => clock.t,
    file: '/tmp/x', stem: 'x', ...o });
  return { s, clock, g: createCodexBuilder({ threadId, cliVersion: version }) };
}
const run = (s, recs, opts) => recs.flat().flatMap((r) => s.apply(r, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const noTs = (evs) => evs.map(({ ts, ...rest }) => rest);
const opening = (g, text = 'Fix the login bug') => [g.sessionMeta(), g.taskStarted(), g.userMessage(text)];
// The normalized items CodexSession hands to SessionCore (item order checks).
function spyItems(s) {
  const items = [];
  const wrap = (core) => {
    const orig = core.apply.bind(core);
    core.apply = (it, o) => {
      items.push(it.k);
      return orig(it, o);
    };
  };
  wrap(s.core);
  return items;
}

// ---------------------------------------------------------------------------------------------- identity rows

test('row session_meta: cwd and branch on the first session event, no account id or instructions anywhere', () => {
  const { s, g } = mk();
  const evs = run(s, [g.sessionMeta()]);
  assert.deepEqual(noTs(evs), [{
    type: 'session', sessionId: MAIN_ID, agent: 'codex', project: '/work/codex-repo', projectLabel: 'codex-repo',
    title: '019a2b3c', branch: 'feat/login', worktree: null, isSubagent: false, parentSessionId: null,
  }]);
  assert.equal(s.firstCwd, '/work/codex-repo');
  assert.doesNotMatch(JSON.stringify([evs, s.snapshotEvents(), s.debugState()]), /BAIT|bait/);
});

test('row session_meta: another thread\'s copy (inherited context) and a repeat are ignored; turn_context cwd only as a fallback', () => {
  const { s, g } = mk();
  const other = createCodexBuilder({ threadId: CODEX_GRANDCHILD }).sessionMeta({ cwd: '/work/other', branch: 'main' });
  run(s, [g.sessionMeta({ cwd: '/work/codex-repo' }), g.inherit([other])[0], g.turnContext({ cwd: '/work/ctx' })]);
  assert.equal(s.firstCwd, '/work/codex-repo');
  assert.equal(s.sessionEvent().branch, 'feat/login');
  const { s: s2, g: g2 } = mk();
  run(s2, [g2.sessionMeta({ cwd: 'not/absolute' }), g2.turnContext({ cwd: '/work/from-context' }), g2.turnContext({ cwd: '/work/later' })]);
  assert.equal(s2.firstCwd, '/work/from-context', 'turn_context gives the cwd only when session_meta had none');
  assert.equal(s2.debugState().codex.cliVersion, NEW_VERSION);
});

test('row session_meta (sub): agentType from the role, the nickname as the fallback title, the sidecar title wins', () => {
  const { s, g } = mk({ id: CHILD_ID, kind: 'sub', threadId: CODEX_CHILD });
  const evs = run(s, [g.sessionMeta({ sub: { parent: CODEX_THREAD, role: 'explorer', nickname: 'Hume' } })]);
  const ev = of(evs, 'session')[0];
  assert.equal(ev.isSubagent, true);
  assert.equal(ev.parentSessionId, MAIN_ID);
  assert.equal(ev.agentType, 'explorer');
  assert.equal(ev.title, 'Hume');
  const info = s.setInfo({ title: 'Explore the auth module' });
  assert.equal(of(info, 'session')[0].title, 'Explore the auth module');
  const { s: r, g: rg } = mk({ id: CHILD_ID, kind: 'sub', threadId: CODEX_CHILD });
  assert.equal(of(run(r, [rg.sessionMeta({ review: true })]), 'session')[0].agentType, 'review', 'D10d');
});

// ---------------------------------------------------------------------------------------------- turn rows

test('row task_started: turn_start with the turn id comes before the prompt; a start without an end -> next_turn', () => {
  const { s, g } = mk();
  const items = spyItems(s);
  const evs = run(s, [...opening(g), ...g.say('Working.'), g.taskStarted(), g.userMessage('Second prompt')]);
  assert.deepEqual(items.slice(0, 3), ['meta', 'turn_start', 'prompt']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['next_turn']);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug', 'Second prompt']);
  assert.equal(s.debugState().turnId, g.turnId);
});

test('row task_started with the current turn id: the same turn (core keeps its calls open, so their outputs still pair)', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  run(s, [...opening(g), g.execCommand('npm test')]);
  const again = run(s, [g.taskStarted({ turnId: g.turnId }), g.functionOutput({ output: out.execCommand() })]);
  assert.equal(of(again, 'turn_end').length, 0);
  assert.deepEqual(of(again, 'tool_end').map((e) => e.ok), [true]);
  assert.equal(s.snapshotEvents().filter((e) => e.type === 'tool_start').length, 0, 'nothing left open');
});

test('row task_complete: turn_end end_turn; open calls are abandoned; a late end of an older turn is ignored', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const evs = run(s, [...opening(g), g.execCommand('npm test'), g.taskComplete()]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => e.errorKind), ['abandoned']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
  const firstTurn = g.turnId;
  const late = run(s, [g.taskStarted(), g.execCommand('ls'), g.taskComplete({ turnId: firstTurn }), g.turnAborted({ turnId: firstTurn })]);
  assert.equal(of(late, 'turn_end').length, 0, 'stale ends of the previous turn do nothing');
  assert.equal(of(late, 'tool_end').length, 0);
  assert.equal(s.debugState().turnOpen, true);
});

test('row task_complete with error: system api_error (first line, scrubbed) then turn_end api_error', () => {
  const { s, g } = mk();
  const evs = run(s, [...opening(g), g.taskComplete({ error: 'stream disconnected before completion\nBAIT_SYSTEM_SECOND_LINE /Users/bait-user/x' })]);
  assert.deepEqual(noTs(of(evs, 'system')), [{ type: 'system', sessionId: MAIN_ID, kind: 'api_error', text: 'stream disconnected before completion' }]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['api_error']);
  const e2 = run(s, [g.taskStarted(), g.taskComplete({ error: '' })]);
  assert.equal(of(e2, 'system')[0].text, 'API error', 'fallback text');
  assert.doesNotMatch(JSON.stringify(evs), /BAIT|bait/);
});

test('row turn_aborted: every open call ends interrupted, then turn_end interrupt', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const evs = run(s, [...opening(g), g.execCommand('npm run dev'), g.shellCommand('make'), g.turnAborted()]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.errorKind, e.error]), [['interrupted', 'interrupted'], ['interrupted', 'interrupted']]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['interrupt']);
  assert.equal(s.snapshotEvents().filter((e) => e.type === 'tool_start').length, 0);
});

// ---------------------------------------------------------------------------------------------- text rows

test('row item_completed UserMessage: the prompt; text starting with < is skipped; role:user messages are never prompts', () => {
  const { s, g } = mk();
  const evs = run(s, [
    g.sessionMeta(), g.taskStarted(), g.userContext(), g.developer(), g.userMessage('<heartbeat>tick</heartbeat>'),
    g.userMessage('<environment_context>BAIT_INJECTED</environment_context>'), g.userMessage('Fix the login bug'),
    g.agentMessage(), g.worldState(),
  ]);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug']);
  assert.equal(s.title, 'Fix the login bug', 'the first human input is the title fallback');
  assert.doesNotMatch(JSON.stringify(evs), /BAIT|Ignore all previous|AGENTS\.md/);
});

test('row item_completed UserMessage: an IDE context wrapper is stripped before the prompt and the title fallback', () => {
  const { s, g } = mk();
  const wrapped = '# Context from my IDE setup:\n\n## Active file: /Users/bait-user/proj/BAIT_ACTIVE.ts\n\n## Open tabs:\n- BAIT_TAB.ts\n\n'
    + '## My request for Codex:\nMake the login form remember the user';
  const evs = run(s, [g.sessionMeta(), g.taskStarted(), g.userMessage(wrapped)]);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Make the login form remember the user']);
  assert.equal(s.title, 'Make the login form remember the user');
  assert.doesNotMatch(JSON.stringify([evs, s.snapshotEvents()]), /BAIT|Context from my IDE|Active file/);
});

test('row item_completed UserMessage (sub): a child never sends its task as a prompt or title', () => {
  const { s, g } = mk({ id: CHILD_ID, kind: 'sub', threadId: CODEX_CHILD });
  const evs = run(s, [g.sessionMeta({ sub: { role: 'worker' } }), g.taskStarted(), g.userMessage('BAIT_SUB_TASK do the work')]);
  assert.equal(of(evs, 'prompt').length, 0);
  assert.doesNotMatch(JSON.stringify([evs, s.sessionEvent()]), /BAIT_SUB_TASK/);
  const { s: m, g: mg } = mk();
  const evs2 = run(m, [mg.sessionMeta({ sub: { role: 'worker' } }), mg.taskStarted(), mg.userMessage('BAIT_SUB_TASK as a main')]);
  assert.equal(of(evs2, 'prompt').length, 0, 'a child attached as a main knows from its own line that it runs a task');
});

test('row AgentMessage / Reasoning (new version): say and thinking from item_completed only, durationMs from the item', () => {
  const { s, g } = mk({ version: NEW_VERSION });
  const evs = run(s, [...opening(g), ...g.think('Reading the auth code. Then more.'), ...g.say('I found it.')]);
  assert.deepEqual(noTs(of(evs, 'thinking')), [{ type: 'thinking', sessionId: MAIN_ID, text: 'Reading the auth code.', durationMs: 1200 }]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['I found it.'], 'the response_item duplicate is not read');
  assert.equal(s.debugState().codex.source, 'item');
});

test('row response_item message / reasoning (old version): say and thinking from response_item only', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const evs = run(s, [...opening(g), ...g.think('Reading the auth code.'), ...g.say('I found it.'), ...g.think(null)]);
  assert.deepEqual(of(evs, 'thinking').map((e) => [e.text, e.durationMs]), [['Reading the auth code.', null], [null, null]],
    'an empty summary is a signature-only thinking (text null)');
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['I found it.']);
  assert.equal(s.debugState().codex.source, 'response');
});

test('duplicate sources: only one copy of each message whatever the order, and a single copy is not lost', () => {
  for (const version of [OLD_VERSION, NEW_VERSION]) {
    const { s, g } = mk({ version });
    const [item, resp] = g.say('Same text.');
    const evs = run(s, [...opening(g), resp, item, ...g.think('One thought.').reverse()]);
    assert.equal(of(evs, 'say').length, 1, version);
    assert.equal(of(evs, 'thinking').length, 1, version);
  }
  const { s, g } = mk({ version: 'unknown-build' });
  const evs = run(s, [g.sessionMeta(), g.taskStarted(), g.assistantMessage('Only the response copy.')]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Only the response copy.'], 'an unknown version reads response_item');
});

test('row say phase final_answer: arms the end_turn idle fallback (core), commentary does not', () => {
  const { s, g, clock } = mk();
  run(s, [...opening(g), ...g.say('Commentary.')]);
  clock.t += END_TURN_IDLE_MS + 1;
  assert.equal(of(s.idle(clock.t), 'turn_end').length, 0);
  run(s, [...g.say('All done.', { phase: 'final_answer' })]);
  clock.t += END_TURN_IDLE_MS + 1;
  assert.deepEqual(of(s.idle(clock.t), 'turn_end').map((e) => e.reason), ['end_turn']);
});

test('row item_completed Plan: plan { markdown } -> an exit_plan board of at most 6 items', () => {
  const { s, g } = mk();
  const evs = run(s, [...opening(g), g.planItem('# Plan\n\n1. Read the auth code\n2. Fix the token check\n3. Add a test')]);
  const p = of(evs, 'plan')[0];
  assert.equal(p.source, 'exit_plan');
  assert.deepEqual(p.items.map((i) => i.content), ['Plan', 'Read the auth code', 'Fix the token check', 'Add a test'],
    'the shared planFromMarkdown keeps headings as items (as for Claude ExitPlanMode)');
  const long = run(s, [g.planItem(Array.from({ length: 12 }, (_, i) => `${i + 1}. Step ${i + 1}`).join('\n'))]);
  assert.equal(of(long, 'plan')[0].items.length, 6);
});

test('row item_completed SubAgentActivity: completed / interrupted -> an end hint for the child; started / interacted nothing', () => {
  const { s, g } = mk();
  const evs = run(s, [
    ...opening(g), g.subAgentActivity({ kind: 'started' }), g.subAgentActivity({ kind: 'interacted' }),
    g.subAgentActivity({ kind: 'completed' }), g.subAgentActivity({ child: CODEX_GRANDCHILD, kind: 'interrupted' }),
    g.subAgentActivity({ child: 'bad/id', kind: 'completed' }),
  ]);
  assert.deepEqual(evs.filter((e) => e.hint), [
    { hint: 'end', charId: CHILD_ID, reason: 'done' }, { hint: 'end', charId: `codex-${CODEX_GRANDCHILD}`, reason: 'done' },
  ]);
  const replayed = mk();
  const hints = run(replayed.s, [...opening(replayed.g), replayed.g.subAgentActivity()], { replay: true });
  assert.deepEqual(hints, [], 'replay returns nothing: the child\'s last lifecycle entry decides when the replay ends');
  assert.deepEqual(replayed.s.idle(T0).filter((e) => e.hint), [{ hint: 'end', charId: CHILD_ID, reason: 'done' }], 'and keeps it');
});

test('row compacted: one system compact (the summary text is not read); compaction duplicates are ignored', () => {
  const { s, g } = mk();
  const evs = run(s, [...opening(g), g.compacted(), g.compaction(), g.contextCompactionItem()]);
  assert.deepEqual(noTs(of(evs, 'system')), [{ type: 'system', sessionId: MAIN_ID, kind: 'compact', text: 'Conversation compacted' }]);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/);
});

test('row noise and unknown types: no events (token_count, settings, goals, usage, world_state, unknown kinds)', () => {
  const { s, g } = mk();
  run(s, opening(g));
  const evs = run(s, [
    g.tokenCount(), g.threadSettings(), g.goalUpdated(), g.tokenUsage(), g.worldState(), g.interAgentMeta(), g.agentMessage(),
    g.unknown(), g.unknownEvent(), g.collabItem(), g.extensionItem(),
  ]);
  assert.deepEqual(evs, []);
  assert.equal(s.skipped, 0, 'known noise and unknown kinds are ignored, not counted as malformed');
  assert.deepEqual(run(s, [null, { type: 'x' }, 'junk']), []);
  assert.equal(s.skipped, 3);
});

// ---------------------------------------------------------------------------------------------- dedupe and order

test('dedupe: a record with an ordinal seen before yields nothing (R9), a repeated call_id opens nothing', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const recs = [...opening(g), g.execCommand('npm test')];
  const first = run(s, recs);
  assert.deepEqual(run(s, recs.map((r) => cloneRecord(r))), []);
  const again = cloneRecord(recs[3]);
  again.ordinal = 99;
  assert.deepEqual(run(s, [again]), [], 'same call_id at a new ordinal: no second tool_start');
  assert.equal(of(first, 'tool_start').length, 1);
});

test('R12: file order wins; timestamps that go backwards never reorder or drop records', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const recs = [...opening(g), g.execCommand('npm test'), g.functionOutput({ output: out.execCommand() })];
  recs[4].timestamp = '2026-10-20T08:00:00.000Z';
  const evs = run(s, recs);
  assert.deepEqual(evs.map((e) => e.type), ['session', 'prompt', 'session', 'tool_start', 'tool_end']);
});

// ---------------------------------------------------------------------------------------------- history start

function childFile({ withOwn = true } = {}) {
  const parent = createCodexBuilder({ threadId: CODEX_THREAD, cliVersion: NEW_VERSION });
  const inherited = [parent.sessionMeta(), parent.taskStarted(), parent.userMessage('BAIT_PARENT_PROMPT'),
    parent.updatePlan([{ step: 'BAIT_PARENT_PLAN', status: 'pending' }]), parent.functionOutput({ output: out.planUpdated() }),
    parent.spawnAgent(), parent.subAgentActivity({ child: CODEX_GRANDCHILD })];
  const c = createCodexBuilder({ threadId: CODEX_CHILD, cliVersion: NEW_VERSION });
  const H = 1 + inherited.length;
  const recs = [c.sessionMeta({ sub: { parent: CODEX_THREAD, role: 'explorer', nickname: 'Hume' }, historyStart: H }), ...c.inherit(inherited)];
  if (withOwn) {
    recs.push(c.taskStarted(), c.agentMessage(), ...c.think('Exploring.'), c.exec('await tools.exec_command({})'),
      c.commandItem({ script: 'rg -n auth src' }));
  }
  return { recs, c, H };
}
const mkChild = () => mk({ id: CHILD_ID, kind: 'sub', threadId: CODEX_CHILD });

test('history start: records before subagent_history_start_ordinal are inherited context and leave no trace', () => {
  const { s } = mkChild();
  const { recs } = childFile();
  const replayed = run(s, recs, { replay: true });
  assert.deepEqual(replayed, [], 'no hint from the inherited SubAgentActivity');
  const live = s.idle(T0);
  assert.equal(live.filter((e) => e.hint).length, 0);
  const st = s.debugState();
  assert.equal(st.plan, null, 'the parent\'s plan is not the child\'s board');
  assert.equal(st.codex.hist, 'own');
  assert.equal(st.codex.resets, 1);
  const snap = s.snapshotEvents();
  assert.deepEqual(snap.filter((e) => e.type === 'tool_start').map((e) => e.tool), ['exec'], 'only the child\'s own open exec');
  assert.equal(snap[0].title, 'Hume');
  assert.equal(snap[0].agentType, 'explorer', 'meta survives the reset');
  assert.doesNotMatch(JSON.stringify(snap), /BAIT/);
});

test('history start: the same file live from the start gives the same state (inherited lines dropped, never shown)', () => {
  const { recs } = childFile();
  const a = mkChild();
  run(a.s, recs, { replay: true });
  a.s.idle(T0);
  const b = mkChild();
  const evs = run(b.s, recs);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/);
  assert.equal(of(evs, 'tool_start').some((e) => e.tool === 'collaboration.spawn_agent'), false, 'the parent\'s inherited spawn never shows');
  assert.equal(of(evs, 'plan').length, 0, 'nor its plan');
  assert.equal(evs.filter((e) => e.hint).length, 0);
  assert.deepEqual(noTs(b.s.snapshotEvents()), noTs(a.s.snapshotEvents()));
  const strip = (st) => ({ ...st, codex: { ...st.codex, dropped: 0, resets: 0 } });
  assert.deepEqual(strip(b.s.debugState()), strip(a.s.debugState()));
  assert.equal(b.s.debugState().codex.dropped, 6);
});

test('history start fallback: when skipping would leave nothing, everything after line 0 is read (old migrated files)', () => {
  const { s } = mkChild();
  const c = createCodexBuilder({ threadId: CODEX_CHILD, cliVersion: '0.120.0' });
  // a migrated old child: H equals the file length, so every record after line 0 sits before H
  const meta = c.sessionMeta({ sub: { role: 'worker' }, historyStart: 6 });
  const own = [c.taskStarted(), c.updatePlan([{ step: 'Own step', status: 'in_progress' }]), c.functionOutput({ output: out.planUpdated() }),
    c.subAgentActivity({ child: CODEX_GRANDCHILD }), c.execCommand('npm test')];
  assert.equal(c.ordinal, 6);
  const recs = [meta, ...own];
  assert.deepEqual(run(s, recs, { replay: true }), [], 'held until the replay ends');
  const settled = s.idle(T0);
  assert.deepEqual(settled.filter((e) => e.hint), [{ hint: 'end', charId: `codex-${CODEX_GRANDCHILD}`, reason: 'done' }]);
  const st = s.debugState();
  assert.equal(st.codex.hist, 'fallback');
  assert.deepEqual(st.plan.items, [{ content: 'Own step', status: 'in_progress' }]);
  assert.deepEqual(s.snapshotEvents().filter((e) => e.type === 'tool_start').map((e) => e.tool), ['exec_command']);
  const more = run(s, [c.functionOutput({ output: out.execCommand() })]);
  assert.deepEqual(of(more, 'tool_end').map((e) => e.ok), [true], 'later records keep flowing');
});

test('history start: inherited lines that arrive after the attach replay are dropped until the child\'s own records', () => {
  const { s } = mkChild();
  const { recs, H } = childFile();
  const [meta, ...rest] = recs;
  run(s, [meta], { replay: true });
  s.idle(T0); // the Runner publishes the file here
  const evs = run(s, rest);
  assert.equal(s.debugState().codex.dropped, H - 2, 'every inherited line but the parent\'s session_meta copy (ignored as another thread)');
  assert.equal(evs.filter((e) => e.hint).length, 0);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.tool), ['exec', 'exec_command']);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/);
});

test('history start: no or a trivial subagent_history_start_ordinal skips nothing', () => {
  for (const historyStart of [undefined, 0, 1]) {
    const { s, g } = mkChild();
    const evs = run(s, [g.sessionMeta({ sub: { role: 'worker' }, historyStart }), g.taskStarted(), g.execCommand('ls')]);
    assert.equal(of(evs, 'tool_start').length, 1, String(historyStart));
    assert.equal(s.debugState().codex.hist, 'none');
  }
});

test('sub idle: a child with no open tools ends idle after SUB_IDLE_MS; a parent\'s SubAgentActivity is its end hint', () => {
  const { s, g, clock } = mkChild();
  run(s, [g.sessionMeta({ sub: { role: 'worker' } }), g.taskStarted(), g.execCommand('ls'), g.functionOutput({ output: out.execCommand() })]);
  clock.t += SUB_IDLE_MS + 1;
  assert.deepEqual(of(s.idle(clock.t), 'session_end').map((e) => e.reason), ['idle']);
});

// ---------------------------------------------------------------------------------------------- long mixed scenarios

function longScenario(version) {
  const g = createCodexBuilder({ cliVersion: version });
  const code = version === NEW_VERSION;
  const recs = [
    g.sessionMeta(), g.turnContext(), g.taskStarted(), g.userContext(), g.developer(), g.userMessage('Fix the login bug'),
    ...g.think('Reading the auth code.'), g.tokenCount(),
  ];
  if (code) {
    recs.push(g.exec('const r = await tools.exec_command({ cmd: "rg -n token src" });'), g.commandItem({ script: 'rg -n token src' }),
      g.fileChangeItem(), g.mcpItem({ status: 'failed' }), g.execOutput(), g.exec('await tools.update_plan({ plan: [] })'),
      g.execOutput(out.scriptFailed()), g.planItem());
  } else {
    recs.push(g.execCommand('rg -n token src'), g.functionOutput({ output: out.execCommand() }), g.applyPatch(),
      g.customOutput({ output: out.json() }), g.updatePlan(), g.functionOutput({ output: out.planUpdated() }),
      g.mcp({ server: 'github', tool: 'get_issue' }), g.functionOutput({ output: out.mcpResult() }));
  }
  recs.push(...g.say('Patched the token check.'), g.writeStdin(), g.functionOutput({ output: out.execCommand({ running: true }) }),
    g.spawnAgent(), g.functionOutput({ output: out.spawned() }), g.subAgentActivity({ kind: 'completed' }),
    ...g.say('Done.', { phase: 'final_answer' }), g.taskComplete(), g.taskStarted(), g.userMessage('Now run the tests'),
    g.execCommand('npm test'), g.functionOutput({ output: out.execCommand({ exitCode: 1 }) }), g.compacted(), g.taskStarted(),
    g.userMessage('<heartbeat>tick</heartbeat>'), g.requestUserInput(), g.turnAborted(), g.taskStarted(),
    g.userMessage('Try once more'), g.taskComplete({ error: 'Rate limit reached' }), g.taskStarted(), g.clockSleep(),
    g.execCommand('npm run dev'));
  return recs;
}

test('long mixed scenario: replay-mode state equals live-mode state, in both cli_version shapes', () => {
  for (const version of [OLD_VERSION, NEW_VERSION]) {
    const recs = longScenario(version);
    const replay = mk({ version });
    const hints = [...run(replay.s, recs, { replay: true }), ...replay.s.idle(T0)].filter((e) => e.hint); // given when the replay ends
    const live = mk({ version });
    const evs = run(live.s, recs);
    live.s.idle(T0);
    assert.deepEqual(replay.s.snapshotEvents(), live.s.snapshotEvents(), version);
    assert.deepEqual(replay.s.debugState(), live.s.debugState(), version);
    assert.deepEqual(hints, evs.filter((e) => e.hint), `${version}: replay keeps the hints`);
    assert.equal(live.s.skipped, 0, version);
    // the live stream itself
    assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn', 'next_turn', 'interrupt', 'api_error'], version);
    assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug', 'Now run the tests', 'Try once more'], version);
    assert.equal(of(evs, 'say').length, 2, `${version}: one say per message`);
    assert.equal(of(evs, 'thinking').length, 1, version);
    assert.deepEqual(of(evs, 'system').map((e) => e.kind), ['compact', 'api_error'], version);
    const starts = new Set(of(evs, 'tool_start').map((e) => e.toolUseId));
    for (const e of of(evs, 'tool_end')) assert.ok(starts.has(e.toolUseId), `${version}: tool_end ${e.toolUseId} has a start`);
    const open = live.s.snapshotEvents().filter((e) => e.type === 'tool_start').map((e) => [e.tool, e.room]);
    assert.deepEqual(open, [['clock.sleep', 'lounge'], ['exec_command', 'server']], version);
    assert.doesNotMatch(JSON.stringify(evs), /BAIT|bait|Ignore all previous/, `${version}: privacy`);
  }
});

test('long mixed scenario: a child file with inherited context, replayed then live-appended, matches a fully live read', () => {
  const { recs } = childFile();
  const c = createCodexBuilder({ threadId: CODEX_CHILD, cliVersion: NEW_VERSION, startMs: T0 + 3600_000 });
  c.skipTo(recs.length);
  const tail = [c.execOutput(out.script(), recs.find((r) => r.payload?.name === 'exec').payload.call_id), ...c.say('Found it.', { phase: 'final_answer' }),
    c.taskComplete()];
  const a = mkChild();
  run(a.s, recs, { replay: true });
  a.s.idle(T0);
  const liveTail = run(a.s, tail);
  assert.deepEqual(of(liveTail, 'tool_end').map((e) => e.ok), [true]);
  assert.deepEqual(of(liveTail, 'say').map((e) => e.text), ['Found it.']);
  assert.equal(of(liveTail, 'turn_end').length, 0, 'turn events are for mains only');
  const b = mkChild();
  run(b.s, [...recs, ...tail]);
  assert.deepEqual(noTs(a.s.snapshotEvents()), noTs(b.s.snapshotEvents()));
});
