// theme-geometry.js 순수 기하: 엘리베이터·대문 문짝이 열고 닫힐 때 틀 안에 머무는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorLeafPose } from '../public/js/theme-geometry.js';

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
