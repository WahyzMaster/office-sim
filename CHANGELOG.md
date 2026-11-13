# Changelog

Notable changes to Office Sim, written for the people who use it. Releases before 0.12.0 are listed in the release ledger of [`docs/SOFTWARE_DEVELOPMENT_REPORT.md`](docs/SOFTWARE_DEVELOPMENT_REPORT.md) and described in [`docs/HISTORY.md`](docs/HISTORY.md).

## Unreleased

### Fixed

- Guarded all delegated click and `window` `keydown` `e.target.closest(...)` calls in `public/js/hud.js` so synthetic or non-Element targets never throw (`GLO-1250`).
- Closed open synthetic hook tools with `abandoned` in `src/hooks-bridge.mjs` when transcript tracking takes over a Claude Code session.
- Hardened `installClaudeHooks` and `uninstallClaudeHooks` (`src/hooks-receiver.mjs`) with atomic `O_EXCL | O_NOFOLLOW` temporary writes and backup symlink protection (`ELOOP`).
- Updated `findRunning` (`src/port-reuse.mjs`) and `docs/CONTRACT.md` so explicit `--port <N>` still fails on `EADDRINUSE` while probing `<N>` for a running `office-sim` URL hint (skipping invalid ports `< 1`).
- Distinguished `WebGPURenderer.init()` 3000ms timeouts with `fallbackCode: 'timeout'` and localized `ko`/`en` diagnostics (`public/js/webgpu-stage.js`).
- Skipped Node `< 22` advisory startup warning lines in `/office` skill wait snippets (`skills/office/SKILL.md` and `plugin/skills/office/SKILL.md`).
- Removed leftover Korean parenthetical text from the English Grok row in `README.md`.

### Added

- Antigravity 2.x tool mappings (`search_marketplace`, `list_plugin_accounts`, `enter_plan_mode`, `exit_plan_mode`, `swarm`) and generalized `_rooms` patching in `src/adapters/antigravity/` (`docs/CONTRACT.md` §4.8, `docs/ADAPTERS.md` §5.3/§6.2).
- Shared pure DOM invariant auditor (`src/flywheel/dom-audit.mjs`), wired live flywheel Tier A runbooks (`src/server.mjs`), anti-Goodhart RSI ratchet CLI (`scripts/flywheel/rsi-eval.mjs`), L2 lesson (`docs/lessons/L-rsi-dom-ratchet.md`), and five-module decomposition keeping modified modules well below the 500-line ceiling.

## 0.12.0

The first run now works from one command, the default page talks to your own machine only, and the README says only what the program does. Several defaults change, so read "Changed" before you upgrade.

### Changed

- **Breaking: the default port is `4747`.** It was `4317`, which is also the default port of OpenTelemetry collectors. Bookmarks, scripts and anything else that names the old address need the new one, or `--port 4317`. There is no automatic fallback to another port.
- **Breaking: the browser opens by itself** when you start `office-sim` in a terminal. `--no-open` turns that off. Nothing opens when the output is a pipe or a file, when `CI` is set, or with `--auth` on Linux; `--open` still forces it.
- **Breaking: the page starts in English** unless the browser language is Korean (`ko`, `ko-KR`). Before, it started in Korean unless the browser language was English. A language chosen with the `KO / EN` button, and `?lang=`, still win.
- **Breaking: sound starts off.** A saved choice still wins; the sound button turns it on.
- **Breaking: Claude Code hooks do one job now.** Office Sim registers two hooks, `PermissionRequest` and `Notification` (for permission prompts), as `http` hooks. Earlier versions used `curl` command hooks for thirteen events. For a session whose log is being read, a hook only marks an open tool as waiting for permission; everything else comes from the session log. `office-sim hooks install` replaces the older hooks, and `office-sim hooks uninstall` removes both kinds. The hook endpoint now answers `200` with `{}`.
- **Releases are manual.** A merge to the main branch no longer publishes a new npm version. Versions are published by hand and may batch several changes, like this one.
- The page loads everything from the local server. three.js 0.160.0 ships inside the package, Google Fonts are gone (system fonts are used), and the content security policy names no outside host. The opt-in WebGPU renderer (`?renderer=webgpu`) is the one thing that still comes from a CDN, and it now needs `--cdn` as well.
- Starting a second `office-sim` on the default port no longer fails while the first one is running: with no option other than `--open`, `--no-open` and `--demo` it prints the running address, opens it when opening is on, and exits. With any other option the busy port is still an error, and the message names the running server.
- Maintainer tools (the Flywheel button, the RCI and Lens pill, the tail-interval input) are hidden unless the page is opened with `?labs=1`.
- Node.js 22 is the stated floor everywhere. An older Node prints one warning and still runs.
- The `/office` skill works from a clone, from the plugin and from `npx`.
- The README starts with what the program does and how to run it, and has a table of what is detected for each agent.

