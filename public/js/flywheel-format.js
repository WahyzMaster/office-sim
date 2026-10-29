// Pure formatting and view-model helpers for the 4-Zone Improvement Flywheel HUD panel.
// Zero DOM dependencies so Node tests can validate all 4 zones directly.

import { langOf } from './rooms.js';

export const FLYWHEEL_KINDS = Object.freeze([
  'privacy_guard',
  'runner_health',
  'tailer_integrity',
  'permission_wait',
  'sse_backpressure',
  'session_recap',
  'adapter_conformance',
  'dom_entropy',
]);

export const FLYWHEEL_TEXT = Object.freeze({
  ko: Object.freeze({
    btnLabel: (active, pending) =>
      pending > 0 ? `플라이휠 · 승인 ${pending}` : active > 0 ? `플라이휠 · ${active}` : '플라이휠',
    btnTitle: '개선 및 개정 플라이휠 4-Zone 대시보드 열기/닫기 (단축키 Y)',
    panelTitle: '개선 플라이휠 (L3 -> Dedup -> L1 -> L2)',
    scanNow: '지금 스캔',
    scanning: '스캔 중...',
    closeBtn: '닫기',
    enabledToggle: '자동 수집 켜짐',
    disabledToggle: '자동 수집 꺼짐',
    tierADryRun: 'Tier A: Dry-Run (승인 대기)',
    tierAAuto: 'Tier A: 자동 실행',
    linearAutoOn: 'Linear 티켓: 자동 생성',
    linearAutoOff: 'Linear 티켓: 수동/드래프트',
    filterAll: '전체 신호 보기',
    zone2Title: '8-Source 신호 매트릭스 (24-Tick 이력)',
    zone3Title: '활성 신호 큐 & Tier A Dry-Run 승인함',
    zone4Title: '최근 사이클 실행 이력 (최대 20회)',
    emptySignals: '현재 열린 L3 이상 신호가 없습니다.',
    approveBtn: 'Dry-Run 승인 실행',
    approvedBadge: '승인 실행됨',
    copySeedBtn: 'L1 계약 시드 명령 복사',
    copiedSeedBadge: '복사됨',
    debouncingBadge: '2-Tick 디바운스 대기',
    regressionBadge: '72h 회귀 감지',
    statusLabels: Object.freeze({
      pass: '정상',
      warn: '주의',
      fail: '심각',
    }),
    trackLabels: Object.freeze({
      tier_a: 'Tier A (운영 런북)',
      tier_b: 'Tier B (코드/어댑터 수정)',
      tier_c: 'Tier C (사람 검토 필수)',
    }),
    triggerLabels: Object.freeze({
      scheduled: '정기 스케줄',
      on_demand: '수동 스캔',
      ci_gate: 'CI 게이트',
    }),
    kindLabels: Object.freeze({
      privacy_guard: '프라이버시 & 경로 가드',
      runner_health: '어댑터 탐색/루프 상태',
      tailer_integrity: 'JSONL 꼬리 읽기 무결성',
      permission_wait: '권한 대기 큐 (FIFO)',
      sse_backpressure: 'SSE 백프레셔 & 지연',
      session_recap: '세션 요약 & 오류율',
      adapter_conformance: '어댑터 스키마 정합성',
      dom_entropy: 'DOM 불변성 & 500줄 상한',
    }),
  }),
  en: Object.freeze({
    btnLabel: (active, pending) =>
      pending > 0 ? `Flywheel · ${pending} Action` : active > 0 ? `Flywheel · ${active}` : 'Flywheel',
    btnTitle: 'Toggle Improvement & Revision Flywheel 4-Zone HUD (Shortcut Y)',
    panelTitle: 'Improvement Flywheel (L3 -> Dedup -> L1 -> L2)',
    scanNow: 'Scan Now',
    scanning: 'Scanning...',
    closeBtn: 'Close',
    enabledToggle: 'Auto-Scan On',
    disabledToggle: 'Auto-Scan Off',
    tierADryRun: 'Tier A: Dry-Run (Approval)',
    tierAAuto: 'Tier A: Auto-Execute',
    linearAutoOn: 'Linear: Auto-Ticket',
    linearAutoOff: 'Linear: Draft Only',
    filterAll: 'Show All Signals',
    zone2Title: '8-Source Signal Matrix (24-Tick Strip)',
    zone3Title: 'Active Signal Queue & Safe Dry-Run Inbox',
    zone4Title: 'Cycle Execution History (Last 20)',
    emptySignals: 'No active L3 anomaly signals.',
    approveBtn: 'Approve & Run',
    approvedBadge: 'Executed',
    copySeedBtn: 'Copy L1 Seed Command',
    copiedSeedBadge: 'Copied',
    debouncingBadge: '2-Tick Debouncing',
    regressionBadge: '72h Regression',
    statusLabels: Object.freeze({
      pass: 'PASS',
      warn: 'WARN',
      fail: 'FAIL',
    }),
    trackLabels: Object.freeze({
      tier_a: 'Tier A (Runbook)',
      tier_b: 'Tier B (Code Fix)',
      tier_c: 'Tier C (Human Escalation)',
    }),
    triggerLabels: Object.freeze({
      scheduled: 'Scheduled',
      on_demand: 'On-Demand',
      ci_gate: 'CI Gate',
    }),
    kindLabels: Object.freeze({
      privacy_guard: 'Privacy & Symlink Guard',
      runner_health: 'Adapter Runner Health',
      tailer_integrity: 'JSONL Tailer Integrity',
      permission_wait: 'Permission FIFO Queue',
      sse_backpressure: 'SSE Backpressure & Latency',
      session_recap: 'Session Recap & Errors',
      adapter_conformance: 'Adapter Wire Conformance',
      dom_entropy: 'DOM Invariants & Line Cap',
    }),
  }),
});

