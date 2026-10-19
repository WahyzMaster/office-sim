// 재생 모드(P3) 픽스처: 지어낸 세션 하나 + 서브에이전트 하나 (+ meta.json). 실제 기록에서 가져온 내용은 없다.
// 테스트는 writeReplayFixture(임시 폴더)를 쓰고, 앱 브라우저 확인용 사본은 이 파일을 직접 실행해 만든다:
//   node test/fixtures/replay-fixture.mjs test/fixtures/replay
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecordBuilder, clone, toJsonl } from './records.mjs';

export const REPLAY_SID = '7e7e7e7e-1111-4222-8333-444455556666';
export const REPLAY_AGENT = 'a7b6c5d4e3f201928';
export const REPLAY_CWD = '/work/invented-replay';
export const START_MS = Date.UTC(2026, 0, 5, 9, 0, 0);
export const LONG_GAP_MS = 60 * 60 * 1000; // 사람이 자리를 비운 한 시간: 재생은 maxGapMs 로 줄인다
// 시각(초)이 그대로 테스트 기대값이 되는 도구 호출
export const IDS = {
  read: 'toolu_r01', grep: 'toolu_r02', agent: 'toolu_r03', edit: 'toolu_r04',
  approved: 'toolu_r05', rejected: 'toolu_r06', lint: 'toolu_r07', subRead: 'toolu_s01', subGrep: 'toolu_s02',
};

const at = (b, sec) => b.tick(START_MS + sec * 1000 - b.nowMs());

function mainRecords() {
  const m = createRecordBuilder({ sessionId: REPLAY_SID, cwd: REPLAY_CWD, startMs: START_MS, stepMs: 0, gitBranch: 'fix/parser' });
  const out = [];
  const put = (sec, rec) => {
    at(m, sec);
    out.push(typeof rec === 'function' ? rec() : rec);
  };
  out.push(m.customTitle('지어낸 파서 정리'));
  put(0, () => m.humanPrompt({ text: '지어낸 파서를 정리해 줘' }));
  put(2, () => m.assistantThinking({ msgId: 'msg_r1', text: '파서부터 읽어 보자.', durationMs: 1800 }));
  put(3, () => m.updatePlanUse({ msgId: 'msg_r1', id: 'toolu_p01', input: { items: [
    { content: '파서 읽기', status: 'in_progress' }, { content: '정리하기', status: 'pending' }, { content: '테스트', status: 'pending' },
  ] } }));
  put(3.2, () => m.updatePlanResult({ toolUseId: 'toolu_p01', text: 'Plan shown (3 steps).' }));
  put(4, () => m.assistantToolUse({ msgId: 'msg_r2', id: IDS.read, name: 'Read', input: { file_path: `${REPLAY_CWD}/src/parser.mjs` } }));
  put(4.4, () => m.toolResult({ toolUseId: IDS.read, content: 'invented file body' }));
  put(6, () => m.assistantToolUse({ msgId: 'msg_r3', id: IDS.grep, name: 'Grep', input: { pattern: 'tokenize', path: `${REPLAY_CWD}/src` } }));
  put(6.3, () => m.toolResult({ toolUseId: IDS.grep, content: 'invented match' }));
  put(8, () => m.agentUse({ msgId: 'msg_r4', id: IDS.agent, description: '사용처 조사', subagentType: 'Explore' }));
  put(19, () => m.agentSyncResult({ toolUseId: IDS.agent, agentId: REPLAY_AGENT }));
  put(21, () => m.assistantToolUse({ msgId: 'msg_r5', id: IDS.edit, name: 'Edit', input: { file_path: `${REPLAY_CWD}/src/parser.mjs`, old_string: 'a', new_string: 'b' } }));
  put(21.8, () => m.toolResult({ toolUseId: IDS.edit, content: 'invented edit ok' }));
  // 사람이 권한 창에서 '허용'을 누를 때까지 10초 기다린 호출
  put(23, () => m.bashUse({ msgId: 'msg_r6', id: IDS.approved, command: 'npm test', description: '테스트 실행' }));
  put(33, () => clone(m.bashResult({ toolUseId: IDS.approved }), { permissionDecision: { decision: 'accept', source: 'user_temporary' } }));
  // 사람이 거절한 호출
  put(35, () => m.bashUse({ msgId: 'msg_r7', id: IDS.rejected, command: 'git push', description: '원격에 올리기' }));
  put(39, () => m.userRejected({ toolUseId: IDS.rejected }));
  put(41, () => m.updatePlanUse({ msgId: 'msg_r8', id: 'toolu_p02', input: { done: [1, 2], start: 3 } }));
  put(41.2, () => m.updatePlanResult({ toolUseId: 'toolu_p02', text: 'Plan updated: step 3 of 3 is in progress.' }));
  put(42, () => m.assistantText({ msgId: 'msg_r9', text: '정리를 마쳤어요.', stopReason: 'end_turn' }));
  put(42.3, () => m.stopHookSummary());
  const back = 42.3 + LONG_GAP_MS / 1000;
  put(back, () => m.humanPrompt({ text: '린트도 돌려 줘' }));
  put(back + 2, () => m.bashUse({ msgId: 'msg_r10', id: IDS.lint, command: 'npm run lint', description: '린트' }));
  put(back + 4, () => m.bashResult({ toolUseId: IDS.lint }));
  put(back + 5, () => m.assistantText({ msgId: 'msg_r11', text: '린트도 통과했어요.', stopReason: 'end_turn' }));
  put(back + 5.2, () => m.stopHookSummary());
  return out;
}

