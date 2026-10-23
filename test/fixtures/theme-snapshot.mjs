// 리팩터 전후 비교용: 테마마다 메시 한 줄씩 정렬해 찍는다. node test/fixtures/theme-snapshot.mjs > before.txt
import { buildTheme, THEMES } from './load-three-record.mjs';

const f2 = (v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const f3 = (v) => (typeof v === 'number' ? +v.toFixed(3) : v);
const lines = [];
for (const t of THEMES) {
  for (const r of buildTheme(t).meshes) {
    if (r.kind === 'InstancedMesh') { lines.push(`${t} InstancedMesh ${r.geom.type} count=${r.count}`); continue; }
    const params = Object.values(r.geom.params).filter((v) => typeof v === 'number').map(f3).join(',');
    lines.push(`${t} ${r.kind} ${r.geom.type}(${params}) ${r.mat.color ?? '-'} min=[${r.aabb.min.map(f2)}] max=[${r.aabb.max.map(f2)}]`);
  }
}
process.stdout.write(`${lines.sort().join('\n')}\n`);
