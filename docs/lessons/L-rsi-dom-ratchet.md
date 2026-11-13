---
schema: harness2-v1
id: "L-rsi-dom-ratchet"
dimension: DOM
component: gate
cue: "Adding features to near-cap modules (>450L) or modifying flywheel audit/ratchet paths"
confidence: 0.90
verdict: promote
created_at: "2026-11-13T02:49:45.145Z"
code_anchors:
  - "src/flywheel/dom-audit.mjs#auditDomHealth"
  - "scripts/flywheel/rsi-eval.mjs#verifyRsiRatchet"
---

# Lesson: L-rsi-dom-ratchet (DOM / gate)

## Cue
Adding features to near-cap modules (>450L) or modifying flywheel audit/ratchet paths

## Lesson
Share pure auditDomHealth between CLI verify-dom-invariants and live server runbooks, and ratify multi-cycle edits with verifyRsiRatchet so nearCapFiles (>450L) and protected verifier hashes never regress.

## Evidence
GLO-1250 RSI Cycles 1-3 reduced nearCapFiles 19->14 and criticalCapFiles 10->6 while preserving zero runtime dependencies.

## Code Anchors
- `src/flywheel/dom-audit.mjs#auditDomHealth`
- `scripts/flywheel/rsi-eval.mjs#verifyRsiRatchet`
