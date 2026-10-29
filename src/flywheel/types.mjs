// Office Sim Improvement & Revision Flywheel types, constants, and Tier A/B/C runbook specs.
// Ported from wahyz_omni (functions-ksm/src/healthChecks/flywheel/flywheelTypes.ts & tools/loop/flywheel_router.mjs)
// and adapted to office-sim's 8 L3 runtime & DOM signal sources with strict CONTRACT.md section 5 privacy guards.

export const FLYWHEEL_STATE_SCHEMA_VERSION = '1.0.0';

/**
 * 8-source signal priority order (P1..P8) for office-sim.
 * P1 and P2 (and any 'fail' severity) bypass the 2-tick debounce gate.
 * P3..P8 'warn' signals require 2 consecutive ticks to promote from 'debouncing' to 'open'.
 */
export const FLYWHEEL_SIGNAL_KINDS = Object.freeze([
  'privacy_guard',
  'runner_health',
  'tailer_integrity',
  'permission_wait',
  'sse_backpressure',
  'session_recap',
  'adapter_conformance',
  'dom_entropy',
]);

export const FLYWHEEL_CAPABILITIES = Object.freeze([
  'privacy-guard',
  'adapters',
  'tailer-store',
  'observe-sidecar',
  'http-sse',
  'session-recap',
  'scene-3d',
  'dom-harness',
]);

export const SIGNAL_KIND_CAPABILITY_MAP = Object.freeze({
  privacy_guard: Object.freeze({
    primary: 'privacy-guard',
    secondary: Object.freeze(['adapters', 'http-sse']),
  }),
  runner_health: Object.freeze({
    primary: 'adapters',
    secondary: Object.freeze(['tailer-store']),
  }),
  tailer_integrity: Object.freeze({
    primary: 'tailer-store',
    secondary: Object.freeze(['observe-sidecar']),
  }),
  permission_wait: Object.freeze({
    primary: 'observe-sidecar',
    secondary: Object.freeze(['adapters', 'scene-3d']),
  }),
  sse_backpressure: Object.freeze({
    primary: 'http-sse',
    secondary: Object.freeze(['tailer-store']),
  }),
  session_recap: Object.freeze({
    primary: 'session-recap',
    secondary: Object.freeze(['http-sse']),
  }),
  adapter_conformance: Object.freeze({
    primary: 'adapters',
    secondary: Object.freeze(['observe-sidecar', 'privacy-guard']),
  }),
  dom_entropy: Object.freeze({
    primary: 'dom-harness',
    secondary: Object.freeze(['scene-3d']),
  }),
});

export const VALID_INTERVAL_MINUTES = Object.freeze([5, 15, 30, 60, 180, 360]);
export const FINGERPRINT_RE = /^[0-9a-f]{24}$/;
export const CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;
export const SAFE_KEY_RE = /^[a-z0-9_.-]{1,64}$/i;

export const TIER_C_CAPABILITIES = new Set([
  'privacy-guard',
  'scene-3d',
]);

export const TIER_A_RUNBOOKS = Object.freeze({
  runner_health: Object.freeze({
    runbookId: 'rescan_adapter_roots',
    title: '어댑터 루트 즉시 재탐색 (Rescan Adapter Roots)',
    titleEn: 'Rescan Adapter Roots Immediately',
    dryRunPreview:
      'Dry-Run: 활성 어댑터(claude-code, codex, grok, antigravity)의 탐색 루프를 즉시 1회 재실행하고 일시적 scanErr 상태를 재검증합니다 (세션 기록 변경 없음).',
    dryRunPreviewEn:
      'Dry-Run: Triggers a non-destructive single rescan pass across active adapters to re-verify transient scanErr states.',
  }),
  tailer_integrity: Object.freeze({
    runbookId: 'start_diagnostic_observe',
    title: '기록 관찰 진단 캡처 시작 (Start Diagnostic Observe)',
    titleEn: 'Start Bounded Diagnostic Observe Capture',
    dryRunPreview:
      'Dry-Run: 비침습 기록 관찰(ObserveControl)을 시작하여 JSONL 줄 잘림·초과 크기 지표를 수집합니다 (원문 미저장).',
    dryRunPreviewEn:
      'Dry-Run: Starts a bounded non-invasive ObserveControl capture to collect JSONL framing metrics without payload contents.',
  }),
  permission_wait: Object.freeze({
    runbookId: 'prune_observe_files',
    title: '관찰 기록 보관 정리 및 권한 큐 재집계 (Prune & Refresh Observe)',
    titleEn: 'Prune Observe Outputs & Refresh Permission Queue',
    dryRunPreview:
      'Dry-Run: 오래된 관찰 파일 보관 한도(KEEP_FILES=20)를 정리하고 권한 대기 지표를 재점검합니다.',
    dryRunPreviewEn:
      'Dry-Run: Runs retention pruning (KEEP_FILES=20) on observation outputs and refreshes permission wait counters.',
  }),
  sse_backpressure: Object.freeze({
    runbookId: 'probe_sse_and_runner_latency',
    title: 'SSE 연결 및 탐색 지연 재점검 (Probe SSE & Scan Latency)',
    titleEn: 'Probe SSE Clients & Runner Scan Latency',
    dryRunPreview:
      'Dry-Run: 현재 연결된 SSE 클라이언트 버퍼 상태와 어댑터 탐색 지연(lastScanMs)을 비파괴 재측정합니다.',
    dryRunPreviewEn:
      'Dry-Run: Re-evaluates active SSE client buffer states and adapter scan latency (lastScanMs) without dropping healthy clients.',
  }),
  dom_entropy: Object.freeze({
    runbookId: 'run_dom_invariant_audit',
    title: 'DOM 불변성 및 500줄 상한 재검증 (Run DOM Invariant Audit)',
    titleEn: 'Run DOM Invariant & Line-Cap Audit',
    dryRunPreview:
      'Dry-Run: 런타임 의존성 0개, 파일당 500줄 상한, O_NOFOLLOW 규칙을 메모리에서 즉시 재점검합니다.',
    dryRunPreviewEn:
      'Dry-Run: Re-runs the deterministic zero-dependency, 500-line file cap, and O_NOFOLLOW invariant checks.',
  }),
});

export const DEFAULT_FLYWHEEL_ENABLED_SOURCES = Object.freeze({
  privacy_guard: true,
  runner_health: true,
  tailer_integrity: true,
  permission_wait: true,
  sse_backpressure: true,
  session_recap: true,
  adapter_conformance: true,
  dom_entropy: true,
});

export const DEFAULT_FLYWHEEL_CONFIG = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  tierAMode: 'dry_run',
  autoCreateLinearTicket: false,
  regressionWindowHours: 72,
  enabledSources: DEFAULT_FLYWHEEL_ENABLED_SOURCES,
});
