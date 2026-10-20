import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecord, contentText } from '../src/records.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '22222222-2222-4222-8222-222222222222';
const mk = (o = {}) => createRecordBuilder({ sessionId: SID, cwd: '/tmp/office-sim-fixture/repo', gitBranch: 'feature/x', ...o });

test('meta: uuid-less sidecars map to field/value', () => {
  const b = mk();
  assert.deepEqual(classifyRecord(b.customTitle('My title')), { kind: 'meta', field: 'title', value: 'My title', sessionId: SID });
  assert.equal(classifyRecord(b.agentName('helper')).field, 'agentName');
  assert.equal(classifyRecord(b.agentName('helper')).value, 'helper');
  assert.deepEqual(classifyRecord(b.lastPrompt('the last one')).value, 'the last one');
  const ws = { originalCwd: '/tmp/r', worktreePath: '/tmp/r/.worktrees/wt1', worktreeName: 'wt1' };
  assert.deepEqual(classifyRecord(b.worktreeState(ws)).value, ws);
  assert.equal(classifyRecord(b.worktreeState(null)).value, null);
  assert.equal(classifyRecord(b.relocated('/tmp/moved')).field, 'relocatedCwd');
  assert.equal(classifyRecord(b.relocated('/tmp/moved')).value, '/tmp/moved');
  const sum = classifyRecord(b.legacySummary('Old summary'));
  assert.equal(sum.field, 'summary');
  assert.equal(sum.value, 'Old summary');
});

test('meta: other uuid-less types are ignored', () => {
  const b = mk();
  for (const rec of [
    b.queueOperation(), b.modeRecord(),
    { type: 'pr-link', sessionId: SID, prNumber: 1, prUrl: 'https://example.invalid/pr/1', timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'atis-latch', atis: 'x', sessionId: SID },
    { type: 'bridge-session', sessionId: SID, bridgeSessionId: 'b' },
    { type: 'frame-link', sessionId: SID, artifactCount: 0 },
    { type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false },
    { type: 'file-history-delta', messageId: 'm' },
    { type: 'artifact-autoreact-ledger', v: 1, sessionId: SID },
    { type: 'cost-state', sessionId: SID, totalCostUSD: 0 },
  ]) {
    assert.equal(classifyRecord(rec).kind, 'ignore', rec.type);
  }
});

test('assistant: blocks normalized, server tools dropped, envelope fields kept', () => {
  const b = mk();
  const rec = b.assistantToolUse({ msgId: 'msg_A', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } });
  rec.wireToolInputs = { toolu_1: { file_path: '/tmp/WIRE.txt' } };
  const c = classifyRecord(rec);
  assert.equal(c.kind, 'assistant');
  assert.equal(c.msgId, 'msg_A');
  assert.equal(c.synthetic, false);
  assert.equal(c.apiError, false);
  assert.equal(c.stopReason, 'tool_use');
  assert.equal(c.model, 'claude-opus-5-5');
  assert.deepEqual(c.blocks, [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]);
  assert.equal(c.uuid, rec.uuid);
  assert.equal(c.ts, rec.timestamp);
  assert.equal(c.cwd, '/tmp/office-sim-fixture/repo');
  assert.equal(c.gitBranch, 'feature/x');
  assert.equal(c.sessionId, SID);
  assert.equal(classifyRecord(b.advisorBlocks({ msgId: 'msg_A' })).blocks.length, 0);
});

test('assistant: thinking text and duration, multi-block old lines', () => {
  const b = mk();
  const t = classifyRecord(b.assistantThinking({ msgId: 'msg_T', text: '', durationMs: 4321 }));
  assert.deepEqual(t.blocks, [{ type: 'thinking', text: '' }]);
  assert.equal(t.thinkingDurationMs, 4321);
  assert.equal(classifyRecord(b.assistantText({ msgId: 'msg_T' })).thinkingDurationMs, null);
  const multi = classifyRecord(b.assistantMulti({
    msgId: 'msg_M',
    blocks: [
      { type: 'thinking', thinking: 'Plan it.', signature: 's' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: { pattern: 'x' } },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    ],
  }));
  assert.deepEqual(multi.blocks.map((x) => x.type), ['thinking', 'text', 'tool_use', 'tool_use']);
  assert.equal(multi.blocks[0].text, 'Plan it.');
});

