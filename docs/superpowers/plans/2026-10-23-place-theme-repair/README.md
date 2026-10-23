# Place theme repair: audit evidence

Companion folder for `../2026-10-23-place-theme-repair.md`. Referred to as `$AUDIT` in the plan.

| Path | Contents |
|---|---|
| `audit/verified-audit.json` | 103 kept findings across 7 themes plus cross-cutting ones, each with evidence, root cause, fix and the adversarial verifier's verdict and corrections; per-theme improvement sketches; 1 refuted item. Image paths under `$AUDIT_OUT/` point at renders from the audit session that were not kept; regenerate them with the tools. |
| `audit/REPORT.txt`, `audit/summary.json` | Deterministic geometry audit (commit 369f29b): floating, hidden, interpenetrating, invisible-collision, walk-through, raised-floor and ring-clearance hits, each with its creating source line. |
| `audit/geometry-<theme>.json` | World-space AABB, geometry type and colour of every mesh per theme (Task 1 fidelity check). |
| `reference/before-<theme>-iso_se.jpg` | Default-camera render of every theme before any fix. |
| `reference/<theme>-EXPERIMENT_*.jpg`, `reference/<theme>-audit_*.jpg` | In-page fix experiments the plan cites as targets. |
| `reference/before-after-iso_se.jpg` | All 7 themes at the default camera before the repair (left) and after Tasks 1-19 (right). |
| `execution-ledger.md` | Execution record of Tasks 1-19: per-task completion lines, every ruling that deviated from the plan with its cost, and the final review's fixes, deferred minors and rulings. |
| `tools/` | `capture_themes.py` (19 views per theme), `analyze_themes.py` + `report.py` (geometry audit), `multishot.py` (views with an optional in-page patch), `leave_probe3.py`, `leak_probe.py`, `doors_hold_open.js`. |

Requirements: Python 3 with Playwright (`pip install playwright && playwright install chromium`) and a running office-sim server. Example:

```bash
python3 -I tools/analyze_themes.py http://localhost:4319/ "${TMPDIR:-/tmp}/office-sim-theme-audit/analysis"
```
