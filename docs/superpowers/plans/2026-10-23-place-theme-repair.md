# Place Theme Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair every verified broken building and object in the seven office-sim place themes (studio, office, palace, hanok, starship, dogs, cats), lock each repair in with node-run geometry invariants, and leave theme-identity polish as optional follow-up tasks.

**Architecture:** First a recording three.js stub lets `node --test` build all seven themes through the real `Floor.prototype.rebuildTheme` dispatch and assert geometry invariants (shear, hidden meshes, floor support, floor height, ring clearance, collision/visual coverage, globe and route clearance, allocation, determinism, coplanar tops, backed screens) against a ratcheting allowlist of today's known failures. Shared root causes are then fixed once in shared helpers and in pure layout data (roof geometry, elevator/gate data and door kinematics, corridor rails derived from `obstaclesOf`, floor heights, centre-feature sizing, scroll screens, globe boxes, rebuild hygiene), followed by per-theme P0/P1 fixes and optional P2 tasks. Every task starts by removing its entries from the allowlist (red) and ends green.

**Tech Stack:** three.js 0.160 (CDN importmap), vanilla ES modules, node --test.

**Spec:** "User request 2026-10-23: improve place themes; fix broken objects and buildings." Evidence travels with this plan in `docs/superpowers/plans/2026-10-23-place-theme-repair/` (`$AUDIT` below): `audit/verified-audit.json` (every finding id such as `studio-01`, with evidence, fix and verifier notes; Task 27 cites its improvement sketches by title), `audit/REPORT.txt` (deterministic geometry audit), `audit/geometry-<theme>.json` (per-mesh AABBs), `reference/*.jpg` (before renders and verified fix experiments) and `tools/` (render and probe scripts).

---

## Global Constraints

- Zero npm dependencies: tests use only `node:test`, `node:assert`, `node:module`; three.js stays on the CDN importmap.
- English identifiers; comments follow the existing Korean comment style; no emoticons in markdown.
- Files stay at or below about 500 lines. `theme-grounds.js` (403) and `theme-props.js` (409) are split in Task 4 before anything grows; every task's verify step runs `wc -l public/js/theme-*.js public/js/furniture.js public/js/floor.js`.
- The `theme-layouts.js` contract (THEME_LAYOUTS slots/doors/elevator, `obstaclesOf`, `corridorWaypoints`) is stable except where a task says otherwise: Task 6 (elevator data), Task 12 (research-globe boxes), Task 21 (studio/office extra boxes), Task 22 (lounge-sofa table). Every `obstaclesOf` change re-runs `test/browser-names.test.mjs:353-370` (all 7 themes: slots clear at r 0.24, door-to-slot routes clear at r 0.16, at least 20 boxes) and keeps the pins at `:172-190` (hanok `ELEVATOR.x === -11.6`, ring detour `abs(z) >= 1.3`) and `segmentHitsObstacle(-8, 2.9, -8, 6.6, 0.2, 'studio') === true`. Palace obstacles are pinned indirectly by that loop too (palace-m03).
- Low-poly primitives only; no external assets, textures or loaders.
- `npm test` stays green after every task (baseline 1299 passing plus the new tests). Known failures live only in the Task 2 allowlist `test/fixtures/theme-known.mjs`, never as skipped tests.
- Return contracts (test/page-approval-office.test.mjs:338-363): `buildThemeGround` returns exactly 2 door leaves; every `build*Props` returns non-empty `leds` and a `globe`; builders only call `g.add` on the passed parent.
- New geometries and materials are module-level constants or members of the cached `mats()` / `themeMats()`; never created per build (harness check `alloc`). Never call `rotateY` or `dispose` on a shared geometry (`CONE4` also feeds the cats ears until Task 19). Never call `themed()` outside `mats()` (scene.js:19-25 pushes every call into THEMED).
- Floor-layer rule: agent feet are at y = 0 (agent.js/agent-mesh.js); walkable tops are at most 0.06; any new decal or pad top differs by at least 0.005 from every overlapping flat top of a different material (harness `coplanar`).
- Centre-feature rule (ring themes): anything taller than 0.08 stays inside the corridor-center box (`abs(x) <= obstacle.x1 - 0.35`, `abs(z) <= 0.92`); the ring lane body band is `abs(zRing) +/- 0.375` (lane offset 0.7 x 0.25 plus the 0.2 walking radius `resolveObstacleCollision(pos, 0.2, ...)` uses in Agent.update).
- Camera rule: the default camera looks from SE (+x, +z). Opaque corridor rails are at most 0.75 tall, translucent strips at most 1.0 with `castShadow = false`; no prop taller than 0.8 within 0.6 of the east (x > 11) or south (z > 7.3) edge; tall identity props go on north or west walls.
- Collision/visual rule: a visible barrier lies inside the obstacle box it represents, and nothing visible enters a door gap (`d.x +/- 0.95`).
- Line numbers are pre-split (commit 369f29b). After Task 4, locate code by function name plus the quoted literal; Task 4 lists every move.
- Process (user policy): implement in a git worktree under `.worktrees/` cut from `origin/master`; commit only when the user has approved committing; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit subjects follow the repo style (`test(themes): ...`, `fix(themes): ...`, `refactor(themes): ...`, `feat(themes): ...`).
- Render checks. `AUDIT=docs/superpowers/plans/2026-10-23-place-theme-repair` (committed tools and references) and `OUT=${TMPDIR:-/tmp}/office-sim-theme-audit` (new renders and analyzer output; never committed; `mkdir -p $OUT/<theme>` first). Tools need Python 3 with Playwright (`pip install playwright && playwright install chromium`). Serve the worktree, not the main checkout: add a `.claude/launch.json` entry (or use the preview tool) running `node bin/office-sim.mjs --port 4319 --replay test/fixtures/replay/7e7e7e7e-1111-4222-8333-444455556666.jsonl --speed 4 --loop`. Shots: `OFFICE_SIM_URL=http://localhost:4319/ python3 -I $AUDIT/tools/multishot.py <theme> $OUT/<theme>/audit_T<n> <patch.js or -> <view...>`. Analyzer: `python3 -I $AUDIT/tools/analyze_themes.py http://localhost:4319/ $OUT/analysis_T<n> <theme...>` (then `python3 -I $AUDIT/tools/report.py $OUT/analysis_T<n>` writes a readable `REPORT.txt` there). In-page patches must be function expressions inlined by `multishot.py` (the page CSP blocks `eval`). Open-door renders use `$AUDIT/tools/doors_hold_open.js`. In-page demo framing drifts between runs; treat before/after pairs as qualitative.
- View strings (name:dx,dy,dz,tx,tz,zoom): `iso_se:1,0.92,1,0,0,1` `iso_sw:-1,0.92,1,0,0,1` `iso_ne:1,0.92,-1,0,0,1` `iso_nw:-1,0.92,-1,0,0,1` `top:0.001,1,0.02,0,0,1` `low_s:0.15,0.32,1,0,0,1` `low_w:-1,0.32,0.15,0,0,1` `center:1,0.8,1,0,0,2.6` `entrance:1,0.6,0.4,-11.5,0,2.8` `exterior_n:0.3,0.55,-1,0,-7,1.6` `exterior_s:0.3,0.55,1,0,7,1.6` and `room_<k>:1,0.8,1,<x>,<z>,2.4` with archive (-8,-5), dev (0,-5), server (8,-5), research (-8,5), meeting (0,5), desk (8,5), lounge_w (-9,0), lounge_e (8,0).
- Thin seam artefacts (starship-09, dogs-10, cats-m02) were seen in swiftshader; confirm on a real GPU before spending more than the planned one-line fix.

---

## Review Focus

| # | Failure mode | What pins it | Owner |
|---|---|---|---|
| 1 | A fix in a shared helper silently changes another theme: `roofEave` (palace+hanok), `buildElevatorDoors` (5 themes), `scrollScreen` (27 call sites, 5 themes), `buildStandardPartitions` (studio+office), `populateShelves` (palace+hanok), all of furniture.js (studio+office), `M.rug` (all) | Per-theme snapshot diff (`test/fixtures/theme-snapshot.mjs`, Task 1) reviewed in every task touching a shared helper; per-theme `KNOWN` ratchet counts must change only for the themes the task names | Tasks 1, 4, 5, 6, 11 |
| 2 | Collision boxes drift from visuals: rails vs `part-*`, `div-*` tails, lounge-sofa props, research-globe boxes vs spinning rings, props agents walk through | Harness `coverage`, `globe`, `routeClear`; browser-names `:353-370`; rails are generated from `obstaclesOf` so they cannot drift | Tasks 8, 12, 16, 18, 19, 21, 22 |
| 3 | Agents vs floors and centre features: feet sinking, ring lanes crossing plinths, spawn inside frames, leave target behind the -11.65 clamp (agents never despawn) | Harness `floorTop`, `ringClear`, `support`; pure `bounds` and spawn-vs-frame invariants; `$AUDIT/tools/leave_probe3.py` at dt 1/60 and 1/30 | Tasks 6, 7, 9, 10 |
| 4 | Roofs, walls and new props occluding rooms: roofs from NE/NW cameras, tall rails or identity props at the camera-side edges | Render checks at `iso_ne`/`iso_nw` (roofs) and `iso_se` (rails, props) with the camera rule; facade cutaway later | Tasks 5, 8, 27, 28 |
| 5 | Theme switching and rebuild hygiene: geometries allocated per build, InstancedMesh buffers never disposed, Math.random layouts, new coplanar decals, door array length | Harness `alloc`, `random`, `coplanar`, dispose test; page-approval-office `:338-363` | Tasks 3, 13, plus every task adding decals |


## Skills for implementers

- `threejs-fundamentals` (installed): transforms, T*R*S order, object hierarchy; read before Tasks 5, 6, 10, 19, 25.
- `superpowers:test-driven-development`, `superpowers:verification-before-completion`: every task ratchets `KNOWN` red before it goes green.
- Optional, not installed (found with `npx skills find threejs`): `cloudai-x/threejs-skills@threejs-geometry` (13.9K installs; BufferGeometry, ExtrudeGeometry, baking transforms). Useful for Task 19 (cat outline extrusion) and a ridged hip roof if chosen. Install: `npx skills add cloudai-x/threejs-skills@threejs-geometry -g -y`.


## Open Questions (defaults apply unless the user objects)

Decisions that change how the themes look:
1. Roofs (Task 5): a single-peak hip roof (default, already verified in `$AUDIT/reference/hanok-EXPERIMENT_roof_fixed_iso_se.jpg`). The alternative is a ridged hip roof with a horizontal ridge line for the long hanok north eave and the palace eaves; it needs a custom geometry.
2. Raised floors (Task 9): thin the palace and hanok maru floors to about 3 cm so feet stop sinking (default). This loses most of the raised-floor look. The alternative is a per-theme floor height for agents, which touches the agent rig, placement and click picking.
3. Cat lounge floor (Task 19): one merged cat-face outline, with ears to the north and paws to the south, built as an extrusion (default, effort L). The cheaper fallback adds cheek lobes, but it showed seams in testing.
4. Corridor rails in open themes (Task 8): draw rails where agents already stop at invisible walls (default). Hanok gets a 0.48 m wooden lattice, starship a 0.94 m force-field strip, dogs a 0.62 m picket fence and cats a 0.58 m velvet wall. Removing the collision boxes instead is not recommended.

Scope and engineering:
5. Node test harness (Tasks 1-2): a recording three.js stub (about 900 lines of test fixtures) so that `npm test` checks theme geometry (default). The cheaper alternative is to rely only on the Python browser audit, which leaves `npm test` blind to geometry regressions.
6. Module split (Task 4): split `theme-grounds.js` and `theme-props.js` (about 405 lines each) into kit, grounds and pets modules before the fixes grow them past 500 lines (default). The alternative keeps the current files, accepting that some will pass 500 lines.
7. Elevator doors (Task 6): one shared change in `floor.js` that telescopes the door leaves inside their frames (default). The alternative keeps the sliding leaves and widens frames per theme. Task 6 also changes `agent.js`, because in palace and starship the leave target sits behind the position clamp and departing agents never despawn (xcut-m01).
8. Research globe (Task 12): keep the large studio and office globes and widen their collision boxes (default, changes `obstaclesOf`). The alternative shrinks the globe and raises it on a thinner pedestal.
9. Office lounge (Task 22): a west-facing sofa at the east end with its own collision box (default). The alternative keeps the sofa in place and makes the adjacent partitions glass.
10. Dev-room black box (Task 21): replace it with a printer moved 0.65 m into the room (default). The alternative is a PC tower under the west dev desk.
11. Optional work: which P2 tasks (20-27) to do, whether to do the facade cutaway (Task 28) or only limit camera rotation, and whether to promote `$AUDIT/tools` to `scripts/` (Task 29).
12. Evidence folder: keep all of `$AUDIT` (3.3 MB, including 2.1 MB of reference JPEGs and the 428 KB audit JSON) in the repository, or keep only `tools/` and `audit/REPORT.txt`.

---

## Findings Summary

Severity is the verified one; where merging changed it, the note says why. "T" is the owning task.