export const flywheelText = (lang = 'ko') => FLYWHEEL_TEXT[langOf(lang)];

const safeInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function readFlywheelStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const config = raw.config && typeof raw.config === 'object' ? raw.config : {};
  const components = raw.components && typeof raw.components === 'object' ? raw.components : {};
  const signals = Array.isArray(raw.signals)
    ? raw.signals
    : raw.signals && typeof raw.signals === 'object'
      ? Object.values(raw.signals)
      : [];
  const cycleHistory = Array.isArray(raw.cycleHistory) ? raw.cycleHistory : [];
  const summaryCounts = raw.summaryCounts && typeof raw.summaryCounts === 'object' ? raw.summaryCounts : {};

  return {
    overallStatus: ['pass', 'warn', 'fail'].includes(raw.overallStatus) ? raw.overallStatus : 'pass',
    config: {
      enabled: config.enabled !== false,
      intervalMinutes: safeInt(config.intervalMinutes) || 30,
      tierAMode: config.tierAMode === 'auto_execute' ? 'auto_execute' : 'dry_run',
      autoCreateLinearTicket: Boolean(config.autoCreateLinearTicket),
      regressionWindowHours: safeInt(config.regressionWindowHours) || 72,
      enabledSources: config.enabledSources && typeof config.enabledSources === 'object'
        ? { ...config.enabledSources }
        : {},
    },
    components,
    signals,
    cycleHistory,
    summaryCounts: {
      activeCount: safeInt(summaryCounts.activeCount),
      failCount: safeInt(summaryCounts.failCount),
      warnCount: safeInt(summaryCounts.warnCount),
      debouncingCount: safeInt(summaryCounts.debouncingCount),
      dryRunPendingCount: safeInt(summaryCounts.dryRunPendingCount),
      linkedLinearCount: safeInt(summaryCounts.linkedLinearCount),
      regressionCount: safeInt(summaryCounts.regressionCount),
    },
    lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : null,
    nextScheduledAt: typeof raw.nextScheduledAt === 'string' ? raw.nextScheduledAt : null,
  };
}

