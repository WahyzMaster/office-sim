# AGENTS.md — office-sim

## Scope & Global Profile
- **User-Scope (`INV`)**: `WahyzDAD/wahyz_agent_profile#v1.4.3` (`~/.codex/AGENTS.md`).
- **Project-Scope (`DOM`)**: `office-sim` (Node.js 22+ 3D multi-agent visualizer; the server has no npm dependencies and the page ships a vendored three.js). Read `CLAUDE.md` for full module architecture and privacy invariants.
- **Harness² Budget**: Keep this file under `8,000 bytes` / `120 lines` (`skill -> script -> subagent -> hook -> gate -> memory -> always-on`).

## Workflow & Narrow Verification
- **Worktree Isolation, Merge-Wait Teardown & Post-Merge Deployment (`P5`)**: Perform all repository edits inside `.worktrees/<slug>` branched from `origin/master` (`using-git-worktrees`). Never run `git stash`. Run `worktree_land.sh preflight` before committing, land via `worktree_land.sh land --pr <N> --auto-merge --wait` (never chain `gh pr merge` with manual `git worktree remove`), and never publish or deploy from `.worktrees/<slug>` (`P1`–`P4`); releases execute only at `P5` after PR merge to `origin/master` (`worktree_land.sh deploy-check`).
- **Structural Search**: Prefer `codegraph_*` and `serena` over raw grep for symbol/caller lookups.
- **Narrowest Test First**:
  - Focused test: `node --test test/<name>.test.mjs`
  - Adapter conformance: `node --test test/adapter-*-conformance.test.mjs`
  - Flywheel suite: `node --test test/flywheel-*.test.mjs`
  - Domain invariant gate: `node scripts/verify-dom-invariants.mjs`
  - Full suite: `npm test`
  - Surface gate: `python3 "${HOME}/.agents/skills/apply-wahyz-profile/scripts/verify_project_surface.py" .`

## Critical Invariants
- **Zero Dependencies**: Use only `node:*` built-in modules on the server (`bin/office-sim.mjs` is a stub that loads `src/cli-main.mjs`; `src/`, `scripts/`) and native ES modules in `public/js/`. three.js is vendored under `public/vendor/` (sha256-pinned), so the default page loads from loopback only.
- **Default Port**: `4747`, with no fallback port. It is written into hook URLs, `skills/office/SKILL.md` and `plugin/hooks/hooks.json` (a byte-identical skill copy lives in `plugin/skills/office/SKILL.md`), so change them together.
- **Privacy & Synthetic Roots**: Never read or write real `~/.claude`, `~/.codex`, `~/.grok`, or `~/.gemini` in tests (`scripts/fake-root-guard.mjs` + `os.tmpdir()`). Enforce `O_NOFOLLOW` symlink rejection and basename/hostname scrubbing per `docs/CONTRACT.md`.
- **Module Hygiene**: Max `500 lines` per file (third-party files under `public/vendor/` are exempt); no emoticons in markdown; a user-visible change gets a `CHANGELOG.md` entry; preserve `ko`/`en` parity across all 7 room themes in `public/js/rooms.js`.