| id | theme(s) | sev | title | T |
|---|---|---|---|---|
| studio-01 | studio | P0 | NW corner notch open to the sky; wall ends overhang fillet | 14 |
| studio-02 | studio, office | P0 | Research dish renders as a crescent on a pole | 14 |
| studio-03 | studio, office, starship, dogs, cats | P1 | Open elevator doors slide off the frame | 6 |
| studio-04 | studio, office | P1 | Agents' heads enter the research globe | 12 |
| studio-05 | studio | P2 | Glass partitions cast opaque shadows | 20 |
| studio-06 | studio | P1 | Balcony pod oak top coplanar with slab (z-fight) | 14 |
| studio-07 | studio, office | P2 | Dev tower and desk plant have no collision box; sofa arms outside box | 21, 22 |
| studio-08 | studio, office | P2 | Archive cabinet and dev tower are blank cubes | 21 |
| studio-09 | studio, office | P2 | Props flush with rail read as clipped (recategorised: readability) | 21 |
| studio-m01 | studio, office | P2 | x=+-4 glass dividers have no cap rail | 20 |
| studio-m02 | studio, office | P2 | Dead `buildLounge` second elevator | 6 |
| office-01 | office, studio | P1 | Open elevator reads as two loose pillars | 6 |
| office-02 | office, studio | P1 | Globe overhangs its collision box (head clipping) | 12 |
| office-03 | office, studio | P0 | Dish reads as a scythe (audit P2; merged with studio-02, visible at default camera) | 14 |
| office-04 | office, studio | P2 | Lounge sofa hidden behind partition | 22 |
| office-05 | office, studio | P2 | Featureless cabinet; dev box without collision | 21 |
| office-06 | office | P2 | Bare west terrace and SE ledge | 21 |
| office-07 | office, studio | P2 | Whiteboard back reads as a dark monolith | 21 |
| office-08 | office, studio | P2 | Plants and mast without collision boxes (latent) | 21 |
| office-09 | office | P2 | Divider caps (a), NW notch (b), edge sliver (c) | 20 (a), 21 (b, c) |
| office-m01 | all 7 | P1 | Doors never open on departure | 6 |
| office-m02 | office, studio | P2 | Dead `buildLounge` | 6 |
| office-m03 | office, studio | P2 | Lounge slots are a bare standing row | 22 |
| palace-01 | palace, hanok, starship | P0 | Roofs render as sheared blades and kites | 5 (starship part: 25) |
| palace-02 | palace | P0 | Pond water coplanar with granite rim | 15 |
| palace-03 | palace, hanok | P1 | Raised maru floors sink agents' feet | 9 |
| palace-04 | palace | P1 | Agents walk through the armillary rings | 12 |
| palace-05 | palace | P2 | North pillar clips middle bookshelf | 23 |
| palace-06 | palace | P2 | South step cantilevers over the void | 23 |
| palace-07 | palace | P2 | Pillars and floor sheet overhang the upper slab | 23 |
| palace-08 | palace | P2 | Gate leaves slide through posts; sit on spawn | 6 (resolved by telescoping + spawn move) |
| palace-09 | palace + 4 | P1 | Scroll screens vanish from behind; float 0.04 (audit P2; merged into xcut-08) | 11 |
| palace-10 | palace | P2 | Perimeter reads as stray posts (recategorised: identity, not collision) | 23 |
| palace-m01 | palace | P2 | Lounge bench hidden behind SE partition | 22 |
| palace-m02 | palace | P2 | Meeting room nearly empty | 23 |
| palace-m03 | palace | P2 | Palace obstacles are pinned indirectly by browser-names | Global Constraints, 2 |
| hanok-01 | hanok, palace | P0 | roofEave shears hanok roofs | 5 |
| hanok-02 | hanok | P1 | Orphan pavilion post | 16 |
| hanok-03 | hanok, palace | P1 | Raised maru floors sink feet | 9 |
| hanok-04 | hanok | P1 | Eight invisible corridor walls | 8 |
| hanok-05 | hanok, palace | P1 | Gate leaves slide through posts | 6 |
| hanok-06 | hanok, palace | P1 | Scroll screens vanish from behind | 11 |
| hanok-07 | hanok | P1 | Pavilion railings float past the maru edge | 16 |
| hanok-08 | hanok | P2 | Hanji partitions float over the courtyard (latent until floors drop) | 9 |
| hanok-09 | hanok | P2 | Eave trim cuts shelf tops and chimneys | 24 |
| hanok-10 | hanok | P2 | Globe ring sweeps through pedestal | 24 |
| hanok-11 | hanok | P2 | North wall overhangs; reads as blank plaster | 24 |
| hanok-12 | hanok | P2 | Latent plinth/slab coplanar tops | 24 |
| hanok-13 | hanok | P1 | Quench barrel outside the server-desk box | 16 |
| hanok-14 | hanok | P2 | Comments promise unbuilt lantern and well | 24, 27 |
| hanok-m01 | hanok | P2 | Meeting table top fuses with the maru | 24 |
| hanok-m02 | hanok | P1 | Globe ring wider than its box (audit P2; re-rated to match palace-04, same class) | 12 |
| starship-01 | starship | P0 | Hull notches: elevator, entrance path and bench over the void | 7 |
| starship-02 | starship | P1 | Airlock doors hang in space when open | 6 (telescoping; pockets superseded) |
| starship-03 | starship | P1 | Engine-core LEDs enclosed in the columns | 17 |
| starship-04 | starship | P1 | Warp-core disc and torus in the walk lanes | 10 |
| starship-05 | starship | P1 | Invisible corridor walls | 8 |
| starship-06 | starship + 4 | P1 | Hologram screens vanish from behind; frames float | 11 |
| starship-07 | starship | P2 | Thrusters read as wheels; archive nozzle detached | 25 |
| starship-08 | starship | P2 | OCT hull rotated after non-uniform scale | 25 |
| starship-09 | starship, studio | P2 | Deck edges show as seams through rugs | 25 |
| starship-10 | starship | P2 | Crystal plinths overhang and crowd slots | 25 |
| starship-m01 | starship | P2 | Force-field dividers overhang hull ends | 25 |
| dogs-01 | dogs | P0 | Gate floats outside the bone footprint; spawn inside frame | 6, 7 |
| dogs-02 | dogs | P0 | Cabinet stripes z-fight (z-fight is P1 on the scale; kept P0: visible on 3 objects at the default camera) | 18 |
| dogs-03 | dogs | P1 | Fence runs through cabinets and racks | 18 |
| dogs-04 | dogs + 4 | P1 | Desk monitors vanish from behind | 11 |
| dogs-05 | dogs | P1 | Plaza rim and lawn disc in the ring lanes | 10 |
| dogs-06 | dogs, cats | P1 | Invisible corridor walls, short dividers, missing bench | 8 (rails, bench), 18 (dividers) |
| dogs-07 | dogs | P1 | Tennis-ball globe floats 0.145 | 18 |
| dogs-08 | dogs, cats, starship | P1 | Gate leaves slide out of the frame | 6 |
| dogs-09 | dogs | P2 | NE pine jammed against rack 4 | 26 |
| dogs-10 | dogs | P2 | Lawn seam lines at lobe junctions | 26 |
| dogs-11 | dogs | P2 | Reachable floorless strip east of the lounge | 26 |
| dogs-m01 | dogs | P2 | Tennis ball reads as a ringed planet | 26 |
| cats-01 | cats | P0 | SW and SE room corners have no floor | 19 |
| cats-02 | cats | P1 | Ear sunrooms are pyramids; notches under props | 19 |
| cats-03 | cats | P1 | Invisible corridor walls; dividers 0.9 short | 8 (rails), 19 (dividers) |
| cats-04 | cats | P2 | Lounge-sofa box has no geometry (verifier recategorised to identity: no route reaches it) | 8 |
| cats-05 | cats | P1 | Spawn inside frame; doors hang in air | 6 (wings superseded) |
| cats-06 | cats | P1 | Cat tower base and pads in the ring lanes | 10 |
| cats-07 | cats + 4 | P1 | Scroll screens vanish from behind | 11 |
| cats-08 | cats | P2 | Face slab is a visibly faceted 16-gon | 19 (subsumed by outline) |
| cats-m01 | cats | P2 | Yarn globe floats 0.12 over pedestal | 26 |
| cats-m02 | cats | P2 | Stacked floor primitives leave seams | 19 |
| xcut-01 | palace, hanok | P0 | roofEave shear (all 7 eaves/gates); palace eaves over north rooms | 5 |
| xcut-02 | starship, dogs, cats | P0 | Spawn and frame authored separately; spawn over void or inside frame | 6, 7 |
| xcut-03 | starship | P2 | `cyl()` rotY after non-uniform scale (OCT hull) | 25; guard as harness `shear` (2) |
| xcut-04 | all 7 | P1 | One slide distance overshoots every frame and gate | 6 |
| xcut-05 | open themes | P1 | Shared part/div/lounge boxes without geometry | 8, 18, 19 |
| xcut-06 | starship, dogs, cats | P1 | Centre features reach the walk lanes | 10 |
| xcut-07 | palace, hanok | P1 | Raised room floors | 9 |
| xcut-08 | 5 prop themes | P1 | scrollScreen single-sided with no back | 11 |
| xcut-09 | starship, cats, dogs | P0 | Rectangle anchors hang off non-rectangular footprints (re-rated to P0 by its verifier: visible at the default camera) | 7 (starship via gangway), 19 (cats via outline) |
| xcut-10 | studio, office, hanok, palace | P2 | North/west facades hide rooms from NE/NW | 28 |
| xcut-11 | all | P2 | Per-build geometry allocation; no dispose | 13 |
| xcut-12 | studio, office, palace, hanok | P2 | Math.random layouts | 3 |
| xcut-13 | studio, starship, hanok | P2 | Transparent panes cast shadows, write depth | 20 |
| xcut-15 | studio, office | P2 | Dead `buildLounge` | 6 |
| xcut-m01 | palace, starship | P0 | Leaving agents never despawn (target behind clamp) | 6 |
| xcut-m02 | palace, studio, hanok, starship | P1 | Coplanar tops from bottom-at-y arithmetic | 2 (check), 14, 15, 24 |
| xcut-m03 | all 7 | P1 | Agents vanish in front of closed doors (audit P2; merged with office-m01) | 6 |
| xcut-m04 | studio, office, palace, hanok | P2 | `userData.blink` lamps never blink | 20 |

**Refuted (kept visible):**
- xcut-14: sign anchors inside the fixed gate roofs. Signs are CSS2D DOM labels with no depth test, so there is no rendering consequence.

**Superseded proposals (the finding is still fixed, by the task shown):**
- Frame widening (studio-03 depth 3.4, office-01 frameW 3.6, dogs-08 depth 3.7), starship-02 door pockets and cats-05 wing panels: superseded by telescoping leaves (Task 6).
- palace-08 leaf move to x -12.12: unnecessary after telescoping plus the palace spawn move to -11.45 (Task 6).
- dogs-01 frame move to x -11.9 with a 1.5-wide apron: replaced by xcut-02's spawn -10.8 plus a pad under the existing frame (Tasks 6, 7).
- xcut-09 starship bench move: replaced by starship-01 gangways (Task 7). xcut-09 cats anchor moves and cheek lobes: replaced by the merged outline (Task 19); cheek lobes stay the documented fallback.
- cats-02 tinted DIAMOND ear layer and cats-01 tinted paw pad: rejected by their verifiers (render over the face floor, seams); merged outline instead.
- studio-08 "lower the dev tower to 0.6", studio-09 sofa-back lowering and lounge plant to z 1.25, office-07 full body recolour, palace-04 instrument shrink as primary, xcut-05 redrawing `div-*` boxes, xcut-03 runtime `console.warn`, xcut-06 dogs basin rz 0.95, xcut-07 thickness numbers (palace-03/hanok-03 numbers used): rejected or replaced as noted in the tasks.
- studio-02's quaternion dish orientation: replaced by office-03's verified two-angle version (Task 14).
- studio-04 Fix A (shrink and raise the globe): alternative to the box widening (open question).

**Unaudited (follow-up, not fixed here):** harness check `globe` will also evaluate dogs, cats and starship research globes, which no auditor examined; their failures are recorded in KNOWN with `// triage: unaudited` and filed as a follow-up issue.

---

## File Structure

