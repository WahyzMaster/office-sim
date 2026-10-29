#!/usr/bin/env node
// L3 -> L1 Loop Contract Seeder for Office Sim (ported from wahyz_omni tools/ci/seed_loop_contract.mjs).
// Generates a Loop Contract (.loop-contract.md) from a Flywheel signal or Linear issue with:
// - Primary & secondary office-sim capabilities
// - Protected Verification Files (off-limits during implementation to prevent reward hacking)
// - Narrowest verification commands + DOM & surface gates
// - Empty Attempt & Friction Ledger ready for L1 -> L2 promotion

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FLYWHEEL_SIGNAL_KINDS,
  SIGNAL_KIND_CAPABILITY_MAP,
} from '../../src/flywheel/types.mjs';
import {
  classifySignalTrack,
  computeSignalFingerprint,
  priorityRankForKind,
} from '../../src/flywheel/router.mjs';

export const PROTECTED_VERIFICATION_FILES = Object.freeze([
  'scripts/verify-dom-invariants.mjs',
  'scripts/fake-root-guard.mjs',
  'test/adapter-claude-conformance.test.mjs',
  'test/adapter-codex-conformance.test.mjs',
  'test/adapter-grok-conformance.test.mjs',
  'test/adapter-antigravity-conformance.test.mjs',
  'test/flywheel-router.test.mjs',
]);

export const CAPABILITY_VERIFY_COMMANDS = Object.freeze({
  'privacy-guard': [
    'node --test test/server.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  adapters: [
    'node --test test/adapter-claude-conformance.test.mjs test/adapter-codex-conformance.test.mjs test/adapter-grok-conformance.test.mjs test/adapter-antigravity-conformance.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  'tailer-store': [
    'node --test test/tailer.test.mjs test/store.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  'observe-sidecar': [
    'node --test test/observe-control.test.mjs test/observe-writer.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  'http-sse': [
    'node --test test/server.test.mjs test/flywheel-control-http.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  'session-recap': [
    'node --test test/session-recap.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  'scene-3d': [
    'node --test test/page-observe.test.mjs test/flywheel-panel.test.mjs',
    'node scripts/verify-dom-invariants.mjs',
  ],
  'dom-harness': [
    'node scripts/verify-dom-invariants.mjs',
    'python3 "${HOME}/.agents/skills/apply-wahyz-profile/scripts/verify_project_surface.py" . --skip-codegraph',
  ],
});

export const CAPABILITY_ANCHOR_HINTS = Object.freeze({
  'privacy-guard': ['src/server-guard.mjs#crossSiteFetch', 'src/tailer.mjs#Tailer'],
  adapters: ['src/adapters/index.mjs#selectAdapters', 'src/server-runner.mjs#Runner'],
  'tailer-store': ['src/tailer.mjs#Tailer', 'src/store.mjs#Store'],
  'observe-sidecar': ['src/observe/control.mjs#ObserveControl', 'src/observe/summary.mjs#summarize'],
  'http-sse': ['src/server-http.mjs#createHttp', 'src/flywheel/control.mjs#FlywheelControl'],
  'session-recap': ['src/session-recap.mjs#SessionRecapTracker'],
  'scene-3d': ['public/js/flywheel-panel.js#installFlywheelPanel', 'public/js/rooms.js#ROOMS'],
  'dom-harness': ['scripts/verify-dom-invariants.mjs', 'src/flywheel/router.mjs#routeFlywheelSignals'],
});

