# Launch Readiness Implementation Plan (v0.12.0, GLO-1248)

**Goal:** make a first-time visitor's path work end to end and make every claim in the README literally true. No new in-office features.

**Delivery:** one worktree (`.worktrees/glo-1248-launch-readiness`), one branch, one pull request, one batched release (`0.12.0`).

**Baseline:** `npm test` passes 1391 of 1391 on Node 22.23.2 and Node 24.13.0 at `787e372`.

## Decisions

| ID | Decision |
|---|---|
| D1 | Default port moves from `4317` (OTLP gRPC default) to `4747`, once. No automatic fallback to another port, because the port is written into hook URLs and `skills/office/SKILL.md`. |
| D2 | On `EADDRINUSE` with the default port, probe `GET /healthz`. If the listener is an office-sim, print its URL, open it when opening is enabled, and exit `0`. Otherwise fail with a message naming `--port`. |
| D3 | Supported Node floor is `22` (CI runs 22 and 24). `.nvmrc` stays `24` as the development default. A Node below 22 prints one warning line at startup and continues. |
| D4 | `three@0.160.0` is vendored under `public/vendor/` (`three.module.min.js`, `OrbitControls.js`, `CSS2DRenderer.js`, `LICENSE-three.txt`). The importmap keeps the `three/addons/` prefix on the CDN only for the opt-in WebGPU renderer; the default CSP blocks that host, so the default page contacts loopback only. A new `--cdn` flag adds the CDN to `script-src` for people who want `?renderer=webgpu`. |
| D5 | Google Fonts links are removed. Text uses the system font stacks already listed in `public/office.html`. |
| D6 | When live mode's first complete snapshot has no session, the page plays the demo scenario under a persistent banner and switches to live on the first real session. `--demo` opens the demo directly. |
| D7 | The browser opens by default when stdout is a TTY and `CI` is unset. `--no-open` disables it; `--open` still forces it. |
| D8 | UI language is English unless the browser locale starts with `ko`. A saved choice still wins. |
| D9 | Sound is off by default. A saved choice still wins. |
| D10 | Maintainer tools (Flywheel button, RCI and Lens pill, tail-interval input) show only with `?labs=1` or a saved labs preference. The flywheel scan request is skipped when labs is off. |
| D11 | The USD estimate is removed from the inspector, `/api/recap` and the recap Markdown. The context ring stays and is labelled an estimate. |
| D12 | The Claude Desktop scan stays on by default and is documented in `README.md`, `README.ko.md` and `docs/CONTRACT.md` section 5. |
| D13 | Claude Code hooks add exactly one signal the transcript lacks: permission prompts. The installer and the plugin register only `PermissionRequest` and `Notification`, as `http` hooks. |
| D14 | Hook events for a session the tailer already follows are reduced to `tool_wait`; the transcript stays the source for everything else. Sessions the tailer does not follow keep today's behaviour. |
| D15 | A hook payload whose `transcript_path` is outside the configured Claude root is ignored (another agent reading Claude hook files must not appear as Claude Code). |
| D16 | The hook route accepts bodies up to 1 MiB, answers `200` with `{}`, and keeps nothing from `tool_input` after scrubbing. |
| D17 | Releases are manual: `publish.yml` runs on `workflow_dispatch` only. `package.json` is set to `0.12.0` in this branch. |

### Decisions added after the review of W1 to W5

| ID | Decision |
|---|---|
| D18 | Refines D2. An already running office-sim is reused only when this run passes no option other than `--open`, `--no-open` and `--demo`. With any other option (for example `--replay`, `--auth`, `--agents`, a root, `--notify`, `--cdn`) the port conflict stays an error, and the message names the running URL and `--port`. |
| D19 | With `--demo`, when the browser is not opened, the CLI prints one line `office-sim: demo <url>#demo`. |
| D20 | The desktop app log readers pass nothing from tool arguments to the page. An MCP tool name is taken only from a JSON-parsed client `tools/call` request (`params.name`) and must match `[A-Za-z0-9_.:-]{1,64}`; server names follow the same rule; anything else becomes a generic label. |
| D21 | The first-run banner names no time window: "No agent session is running right now. Start Claude Code, Codex, Grok or Antigravity and it appears here. This is a demo." |
| D22 | Refines D8. Korean is chosen only for the language subtag `ko` (`ko`, `ko-KR`), not for other subtags that start with those letters. |
| D23 | A real release (`dry_run` false) runs only on `refs/heads/master`. |
| D24 | The compaction toast states no percentage. |
| D25 | A hook-derived `tool_wait` carries exactly `toolUseId` and `waiting`, like the Grok one, and is present in snapshots so a reconnecting page still shows the wait. |