function subRecords() {
  const s = createRecordBuilder({
    sessionId: REPLAY_SID, cwd: REPLAY_CWD, agentId: REPLAY_AGENT, startMs: START_MS, stepMs: 0, gitBranch: 'fix/parser',
  });
  const out = [];
  const put = (sec, fn) => {
    at(s, sec);
    out.push(fn());
  };
  put(9, () => s.subagentPrompt({ text: '지어낸 사용처를 찾아 줘' }));
  put(11, () => s.assistantToolUse({ msgId: 'msg_s1', id: IDS.subRead, name: 'Read', input: { file_path: `${REPLAY_CWD}/src/use.mjs` } }));
  put(11.5, () => s.toolResult({ toolUseId: IDS.subRead, content: 'invented sub body' }));
  put(13, () => s.assistantToolUse({ msgId: 'msg_s2', id: IDS.subGrep, name: 'Grep', input: { pattern: 'parse(', path: `${REPLAY_CWD}/src` } }));
  put(13.4, () => s.toolResult({ toolUseId: IDS.subGrep, content: 'invented sub match' }));
  put(17, () => s.assistantText({ msgId: 'msg_s3', text: '사용처 두 곳을 찾았어요.', stopReason: 'end_turn' }));
  return out;
}

/** dir 아래에 <sid>.jsonl, <sid>/subagents/agent-<id>.jsonl, agent-<id>.meta.json 을 쓴다. -> { mainPath, subPath } */
export async function writeReplayFixture(dir) {
  const subDir = path.join(dir, REPLAY_SID, 'subagents');
  await fs.mkdir(subDir, { recursive: true });
  const mainPath = path.join(dir, `${REPLAY_SID}.jsonl`);
  const subPath = path.join(subDir, `agent-${REPLAY_AGENT}.jsonl`);
  await fs.writeFile(mainPath, toJsonl(mainRecords()));
  await fs.writeFile(subPath, toJsonl(subRecords()));
  const meta = { agentType: 'Explore', description: '사용처 조사', toolUseId: IDS.agent };
  await fs.writeFile(path.join(subDir, `agent-${REPLAY_AGENT}.meta.json`), JSON.stringify(meta));
  return { mainPath, subPath };
}

// node --test test/ 도 이 파일을 인자 없이 실행한다: 그때는 아무것도 하지 않는다.
const out = process.argv[2];
if (out && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mainPath } = await writeReplayFixture(path.resolve(out));
  process.stdout.write(`${path.relative(process.cwd(), mainPath)}\n`);
}