| File | Status | Responsibility after this plan | Est. lines |
|---|---|---|---|
| `public/js/theme-kit.js` | create (Task 4) | `themeMats` (moved, plus new cached materials), shared geometry constants (`ROOF4`, `CYL32`, `CYL48`, `DIAMOND4`, `HALF_SPHERE`), `cyl`, `roofEave`, `pineTree`, `buildStandardPartitions`, `buildElevatorDoors`, `buildCorridorRails` + `RAIL_STYLES`, `lowTable`, `scrollScreen`, `boardFrame`, `populateShelves` | 300 |
| `public/js/theme-grounds.js` | modify | `buildThemeGround` dispatcher; studio, office, palace, hanok grounds; re-exports `themeMats` | 330 |
| `public/js/theme-grounds-ext.js` | create (Task 4) | starship, dogs, cats grounds | 330 |
| `public/js/theme-props.js` | modify | palace, hanok, starship props; re-exports dogs/cats props | 330 |
| `public/js/theme-props-pets.js` | create (Task 4) | dogs, cats props | 180 |
| `public/js/theme-geometry.js` | create (Task 6) | pure (no three): `doorLeafPose`, `catOutline`, `facadeVisible` | 120 |
| `public/js/rng.js` | create (Task 3) | pure `mulberry32`, `seedOf` | 25 |
| `public/js/theme-layouts.js` | modify | elevator `frameX`/`kind`; keyed research-globe and lounge-sofa tables; studio/office extra boxes | 290 |
| `public/js/furniture.js` | modify | hoisted geometries, `metalDS`, `wire` material, dish/printer/cabinet, delete `buildLounge` | 290 |
| `public/js/floor.js` | modify | door pose, InstancedMesh dispose, blinkers | 225 |
| `public/js/agent.js` | modify | open doors on departure | +4 |
| `test/fixtures/three-record.mjs` | create (Task 1) | recording three.js subset with geometry sampling and counters | 450 |
| `test/fixtures/three-addons-stub.mjs` | create (Task 1) | no-op `CSS2DObject`, `CSS2DRenderer`, `OrbitControls` | 20 |
| `test/fixtures/load-three-record.mjs` | create (Task 1) | resolve hook, DOM stubs, `buildTheme(theme)` | 120 |
| `test/fixtures/geom-utils.mjs` | create (Task 2) | convex hull, point-in-polygon, polygon-union membership, polyline sampling | 120 |
| `test/fixtures/theme-known.mjs` | create (Task 2) | ratcheting `KNOWN` allowlist | 60 |
| `test/fixtures/theme-snapshot.mjs` | create (Task 1) | CLI printing a sorted per-theme mesh snapshot for refactor diffs | 50 |
| `test/theme-build.test.mjs` | create (Tasks 1-2) | builds all 7 themes; geometry invariants | 450 |
| `test/theme-layout-invariants.test.mjs` | create (Task 2) | pure layout invariants (bounds, spawn vs frame, ring lanes, new tags) | 120 |
| `test/theme-geometry.test.mjs` | create (Task 6) | `doorLeafPose`, `catOutline`, `facadeVisible` | 120 |
| `test/rng.test.mjs` | create (Task 3) | RNG determinism | 30 |
| `scripts/audit-themes.py` | optional (Task 29) | committed browser audit runner (not shipped: `package.json files` lists only `scripts/install-skill.mjs`) | 300 |

Why: the split keeps every file under 500 lines while the fixes add geometry; all new browser modules stay flat in `public/js/` because `test/page-approval-office.test.mjs:15-20` scans that directory non-recursively for `THREE.X` names; `theme-kit.js` never imports `theme-grounds*.js` or `theme-props*.js` (no cycles); the pure modules (`theme-geometry.js`, `rng.js`) carry the invariants node can check without three.

---

## Phase A: Verification

### Task 1: Recording three.js stub and theme snapshot

**Files:**
- Create: `test/fixtures/three-record.mjs`, `test/fixtures/three-addons-stub.mjs`, `test/fixtures/load-three-record.mjs`, `test/fixtures/theme-snapshot.mjs`, `test/theme-build.test.mjs`
- Read for reuse: `test/page-approval-office.test.mjs:12-36` (resolve hook, name scan), `:329-334` (document/getComputedStyle stubs); `public/js/floor.js:63-89` (`rebuildTheme`)

**Interfaces:**
- Consumes: real `Floor.prototype.rebuildTheme`, called with a fake `this` = `{ archGroup: new Group(), board: { material: new MeshStandardMaterial() }, setShadows() {}, refreshSigns() {}, shadows: true }`, so theme dispatch stays single-sourced in floor.js.
- Produces: `buildTheme(theme) -> { root, doors, leds, globe, meshes, stats }`. Each mesh record: `{ kind: 'Mesh' | 'InstancedMesh' | 'LineSegments', geom: { type, params, baked }, mat: { color, transparent, opacity, emissive, side, depthWrite, polygonOffset }, castShadow, samples (world [x,y,z][]), aabb, top, bottom, outline (XZ convex hull; ExtrudeGeometry keeps its shape polygon), flatTop (Box, Cylinder with radiusTop > 0, Extrude), inGlobe, path }`. `stats = { geometries, materials, randomCalls, disposed }`.
- Stub surface: Object3D/Group/Mesh/InstancedMesh (`setMatrixAt`, `setColorAt`, `dispose`)/LineSegments with position/scale (`set`, `copy`, `setScalar`, `add`, `clone`, `multiplyScalar`), rotation (Euler XYZ), quaternion (`setFromUnitVectors`, `setFromEuler`), `lookAt`, `add`/`remove`/`clear`/`traverse`/`children`/`userData`, world matrix T*R*S through the parent chain; Vector2/Vector3/Matrix4 (`makeScale`, `setPosition`, `compose`, `multiply`)/Color/Quaternion/Euler; BoxGeometry, PlaneGeometry, CylinderGeometry, ConeGeometry, SphereGeometry, IcosahedronGeometry, TorusGeometry, WireframeGeometry, ExtrudeGeometry, Shape with `parameters` and sampled vertices (Cylinder vertex k at theta = thetaStart + k/n * thetaLength, x = r sin(theta), z = r cos(theta), as three does; Icosahedron detail 0 = 12 vertices, detail 1+ adds normalised edge midpoints; Torus and Sphere sampled grids; Extrude = shape points at 0 and depth), and `rotateX`/`rotateY`/`rotateZ`/`translate`/`scale` baking into samples; materials store params and `clone`; `DoubleSide`, `FrontSide` constants. Every geometry/material constructor increments `stats`. `load-three-record.mjs` serves `'three'` as a generated wrapper that re-exports `three-record.mjs` and adds the page-approval Proxy no-op for every other `THREE.X` name found by the same scan, and serves `'three/*'` from `three-addons-stub.mjs`. It also wraps `Math.random` during `buildTheme` to count calls.

- [ ] **Step 1: Write the failing tests** in `test/theme-build.test.mjs`. Only build-level facts are committed (mesh counts change in later tasks):
  ```js
  // 스텁 자체 검증: T*R*S 합성 (비균일 스케일 후 회전)
  const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), mat);
  m.scale.set(11.2, 0.52, 8.6); m.rotation.y = Math.PI / 8; root.add(m);
  assert.ok(recordOf(m).samples.some(([x, , z]) => Math.abs(x - 10.348) < 1e-3 && Math.abs(z + 4.286) < 1e-3));
  for (const t of ['studio', 'office', 'palace', 'hanok', 'starship', 'dogs', 'cats']) {
    const b = buildTheme(t);
    assert.equal(b.doors.length, 2, t);
    assert.ok(b.meshes.length > 100 && b.globe && b.leds.length > 0, t);
  }
  ```
  (`root`, `mat` and `recordOf` come from `load-three-record.mjs`.)
  Run `node --test test/theme-build.test.mjs`. Expected: FAIL (fixture modules missing).
- [ ] **Step 2: Implement** the four fixture modules. Keep `three-record.mjs` at or below 450 lines.
- [ ] **Step 3: Fidelity cross-check (one-off, not committed).** Mesh counts (isMesh, LineSegments excluded) must equal the analyzer's: studio 273, office 245, palace 190, hanok 157, starship 152, dogs 170, cats 144 (REPORT.txt headers); the studio north wall record must have aabb min [-11.6, 0, -8.21], max [11.6, 2.7, -7.99]; and per theme the multiset of `(geom type, colour hex)` must equal `$AUDIT/audit/geometry-<theme>.json` (`meshes[].geom`, `meshes[].color`). If anything differs, fix the stub, never the expectations.
- [ ] **Step 4: Snapshot CLI.** `node test/fixtures/theme-snapshot.mjs > $OUT/snap_T1.txt` prints one sorted line per mesh: `<theme> <kind> <type>(<params, 3 dp>) #<color> min=[..] max=[..]` (2 dp; InstancedMesh prints its instance count only).
- [ ] **Step 5: Verify.** `npm test` -> 1299 existing + new tests pass.
- [ ] **Step 6: Commit** `test(themes): add recording three.js stub that builds every room theme in node`.

### Task 2: Geometry invariant suite with a ratcheting allowlist

**Files:**
- Create: `test/fixtures/geom-utils.mjs`, `test/fixtures/theme-known.mjs`, `test/theme-layout-invariants.test.mjs`
- Modify: `test/theme-build.test.mjs`

**Interfaces:**
- Consumes: `buildTheme`; `obstaclesOf`, `layoutOf`, `THEME_LAYOUTS` (theme-layouts.js); `route`, `AGENT_RADIUS`, `LANES` (placement.js).
- Produces: `KNOWN` map `{ '<check>:<theme>': count }`. Each check asserts `failures.length === (KNOWN[key] ?? 0)` and prints offending mesh paths and coordinates on mismatch. Later tasks lower counts first (red), then fix (green).

| check | rule (tolerances) | expected today (record exact first-run counts) |
|---|---|---|
| `shear` | Cylinder/Cone with radialSegments in {4, 6, 8}, not baked, abs(scale.x - scale.z) > 1e-6 and rotation.y not a multiple of PI/2 | palace 4, hanok 3, starship 2 |
| `hidden` | opaque mesh whose samples all lie within another opaque mesh's solid (+-1e-3) | starship 20 (engine LEDs), dogs 12 (stripes, fence posts) |
| `support` | inside the union of ground outlines (bottom <= 0.001, top in [-0.02, 0.2], XZ area >= 0.5) within 0.05: each slot centre plus 8 points at r 0.24, each door `(x, inner)`, the elevator spawn, and bottom samples of standing meshes (bottom in [-0.05, 0.12], top > 0.12, not in the globe) | starship (frame, 2 leaves, spawn, bench east legs), dogs (frame, 2 leaves, spawn), cats (research tables, desk-table corner, bell, research slots 1 and 3), studio (north and west wall ends at the fillets) |
| `floorTop` | max top of ground-like meshes (bottom <= 0.2, top <= 0.3) under each slot centre <= 0.06 | palace 29, hanok 29 |
| `ringClear` | ring themes: no mesh with top > 0.08 has samples with x in [obstacle.x0, obstacle.x1] and abs(z) in [abs(zRing) - 0.375, abs(zRing) + 0.375] (palace pond coping at 1.05 stays outside 1.075) | starship 3, dogs 2, cats 4 |
| `coverage` | per `part-*` box: >= 60% of centreline samples (step 0.05, only samples over ground) lie under a mesh with top >= 0.3 overlapping the box; per `div-*` >= 85%; `lounge-sofa` >= 60% of its area | part: hanok 8, starship 8, dogs 8, cats 8; div: dogs 4, cats 4; lounge-sofa: dogs 1, cats 1 |
| `globe` | c = globe world origin; R = max distance from c to samples of solid (non-LineSegments) descendants; dMin = distance from the axis to the `research-globe` box boundary + 0.18 (findSafePath radius); require `hypot(dMin, c.y - 1.44) >= R + 0.31` (head sphere r 0.31 at y 1.44, agent-mesh.js:9 and :333) | studio 1, office 1, palace 1, hanok 1; dogs/cats/starship recorded as `// triage: unaudited` |
| `routeClear` | standing solid meshes (top >= 0.5, bottom <= 0.3, opaque, not elevator frame/leaves, not in globe) keep >= 0.24 from route samples (step 0.1) of: spawn -> every slot, door inner -> every slot of its room, every slot -> every slot of other rooms, lanes -0.7/0/0.7; samples inside an obstacle box are exempt | hanok 1 (quench barrel); record others |
| `alloc` | a second `buildTheme(t)` constructs 0 geometries and 0 materials | studio 11, office 11 |
| `random` | `buildTheme` makes no `Math.random` call (one failure entry per offending theme) | studio 1, office 1, palace 1, hanok 1 |
| `screenBack` | every PlaneGeometry using a screen or board material has an opaque box within 0.06 behind it (its local -z) covering >= 90% of its area | palace, hanok, starship, dogs, cats (record) |
| `coplanar` | two meshes of different materials with flat tops within 0.003 in y overlapping > 0.0025 m2 in XZ | palace 1 (pond), studio 2 (bay pods), hanok 1 (plinth); record others |

Pure checks in `test/theme-layout-invariants.test.mjs`: `bounds` (every slot, door `(x, inner)` and `elevator.x` within abs(x) <= 11.6 and abs(z) <= 7.6; KNOWN palace 1, starship 1) and `ringLanes` (ring themes: `abs(zNorth) + 0.375 <= 1.88` and `abs(zNorth) - 0.375 >= 0.92`; passes today, guards later edits).

Thresholds: every comparison in the table has 1e-6 slack in the lenient direction (for example `top <= 0.06 + 1e-6`, because 0.03 + 0.015 + 0.015 is 0.060000000000000005 in JS). `random` returns one failure entry per theme whose build calls `Math.random` at all (not the call count), so its KNOWN value is 1.

- [ ] **Step 1: Write the checks** with an empty `KNOWN`; run `node --test test/theme-build.test.mjs test/theme-layout-invariants.test.mjs`. Expected: FAIL with the failures in the table.
- [ ] **Step 2: Populate `KNOWN`** from the run. Any entry not explained by the table gets `// triage: <one line>` and is listed in the PR description; do not fix anything here.
- [ ] **Step 3: Sanity check:** set `KNOWN['shear:palace'] = 0`; the test must fail naming the 4 `roofEave` meshes (theme-grounds.js:188-190, :209); revert.
- [ ] **Step 4: Verify** `npm test` green.
- [ ] **Step 5: Commit** `test(themes): pin geometry invariants with a ratcheting known-failure list`.

### Task 3: Seeded RNG for procedural props (xcut-12)

**Files:**
- Create: `public/js/rng.js`, `test/rng.test.mjs`
- Modify: `public/js/theme-props.js:49-73` (`populateShelves`), `public/js/furniture.js:112-140` (`buildArchive`), `:44-73` (`screenMat`)

