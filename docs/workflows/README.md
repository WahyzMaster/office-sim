# Wahyz Standard Workflows — Visualized HTML Guides (`office-sim`)

Interactive standalone HTML guides (generated and validated via `archify`) documenting the 6-phase `/standard-workflow` conductor (`P0 INTAKE -> P5 SHIP & LAND`), the 7-stage `ship-and-land` worktree lifecycle, and the **Post-Merge Deployment Only (`P5`)** invariant:

- [STANDARD_WORKFLOW_HANDBOOK.html](./STANDARD_WORKFLOW_HANDBOOK.html) -- Master end-to-end handbook covering `P0 INTAKE -> P5 SHIP & LAND`, Prompt & L3 Operational Signal triggers, 4 Delivery Pillars, and 7-stage PR landing (`GLO-1155`)
- [STANDARD_WORKFLOW_ARCHITECTURE.html](./STANDARD_WORKFLOW_ARCHITECTURE.html) -- Interactive system architecture diagram showing `INV` (`wahyz_agent_profile`) and `DOM` boundaries and hook back-edges
- [WORKFLOW_TRIGGER_CONDUCTOR_GUIDE.html](./WORKFLOW_TRIGGER_CONDUCTOR_GUIDE.html) -- Deep-dive visual explainer for the `standard-workflow` skill and 3 trigger channels
- [SHIP_AND_LAND_LIFECYCLE_GUIDE.html](./SHIP_AND_LAND_LIFECYCLE_GUIDE.html) -- Visual explainer for the 7-Stage Git, PR, Merge Queue & Safe Worktree Cleanup lifecycle (`ship-and-land` + `worktree_land.sh`)
- [DEPLOY_AFTER_MERGE_REVIEW.html](./DEPLOY_AFTER_MERGE_REVIEW.html) -- Visual explainer for the `P5` Post-Merge Deployment Only invariant (`Worktree Edits [P1-P4] <-> Primary Checkout Deploys [P5]`, `deploy-check` gate, and cross-worktree override prevention)
- [P5_HARDENING_REVIEW.html](./P5_HARDENING_REVIEW.html) -- Visual explainer for `P5` Merge Queue wait polling (`worktree_land.sh land --wait`), chained teardown hook guards, and unified `worktree_land.sh preflight` gates
