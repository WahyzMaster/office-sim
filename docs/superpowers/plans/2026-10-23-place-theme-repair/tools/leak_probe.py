import json
from playwright.sync_api import sync_playwright
import os
BASE = os.environ.get("OFFICE_SIM_URL", "http://localhost:4318/")
JS = r"""
async () => {
  const off = window.officeSim.office; const st = off.stage; const r = st.renderer;
  const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const mem = () => ({ geo: r.info.memory.geometries, tex: r.info.memory.textures, prog: r.info.programs?.length });
  const out = { floors: off.floors.length, start: mem(), steps: [] };
  const themes = ['studio', 'palace', 'office', 'hanok', 'starship', 'dogs', 'cats'];
  for (let round = 0; round < 3; round++) {
    for (const t of themes) {
      for (const f of off.floors) f.rebuildTheme(t);
      await raf();
    }
    out.steps.push(mem());
  }
  // count unique geometries referenced by the focused floor's archGroup after a studio rebuild
  for (const f of off.floors) f.rebuildTheme('studio');
  await raf();
  const f = off.floors[0]; const ids = new Set(); let meshes = 0;
  f.archGroup.traverse((o) => { if (o.geometry) { ids.add(o.geometry.uuid); meshes++; } });
  out.studioUniqueGeos = ids.size; out.studioMeshes = meshes; out.end = mem();
  return out;
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = br.new_context(viewport={"width": 1000, "height": 700}).new_page()
    prefs = {"roomTheme": "studio", "charTheme": "studio", "colorTheme": "light", "lang": "en", "soundOn": False, "voiceMode": "mute"}
    page.add_init_script(f"localStorage.setItem('office-sim:v1', {json.dumps(json.dumps(prefs))});")
    page.goto(BASE + "#demo"); page.wait_for_function("window.__officeReady === true", timeout=30000); page.wait_for_timeout(2000)
    print(json.dumps(page.evaluate(JS), indent=1))
    br.close()
