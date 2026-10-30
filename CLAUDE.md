# CLAUDE.md — office-sim

## 1. Profile & Scope (`INV` vs `DOM`)
- **User-Scope (`INV` Baseline)**: `WahyzDAD/wahyz_agent_profile#v1.4.0` (`~/.claude/CLAUDE.md`). Global MCP routing (`serena`, `codegraph`, `morph-mcp`, `context7`, `tavily`), 60+ portable skills, and worktree isolation hooks (`using-git-worktrees`) come from the global profile — do not duplicate them here.
- **Project-Scope (`DOM` Contract)**: This file defines domain-specific architecture, build/test commands, and privacy/runtime invariants for `office-sim` (Node.js 22+ ESM + Three.js browser visualizer).
- **Harness² Cost Hierarchy**: `skill -> script -> subagent -> hook -> gate -> memory -> always-on`. Keep this file under `16,000 bytes` / `220 lines`; load heavy specifications (`docs/CONTRACT.md`, `docs/ADAPTERS.md`) on demand only when modifying adapters or wire schemas.

## 2. Architecture & Module Map
- **CLI Entrypoint**: `bin/office-sim.mjs` parses CLI flags via `src/cli-args.mjs` and launches the loopback server.
- **Loopback HTTP/SSE Server (`src/`)**:
  - `src/server.mjs`, `src/server-runner.mjs`, `src/server-http.mjs`, `src/server-health.mjs`, `src/server-guard.mjs`: serves static assets, `/events` SSE stream, `/state` snapshot, and `/healthz` diagnostics with strict `Host`/`Origin`/`Sec-Fetch-Site`/CSP guards.
  - `src/discover.mjs`, `src/tailer.mjs`, `src/store.mjs`, `src/store-claude.mjs`, `src/store-link.mjs`: discovers active agent log files, tails byte offsets every 250ms, and links subagent sessions and project worktree floors.
  - `src/session.mjs`, `src/session-identity.mjs`, `src/session-plan.mjs`, `src/session-util.mjs`, `src/core/`: normalizes tool invocations, checklists (`task.md`, `implementation_plan.md`), and speech summaries.
- **Multi-Agent Adapters (`src/adapters/`)**:
  - `src/adapters/index.mjs` registers `claude-code` (`src/adapters/claude-code.mjs`), `codex` (`src/adapters/codex/`), `grok` (`src/adapters/grok/`), and `antigravity` (`src/adapters/antigravity/`).
- **Observation Sidecar (`src/observe/`)**:
  - `src/observe/observer.mjs`, `src/observe/control.mjs`, `src/observe/records.mjs`, `src/observe/summary.mjs`, `src/observe/retention.mjs`: non-invasive file watcher (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`) emitting category/shape metrics without sensitive payloads.
- **Improvement & Revision Flywheel (`src/flywheel/` & `scripts/flywheel/`)**:
  - `src/flywheel/types.mjs`, `src/flywheel/router.mjs`, `src/flywheel/collectors.mjs`, `src/flywheel/control.mjs`: 8-source (`P1..P8`) runtime anomaly collector, 24-hex SHA-256 3-layer deduplication, 2-tick warn debounce, 72h regression detection, and Tier A/B/C dry-run router exposed via `/api/flywheel` and `public/js/flywheel-panel.js`.
  - `scripts/flywheel/seed-loop-contract.mjs`, `scripts/flywheel/loop-attempt-ledger.mjs`, `scripts/flywheel/promote-lesson.mjs`, `scripts/flywheel/evidence-notes.mjs`: `L3 -> L1 -> L2` `Harness²` CLI tools paired with `.claude/skills/office-flywheel/SKILL.md`.
- **3D Browser Client (`public/`)**:
  - `public/office.html` + `public/js/` (native ES modules + Three.js via `importmap`), including simulation sidecars `public/js/sim-motives.js`, `public/js/sim-overlays.js`, `public/js/sim-flywheel-viz.js`, `public/js/sim-advisor.js`, and `public/js/sim-cute-anim.js`.
  - `public/js/rooms.js` defines the 7 functional rooms (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`), 7 architectural themes (`studio`, `office`, `palace`, `hanok`, `starship`, `dogs`, `cats`), and bilingual (`ko`/`en`) strings.
- **Bundled Skills, Subagents & Scripts (`c5..c7`)**:
  - Runtime skill: `skills/office/SKILL.md` installed via `scripts/install-skill.mjs`.
  - On-demand `DOM` adapter/theme skill (`c6`): `.claude/skills/office-adapter/SKILL.md`.
  - Privacy & conformance subagent (`c5`): `.apm/agents/adapter-privacy-auditor.md`.
  - Synthetic stream generators, root guard & invariant gate (`c7`): `scripts/fake-root-guard.mjs`, `scripts/fake-codex-append.mjs`, `scripts/fake-grok-append.mjs`, `scripts/fake-antigravity-append.mjs`, `scripts/verify-dom-invariants.mjs`.

## 3. Build, Run & Verification Commands
- **Start local server**: `npm start` (or `node bin/office-sim.mjs`)
- **Narrowest test verification (preferred during iteration)**:
  ```bash
  node --test test/<specific>.test.mjs
  ```
- **Adapter conformance & privacy verification**:
  ```bash
  node --test test/adapter-*-conformance.test.mjs
  ```
- **Full test suite (115+ test files)**:
  ```bash
  npm test
  ```
- **Verify `DOM` (`c1..c8`) Harness² surface & domain invariants**:
  ```bash
  node scripts/verify-dom-invariants.mjs
  python3 "${HOME}/.agents/skills/apply-wahyz-profile/scripts/verify_project_surface.py" .
  ```

## 4. Strict Domain (`DOM`) Guardrails
1. **Zero Runtime Dependencies**: Server (`bin/`, `src/`, `scripts/`) must use only Node.js built-in `node:*` modules (`package.json` `dependencies` must remain absent/empty). Browser UI (`public/`) uses native ES modules and Three.js `importmap`.
2. **Privacy by Default (`docs/CONTRACT.md` §5)**:
   - Bind strictly to loopback (`127.0.0.1` / `localhost` / `[::1]`).
   - Open agent files with `O_NOFOLLOW`, verify regular file/directory inodes via `lstat`, and never follow symlinks outside allowed roots.
   - Never open non-allowlisted files (e.g., encrypted `conversations/*.pb`, auth/config/sqlite files).
   - Scrub file paths to basenames, URLs to hostnames, and strip tokens/emails/raw contents before emitting events.
3. **Synthetic Test Isolation**: Every test in `test/*.test.mjs` and every `scripts/fake-*-append.mjs` run must operate strictly inside `os.tmpdir()` (guarded by `scripts/fake-root-guard.mjs`), never touching real `~/.claude`, `~/.codex`, `~/.grok`, or `~/.gemini`.
4. **File Size & Style Caps**: Keep every source file at or under `500 lines`. Do not use emoticons in markdown files. Maintain `ko`/`en` parity in `public/js/rooms.js`.
5. **Worktree Isolation**: Always edit inside `.worktrees/<slug>` created from `origin/master` (`using-git-worktrees`). Never run `git stash`.
