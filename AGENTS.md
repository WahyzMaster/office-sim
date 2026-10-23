# AGENTS.md — office-sim

## Scope & Global Profile
- **User-Scope (`INV`)**: `WahyzDAD/wahyz_agent_profile#v1.3.0` (`~/.codex/AGENTS.md`).
- **Project-Scope (`DOM`)**: `office-sim` (Node.js 22+ zero-dependency 3D multi-agent visualizer). Read `CLAUDE.md` for full module architecture and privacy invariants.
- **Harness² Budget**: Keep this file under `8,000 bytes` / `120 lines` (`skill -> script -> subagent -> hook -> gate -> memory -> always-on`).

## Workflow & Narrow Verification
- **Worktree Isolation**: Perform all repository edits inside `.worktrees/<slug>` branched from `origin/master` (`using-git-worktrees`). Never run `git stash`.
- **Structural Search**: Prefer `codegraph_*` and `serena` over raw grep for symbol/caller lookups.
- **Narrowest Test First**:
  - Focused test: `node --test test/<name>.test.mjs`
  - Adapter conformance: `node --test test/adapter-*-conformance.test.mjs`
  - Domain invariant gate: `node scripts/verify-dom-invariants.mjs`
  - Full suite: `npm test`
  - Surface gate: `python3 "${HOME}/.agents/skills/apply-wahyz-profile/scripts/verify_project_surface.py" .`

## Critical Invariants
- **Zero Dependencies**: Use only `node:*` built-in modules on the server (`bin/office-sim.mjs`, `src/`, `scripts/`) and native ES modules in `public/js/`.
- **Privacy & Synthetic Roots**: Never read or write real `~/.claude`, `~/.codex`, `~/.grok`, or `~/.gemini` in tests (`scripts/fake-root-guard.mjs` + `os.tmpdir()`). Enforce `O_NOFOLLOW` symlink rejection and basename/hostname scrubbing per `docs/CONTRACT.md`.
- **Module Hygiene**: Max `500 lines` per file; no emoticons in markdown; preserve `ko`/`en` parity across all 7 room themes in `public/js/rooms.js`.