### Decisions taken while reviewing W6 to W8

| ID | Decision |
|---|---|
| D26 | A session only hooks report sends no free text of a hook body: `stop_reason` and a tool's `error` are replaced by fixed lines, and `agent_type` shows only when it has the shape of a name. |
| D27 | The specification follows the code on the Antigravity desktop app folder: `<root>/antigravity/` is read (since 0.2.0), and the documents say so. Reverting to the older scope stays an owner decision. |
| D28 | An explicit `--port` is never probed for a running office-sim (D18 covers the default port only); its conflict message keeps the plain hint. |

### Left for a follow-up issue (existing behaviour, not changed here)

- Free text has no secret detector: `cleanText` masks paths, URLs and email addresses, not token-shaped strings. The guardrail line in `CLAUDE.md` 4.2 says more than the code does; which side moves is an owner decision.
- The Grok Bot title is cut to 48 characters before the title scrub, so an address or path that straddles the cut is not recognised.
- A tool that an older thirteen-event hook install opened stays in the bridge's open list after the Store starts to follow that session.
- The settings write of the hook installer is not atomic (backup, then write).
- The WebGPU timeout reason is English only; the English README keeps one Korean phrase in the Grok row because `test/grok-docs.test.mjs` pins it.

## Work items, in dependency order

Each item is one commit. Tests are written first and run with `node --test test/<file>.test.mjs`. New code goes in new modules because ten files sit within six lines of the 500-line cap (`office.js`, `hud.js`, `agent.js`, `session.mjs`, `rooms.js`, `office.html`, `flywheel/control.mjs`, `placement.js`, `store.mjs`, `server-runner.mjs`).

### W1. Manual releases and hosted demo head

- `.github/workflows/publish.yml`: remove the `push` trigger; keep `workflow_dispatch` with `dry_run` (default `true`); drop conditions that test for a push event.
- `scripts/build-demo.mjs` (new, zero dependencies): writes `_site/index.html` as head plus `public/office.html` plus tail, with `lang="en"`, description, canonical, Open Graph and Twitter card tags, and copies one existing image as `og.png`.
- `.github/workflows/pages.yml`: call the script instead of copying the fragment.
- `package.json`: version `0.12.0`.
- `CHANGELOG.md` (new): human-written entry for `0.12.0`.
- Test: `test/build-demo.test.mjs` runs the script into `os.tmpdir()` and checks doctype, viewport and tags.

### W2. Port and Node floor

- `src/server.mjs` `DEFAULTS.port` -> `4747`; `src/hooks-receiver.mjs` default port; `.claude/launch.json`; `skills/office/SKILL.md`; `README.md`, `README.ko.md`, `docs/CONTRACT.md`.
- `src/cli-main.mjs` (new) takes the current body of `bin/office-sim.mjs`; the bin becomes a short stub that checks `process.versions.node`, prints the warning (D3), then imports the real entry.
- `src/port-reuse.mjs` (new): the `/healthz` probe for D2.
- Reconcile the Node floor text in `package.json`, `docs/CONTRACT.md` section 0, `skills/office/SKILL.md`, `.github/workflows/test.yml` comment.

### W3. Loopback-only assets

- Add `public/vendor/` files (D4) with sha256 pins checked by a test.
- `public/office.html`: importmap entries, remove font links (in-place edits only).
- `src/server-http.mjs`: a `/vendor/<name>` allowlist route. `src/server-guard.mjs`: CSP without the CDN and font hosts; `--cdn` adds `https://cdn.jsdelivr.net` to `script-src`.
- `scripts/verify-dom-invariants.mjs` and `docs/CONTRACT.md` section 0: third-party files under `public/vendor/` are exempt from the 500-line cap.
- `package.json` `files` already includes `public/`.

### W4. First run

