// Privacy-scrubbed L3 runtime signal collectors for the Office Sim Improvement Flywheel.
// Converts in-memory /healthz counters, ObserveControl tallies, SessionRecapTracker summaries,
// SSE backpressure counters, and DOM invariant metrics into RawFlywheelCandidate[] and 8-source snapshots.
// Strictly enforces CONTRACT.md section 5: only counts, uppercase error codes, and capability/adapter IDs.

import {
  CODE_RE,
  FLYWHEEL_SIGNAL_KINDS,
  SAFE_KEY_RE,
  SIGNAL_KIND_CAPABILITY_MAP,
} from './types.mjs';
import { priorityRankForKind } from './router.mjs';

const safeCount = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const safeCode = (v) => (typeof v === 'string' && CODE_RE.test(v) ? v : 'EUNKNOWN');
const safeKey = (v, fallback = 'default') =>
  typeof v === 'string' && SAFE_KEY_RE.test(v) ? v : fallback;

/**
 * Collects raw flywheel candidates and 8-component status summaries from runtime snapshots.
 */
export function collectRuntimeSignals({
  healthSnapshot = null,
  observeSummary = null,
  recapSummaries = [],
  sseMetrics = null,
  domAudit = null,
  extraCandidates = [],
} = {}) {
  const candidates = [];
  const commitSha = typeof healthSnapshot?.commit === 'string' ? healthSnapshot.commit : null;

  // P1: privacy_guard — rejected symlink/traversal refs or cross-site blocks
  const rejectedRefs = safeCount(healthSnapshot?.rejectedRefs);
  const crossSiteBlocks = safeCount(sseMetrics?.crossSiteBlocks);
  if (rejectedRefs > 0 || crossSiteBlocks > 0) {
    candidates.push({
      kind: 'privacy_guard',
      capabilityId: 'privacy-guard',
      primaryKey: rejectedRefs > 0 ? 'rejected-refs' : 'cross-site-guard',
      title: `Privacy guard rejected ${rejectedRefs} ref(s), ${crossSiteBlocks} cross-site request(s)`,
      summary: `Store rejectedRefs=${rejectedRefs}, HTTP crossSiteBlocks=${crossSiteBlocks}. Verify symlink/path isolation under CONTRACT.md section 5.`,
      severity: rejectedRefs > 0 ? 'fail' : 'warn',
      signature: `privacy_guard:rejected=${rejectedRefs > 0}:cross=${crossSiteBlocks > 0}`,
      gitSha: commitSha,
    });
  }

  // P2: runner_health — per-adapter scanErr, loopErrors, applyErrors, linkErrors
  const runners = healthSnapshot?.runners && typeof healthSnapshot.runners === 'object'
    ? healthSnapshot.runners
    : {};
  let adapterScanErrors = 0;
  let totalRunnerErrors = 0;
  let maxScanMs = 0;

  for (const [rawId, r] of Object.entries(runners)) {
    const adapterId = safeKey(rawId, 'adapter');
    const scanErr = r?.scanErr ? safeCode(r.scanErr) : null;
    const loopErrors = safeCount(r?.loopErrors);
    const applyErrors = safeCount(r?.applyErrors);
    const linkErrors = safeCount(r?.linkErrors);
    const scanMs = safeCount(r?.lastScanMs);
    if (scanMs > maxScanMs) maxScanMs = scanMs;

    if (scanErr) {
      adapterScanErrors += 1;
      candidates.push({
        kind: 'runner_health',
        capabilityId: 'adapters',
        primaryKey: adapterId,
        title: `Adapter ${adapterId} scan error (${scanErr})`,
        summary: `Runner ${adapterId} reported scanErr=${scanErr} (files=${safeCount(r?.files)}).`,
        severity: scanErr === 'SCAN_CAPPED' ? 'warn' : 'fail',
        signature: `runner_health:${adapterId}:scanErr:${scanErr}`,
        gitSha: commitSha,
      });
    }

    const errSum = loopErrors + applyErrors + linkErrors;
    if (errSum > 0) {
      totalRunnerErrors += errSum;
      candidates.push({
        kind: 'runner_health',
        capabilityId: 'adapters',
        primaryKey: adapterId,
        title: `Adapter ${adapterId} runtime errors (${errSum})`,
        summary: `Runner ${adapterId} counters: applyErrors=${applyErrors}, loopErrors=${loopErrors}, linkErrors=${linkErrors}.`,
        severity: loopErrors > 0 || applyErrors >= 5 ? 'fail' : 'warn',
        signature: `runner_health:${adapterId}:errors:loop=${loopErrors > 0}:apply=${applyErrors > 0}:link=${linkErrors > 0}`,
        gitSha: commitSha,
      });
    }
  }

  // P3: tailer_integrity — badLines, skippedLines, oversize, partialTail
  const badLines = safeCount(healthSnapshot?.badLines);
  const skippedLines = safeCount(healthSnapshot?.skippedLines);
  let observeOversize = 0;
  let observeBad = 0;
  if (observeSummary?.kinds && typeof observeSummary.kinds === 'object') {
    for (const k of Object.values(observeSummary.kinds)) {
      observeOversize += safeCount(k?.oversize);
      observeBad += safeCount(k?.bad);
    }
  }
  if (badLines > 0 || skippedLines > 0 || observeOversize > 0 || observeBad > 0) {
    const totalFraming = badLines + skippedLines + observeOversize + observeBad;
    candidates.push({
      kind: 'tailer_integrity',
      capabilityId: 'tailer-store',
      primaryKey: 'jsonl-tailer',
      title: `JSONL tailer framing anomalies (${totalFraming} line(s))`,
      summary: `Tailer counters: badLines=${badLines}, skippedLines=${skippedLines}, observeBad=${observeBad}, observeOversize=${observeOversize}.`,
      severity: badLines >= 10 || skippedLines >= 10 ? 'fail' : 'warn',
      signature: `tailer_integrity:bad=${badLines > 0}:skip=${skippedLines > 0}:oversize=${observeOversize > 0}`,
      gitSha: commitSha,
    });
  }

  // P4: permission_wait — Grok/agent permission wait stalls and unmatched/dropped queues
  const perm = observeSummary?.grokPermission ?? null;
  const longWaits = safeCount(perm?.longWaits);
  const unmatchedPerm = safeCount(perm?.unmatched);
  const droppedPerm = safeCount(perm?.dropped);
  const unresolvedPerm = safeCount(perm?.unresolved);
  if (unmatchedPerm > 0 || droppedPerm > 0 || unresolvedPerm >= 2 || longWaits >= 3) {
    candidates.push({
      kind: 'permission_wait',
      capabilityId: 'observe-sidecar',
      primaryKey: 'permission-fifo',
      title: `Permission queue stall (longWaits=${longWaits}, unmatched=${unmatchedPerm}, dropped=${droppedPerm})`,
      summary: `Permission FIFO metrics: longWaits=${longWaits}, unmatched=${unmatchedPerm}, dropped=${droppedPerm}, unresolved=${unresolvedPerm}.`,
      severity: unmatchedPerm > 0 || droppedPerm > 0 ? 'fail' : 'warn',
      signature: `permission_wait:unmatched=${unmatchedPerm > 0}:dropped=${droppedPerm > 0}:long=${longWaits >= 3}`,
      gitSha: commitSha,
    });
  }

  // P5: sse_backpressure — slow client drops or high runner scan latency
  const droppedClients = safeCount(sseMetrics?.droppedClients);
  if (droppedClients > 0 || maxScanMs >= 500) {
    candidates.push({
      kind: 'sse_backpressure',
      capabilityId: 'http-sse',
      primaryKey: droppedClients > 0 ? 'sse-buffer-drop' : 'runner-scan-latency',
      title: `Loopback backpressure (droppedClients=${droppedClients}, maxScanMs=${maxScanMs}ms)`,
      summary: `SSE slow-client drops=${droppedClients}, max adapter scan latency=${maxScanMs}ms.`,
      severity: droppedClients >= 3 || maxScanMs >= 2000 ? 'fail' : 'warn',
      signature: `sse_backpressure:drops=${droppedClients > 0}:slowScan=${maxScanMs >= 500}`,
      gitSha: commitSha,
    });
  }

  // P6: session_recap — high tool/API error sessions or unreviewed completed backlog
  const recaps = Array.isArray(recapSummaries) ? recapSummaries : [];
  let highErrorSessions = 0;
  let unreviewedCount = 0;
  for (const s of recaps) {
    if (safeCount(s?.apiErrors) > 0 || safeCount(s?.toolErrors) >= 3) highErrorSessions += 1;
    if (s?.unreviewedDone === true) unreviewedCount += 1;
  }
  if (highErrorSessions > 0 || unreviewedCount >= 5) {
    candidates.push({
      kind: 'session_recap',
      capabilityId: 'session-recap',
      primaryKey: highErrorSessions > 0 ? 'session-error-burst' : 'unreviewed-backlog',
      title: `Session recap anomalies (errorSessions=${highErrorSessions}, unreviewed=${unreviewedCount})`,
      summary: `Active sessions with repeated API/tool errors=${highErrorSessions}, unreviewed completed sessions=${unreviewedCount}.`,
      severity: highErrorSessions >= 2 ? 'fail' : 'warn',
      signature: `session_recap:errors=${highErrorSessions > 0}:unreviewed=${unreviewedCount >= 5}`,
      gitSha: commitSha,
    });
  }

  // P7: adapter_conformance — observe errors or unexpected active shapes
  let observeErrorCount = 0;
  if (observeSummary?.errors && typeof observeSummary.errors === 'object') {
    for (const errMap of Object.values(observeSummary.errors)) {
      if (errMap && typeof errMap === 'object') {
        for (const n of Object.values(errMap)) observeErrorCount += safeCount(n);
      }
    }
  }
  const activeShapesCount = Array.isArray(observeSummary?.active?.shapes)
    ? observeSummary.active.shapes.length
    : 0;
  if (observeErrorCount > 0 || activeShapesCount > 4) {
    candidates.push({
      kind: 'adapter_conformance',
      capabilityId: 'adapters',
      primaryKey: 'wire-shape-drift',
      title: `Adapter wire observation drift (errors=${observeErrorCount}, shapes=${activeShapesCount})`,
      summary: `Observe sidecar recorded ${observeErrorCount} fs/read error(s) and ${activeShapesCount} distinct active file shape(s).`,
      severity: observeErrorCount >= 5 ? 'fail' : 'warn',
      signature: `adapter_conformance:obsErr=${observeErrorCount > 0}:shapes=${activeShapesCount > 4}`,
      gitSha: commitSha,
    });
  }

  // P8: dom_entropy — DOM invariant violations, near-cap files (>450 lines), or stale anchors
  const domViolations = safeCount(domAudit?.violationsCount);
  const nearCapFiles = safeCount(domAudit?.nearCapFilesCount);
  const staleAnchors = safeCount(domAudit?.staleAnchorsCount);
  if (domViolations > 0 || nearCapFiles > 0 || staleAnchors > 0) {
    candidates.push({
      kind: 'dom_entropy',
      capabilityId: 'dom-harness',
      primaryKey: domViolations > 0 ? 'dom-invariant-violation' : 'file-line-budget',
      title: `DOM & Harness2 drift (violations=${domViolations}, nearCap=${nearCapFiles}, staleAnchors=${staleAnchors})`,
      summary: `DOM audit: ${domViolations} hard violation(s), ${nearCapFiles} file(s) >450 lines, ${staleAnchors} stale code_anchor(s).`,
      severity: domViolations > 0 || staleAnchors > 0 ? 'fail' : 'warn',
      signature: `dom_entropy:v=${domViolations > 0}:near=${nearCapFiles > 0}:anchors=${staleAnchors > 0}`,
      gitSha: commitSha,
    });
  }

  for (const extra of extraCandidates ?? []) {
    if (!extra || !FLYWHEEL_SIGNAL_KINDS.includes(extra.kind)) continue;
    candidates.push({
      kind: extra.kind,
      capabilityId: safeKey(
        extra.capabilityId,
        SIGNAL_KIND_CAPABILITY_MAP[extra.kind]?.primary ?? 'dom-harness',
      ),
      primaryKey: safeKey(extra.primaryKey, extra.kind),
      title: String(extra.title ?? extra.kind).slice(0, 160),
      summary: String(extra.summary ?? extra.title ?? extra.kind).slice(0, 280),
      severity: extra.severity === 'fail' ? 'fail' : 'warn',
      signature: extra.signature ?? `${extra.kind}:${extra.primaryKey ?? 'default'}`,
      gitSha: extra.gitSha ?? commitSha,
    });
  }

  const byKindStatus = (kind) => {
    const matching = candidates.filter((c) => c.kind === kind);
    if (matching.some((c) => c.severity === 'fail')) return 'fail';
    if (matching.some((c) => c.severity === 'warn')) return 'warn';
    return 'pass';
  };

  const componentSummaries = {
    privacy_guard: {
      status: byKindStatus('privacy_guard'),
      summaryText:
        byKindStatus('privacy_guard') === 'pass'
          ? '정상 · 심볼릭 링크/교차 출처 차단 0건'
          : `보안 가드 차단 감지 (rejectedRefs=${rejectedRefs})`,
      metrics: { rejectedRefs, crossSiteBlocks },
    },
    runner_health: {
      status: byKindStatus('runner_health'),
      summaryText:
        byKindStatus('runner_health') === 'pass'
          ? `정상 · 활성 어댑터 ${Object.keys(runners).length}개 탐색 정상`
          : `어댑터 탐색/적용 오류 ${adapterScanErrors + totalRunnerErrors}건`,
      metrics: {
        activeAdapters: Object.keys(runners).length,
        scanErrors: adapterScanErrors,
        runnerErrors: totalRunnerErrors,
      },
    },
    tailer_integrity: {
      status: byKindStatus('tailer_integrity'),
      summaryText:
        byKindStatus('tailer_integrity') === 'pass'
          ? '정상 · JSONL 줄 깨짐/초과 0건'
          : `JSONL 줄 오류(bad=${badLines}, skipped=${skippedLines})`,
      metrics: { badLines, skippedLines, observeOversize },
    },
    permission_wait: {
      status: byKindStatus('permission_wait'),
      summaryText:
        byKindStatus('permission_wait') === 'pass'
          ? `정상 · 권한 대기 큐 정상 (longWaits=${longWaits})`
          : `권한 대기 이상 (unmatched=${unmatchedPerm}, dropped=${droppedPerm})`,
      metrics: { longWaits, unmatchedPerm, droppedPerm, unresolvedPerm },
    },
    sse_backpressure: {
      status: byKindStatus('sse_backpressure'),
      summaryText:
        byKindStatus('sse_backpressure') === 'pass'
          ? `정상 · 최대 탐색 지연 ${maxScanMs}ms`
          : `백프레셔 감지 (dropped=${droppedClients}, maxScanMs=${maxScanMs}ms)`,
      metrics: { droppedClients, maxScanMs },
    },
    session_recap: {
      status: byKindStatus('session_recap'),
      summaryText:
        byKindStatus('session_recap') === 'pass'
          ? `정상 · 추적 세션 ${recaps.length}개`
          : `세션 오류 ${highErrorSessions}건 · 미검토 ${unreviewedCount}건`,
      metrics: { trackedSessions: recaps.length, highErrorSessions, unreviewedCount },
    },
    adapter_conformance: {
      status: byKindStatus('adapter_conformance'),
      summaryText:
        byKindStatus('adapter_conformance') === 'pass'
          ? '정상 · 어댑터 스키마 드리프트 없음'
          : `관찰 오류 ${observeErrorCount}건 · 형태 ${activeShapesCount}종`,
      metrics: { observeErrorCount, activeShapesCount },
    },
    dom_entropy: {
      status: byKindStatus('dom_entropy'),
      summaryText:
        byKindStatus('dom_entropy') === 'pass'
          ? '정상 · 0 런타임 의존성 / 500줄 상한 준수'
          : `DOM 위반 ${domViolations}건 · 상한 근접 ${nearCapFiles}개`,
      metrics: { domViolations, nearCapFiles, staleAnchors },
    },
  };

  return { candidates, componentSummaries };
}

export function buildInitialFlywheelState(nowIso = new Date().toISOString()) {
  const components = {};
  for (const kind of FLYWHEEL_SIGNAL_KINDS) {
    components[kind] = {
      kind,
      priorityRank: priorityRankForKind(kind),
      status: 'pass',
      enabled: true,
      activeSignalsCount: 0,
      dedupSuppressedCount: 0,
      linkedLinearCount: 0,
      statusHistory: ['pass'],
      summaryText: '정상 (신호 없음)',
      metrics: {},
      checkedAt: nowIso,
    };
  }
  return {
    schemaVersion: '1.0.0',
    config: {
      enabled: true,
      intervalMinutes: 30,
      tierAMode: 'dry_run',
      autoCreateLinearTicket: false,
      regressionWindowHours: 72,
      enabledSources: Object.fromEntries(FLYWHEEL_SIGNAL_KINDS.map((k) => [k, true])),
      updatedAt: nowIso,
    },
    components,
    signals: {},
    cycleHistory: [],
    lastScanAt: null,
    nextScheduledAt: new Date(Date.parse(nowIso) + 30 * 60_000).toISOString(),
    updatedAt: nowIso,
  };
}
