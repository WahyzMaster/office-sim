// 기록 관찰 페이지 테스트가 함께 쓰는 합성 서버 상태 (test/page-observe*.test.mjs). 손으로 만든 값이고 실제 기록 폴더는
// 읽지 않는다. 불러올 때 아무것도 하지 않는다 (node --test 가 test/ 아래의 파일을 모두 테스트 파일로 돌린다).

export const IDS = ['grok-updates', 'grok-wait', 'grok-active', 'codex-rollout'];
export const NEED = { 'grok-updates': 20, 'grok-wait': 1, 'grok-active': 1, 'codex-rollout': 20 };

// 체크리스트: have 를 id 별로 받는다. off 는 꺼진 id 목록.
export function checklist(have = {}, off = []) {
  return IDS.map((id) => {
    const isOff = off.includes(id);
    const h = isOff ? 0 : have[id] ?? 0;
    return { id, have: h, need: NEED[id], done: !isOff && h >= NEED[id], off: isOff };
  });
}

export function status(over = {}) {
  return {
    type: 'observe', available: true, agents: { grok: true, codex: true }, running: false, startedAt: null, elapsedMs: 0,
    checklist: checklist(), ready: false, totals: { files: 0, appends: 0 }, last: null, ...over,
  };
}

export const ALL_DONE = { 'grok-updates': 23, 'grok-wait': 1, 'grok-active': 2, 'codex-rollout': 20 };
export const LAST = {
  file: 'observe-20261021-153000.jsonl', endedAt: '2026-10-21T15:42:10.000Z',
  checklist: checklist(ALL_DONE), totals: { files: 3, appends: 57 },
};