- `public/js/empty-state.js` (new): banner, ko/en strings, demo overlay control.
- `public/js/main.js`: live source plus an overlay demo source; switch on the first real `session` event through the existing reset path.
- `src/cli-args.mjs`: `--demo`, `--no-open`, `--cdn`; `src/cli-main.mjs`: default open (D7), a terminal line when no session is attached.
- `public/js/rooms.js` `detectLang` (D8); `public/js/hud.js` sound default (D9); static Korean strings in `public/office.html` get an English default; `src/server-http.mjs` `HEAD` uses `lang="en"`.
- `public/js/labs.js` (new) and small gates in `flywheel-panel.js`, `sim-overlays.js`, `sim-flywheel-viz.js` (D10). Demo mode skips `/api/notify` and `/api/flywheel`.

### W5. Honest numbers and disclosure

- `src/session-recap.mjs`, `public/js/agent-extras.js`: remove cost constants, fields and UI (D11); label the ring.
- `README.md`, `README.ko.md`, `docs/CONTRACT.md` section 5: Claude Desktop scan (D12).

### W6. Hook receiver

- `src/hooks-bridge.mjs` (new): owns the hook route logic. Accepts `PermissionRequest` (no `tool_use_id`) and `Notification` with `notification_type: "permission_prompt"`; maps the wait to the session's newest open non-ask tool; if no tool is open yet, holds the wait (bounded, short time to live) and emits `tool_wait` right after the matching `tool_start`; applies D14, D15, D16.
- `src/hooks-receiver.mjs`: `HOOK_EVENTS` becomes `['PermissionRequest', 'Notification']`; the installer writes `http` hooks, still merges, still backs up once, and the uninstaller also removes the older command hooks.
- `src/server-http.mjs`: the route delegates to the bridge with the larger body limit.
- `docs/CONTRACT.md` sections 2, 5 and 7: `tool_wait` for Claude Code through hooks; raw hook bodies are discarded after scrubbing.

### W7. Install path

Facts below were read from the Claude Code plugin and hook reference on 2026-11-12.

- Layout: the marketplace file lives at the repository root, the plugin in its own small directory so the plugin cache copies only that directory ("Files outside the plugin directory aren't copied"):
  - `.claude-plugin/marketplace.json`: required `name`, `owner.name`, `plugins[]`; the entry has `name` and `source: "./plugin"`.
  - `plugin/.claude-plugin/plugin.json`: `name` is the only required key; also `version`, `description`, `author.name`, `homepage` (must parse as a URL), `repository`, `license`, `keywords`.
  - `plugin/skills/office/SKILL.md`: byte-identical copy of `skills/office/SKILL.md`, enforced by a test. The skill is invoked as `/office-sim:office`.
  - `plugin/hooks/hooks.json`: a top-level `hooks` key wrapping the event map, with `type: "http"` handlers (`url`, optional `timeout` in seconds) for `PermissionRequest` and `Notification`, posting to `http://127.0.0.1:4747/api/hooks/claude`.
- Documented http hook behaviour: a connection failure and a non-2xx status are non-blocking errors; a 2xx with an empty body counts as success with no output; the default timeout is 600 seconds, so the hooks set a short one. An `allowedHttpHookUrls` policy applies to plugin hooks.
- Install commands for the README: `/plugin marketplace add WahyzMaster/office-sim`, then `/plugin install office-sim@office-sim`.
- `src/cli-init.mjs` (new): `office-sim init`, `office-sim hooks install|uninstall|status`; prints the diff first, writes only with `--yes` or an interactive confirmation, supports `--settings <path>` for tests.
- `skills/office/SKILL.md`: one text that works from a clone (symlink install), from the plugin and from `npx`. When no checkout is reachable it starts the server with `npx -y office-sim@latest --no-open`.
- `public/js/needs-you.js` (new): count of agents with a live ask or wait in `document.title` and one chip that cycles focus.

### W8. README top

- First screen: one plain sentence, three behaviour bullets, the `npx` line, what a first run shows, and a detection coverage table per agent (question, plan approval, permission prompt, done) stating which signals need the plugin.
- Internal phase codes and DOM ids leave the top; galleries and reference tables move below.

### W9. Mini window (separate commit; the spike passed)

- `public/js/pip.js` (new): Document Picture-in-Picture window with the stage, one floor, capped frame rate.
- Spike result (headed Chrome 157): a WebGL canvas moved into the Picture-in-Picture document keeps its context and keeps drawing when the loop runs on that window's animation frames.
- Decisions D29 to D31 below are binding for this item.

