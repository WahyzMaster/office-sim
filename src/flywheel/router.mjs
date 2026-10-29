// Office Sim Improvement & Revision Flywheel Router (L3 -> Dedup & Linear -> L1).
// Ported from wahyz_omni tools/loop/flywheel_router.mjs & functions-ksm/src/healthChecks/flywheel/flywheelEngine.ts.
//
// Responsibilities:
// 1. Deterministic 24-hex SHA-256 signal fingerprinting across all 8 signal kinds.
// 2. 2-tick debounce on warn signals (fail and P1/P2 signals trigger immediately on tick 1).
// 3. 3-Layer Deduplication Barrier + 72-hour regression detection ([Regression] marker):
//    - Layer 1: In-batch fingerprint collapse
//    - Layer 2: Persistent ledger state check (increments occurrenceCount if active)
//    - Layer 3: Linear [flywheel:<fingerprint>] marker check before ticket creation
// 4. Safe Rollout: Tier A operational runbooks default to "dry_run" (pending_approval).
// 5. Auto-resolution: Signals absent in the latest scan transition to 'resolved' and cancel stale dry-runs.

import { createHash } from 'node:crypto';
import {
  DEFAULT_FLYWHEEL_CONFIG,
  FLYWHEEL_SIGNAL_KINDS,
  SIGNAL_KIND_CAPABILITY_MAP,
  TIER_A_RUNBOOKS,
  TIER_C_CAPABILITIES,
} from './types.mjs';

export function priorityRankForKind(kind) {
  const idx = FLYWHEEL_SIGNAL_KINDS.indexOf(kind);
  return idx >= 0 ? idx + 1 : 8;
}

