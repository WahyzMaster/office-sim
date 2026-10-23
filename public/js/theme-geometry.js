// 테마 기하의 순수 계산(three.js 없음). 노드 테스트로 바로 검증한다.

// 엘리베이터·대문 문짝 하나의 z 자세(바깥 모서리 |z| = 0.885 고정). open 0 = 닫힘(안쪽 0.035, 길이 0.85),
// 1 = 열림(길이 0.12 로 틀 쪽에 접힌다). 미닫이처럼 통째로 밀면 틀 밖 허공으로 나가므로 길이를 줄인다.
export function doorLeafPose(open) {
  const inner = 0.035 + 0.73 * open;
  const len = 0.885 - inner;
  return { inner, len, centre: inner + len / 2 };
}
