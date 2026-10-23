// 아직 고치지 않은 테마 기하 실패 수('<검사>:<테마>' -> 개수). 고치는 작업은 먼저 여기서 숫자를 내리고(빨강) 고친다(초록).
// 개수가 늘어나도 줄어들어도 테스트가 실패하므로, 새 결함이 조용히 섞이거나 고친 것이 되살아나지 않는다.
// 오른쪽 주석: 감사 id (docs/superpowers/plans/2026-10-23-place-theme-repair.md) 또는 triage.
export const KNOWN = {
  // 비균일 스케일 뒤 회전: roofEave(궁궐 4, 한옥 3), 스타십 팔각 선체·갑판
  'shear:starship': 2, // starship-08
  // 다른 메시 속에 묻힘
  'hidden:starship': 20, // starship-03 엔진 코어 LED
  'hidden:dogs': 12, // dogs-02 줄무늬 6, dogs-03 울타리 기둥 6
  // 바닥 밖
  'support:hanok': 1, // triage: hanok-11 북쪽 담이 기단 밖으로 0.12 (P2, Task 24)
  'support:starship': 4, // starship-m01 역장 끝 2, starship-10 받침 2 (Task 25)
  'support:dogs': 4, // dogs-03 장 2·랙 2 (Task 18)
  'support:cats': 12, // cats-01 연구실 자리 2·책상 다리 8·종, cats-02 랙 1
  // 자리 밑 바닥이 높음
  // 고리 보행 띠
  // 보이지 않는 충돌 상자
  'coverage:dogs': 4, // dogs-06 칸막이 div 4 (Task 18)
  'coverage:cats': 4, // cats-03 칸막이 div 4 (Task 19)
  // 연구실 구체와 머리
  'globe:starship': 1, // triage: unaudited
  'globe:dogs': 1, // triage: unaudited
  'globe:cats': 1, // triage: unaudited
  // 경로가 서 있는 물체에 0.24 보다 가까움
  'routeClear:studio': 1, // triage: 서버 데스크 남동 다리 0.237 (3 mm)
  'routeClear:office': 1, // triage: 같은 데스크 다리
  // 같은 높이 다른 재질
  'coplanar:hanok': 1, // hanok-12 누각 기단
  // 다시 지을 때 새로 만드는 기하·재질
  'alloc:dogs': 1, // triage: theme-props 의 M.white 가 mats() 에 없어 Mesh 기본 재질을 매번 만든다
  // theme-layouts 순수 검사
};
