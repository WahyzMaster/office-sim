---
name: office-flywheel
description: Execute the Office Sim Improvement & Revision Flywheel (L3 -> Dedup & Linear -> L1 -> L2). Use when triaging runtime signals from /api/flywheel, approving Tier A dry-run runbooks, seeding L1 Loop Contracts, recording attempt friction, promoting code-anchored L2 lessons (schema: harness2-v1), or attaching refs/notes/evidence envelopes.
---

# Office Sim Improvement & Revision Flywheel (`L3 -> Dedup -> L1 -> L2`)

## 1. 8-Source Priority Matrix (`P1..P8`)

| Priority | Signal Kind (`kind`) | Primary Capability | Autonomy Track |
|---|---|---|---|
| `P1` | `privacy_guard` | `privacy-guard` | `tier_c` (Human Escalation) |
| `P2` | `runner_health` | `adapters` | `tier_a` (Safe Dry-Run Runbook) |
| `P3` | `tailer_integrity` | `tailer-store` | `tier_a` (Safe Dry-Run Runbook) |
| `P4` | `permission_wait` | `observe-sidecar` | `tier_a` (Safe Dry-Run Runbook) |
| `P5` | `sse_backpressure` | `http-sse` | `tier_a` (Safe Dry-Run Runbook) |
| `P6` | `session_recap` | `session-recap` | `tier_b` (Agent Code Fix) |
| `P7` | `adapter_conformance` | `adapters` | `tier_b` (Agent Code Fix) |
| `P8` | `dom_entropy` | `dom-harness` | `tier_a` (Safe Dry-Run Runbook) |

## 2. Deduplication, Debounce & 72h Regression Rules

1. **Deterministic 24-Hex Fingerprint**: `sha256(kind:capabilityId:primaryKey:normalizedSignature).slice(0, 24)` (`src/flywheel/router.mjs`).
2. **2-Tick Warn Debounce**: `P3..P8` `warn` signals enter `debouncing` on tick 1 and promote to `open` only on tick 2. `P1`, `P2`, and any `fail` severity trigger immediately on tick 1.
3. **3-Layer Deduplication Barrier**:
   - Layer 1: In-batch fingerprint collapse.
   - Layer 2: Active ledger lookup (`occurrenceCount` increments without duplicate tickets).
   - Layer 3: Linear `[flywheel:<24-hex-fingerprint>]` marker lookup before creating an issue.
4. **72-Hour Regression Window**: Signals recurring within 72 hours of `resolvedAt` are tagged `[Regression]`.

## 3. CLI Workflow (`L3 -> L1 -> L2`)

### Step 1: Seed an L1 Loop Contract from an L3 Signal
```bash
node scripts/flywheel/seed-loop-contract.mjs \
  --issue GLO-123 \
  --signal-kind adapter_conformance \
  --primary-key wire-shape-drift \
  --out .worktrees/flywheel/.loop-contract.md
```

### Step 2: Record Verification Attempts & Detect Repeated Friction
```bash
node scripts/flywheel/loop-attempt-ledger.mjs \
  --contract .worktrees/flywheel/.loop-contract.md \
  --gate "node --test test/adapter-codex-conformance.test.mjs" \
  --outcome fail \
  --friction-class missing-context \
  --notes "Missing rollout tool_end mapping"
```

### Step 3: Promote Code-Anchored L2 Lesson (`schema: harness2-v1`)
When `detectRepeatedFriction` reports `requiresL2Promotion: true` ($\ge 2$ occurrences of the same friction class), promote a lesson along the cost hierarchy (`skill -> script -> subagent -> hook -> gate -> memory -> always-on`):
```bash
node scripts/flywheel/promote-lesson.mjs \
  --id codex-rollout-tool-end \
  --dimension DOM \
  --component skill \
  --cue "Codex adapter misses tool_end when rollout item is truncated" \
  --lesson "Check src/adapters/codex/parse.mjs before adding new tool state transitions" \
  --evidence "Verified in test/adapter-codex-conformance.test.mjs" \
  --anchor "src/adapters/codex/parse.mjs#parseCodexLine"
```

### Step 4: Attach `refs/notes/evidence` Envelope
```bash
node scripts/flywheel/evidence-notes.mjs write \
  --issue GLO-123 \
  --signal-kind adapter_conformance \
  --gate "npm test:pass:1200" \
  --gate "node scripts/verify-dom-invariants.mjs:pass:80"
```
