"""Load one theme once, optionally apply a patch (inlined, CSP-safe), take several views.
Usage: python3 -I multishot.py <theme> <outprefix> <patch.js|-> view1 [view2 ...]
view = name:dx,dy,dz,tx,tz,zoom
"""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
theme, prefix, patchp = sys.argv[1:4]
views = sys.argv[4:]
patch = None if patchp == '-' else Path(patchp).read_text()
import os
BASE = os.environ.get("OFFICE_SIM_URL", "http://localhost:4318/")
VIEW_JS = """
async ([dx, dy, dz, tx, tz, zoom]) => {
  const THREE = await import('three');
  const off = window.officeSim.office; const st = off.stage;
  const f = off.floors[off.focusIndex] || off.floors[0];
  const y = f ? f.group.position.y : 0;
  st.controls.minPolarAngle = 0; st.controls.maxPolarAngle = Math.PI / 2;
  st.controls.minZoom = 0.2; st.controls.maxZoom = 8;
  const t = new THREE.Vector3(tx, y, tz);
  st.setGoal?.(t, { snapPan: true });
  st.controls.target.copy(t);
  st.camera.position.copy(t).add(new THREE.Vector3(dx, dy, dz).normalize().multiplyScalar(160));
  st.camera.lookAt(t);
  st.camera.zoom = zoom; st.camera.updateProjectionMatrix(); st.controls.update();
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = br.new_context(viewport={"width": 1400, "height": 1000})
    page = ctx.new_page()
    prefs = {"roomTheme": theme, "charTheme": theme, "colorTheme": "light", "lang": "en", "soundOn": False, "voiceMode": "mute"}
    page.add_init_script(f"localStorage.setItem('office-sim:v1', {json.dumps(json.dumps(prefs))});")
    page.goto(BASE + "#demo")
    page.wait_for_function("window.__officeReady === true", timeout=30000)
    page.wait_for_timeout(2500)
    page.add_style_tag(content="#hud,#exit-overlay,.labels,#boot,#inspector,#legend,#log{display:none!important}")
    if patch:
        r = page.evaluate("async () => { const THREE = await import('three'); const off = window.officeSim.office;"
                          " const f = off.floors[off.focusIndex] || off.floors[0]; const fn = (" + patch + "); return await fn(THREE, f); }")
        print("patch ->", r)
    for v in views:
        name, nums = v.split(':')
        vals = [float(x) for x in nums.split(',')]
        page.evaluate(VIEW_JS, vals); page.wait_for_timeout(500)
        page.evaluate(VIEW_JS, vals); page.wait_for_timeout(200)
        out = f"{prefix}_{name}.png"
        page.screenshot(path=out); print(out)
    br.close()
