# SDD ledger — plan: docs/superpowers/plans/2026-10-23-place-theme-repair.md
Scope: Tasks 1-19 (Phases A-C), defaults for all open questions (user, 2026-10-23). Spec = user request + $AUDIT evidence committed in 46ba353.
Setup: Ruling: native worktree .claude/worktrees/place-theme-repair on branch worktree-place-theme-repair from origin/master 369f29b, not .worktrees/ — harness-managed isolation is equivalent — cost if wrong: path only.
Setup: Ruling: per-task local commits on the feature branch (the approved plan has commit steps); no push, no merge — cost if wrong: branch reset.
Setup: baseline npm test 1299/1299 pass.
Pre-flight: T1->T2 buildTheme records (samples/aabb/outline/flatTop/mat flags/stats) consumed by every check: consistent.
Pre-flight: T3->T9 populateShelves({y0}) option: consistent (T9 passes y0 0.03).
Pre-flight: T4->T5..T19 code moves to theme-kit/grounds-ext/props-pets; later tasks locate by function name: consistent.
Pre-flight: T6->T7 spawn/frameX (starship -11.2/-11.82, dogs -10.8/-11.42) sized into T7 gangway/pad: consistent.
Pre-flight: T9->T12 palace globe y 1.60, hanok 1.57 used in T12 globe margins: consistent. T9->T16 hanok rail base y 0.03: consistent.
Pre-flight: T8 leaves div-* coverage for T18/T19: consistent. T11 adds 10th scrollScreen arg; callers updated in T11: consistent.
Pre-flight: T2 KNOWN 'expected today' counts are estimates; first-run counts are recorded by design.
Task 1: Ruling: stub math split into test/fixtures/three-record-math.mjs (three-record.mjs 349 + math 191 lines) — 450/500-line caps — cost if wrong: one extra fixture file.
Task 1: Ruling: geom-utils.mjs (convexHull etc.) created in Task 1 instead of Task 2 — records need XZ outlines now — cost if wrong: none.
Task 1: Ruling: Mesh default material is a white MeshBasicMaterial like three — dogs tennis-ball seam uses undefined M.white (three falls back to unlit white); fidelity required it — finding noted for dogs polish.
Task 1: fidelity: counts studio 273/office 245/palace 190/hanok 157/starship 152/dogs 170/cats 144 match; (type,colour) multisets match (LED colours normalised: browser animates them); non-rotated AABB delta <= 0.0005; residual deltas = doors open / globes spinning / browser Box3 looseness for rotated meshes.
Task 1: Ruling: snapshot differs run-to-run only in InstancedMesh counts (Math.random shelves) until Task 3 — expected — cost if wrong: none.
Task 1: complete (commits 46ba353..63f05e5, tests: npm test → # duration_ms 13293.608708)
Task 2: Ruling: check implementations live in test/fixtures/theme-checks.mjs (test files stay thin) — file-size rule — cost if wrong: none.
Task 2: Ruling: routeClear exempts door leaves and entrance hardware (aabb max x <= -11.0, |z| <= 1.6, top >= 2.0) — plan says frames/leaves exempt; dogs/cats spawn sits inside the frame (Task 6 owns that) — cost if wrong: a prop placed in the entrance zone would be missed.
Task 2: Ruling: alloc returns one entry per allocated geometry/material (studio/office 12 = 11 geometries + LineBasicMaterial) — plan said ~11 — cost if wrong: none.
Task 2: Ruling: ringClear also tests outline-vs-band overlap (stricter than samples only); counts equal the plan's (starship 3, dogs 2, cats 4).
Task 2: triage (new, not in audit): hanok north wall overhangs plinth (support 1, P2/Task 24); studio/office server desk leg 0.237 from route (3 mm); palace lantern poles end flush with lantern tops (coplanar 2) — Task 9 must keep them apart; dogs uses undefined M.white -> three default material allocated per rebuild (alloc:dogs 1); starship/dogs/cats research globes fail head clearance (unaudited, outside Tasks 1-19).
Task 2: sanity: KNOWN['shear:palace']=0 failed naming theme-grounds.js:188/189/190/209; reverted.
Task 2: complete (commits 63f05e5..da85b65, tests: npm test → # duration_ms 13034.4685)
Task 3: Ruling: populateShelves applies y0 now (book rows offset by y0 - 0.08; default 0.08 is byte-identical) instead of in Task 9 — one edit instead of two — cost if wrong: none.
Task 3: complete (commits da85b65..888ee21, tests: npm test → # duration_ms 14438.837625)
Task 4: Ruling: theme-kit.js also imports FLOOR_W/CORRIDOR from rooms.js (buildStandardPartitions needs them; no cycle) - cost if wrong: none.
Task 4: Ruling: theme-props.js imports themeMats from theme-kit.js instead of the theme-grounds re-export - avoids grounds/props coupling - cost if wrong: none.
Task 4: verify: snapshot before == after; browser load of all 7 themes: mesh counts unchanged, 0 console errors (preview serves the worktree on :4318).
Task 4: complete (commits 888ee21..984f304, tests: npm test → # duration_ms 13603.881667)
Task 5: verify: renders palace/hanok iso_se/iso_nw/iso_ne/entrance - hip roofs, no blades; palace eaves only over the colonnade (out/palace/T5_*.png).
Task 5: complete (commits 984f304..6fa8c2b, tests: npm test → # duration_ms 13088.995334)
Task 6: Ruling: departure hook kept to 2 lines so agent.js stays at 500 lines (global file cap) - cost if wrong: none.
Task 6: support known counts updated: starship 11->12 (new recess panel over the void until Task 7), dogs 9->8 (spawn/door at -10.8 now on the lawn edge; recess +1).
Task 6: verify: leave_probe dt 1/60 and 1/30 -> removed true in all 7 themes (palace/starship were false, stuck at x -11.65); open-door renders: leaves inside frames/gate posts, dark cab visible.
Task 6: complete (commits 6fa8c2b..8c16a85, tests: npm test → # duration_ms 13012.955792)
Task 7: Ruling: skipped the optional dogs path decal - YAGNI, plan marks it optional - cost if wrong: a cosmetic strip.
Task 7: residuals recorded: support starship 4 (force-field ends 2, plinths 2 -> Task 25), dogs 4 (cabinets 2, racks 2 -> Task 18). Renders: starship/dogs entrances on floor (out/*/T7_*.png).
Task 7: complete (commits 8c16a85..f3ee168, tests: npm test → # duration_ms 12975.129916)
Task 8: Ruling: cats bed back is 0.55 tall (plan said 0.3 = same as the seat, which reads as no backrest); still inside lounge-sofa box and under the 0.8 camera-edge rule - cost if wrong: one number.
Task 8: verify: renders hanok/starship/dogs/cats iso_se + lounge_e: rails with door gaps, seating visible (out/*/T8_*.png).
Task 8: complete (commits f3ee168..28941a8, tests: npm test → # duration_ms 13333.817375)
Task 9: Ruling: palace lantern poles shortened to 1.6 (top 1.63, ends inside the lantern 1.20..1.68) - the plan's 0.03/1.20 kept pole and lantern tops coplanar (Task 2 triage) - coplanar:palace 3 -> 1 - cost if wrong: one number.
Task 9: verify: browser analyzer palace/hanok raisedFloor 0, floating 0; hanok invisibleObstacle part-* 0.333 is the analyzer's 3-row grid vs thin rails (node centerline coverage passes); renders show feet on floors, flames seated (out/*/T9_*.png).
Task 9: complete (commits 28941a8..1ef8d20, tests: npm test → # duration_ms 13036.373041)
Task 10: verify: renders starship/dogs/cats center: vertical warp core, flat plaza, oval cat-tower base; ringClear 0 for all (out/*/T10_center.png).
Task 10: complete (commits 1ef8d20..7ecda31, tests: npm test → # duration_ms 13005.227458)
Task 11: Ruling: screenBack check probes depths 0.02..0.06 (step 0.01) instead of 0.03/0.055 - the plan's rule is 'within 0.06 behind'; the new back panel sits 0.035..0.055 behind the plane and 0.055 hit a float boundary - cost if wrong: a back panel 0.06+ behind would still pass.
Task 11: verify: renders from behind (palace/starship/cats dev, hanok desk): backs visible, bars seated (out/*/T11_*.png).
Task 11: complete (commits 7ecda31..49a60c1, tests: npm test → # duration_ms 13289.641292)
Task 12: also ratcheted routeClear:palace 1 -> 0 (same root cause: armillary pedestal 1.1 wide vs the old 1.0 box; triage note from Task 2).
Task 12: verify: browser-names route/slot tests pass with the wider boxes (no fallback needed).
Task 12: complete (commits 49a60c1..2496513, tests: npm test → # duration_ms 13021.500458)
Task 13: verify: leak_probe GPU geometries 49/50/51 over 3 cycles - split probe shows theme meshes reference a constant 33 geometries across 4 cycles; the +1/cycle tracks demo agents arriving (3->7), not themes. alloc:dogs 1 (undefined M.white material) left for dogs work.
Task 13: complete (commits 2496513..4541952, tests: npm test → # duration_ms 12962.734542)
Task 14: verify: renders studio room_archive (curved NW wall, bookcase clear), room_research + dish_sw (dish with feed arm from both angles), office room_research (same furniture) (out/studio|office/T14_*.png); support/coplanar studio 0.
Task 14: complete (commits 4541952..5266ae2, tests: npm test → # duration_ms 13040.597625)
Task 15: complete (commits 5266ae2..9078a29, tests: npm test → # duration_ms 13246.776417)
Task 16: complete (commits 9078a29..40fa715, tests: npm test → # duration_ms 13064.877042)
Task 17: complete (commits 40fa715..cbe9d9a, tests: npm test → # duration_ms 12799.6405)
Task 18: Ruling: added mats().white (lit MeshStandardMaterial) for the tennis-ball seam that referenced the undefined M.white - three silently created a new unlit default material on every rebuild (alloc:dogs 1 -> 0); the plan's Task 26 also assumes M.white exists - cost if wrong: seam shading changes from unlit to lit white.
Task 18: verify: renders dogs iso_se/room_archive/room_research (out/dogs/T18_*.png); hidden/support/coverage/alloc dogs 0.
Task 18: complete (commits cbe9d9a..d87a0ed, tests: npm test → # duration_ms 12809.286667)
Task 19: verify: browser load of all 7 themes 0 console errors; analyzer cats noSupport 0 / overhang 0 / raisedFloor 0; renders cats iso_se/top/room_research/room_desk/iso_nw show one cat-face outline, ears north, paws south, bell on the desk (out/cats/T19_*.png).
Task 19: complete (commits d87a0ed..13a6770, tests: npm test → # duration_ms 12834.15)
Final review: workflow of 3 independent reviewers (opus; lenses runtime / harness / plan) + adversarial verifier per Critical/Important finding. Verdicts: runtime "With fixes", harness "With fixes", plan "Yes". Critical: none. Important: 2, both confirmed by verifiers.
Final: fixed rt-01 lounge-seat departure vanished in place while the far elevator opened - "Agent.start: leaving from a lounge seat walks to the elevator instead of vanishing at the seat" RED->GREEN, suite 1324/1324; browser probe studio/palace/dogs: walks ~5 s, doors open at ~2.7 from the elevator, despawns at the spawn, never opens while far.
Final: fixed th-01 unimplemented three types fell through to a Proxy and vanished from every check - "three-record: unimplemented geometry, material and texture types fail loudly..." RED->GREEN, suite 1324/1324.
Final: minor (deferred): rt-02 Floor.update door pose hard-codes leaf size 0.85 / outer edge 0.885 / elevator z 0 (hanok builds 0.84, snaps on first frame).
Final: minor (deferred): th-02 + pl-01 routeClear entrance exemption is stale after Task 6 (removing it adds 0 failures); spawn-vs-frame constants are hand-derived.
Final: minor (deferred): th-03 props 0.3-0.5 m tall fall between floorTop (<=0.3) and routeClear (>=0.5).
Final: minor (deferred): th-04 KNOWN ratchet compares counts only; a fix and a new regression in the same theme/check cancel out.
Final: minor (deferred): th-05 theme-known.mjs header comment stale; globe:starship/dogs/cats entries need the measured overlap and an owner/issue.
Final: minor (deferred): th-06 stub simplifications (Extrude bevel/holes, Icosahedron detail>=2, screenBack grid in object units, shear skips baked) are correct today but should throw on unmodelled options.
Final: minor (deferred): pl-02 starship warp-core inlays top 0.078 vs the plan's walkable-top rule 0.06 (plan contradicts itself; Task 10 table followed); browser analyzer ringClearance still flags them.
Final: minor (deferred): pl-03 starship rail end posts 1.1 m vs camera rule 0.75; starship clip 11.2 leaves 0.8 m of part-* collision over the new gangway decks without a visible rail.
Final: minor (deferred): pl-04 analyzer part-* invisibleObstacle residual in hanok/starship/dogs (0.19-0.34) is the analyzer's 3-row grid against thin rails; node centreline coverage passes.
Final: minor (deferred): pl-05 cats bell comment names the hanok desk; cats ground header comment still describes the old ear-cone construction.
Final: Ruling: research globes in starship/dogs/cats still clip heads (-0.57/-0.24/-0.41 m) - outside Tasks 1-19 (unaudited), kept in KNOWN - cost if wrong: visible head clipping in those 3 themes until a follow-up.
Final: Ruling: userData.blink lamps never blink - predates branch, plan Task 20 (P2) - cost: static lamps.
Final: Ruling: scrollScreen 0.03 gap under the top bar, rugs/inlays 0.04-0.06 above feet - cosmetic, plan accepts y=0 feet - cost: none visible at iso zoom.
Final: Ruling: hidden floors (detail.js) do not count elevT down - predates branch - cost: a late door animation when a floor is re-shown.
Final: Ruling: board materials stay in scene.js GLOWING after Floor.dispose - old leak outside plan - cost: a few material refs per removed floor.
Final: Ruling: studio/hanok north/west walls block rooms from NE/NW cameras - predates branch; roofs changed here are narrower than before; Task 28 owns cutaway - cost: occlusion when users orbit north.
Final: Ruling: studio slab corner / server rack 0.2 past the shortened north-wall end - cosmetic, not reported as broken in audit - cost: none at default camera.
Final: Ruling: coplanar threshold 0.003 vs the 0.005 global rule; dogs plaza 0.004 gap is exactly what Task 10 specified - cost: possible faint shimmer on the dogs plaza rim at grazing angles.
Final: Ruling: globe check excludes the wireframe shell (LineSegments) per the plan's rule; studio/office shell may graze heads by ~2 cm - cost: negligible.
Final: Ruling: no floating-prop check (bottom above 0.12) and no CanvasTexture alloc count - not in the plan's check table; browser analyzer covers floating - cost: a new floating prop only shows in the browser audit.
Final: Ruling: no committed snapshot baseline - plan makes snapshot diffs a manual per-task step - cost: shared-helper refactors rely on review.
Final: Ruling: coplanar checks top faces only - plan's definition - cost: side-face z-fight not caught.
Final: Ruling: server-desk leg 0.237 from a route in studio/office - 3 mm under the 0.24 sampling radius, above the 0.2 collision radius - cost: none.
Final: Ruling: package.json engines >=22 vs local Node 20.20 - environment matter; per-file process isolation holds on both - cost: none.
Final: Ruling: simple-polygon test detects proper crossings only - outline is generated and containment margins pass - cost: a collinear overlap would go unnoticed.
Final: Ruling: hard-coded 1.88/0.92 corridor bands in ringLanes match obstaclesOf today - cost: must be updated if the corridor boxes change.
Final: Ruling: hanok gate posts past the -11.65 clamp and palace gate leaves behind it (analyzer walkThrough) - unreachable by agents, predates branch - cost: none.
Final: Ruling: cats desk-main box east strip lost its visible coverage when the floor bell moved onto the desk (plan Task 19) - no route reaches it - cost: none.
Final: Ruling: hanok research-globe box mostly empty at floor level (analyzer 0.327) - intentional head-clearance halo (Task 12) - cost: agents detour slightly wider.
Final: Ruling: starship deck seam where gangway meets the octagon - Task 25 (P2) - cost: thin seam line.
Final: Ruling: studio/office dev box and desk plant walk-through, dev-desks/meeting-board coverage gaps - predate branch, Tasks 21/22 (P2) - cost: agents brush those props.
Final: Ruling: Task 13 browser GPU geometry +1/cycle attributed to demo agents (theme meshes reference a constant 33 geometries over 4 cycles; node alloc 0) - cost if wrong: a slow leak per theme switch.
Final: Ruling: follow-up issue for unaudited globes and PR triage list are process steps for PR time - no PR yet - cost: none until a PR is opened.
Final: Ruling: per-task local commits accepted as within the approved plan - nothing pushed - cost: branch reset if unwanted.
