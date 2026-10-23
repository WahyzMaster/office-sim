"""Synchronously step one agent toward ELEVATOR at 60 fps and see whether it ever arrives."""
import json, sys
from playwright.sync_api import sync_playwright
import os
BASE = os.environ.get("OFFICE_SIM_URL", "http://localhost:4318/")
themes = sys.argv[2:]
with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    for theme in themes:
        ctx = br.new_context(viewport={"width": 800, "height": 600})
        page = ctx.new_page()
        prefs = {"roomTheme": theme, "charTheme": theme, "colorTheme": "light", "lang": "en", "soundOn": False, "voiceMode": "mute"}
        page.add_init_script(f"localStorage.setItem('office-sim:v1', {json.dumps(json.dumps(prefs))});")
        page.goto(BASE + "#demo")
        page.wait_for_function("window.__officeReady === true", timeout=30000)
        page.wait_for_timeout(2500)
        r = page.evaluate("""async (DTARG) => {
          const rooms = await import('./js/rooms.js');
          const off = window.officeSim.office;
          const a = [...off.agents.values()][0];
          a.queue = [];
          a.group.position.set(-9.0, 0, 0.0);
          a.current = { kind: 'leave', room: 'lounge', t: 0, arrived: false };
          a.walkTo('lounge', rooms.ELEVATOR.x, rooms.ELEVATOR.z, -Math.PI / 2);
          const pathStart = a.path.map(p => [+p.x.toFixed(2), +p.z.toFixed(2)]);
          let frames = 0; let removed = false;
          const DT = DTARG; for (; frames < 600; frames++) {
            a.update(DT);
            if (!off.agents.has(a.id) && ![...off.agents.values()].includes(a)) { removed = true; break; }
          }
          return { elevator: { ...rooms.ELEVATOR }, pathStart, frames, removed, x: +a.group.position.x.toFixed(3), z: +a.group.position.z.toFixed(3), pathLeft: a.path.length };
        }""", float(sys.argv[1]))
        print(theme, json.dumps(r))
        ctx.close()
    br.close()
