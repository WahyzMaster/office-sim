// 재생 모드(P3) 시간표: 줄 시각, 파일 합치기, 배속/공백 상한, 승인 표시 근거, 세션 파일 찾기. 합성 데이터만 쓴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileEntries, mergeTimeline, schedule, approvalIdsOf, MAX_LINE_CHARS } from '../src/replay-timeline.mjs';
import { sessionRefs } from '../src/discover.mjs';
import { createRecordBuilder, clone } from './fixtures/records.mjs';
import { writeReplayFixture, REPLAY_SID, REPLAY_AGENT } from './fixtures/replay-fixture.mjs';

const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

const T0 = Date.UTC(2026, 0, 1);
const rec = (sec, extra = {}) => JSON.stringify({ type: 'user', sessionId: 's-1', timestamp: new Date(T0 + sec * 1000).toISOString(), ...extra });

test('fileEntries: time never goes back, untimed leading lines take the first time, blank lines dropped', () => {
  const text = [
    JSON.stringify({ type: 'custom-title', customTitle: 'x' }), // 시각 없음
    rec(10),
    '',
    rec(5), // 시각이 거꾸로 간다 (R12): 순서는 그대로, 시각은 10 을 유지
    'not json',
    rec(12),
  ].join('\n');
  const seen = [];
  const { entries, skipped, sessionId } = fileEntries(text, (r) => seen.push(r.type));
  assert.deepEqual(entries.map((e) => (e.t - T0) / 1000), [10, 10, 10, 10, 12]);
  assert.equal(entries.length, 5);
  assert.equal(skipped, 0);
  assert.equal(sessionId, 's-1');
  assert.deepEqual(seen, ['custom-title', 'user', 'user', 'user']);
});

test('fileEntries: lines over the tailer limit are skipped and counted', () => {
  const big = rec(1, { pad: 'x'.repeat(MAX_LINE_CHARS) });
  const { entries, skipped } = fileEntries([rec(0), big, rec(2)].join('\n'));
  assert.equal(skipped, 1);
  assert.equal(entries.length, 2);
});

test('fileEntries: a file without any timestamp plays at time 0', () => {
  const { entries } = fileEntries('{"type":"custom-title"}\n{"type":"agent-name"}\n');
  assert.deepEqual(entries.map((e) => e.t), [0, 0]);
});

test('mergeTimeline: time order across files, file order on ties, line order inside a file', () => {
  const a = [{ line: 'a1', t: 1 }, { line: 'a2', t: 5 }, { line: 'a3', t: 5 }, { line: 'a4', t: 9 }];
  const b = [{ line: 'b1', t: 5 }, { line: 'b2', t: 6 }];
  const c = [];
  const merged = mergeTimeline([a, b, c]);
  assert.deepEqual(merged.map((e) => e.line), ['a1', 'a2', 'a3', 'b1', 'b2', 'a4']);
  assert.deepEqual(merged.map((e) => e.fi), [0, 0, 0, 1, 1, 0]);
});

test('schedule: gaps are divided by the speed and capped at maxGapMs', () => {
  const merged = [{ t: 0 }, { t: 4000 }, { t: 4000 }, { t: 4000 + 3_600_000 }, { t: 4000 + 3_602_000 }];
  const total = schedule(merged, { speed: 4, maxGapMs: 5000 });
  assert.deepEqual(merged.map((e) => e.due), [0, 1000, 1000, 6000, 6500]);
  assert.equal(total, 6500);
  schedule(merged, { speed: 0.5, maxGapMs: 100_000 });
  assert.deepEqual(merged.map((e) => e.due), [0, 8000, 8000, 108000, 112000]);
});

test('approvalIdsOf: only a human answer to a permission prompt counts', () => {
  const b = createRecordBuilder({ sessionId: 's-1' });
  const ok = b.bashResult({ toolUseId: 'toolu_a' });
  assert.deepEqual(approvalIdsOf(clone(ok, { permissionDecision: { decision: 'accept', source: 'user_temporary' } })), ['toolu_a']);
  // 저장된 규칙(user_permanent), 설정/분류기(config), 훅(hook)은 사람이 기다린 것이 아니다
  for (const source of ['user_permanent', 'config', 'hook']) {
    assert.deepEqual(approvalIdsOf(clone(ok, { permissionDecision: { decision: 'accept', source, reasonType: 'rule' } })), [], source);
  }
  assert.deepEqual(approvalIdsOf(ok), []);
  assert.deepEqual(approvalIdsOf(b.userRejected({ toolUseId: 'toolu_b' })), ['toolu_b']);
  const feedback = b.toolResult({
    toolUseId: 'toolu_c', isError: true, toolDenialKind: 'permission-rule',
    content: [{ type: 'text', text: "The user doesn't want to proceed with this tool use. the user said:\nnot now" }],
  });
  assert.deepEqual(approvalIdsOf(feedback), ['toolu_c']);
  const blocked = b.toolResult({ toolUseId: 'toolu_d', isError: true, content: 'Permission for this action was denied by the classifier.' });
  assert.deepEqual(approvalIdsOf(blocked), []);
  assert.deepEqual(approvalIdsOf(b.assistantText({ text: 'hi' })), []);
  assert.deepEqual(approvalIdsOf(null), []);
});

test('sessionRefs: main first, then its subagents; a lone file works; a missing file throws', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-replay-refs-'));
  tmpDirs.push(dir);
  const { mainPath, subPath } = await writeReplayFixture(dir);
  await fs.writeFile(path.join(path.dirname(subPath), `agent-${REPLAY_AGENT}.meta.json.bak`), '{}'); // 무시되는 파일
  const refs = await sessionRefs(mainPath);
  assert.deepEqual(refs.map((r) => [r.kind, r.stem]), [['main', REPLAY_SID], ['sub', REPLAY_AGENT]]);
  assert.equal(refs[1].sessionId, REPLAY_SID);
  const lone = path.join(dir, 'lone.jsonl');
  await fs.writeFile(lone, `${rec(0)}\n`);
  assert.deepEqual((await sessionRefs(lone)).map((r) => r.kind), ['main']);
  await assert.rejects(sessionRefs(path.join(dir, 'missing.jsonl')), { code: 'ENOENT' });
  await assert.rejects(sessionRefs(dir));
});
