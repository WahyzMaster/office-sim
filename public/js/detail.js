// 층마다 얼마나 자세히 그릴지 (P3 성능). three.js 를 쓰지 않는 순수 함수라 node 테스트에서 바로 부른다.
// - 초점 층 (전체 보기에서는 모든 층): 다 그린다.
// - 초점 아래층: 화면에 보이지만 위층 바닥판 그늘에 덮여 있다. 그림자를 드리우지 않고 라벨도 숨긴다.
// - 초점 위층: 숨긴다. 그리지 않고, 행렬 갱신, 라벨, 몸짓/LED 애니메이션도 건너뛴다 (일의 진행은 그대로 한다).
export function floorDetail(index, focusIndex, overview) {
  if (overview || index === focusIndex) return { visible: true, labels: true, shadows: true, animate: true };
  if (index < focusIndex) return { visible: true, labels: false, shadows: false, animate: true };
  return { visible: false, labels: false, shadows: false, animate: false };
}

// 전체 보기면 장면 전체, 아니면 초점 층만 CSS 라벨을 계산한다 (CSS2DRenderer 는 받은 묶음 아래만 돈다).
export function labelRootIndex(focusIndex, overview, floorCount) {
  if (overview || floorCount <= 0) return -1;
  return Math.min(Math.max(0, focusIndex), floorCount - 1);
}
