# Contributing to Office Sim

Thank you for contributing to **Office Sim**!

## Core Principles

1. **Zero Runtime Dependencies**: Server (`src/`, `bin/`) uses only Node.js built-in modules (`node:http`, `node:fs`, `node:path`, `node:crypto`, etc.). Browser UI (`public/`) uses native ES modules + Three.js via `importmap`.
2. **Privacy by Default**:
   - The server binds strictly to loopback (`127.0.0.1` / `localhost` / `[::1]`) and rejects cross-site or foreign-Host requests.
   - Adapters must only read allowlisted session files, must never follow symlinks outside allowed roots, and must scrub paths (basename only), URLs (hostname only), emails, tokens, and raw file/command contents before emitting events.
   - See `docs/CONTRACT.md` (Section 5) for the full privacy contract.
3. **Small, Focused Modules**: Keep every file at or under 500 lines. No emoticons in markdown files.
4. **Tests Never Touch Real Home Directories**: Every test in `test/*.test.mjs` must run against temporary directories or synthetic fixtures (`os.tmpdir()`), never reading or writing the user's real `~/.claude`, `~/.codex`, `~/.grok`, or `~/.gemini`.

## Development Setup

Requires **Node.js 22+** (tested in CI on Node 22 and Node 24).

```bash
# Run the local server (opens on http://127.0.0.1:4317)
npm start

# Run the full test suite
npm test
```

## Adding or Updating an Agent Adapter

1. Review `docs/CONTRACT.md` (Section 2 Event Schema & Section 4 Adapter Contract) and `docs/ADAPTERS.md`.
2. Add or update the adapter under `src/adapters/<agent-id>/` and register it in `src/adapters/index.mjs`.
3. Add conformance and privacy tests under `test/adapter-<agent-id>-conformance.test.mjs` verifying that:
   - Sensitive fields, credentials, and non-allowlisted files are never opened.
   - Symlinks are rejected.
   - Tool descriptors map cleanly to the 7 functional rooms (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`).

## Adding or Updating Room Themes

Room themes and bilingual UI strings (`KO` / `EN`) live in `public/js/rooms.js` (`ROOM_THEMES` and `UI_TEXT`). Each theme maps the 7 internal room keys (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`) to `[label, hint]` pairs in both `ko` and `en`.
