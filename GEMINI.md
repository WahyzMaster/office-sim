# GEMINI.md — office-sim

## Scope & Global Profile
- **User-Scope (`INV`)**: `WahyzDAD/wahyz_agent_profile#v1.3.0` (`~/.gemini/GEMINI.md` & `~/.gemini/config/hooks.json`).
- **Project-Scope (`DOM`)**: `office-sim` (Node.js 22+ ESM + Three.js). `CLAUDE.md` is the canonical project contract; this file adapts project rules for Gemini CLI and Antigravity (`<= 8,000 bytes` / `140 lines`).

## Worktree & Harness² Discipline
- Antigravity `PreToolUse` hooks block direct edits on the primary checkout; always work inside `.worktrees/<slug>` branched from `origin/master` (`using-git-worktrees`). Never run `git stash`.
- Follow the `Harness²` cost ladder (`skill -> script -> subagent -> hook -> gate -> memory -> always-on`). Load `docs/CONTRACT.md` and `docs/ADAPTERS.md` only when editing `src/adapters/` or wire schemas.

## Key Commands & Invariants
- Entrypoint: `bin/office-sim.mjs` (`npm start`); skill installer: `scripts/install-skill.mjs` (`skills/office/SKILL.md`).
- Narrowest test: `node --test test/<name>.test.mjs` before running full `npm test`.
- Domain & surface checks: `node scripts/verify-dom-invariants.mjs` and `python3 "${HOME}/.agents/skills/apply-wahyz-profile/scripts/verify_project_surface.py" .`
- Keep zero runtime dependencies (`node:*` built-ins only), `<= 500 lines` per file, no emoticons in markdown, and strict `os.tmpdir()` test isolation (`scripts/fake-root-guard.mjs`).
