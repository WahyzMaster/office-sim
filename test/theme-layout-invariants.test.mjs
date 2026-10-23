// theme-layouts.js 순수 데이터 불변식: 자리·문·엘리베이터가 건물 안쪽에 있고, 고리 보행 띠가 복도 안에 들어가는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_LAYOUTS } from '../public/js/theme-layouts.js';
import { KNOWN } from './fixtures/theme-known.mjs';

const THEMES = Object.keys(THEME_LAYOUTS);
const inside = (x, z) => Math.abs(x) <= 11.6 + 1e-9 && Math.abs(z) <= 7.6 + 1e-9;

const PURE = {
  bounds(t) {
    const L = THEME_LAYOUTS[t];
    const out = [];
    for (const [room, list] of Object.entries(L.slots)) list.forEach(([x, z], k) => { if (!inside(x, z)) out.push(`slot ${room}#${k} (${x}, ${z})`); });
    for (const [room, d] of Object.entries(L.doors)) if (!inside(d.x, d.inner)) out.push(`door ${room} (${d.x}, ${d.inner})`);
    if (!inside(L.elevator.x, L.elevator.z)) out.push(`elevator (${L.elevator.x}, ${L.elevator.z})`);
    return out;
  },
  // 걷는 몸(lane 0.7 x 0.25 + 반지름 0.2 = 0.375)이 중앙 장애물(|z| <= 0.92)과 복도 칸막이(|z| >= 1.88) 사이에 들어가는지
  ringLanes(t) {
    const L = THEME_LAYOUTS[t];
    if (L.walkway !== 'ring') return [];
    return [L.obstacle.zNorth, L.obstacle.zSouth].filter((z) => !(Math.abs(z) + 0.375 <= 1.88 + 1e-9 && Math.abs(z) - 0.375 >= 0.92 - 1e-9))
      .map((z) => `ring lane at z ${z} leaves the corridor band`);
  },
};

// 출입 지점(직원이 나타나고 사라지는 곳)이 엘리베이터 틀·대문 문짝과 겹치지 않는지.
// 포털: 틀 반폭 0.175 + 문짝 앞면 0.045 + 직원 반지름 0.24 + 여유 0.16 = 0.62, 대문: 문짝 반폭 0.05 + 반지름 0.24 = 0.29
test('theme layout: every elevator spawn stands clear of its frame or gate leaves', () => {
  for (const t of THEMES) {
    const e = THEME_LAYOUTS[t].elevator;
    assert.ok(['portal', 'gate'].includes(e.kind), `${t} kind`);
    assert.ok(e.x >= -11.6, `${t} spawn inside the building`);
    assert.ok(e.x >= e.frameX + (e.kind === 'portal' ? 0.62 : 0.29) - 1e-9, `${t} spawn ${e.x} vs frame ${e.frameX}`);
  }
});

for (const [name, check] of Object.entries(PURE)) {
  test(`theme layout invariant ${name}: failures match the known list for every theme`, () => {
    const msgs = [];
    for (const t of THEMES) {
      const fails = check(t);
      const want = KNOWN[`${name}:${t}`] ?? 0;
      if (fails.length !== want) msgs.push(`${name}:${t} expected ${want} known failures, got ${fails.length}\n    ${fails.join('\n    ')}`);
    }
    assert.equal(msgs.length, 0, `\n${msgs.join('\n')}`);
  });
}
