import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLYWHEEL_SIGNAL_KINDS,
  FINGERPRINT_RE,
} from '../src/flywheel/types.mjs';
import {
  classifySignalTrack,
  computeSignalFingerprint,
  formatLinearTicketDraft,
  normalizeSignature,
  priorityRankForKind,
  routeFlywheelSignals,
} from '../src/flywheel/router.mjs';
import { collectRuntimeSignals } from '../src/flywheel/collectors.mjs';

describe('Flywheel Router & 3-Layer Deduplication (L3 -> Dedup)', () => {
  it('assigns P1..P8 priority ranks deterministically across all 8 signal kinds', () => {
    assert.equal(FLYWHEEL_SIGNAL_KINDS.length, 8);
    assert.equal(priorityRankForKind('privacy_guard'), 1);
    assert.equal(priorityRankForKind('runner_health'), 2);
    assert.equal(priorityRankForKind('tailer_integrity'), 3);
    assert.equal(priorityRankForKind('permission_wait'), 4);
    assert.equal(priorityRankForKind('sse_backpressure'), 5);
    assert.equal(priorityRankForKind('session_recap'), 6);
    assert.equal(priorityRankForKind('adapter_conformance'), 7);
    assert.equal(priorityRankForKind('dom_entropy'), 8);
  });

  it('normalizes volatile ISO timestamps and ms latencies into stable 24-hex SHA-256 fingerprints', () => {
    const sigA = normalizeSignature('Runner codex lag 540ms at 2026-10-29T08:00:00.123Z');
    const sigB = normalizeSignature('Runner codex lag 1290ms at 2026-10-29T09:15:30Z');
    assert.equal(sigA, sigB);

    const fpA = computeSignalFingerprint({
      kind: 'sse_backpressure',
      capabilityId: 'http-sse',
      primaryKey: 'runner-scan-latency',
      signature: sigA,
    });
    const fpB = computeSignalFingerprint({
      kind: 'sse_backpressure',
      capabilityId: 'http-sse',
      primaryKey: 'runner-scan-latency',
      signature: sigB,
    });
    assert.match(fpA, FINGERPRINT_RE);
    assert.equal(fpA, fpB);
  });

  it('classifies signals into Tier A (runbook), Tier B (agent code fix), and Tier C (human escalation)', () => {
    assert.equal(
      classifySignalTrack({ kind: 'privacy_guard', capabilityId: 'privacy-guard', primaryKey: 'rejected-refs' }),
      'tier_c',
    );
    assert.equal(
      classifySignalTrack({ kind: 'runner_health', capabilityId: 'adapters', primaryKey: 'codex' }),
      'tier_a',
    );
    assert.equal(
      classifySignalTrack({ kind: 'adapter_conformance', capabilityId: 'adapters', primaryKey: 'wire-shape-drift' }),
      'tier_b',
    );
  });

  it('collapses Layer 1 in-batch duplicates and applies 2-tick warn debounce for P3..P8', async () => {
    const rawBatch = [
      {
        kind: 'tailer_integrity',
        capabilityId: 'tailer-store',
        primaryKey: 'jsonl-tailer',
        title: 'JSONL tailer framing anomalies',
        summary: 'badLines=2',
        severity: 'warn',
        signature: 'tailer_integrity:bad=true',
      },
      {
        kind: 'tailer_integrity',
        capabilityId: 'tailer-store',
        primaryKey: 'jsonl-tailer',
        title: 'JSONL tailer framing anomalies',
        summary: 'badLines=3',
        severity: 'warn',
        signature: 'tailer_integrity:bad=true',
      },
    ];

    // Tick 1: P3 warn signal is debounced (status='debouncing', no dry-run recommendation yet)
    const tick1 = await routeFlywheelSignals({
      rawSignals: rawBatch,
      existingLedger: {},
      nowIso: '2026-10-29T10:00:00.000Z',
    });
    assert.equal(tick1.routedSignals.length, 1);
    assert.equal(tick1.dedupSuppressedCount, 1);
    const sig1 = tick1.routedSignals[0];
    assert.equal(sig1.status, 'debouncing');
    assert.equal(sig1.debounced, true);
    assert.equal(sig1.occurrenceCount, 2);
    assert.equal(sig1.consecutiveCount, 1);
    assert.equal(sig1.recommendedAction, null);

    // Tick 2: Consecutive warn promotes to 'open' and attaches Tier A dry_run recommendation
    const tick2 = await routeFlywheelSignals({
      rawSignals: [rawBatch[0]],
      existingLedger: tick1.updatedLedger,
      nowIso: '2026-10-29T10:30:00.000Z',
    });
    const sig2 = tick2.routedSignals[0];
    assert.equal(sig2.status, 'open');
    assert.equal(sig2.debounced, false);
    assert.equal(sig2.occurrenceCount, 3);
    assert.equal(sig2.consecutiveCount, 2);
    assert.equal(sig2.recommendedAction?.status, 'pending_approval');
    assert.equal(sig2.recommendedAction?.runbookId, 'start_diagnostic_observe');
  });

  it('triggers immediately on tick 1 for P1/P2 or fail severity, auto-resolves on recovery, and flags 72h regressions', async () => {
    const p2Signal = {
      kind: 'runner_health',
      capabilityId: 'adapters',
      primaryKey: 'grok',
      title: 'Adapter grok scan error (EACCES)',
      summary: 'Runner grok reported scanErr=EACCES',
      severity: 'warn',
      signature: 'runner_health:grok:scanErr:EACCES',
    };

    // Tick 1: P2 triggers immediately without debounce
    const t1 = await routeFlywheelSignals({
      rawSignals: [p2Signal],
      existingLedger: {},
      nowIso: '2026-10-29T00:00:00.000Z',
    });
    const fp = t1.routedSignals[0].fingerprint;
    assert.equal(t1.updatedLedger[fp].status, 'open');
    assert.equal(t1.updatedLedger[fp].debounced, false);
    assert.equal(t1.updatedLedger[fp].recommendedAction?.status, 'pending_approval');

    // Tick 2: Empty batch resolves the signal and auto-cancels pending dry-run
    const t2 = await routeFlywheelSignals({
      rawSignals: [],
      existingLedger: t1.updatedLedger,
      nowIso: '2026-10-29T01:00:00.000Z',
    });
    assert.equal(t2.resolvedThisTickCount, 1);
    assert.equal(t2.updatedLedger[fp].status, 'resolved');
    assert.equal(t2.updatedLedger[fp].recommendedAction?.status, 'auto_cancelled');

    // Tick 3 (24h later, within 72h window): Re-appearance marks regression=true and prepends [Regression]
    const t3 = await routeFlywheelSignals({
      rawSignals: [p2Signal],
      existingLedger: t2.updatedLedger,
      nowIso: '2026-10-30T01:00:00.000Z',
    });
    assert.equal(t3.updatedLedger[fp].status, 'open');
    assert.equal(t3.updatedLedger[fp].regression, true);
    assert.match(t3.updatedLedger[fp].title, /^\[Regression\] /);
  });

  it('enforces Layer 3 Linear [flywheel:<fingerprint>] marker check before creating tickets', async () => {
    const calls = { find: 0, create: 0 };
    const fakeLinear = {
      async findOpenIssueByMarker(marker) {
        calls.find += 1;
        if (calls.find === 1) return null;
        return { id: 'lin_1', identifier: 'GLO-777', url: 'https://linear.app/issue/GLO-777', marker };
      },
      async createIssue(draft) {
        calls.create += 1;
        return { id: 'lin_1', identifier: 'GLO-777', url: 'https://linear.app/issue/GLO-777', title: draft.title };
      },
    };

    const failSignal = {
      kind: 'adapter_conformance',
      capabilityId: 'adapters',
      primaryKey: 'wire-shape-drift',
      title: 'Adapter wire observation drift',
      summary: 'Observe sidecar recorded 6 errors',
      severity: 'fail',
      signature: 'adapter_conformance:obsErr=true',
    };

    const first = await routeFlywheelSignals({
      rawSignals: [failSignal],
      existingLedger: {},
      config: { enabled: true, autoCreateLinearTicket: true },
      linearClient: fakeLinear,
    });
    assert.equal(first.linearCreatedCount, 1);
    assert.equal(first.routedSignals[0].linearIssueIdentifier, 'GLO-777');
    const draft = formatLinearTicketDraft(first.routedSignals[0]);
    assert.ok(draft.description.includes(`[flywheel:${first.routedSignals[0].fingerprint}]`));

    // Even if local ledger lost the linearIssueIdentifier, Layer 3 remote marker lookup prevents duplicate creation
    const strippedLedger = structuredClone(first.updatedLedger);
    for (const v of Object.values(strippedLedger)) {
      v.linearIssueIdentifier = null;
    }
    const second = await routeFlywheelSignals({
      rawSignals: [failSignal],
      existingLedger: strippedLedger,
      config: { enabled: true, autoCreateLinearTicket: true },
      linearClient: fakeLinear,
    });
    assert.equal(second.linearCreatedCount, 0);
    assert.equal(second.routedSignals[0].linearIssueIdentifier, 'GLO-777');
  });

  it('collects privacy-scrubbed runtime candidates without leaking paths or secrets', () => {
    const { candidates, componentSummaries } = collectRuntimeSignals({
      healthSnapshot: {
        commit: 'a1b2c3d',
        rejectedRefs: 2,
        badLines: 4,
        skippedLines: 1,
        runners: {
          'claude-code': { files: 3, scanErr: null, loopErrors: 0, applyErrors: 0, linkErrors: 0, lastScanMs: 42 },
          codex: { files: 1, scanErr: '/Users/secret/path/leak', loopErrors: 1, applyErrors: 0, linkErrors: 0, lastScanMs: 620 },
        },
      },
      sseMetrics: { crossSiteBlocks: 1, droppedClients: 2 },
    });

    const serialized = JSON.stringify({ candidates, componentSummaries });
    assert.equal(serialized.includes('/Users/secret'), false);
    assert.ok(candidates.some((c) => c.kind === 'privacy_guard'));
    assert.ok(candidates.some((c) => c.kind === 'runner_health' && c.title.includes('EUNKNOWN')));
    assert.ok(candidates.some((c) => c.kind === 'tailer_integrity'));
    assert.ok(candidates.some((c) => c.kind === 'sse_backpressure'));
  });
});