export function flywheelView(raw, { lang = 'ko', selectedKind = null } = {}) {
  const t = flywheelText(lang);
  const st = readFlywheelStatus(raw) ?? readFlywheelStatus({});

  const zone1 = {
    overallStatus: st.overallStatus,
    statusLabel: t.statusLabels[st.overallStatus] ?? t.statusLabels.pass,
    enabled: st.config.enabled,
    intervalMinutes: st.config.intervalMinutes,
    tierAMode: st.config.tierAMode,
    autoCreateLinearTicket: st.config.autoCreateLinearTicket,
    ...st.summaryCounts,
    lastScanAt: st.lastScanAt,
    nextScheduledAt: st.nextScheduledAt,
  };

  const zone2 = FLYWHEEL_KINDS.map((kind, idx) => {
    const comp = st.components[kind] ?? {};
    const status = ['pass', 'warn', 'fail'].includes(comp.status) ? comp.status : 'pass';
    const history = Array.isArray(comp.statusHistory) && comp.statusHistory.length
      ? comp.statusHistory.slice(-24)
      : [status];
    return {
      kind,
      priorityLabel: `P${idx + 1}`,
      title: t.kindLabels[kind] ?? kind,
      status,
      statusLabel: t.statusLabels[status] ?? status,
      enabled: comp.enabled !== false && st.config.enabledSources[kind] !== false,
      activeSignalsCount: safeInt(comp.activeSignalsCount),
      dedupSuppressedCount: safeInt(comp.dedupSuppressedCount),
      linkedLinearCount: safeInt(comp.linkedLinearCount),
      statusHistory: history,
      summaryText: typeof comp.summaryText === 'string' ? comp.summaryText : '',
      selected: selectedKind === kind,
    };
  });

  const activeSignals = st.signals
    .filter((s) => s && s.status !== 'resolved')
    .filter((s) => !selectedKind || s.kind === selectedKind)
    .map((s) => ({
      fingerprint: String(s.fingerprint ?? ''),
      kind: String(s.kind ?? ''),
      priorityLabel: `P${safeInt(s.priorityRank) || 8}`,
      capabilityId: String(s.capabilityId ?? ''),
      primaryKey: String(s.primaryKey ?? ''),
      title: String(s.title ?? ''),
      summary: String(s.summary ?? ''),
      severity: s.severity === 'fail' ? 'fail' : 'warn',
      severityLabel: t.statusLabels[s.severity === 'fail' ? 'fail' : 'warn'],
      track: String(s.track ?? 'tier_b'),
      trackLabel: t.trackLabels[s.track] ?? String(s.track ?? 'tier_b'),
      status: String(s.status ?? 'open'),
      occurrenceCount: safeInt(s.occurrenceCount) || 1,
      consecutiveCount: safeInt(s.consecutiveCount) || 1,
      debounced: Boolean(s.debounced),
      regression: Boolean(s.regression),
      linearIssueIdentifier: s.linearIssueIdentifier ?? null,
      linearIssueUrl: s.linearIssueUrl ?? null,
      seedCommand: String(s.seedCommand ?? ''),
      recommendedAction: s.recommendedAction
        ? {
          runbookId: String(s.recommendedAction.runbookId ?? ''),
          title: langOf(lang) === 'en'
            ? String(s.recommendedAction.titleEn ?? s.recommendedAction.title ?? '')
            : String(s.recommendedAction.title ?? ''),
          dryRunPreview: langOf(lang) === 'en'
            ? String(s.recommendedAction.dryRunPreviewEn ?? s.recommendedAction.dryRunPreview ?? '')
            : String(s.recommendedAction.dryRunPreview ?? ''),
          status: String(s.recommendedAction.status ?? 'pending_approval'),
          executionResult: s.recommendedAction.executionResult ?? null,
        }
        : null,
    }));

  const zone4 = st.cycleHistory.slice(0, 20).map((c) => {
    const status = ['pass', 'warn', 'fail'].includes(c?.status) ? c.status : 'pass';
    return {
      cycleId: String(c?.cycleId ?? ''),
      triggerLabel: t.triggerLabels[c?.triggerSource] ?? String(c?.triggerSource ?? 'on_demand'),
      startedAt: String(c?.startedAt ?? ''),
      durationText: `${safeInt(c?.durationMs)}ms`,
      scannedSignalsCount: safeInt(c?.scannedSignalsCount),
      dedupSuppressedCount: safeInt(c?.dedupSuppressedCount),
      linearCreatedCount: safeInt(c?.linearCreatedCount),
      dryRunPendingCount: safeInt(c?.dryRunPendingCount),
      resolvedThisTickCount: safeInt(c?.resolvedThisTickCount),
      status,
      statusLabel: t.statusLabels[status],
    };
  });

  return {
    zone1,
    zone2,
    zone3: {
      selectedKind,
      activeSignals,
      pendingApprovals: activeSignals.filter(
        (s) => s.recommendedAction?.status === 'pending_approval',
      ),
    },
    zone4,
  };
}
