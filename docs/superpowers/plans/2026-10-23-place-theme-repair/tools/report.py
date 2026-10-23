import json, sys
from pathlib import Path
# usage: python3 -I report.py <analysis_dir>  (output of analyze_themes.py; writes <analysis_dir>/REPORT.txt)
A = Path(sys.argv[1] if len(sys.argv) > 1 else 'analysis')
out = []
for t in ["studio","office","palace","hanok","starship","dogs","cats"]:
    d = json.load(open(A / f"{t}.json")); f = d["findings"]
    out.append(f"\n######## THEME {t}  (meshes={d['meshCount']})  counts={d['counts']}")
    def b(x): return f"{x['geom'].replace('Geometry','')} {x['color']} @{x['src']} <{x.get('src2')}> min={x['min']} max={x['max']}"
    for k in ["noSupport","floating","floatingGlow","overhang","walkThrough","outside"]:
        for x in f[k]: out.append(f"[{k}] {b(x)}" + (f" gap={x.get('gapBelow')}" if 'gapBelow' in x else "") + (f" corners={x.get('cornerGaps')}" if 'cornerGaps' in x else ""))
    seen=set()
    for x in f["hidden"]:
        key=(x['hidden']['src'],x['by']['src'])
        if key in seen: continue
        seen.add(key); n=sum(1 for y in f['hidden'] if (y['hidden']['src'],y['by']['src'])==key)
        out.append(f"[hidden x{n}] {b(x['hidden'])}  INSIDE  {b(x['by'])}")
    for x in f["intersect"]:
        out.append(f"[intersect vol={x['vol']} ratio={x['ratio']}] A: {b(x['a'])}  |  B: {b(x['b'])}")
    for x in f["invisibleObstacle"]:
        out.append(f"[invisibleObstacle] {x['tag']} box(x0,z0,x1,z1)={x['box']} visibleCoverage={x['coverage']}")
    for x in f["slotBlocked"]:
        out.append(f"[slotBlocked] {x['room']}#{x['k']} ({x['x']},{x['z']}) meshes={[m['src'] for m in x['meshes']]} obstacles={x['obstacles']}")
    rf = f["raisedFloor"]
    if rf: out.append(f"[raisedFloor] {len(rf)} slots stand on floor tops above y=0 (agent feet at y=0 sink): tops={sorted(set(x['floorTop'] for x in rf))}")
    for x in f["ringClearance"]:
        out.append(f"[ringClearance] {b(x)} walk ring z={x['ring']}")
(A / "REPORT.txt").write_text("\n".join(out))
print("\n".join(out))
