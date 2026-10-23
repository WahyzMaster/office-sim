"""Deterministic geometry audit of every office-sim room theme (runs in headless Chromium).

Each mesh of the focused floor's archGroup is rebuilt with its creation call-site recorded, then checked for:
  floating / overhang (downward raycasts), hidden (fully enclosed by another mesh), interpenetration (AABB),
  slot-in-furniture, invisible collision boxes, solid props agents can walk through, raised floors (agent feet sink),
  and walk ring vs. centre feature clearance.

Usage: python3 -I analyze_themes.py <base_url> <out_dir> [theme ...]
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4318/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "analysis")
THEMES = sys.argv[3:] or ["studio", "office", "palace", "hanok", "starship", "dogs", "cats"]

ANALYZE_JS = r"""
async () => {
  const THREE = await import('three');
  const lay = await import('/js/theme-layouts.js');
  const off = window.officeSim.office;
  const f = off.floors[off.focusIndex] || off.floors[0];
  const theme = f.theme;

  // 1) 생성 위치(call-site)를 남기며 다시 짓는다.
  const origAdd = THREE.Object3D.prototype.add;
  THREE.Object3D.prototype.add = function (...objs) {
    const st = (new Error().stack || '').split('\n').slice(2)
      .map((l) => l.trim())
      .filter((l) => /\/js\/(theme-|furniture|floor)/.test(l))
      .map((l) => l.replace(/^at\s+/, '').replace(/https?:\/\/[^/]+\/js\//, '').replace(/[()]/g, ''))
      .slice(0, 3);
    for (const o of objs) if (o && !o.userData.src) o.userData.src = st;
    return origAdd.apply(this, objs);
  };
  try { f.rebuildTheme(theme); } finally { THREE.Object3D.prototype.add = origAdd; }
  f.group.updateMatrixWorld(true);
  const y0 = f.group.position.y;

  const all = [];
  f.archGroup.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) all.push(o); });
  const r3 = (v) => +v.toFixed(3);
  const info = all.map((o, i) => {
    const b = new THREE.Box3().setFromObject(o);
    const m = o.material;
    const src = o.userData.src?.length ? o.userData.src : (o.parent?.userData?.src || []);
    return {
      i, o, b,
      geom: o.geometry.type,
      color: m.color ? '#' + m.color.getHexString() : null,
      emissive: m.emissive && m.emissive.getHex() ? '#' + m.emissive.getHexString() : null,
      transparent: !!m.transparent && m.opacity < 0.95,
      src,
      min: [r3(b.min.x), r3(b.min.y - y0), r3(b.min.z)],
      max: [r3(b.max.x), r3(b.max.y - y0), r3(b.max.z)],
    };
  });
  const brief = (m) => ({ i: m.i, geom: m.geom, color: m.color, src: m.src[0] || null, src2: m.src[1] || null, min: m.min, max: m.max });
  const H = (m) => m.max[1] - m.min[1];
  const footprint = (m) => (m.max[0] - m.min[0]) * (m.max[2] - m.min[2]);
  // 바닥재(슬래브·바닥·러그): 윗면이 거의 0 이하이고 넓다
  const isGround = (m) => m.max[1] <= 0.2 && footprint(m) > 1.5 && H(m) < 0.6;
  const isSolid = (m) => !m.transparent && !m.emissive && !isGround(m) && H(m) > 0.05;

  // DoubleSide 로 바꿔 레이캐스트(안/밖 판정용), 끝나면 되돌린다.
  const sides = new Map();
  for (const m of info) { sides.set(m.o, m.o.material.side); }
  const setDouble = (on) => { for (const m of info) m.o.material.side = on ? THREE.DoubleSide : sides.get(m.o); };

  const rc = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const meshes = info.map((m) => m.o);
  const findings = { noSupport: [], floating: [], floatingGlow: [], overhang: [], hidden: [], intersect: [], slotBlocked: [], invisibleObstacle: [],
    walkThrough: [], raisedFloor: [], ringClearance: [], outside: [] };

  setDouble(true);
  // 2) 받침 확인: 바닥 아래로 레이를 쏜다
  for (const m of info) {
    if (m.min[1] < -0.04 || isGround(m)) continue;
    const others = meshes.filter((o) => o !== m.o);
    const cx = (m.min[0] + m.max[0]) / 2, cz = (m.min[2] + m.max[2]) / 2;
    const ix = (m.max[0] - m.min[0]) * 0.35, iz = (m.max[2] - m.min[2]) * 0.35;
    const y = m.min[1] + y0 + 0.03;
    const probe = (x, z) => {
      rc.set(new THREE.Vector3(x, y, z), DOWN);
      rc.far = 3;
      const hit = rc.intersectObjects(others, false)[0];
      return hit ? +(hit.distance - 0.03).toFixed(3) : null;
    };
    const c = probe(cx, cz);
    const corners = [probe(cx - ix, cz - iz), probe(cx + ix, cz - iz), probe(cx - ix, cz + iz), probe(cx + ix, cz + iz)];
    if (c == null && corners.every((d) => d == null)) {
      findings.noSupport.push({ ...brief(m), emissive: m.emissive });
      continue;
    }
    // 다른 메시의 윗면(또는 옆면)이 이 메시 밑면에 닿아 있으면 받쳐진 것으로 본다 (다리 위 상판, 기둥 위 처마 등)
    const touched = info.some((o) => o !== m && !(o.max[0] < m.min[0] - 0.02 || o.min[0] > m.max[0] + 0.02 || o.max[2] < m.min[2] - 0.02 || o.min[2] > m.max[2] + 0.02)
      && o.min[1] <= m.min[1] + 0.06 && o.max[1] >= m.min[1] - 0.06);
    if ((c == null || c > 0.12) && !touched) {
      (m.emissive || m.transparent ? findings.floatingGlow : findings.floating).push({ ...brief(m), gapBelow: c });
    } else if (corners.some((d) => d == null || d > 0.4) && m.min[1] < 0.2) {
      findings.overhang.push({ ...brief(m), cornerGaps: corners });
    }
  }

  // 3) 가려진 메시: AABB 가 다른 메시 안에 들어가고, 꼭짓점·중심이 모두 그 메시 내부(홀수 교차)
  const inside = (pt, target) => {
    let n = 0;
    for (const dir of [new THREE.Vector3(1, 0.013, 0.007), new THREE.Vector3(-0.01, 0.017, 1)]) {
      rc.set(pt, dir.normalize());
      rc.far = 100;
      n += rc.intersectObject(target, false).length % 2;
    }
    return n === 2;
  };
  for (const a of info) {
    if (H(a) <= 0 || isGround(a)) continue;
    for (const b of info) {
      if (a === b || isGround(b) || b.transparent) continue;
      if (!b.b.containsBox(a.b)) continue;
      const pts = [a.b.getCenter(new THREE.Vector3())];
      for (const x of [a.b.min.x, a.b.max.x]) for (const yy of [a.b.min.y, a.b.max.y]) for (const z of [a.b.min.z, a.b.max.z]) {
        pts.push(new THREE.Vector3(x, yy, z).lerp(pts[0], 0.02));
      }
      if (pts.every((p) => inside(p, b.o))) { findings.hidden.push({ hidden: brief(a), by: brief(b) }); break; }
    }
  }
  setDouble(false);

  // 4) 겹침(AABB 교차 부피): 서로 다른 생성 위치의 단단한 메시끼리
  const solids = info.filter(isSolid);
  for (let p = 0; p < solids.length; p++) for (let q = p + 1; q < solids.length; q++) {
    const a = solids[p], b = solids[q];
    if (a.src[0] && a.src[0] === b.src[0]) continue;
    const ib = a.b.clone().intersect(b.b);
    if (ib.isEmpty()) continue;
    const s = ib.getSize(new THREE.Vector3());
    const vol = s.x * s.y * s.z;
    const va = a.b.getSize(new THREE.Vector3()), vb = b.b.getSize(new THREE.Vector3());
    const minV = Math.min(va.x * va.y * va.z, vb.x * vb.y * vb.z);
    if (vol > 0.004 && vol / minV > 0.12) findings.intersect.push({ a: brief(a), b: brief(b), vol: r3(vol), ratio: r3(vol / minV) });
  }

  // 5) 자리(slot)가 가구 안에 있는지
  const L = lay.layoutOf(theme);
  const obs = lay.obstaclesOf(theme);
  for (const [room, list] of Object.entries(L.slots)) {
    list.forEach(([x, z], k) => {
      const hits = info.filter((m) => isSolid(m) && m.min[1] < 0.9 && m.max[1] > 0.25
        && x + 0.22 > m.min[0] && x - 0.22 < m.max[0] && z + 0.22 > m.min[2] && z - 0.22 < m.max[2]);
      const ob = obs.filter((o) => x > o.x0 - 0.1 && x < o.x1 + 0.1 && z > o.z0 - 0.1 && z < o.z1 + 0.1).map((o) => o.tag);
      if (hits.length || ob.length) findings.slotBlocked.push({ room, k, x, z, meshes: hits.map(brief), obstacles: ob });
    });
  }

  // 6) 충돌 상자인데 눈에 보이는 물체가 거의 없는 곳 (투명 유리도 '보이는 벽'으로 친다)
  const visibleAt = (x, z) => info.some((m) => !isGround(m) && m.max[1] > 0.3 && m.min[1] < 1.2
    && x >= m.min[0] && x <= m.max[0] && z >= m.min[2] && z <= m.max[2]);
  for (const o of obs) {
    let n = 0, hit = 0;
    for (let x = o.x0 + 0.05; x < o.x1; x += 0.1) for (let z = o.z0 + 0.02; z < o.z1; z += 0.08) { n++; if (visibleAt(x, z)) hit++; }
    const cov = n ? hit / n : 0;
    if (cov < 0.35) findings.invisibleObstacle.push({ tag: o.tag, box: [o.x0, o.z0, o.x1, o.z1].map(r3), coverage: r3(cov) });
  }

  // 7) 보행 높이에 서 있는 단단한 물체인데 어떤 충돌 상자와도 겹치지 않음 (실내 범위만)
  for (const m of solids) {
    if (m.min[1] > 0.3 || m.max[1] < 0.45 || footprint(m) < 0.03) continue;
    const cx = (m.min[0] + m.max[0]) / 2, cz = (m.min[2] + m.max[2]) / 2;
    if (Math.abs(cx) > 11.9 || Math.abs(cz) > 7.9) continue;
    const covered = obs.some((o) => m.max[0] > o.x0 && m.min[0] < o.x1 && m.max[2] > o.z0 && m.min[2] < o.z1);
    if (!covered) findings.walkThrough.push(brief(m));
  }

  // 8) 사람 발이 묻히는 올린 바닥 (y=0 위로 솟은 넓은 바닥면 위에 slot 이 있음)
  for (const [room, list] of Object.entries(L.slots)) {
    list.forEach(([x, z], k) => {
      let top = 0;
      for (const m of info) {
        if (footprint(m) < 0.6 || m.min[1] > 0.3) continue;
        if (x >= m.min[0] && x <= m.max[0] && z >= m.min[2] && z <= m.max[2] && m.max[1] > top && m.max[1] <= 0.35) top = m.max[1];
      }
      if (top > 0.06) findings.raisedFloor.push({ room, k, x, z, floorTop: r3(top) });
    });
  }

  // 9) 중앙 장애물(연못·워프코어 등)과 보행 링(z = zNorth/zSouth)의 여유
  if (L.obstacle) {
    const center = info.filter((m) => !isGround(m) || m.max[1] > 0.06)
      .filter((m) => Math.abs((m.min[0] + m.max[0]) / 2) < 3.6 && Math.abs((m.min[2] + m.max[2]) / 2) < 1.9 && m.max[1] > 0.06);
    for (const m of center) {
      const reachN = m.min[2] < L.obstacle.zNorth + 0.25 && m.max[0] > L.obstacle.x0 && m.min[0] < L.obstacle.x1;
      const reachS = m.max[2] > L.obstacle.zSouth - 0.25 && m.max[0] > L.obstacle.x0 && m.min[0] < L.obstacle.x1;
      if (reachN || reachS) findings.ringClearance.push({ ...brief(m), ring: [L.obstacle.zNorth, L.obstacle.zSouth] });
    }
  }

  // 10) 건물 바깥(±12.3, ±8.3) 으로 나간 물체
  for (const m of info) {
    const cx = (m.min[0] + m.max[0]) / 2, cz = (m.min[2] + m.max[2]) / 2;
    if (Math.abs(cx) > 12.3 || Math.abs(cz) > 8.3) findings.outside.push(brief(m));
  }

  const counts = Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length]));
  return { theme, meshCount: info.length, counts, findings };
}
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    summary = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for theme in THEMES:
            ctx = browser.new_context(viewport={"width": 1200, "height": 800})
            page = ctx.new_page()
            prefs = {"roomTheme": theme, "charTheme": theme, "colorTheme": "light", "lang": "en", "soundOn": False, "voiceMode": "mute"}
            page.add_init_script(f"localStorage.setItem('office-sim:v1', {json.dumps(json.dumps(prefs))});")
            page.goto(BASE + "#demo", wait_until="load")
            page.wait_for_function("window.__officeReady === true", timeout=30000)
            page.wait_for_timeout(1500)
            res = page.evaluate(ANALYZE_JS)
            (OUT / f"{theme}.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
            summary[theme] = res["counts"]
            ctx.close()
        browser.close()
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