### Added

- **First run**: when no agent session is running, the page plays the demo under a banner that says so, and switches to your real sessions as soon as one appears. The terminal prints one line saying the same. `--demo` opens the demo directly.
- **Claude Code permission prompts**: with the hooks installed, a prompt shows as a visit to the review booth, and a page that reconnects still shows it. This path is tested with fixture payloads written from Claude Code's hook reference, not yet against a live Claude Code session.
- **Claude Code plugin**: `/plugin marketplace add WahyzMaster/office-sim`, then `/plugin install office-sim@office-sim`. It carries the two hooks and the `/office-sim:office` skill.
- **`office-sim init`** and **`office-sim hooks install | uninstall | status`**: the same setup without the plugin system. They print every change first and write only after a yes (or `--yes`); `--dry-run` writes nothing.
- The number of characters that wait for an answer in the browser tab title, and a chip that steps through them.
- **Secret mask**: in the free text sent to the page (excerpts, titles, summaries, questions, plan items, error lines), a fixed list of secret shapes is replaced by `(secret)`: some keys that start with a well-known prefix, JSON Web Tokens, `Bearer` credentials, the values of `Authorization` and `x-api-key` headers (a value that is one ordinary word, with no known scheme in front of it, is left), PEM private keys, and the value behind a name that ends with a word such as `password`, `secret`, `token` or `api_key`. It is a net, not a detector: a secret of any other shape is still shown as written, and names (tool names, the project folder) are not masked (`docs/CONTRACT.md` section 5 has the list).
- **Mini window**: a button in the top bar moves the office into a small window that stays on top of other applications (one floor, the number of characters that wait, the scene moving on at most 30 times a second), and `Back to tab` puts it back. It needs Chrome or Edge on a desktop; the button does not appear in Safari or Firefox.
- `--no-open`, `--demo` and `--cdn`.
- A list, in the README and in `docs/CONTRACT.md` section 5.1, of every file the Claude, ChatGPT and Grok desktop-app checks look at.
- This changelog, and issue forms for bug reports, adapter requests and theme ideas.

### Removed

- **Breaking for scripts that read `/api/recap`: the USD cost estimate.** It is gone from the inspector, from the Sprint Recap Markdown and from `/api/recap` (the `estimatedCostUsd` field). The context ring and the token figures stay and are labelled as estimates.
- The percentage in the "context compacted" toast.
- Requests to Google Fonts and, by default, to the jsDelivr CDN.
- Automatic npm releases on every merge.

### Fixed

- The context ring and the token rows are labelled as estimates, in Korean and English.
- The Claude desktop-app log reader takes an MCP tool name only from a parsed `tools/call` request and never reads tool arguments. A name of an unexpected shape becomes a generic label.
- A hook request about a session outside the Claude Code folder is ignored, so another agent that runs Claude hook files no longer appears as Claude Code.
- Hook requests up to 1 MiB are accepted, and for a session whose log is read nothing of the tool input in them is used or kept. The old 4 KiB limit rejected hooks for large edits.
- The demo page (hosted, or opened with `#demo`) no longer calls the local server's API.
- The hosted demo page is a complete HTML document with link-preview tags.
- README statements that were not true: `--open` in the quick start, the "zero dependencies" wording, the privacy note about paths, the Sprint Recap description, the notification guards, and an Antigravity file (`implementation_plan.md`) that was never read.
- The privacy notes in the README now name the pieces of a tool call that reach the page besides file names and host names (for example a search pattern, a web or MCP search query, the agent's one-line description of a command or subagent task, and the headers and option labels of a question; sections 3.1, 4 and 5 of `docs/CONTRACT.md` are the complete list), and say which secret shapes are masked in that text and that everything else is shown as written.
- `office-sim --help` and `docs/CONTRACT.md` said the Antigravity desktop app's folder (`~/.gemini/antigravity/`) is never read. Since 0.2.0 its step logs, task list and two small metadata files are read when the app writes them; the help text, the specification and the README now say so. The app's encrypted `conversations/*.pb` files are still never opened.