**Interfaces:** Produces `mulberry32(seed) -> () => [0, 1)` and `seedOf(str) -> uint32` (FNV-1a). `populateShelves(g, shelfMat, palette, xs, { z = -7.4, y0 = 0.08, rng } = {})`; the options object replaces the 5th positional `z` (palace :80 and hanok :153 pass 4 arguments, so no caller changes). `y0` is unused until Task 9 (default keeps today's 0.08).

- [ ] **Step 1: Failing tests.** `test/rng.test.mjs`: two `mulberry32(seedOf('shelves'))` streams give equal first 10 values, all in [0, 1); `seedOf('a') !== seedOf('b')`. In `theme-known.mjs` delete all `random:*` entries. Run -> FAIL.
- [ ] **Step 2: Implement** `mulberry32` as in the xcut improvement sketch. Default seeds: shelves `seedOf(\`shelves:${xs.join()}:${z}\`)`, archive `seedOf('archive')`, screens `seedOf(\`screen:${kind}\`)`. Leave the Floor.update LED flicker random (animation only).
- [ ] **Step 3: Verify** `npm test` green; `node test/fixtures/theme-snapshot.mjs` differs from `snap_T1.txt` only in InstancedMesh counts.
- [ ] **Step 4: Commit** `fix(themes): seed procedural bookshelves and screens so builds are reproducible`.

### Task 4: Split the theme modules (pure refactor)

**Files:**
- Create: `public/js/theme-kit.js`, `public/js/theme-grounds-ext.js`, `public/js/theme-props-pets.js`
- Modify: `public/js/theme-grounds.js`, `public/js/theme-props.js`

**Interfaces:** export surface unchanged for floor.js and tests (`buildThemeGround`, `themeMats` from theme-grounds.js; `build*Props` from theme-props.js).

**Moves (verbatim):**
- To `theme-kit.js`: `themeMats` (theme-grounds.js:14-50), `cyl` (:52-61), `roofEave` (:63-71), `pineTree` (:73-82), `buildStandardPartitions` (:141-159), `buildElevatorDoors` (:398-403); from theme-props.js `lowTable` (:14-19), `scrollScreen` (:21-32), `boardFrame` (:34-47), `populateShelves` (:49-73). Each module keeps its own module-level geometry constants (grounds `CYL` is 16-segment, props `CYL` is 14-segment; do not merge them).
- To `theme-grounds-ext.js`: `buildStarshipGround` (:267-317), `buildDogsGround` (:320-359), `buildCatsGround` (:362-396), exported and imported by the dispatcher.
- To `theme-props-pets.js`: `buildDogsProps` (about :295-348), `buildCatsProps` (:351-409); `theme-props.js` re-exports both.
- `theme-grounds.js` keeps `buildThemeGround`, studio/office/palace/hanok grounds, and adds `export { themeMats } from './theme-kit.js'`. `theme-kit.js` imports only three, scene.js, furniture.js, rng.js, theme-layouts.js.

- [ ] **Step 1:** `node test/fixtures/theme-snapshot.mjs > $OUT/snap_T4_before.txt`.
- [ ] **Step 2:** Move the code.
- [ ] **Step 3: Verify** snapshot after equals before (`diff` empty); `npm test` green (page-approval-office scan covers the new flat files); `wc -l` shows every theme file below 330.
- [ ] **Step 4: Commit** `refactor(themes): split theme builders into kit, grounds and props modules`.

---

## Phase B: Shared root causes

### Task 5: Bake the hip-roof rotation (palace-01, hanok-01, xcut-01) - P0

**Files:** `theme-kit.js` (`roofEave`, add `ROOF4`); `theme-grounds.js` palace :188-190.

**Interfaces:** `roofEave(g, mat, trimMat, w, h, d, x, y, z)` unchanged; footprint becomes 1.046 w x 1.046 d (about 2% over the trim).

- [ ] **Step 1: Ratchet** `shear:palace` 4 -> 0 and `shear:hanok` 3 -> 0. Run -> FAIL.
- [ ] **Step 2: Change.** `const ROOF4 = new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4);` (new constant; `CONE4` untouched); `roofEave` uses `ROOF4`, keeps `scale.set(w * 0.74, h, d * 0.74)`, deletes `roof.rotation.y = Math.PI / 4`. Pull palace north eaves back to the colonnade line (xcut-01): :188 -> `roofEave(g, tm.tile, tm.dancheong, 9.2, 0.95, 1.3, 0, 2.45, -8.15)`; :189/:190 -> `roofEave(g, tm.tile, tm.dancheong, 8.2, 0.72, 1.0, -8, 2.3, -7.95)` and the same with x = 8. Trims span z -8.75..-7.55 and -8.4..-7.5 and still cap the z = -7.8 pillars; the wing roof surface over the x = +-11.6 pillar tops is at y 2.576 > 2.5.
- [ ] **Step 3: Verify.** `npm test` green. Renders palace and hanok `iso_se iso_nw iso_ne entrance`: hip roofs, no diagonal blades or kites (reference `$AUDIT/reference/hanok-EXPERIMENT_roof_fixed_iso_se.jpg`, `$AUDIT/reference/palace-audit_roofshrink_iso_se.jpg`); palace pillar tops hidden; from `iso_ne` the palace wings cover only the shelf line (`$AUDIT/reference/palace-audit_roofshrink_iso_ne.jpg`). Analyzer: `roofEave` hits reduce to cone-on-trim contact (no cone crossing other meshes). Hanok long north eave reads as a low pyramid band (ridge style is an open question).
- [ ] **Step 4: Commit** `fix(themes): bake hip-roof rotation so palace and hanok eaves stop shearing`.

### Task 6: Elevator and gate system (xcut-02, xcut-m01, xcut-04, studio-03, office-01, starship-02, dogs-08, cats-05, hanok-05, palace-08, office-m01, xcut-m03, studio-m02, office-m02, xcut-15) - P0/P1

**Files:**
- Modify: `theme-layouts.js:46-136` (elevator and `doors.lounge` per theme); `floor.js:195-199` (`update`); `theme-kit.js` (`buildElevatorDoors`); `theme-grounds.js` studio :118, office :138, palace :210-211, hanok :261-262; `theme-grounds-ext.js` starship :316, dogs :358, cats :395; `agent.js` `update` (about :436-460) and `onArrive` `'leave'` (:319-321); `furniture.js:258-267` (delete `buildLounge`)
- Create: `public/js/theme-geometry.js`, `test/theme-geometry.test.mjs`
- Modify tests: `test/theme-layout-invariants.test.mjs`, `test/fixtures/theme-known.mjs`

**Interfaces:**
- Produces: `THEME_LAYOUTS[t].elevator = { x, z, frameX, kind: 'portal' | 'gate' }` (`ELEVATOR` receives the extra keys through `Object.assign` in rooms.js:242, harmless); pure `doorLeafPose(open) -> { inner, len, centre }` with `inner = 0.035 + 0.73 * open`, `len = 0.885 - inner`, `centre = inner + len / 2`.
- Consumes: builders call `buildElevatorDoors(g, frameMat, doorMat, layoutOf(theme).elevator.frameX, 0)` (signature unchanged); palace and hanok place their gate leaves at `frameX`.

| theme | elevator.x | frameX | kind | doors.lounge |
|---|---|---|---|---|
| studio, office | -11.2 | -11.82 | portal | unchanged |
| palace | -11.45 (was -11.8) | -11.85 (leaf x) | gate | `{ x: -11.45, z: 0, inner: 0, sign: [-12.1, 3.1, 0] }` |
| hanok | -11.6 (pinned) | -11.95 (leaf x, was -11.7) | gate | unchanged |
| starship | -11.2 (was -11.8) | -11.82 | portal | `{ x: -11.2, z: 0, inner: 0, sign: [-12.1, 3.0, 0] }` |
| dogs, cats | -10.8 (was -11.4) | -11.42 | portal | `{ x: -10.8, z: 0, inner: 0, sign: [-11.8, 3.0, 0] }` |

- [ ] **Step 1: Failing tests.**
  - `theme-layout-invariants.test.mjs`: set `bounds` KNOWN to 0; add `for (const t of THEMES) { const e = THEME_LAYOUTS[t].elevator; assert.ok(e.x >= -11.6); assert.ok(e.kind === 'portal' ? e.x >= e.frameX + 0.62 - 1e-9 : e.x >= e.frameX + 0.29 - 1e-9, t); }` (portal: frame half 0.175 + leaf front 0.045 + radius 0.24 + 0.16 margin, equality for studio; gate: leaf half 0.05 + radius 0.24).
  - `theme-geometry.test.mjs`: `doorLeafPose(0)` gives inner 0.035, len 0.85, centre 0.46 (today's closed pose); `doorLeafPose(1)` gives inner 0.765; for open in 0..1 step 0.1, `inner + len === 0.885` (1e-9).
  - Run -> FAIL.
- [ ] **Step 2: Data** per the table.
- [ ] **Step 3: Door kinematics.** In `Floor.update` replace `const o = 0.46 + this.doorOpen * 0.78; ...` with `const p = doorLeafPose(this.doorOpen); for (const [i, s] of [[0, -1], [1, 1]]) { const d = this.doors[i]; d.scale.z = p.len; d.position.z = s * p.centre; }` (elevator z is 0 in every theme; `box()` meshes use the unit BOX, so `scale.z` is the leaf length). Leaves never pass abs(z) 0.885: inside every frame (1.1) and gate post (1.0 / 1.03).
- [ ] **Step 4: Recess.** In `buildElevatorDoors` add `box(g, mats().dark, 0.02, 2.06, 1.76, x + 0.19, 0, z, false)` (x+0.18..x+0.20, abs(z) <= 0.88, top 2.06 below the 2.1 leaf tops; hidden by closed leaves, shows a dark seam when closed and a dark cab when open). Gates get no recess.
- [ ] **Step 5: Departure.** In `Agent.update`, after movement: `if (this.current?.kind === 'leave' && Math.hypot(pos.x - ELEVATOR.x, pos.z - ELEVATOR.z) < 2.5) this.floor.openElevator?.();` and in `onArrive` case `'leave'` call `this.floor.openElevator?.()` before `this.office.removeAgent(this)`.
- [ ] **Step 6:** Delete `buildLounge` (furniture.js:258-267; no importers).
- [ ] **Step 7: Verify.** `npm test` green, including browser-names `:353-370` (new lounge doors route to every lounge slot) and `:187`. Harness: `support` counts for starship and dogs may change (spawn still over void until Task 7); update KNOWN with a note. Browser: `OFFICE_SIM_URL=http://localhost:4319/ python3 -I $AUDIT/tools/leave_probe3.py 0.0166 studio office palace hanok starship dogs cats` and again with `0.0333`: every line `"removed": true` (palace and starship were `false` before). Renders with `$AUDIT/tools/doors_hold_open.js`, views `entrance iso_se`, all 7 themes: leaves stay inside frames or between gate posts, dark cab visible in portal themes, nothing hangs beside a frame; with patch `-` the closed doors show only a thin dark seam.
- [ ] **Step 8: Commit** `fix(themes): keep elevator spawns reachable and doors inside their frames`.

### Task 7: Entrance footprints (starship-01, dogs-01, xcut-02 pad, xcut-09 starship bench) - P0

**Files:** `theme-grounds-ext.js` `buildStarshipGround` (after :275), `buildDogsGround` (after :329).

**Interfaces:** geometry only; consumes Task 6 spawn and `frameX` values; no exported signature or layout change.

- [ ] **Step 1: Ratchet** `support:starship` down to its residual (expected 3: the two force-field ends of starship-m01 and the starship-10 plinth, fixed in Task 25) and `support:dogs` down to its residual (expected 2: cabinet 3 and rack 1 hanging off the bar edge, fixed by dogs-03 in Task 18). Replace these expected residuals with the counts Task 2 actually recorded. Run -> FAIL.
- [ ] **Step 2: Starship gangways** (starship-01 with its fixCorrection): `for (const sx of [-1, 1]) { box(g, tm.hull, 3.04, 0.48, 5.2, sx * 10.92, -0.5, 0); box(g, tm.hullDeck, 2.7, 0.04, 4.8, sx * 10.85, 0, 0); }` (hull x +-(9.4..12.44), z +-2.6, meeting the pod vertices flush; deck top 0.04 = pod decks, same material). This supports the frame (x -11.995..-11.645), spawn -11.2 and the lounge bench (x 9.1..11.1, z 1.3..1.86) without moving the bench or the lounge-sofa box.
- [ ] **Step 3: Dogs pad** (xcut-02 corrected): `box(g, tm.lawnDark, 1.15, 0.44, 3.0, -11.075, -0.44, 0)` (x -11.65..-10.5, z +-1.5, top 0 like the bar, same material) and `box(g, tm.lawn, 1.0, 0.035, 2.8, -11.1, 0, 0, false)` (top 0.035, 0.005 under the 0.04 bar lawn where they overlap). Optional path decal `box(g, tm.granite, 0.9, 0.012, 1.9, -11.15, 0.035, 0, false)` (top 0.047). Cats needs nothing (its 16-gon reaches x -11.76 at z +-1.1).
- [ ] **Step 4: Verify.** `npm test` green. Renders starship `iso_se entrance top room_lounge_e`, dogs `iso_se entrance top`: elevator and spawn on floor, bench legs on the gangway, no sky under the frame (references `$AUDIT/reference/starship-audit_fix_entrance.jpg`, `$AUDIT/reference/starship-audit_fix_lounge_e.jpg`). Analyzer starship and dogs: `noSupport` 0; no `overhang` on frame or leaves.
- [ ] **Step 5: Commit** `fix(themes): put starship and dogs entrances on real floor`.

### Task 8: Corridor rails from collision data and lounge-sofa props (xcut-05, hanok-04, starship-05, dogs-06 rails and bench, cats-03 rails, cats-04) - P1

**Files:** `theme-kit.js` (add `buildCorridorRails`, `RAIL_STYLES`); `theme-grounds.js` (hanok); `theme-grounds-ext.js` (starship, dogs, cats); `theme-props-pets.js` (dogs deck, cats bed).

**Interfaces:** `buildCorridorRails(g, theme, style)` iterates `obstaclesOf(theme)` entries whose tag matches `/^part-/` only (redrawing `div-*` would double the existing dividers); clips x to `[-style.clip(z), style.clip(z)]`; skips spans shorter than 0.3; calls `style.span(g, x0, x1, z)`. Obstacles are unchanged; gaps follow `layout.doors` automatically (hanok research door at -8.4 ends `part-s-1` at -9.35). Every piece stays inside its box (x0..x1, z +-0.12).

| theme | style (cx = span centre, L = span length) | clip |
|---|---|---|
| hanok (hanok-04, base lowered 0.02 onto the courtyard) | bottom rail `box(hanokDark, L, 0.05, 0.08, cx, 0.02, z)`; balusters `box(hanokDark, 0.06, 0.4, 0.06, x, 0.02, z)` every 0.5 from x0 + 0.03; top rail `box(hanokDark, L, 0.06, 0.1, cx, 0.42, z)` (top 0.48) | 12.0 |
| starship (starship-05, end posts moved inside the box) | kerb `box(hullTrim, L, 0.14, 0.18, cx, 0, z)`; field `box(forceField, L, 0.8, 0.05, cx, 0.14, z, false)`; posts `box(hullTrim, 0.16, 1.1, 0.24, x0 + 0.08 and x1 - 0.08, 0, z)` | 11.2 |
| dogs (dogs-06) | posts `box(fenceWood, 0.1, 0.62, 0.1, x, 0, z)` at x0 + 0.05, then at most 1.0 apart, last at x1 - 0.05; rails `box(fenceWood, L, 0.07, 0.06, cx, 0.22, z)` and at y 0.46 | 10.7 |
| cats (cats-03 with correction) | wall `box(roseGold, L, 0.5, 0.1, cx, 0, z)`; cap `box(plushPink, L, 0.08, 0.16, cx, 0.5, z)`; sisal jamb posts r 0.09, h 0.75 at the span ends next to a door gap (x0 + 0.09 or x1 - 0.09, i.e. d.x +- 1.04) | 11.15 for z < 0, 11.45 for z > 0 |

Lounge-sofa props inside the existing box (9.1..11.1 x 1.3..1.86): dogs deck `lowTable(g, tm.fenceWood, tm.hanokDark, 9.9, 1.58, 1.6, 0.55, 0.42)` plus cushion `box(g, tm.agilityBlue, 1.4, 0.08, 0.45, 9.9, 0.5, 1.58)` (legs at x 9.2/10.6 stay on the bar lawn); cats bed seat `box(g, tm.plushPink, 2.0, 0.3, 0.5, 10.1, 0, 1.55)`, back `box(g, tm.roseGold, 2.0, 0.3, 0.12, 10.1, 0, 1.8)`, two velvetCream cushions (props `CYL` scaled 0.32 x 0.08 x 0.2) resting on the seat (bottom 0.30, mesh centre y 0.34) at x 9.55 and 10.65, z 1.55.

- [ ] **Step 1: Ratchet** `coverage` part entries for hanok, starship, dogs, cats -> 0 and lounge-sofa dogs, cats -> 0 (div entries stay for Tasks 18 and 19). Run -> FAIL.
- [ ] **Step 2: Implement** the helper, styles and props; call `buildCorridorRails(g, theme, RAIL_STYLES[theme])` from the four grounds.
- [ ] **Step 3: Verify.** `npm test` green (obstacles unchanged). Renders hanok, starship, dogs, cats `iso_se center room_lounge_e`: rails with door gaps at x -8/0/8 (hanok research at -8.4), agents' torsos visible over the rails, starship field translucent without a shadow band. Analyzer: no `invisibleObstacle` for `part-*` or `lounge-sofa`.
- [ ] **Step 4: Commit** `fix(themes): draw corridor rails where open themes already block agents`.

### Task 9: Thin the raised floors (palace-03, hanok-03, hanok-08, xcut-07) - P1

**Files:** `theme-grounds.js` palace :169, :180-181, hanok :229-230, :241-244; `theme-kit.js` `populateShelves` (book rows offset by `y0 - 0.08`); `theme-props.js` palace :80, :93-94, :98, :101, :108, :110, :135-137, :140-141 and hanok :153, :166-167, :169, :172, :175, :180, :184, :187, :207-210.

**Interfaces:** consumes `populateShelves(..., { y0 })` from Task 3; geometry only otherwise; hanok-08 must ship in the same commit because thinner floors expose the partition gap.

| item | from | to |
|---|---|---|
| palace maru (:180) | h 0.08 at y 0 | `box(g, tm.hanokWood, w, 0.03, 5.4, cx, 0, cz, false)` (top 0.03) |
| palace rug (:181) | h 0.02 at y 0.09 | `box(g, M.rug[k], w, 0.01, 4.2, cx, 0.03, cz, false)` (top 0.04) |
| palace north protrusion (:169) | h 0.32 | h 0.28 (top 0.02) |
| palace props | shelves y0 0.08; rack 0.08; rack cap 1.98; brazier 0.30; led 0.54; pedestal 0.08; globe 1.65; seal pedestal 0.08; gold 1.00; sealTop 1.28; pole 0.08; lantern 1.25 | shelves `{ y0: 0.03 }`; 0.03; 1.93; 0.25; 0.475 (seated on the new brazier top); 0.03; 1.60; 0.03; 0.95; 1.23; 0.03; 1.20 |
| hanok maru (:229) | y 0 | y -0.11 (top 0.03, above the 0.02 courtyard) |
| hanok rug (:230) | y 0.15 | y 0.03 (top 0.05) |
| hanok props | shelves y0 0.08; hearth 0.14; chimney 1.49; leds 0.55; anvil 0.14; barrel 0.45; rails 0.14; pedestal 0.6; globe 1.68; lantern 0.14/1.0/1.36 | shelves `{ y0: 0.03 }`; 0.03; 1.38; 0.44; 0.03; 0.34; 0.03; 0.49; 1.57; 0.03/0.89/1.25 |
| hanok hanji (:241/:243, hanok-08) | `box(hanji, 0.1, 1.1, 5.4, x, 0.14, +-5)` | `box(g, tm.hanji, 0.1, 1.22, 5.7, x, 0.02, +-4.925)` (abs(z) 2.075..7.775, top 1.24) |
| hanok hanji caps (:242/:244) | 5.5 at +-5 | `box(g, tm.hanokDark, 0.14, 0.08, 5.85, x, 1.22, +-4.925)` |

- [ ] **Step 1: Ratchet** `floorTop:palace` and `floorTop:hanok` 29 -> 0. Run -> FAIL.
- [ ] **Step 2: Implement** the table (populateShelves defaults stay 0.08 for other callers).
- [ ] **Step 3: Verify.** `npm test` green. Renders palace and hanok `room_archive room_research center iso_se`: agent shoes visible on maru and rugs; braziers, shelves, lanterns and hanji bases neither float nor sink. Analyzer: `raisedFloor` 0, no new `floating`.
- [ ] **Step 4: Commit** `fix(themes): lower palace and hanok room floors so agents stand on them`.

### Task 10: Centre features out of the walk ring (starship-04, dogs-05, cats-06, xcut-06) - P1

**Files:** `theme-grounds-ext.js` starship :302-314, dogs :346-355, cats :386-394; `theme-kit.js` (add `CYL48 = new THREE.CylinderGeometry(1, 1, 1, 48)`).

**Interfaces:** geometry only; `corridor-center` obstacles and `corridorWaypoints` unchanged.

| theme | change |
|---|---|
| starship (starship-04 + correction) | disc -> `cyl(g, tm.hull, 2.2, 2.2, 0.02, 0, 0.03, 0)` (0.03..0.05, never coplanar with the 0.03/0.04 deck); ring1/ring2 `scale.set(r, r, 0.3)` with r 1.65/1.1, `position.y = 0.06` (flat glowing inlays, top 0.078); add plinth `cyl(g, tm.hullTrim, 0.85, 0.85, 0.3, 0, 0, 0, OCT)`, column `cyl(g, tm.plasmaCyan, 0.26, 0.26, 2.1, 0, 0.3, 0)`, three `TORUS` in `tm.plasmaViolet` at `scale (0.46, 0.46, 0.9)`, `rotation.x = PI/2`, y 0.85/1.4/1.95, cap `cyl(g, tm.hullTrim, 0.5, 0.5, 0.12, 0, 2.4, 0, OCT)`; core ICOSA at y 2.72, scale 0.3 |
| dogs (dogs-05) | rim `cyl(g, tm.granite, 2.3, 2.1, 0.03, 0, 0.018, 0)` (top 0.048); leaf `cyl(g, M.leaf, 2.0, 1.8, 0.02, 0, 0.032, 0)` (top 0.052); paw pad and toes y 0.16 -> 0.05; hoop y 0.85 -> 0.74 |
| cats (cats-06) | base `cyl(g, tm.roseGold, 2.3, 0.9, 0.06, 0, 0, 0, CYL48)`; posts at (-0.9, -0.2, h 0.9), (0.9, -0.2, h 1.35), (0, 0.25, h 1.8) from y 0.06; pads r 0.62 at y 0.06 + h; yarn (0, 2.2, 0.25) |

- [ ] **Step 1: Ratchet** `ringClear:starship/dogs/cats` -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green (no new `coplanar`). Renders `center iso_se` for the three: no leg inside a ring or disc; starship reads as a vertical warp core (reference `$AUDIT/reference/starship-audit_fix_center.jpg`). Analyzer `ringClearance` 0.
- [ ] **Step 4: Commit** `fix(themes): keep ring-theme centre features inside their collision box`.

### Task 11: Backed, seated scroll screens (xcut-08, palace-09, hanok-06, starship-06, dogs-04, cats-07) - P1

**Files:** `theme-kit.js` (`scrollScreen`; `themeMats` gains `scrollBack: MeshStandardMaterial({ color: 0xe8dfca, roughness: 0.6 })`); `theme-props.js` palace :87, :105, :123, :132, :133 and hanok :159, :196, :205, :206 pass `tm.scrollBack` as the 10th argument; callers that omit `w, h` today must now pass them explicitly (0.95, 0.58) so the material does not land in `w`.

**Interfaces:** `scrollScreen(g, frameMat, screenMat, x, y, z, rotY, w = 0.95, h = 0.58, backMat = mats().dark)`. Never use `frameMat` for the back (starship passes emissive `tm.plasmaCyan`). Caller `y` values stay; the local re-layout lowers the assembly 0.06, which beds every bottom bar 0.02-0.04 into its table top (callers pass table top - 0.02 to - 0.04).

New local layout: bottom bar `box(grp, frameMat, w + 0.12, 0.06, 0.06, 0, 0, 0)`; plane centre y `0.03 + h / 2`, z 0.02; top bar at y `h + 0.06`; back panel `box(grp, backMat, w + 0.04, h + 0.10, 0.02, 0, 0.01, -0.025)` (y 0.01..h+0.11, z -0.035..-0.015: no face coplanar with a bar or the plane).

- [ ] **Step 1: Ratchet** all `screenBack:*` -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green; snapshot diff touches only scrollScreen groups. Renders per prop theme `iso_nw exterior_n iso_se room_desk`: from behind, boards read as dark monitor backs (starship, dogs, cats) or hanji-tone scroll backs (palace, hanok); no glowing slabs on starship; bottom bars touch the tables.
- [ ] **Step 4: Commit** `fix(themes): give scroll screens a back panel and seat them on their desks`.

### Task 12: Research globe clearance (studio-04, office-02, palace-04, hanok-m02) - P1

**Files:** `theme-layouts.js:191-193` (research-globe branch becomes a keyed table). Depends on Task 9 (palace and hanok globe heights).

**Interfaces:** changes `obstaclesOf(theme)` output for studio, office, palace, hanok only (tag and box count unchanged).

| theme | research-globe box | check (`globe` rule) |
|---|---|---|
| studio, office | `{ x0: -8.9, x1: -7.1, z0: 4.1, z1: 5.9 }` (office-02, route-simulated) | ball r 0.8 at y 1.78: hypot(1.08, 0.34) = 1.132 >= 1.11 |
| palace | `{ x0: -9.05, x1: -6.95, z0: 3.95, z1: 6.05 }` (palace-04 hero size kept; +-1.05 instead of the audit's +-0.95 so the 0.31 head sphere, not only the body, clears) | ring sweep 0.901 at y 1.60: hypot(1.23, 0.16) = 1.240 >= 1.211 |
| hanok | `{ x0: -9.35, x1: -7.45, z0: 4.35, z1: 6.25 }` (replaces the hanok branch; hanok-m02's +-0.9 widened to +-0.95 for the same reason) | ring 0.806 at y 1.57: hypot(1.13, 0.13) = 1.137 >= 1.116 |
| starship, dogs, cats | unchanged | unaudited |

Slot margins at r 0.24 (all pass): studio (-6.6, 5) 0.5 from x1, (-8, 6.6) 0.7 from z1; palace (-6.5, 5) 0.45, (-8, 6.7) 0.65, (-10.1, *) 1.05, door inner (-8, 2.9) 1.05; hanok (-7.0, 5.3) 0.45, (-8.5, 7.0) 0.75, (-10.6, *) 1.25, door inner (-8.4, 3.1) 1.25. West detour channels: palace 1.6 (to research-desks x1 -10.65), hanok 1.65 (to -11.0).

- [ ] **Step 1: Ratchet** `globe:studio/office/palace/hanok` -> 0. Run -> FAIL.
- [ ] **Step 2: Implement** the table.
- [ ] **Step 3: Verify.** `npm test` green, including browser-names `:353-370`, `segmentHitsObstacle(-8, 2.9, -8, 6.6, 0.2, 'studio') === true` and the findSafePath detour. If a palace or hanok route assertion fails, fall back to the audit boxes (+-0.95 / +-0.9), record the residual as `globe:<theme>: 1 // triage: residual head overlap <cm>` and report it. Renders `room_research` per theme: agents walk around, not into, the globe.
- [ ] **Step 4: Commit** `fix(themes): size research-globe collision to the spinning globes`.

### Task 13: Rebuild hygiene: allocation and disposal (xcut-11) - P2, shared

**Files:** `furniture.js` (hoist geometries at :169, :175, :177-179, :188, :190, :226, :231, :234, :237, :251 to module constants `RESEARCH_PED`, `GLOBE_BALL`, `GLOBE_WIRE`, `MAST`, `DISH`, `MUG`, `BOOTH_PED`, `BOOTH_RING`, `BOOTH_CORE`, `BOTTLE`; move the per-call `LineBasicMaterial` into `mats().wire`); `floor.js` `rebuildTheme` (:63-89) and `dispose` (:202-205).

**Interfaces:** `mats()` gains `wire`; no signature change; never dispose module-level geometries or cached materials.

- [ ] **Step 1: Failing tests.** Ratchet `alloc:studio/office` -> 0. Add to `theme-build.test.mjs`: rebuild the same fake floor twice through `Floor.prototype.rebuildTheme`; every InstancedMesh from the first build has `dispose` recorded before the second build. Run -> FAIL.
- [ ] **Step 2: Implement.** Before `this.archGroup.clear()`: `this.archGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });`. Same in `Floor.dispose`, plus dispose the board's canvas texture if board.js exposes one. Never dispose module-level geometries or cached materials.
- [ ] **Step 3: Verify.** `npm test` green. `OFFICE_SIM_URL=http://localhost:4319/ python3 -I $AUDIT/tools/leak_probe.py`: `renderer.info.memory.geometries` flat across three 7-theme cycles.
- [ ] **Step 4: Commit** `fix(themes): stop leaking geometries and instance buffers on theme rebuild`.

---

## Phase C: Per-theme P0/P1

### Task 14: Studio and office (studio-01, studio-02 + office-03, studio-06) - P0/P1

**Files:** `theme-grounds.js` studio :101-116; `furniture.js` `mats()` :17-39, `buildArchive` :115, `buildResearch` :186-195.

**Interfaces:** `mats()` gains `metalDS`; geometry only otherwise (office shares the furniture changes).

- **studio-01 corner:** four chord boxes `for (let i = 0; i < 4; i++) { const phi = (i + 0.5) * Math.PI / 8; const m = box(g, M.wall, 0.567, 2.7, 0.22, -10.8 - 1.275 * Math.sin(phi), 0, -6.8 - 1.275 * Math.cos(phi)); m.rotation.y = phi; }`. North wall `box(g, M.wall, 22.0, 2.7, 0.22, 0.2, 0, -8.1)` (x -10.8..11.2) and west wall `box(g, M.wall, 0.22, 2.7, 14.0, -12.1, 0, 0.2)` (z -6.8..7.2). The audit's ends at x 11.6 and z 7.6 are trimmed by 0.4 so the NE and SW wall corners sit on the fillet (corner radius 1.466 < 1.471 apothem) and pass `support`. Slats `for (let x = -9.9; x <= 11.05; x += 1.1) box(g, tm.studioOak, 0.12, 2.5, 0.12, x, 0.02, -7.96)` (11.05 guards float accumulation so the x = 11 slat survives; y 0.1 -> 0.02 grounds them). Bookcases `[-10.15, -8, -5.6]` (furniture.js:115; office shifts too, harmless).
- **dish (office-03 with its correction; supersedes studio-02's orientation):** `mats().metalDS = themed('--metal', { roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide })`; module constants `DISH = new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3.2).rotateX(-Math.PI / 2)`, `FEED = new THREE.CylinderGeometry(0.012, 0.012, 0.56, 6).rotateX(Math.PI / 2)`. Mast at (-4.9, 0.9, 7.1) so `mastTop = (-4.9, 1.8, 7.1)`; `dir = new THREE.Vector3(0.75, 0.9, -0.75).normalize()`; dish at `mastTop + 0.42 dir` with `dish.lookAt(dish.position.clone().add(dir))`; feed at `mastTop + 0.33 dir`, same `lookAt` (spans 0.05..0.61 dir); blinking tip at `mastTop + 0.6 dir`.
- **studio-06 pods:** :104 -> `cyl(g, tm.studioOak, 2.6, 1.6, 0.45, x, -0.465, 7.6)` (top -0.015); :105 -> `cyl(g, M.floor, 2.3, 1.35, 0.045, x, -0.015, 7.6)` (top 0.03).

- [ ] **Step 1: Ratchet** `support:studio` and `coplanar:studio` -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders studio `iso_se iso_nw room_archive top`: no sky at the NW corner, bookcase clear of the arc, no stripes at pod junctions (reference `$AUDIT/reference/studio-audit_nwcorner_after.jpg`, `$AUDIT/reference/studio-audit_bayrim_after.jpg`); studio and office `room_research iso_sw`: dish reads as a dish with a feed arm from both angles (reference `$AUDIT/reference/office-audit_dish_fix_b.jpg`, `$AUDIT/reference/office-audit_dish_fix_b_sw.jpg`).
- [ ] **Step 4: Commit** `fix(themes): close the studio NW corner, fix the research dish and pod z-fight`.

### Task 15: Palace pond (palace-02, xcut-m02) - P0

**Files:** `theme-grounds.js` palace :203-204.

**Interfaces:** geometry only; pond footprint (x +-2.8, z +-1.05) and `corridor-center` unchanged.

- [ ] **Step 1: Ratchet** `coplanar:palace` -> 0. Run -> FAIL.
- [ ] **Step 2: Change:** base `box(g, tm.graniteDark, 5.6, 0.04, 2.1, 0, 0, 0)`; coping `box(g, tm.graniteDark, 5.6, 0.22, 0.225, 0, 0, +-0.9375)` and `box(g, tm.graniteDark, 0.25, 0.22, 1.65, +-2.675, 0, 0)`; water `box(g, M.water, 5.1, 0.1, 1.65, 0, 0.04, 0, false)` (top 0.14, 0.08 below the coping). Island and pine unchanged; footprint still x +-2.8, z +-1.05.
- [ ] **Step 3: Verify.** `npm test` green. Renders palace `center iso_se iso_sw`: clean blue water in a coping frame (reference `$AUDIT/reference/palace-audit_fixA_center.jpg`).
- [ ] **Step 4: Commit** `fix(themes): stop the palace pond water z-fighting its rim`.

### Task 16: Hanok (hanok-02, hanok-07, hanok-13) - P1

**Files:** `theme-grounds.js` hanok :235-237; `theme-props.js` hanok :172-181.

**Interfaces:** geometry only; the barrel moves inside the existing `server-desk` box.

- hanok-02: posts `[[-12.6, 2.3], [-11.05, 2.3], [-12.6, 8.3], [-11.05, 8.3]]` (x -11.05 keeps the r 0.18 post inside the -10.85 trim edge).
- hanok-07: rails `[[-8.5, 7.79, 8.6, 0.12], [-12.74, 5.1, 0.12, 5.5]]`, base y 0.03 (after Task 9).
- hanok-13: barrel x 8.6 -> 8.38 (8.06..8.70, inside server-desk); the anvil stays at 7.65 (moving it to 7.6 would leave the box).

- [ ] **Step 1: Ratchet** `routeClear:hanok` -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders hanok `iso_se low_s room_server`: no lone post at the research/meeting corner, four posts under the pavilion eave, no gap under the south rail.
- [ ] **Step 4: Commit** `fix(themes): fix hanok pavilion posts, railings and forge barrel`.

### Task 17: Starship engine-core LEDs (starship-03) - P1

**Files:** `theme-props.js` starship :240-248.

**Interfaces:** the returned `leds` array still holds meshes whose `material` Floor.update swaps.

- [ ] **Step 1: Ratchet** `hidden:starship` 20 -> 0. Run -> FAIL.
- [ ] **Step 2: Change** line 246 to a protruding ring: `const ring = new THREE.Mesh(CYL, M.ledOn); ring.scale.set(0.6, 0.07, 0.6); ring.position.set(x, 0.46 + r * 0.38, -7.1); g.add(ring); leds.push(ring);` (14-gon inscribed radius 0.585 > column 0.52; inside server-racks).
- [ ] **Step 3: Verify.** `npm test` green (leds non-empty). Renders starship `room_server iso_se`: green/amber rings animate on the columns.
- [ ] **Step 4: Commit** `fix(themes): make starship engine-core status lights visible`.

### Task 18: Dogs (dogs-02, dogs-03, dogs-07, dogs-06 dividers) - P0/P1

**Files:** `theme-grounds-ext.js` dogs :324-325, :336-343; `theme-props-pets.js` dogs :299-303, :326.

**Interfaces:** geometry only; dogs-03 lands before the divider change in the same commit.

- dogs-02: stripes -> `box(g, tm.agilityYellow, 1.5, 0.14, 0.05, x, 0.55, -6.85, false)` and `box(g, tm.agilityBlue, 1.5, 0.14, 0.05, x, 1.05, -6.85, false)` (0.05 proud of the cabinet face).
- dogs-03: bar `box(g, tm.lawnDark, FLOOR_W - 2.4, 0.44, FLOOR_D - 0.4, 0, -0.44, 0)` (z +-7.8); lawn `box(g, tm.lawn, FLOOR_W - 2.6, 0.04, FLOOR_D - 0.6, 0, 0, 0, false)`; fence posts and both rails z -7.4 -> -7.64.
- dogs-07: `globe.position.set(-8, 1.40, 5)` (ball bottom 0.84 on the 0.845 hydrant top).
- dividers (dogs-06): `box(g, tm.fenceWood, 0.14, 0.72, 5.6, x, 0, +-4.8)` (abs(z) 2.0..7.6; needs dogs-03).

- [ ] **Step 1: Ratchet** `hidden:dogs` 12 -> 0, `support:dogs` residual -> 0 and `coverage` div dogs 4 -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders dogs `iso_se exterior_n low_s top`: crisp stripe plates, rails behind racks and cabinets, ball on the hydrant. Analyzer dogs: `hidden` 0, `floating` 0, no cabinet/rack `overhang`.
- [ ] **Step 4: Commit** `fix(themes): fix dogs cabinet stripes, north fence, tennis ball and dividers`.

### Task 19: Cats floor outline (cats-01, cats-02, cats-08, cats-m02, xcut-09 cats, cats-03 dividers) - P0/P1, effort L

**Files:** `public/js/theme-geometry.js` (add `catOutline`); `test/theme-geometry.test.mjs`; `theme-grounds-ext.js` cats :366-376, :379-384; `theme-kit.js` (add `CYL32`, `DIAMOND4`, `HALF_SPHERE`); `theme-props-pets.js` cats :404-407.

**Interfaces:** pure `catOutline(pad = 0) -> [[x, z], ...]` (counter-clockwise). Primitives (pad added to radii): face ellipse centre (0, 0.4), rx 11.9, rz 7.9; ears are square diamonds centred (+-7.8, -5.8), circumradius 4.5, vertices on the local axes rotated by +-0.12 rad (the orientation `cyl(..., CONE4, sx * 0.12)` has today); paws are ellipses centred (+-9.0, 5.0), rx 3.35, rz 3.15. Outline = radial hull about (0, 0.4): for theta at 1 degree steps plus every diamond vertex angle, r(theta) = farthest ray intersection with any primitive. This deliberately fills the ear/face V-notches.

- [ ] **Step 1: Failing tests** in `theme-geometry.test.mjs`: `catOutline(0)` contains every cats slot centre and its 8 samples at r 0.24, every door `(x, inner)`, the spawn (-10.8, 0) and the research-table corner (-11.4, 7.1) with at least 0.05 margin; `catOutline(0.3)` contains the frame corners (-11.595 and -11.245, +-1.1); the polygon is simple with at least 360 points. Ratchet `support:cats` and `coverage` div cats -> 0. Run -> FAIL.
- [ ] **Step 2: Floor.** Module constants `CAT_FLOOR = new THREE.ExtrudeGeometry(shapeOf(catOutline(0)), { depth: 0.04, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 0.04, 0)` (y 0..0.04) and `CAT_RIM = new THREE.ExtrudeGeometry(shapeOf(catOutline(0.3)), { depth: 0.44, bevelEnabled: false }).rotateX(Math.PI / 2)` (y -0.44..0), where `shapeOf` maps `[x, z]` to `Vector2(x, z)` (rotateX(+PI/2) sends shape y to world z and depth to -y). Rim mesh `tm.roseGold`; floor mesh `tm.velvetCream`, `castShadow = false`. Replace :366-371 (two face cylinders, three ear cones) with these two meshes plus pink inner-ear decals `cyl(g, tm.plushPink, 2.6, 2.6, 0.004, sx * 7.8, 0.045, -6.3, DIAMOND4, sx * 0.12)` (`DIAMOND4 = new THREE.CylinderGeometry(1, 1, 1, 4)`, top 0.049, rx == rz so no shear). Give `cyl()` a trailing `shadow = true` parameter and pass `false` for this decal and the rugs.
- [ ] **Step 3: Rugs and props.** Rugs :376 -> `cyl(g, M.rug[k], 3.0, 2.2, 0.03, cx, 0.03, cz, CYL32)` (top 0.06). Bell (cats-01): remove the floor bell (:404-407); add base props `CYL` r 0.2, h 0.06 with its bottom on the 0.70 desk top (mesh centre (9.5, 0.73, 5.0)) and dome `HALF_SPHERE` (`new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)`) scaled 0.15 at (9.5, 0.76, 5.0), both `tm.gold`. Dividers (cats-03): north `box(g, tm.roseGold, 0.1, 0.85, 4.9, x, 0, -4.45)` (z -6.9..-2.0), south `box(g, tm.roseGold, 0.1, 0.85, 5.3, x, 0, 4.65)` (z 2.0..7.3); sisal posts z +-3.2 -> +-2.0.
- [ ] **Step 4: Verify.** `npm test` green. Renders cats `iso_se iso_nw top room_research room_desk room_server center`, plus crops along the old face and ear edges and across the server rug: no seams (cats-m02), tables, bell and rugs on floor. Analyzer cats: `noSupport` 0, `overhang` 0. Fallback if this task is deferred: xcut-09 cheek lobes (`roseGold` cyl 4.3 x 3.3 at (+-8.6, 5.0); cream 4.0 x 3.0, top 0.04), known seam risk.
- [ ] **Step 5: Commit** `fix(themes): build the cat lounge floor as one outline that covers every room`.

---

## Phase D: P2 (optional)

### Task 20: Shared polish: glass shadows, divider caps, transparency, blinkers (studio-05, studio-m01, office-09a, xcut-13, xcut-m04)

**Files:** `theme-kit.js` (`buildStandardPartitions` :141-159 pre-split, `themeMats` :34, :38); `floor.js` (`rebuildTheme` :63-89, `update` :180-200).

**Interfaces:** Floor gains `blinkers`/`blinkT`; no exported signature change.

- `buildStandardPartitions`: `const sh = !wallMat.transparent;` passed as the 9th argument of the four pane boxes (:147, :152, :156, :157); caps keep casting. Divider caps inside the x loop: `box(g, capMat, 0.16, 0.06, 5.92, x, 0.9, -5.04)` and the same at 5.04 (abs(z) 2.08..8.0; studio-m01 supersedes office-09a's 6.0 at +-5, which overlaps the corridor cap). Office gets metal caps too.
- `themeMats`: `glassWall` and `forceField` get `depthWrite: false`.
- Blinkers: `rebuildTheme` collects `this.blinkers` via `ag.traverse((o) => { if (o.userData.blink) this.blinkers.push(o); })`; `update`: `this.blinkT = (this.blinkT || 0) + dt; const on = this.blinkT % 1.2 < 0.8; for (const b of this.blinkers) b.material = on ? M.lamp : M.ledOff;` (material swap, never mutating `M.lamp`).

- [ ] **Step 1: Failing test:** new harness check `glassShadow` (meshes with `transparent` and opacity below 0.5 have `castShadow === false`; near-opaque hanji at 0.88 is exempt) with expected 0. Run -> FAIL (studio panes).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders studio `iso_se center`: no grey bands beside glass; x = +-4 dividers have oak rails; office dividers capped.
- [ ] **Step 4: Commit** `fix(themes): stop glass casting solid shadows and cap the room dividers`.

### Task 21: Studio and office polish (studio-07, office-08, office-05, studio-08, studio-09, office-07, office-06, office-09 b/c)

**Files:** `theme-layouts.js:205-209` (studio/office block); `furniture.js` :138, :148, :149, :204, :254; `theme-grounds.js` office :126-127, :128-129, :136.

**Interfaces:** `obstaclesOf('studio' | 'office')` gains 7 boxes (count only grows); geometry otherwise.

- New studio/office obstacles: `dev-printer {-3.65, -3.05, -3.65, -3.15}`, `desk-plant {4.7, 5.3, 7.1, 7.7}`, `meeting-plant {3.1, 3.7, 7.1, 7.7}`, `dev-plant {3.1, 3.5, -3.55, -3.15}`, `lounge-plant-w {-10.65, -10.15, -1.55, -1.05}`, `lounge-plant-e {11.3, 11.8, 1.3, 1.8}`, `research-mast {-5.0, -4.8, 7.0, 7.2}` (x0, x1, z0, z1).
- Printer replaces the dev box (office-05 parts, moved 0.65 north so the front face is 1.1 behind the rail per studio-08): body `box(M.wall, 0.55, 0.7, 0.48, -3.35, 0, -3.4)`, lid `box(M.dark, 0.55, 0.08, 0.48, -3.35, 0.7, -3.4)`, paper `box(M.wall, 0.3, 0.02, 0.22, -3.3, 0.78, -3.45, false)`, slot `box(M.dark, 0.02, 0.04, 0.34, -3.07, 0.45, -3.4, false)`, LED `box(M.ledOn, 0.02, 0.03, 0.05, -3.07, 0.6, -3.57, false)`.
- Cabinet: office-05 drawer fronts `box(M.part, 0.02, 0.34, 0.6, -10.89, y, -3.1, false)` for y 0.06/0.44/0.82 with handles `box(M.dark, 0.03, 0.04, 0.24, -10.87, y + 0.22, -3.1, false)`, plus studio-08's archive box `box(M.wood, 0.45, 0.22, 0.36, -11.3, 1.2, -3.1)`.
- Plants (studio-09 corrected): `plant(g, 3.3, -3.35, 0.75)` and `plant(g, -10.4, -1.3, 0.9)`. If the NW lounge counter (Task 27) is adopted later, it replaces this plant and its box.
- office-07: back skin `box(grp, M.part, 4.3, 2.1, 0.02, 0, 0.6, -0.115, false)` in the board group (front unchanged).
- office-06 terrace (replaces :126): base `box(g, M.slab, 2.2, 0.5, 6.4, -13.3, -0.5, 0)`; oak deck `box(g, tm.studioOak, 2.0, 0.04, 6.2, -13.3, 0, 0, false)`; planter `box(g, tm.lawn, 0.6, 0.3, 5.6, -13.95, 0.04, 0)`; shrubs `cyl(g, tm.lawnDark, 0.32, 0.32, 0.5, -13.95, 0.34, z, ICOSA)` for z in [-2, 0, 2]; glass rail `box(g, tm.glassWall, 0.05, 0.9, 6.2, -14.35, 0.04, 0, false)` with cap `box(g, M.metal, 0.08, 0.04, 6.2, -14.35, 0.94, 0)`.
- office-06 ledge (replaces :127): base `box(g, M.slab, 7.2, 0.5, 1.4, 8, -0.5, 8.5)`; balustrade `box(g, tm.glassWall, 7.1, 0.9, 0.05, 8, 0, 9.15, false)` with cap `box(g, M.metal, 7.1, 0.04, 0.08, 8, 0.9, 9.15)`; end panels `box(g, tm.glassWall, 0.05, 0.9, 0.85, x, 0, 8.72, false)` at x 4.45 and 11.55. Glass is translucent, so the camera rule allows 0.94 at the south edge; it passes Task 20's `glassShadow` check because the boxes do not cast.
- office-09 (b) `box(g, M.wall, 0.25, 2.8, 16.395, -12.12, 0, -0.0475)`; (c) corridor width `FLOOR_W - 0.02`. Both invisible today; do them only while editing these lines.

- [ ] **Step 1: Failing test** in `theme-layout-invariants.test.mjs`: `obstaclesOf('studio')` and `obstaclesOf('office')` include the seven new tags. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green (browser-names loop with the new boxes). Analyzer studio/office `walkThrough`: only the elevator frame and leaves. Renders `iso_se room_dev room_archive iso_sw low_w exterior_s`.
- [ ] **Step 4: Commit** `feat(themes): detail studio and office props and match their collision`.

### Task 22: Lounge seating per theme (office-04, office-m03, palace-m01, studio-07 sofa arms)

**Files:** `theme-layouts.js:203` (lounge-sofa becomes `LOUNGE_SOFA[key] ?? default {9.1, 11.1, 1.3, 1.86}`) and studio/office block; `furniture.js:245-256`; `theme-props.js` palace :144.

**Interfaces:** `obstaclesOf` lounge-sofa becomes theme-keyed (tag and count unchanged); studio/office gain two bench boxes.

- studio/office (office-04 option A): seat `box(M.sofa, 0.55, 0.42, 2.0, 11.4, 0, 0)`, back `box(M.sofa, 0.16, 0.55, 2.0, 11.6, 0.42, 0)`, arms `box(M.sofa, 0.55, 0.62, 0.16, 11.4, 0, +-1.0)`; box `{11.1, 11.8, -1.1, 1.1}`. If option B is chosen (open question), keep the sofa, move its arms to x 9.18/11.02 (studio-07) and build the office's east lounge partitions from `tm.glassWall`.
- studio/office benches (office-m03): `box(M.sofa, 5.4, 0.42, 0.34, 4.0, 0, -1.76)`, `box(M.sofa, 1.6, 0.42, 0.34, 10.05, 0, -1.76)`, optional backs `box(M.sofa, w, 0.4, 0.08, x, 0.42, -1.89)`; obstacles `lounge-bench-1 {1.3, 6.7, -1.93, -1.59}`, `lounge-bench-2 {9.25, 10.85, -1.93, -1.59}`.
- palace (palace-m01): `lowTable(g, tm.hanokWood, tm.hanokDark, 11.25, 0, 0.55, 2.0, 0.42)`; box `{10.95, 11.55, -1.05, 1.05}`.
- starship, dogs, cats keep the default box (props from Tasks 7 and 8).

- [ ] **Step 1: Failing test:** `obstaclesOf('office')` lounge-sofa equals `{11.1, 11.8, -1.1, 1.1}` and `obstaclesOf('palace')` lounge-sofa equals `{10.95, 11.55, -1.05, 1.05}`. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green (browser-names loop; harness `coverage` lounge-sofa 0 everywhere). Renders office `iso_se room_lounge_e`, palace `iso_se`: seating visible from the default camera.
- [ ] **Step 4: Commit** `feat(themes): give each lounge visible seating`.

### Task 23: Palace polish (palace-05, palace-06, palace-07, palace-10, palace-m02)

**Files:** `theme-props.js` palace :80 (shelves), :126-128 (meeting); `theme-grounds.js` palace :167, :170, :172-174 (posts and new rails).

**Interfaces:** geometry only; consumes `populateShelves` options.

- palace-05: `populateShelves(g, tm.vermilion, palette, [-10.4, -8, -5.6], { z: -7.28, y0: 0.03 })`.
- palace-06: add `box(g, tm.graniteDark, 9.6, 0.32, 2.2, 0, -0.58, 8.8)`.
- palace-07: :167 -> `box(g, tm.granite, FLOOR_W + 0.4, 0.28, FLOOR_D + 0.16, 0, -0.26, 0)`.
- palace-10 (identity): south rails between posts on [-11.8, -8], [-8, -4.2], [4.2, 8], [8, 11.8]: `box(g, tm.granite, len, 0.07, 0.09, mid, 0.3, 7.85)` and `box(g, tm.granite, len, 0.05, 0.07, mid, 0.1, 7.85)`; east and west rails start at z -7.5 (no post at (11.85, -7.85)); gate opening abs(z) < 1.6 stays open; everything under 0.45 tall.
- palace-m02 (tabletop only; floor cushions would bring back sinking feet): incense burner props `CYL` scaled (0.12, 0.14, 0.12), bottom at y 0.76 (mesh centre (0.8, 0.83, 5)), in `tm.gold`; three scroll rolls `CYL` scaled (0.04, 0.5, 0.04) with `rotation.x = PI/2` at (0.8, 0.80, 4.0 / 5.6 / 6.2) in `tm.granite`; runner `box(g, tm.dancheong, 0.5, 0.01, 2.6, 0.8, 0.76, 5, false)`; all inside the meeting-table box (x 0.1..1.5, z 3.4..6.6).

- [ ] **Step 1: Baseline check (render/analyzer):** `python3 -I $AUDIT/tools/analyze_themes.py http://localhost:4319/ $OUT/analysis_T23_before palace` lists the intersect between the x = -8 pillar (theme-grounds.js:185) and the middle shelf (populateShelves) and an `outside` hit for the south step (:170) with nothing under it in `exterior_s`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Re-run the analyzer into `$OUT/analysis_T23_after`: the pillar/shelf intersect is gone and `exterior_s` shows a two-step stair. Renders palace `exterior_s exterior_n room_meeting iso_se`; rails stay under 0.45 and do not hide the desk room.
- [ ] **Step 4: Commit** `feat(themes): finish palace terrace, shelves and meeting hall`.

### Task 24: Hanok polish (hanok-09, hanok-10, hanok-11, hanok-12, hanok-14, hanok-m01)

**Files:** `theme-grounds.js` hanok :221-222, :229, :233-238, :246; `theme-props.js` hanok :167, :182-193; `theme-kit.js` `themeMats` (`stoneWall`, `maru`); `theme-layouts.js:70` (comment).

**Interfaces:** `themeMats()` gains `stoneWall` and `maru`; geometry only otherwise.

- North wall (hanok-09 + hanok-11): `box(g, tm.stoneWall, FLOOR_W, 2.35, 0.24, 0, 0, -7.98)` with new `tm.stoneWall` (0x8f8578) and two `tm.hanokDark` bands `box(24, 0.05, 0.26)` at y 0.9 and 1.7; eave y 2.15 -> 2.3; chimney z -7.2 -> -7.0 (optionally h 0.9 -> 0.7).
- hanok-10 (after Task 9): pedestal `scale.y` 0.95 -> 0.7, `position.y` 0.38 (0.03..0.73, ring bottom 0.764 clears); spindle CYL r 0.045, h 0.36, centre y 0.91.
- hanok-12: :221 -> `box(g, tm.graniteDark, 9.4, 0.47, 7.2, -8.4, -0.48, 5.4)` (top -0.01); :222 cyl y -0.43; posts standing only on the plinth start at y -0.01.
- hanok-m01: `tm.maru = MeshStandardMaterial({ color: 0xb3864f, roughness: 0.7 })`, used only for the room maru (:229).
- hanok-14: reword theme-grounds.js:246 and theme-layouts.js:70 unless Task 27 builds the lantern and well.

- [ ] **Step 1: Ratchet** `coplanar:hanok` -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders hanok `iso_se iso_nw exterior_n room_research room_meeting`.
- [ ] **Step 4: Commit** `feat(themes): finish hanok walls, globe stand and maru tone`.

### Task 25: Starship hull geometry (starship-08, xcut-03, starship-07, starship-10, starship-09, starship-m01)

**Files:** `theme-grounds-ext.js` starship :271, :276, :280, :283-293, :298-299; `theme-props.js` starship :221-229; `theme-kit.js` `themeMats` (`hullDS`).

**Interfaces:** `themeMats()` gains `hullDS`; geometry only otherwise.

These ship together: baking the octagon moves its north edge to z -7.945, which detaches the x = 0 nozzle unless the nacelles land, and the raised nacelle at x -5.5 needs the smaller plinth.

- `OCT8 = new THREE.CylinderGeometry(1, 1, 1, 8).rotateY(Math.PI / 8)`; :271 `cyl(g, tm.hull, 11.2, 8.6, 0.52, 0, -0.52, 0, OCT8)`; :276 `cyl(g, tm.hullDeck, 10.7, 8.2, 0.04, 0, 0, 0, OCT8)` (flat edges x +-10.35, z +-7.945; deck top 0.04 like pods and gangways).
- Nacelles (starship-07 correction): per tx in [-5.5, 0, 5.5]: `box(g, tm.hullTrim, 1.5, 1.05, 0.6, tx, -0.5, -8.25)`; open bell `BELL = new THREE.CylinderGeometry(0.62, 0.36, 0.9, 16, 1, true)` with cached `themeMats().hullDS` (DoubleSide clone of `hull`), `rotation.x = -PI/2`, centre (tx, 0.25, -8.95), wide end north; glow `CYL` plasmaCyan scaled (0.36, 0.02, 0.36), `rotation.x = PI/2`, at (tx, 0.25, -8.6) inside the throat. No additive plume. This is a visual call: if `iso_se` shows black horns behind the dev room, drop the raise and keep the bell axis at y -0.25.
- starship-10: plinth `base.scale.set(0.7, 0.3, 0.7)`; crystal r 0.45.
- starship-09: offset clones of the starship rug materials (`polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4`) cached once (module-level Map), used only by the starship rug boxes (:280); never modify `M.rug` (studio's mug shares `M.rug.desk`).
- starship-m01: resolved by OCT8; optional end posts `box(g, tm.hullTrim, 0.18, 1.25, 0.24, x, 0, +-7.45)`.

- [ ] **Step 1: Ratchet** `shear:starship` 2 -> 0 and the `support:starship` residual (force-field ends, plinth) -> 0. Run -> FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders starship `top exterior_n iso_ne iso_se room_research`: symmetric octagon, engines attached and reading as engines, no rug seams at iso (confirm on a real GPU).
- [ ] **Step 4: Commit** `feat(themes): square up the starship hull and rebuild its engines`.

### Task 26: Pets polish (dogs-09, dogs-10, dogs-11, dogs-m01, cats-m01)

**Files:** `theme-grounds-ext.js` dogs :326-328, :356-357 (+ east apron after :329); `theme-props-pets.js` dogs :322-333, cats :383-389.

**Interfaces:** geometry only (dogs-11 uses the geometry option, no obstacle).

- dogs-09: `pineTree(g, tm, +-11.8, -4.3, 0.95)`.
- dogs-10: lobe lawn tops `cyl(g, tm.lawn, 3.45, 3.15, 0.046, bx, 0, bz)`.
- dogs-11: east apron `box(g, tm.lawnDark, 1.0, 0.44, 3.9, 11.25, -0.44, 0)` plus lawn top `box(g, tm.lawn, 0.9, 0.04, 3.7, 11.15, 0, 0, false)` (x 10.7..11.6, abutting the bar lawn without overlap).
- dogs-m01: module constant `TBALL = new THREE.IcosahedronGeometry(1, 2)` at scale 0.56; two seams `TORUS` in `M.white` scaled 0.36 at (0.42, 0, 0) with `rotation.y = PI/2` and at (-0.42, 0, 0) with `rotation.x = PI/2`, inside the globe group; globe y 1.39 (detail-2 lowest vertex 0.548 below the centre).
- cats-m01: `globe.position.set(-8, 1.47, 5)`.

- [ ] **Step 1: Baseline.** Ratchet any `coplanar:dogs` entries -> 0 (run -> FAIL if any exist). Render `low_s` for cats with `$AUDIT/tools/multishot.py cats $OUT/cats/audit_T26_before - low_s:0.15,0.32,1,0,0,1`: background visible between the yarn ball and its pedestal; dogs `room_server`: foliage over rack 4's lower LEDs.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.** `npm test` green. Renders dogs `room_server iso_se room_desk low_s`, cats `low_s room_research`.
- [ ] **Step 4: Commit** `feat(themes): polish dog park trees, lawn seams and toy props`.

### Task 27: Theme identity backlog (choose items per open question)

**Files:** per item, as anchored in the table (builder files after Task 4; `theme-layouts.js` studio/office or theme-keyed blocks when an item adds an obstacle).

**Interfaces:** any new obstacle is theme-keyed and passes browser-names `:353-370`; sketches are the audit's improvement entries (the verified audit JSON must accompany this plan for these items).

One commit per accepted item: `feat(themes): <theme> - <item>`. For each item: add or extend an invariant if it adds an obstacle; geometry as module constants; obey the floor-layer, camera and collision/visual rules; render `iso_se` plus one close-up.

| theme | item (audit improvement) | anchor and constraint | effort |
|---|---|---|---|
| studio/office | lounge rug + east coffee bar | furniture.js `buildLoungeProps`; bar box conflicts with Task 22 option A sofa at x 11.1..11.8, pick one | S |
| studio | balcony balustrade + seating on pods | theme-grounds.js pods; unreachable, no collision; glass `castShadow` false | M |
| studio | glass elevator jambs/canopy | build on Task 6; re-derive jambs for the 2.2 frame (z +-1.0), not the superseded 3.4 frame | M |
| studio | dense oak louver wall | slats every 0.36 from x -10.4 after the Task 14 arc | S |
| studio/office | review-booth projector beam, lower booth panels to 1.15 | furniture.js:230-241 | S |
| studio/office | real bookcase carcasses | furniture.js:115-136; same footprint | S |
| studio/office | server cable tray and floor grilles | grilles at z -6.45 between racks and slots | S |
| office/studio | NW lounge counter | replaces the Task 21 west lounge plant and its box; obstacle `lounge-counter {-11.45, -9.35, -1.88, -1.33}` | S |
| office | dev-room wall dashboard | north wall y 1.65..2.65 | S |
| office/studio | chairs under desks | inside existing desk boxes | M |
| office/studio | globe meridian ring | radius 0.9 raises globe R: re-run `globe` (Task 12 box assumes R 0.8; widen or use ring 0.78 with the shrink alternative) | S |
| office | hotline booth glass panels and phone | furniture.js:216-243 via a theme argument | M |
| office | glass meeting dividers | office-only pass; footprints equal `div-bot-*` | S |
| palace | north hall back wall under eaves | z -7.86 inside the pillar row; opaque hanji 0xf4efe4 | S |
| palace | colonnade dancheong beams | x -11.8, y 2.3 | S |
| palace | lounge cushions and stone lanterns | cushions top 0.042 at slots; lantern cap uses `ROOF4` | S |
| palace | brazier bowls and spear racks | keep 8 leds (cone flames) | M |
| palace | sun-moon-five-peaks screen on the desk room north partition | not on the east edge (camera rule) | M |
| palace | dev front desks | extend the dogs/cats `dev-table-w/e` branch to palace | S |
| hanok | plum tree, stoneLantern helper, hanji lattice, gyeja pavilion rails, onggi jars, forge dressing, gate wing walls (start at abs(z) >= 1.75), courtyard well (obstacle `lounge-well {-10.85, -9.95, 0.85, 1.75}` hanok-only) | see hanok improvements; lantern/well also close hanok-14 | S-M each |
| starship | data-vault crystals + archive console, engine caps + conduit, tactical holo-table, desk projector beam, observation lounge on the east gangway (inside lounge-sofa), bow canopy and nav lights (inside wall-south), research sensor dish, airlock signage (strips at the frame edges z +-1.05, not the superseded pocket edges) | see starship improvements | S-M each |
| dogs | scent-trail hedges, ball launchers + lane decal, treat jar, hydrant details, park gate, lounge bowl/beds/toy, council cushions (h 0.04 so tops stay at 0.06), hoop stand + perimeter bushes | see dogs improvements | S-M each |
| cats | whiskers + paw trail, cat-house portal, laser domes, yarn-ball tower top, yarn globe, churu jar in the desk-main east half, meeting cushions (y 0.03 so tops stay at 0.06), scratcher stripes | see cats improvements | S each |
| all | per-theme structural style table (rails, portal, bench, backed screen) | extends Task 8 `RAIL_STYLES` | M |

### Task 28: Camera-facing facade cutaway (xcut-10)

**Files:** `theme-geometry.js` (pure `facadeVisible(dirXZ, n, wasVisible)`: visible when `dot(dir, n) < 0.25`, with 0.05 hysteresis); grounds (tag `userData.facade = [nx, nz]` on studio :114-116, office :135-136, hanok :233-234, palace :188-190, gate roofs :209/:260 as west); `floor.js` (collect facades); `office.js` update (pass the normalised camera XZ direction from `this.stage`).

**Interfaces:** produces pure `facadeVisible`; `Floor.update` gains an optional camera-direction argument.

- [ ] **Step 1: Failing test:** `facadeVisible([0.707, 0.707], [0, -1], true) === true` (default SE camera never hides anything); `facadeVisible([0, -1], [0, -1], true) === false`; hysteresis at dot 0.27 keeps the previous state. Run -> FAIL.
- [ ] **Step 2: Implement** with a shared ghost material (opacity 0.15, `depthWrite: false`) rather than `visible = false`, so shadows stay.
- [ ] **Step 3: Verify.** `npm test` green. Renders `iso_ne iso_nw` for studio, office, palace, hanok: north rooms visible; `iso_se` unchanged.
- [ ] **Step 4: Commit** `feat(themes): ghost camera-facing facades so north rooms stay visible`.

### Task 29: Commit the browser audit runner (optional tooling)

**Files:** create `scripts/audit-themes.py`, `scripts/capture-themes.py`, `scripts/theme-audit-baseline.json`.

**Interfaces:** CLI only; not shipped, not in CI.

- Promote `$AUDIT/tools/analyze_themes.py`, `$AUDIT/tools/capture_themes.py`, `multishot.py` and the probes (`leave_probe3.py`, `leak_probe.py`, `doors_hold_open.js`) into `scripts/audit-themes.py` and `scripts/capture-themes.py` with `scripts/theme-audit-baseline.json`; pass in-page code as `page.evaluate` function expressions (CSP forbids eval, src/server-guard.mjs:22); exit 1 when a category count exceeds the baseline. Keep out of `public/` (pages.yml deploys it) and out of `package.json files`. Manual pre-merge step, not CI.
- [ ] Verify: `python3 -I scripts/audit-themes.py http://localhost:4319/ --baseline scripts/theme-audit-baseline.json` exits 0 after Task 19.
- [ ] Commit `chore(themes): add a manual browser audit for room themes`.
