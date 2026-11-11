// 층마다 얼마나 자세히 그릴지 (P3 성능 + 고밀도 부하 제어). three.js 를 쓰지 않는 순수 함수라 node 테스트에서 바로 부른다.
// - 초점 층 (전체 보기에서는 모든 층): 다 그린다. 단 100명+ / 20층+ 고밀도 전체 보기에서는 그림자·라벨을 단계적으로 줄인다.
// - 초점 아래층: 화면에 보이지만 위층 바닥판 그늘에 덮여 있다. 그림자를 드리우지 않고 라벨도 숨기며 고밀도에서는 몸짓도 아낀다.
// - 초점 위층: 숨긴다. 그리지 않고, 행렬 갱신, 라벨, 몸짓/LED 애니메이션도 건너뛴다 (일의 진행은 그대로 한다).
export function floorDetail(index, focusIndex, overview, load = null) {
  const agentCount = load?.agentCount ?? 0;
  const floorCount = load?.floorCount ?? 1;
  const heavy = agentCount >= 64 || floorCount >= 12;
  const extreme = agentCount >= 100 || floorCount >= 20;
  if (overview) {
    return { visible: true, labels: !extreme, shadows: !heavy, animate: true };
  }
  if (index === focusIndex) {
    return { visible: true, labels: true, shadows: agentCount < 160, animate: true };
  }
  if (index < focusIndex) {
    const gap = focusIndex - index;
    return {
      visible: !(extreme && gap > 4),
      labels: false,
      shadows: false,
      animate: !heavy,
    };
  }
  return { visible: false, labels: false, shadows: false, animate: false };
}

// 고밀도(64명+, 100명+)에서 비초점 층/전체 보기의 보조 애니메이션 주기를 늦춰 CPU 예산을 지킨다.
export function crowdStride(agentCount = 0, isFocused = true) {
  if (agentCount < 64 || (isFocused && agentCount < 100)) return 1;
  if (agentCount < 120 || isFocused) return 2;
  return 4;
}

// 고밀도 구간(0: <64, 1: 64..99, 2: 100..159, 3: 160+)이 바뀔 때만 layout() 을 다시 돌려 그림자·라벨을 맞춘다.
export const lodTier = (agentCount = 0) => (agentCount >= 160 ? 3 : agentCount >= 100 ? 2 : agentCount >= 64 ? 1 : 0);

// 전체 보기면 장면 전체, 아니면 초점 층만 CSS 라벨을 계산한다 (CSS2DRenderer 는 받은 묶음 아래만 돈다).
export function labelRootIndex(focusIndex, overview, floorCount) {
  if (overview || floorCount <= 0) return -1;
  return Math.min(Math.max(0, focusIndex), floorCount - 1);
}
