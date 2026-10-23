---
name: office-adapter
description: On-demand domain guide for adding or modifying office-sim agent adapters (src/adapters/), observation sidecar (src/observe/), or 3D room themes (public/js/rooms.js) without loading the full 350 KB CONTRACT.md and ADAPTERS.md into always-on context.
---

# Office Sim Adapter & Theme Workflow (`DOM` Skill)

## When to Use

Activate this skill when modifying:
- `src/adapters/<agent-id>/` or `src/adapters/index.mjs`
- `src/observe/`
- `public/js/rooms.js` (room themes and bilingual `ko`/`en` strings)

## 1. Adapter Contract (`src/adapters/`)

1. Read only the relevant sections of `docs/CONTRACT.md` (Section 2 Event Schema, Section 4 Adapter Contract, Section 5 Privacy Contract) and `docs/ADAPTERS.md`.
2. Register the adapter in `src/adapters/index.mjs` (`KNOWN_AGENTS`, `AGENT_LABELS`, `ADAPTERS`).
3. Enforce filesystem and privacy invariants:
   - Open log files with `O_NOFOLLOW` and verify `lstat` vs `fstat` inode identity.
   - Reject symlinks at every directory hop between the root and the target file.
   - Emit only scrubbed tool descriptors (file basename, URL hostname, zero secrets/tokens/emails) mapped to the 7 functional rooms (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`).
4. Add or update `test/adapter-<agent-id>-conformance.test.mjs` using synthetic `os.tmpdir()` roots.

## 2. Room Theme & Bilingual UI Contract (`public/js/rooms.js`)

1. Every theme in `ROOM_THEMES` (`studio`, `office`, `palace`, `hanok`, `starship`, `dogs`, `cats`) must define all 7 room keys (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`) with `[label, hint]` pairs in both `ko` and `en`.
2. Verify 3D layout and collider invariants:
   ```bash
   node --test test/theme-*.test.mjs
   ```

## 3. Pre-Completion Verification

```bash
node --test test/adapter-*-conformance.test.mjs
node scripts/verify-dom-invariants.mjs
python3 "${HOME}/.agents/skills/apply-wahyz-profile/scripts/verify_project_surface.py" .
```
