"""Capture every room theme of office-sim from several camera angles (headless Chromium).

Usage: python3 capture_themes.py <base_url> <out_dir> [theme ...]
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4318/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "captures")
THEMES = sys.argv[3:] or ["studio", "office", "palace", "hanok", "starship", "dogs", "cats"]

# name -> (dir x, dir y, dir z, target x, target z, zoom)
VIEWS = {
    "iso_se": (1, 0.92, 1, 0, 0, 1.0),
    "iso_sw": (-1, 0.92, 1, 0, 0, 1.0),
    "iso_ne": (1, 0.92, -1, 0, 0, 1.0),
    "iso_nw": (-1, 0.92, -1, 0, 0, 1.0),
    "top": (0.001, 1, 0.02, 0, 0, 1.0),
    "low_s": (0.15, 0.32, 1, 0, 0, 1.0),
    "low_w": (-1, 0.32, 0.15, 0, 0, 1.0),
    "room_archive": (1, 0.8, 1, -8, -5, 2.4),
    "room_dev": (1, 0.8, 1, 0, -5, 2.4),
    "room_server": (1, 0.8, 1, 8, -5, 2.4),
    "room_research": (1, 0.8, 1, -8, 5, 2.4),
    "room_meeting": (1, 0.8, 1, 0, 5, 2.4),
    "room_desk": (1, 0.8, 1, 8, 5, 2.4),
    "room_lounge_w": (1, 0.8, 1, -9, 0, 2.4),
    "room_lounge_e": (1, 0.8, 1, 8, 0, 2.4),
    "center": (1, 0.8, 1, 0, 0, 2.6),
    "entrance": (1, 0.6, 0.4, -11.5, 0, 2.8),
    "exterior_n": (0.3, 0.55, -1, 0, -7, 1.6),
    "exterior_s": (0.3, 0.55, 1, 0, 7, 1.6),
}

HIDE_CSS = """
#hud, #exit-overlay, .labels, #boot, #inspector, #legend, #log { display: none !important; }
"""

SET_VIEW_JS = """
async ([dx, dy, dz, tx, tz, zoom]) => {
  const THREE = await import('three');
  const st = window.officeSim.office.stage;
  const f = window.officeSim.office.floors[window.officeSim.office.focusIndex] || window.officeSim.office.floors[0];
  const y = f ? f.group.position.y : 0;
  st.controls.minPolarAngle = 0;
  st.controls.maxPolarAngle = Math.PI / 2;
  st.controls.minZoom = 0.2;
  st.controls.maxZoom = 8;
  const t = new THREE.Vector3(tx, y, tz);
  st.setGoal?.(t, { snapPan: true });
  st.controls.target.copy(t);
  const d = new THREE.Vector3(dx, dy, dz).normalize().multiplyScalar(160);
  st.camera.position.copy(t).add(d);
  st.camera.lookAt(t);
  st.camera.zoom = zoom;
  st.camera.updateProjectionMatrix();
  st.controls.update();
  return { floors: window.officeSim.office.floors.length, y };
}
"""


DUMP_JS = """
async () => {
  const THREE = await import('three');
  const lay = await import('/js/theme-layouts.js');
  const rooms = await import('/js/rooms.js');
  const off = window.officeSim.office;
  const f = off.floors[off.focusIndex] || off.floors[0];
  const theme = f.theme;
  f.group.updateMatrixWorld(true);
  const y0 = f.group.position.y;
  const meshes = [];
  const b = new THREE.Box3();
  let idx = 0;
  f.archGroup.traverse((o) => {
    if (!o.isMesh && !o.isLineSegments) return;
    const i = idx++;
    if (o.isInstancedMesh) { meshes.push({ i, kind: 'instanced', count: o.count }); return; }
    b.setFromObject(o);
    const g = o.geometry;
    const gp = g.parameters || {};
    const mat = o.material || {};
    meshes.push({
      i,
      geom: g.type,
      gparams: Object.fromEntries(Object.entries(gp).filter(([k, v]) => typeof v === 'number')),
      color: mat.color ? '#' + mat.color.getHexString() : null,
      emissive: mat.emissive ? '#' + mat.emissive.getHexString() : null,
      opacity: mat.transparent ? mat.opacity : 1,
      pos: o.getWorldPosition(new THREE.Vector3()).toArray().map((v, k) => +(k === 1 ? v - y0 : v).toFixed(3)),
      scale: o.scale.toArray().map((v) => +v.toFixed(3)),
      rot: [o.rotation.x, o.rotation.y, o.rotation.z].map((v) => +v.toFixed(3)),
      min: [b.min.x, b.min.y - y0, b.min.z].map((v) => +v.toFixed(3)),
      max: [b.max.x, b.max.y - y0, b.max.z].map((v) => +v.toFixed(3)),
      parentIsGroup: o.parent !== f.archGroup,
    });
  });
  const L = lay.layoutOf(theme);
  return {
    theme,
    meshes,
    slots: L.slots,
    doors: L.doors,
    elevator: L.elevator,
    walkway: L.walkway,
    obstacle: L.obstacle || null,
    obstacles: lay.obstaclesOf(theme),
    rooms: rooms.ROOMS,
  };
}
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for theme in THEMES:
            ctx = browser.new_context(viewport={"width": 1600, "height": 1100}, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on("console", lambda m, e=errors: e.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda ex, e=errors: e.append(f"pageerror: {ex}"))
            prefs = {"roomTheme": theme, "charTheme": theme if theme not in ("dogs", "cats") else theme,
                     "colorTheme": "light", "lang": "en", "soundOn": False, "voiceMode": "mute"}
            page.add_init_script(f"localStorage.setItem('office-sim:v1', {json.dumps(json.dumps(prefs))});")
            page.goto(BASE + "#demo", wait_until="load")
            page.wait_for_function("window.__officeReady === true", timeout=30000)
            page.wait_for_timeout(5000)
            page.add_style_tag(content=HIDE_CSS)
            tdir = OUT / theme
            tdir.mkdir(exist_ok=True)
            dump = page.evaluate(DUMP_JS)
            (tdir / "geometry.json").write_text(json.dumps(dump, indent=1, ensure_ascii=False))
            info = None
            for name, v in VIEWS.items():
                info = page.evaluate(SET_VIEW_JS, list(v))
                page.wait_for_timeout(700)
                # stage.update may ease the target back; re-apply once right before capture
                page.evaluate(SET_VIEW_JS, list(v))
                page.wait_for_timeout(250)
                page.screenshot(path=str(tdir / f"{name}.png"))
            report[theme] = {"errors": errors[:40], "info": info}
            ctx.close()
        browser.close()
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
