// 테마 기하의 순수 계산(three.js 없음). 노드 테스트로 바로 검증한다.

// 엘리베이터·대문 문짝 하나의 z 자세(바깥 모서리 |z| = 0.885 고정). open 0 = 닫힘(안쪽 0.035, 길이 0.85),
// 1 = 열림(길이 0.12 로 틀 쪽에 접힌다). 미닫이처럼 통째로 밀면 틀 밖 허공으로 나가므로 길이를 줄인다.
export function doorLeafPose(open) {
  const inner = 0.035 + 0.73 * open;
  const len = 0.885 - inner;
  return { inner, len, centre: inner + len / 2 };
}

// 캣 살롱 바닥 외곽선(XZ 다각형, 각도 오름차순 = 반시계): 얼굴 타원 + 북쪽 귀 마름모 2 + 남쪽 앞발 타원 2 를
// 중심 (0, 0.4) 에서 본 방사형 껍질로 합친다. 각도마다 가장 먼 교차점을 이어 귀와 얼굴 사이 V 자 틈까지 채우므로
// 바닥이 한 장이 되어 겹친 원기둥 사이의 이음매·빈 모서리가 생기지 않는다. pad 는 모든 반지름에 더한다(테두리 턱).
const CAT_CENTER = [0, 0.4];
export function catOutline(pad = 0) {
  const [ox, oz] = CAT_CENTER;
  const ellipses = [[0, 0.4, 11.9, 7.9], [-9.0, 5.0, 3.35, 3.15], [9.0, 5.0, 3.35, 3.15]]
    .map(([cx, cz, rx, rz]) => [cx, cz, rx + pad, rz + pad]);
  // 귀: 꼭짓점이 축 위에 있는 마름모(외접 반지름 4.5)를 three 의 rotation.y(+-0.12)처럼 돌린다
  const diamonds = [-1, 1].map((sx) => {
    const r = 4.5 + pad, a = sx * 0.12;
    return [[0, r], [r, 0], [0, -r], [-r, 0]]
      .map(([x, z]) => [sx * 7.8 + x * Math.cos(a) + z * Math.sin(a), -5.8 - x * Math.sin(a) + z * Math.cos(a)]);
  });
  const farthest = (dx, dz) => {
    let t = 0;
    for (const [cx, cz, rx, rz] of ellipses) {
      const px = ox - cx, pz = oz - cz;
      const A = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
      const B = 2 * ((px * dx) / (rx * rx) + (pz * dz) / (rz * rz));
      const C = (px * px) / (rx * rx) + (pz * pz) / (rz * rz) - 1;
      const disc = B * B - 4 * A * C;
      if (disc >= 0) t = Math.max(t, (-B + Math.sqrt(disc)) / (2 * A));
    }
    for (const d of diamonds) {
      for (let i = 0; i < 4; i++) {
        const [ax, az] = d[i], [bx, bz] = d[(i + 1) % 4];
        const ex = bx - ax, ez = bz - az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-12) continue;
        const wx = ax - ox, wz = az - oz;
        const tt = (wx * ez - wz * ex) / den;
        const s = (wx * dz - wz * dx) / den;
        if (tt > 0 && s >= -1e-12 && s <= 1 + 1e-12) t = Math.max(t, tt);
      }
    }
    return t;
  };
  const TAU = Math.PI * 2;
  const angles = new Map();
  const addAngle = (a) => { const n = ((a % TAU) + TAU) % TAU; angles.set(n.toFixed(9), n); };
  for (let i = 0; i < 360; i++) addAngle((i * Math.PI) / 180);
  for (const d of diamonds) for (const [x, z] of d) addAngle(Math.atan2(z - oz, x - ox));
  return [...angles.values()].sort((p, q) => p - q).map((a) => {
    const dx = Math.cos(a), dz = Math.sin(a), t = farthest(dx, dz);
    return [ox + t * dx, oz + t * dz];
  });
}