export function normalizeSignature(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<iso>')
    .replace(/\b\d+ms\b/g, '<ms>')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

export function computeSignalFingerprint({
  kind,
  capabilityId,
  primaryKey,
  signature = '',
}) {
  const resolvedCap =
    capabilityId
    ?? SIGNAL_KIND_CAPABILITY_MAP[kind]?.primary
    ?? 'unknown';
  const payload = [
    String(kind ?? 'unknown').trim(),
    String(resolvedCap).trim(),
    String(primaryKey ?? 'default').trim(),
    normalizeSignature(signature),
  ].join(':');
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function classifySignalTrack({ kind, capabilityId, primaryKey }) {
  const resolvedCap =
    capabilityId
    ?? SIGNAL_KIND_CAPABILITY_MAP[kind]?.primary
    ?? 'unknown';
  if (kind === 'privacy_guard' || TIER_C_CAPABILITIES.has(resolvedCap)) {
    return 'tier_c';
  }
  if (TIER_A_RUNBOOKS[kind] || TIER_A_RUNBOOKS[primaryKey]) {
    return 'tier_a';
  }
  return 'tier_b';
}

export function buildDryRunRecommendation({
  kind,
  primaryKey,
  capabilityId,
  tierAMode = 'dry_run',
}) {
  const spec = TIER_A_RUNBOOKS[kind] ?? TIER_A_RUNBOOKS[primaryKey] ?? {
    runbookId: `rerun_${kind}_probe`,
    title: `${capabilityId} 상태 재검증 프로브 실행`,
    titleEn: `Re-verify ${capabilityId} probe`,
    dryRunPreview: `Dry-Run: ${capabilityId} (${primaryKey}) 대상 비파괴 상태 점검을 1회 실행합니다.`,
    dryRunPreviewEn: `Dry-Run: Runs a single non-destructive health probe for ${capabilityId} (${primaryKey}).`,
  };
  return {
    runbookId: spec.runbookId,
    title: spec.title,
    titleEn: spec.titleEn ?? spec.title,
    dryRunPreview: spec.dryRunPreview,
    dryRunPreviewEn: spec.dryRunPreviewEn ?? spec.dryRunPreview,
    targetSubsystem: String(primaryKey || capabilityId),
    status: tierAMode === 'auto_execute' ? 'auto_executed' : 'pending_approval',
    approvedBy: null,
    approvedAt: null,
    executionResult:
      tierAMode === 'auto_execute'
        ? 'Auto-executed by Tier A policy'
        : null,
  };
}

export function buildSeedContractCommand(signal) {
  const issue = signal.linearIssueIdentifier || 'GLO-TBD';
  return `node scripts/flywheel/seed-loop-contract.mjs --issue ${issue} --signal-kind ${signal.kind} --primary-key ${signal.primaryKey}`;
}

export function formatLinearTicketDraft(signal) {
  const marker = `[flywheel:${signal.fingerprint}]`;
  const recSection = signal.recommendedAction
    ? [
      '### Tier A Safe Rollout Recommendation (Dry-Run)',
      `- **Runbook:** \`${signal.recommendedAction.runbookId}\` (${signal.recommendedAction.title})`,
      `- **Preview:** ${signal.recommendedAction.dryRunPreview}`,
      `- **Status:** \`${signal.recommendedAction.status}\` (Approve in Office Sim Flywheel HUD)`,
      '',
    ].join('\n')
    : '';

  return {
    marker,
    title: `[Flywheel][P${signal.priorityRank}][${signal.kind}] ${signal.capabilityId}: ${signal.title}`,
    description: [
      marker,
      '',
      `- **Signal Kind:** \`${signal.kind}\` (Priority P${signal.priorityRank})`,
      `- **Capability:** \`${signal.capabilityId}\``,
      `- **Primary Key:** \`${signal.primaryKey}\``,
      `- **Track:** \`${signal.track}\``,
      `- **Severity:** \`${signal.severity}\``,
      `- **Occurrences:** \`${signal.occurrenceCount}\``,
      signal.regression ? '- **Regression:** Detected within 72h recovery window' : '',
      '',
      '### Summary',
      signal.summary,
      '',
      recSection,
      '### Seed Loop Contract',
      `\`${buildSeedContractCommand(signal)}\``,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function isWithinRegressionWindow(resolvedAtIso, nowIso, windowHours = 72) {
  if (!resolvedAtIso || !nowIso) return false;
  const resolvedMs = Date.parse(resolvedAtIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(resolvedMs) || !Number.isFinite(nowMs)) return false;
  const elapsedMs = nowMs - resolvedMs;
  return elapsedMs >= 0 && elapsedMs <= windowHours * 3600_000;
}

/**
 * Executes the 3-layer deduplication + 2-tick warn debounce + 72h regression check
 * + Tier A/B/C routing over a batch of raw incoming signals.
 */
export async function routeFlywheelSignals({
  rawSignals = [],
  existingLedger = {},
  config = DEFAULT_FLYWHEEL_CONFIG,
  nowIso = new Date().toISOString(),
  linearClient = null,
} = {}) {
  const effectiveConfig = {
    ...DEFAULT_FLYWHEEL_CONFIG,
    ...config,
    enabledSources: {
      ...DEFAULT_FLYWHEEL_CONFIG.enabledSources,
      ...(config?.enabledSources ?? {}),
    },
  };

  if (!effectiveConfig.enabled) {
    return {
      updatedLedger: { ...existingLedger },
      scannedSignalsCount: 0,
      dedupSuppressedCount: 0,
      linearCreatedCount: 0,
      dryRunPendingCount: 0,
      resolvedThisTickCount: 0,
      routedSignals: [],
    };
  }

  // Layer 1: In-batch deduplication by deterministic fingerprint
  const batchByFingerprint = new Map();
  let batchSuppressed = 0;

  for (const raw of rawSignals) {
    if (!raw || !effectiveConfig.enabledSources[raw.kind]) continue;
    const capabilityId =
      raw.capabilityId
      ?? SIGNAL_KIND_CAPABILITY_MAP[raw.kind]?.primary
      ?? 'dom-harness';
    const primaryKey = String(raw.primaryKey ?? raw.kind ?? 'default').trim();
    const fingerprint =
      raw.fingerprint
      ?? computeSignalFingerprint({
        kind: raw.kind,
        capabilityId,
        primaryKey,
        signature: raw.signature ?? raw.summary ?? raw.title,
      });

    if (batchByFingerprint.has(fingerprint)) {
      const prev = batchByFingerprint.get(fingerprint);
      prev.batchHits += 1;
      batchSuppressed += 1;
      if (raw.severity === 'fail') prev.severity = 'fail';
    } else {
      batchByFingerprint.set(fingerprint, {
        ...raw,
        capabilityId,
        primaryKey,
        fingerprint,
        batchHits: 1,
      });
    }
  }

  const nextLedger = { ...existingLedger };
  const activeFingerprintsThisTick = new Set();
  const routedSignals = [];
  let dedupSuppressedCount = batchSuppressed;
  let linearCreatedCount = 0;

  for (const [fingerprint, candidate] of batchByFingerprint.entries()) {
    activeFingerprintsThisTick.add(fingerprint);
    const prior = nextLedger[fingerprint] ?? null;
    const priorityRank = priorityRankForKind(candidate.kind);
    const track = classifySignalTrack({
      kind: candidate.kind,
      capabilityId: candidate.capabilityId,
      primaryKey: candidate.primaryKey,
    });

    const isExistingActive = Boolean(prior && prior.status !== 'resolved');
    const wasRecentlyResolved = Boolean(
      prior
      && prior.status === 'resolved'
      && isWithinRegressionWindow(
        prior.resolvedAt ?? prior.lastSeenAt,
        nowIso,
        effectiveConfig.regressionWindowHours ?? 72,
      ),
    );
    const regression = isExistingActive ? Boolean(prior.regression) : wasRecentlyResolved;

    const occurrenceCount =
      (isExistingActive ? prior.occurrenceCount : 0) + candidate.batchHits;
    const consecutiveCount =
      (isExistingActive ? prior.consecutiveCount : 0) + 1;

    // 2-tick debounce for warn signals (fail and P1/P2 signals trigger immediately)
    const requiresTwoTickDebounce =
      candidate.severity === 'warn' && priorityRank > 2;
    const debounced = requiresTwoTickDebounce && consecutiveCount < 2;

    if (isExistingActive && prior.occurrenceCount >= 1) {
      dedupSuppressedCount += 1;
    }

    const baseTitle = String(candidate.title ?? candidate.kind).replace(/^\[(?:회귀 감지|Regression)\]\s*/i, '');
    const title = regression ? `[Regression] ${baseTitle}` : baseTitle;

    const recommendedAction =
      track === 'tier_a' && !debounced
        ? (isExistingActive && prior.recommendedAction && prior.recommendedAction.status !== 'auto_cancelled'
          ? prior.recommendedAction
          : buildDryRunRecommendation({
            kind: candidate.kind,
            primaryKey: candidate.primaryKey,
            capabilityId: candidate.capabilityId,
            tierAMode: effectiveConfig.tierAMode,
          }))
        : null;

    const entry = {
      fingerprint,
      kind: candidate.kind,
      priorityRank,
      capabilityId: candidate.capabilityId,
      primaryKey: candidate.primaryKey,
      title,
      summary: String(candidate.summary ?? title),
      severity: candidate.severity === 'fail' ? 'fail' : 'warn',
      track,
      status: debounced
        ? 'debouncing'
        : (isExistingActive && prior.status !== 'debouncing'
          ? prior.status
          : 'open'),
      occurrenceCount,
      consecutiveCount,
      debounced,
      regression,
      linearIssueId: isExistingActive ? (prior.linearIssueId ?? null) : null,
      linearIssueIdentifier: isExistingActive ? (prior.linearIssueIdentifier ?? null) : null,
      linearIssueUrl: isExistingActive ? (prior.linearIssueUrl ?? null) : null,
      gitSha: candidate.gitSha ?? (isExistingActive ? prior.gitSha : null) ?? null,
      firstSeenAt: isExistingActive ? prior.firstSeenAt : nowIso,
      lastSeenAt: nowIso,
      resolvedAt: null,
      recommendedAction,
      seedCommand: '',
    };
    entry.seedCommand = buildSeedContractCommand(entry);

    // Layer 2 & Layer 3: Only create a Linear ticket when not debounced,
    // autoCreateLinearTicket is true, and no active ticket is linked yet.
    if (
      !debounced
      && effectiveConfig.autoCreateLinearTicket
      && !entry.linearIssueIdentifier
      && linearClient
    ) {
      const draft = formatLinearTicketDraft(entry);
      const existingRemote = await linearClient.findOpenIssueByMarker(draft.marker);
      if (existingRemote) {
        entry.linearIssueId = existingRemote.id;
        entry.linearIssueIdentifier = existingRemote.identifier;
        entry.linearIssueUrl = existingRemote.url;
        entry.status = 'triaged';
        entry.seedCommand = buildSeedContractCommand(entry);
        dedupSuppressedCount += 1;
      } else {
        const created = await linearClient.createIssue(draft);
        if (created) {
          entry.linearIssueId = created.id;
          entry.linearIssueIdentifier = created.identifier;
          entry.linearIssueUrl = created.url;
          entry.status = 'triaged';
          entry.seedCommand = buildSeedContractCommand(entry);
          linearCreatedCount += 1;
        }
      }
    }

    nextLedger[fingerprint] = entry;
    routedSignals.push(entry);
  }

  // Stage 6: Mark previously-open signals that did not appear in this scan as resolved
  let resolvedThisTickCount = 0;
  for (const [fp, existing] of Object.entries(nextLedger)) {
    if (!activeFingerprintsThisTick.has(fp) && existing.status !== 'resolved') {
      resolvedThisTickCount += 1;
      const cleanedAction =
        existing.recommendedAction?.status === 'pending_approval'
          ? { ...existing.recommendedAction, status: 'auto_cancelled' }
          : existing.recommendedAction;
      nextLedger[fp] = {
        ...existing,
        status: 'resolved',
        debounced: false,
        consecutiveCount: 0,
        resolvedAt: nowIso,
        recommendedAction: cleanedAction ?? null,
      };
    }
  }

  const dryRunPendingCount = Object.values(nextLedger).filter(
    (s) =>
      s.status !== 'resolved'
      && s.recommendedAction?.status === 'pending_approval',
  ).length;

  return {
    updatedLedger: nextLedger,
    scannedSignalsCount: rawSignals.length,
    dedupSuppressedCount,
    linearCreatedCount,
    dryRunPendingCount,
    resolvedThisTickCount,
    routedSignals,
  };
}
