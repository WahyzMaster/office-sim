// 일곱 공간 테마를 진짜 Floor.prototype.rebuildTheme 로 node 에서 짓고, 기록용 three.js(test/fixtures/three-record.mjs)로
// 메시의 월드 정점 샘플을 받아 기하 불변식을 확인한다. 브라우저 없이 npm test 로 깨진 건물·소품을 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE, root, mat, recordOf, buildTheme, THEMES } from './fixtures/load-three-record.mjs';

test('three-record: world samples compose T*R*S (non-uniform scale before rotation)', () => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), mat);
  m.scale.set(11.2, 0.52, 8.6);
  m.rotation.y = Math.PI / 8;
  root.add(m);
  assert.ok(recordOf(m).samples.some(([x, , z]) => Math.abs(x - 10.348) < 1e-3 && Math.abs(z + 4.286) < 1e-3));
});

test('buildTheme: every room theme builds through Floor.rebuildTheme with two doors, leds and a globe', () => {
  for (const t of THEMES) {
    const b = buildTheme(t);
    assert.equal(b.doors.length, 2, t);
    assert.ok(b.meshes.length > 100 && b.globe && b.leds.length > 0, t);
  }
});