test('assistant: synthetic and api error flags', () => {
  const b = mk();
  const e = classifyRecord(b.syntheticApiError({ text: 'API Error: invented outage' }));
  assert.equal(e.synthetic, true);
  assert.equal(e.apiError, true);
  assert.equal(e.stopReason, 'stop_sequence');
  const n = classifyRecord(b.syntheticNoResponse());
  assert.equal(n.synthetic, true);
  assert.equal(n.apiError, false);
});

test('tool_result: text from string or text blocks, flags, endTurn', () => {
  const b = mk();
  const s = classifyRecord(b.toolResult({ toolUseId: 'toolu_1', content: 'plain', isError: true, toolUseResult: 'Error: x', toolDenialKind: 'permission-rule' }));
  assert.equal(s.kind, 'tool_result');
  assert.equal(s.toolUseId, 'toolu_1');
  assert.equal(s.isError, true);
  assert.equal(s.text, 'plain');
  assert.equal(s.toolUseResult, 'Error: x');
  assert.equal(s.toolDenialKind, 'permission-rule');
  assert.equal(s.endTurn, false);
  const arr = classifyRecord(b.toolResult({
    toolUseId: 'toolu_2',
    content: [{ type: 'text', text: 'one' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }, { type: 'text', text: 'two' }],
  }));
  assert.equal(arr.text, 'one\ntwo');
  assert.equal(arr.isError, false);
  assert.equal(arr.toolDenialKind, null);
  assert.equal(classifyRecord(b.wrapUpResult({ toolUseId: 'toolu_3' })).endTurn, true);
  assert.equal(classifyRecord(b.toolResult({ toolUseId: 'toolu_4', toolEndsTurn: true })).endTurn, true);
});

test('prompt: human origin, turnOrigin, legacy, system-reminder blocks', () => {
  const b = mk();
  const p = classifyRecord(b.humanPrompt({ text: 'Fix the invented bug', promptId: 'P1' }));
  assert.deepEqual([p.kind, p.promptId, p.text], ['prompt', 'P1', 'Fix the invented bug']);
  const legacy = classifyRecord(b.legacyPrompt({ text: 'legacy words', promptId: 'P2' }));
  assert.equal(legacy.kind, 'prompt');
  const turnOrigin = b.legacyPrompt({ text: 'via turnOrigin' });
  delete turnOrigin.promptSource;
  turnOrigin.turnOrigin = 'human';
  assert.equal(classifyRecord(turnOrigin).kind, 'prompt');
  const reminder = b.humanPrompt({ text: 'x' });
  reminder.message.content = [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'real words' }];
  assert.equal(classifyRecord(reminder).text, 'real words');
});

test('turn_start: isMeta, peer, command echo, compact summary, subagent first prompt', () => {
  const b = mk();
  b.setPromptId('P9');
  const meta = classifyRecord(b.metaUser({ sourceToolUseID: 'toolu_s' }));
  assert.deepEqual([meta.kind, meta.promptId, meta.isCompactSummary], ['turn_start', 'P9', false]);
  assert.equal(classifyRecord(b.peerMessage()).kind, 'turn_start');
  assert.equal(classifyRecord(b.commandEcho()).kind, 'turn_start');
  const legacyTag = b.legacyPrompt({ text: '<local-command-stdout>x</local-command-stdout>' });
  assert.equal(classifyRecord(legacyTag).kind, 'turn_start');
  const cs = classifyRecord(b.compactSummary({ promptId: 'P10' }));
  assert.deepEqual([cs.kind, cs.isCompactSummary], ['turn_start', true]);
  const sub = createRecordBuilder({ sessionId: SID, agentId: 'a0123456789abcdef' });
  const first = classifyRecord(sub.subagentPrompt({ promptId: 'PS' }));
  assert.equal(first.kind, 'turn_start');
  assert.equal(first.agentId, 'a0123456789abcdef');
});

