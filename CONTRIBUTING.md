# Contributing to Office Sim

Thank you for contributing to **Office Sim**! Bug reports, adapter requests and theme ideas have issue forms; pull requests are welcome too.

## Core Principles

1. **No server dependencies**: the server (`bin/`, `src/`, `scripts/`) uses only Node.js built-in modules (`node:http`, `node:fs`, `node:path`, `node:crypto`, etc.), and `package.json` has no `dependencies`. The browser UI (`public/`) uses native ES modules and a copy of three.js that ships in the repository under `public/vendor/`, so the default page loads everything from the local server.
2. **Privacy by Default**:
   - The server binds strictly to loopback (`127.0.0.1` / `localhost` / `[::1]`) and rejects cross-site or foreign-Host requests.
   - Adapters must only read allowlisted session files, must never follow symlinks outside allowed roots, and must reduce paths to basenames and URLs to hostnames and remove email addresses before emitting events. Raw tool input and tool output are never stored or forwarded.
   - The shared text scrub (`cleanText` in `src/summarize.mjs`) does not detect secrets. A short excerpt of a prompt, a reply, a search query or the first line of a tool error is otherwise sent as written. Treat every field you add to an event as visible on the page, and never add command lines, file contents or tool result bodies.
   - See `docs/CONTRACT.md` (Section 5) for the full privacy contract. `docs/CONTRACT.md` is the specification: a change of behaviour changes it in the same pull request.
3. **Small, Focused Modules**: Keep every source file at or under 500 lines (`node scripts/verify-dom-invariants.mjs` checks `bin/`, `src/`, `public/js/` and `scripts/`). No emoticons in markdown files.
4. **Vendored files are exempt, and frozen**: the third-party files under `public/vendor/` (three.js 0.160.0 and its licence) are not project source, so the 500-line cap does not apply to them. Do not edit them: `test/vendor-assets.test.mjs` pins each file by sha256. To change the three.js version, replace the files and their pins together.
5. **Tests Never Touch Real Home Directories**: Every test in `test/*.test.mjs` must run against temporary directories or synthetic fixtures (`os.tmpdir()`), never reading or writing the user's real `~/.claude`, `~/.codex`, `~/.grok`, or `~/.gemini`. A test never starts a server on a fixed port (use port `0`) and never opens a browser.
6. **Korean and English**: every new string the page shows needs both languages.

## Development Setup

Requires **Node.js 22+** (tested in CI on Node 22 and Node 24).

```bash
# Run the local server (http://127.0.0.1:4747; it opens the browser when run in a terminal, --no-open skips that)
npm start

# Run one test file (the fastest check while you work)
node --test test/summarize.test.mjs

# Run the full test suite, then the invariant check
npm test
node scripts/verify-dom-invariants.mjs
```

Tests are plain `node --test` files, one topic per file, named `test/<topic>.test.mjs`. Write or adjust the test first, watch it fail, then change the code.

## Where Things Live

| What | Where |
|---|---|
| Command line: the entry stub, option parsing, the `init` and `hooks` setup commands | `bin/office-sim.mjs`, `src/cli-main.mjs`, `src/cli-args.mjs`, `src/cli-init.mjs` |
| HTTP server, guards and routes | `src/server.mjs`, `src/server-http.mjs`, `src/server-guard.mjs` |
| Agent adapters (one per agent) | `src/adapters/` (`src/adapters/index.mjs` registers the built-in ones, `src/adapters/plugins.mjs` the opt-in ones) |
| Claude Code hooks | `src/hooks-bridge.mjs`, `src/hooks-receiver.mjs` |
| The page and its modules | `public/office.html`, `public/js/` |
| Place themes, room names and UI strings | `public/js/rooms.js`, `public/js/theme-layouts.js`, `public/js/theme-props.js` |
| Character models | `public/js/agent-mesh.js`, `public/js/pet-mesh.js`, `public/js/bot-mesh.js`, `public/js/legend-data.js` |
| The `/office` skill and the Claude Code plugin | `skills/office/SKILL.md`, `plugin/` (`plugin/skills/office/SKILL.md` is a byte-identical copy, checked by a test) |

## Adding or Updating an Agent Adapter

1. Review `docs/CONTRACT.md` (Section 2 Event Schema & Section 4 Adapter Contract) and `docs/ADAPTERS.md`.
2. Add or update the adapter under `src/adapters/<agent-id>/` and register it in `src/adapters/index.mjs`.
3. Add conformance and privacy tests under `test/adapter-<agent-id>-conformance.test.mjs` verifying that:
   - Sensitive fields, credentials, and non-allowlisted files are never opened.
   - Symlinks are rejected.
   - Tool descriptors map cleanly to the 7 functional rooms (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`).
4. Say in the README's detection table which signals the adapter sees (question, plan approval, permission prompt, turn finished), and write "not detected" where it does not.

## Adding or Updating Room Themes

Room themes and bilingual UI strings (`KO` / `EN`) live in `public/js/rooms.js` (`ROOM_THEMES` and `UI_TEXT`). Each theme maps the 7 internal room keys (`archive`, `dev`, `server`, `research`, `meeting`, `desk`, `lounge`) to `[label, hint]` pairs in both `ko` and `en`.

## Before You Open a Pull Request

- `npm test` and `node scripts/verify-dom-invariants.mjs` pass.
- A change a user can see has a line in `CHANGELOG.md`, and the README still says only what the program does.
