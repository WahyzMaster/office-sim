// 일곱 공간 테마를 진짜 Floor.prototype.rebuildTheme 로 node 에서 짓고, 기록용 three.js(test/fixtures/three-record.mjs)로
// 메시의 월드 정점 샘플을 받아 기하 불변식을 확인한다. 브라우저 없이 npm test 로 깨진 건물·소품을 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE, root, mat, recordOf, buildTheme, makeFloor, THEMES } from './fixtures/load-three-record.mjs';
import { CHECKS } from './fixtures/theme-checks.mjs';
import { KNOWN } from './fixtures/theme-known.mjs';

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

test('Floor.rebuildTheme disposes the instance buffers of the previous build before clearing it', () => {
  const floor = makeFloor();
  const first = buildTheme('studio', floor);
  const books = first.meshes.filter((r) => r.kind === 'InstancedMesh').map((r) => r.obj);
  assert.ok(books.length > 0);
  buildTheme('palace', floor);
  assert.ok(books.every((o) => o.disposed), 'every InstancedMesh of the first build was disposed');
});

// 테마마다 두 번 짓는다: 첫 빌드는 검사용, 두 번째 빌드는 캐시된 재질·기하 위에서 새로 만드는 것이 없는지(alloc) 본다.
const BUILT = Object.fromEntries(THEMES.map((t) => [t, buildTheme(t)]));
const SECOND = Object.fromEntries(THEMES.map((t) => [t, buildTheme(t)]));

const RATCHETS = {
  ...CHECKS,
  alloc: (_b, t) => [
    ...Array.from({ length: SECOND[t].stats.geometries }, (_, i) => `geometry #${i + 1} allocated on rebuild`),
    ...Array.from({ length: SECOND[t].stats.materials }, (_, i) => `material #${i + 1} allocated on rebuild`),
  ],
  random: (b) => (b.stats.randomCalls ? [`Math.random called ${b.stats.randomCalls} times`] : []),
};

for (const [name, check] of Object.entries(RATCHETS)) {
  test(`theme invariant ${name}: failures match the known list for every theme`, () => {
    const msgs = [];
    for (const t of THEMES) {
      const fails = check(BUILT[t], t);
      const want = KNOWN[`${name}:${t}`] ?? 0;
      if (fails.length !== want) msgs.push(`${name}:${t} expected ${want} known failures, got ${fails.length}\n    ${fails.join('\n    ')}`);
    }
    assert.equal(msgs.length, 0, `\n${msgs.join('\n')}`);
  });
}