test('interrupt: both marker forms, string or block content', () => {
  const b = mk();
  b.setPromptId('P1');
  const forTool = classifyRecord(b.interruptMarker({ forTool: true }));
  assert.deepEqual([forTool.kind, forTool.forTool, forTool.promptId], ['interrupt', true, 'P1']);
  const plain = b.interruptMarker({ forTool: false });
  plain.message.content = '[Request interrupted by user]';
  const c = classifyRecord(plain);
  assert.deepEqual([c.kind, c.forTool], ['interrupt', false]);
});

test('notification: user record, queued_command attachment, legacy text, progress form', () => {
  const b = mk();
  const u = classifyRecord(b.notification({ toolUseId: 'toolu_ag', taskId: 'a1111111111111111', status: 'completed', summary: 'Done', promptId: 'PN' }));
  assert.deepEqual(
    [u.kind, u.promptId, u.toolUseId, u.taskId, u.status, u.summary],
    ['notification', 'PN', 'toolu_ag', 'a1111111111111111', 'completed', 'Done'],
  );
  const a = classifyRecord(b.notification({ toolUseId: 'toolu_ag', carrier: 'attachment', status: 'failed' }));
  assert.deepEqual([a.kind, a.promptId, a.status], ['notification', undefined, 'failed']);
  const legacy = b.notification({ toolUseId: 'toolu_x' });
  delete legacy.origin;
  assert.equal(classifyRecord(legacy).kind, 'notification');
  const progress = classifyRecord(b.notification({ toolUseId: null, status: null }));
  assert.deepEqual([progress.toolUseId, progress.status], [null, null]);
});

test('queued_prompt: commandMode prompt is a prompt; meta or peer is not', () => {
  const b = mk();
  const q = classifyRecord(b.queuedPrompt({ text: 'also check the tests' }));
  assert.deepEqual([q.kind, q.text, q.promptId], ['prompt', 'also check the tests', undefined]);
  assert.equal(classifyRecord(b.queuedPrompt({ origin: null })).kind, 'prompt');
  assert.equal(classifyRecord(b.queuedPrompt({ isMeta: true })).kind, 'ignore');
  assert.equal(classifyRecord(b.queuedPrompt({ origin: { kind: 'peer' } })).kind, 'ignore');
  assert.equal(classifyRecord(b.hookAttachment()).kind, 'ignore');
});

test('task_reminder: content array', () => {
  const b = mk();
  const c = classifyRecord(b.taskReminder({ content: [{ id: '1', subject: 'S', status: 'pending' }] }));
  assert.equal(c.kind, 'task_reminder');
  assert.equal(c.content.length, 1);
  assert.deepEqual(classifyRecord(b.taskReminder()).content, []);
});

test('system: four subtypes kept, others ignored', () => {
  const b = mk();
  const retry = classifyRecord(b.apiErrorRetry({ attempt: 2, max: 10, status: 529 }));
  assert.deepEqual([retry.kind, retry.subtype, retry.retryAttempt, retry.maxRetries, retry.status], ['system', 'api_error', 2, 10, 529]);
  assert.equal(classifyRecord(b.apiErrorRetry({ status: null })).status, null);
  assert.equal(classifyRecord(b.stopHookSummary()).subtype, 'stop_hook_summary');
  const cb = classifyRecord(b.compactBoundary());
  assert.deepEqual([cb.subtype, cb.text], ['compact_boundary', 'Conversation compacted']);
  assert.equal(classifyRecord(b.modelRefusalFallback()).subtype, 'model_refusal_fallback');
  assert.equal(classifyRecord(b.localCommand()).kind, 'ignore');
});

test('classifyRecord never throws on odd input', () => {
  for (const rec of [null, undefined, 3, 'x', [], {}, { type: 'user' }, { type: 'user', message: null },
    { type: 'user', uuid: 'u', message: { content: 5 } }, { type: 'assistant', uuid: 'u', message: { content: [null, 4, { type: 'tool_use' }] } },
    { type: 'attachment', uuid: 'u', attachment: null }, { type: 'system', uuid: 'u', subtype: 'api_error', error: 'str' }]) {
    const c = classifyRecord(rec);
    assert.equal(typeof c.kind, 'string');
  }
  const getterBomb = { get type() { throw new Error('boom'); } };
  assert.equal(classifyRecord(getterBomb).kind, 'ignore');
  assert.equal(contentText(null), '');
});