export function resolveLoopSeedContext({
  issue = 'GLO-TBD',
  signalKind = 'dom_entropy',
  primaryKey = null,
  title = null,
  summary = null,
  nowIso = new Date().toISOString(),
} = {}) {
  const kind = FLYWHEEL_SIGNAL_KINDS.includes(signalKind) ? signalKind : 'dom_entropy';
  const capMap = SIGNAL_KIND_CAPABILITY_MAP[kind] ?? {
    primary: 'dom-harness',
    secondary: [],
  };
  const resolvedKey = String(primaryKey || kind).trim();
  const resolvedTitle = String(title || `[${kind}] ${resolvedKey} remediation`).trim();
  const resolvedSummary = String(
    summary || `Remediate L3 ${kind} signal on ${resolvedKey} within office-sim DOM invariants.`,
  ).trim();
  const priorityRank = priorityRankForKind(kind);
  const track = classifySignalTrack({
    kind,
    capabilityId: capMap.primary,
    primaryKey: resolvedKey,
  });
  const fingerprint = computeSignalFingerprint({
    kind,
    capabilityId: capMap.primary,
    primaryKey: resolvedKey,
    signature: resolvedSummary,
  });

  return {
    issue: String(issue || 'GLO-TBD').trim(),
    signalKind: kind,
    priorityRank,
    primaryCapability: capMap.primary,
    secondaryCapabilities: [...(capMap.secondary ?? [])],
    primaryKey: resolvedKey,
    title: resolvedTitle,
    summary: resolvedSummary,
    track,
    fingerprint,
    verifyCommands: CAPABILITY_VERIFY_COMMANDS[capMap.primary] ?? CAPABILITY_VERIFY_COMMANDS['dom-harness'],
    protectedFiles: [...PROTECTED_VERIFICATION_FILES],
    anchorHints: CAPABILITY_ANCHOR_HINTS[capMap.primary] ?? [],
    nowIso,
  };
}

export function renderLoopContractMarkdown(ctx) {
  const verifyLines = (ctx.verifyCommands ?? [])
    .map((cmd) => `- \`${cmd}\``)
    .join('\n');
  const protectedLines = (ctx.protectedFiles ?? [])
    .map((f) => `- \`${f}\``)
    .join('\n');
  const anchorLines = (ctx.anchorHints ?? [])
    .map((a) => `- \`${a}\``)
    .join('\n');

  return [
    `# Loop Contract — ${ctx.issue}: ${ctx.title}`,
    '',
    '## 1. Signal & Capability Context (L3 -> L1)',
    `- **Issue**: \`${ctx.issue}\``,
    `- **Signal Kind**: \`${ctx.signalKind}\` (Priority \`P${ctx.priorityRank}\`)`,
    `- **Primary Capability**: \`${ctx.primaryCapability}\``,
    `- **Secondary Capabilities**: ${ctx.secondaryCapabilities.length ? ctx.secondaryCapabilities.map((c) => `\`${c}\``).join(', ') : 'none'}`,
    `- **Primary Key**: \`${ctx.primaryKey}\``,
    `- **Autonomy Track**: \`${ctx.track}\``,
    `- **Fingerprint**: \`${ctx.fingerprint}\``,
    `- **Seeded At**: \`${ctx.nowIso}\``,
    '',
    '## 2. Goal & Scope',
    ctx.summary,
    '',
    '## 3. Code Anchor Hints',
    anchorLines || '- `src/flywheel/router.mjs#routeFlywheelSignals`',
    '',
    '## 4. Protected Verification Files (Do Not Weaken)',
    'Implementation agents must not weaken assertions or delete checks in these grader files:',
    protectedLines,
    '',
    '## 5. Verification Gates (Narrowest First)',
    verifyLines,
    '- `npm test`',
    '',
    '## 6. Attempt & Friction Ledger (L1 -> L2)',
    '| Attempt | Timestamp | Gate | Outcome | Friction Class | Notes |',
    '|---|---|---|---|---|---|',
    '',
  ].join('\n');
}

export function seedLoopContract({
  issue = 'GLO-TBD',
  signalKind = 'dom_entropy',
  primaryKey = null,
  title = null,
  summary = null,
  outputPath = null,
  nowIso = new Date().toISOString(),
} = {}) {
  const ctx = resolveLoopSeedContext({
    issue,
    signalKind,
    primaryKey,
    title,
    summary,
    nowIso,
  });
  const markdown = renderLoopContractMarkdown(ctx);
  if (outputPath) {
    const resolvedOut = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, markdown, 'utf8');
  }
  return { context: ctx, markdown, outputPath: outputPath ? path.resolve(outputPath) : null };
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--issue') out.issue = argv[++i];
    else if (a === '--signal-kind') out.signalKind = argv[++i];
    else if (a === '--primary-key') out.primaryKey = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
    else if (a === '--out') out.outputPath = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  const res = seedLoopContract(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    process.stdout.write(res.markdown);
  }
}
