// Section 5 session-level regressions (review 2026-10-19, findings 1, 4, 9). 모든 값은 지어낸 것이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '7a7a7a7a-1111-4222-8333-444455556666';
const AGENT = 'a1234567890abcdef';
const UUID = '0b5e2a6c-1234-4abc-9def-0123456789ab'; // invented connector account id
const ZERO = '00000000-0000-0000-0000-000000000000';

function run(records, opts = {}) {
  const st = new SessionState({ id: SID, kind: 'main', stem: SID, now: () => Date.parse('2026-01-01T00:10:00Z'), ...opts });
  const events = [];
  for (const r of records) events.push(...st.apply(r));
  return { st, events };
}

test('finding 1: a connector uuid never reaches tool_start.tool, tool_end.error or free text', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const names = [
    [`mcp__${UUID}__get_issue`, '0b5e2a6c'], // well-formed
    [`mcp__${UUID}`, '0b5e2a6c'], // bare, no tool suffix
    ['mcp__0b5e2a6c-1234-4abc-9def-0123456789ag__notion-search', '0b5e2a6c'], // one-char non-hex typo
    ['mcp__3f9c2a715b8e4d109a6f0c1d2e3f4a5b__search', '3f9c2a71'], // 32-hex segment
  ];
  for (const [i, [name, marker]] of names.entries()) {
    const id = `toolu_m${i}`;
    const { events } = run([
      b.humanPrompt({ text: `call ${name} please` }),
      b.assistantThinking({ msgId: `m${i}`, text: `I will call ${name}.` }),
      b.assistantText({ msgId: `m${i}`, text: `Calling ${name} now` }),
      b.assistantToolUse({ msgId: `m${i}`, id, name, input: { id: 'X-1' } }),
      b.toolResult({ toolUseId: id, isError: true, content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>` }),
    ]);
    const blob = JSON.stringify(events);
    assert.equal(blob.includes(marker), false, `${name} leaked: ${blob}`);
    const start = events.find((e) => e.type === 'tool_start');
    assert.equal(start.tool.split('__')[1], ZERO, start.tool);
    const end = events.find((e) => e.type === 'tool_end');
    assert.ok(end.error.startsWith('Error: No such tool available: mcp__'), end.error);
  }
  // human server names are never masked
  for (const name of ['mcp__github__get_issue', 'mcp__claude-in-chrome__navigate']) {
    const id = `toolu_${name.length}`;
    const { events } = run([
      b.assistantToolUse({ msgId: 'mh', id, name, input: {} }),
      b.toolResult({ toolUseId: id, isError: true, content: `Error: No such tool available: ${name}` }),
    ]);
    assert.equal(events.find((e) => e.type === 'tool_start').tool, name);
    assert.equal(events.find((e) => e.type === 'tool_end').error, `Error: No such tool available: ${name}`);
  }
});

test('finding 4: branch, worktree, agentType and parentSessionId are scrubbed, capped and validated', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', gitBranch: 'victim.person@corp.example/feature' });
  const { st, events } = run([
    b.humanPrompt({ text: 'go' }),
    b.worktreeState({ worktreeName: `wt victim.person@corp.example /Users/victim/XWTDIR/x ${'z'.repeat(100)}`, worktreePath: '/work/demo/.claude/worktrees/wt' }),
    b.assistantText({ msgId: 'm1', text: 'ok' }),
  ]);
  const ev = st.sessionEvent();
  const blob = JSON.stringify([...events, ev, ...st.snapshotEvents()].filter((e) => e.type === 'session').map((e) => ({ ...e, project: undefined })));
  for (const leak of ['victim.person', '/Users/victim', 'XWTDIR', '\u0000']) assert.equal(blob.includes(leak), false, `leaked ${leak}: ${blob}`);
  assert.equal(ev.branch, '(email)'); // emails never, not even the domain (section 5)
  assert.ok(Array.from(ev.worktree).length <= 60, ev.worktree);
  // ordinary values pass through unchanged; HEAD is still 'detached'
  const plain = run([b.humanPrompt({ text: 'go', gitBranch: 'codex/ksm-qa-issues' }), b.assistantText({ msgId: 'm2', text: 'ok', gitBranch: 'codex/ksm-qa-issues' })]).st.sessionEvent();
  assert.equal(plain.branch, 'codex/ksm-qa-issues');
  const head = run([b.humanPrompt({ text: 'go', gitBranch: 'HEAD' })]).st.sessionEvent();
  assert.equal(head.branch, 'detached');

  // subagent: agentType from meta and the state, parent id from setInfo
  const sub = new SessionState({ id: AGENT, kind: 'sub', stem: SID, parentId: 'victim.person@corp.example', agentType: 'reviewer /Users/victim/XATDIR/a', now: () => 0 });
  let sev = sub.sessionEvent();
  assert.equal(sev.parentSessionId, SID); // invalid parent id falls back to the main session
  assert.equal(sev.agentType, 'reviewer a');
  sub.setInfo({ agentType: null, subMeta: { agentType: `owner victim.person@corp.example ${'q'.repeat(100)}` }, parentId: '../../etc/x' });
  sev = sub.sessionEvent();
  assert.equal(sev.parentSessionId, SID);
  assert.ok(sev.agentType.startsWith('owner (email) '), sev.agentType);
  assert.ok(Array.from(sev.agentType).length <= 60);
  for (const leak of ['victim.person', 'XATDIR', 'etc/x']) assert.equal(JSON.stringify(sev).includes(leak), false, leak);
  // valid ids and built-in agent types are kept
  sub.setInfo({ parentId: 'a0000000000000bb', subMeta: { agentType: 'Explore' } });
  assert.deepEqual([sub.sessionEvent().parentSessionId, sub.sessionEvent().agentType], ['a0000000000000bb', 'Explore']);
});

test('finding 9: tool_end.error drops MCP JSON payloads and auto mode classifier reasons', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const cases = [
    ['MCP error -32603: {"filter":{"field":"email","value":"XJSONval"},"doc":"XJSONdoc"}', 'MCP error -32603'],
    ['MCP error -32603: {', 'MCP error -32603'],
    ['Error: {"code":3,"message":"XJSONmsg"}', 'Error'],
    ['{"result":[{"name":"XJSONname"}]}', 'failed'],
    ["MCP error -32000: {'doc': 'XJSONpy'}", 'MCP error -32000'],
    ['Error: [{"path":"XJSONarr"}]', 'Error'],
    ['Permission for this action was denied by the Claude Code auto mode classifier. Reason: [XREASON would run rm on the backup dir]',
      'Permission for this action was denied by the Claude Code auto mode classifier.'],
    ['Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier XREASON',
      'Permission for this action was denied by the Claude Code auto mode classifier.'],
    // unchanged shapes
    ['PreToolUse:Bash hook error: [/tmp/office-sim-fixture/hooks/guard.sh]: blocked https://example.invalid/a?token=1', 'PreToolUse:Bash hook error: [guard.sh]: blocked example.invalid'],
    ['Permission to use Bash with command rm -rf {"x":1} /tmp/office-sim-fixture/secret has been denied.', 'Permission to use Bash has been denied.'],
    ['Exit code 1', 'Exit code 1'],
    ['String to replace not found in file.', 'String to replace not found in file.'],
    ['[Request interrupted by user for tool use]', null],
  ];
  const recs = [b.humanPrompt({ text: 'go' })];
  cases.forEach(([content], i) => {
    recs.push(b.bashUse({ msgId: 'm', id: `t${i}` }), b.toolResult({ toolUseId: `t${i}`, isError: true, content }));
  });
  const ends = run(recs).events.filter((e) => e.type === 'tool_end');
  assert.equal(ends.length, cases.length);
  cases.forEach(([content, want], i) => {
    const e = ends.find((x) => x.toolUseId === `t${i}`);
    for (const leak of ['XJSON', 'XREASON', 'token=1', 'rm -rf']) assert.equal(e.error.includes(leak), false, `${content} -> ${e.error}`);
    if (want !== null) assert.equal(e.error, want, content);
  });
});

test('integrator: the payload cut leaves quoted braces, compiler lines and trailing colons alone (finding 9 regressions)', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const cases = [
    ["SyntaxError: Unexpected token '{'", "SyntaxError: Unexpected token '{'"],
    ["Expected '{' but found 'x'", "Expected '{' but found 'x'"],
    ['Unexpected token [', 'Unexpected token ['],
    ["src/x.ts(3,5): error TS2322: Type '{ a: string; }' is not assignable to type 'B'.", "src/x.ts(3,5): error TS2322: Type '{ a: string; }' is not assignable to type 'B'."],
    ['Found the following issue:', 'Found the following issue:'],
    ['[ERROR] build failed', '[ERROR] build failed'],
    // still cut: unquoted keys, python lists, a pretty-printed payload's first line
    ['MCP error -32603: {a: "XJSONunq"}', 'MCP error -32603'],
    ['Firestore {name: XJSONfs}', 'Firestore'],
    ["Error: ['XJSONpylist', 'b']", 'Error'],
    ['MCP error -32603: [', 'MCP error -32603'],
  ];
  const recs = [b.humanPrompt({ text: 'go' })];
  cases.forEach(([content], i) => {
    recs.push(b.bashUse({ msgId: 'm', id: `t${i}` }), b.toolResult({ toolUseId: `t${i}`, isError: true, content }));
  });
  const ends = run(recs).events.filter((e) => e.type === 'tool_end');
  cases.forEach(([content, want], i) => {
    const e = ends.find((x) => x.toolUseId === `t${i}`);
    assert.equal(e.error.includes('XJSON'), false, `${content} -> ${e.error}`);
    assert.equal(e.error, want, content);
  });
});

test('integrator (corpus replay): connector uuids in error text and uuid-only mcp summaries are masked', () => {
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const { events } = run([
    b.humanPrompt({ text: 'go' }),
    b.assistantToolUse({ msgId: 'm1', id: 'toolu_r', name: 'ReadMcpResourceTool', input: { server: UUID, uri: 'x://y' } }),
    b.toolResult({ toolUseId: 'toolu_r', isError: true, content: `Error: Server "${UUID}" not found. Available servers: a, b` }),
    b.assistantToolUse({ msgId: 'm2', id: 'toolu_p', name: `mcp__${UUID}__get_project`, input: { query: '3f9c2a71-5b8e-4d10-9a6f-0c1d2e3f4a5b' } }),
  ]);
  const blob = JSON.stringify(events);
  for (const leak of ['0b5e2a6c', '3f9c2a71']) assert.equal(blob.includes(leak), false, `leaked ${leak}: ${blob}`);
  assert.equal(events.find((e) => e.type === 'tool_end').error, `Error: Server "${ZERO}" not found. Available servers: a, b`);
  assert.equal(events.find((e) => e.toolUseId === 'toolu_p').summary, 'get project');
});