| ID | Decision |
|---|---|
| D29 | The mini window is a Document Picture-in-Picture window. Its control is shown only where the browser has `documentPictureInPicture` (desktop Chromium); elsewhere no control is shown. It adds no origin, no server route and no stored state. |
| D30 | While the mini window is open it holds the stage (the canvas and its labels) and the tab shows a placeholder with a control that brings the stage back. Closing the mini window, by its own control, by the placeholder's control or by the window's close button, puts the stage back and restores the earlier view. While it is open the frame loop runs on the mini window's animation frames, at no more than 30 frames per second. |
| D31 | The mini window shows one floor: the focused floor, or the floor of a waiting character when no character waits on the shown floor. It carries one line of text, the waiting count, and one control that returns to the tab. |
| D32 | In the mini window the room signs are hidden; name tags and bubbles stay. The waiting count there is plain text without the chip's tooltip. |

## Expected test changes

A reviewer should treat only these as intended updates. Any other weakened or deleted assertion is a defect.

| Test file | Intended change |
|---|---|
| `test/open-url.test.mjs`, `test/cli-names.test.mjs`, `test/skill-file.test.mjs`, `test/skill-commands.test.mjs`, `test/summarize.test.mjs` | Port `4317` -> `4747`; new flags in `USAGE` order; default open and `--no-open`. |
| `test/http-hardening.test.mjs` | CSP: no `cdn.jsdelivr.net`, no font hosts by default; `--cdn` variant; `/vendor/` route. |
| `test/browser-names.test.mjs` | `detectLang`: non-`ko` locales give `en`. |
| `test/p1-p4-roadmap.test.mjs`, `test/records.test.mjs` | `HOOK_EVENTS` set, `http` hook shape, hook route response `{}`; no cost fields. |
| `test/server.test.mjs`, `test/runner-group.test.mjs` | `lang="en"` in the served head, if asserted. |
| `test/share-overlay.test.mjs` | `publish.yml` trigger: the `push` on `master` assertion becomes `workflow_dispatch` only, no `push` (D17). Added in the W1 repair round: the old assertion cannot hold once D17 removes the push trigger. |
| `test/first-run-cli.test.mjs` | `--demo` without an opened browser now prints the demo line (D19); the old pin that `#demo` is absent goes. |
| `test/first-run-page.test.mjs` | The banner names no time window (D21): the pins on `30분`, `last 45 minutes`, the fallback to 30 and the `DEFAULT_ACTIVE_MINUTES` export go, and a changed `activeMinutes` no longer refreshes the chip tooltip. |
| `test/desktop-disclosure.test.mjs` | The pins on the `"name"` pattern wording become pins on `params.name`, `params.arguments`, the name shape and the generic labels (D20). |
| `test/release-workflow.test.mjs` | `no job-level condition` and `exactly 3 ifs` become the master-only job condition (D23). |
| `test/cdn-flag.test.mjs` | A WebGPU import that does not answer in time is a timeout, not a refused load: it leaves the list that expects the `--cdn` hint and gets its own test (no `fallbackCode`, no hint). Follow-up item 11 of the W1 to W5 review. |
| `test/adapter-antigravity-conformance.test.mjs` | Message text of one assertion only (what it checks is unchanged): the bait conversation sits in a folder next to the app roots; the desktop app folder itself is read since 0.2.0. |

## Constraints for every change

- Node built-ins only in `bin/`, `src/`, `scripts/`. Loopback bind only.
- Scrubbing: basenames and hostnames only; nothing from `tool_input` is stored or sent to the page.
- Tests use `os.tmpdir()`; never a real `~/.claude`, `~/.codex`, `~/.grok` or `~/.gemini`.
- Korean and English strings for every new UI text.
- Files at or under 500 lines.

## Verification

1. `npm test` on Node 22 and 24.
2. `node scripts/verify-dom-invariants.mjs` and `verify_project_surface.py`.
3. `worktree_land.sh preflight`.
4. Real page, from the worktree build:
   - an empty home directory shows the demo with the banner;
   - the network log lists loopback requests only;
   - a fixture `PermissionRequest` POST walks the character to the approval booth;
   - a non-Korean locale shows English.

## Not verified here

Claude Code's live behaviour with these hooks (hook target down or slow, an empty `2xx` on `PermissionRequest`) needs a real Claude Code session and is left to the maintainer's check before the README claims permission prompts for Claude Code without qualification.
