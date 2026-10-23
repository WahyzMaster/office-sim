// theme-geometry.js 순수 기하: 엘리베이터·대문 문짝이 열고 닫힐 때 틀 안에 머무는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorLeafPose, catOutline } from '../public/js/theme-geometry.js';
import { THEME_LAYOUTS } from '../public/js/theme-layouts.js';
import { inPolygon, distToPolygon } from './fixtures/geom-utils.mjs';

test('doorLeafPose: closed pose matches the original leaves, open leaves shrink toward the fixed outer edge', () => {
  const closed = doorLeafPose(0);
  assert.ok(Math.abs(closed.inner - 0.035) < 1e-9 && Math.abs(closed.len - 0.85) < 1e-9 && Math.abs(closed.centre - 0.46) < 1e-9);
  assert.ok(Math.abs(doorLeafPose(1).inner - 0.765) < 1e-9);
  for (let i = 0; i <= 10; i++) {
    const p = doorLeafPose(i / 10);
    assert.ok(Math.abs(p.inner + p.len - 0.885) < 1e-9, `open ${i / 10}`);
    assert.ok(Math.abs(p.centre - (p.inner + p.len / 2)) < 1e-9);
  }
});

// 선분 두 개가 끝점이 아닌 곳에서 만나는지.
function properCross([a, b], [c, d]) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

test('catOutline: one simple cat-face polygon covers every cats slot, door, spawn and the research tables', () => {
  const poly = catOutline(0);
  assert.ok(poly.length >= 360, `${poly.length} points`);
  const edges = poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 2; j < edges.length; j++) {
      if (i === 0 && j === edges.length - 1) continue;
      assert.ok(!properCross(edges[i], edges[j]), `edges ${i} and ${j} cross`);
    }
  }
  const inside = (x, z, what) => assert.ok(inPolygon([x, z], poly) && distToPolygon([x, z], poly) >= 0.05, `${what} (${x}, ${z})`);
  const L = THEME_LAYOUTS.cats;
  for (const [room, list] of Object.entries(L.slots)) {
    list.forEach(([x, z], k) => {
      inside(x, z, `slot ${room}#${k}`);
      for (let i = 0; i < 8; i++) inside(x + 0.24 * Math.cos((i * Math.PI) / 4), z + 0.24 * Math.sin((i * Math.PI) / 4), `slot ${room}#${k} rim`);
    });
  }
  for (const [room, d] of Object.entries(L.doors)) inside(d.x, d.inner, `door ${room}`);
  inside(L.elevator.x, L.elevator.z, 'spawn');
  inside(-11.4, 7.1, 'research table corner');
});

test('catOutline: the 0.3 rim outline also carries the elevator frame', () => {
  const rim = catOutline(0.3);
  for (const x of [-11.595, -11.245]) for (const z of [-1.1, 1.1]) assert.ok(inPolygon([x, z], rim), `frame corner (${x}, ${z})`);
});
