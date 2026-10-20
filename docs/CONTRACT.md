# office-sim server contract (P1-P3, P5a, P5b)

The server tails Claude Code session transcripts under `~/.claude/projects`, turns records into UI events,
and streams them to the 3D office page (`public/`) over SSE. This file is the single source of truth for
module boundaries, the event schema and the parsing rules. The format rules come from a corpus study of
5,016 local transcript files (Claude Code 2.1.181 to 2.1.299, entrypoint `claude-desktop`).
Claude Code is the only adapter today; Codex, Grok and Antigravity are planned as separate adapters (see 4.0).
The approved multi-agent design is `docs/ADAPTERS.md`; its shared groundwork (P5a) is in 4.0.1 and the shared session
core for the new adapters (P5b) in 4.0.2.

## 0. Ground rules

- Node 20 (`node -v` = 20.20), ESM (`.mjs`), **zero npm dependencies**. Tests use `node:test` + `node:assert/strict`.
  Run all tests with `node --test test/`.
- Every source file stays under 500 lines. No `console.log` in `src/` (use the injected `log` callback); `bin/` may print.
- Comments may be Korean or English; identifiers are English.
- **Never read from or write to the real `~/.claude` in tests.** Tests build synthetic fixtures in a temp dir
  (`fs.mkdtemp(os.tmpdir() + '/office-sim-')`). Fixture text must be invented, never copied from real transcripts.
  The same holds for the planned adapter roots `~/.codex`, `~/.grok` and `~/.gemini`: tests pass temp roots only.
- The server binds `127.0.0.1` only and serves only to the local browser. It still sends **summaries, not content**
  (see section 5). Loopback is not per-user: without `--auth` any local process or other OS user can read `/state`
  and `/events`. `--auth` (section 6) closes that for other OS users and for web pages; it does not protect against
  processes of the same user, which can read the transcripts directly anyway.

## 1. Layout

```
bin/office-sim.mjs      CLI: parse args, start server, print URL
src/cli-args.mjs        argv -> start() options (pure), USAGE text
src/summarize.mjs       tool_use -> { summary, room? } (pure); cleanText, the one section 5 text scrub
src/summarize-shell.mjs Bash/Monitor command -> program name (+ allow-listed subcommand) (pure)
src/plan.mjs            update_plan / task list / ExitPlanMode plan reconstruction (pure)
src/records.mjs         one parsed jsonl record -> normalized items (pure)
src/session.mjs         SessionState: ordered items -> UI events (stateful, per transcript file)
src/session-util.mjs    tool_result status + error line, ask fields, public tool name, project key (pure)
src/session-identity.mjs titles, branch/worktree/agentType labels, the `session` event with its `agent` id (pure)
src/session-plan.mjs    PlanBoard: plan/task whiteboard state for one SessionState
src/discover.mjs        find transcript files + read subagent meta / workflow journal labels
src/tailer.mjs          per-file byte-offset tail with partial-line buffer
src/store.mjs           registry of sessions and projects, entry agent, event ring buffer, snapshot, announce, patch,
                        since, endCharacter (4.0.1); calls store-claude.mjs only for entries whose agent is claude-code
src/store-claude.mjs    Claude subagent linking (4.5, R28/R29, R36 forwarding), split out of store.mjs in P5a:
                        observe, onResult, onNotification, subByToolUse, the Claude part of endAgent, task deltas,
                        buffered sub meta and journal labels
src/store-link.mjs      Store helpers: file identity, link facts, per-session index, ring lookup (pure)
src/adapters/index.mjs  adapter registry: KNOWN_AGENTS, AGENT_LABELS, ADAPTERS, enabled-adapter selection (4.0.1)
src/adapters/claude-code.mjs the claude-code descriptor; points at the Claude modules where they are (D8)
src/core/tool-summary.mjs normalized tool descriptor -> { tool, summary, room?, background? } (pure, 4.0.2)
src/core/session-core.mjs SessionCore: normalized items -> UI events, the SessionLike API for the new adapters;
                        used by no adapter yet (4.0.2)
src/core/session-items.mjs pure shaping of normalized items into event fields for SessionCore (caps, scrub, plan view)
src/server.mjs          start(): wires Store, RunnerGroup (one Runner per enabled adapter, defined here) and the
                        HTTP layer
src/server-runner.mjs   Runner: poll / rescan / idle loops, attach, relocation, backoff
src/server-http.mjs     http: /, /js/*, /events (SSE), /state, /config, /healthz
src/server-guard.mjs    page CSP, Sec-Fetch-Site check, --auth token and cookie
src/replay.mjs          ReplayRunner (extends Runner): --replay playback of one session (section 6.1)
src/replay-timeline.mjs replay timeline: line times, cross-file merge, speed + gap cap, approval look-ahead (pure)
test/*.test.mjs         unit + integration tests, synthetic fixtures under test/fixtures/ or generated
test/fixtures/conformance.mjs adapter conformance harness (ADAPTERS 10, 4.0.2), run by test/adapter-conformance.test.mjs
                        against the test-only core-fixture adapter (test/fixtures/core-adapter.mjs)
public/                 the browser app; owned by the browser module (public/js/*), server work does not edit it.
                        P3: js/detail.js (per-floor detail: hidden floors skip draw, matrices, labels, animation;
                        unfocused floors cast no shadows; CSS labels only for the focused floor), js/bench.js (#bench)
```

## 2. Event schema (server -> browser)

Every event is one JSON object `{ type, sessionId, ts, ...fields }`. `ts` is the record timestamp (ISO) when known,
else the server time. `sessionId` is the character id: the main session uuid, or the subagent `agentId`
(`a` + 16 hex) for subagent files.

| type | fields |
|---|---|
| `session` | `agent` (stable source id of the adapter, see below), `project` (stable floor key, see 4.4), `projectLabel` (basename), `title` (<= 80), `branch` (<= 60, `HEAD` -> `detached`), `worktree` (name <= 60, or null), `isSubagent`, `parentSessionId` (null for main), `agentType` (subagent only, <= 60) |
| `session_end` | `reason`: `done` \| `idle` |
| `prompt` | `text` (human prompt, <= 80 code points) |
| `tool_start` | `toolUseId`, `tool` (raw name, except a connector-uuid mcp server segment, see 5), `summary`, `room` (optional hint, see 5), `question`, `options` (ask tools only), `background` (bool, optional), `awaitsApproval` (`true` only in replay mode, when the call waited for a human answer to a permission prompt, see 7) |
| `tool_end` | `toolUseId`, `ok` (bool), `errorKind`: `failed` \| `denied` \| `interrupted` \| `abandoned` (absent when ok), `error` (<= 120 code points, absent when ok) |
| `thinking` | `text` (first sentence <= 100 code points, or `null` when the block is signature-only), `durationMs` (number or null) |
| `say` | `text` (<= 100 code points) |
| `plan` | `items`: `[{ content, status }]` with status `pending` \| `in_progress` \| `completed`, `source`: `update_plan` \| `tasks` \| `exit_plan`. Every `content` is scrubbed (section 5) and capped at 80 code points. `exit_plan` carries at most 6 items (`planFromMarkdown`, each raw line cut at 1000 chars before parsing); `update_plan` and `tasks` carry the whole list (no count cap) |
| `turn_end` | `reason`: `stop_hook` \| `api_error` \| `interrupt` \| `wrap_up` \| `next_turn` \| `end_turn` |
| `system` | `kind`: `api_error` \| `compact` \| `refusal`, `text` |

`session.agent` names the tool whose transcript the character comes from, so every character (main sessions and
subagents alike) carries an agent id. It is on every `session` event, live and in snapshots. Ids: `claude-code`
(the only one today), and `codex`, `grok`, `antigravity` for the planned adapters. The page shows the labels
`Claude Code`, `Codex`, `Grok`, `Antigravity`, and an unknown id as-is. The id flows from the file's `FileRef.agent`
through its `SessionState` and its Store entry (4.0.1).

Wire messages on `/events` (each SSE `data:` line is one JSON object, every message has an `id:` line = seq):
- `{ "type": "snapshot", "events": [ ...events ] }` first message on every connection (or replay, see 6).
- `{ "type": "config", "intervalMs": n, "activeMinutes": n }` after a config change and right after the snapshot.
  In replay mode it also carries `replay: { state, speed, loop, round, progress }` (`state`: `loading` | `playing` |
  `done` | `restart` | `error`; `progress` 0..1 by released lines) and is re-sent when the state changes and at most
  once a second while the progress moves (section 6.1).
- any event from the table above.

## 3. Pure module APIs

### 3.1 `src/summarize.mjs`
```js
export function summarize(tool, input) // -> { summary: string, room?: string, background?: boolean, ignore?: boolean }
export function truncate(text, maxCodePoints) // code-point safe, strips control chars, collapses whitespace
export function hostOf(url) // host only, '' on failure
export function cleanText(value, max) // section 5 scrub, then truncate; non-strings -> ''
export function looksLikeUuid(s)      // loose connector-uuid test (8-4-4-4-12 with one-char typos, or 24+ hex)
export const ZERO_UUID                // '00000000-0000-0000-0000-000000000000', the mask for connector uuids
```
- `ignore: true` for app plumbing: every `mcp__ccd_*`, `ToolSearch`, `ListAgents`, `ListMcpResourcesTool`,
  `mcp__visualize__read_me`, `mcp__serena__initial_instructions`, `mcp__firebase__firebase_get_environment`,
  `mcp__computer-use__request_access|request_full_control|release_full_control|app_release`,
  `mcp__claude-in-chrome__tabs_context_mcp|list_connected_browsers`, `mcp__Claude_Browser__tabs_context|preview_list`.
- Summaries (all truncated by code point, never raw content):
  Bash/Monitor: `description` (<= 60) else program name (+ subcommand) after stripping leading `cd <dir> &&`
  and `VAR=val` tokens and dropping tokens containing `/` or `=`; a subcommand after a bare option is dropped (rule
  below). Read/Edit/Write/NotebookEdit: basename of
  `file_path` (Read adds ` L<offset>-<offset+limit>` when both numeric). Grep: `pattern` (<= 40) + basename(path).
  Glob: `pattern`. WebFetch/`*navigate`/preview_start: host. WebSearch/tavily_search: `query` (<= 60).
  Agent: `description` (+ ` · <subagent_type>` for built-ins general-purpose/Explore/Plan). Workflow:
  `description` ?? basename(scriptPath) ?? `inline workflow`. Skill: skill name. SendMessage: `to <name>`.
  TaskCreate: `subject`. TaskUpdate: `#<id> -> <status>` (accept `taskId|id|task_id`). AskUserQuestion: headers
  joined. ExitPlanMode: `plan ready`. mcp tools: split on `__`, never show a server segment that looks like a
  uuid; use the most descriptive short key (`query`, `libraryName`/`libraryId`, `collection_path`/`collectionId`,
  `element`, `action_summary`/`action`, `title`), skipping a value that looks like a uuid, else the tool suffix with
  `_` -> space. Every summary piece goes through `cleanText` (section 5).
- Bash/Monitor program name (`summarize-shell.mjs`), when there is no `description`: wrappers (`env sudo time nohup
  command exec nice timeout caffeinate builtin`) are skipped together with their options and option values
  (`sudo -u USER`, `env -C DIR`, `timeout -s SIG`, `--opt value`, `--` ends them); `$( ... )` and backtick
  substitutions stay inside one token; heredoc bodies (`<<WORD`, `<<-WORD`, quoted or escaped delimiters, not `<<<`)
  are dropped, and a missing terminator drops the rest (fail closed); `<<` inside `$(( ))` or before a digit or `=`
  is a shift; an unquoted `#` at the start of a word starts a comment up to the newline.
  Subcommand (only for the allow-listed CLIs): the first argument that is not a flag and holds no `/`, `\` or `=`.
  A bare option before it (starts with `-`, no `=`: `-n`, `-C`, `--project`, also an attached `-nVALUE`) drops the
  subcommand, because it may be that option's value (a project, account, profile, namespace, host or path):
  `gcloud --project p run` -> `gcloud`, `kubectl -n ns get` -> `kubectl`, `git -C repo status` -> `git`, `npm --prefix
  dir install` -> `npm`. Fail closed: `git --no-pager log` and `git -C /abs/repo log` also show only `git`. An option with
  `=` keeps it (`kubectl --context=prod get` -> `kubectl get`), and so do options after it (`kubectl get -n ns` ->
  `kubectl get`). Wrapper options are not in between (`sudo -u root git status` -> `git status`). This is the one shell
  rule: the core `tool-summary` (4.0.2) calls the same `programOf`.
  `__unparsedToolInput` -> `<tool> (unparsed input)`. Unknown tools -> tool name.
- `room` hint (only where the tool name alone is ambiguous): Bash/Monitor by program name: `grep rg ag find fd ls tree
  cat head tail less wc sed awk jq file stat du` -> `archive`; `curl wget http` -> `research`; anything else -> `server`.
  TaskOutput/TaskStop -> `server`. StructuredOutput/SubagentHandback -> `here`. ScheduleWakeup -> `lounge`.
- `background: true` when `run_in_background` is truthy (`true` or `'true'`).

### 3.2 `src/plan.mjs`
```js
export function emptyPlan()                         // { items: [] }
export function applyUpdatePlan(plan, input)        // returns a NEW plan; never mutates
export function reconcilePlanText(plan, resultText) // trust "Plan updated: step K of N is in progress." / "Plan shown (N steps)."
export function emptyTasks()                        // { tasks: [] }  task = { id, subject, status, activeForm? }
export function applyTaskReminder(tasks, content)   // replace with snapshot; [] clears
export function applyTaskCreate(tasks, input, toolUseResult, resultText) // id from toolUseResult.task.id or /Task #(\d+) created/
export function applyTaskUpdate(tasks, input)       // patch; status 'deleted' removes
export function tasksToItems(tasks)                 // -> [{ content: subject, status }]
export function planFromMarkdown(md, max = 6)       // ExitPlanMode plan -> pending items from headings / top-level list items
```
Rules: `{items}` replaces the list. `{advance:true}` completes the in_progress item and starts the first pending item
after it, else the next index; no in_progress -> no change. `{done:[...], start:n}` is 1-based: complete `done[i]-1`,
then mark `start-1` in_progress, leave the rest. Reconciliation: when the result text names step K of N and the
replayed in_progress index differs, move only the in_progress marker to K-1 and leave every other status as it is.
An `{items}` call always wins over reconciliation (the text `Plan shown (N steps)` only confirms the length).

### 3.3 `src/records.mjs`
```js
export function classifyRecord(rec) // -> { kind, ... } (one of the kinds below), pure, never throws
```
Kinds (classify by top-level `type`, then `subtype` / content):
- `meta`: uuid-less sidecars. Return `{ kind:'meta', field, value }` for `custom-title`->title, `agent-name`->agentName,
  `last-prompt`->lastPrompt, `worktree-state`->worktree (object or null), `relocated`->relocatedCwd, `summary`->summary.
  All other uuid-less types (`queue-operation`, `pr-link`, `atis-latch`, `mode`, `bridge-session`, `frame-link`,
  `file-history-*`, `artifact-*`, `cost-state`) -> `{ kind:'ignore' }`.
- `assistant`: `{ kind:'assistant', uuid, msgId, synthetic, apiError, stopReason, model, thinkingDurationMs, blocks }`
  where blocks are `{type:'thinking', text}`, `{type:'text', text}`, `{type:'tool_use', id, name, input}`
  (`server_tool_use` and `advisor_tool_result` are dropped). `synthetic` = model `<synthetic>`; `apiError` =
  `isApiErrorMessage === true`.
- `tool_result`: `{ kind:'tool_result', uuid, toolUseId, isError, text, toolUseResult, toolDenialKind, endTurn }`
  (`text` = content string or joined text blocks; `endTurn` = `mcpMeta._meta['claude/endTurn'] === true`
  or `toolEndsTurn === true`).
- `prompt`: real human prompt per rules R17-R19 below: `{ kind:'prompt', uuid, promptId, text }`.
- `interrupt`: text starting `[Request interrupted by user` -> `{ kind:'interrupt', uuid, promptId, forTool }`.
- `notification`: origin.kind `task-notification` (user record or queued_command attachment) ->
  `{ kind:'notification', uuid, promptId, toolUseId, taskId, status, summary }` parsed from the XML-ish tags.
- `turn_start`: any other user record that carries a `promptId` (peer, isMeta, command echoes, compact summary)
  -> `{ kind:'turn_start', uuid, promptId, isCompactSummary }`.
- `system`: `{ kind:'system', uuid, subtype, retryAttempt, maxRetries, status, text }` for `stop_hook_summary`,
  `api_error`, `compact_boundary`, `model_refusal_fallback`; other subtypes -> `ignore`.
- `task_reminder`: attachment `task_reminder` -> `{ kind:'task_reminder', uuid, content }`.
- `queued_prompt`: attachment `queued_command` with `commandMode:'prompt'`, not isMeta -> `{ kind:'prompt', ... }`.
- everything else -> `{ kind:'ignore', uuid }`.
Every non-meta kind also carries `ts` (record timestamp), `cwd`, `gitBranch`, `sessionId`, `agentId` when present.

### 3.4 `src/session.mjs`
```js
export class SessionState {
  constructor({ id, file, kind /* 'main'|'sub'|'wf' */, stem, parentId = null, agentType = null, subMeta, journalLabel,
                agent = 'claude-code', now = Date.now })
  apply(rec, { replay = false } = {}) // -> events[] (empty when replay); updates state in both modes
  idle(nowMs)                        // -> events[] for timeouts (abandoned tools, idle subagent end)
  setInfo(info)                      // late meta.json / journal label / custom title / parent project -> events[]
  takeTaskDeltas()                   // sub/wf: TaskCreate/TaskUpdate deltas for the main's list (R36)
  applyExternalTask(delta)           // main: apply one of those deltas -> events[]
  sessionEvent()                     // -> current `session` event
  snapshotEvents()                   // -> events that recreate the current state: session, plan, open tool_starts, open ask
  get title(); get firstCwd(); get lastActivityMs(); get ended()
}
```
Responsibilities: dedupe by uuid (keep first copy; a replayed copy produces no events), skip records whose
`sessionId` differs from `stem` for main files (fork history; still collect uuids), track pending tools keyed by
tool_use id (store name, msgId), group assistant lines by `msgId`, plan + task state via `plan.mjs`, turn tracking
via promptId, title per 4.3. In replay mode the state is built exactly as live, but nothing is emitted.
`agent` is the adapter id of the `session` event: `buildSessionEvent` (`session-identity.mjs`) writes
`s.agent ?? 'claude-code'`.

### 3.5 `src/discover.mjs`
```js
export async function scan(root, { activeMs, nowMs }) // -> FileRef[] for files with mtime >= nowMs - activeMs
// FileRef = { path, kind:'main'|'sub'|'wf', stem, sessionId, agentId, runId, projectDir, mtimeMs, size, ino, agent }
// agent: adapter id (string). When a ref has none, the Runner sets it from deps.agent (4.0.1).
export async function readSubMeta(jsonlPath)        // agent-<id>.meta.json -> object | null (missing is normal)
export async function readJournalLabels(runDir)     // journal.jsonl 'started' -> Map(agentId -> label)
export async function sessionRefs(mainPath)         // replay: the main FileRef + its <stem>/subagents/** refs
```
Main = `<root>/<dir>/<uuid>.jsonl`. Sub = `<root>/<dir>/<sid>/subagents/agent-<id>.jsonl`. Wf =
`<root>/<dir>/<sid>/subagents/workflows/<runId>/agent-<id>.jsonl`. Never treat `journal.jsonl`, `*.meta.json`,
`*.prefix.json`, `workflows/<runId>.json`, `tool-results/`, `session-memory/`, `memory/` as transcripts.
Tolerate ENOENT anywhere (files move live). If the same main stem exists in several dirs, prefer the one with a
`<stem>/` subdir, then newest mtime, then largest size.

### 3.6 `src/tailer.mjs`
```js
export class Tailer {
  constructor({ maxLineBytes = 8 * 1024 * 1024, chunkBytes = 4 * 1024 * 1024 })
  async readAll(ref, onLine, { end }) // attach: stream the file from byte 0 (up to `end` when given), call onLine(line)
                              // per complete line, yield to the event loop between chunks; remembers offset + ino
  async poll(ref, onLine)     // read [offset, size); carry a trailing partial line; size < offset or ino change ->
                              // returns { reset: true, size } (caller re-attaches); returns { bytes }
  rename(from, to, { ino, size }) // carry offset + partial line to a moved path (same inode only, not shorter, idle)
  forget(path)
}
```
After a reset the runner re-attaches at once (no wait for the next rescan) and replays only up to the `size` seen at
the reset; lines appended after it come from the next `poll` as live events.
Lines longer than `maxLineBytes` are skipped (count them). JSON parsing happens in the caller.

### 3.7 `src/store.mjs`
```js
export class Store {
  constructor({ log, ringSize = 1000, seqStart = 0, now = Date.now }) // the server starts seq at Date.now()
  attachFile(ref, sessionState)            // registers, entry.agent = ref.agent ?? 'claude-code'; links Claude subagents (4.5);
                                           // null (not attached) for a non-Claude ref breaking D2 (4.0.1 F2)
  ingest(path, events)                     // assigns seq ids, pushes to ring, notifies listeners
  endCharacter(charId, reason = 'done', agent = null) // common end hint (4.0.1): one session_end for a live, not-ended
                                           // character; with `agent` only that adapter's character (F3), kept for a
                                           // character not announced yet (F4)
  stats()                                  // { rejectedRefs } (4.0.1 F2, a lower bound), merged into start().stats()
  subscribe(fn) / unsubscribe(fn)
  snapshot()                               // { seq, events } built from every live SessionState.snapshotEvents()
  since(seq)                               // events after seq if still in the ring, else null
  rekey(from, ref)                         // same-inode relocation: move the entry, no replay, no re-announce
}
```
Outgoing subagent `session` events are patched by the Store: `parentSessionId` is the linked owner (validated as an
id, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, else the main session), `agentType` is `meta.agentType` through the section 5
scrub capped at 60, `title` per 4.3. `meta.parentAgentId` is used for linking only when it looks like an agent id.
`agent` on a patched event is the event's own agent, else the entry's agent (else `claude-code`). The linking itself (4.5) runs in `store-claude.mjs`, and only for
entries whose agent is `claude-code`.

## 4. Parsing rules (from the corpus study; R-numbers are referenced by tests)

### 4.0 Adapter scope
- Everything in this section (4.1-4.5, R6-R36), together with the file layout in 3.5 and the record kinds in 3.3, is
  the Claude Code adapter: how Claude Code transcripts are found and read. Its `session` events carry
  `agent: 'claude-code'`.
- A future adapter (Codex, Grok, Antigravity) brings its own log discovery and record mapping, but must emit the same
  event schema (section 2) with its own `agent` id, and must send every free-text field through the shared
  `cleanText` scrub and the privacy rules of section 5. The Store, the SSE wire format and the page stay shared.

### 4.0.1 Multi-agent groundwork (P5a)
The multi-agent design (`docs/ADAPTERS.md`) was approved on 2026-10-20 with every decision D1-D12 at its recommended
option. P5a is the shared groundwork from its section 9. `claude-code` is still the only registered adapter, and the
events built from Claude transcripts are byte-for-byte the same as before P5a (the store split changes no Claude
behaviour). What P5a adds at the server level is in section 6: `--agents`, the reserved roots, the printed agents
lines, `/healthz` `agents`, and a missing root that turns its adapter off until the root can be opened (F1 below).

Approved decisions (reasons and the alternatives not taken: ADAPTERS section 11):
- D1 Floors: every adapter uses the same `projectKey`, so the same cwd is the same floor whatever the tool. A tool-only
  worktree (`~/.codex/worktrees/<id>/<name>`, `~/.grok/worktrees/<repo>/<name>`) joins an existing floor whose basename
  is `<name>` / `<repo>`, else gets its own floor (a heuristic, so the HUD shows a worktree badge).
- D2 Character ids: Claude ids stay as they are; the other adapters prefix theirs with `codex-`, `grok-`,
  `antigravity-` (a `:` would break the id rule `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`).
- D3 Enabling: every implemented adapter whose root exists is on; `--agents` narrows the set; the bin prints the
  enabled ids at start.
- D4 Rooms: the server puts a `room` hint on every new-adapter `tool_start` and names MCP calls `mcp__<server>__<tool>`;
  the page does not change.
- D5 `plan.source`: no new values. Full lists (Codex `update_plan`, Grok `plan`) are `update_plan`, markdown plan
  proposals are `exit_plan`, the Antigravity `task.md` checklist is `tasks`.
- D6 Antigravity scope: the CLI (`agy`) and old IDE transcripts only; the desktop app is out of scope (its
  conversation files look encrypted).
- D7 Grok live approval wait (`events.jsonl`): a separate, optional stage after the base Grok adapter; the contract
  change it needs is decided then.
- D8 No file moves: the Claude modules stay where they are; new code goes to `src/adapters/` (and later `src/core/`).
- D9 Claude keeps its `SessionState`; whether it moves onto the shared `SessionCore` is decided after P5.
- D10 Codex: guardian (auto-approval review) threads are hidden; code-mode `exec` shows a short visit per inner item;
  `update_plan` calls inside scripts are not shown in the first version; `/review` threads are ordinary subagents.
- D11 Order: Grok, then Codex, then Antigravity CLI.
- D12 Replay (`--replay`, 6.1) stays Claude-only in P5.

Adapter registry (`src/adapters/index.mjs`):
- `KNOWN_AGENTS = ['claude-code', 'codex', 'grok', 'antigravity']`: every id the CLI accepts.
- `AGENT_LABELS`: display labels, the same as `AGENT_LABEL` in `public/js/hud.js` (`Claude Code`, `Codex`, `Grok`,
  `Antigravity`).
- `ADAPTERS = { 'claude-code': claudeCode }`: the implemented adapters.
- Selection (D3): an implemented adapter whose root exists is enabled. A requested list (`--agents`) narrows the set.
  A requested id that is in `KNOWN_AGENTS` but not implemented is reported as `not implemented yet` and skipped; an id
  outside `KNOWN_AGENTS` is an error. Every list (enabled, off, not implemented) follows `KNOWN_AGENTS` order without
  duplicates, in live and replay mode alike. A root check that has not answered within 2 s (`PROBE_TIMEOUT_MS`, a
  stalled network or FUSE mount) counts as unreadable with code `ETIMEDOUT`.
- Descriptor (`src/adapters/claude-code.mjs`): `id: 'claude-code'`, `defaultRoot: '~/.claude/projects'`, `deps()`
  returning the bundle the server injected before P5a (`SessionState`, `Tailer`, `scan`, `readSubMeta`,
  `readJournalLabels`), and replay support (6.1, D12). It points at the existing modules in place (D8).

Agent id flow:
- `FileRef.agent` (string) is the adapter id. When a ref has none, the Runner sets `ref.agent = deps.agent`.
- `Store.attachFile` records `entry.agent = ref.agent ?? 'claude-code'`; `Store.patch` keeps the event's own `agent`
  and falls back to the entry's agent.
- `SessionState` takes an `agent` option (default `'claude-code'`); `buildSessionEvent` writes `s.agent ?? 'claude-code'`.
- `refIdentity(ref)` (`store-link.mjs`): when `ref.agent` is set and is not `claude-code`, the ref is trusted and the
  path is not parsed: `kind` = `ref.kind` (default `main`), `sid` = `ref.sid` (or `ref.sessionId`), `charId` =
  `ref.charId`, `parentId` = `ref.parentId`. Claude refs keep the path rules of 3.5.

Common end hint (ADAPTERS 3.4):
- `Store.endCharacter(charId, reason = 'done', agent = null)` emits `session_end` with that reason for a character that
  is live and not yet ended, once. It is idempotent: a repeated call or an already ended character is a no-op. Without
  `agent`, an unknown or not yet announced id is a no-op too; with `agent`, see F3 and F4 below.
- A session object may put internal items `{ hint: 'end', charId }` into the arrays it returns from `apply()` and
  `idle()` (a child whose end is written in its parent's file). The Runner strips them before ingesting the events and
  forwards each one to `store.endCharacter(charId, reason, <its adapter id>)` (F3). They are not events: nothing with
  a `hint` field ever reaches the ring, `/events`, `/state` or the browser.

Store split and Runner:
- The Claude-only subagent linking (4.5, R28/R29, R36 forwarding) lives in `src/store-claude.mjs`: `observe`,
  `onResult`, `onNotification`, `subByToolUse`, the Claude part of `endAgent`, `taskDeltas`, `applyBufferedTasks`,
  `setMeta`, `setLabel`, `pendingMeta`, `pendingLabels` and their helpers. `store.mjs` keeps the common parts
  (registration, ring buffer, snapshot, announce, patch, since) and calls the Claude linking only for entries whose
  agent is `claude-code`.
- Runner `prepare()` reads subagent meta and workflow journal labels only when the adapter's deps have
  `readSubMeta` / `readJournalLabels`.
- RunnerGroup: one Runner per enabled adapter (its own deps and root) sharing one Store and one HTTP layer
  (section 6).

Review fixes (F1-F4):
- F1 Late root: a selected implemented adapter whose root is missing or unreadable at start is probed again every
  rescan period (same probe, same 2 s limit; no new check while the previous one has not answered); once the root can
  be opened its Runner joins the running group (`KNOWN_AGENTS` order), the server logs `<id>: root found, adapter on`
  (no path), and `/healthz` `agents` and `start().agents` include it from then on. Replay (D12) is unchanged.
- F2 Ref guard (D2 ids, review gaps G1-G3): `Store.attachFile` (and `rekey`) refuse a non-Claude ref unless its
  `charId`, and its `parentId` and `sid` (`ref.sid ?? ref.sessionId`) when present (not null/undefined; `''` counts as
  present), match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` and start with `<agent>-`, and, for a main ref, its `sid` equals its
  `charId` (G2: `sid` is a sub's owner and floor fallback, so a non-Claude sub never gets a `parentSessionId` or a floor
  from another agent's character). A Runner whose `deps.agent` is set stamps every ref with that id; a ref that already
  carries a different non-empty `agent` is refused before its identity is parsed (G3), on rescan and in `prepare` alike.
  A Runner without `deps.agent` keeps the ref's own `agent` (else `claude-code`). The Runner checks first and builds no
  session object for a refused ref. One log line per refused path, `<agent>: rejected ref with invalid id` or, for G3,
  `<runner agent>: rejected ref with foreign agent` (no path, no id; the prefix is never the spoofed id). Refused paths
  are remembered and never evicted, up to 1000 (G1): a remembered path is never logged or counted again; once 1000 are
  remembered a new refused path is still refused but neither logged on its own nor remembered, and the first time that
  happens the Store logs `<agent>: too many rejected refs, further ones not logged` (once per Store).
  `stats().rejectedRefs` is the number of remembered paths: it stops at 1000, so it is a lower bound of the distinct
  refused paths. Repeat scans of the same paths add no log line and no count. Claude refs are not id-checked.
- F3 Agent-scoped end hints: the Runner forwards each hint with its adapter id (`deps.agent`), and `endCharacter`
  with an `agent` only ends a character whose entry agent is that id; a mismatch is a no-op. Direct calls without an
  agent behave as before.
- F4 Pending end hints: an agent-scoped hint for a character that is not announced yet (its file is not attached yet,
  or is attached later in the same rescan) is kept in a map keyed by agent + charId (only ids that fit that agent, at
  most 1000, oldest dropped, cleared when used). When that character is announced it starts ended (with the 5 s tail
  grace of R29) and is never shown, so a child that already finished in its parent's file does not appear at server
  start; a character that was shown before gets its `session_end` with the hint's reason. Hints for already ended
  characters stay no-ops and are not kept.
- Not in P5a: `SessionCore` and `tool-summary` (added in P5b, 4.0.2), `SidecarWatcher` (moved to P5c; its first
  consumer is Grok) and any Codex, Grok or Antigravity parsing. Until those adapters land, 4.1-4.5 describe the only
  adapter.

### 4.0.2 SessionCore (공통 세션 코어)
P5b is the shared core of ADAPTERS 3.2 for the three new adapters: `src/core/tool-summary.mjs`,
`src/core/session-core.mjs` and its pure helper `src/core/session-items.mjs`. **No adapter uses it yet.**
`claude-code` is still the only registered adapter and keeps its `SessionState` (D9), so the events built from Claude
transcripts do not change. The Grok, Codex and Antigravity adapters (P5c-P5e) map their records to the normalized items
below and feed them to `SessionCore`. Reuse instead of copies: `tool-summary` builds on `src/summarize.mjs` (`cleanText`,
`truncate`, `hostOf`, `looksLikeUuid`, `ZERO_UUID`, and the newly exported `baseName`, `toolLabel`, `shellRoom`) and
`src/summarize-shell.mjs` (`programOf`, and the newly exported `lex`). `session-items` uses `firstSentence`, `firstLine`,
`sanitizeLine`, `askFields` (`session-util.mjs`) and `applyUpdatePlan`, `emptyPlan`, `planFromMarkdown` (`plan.mjs`).
`SessionCore` uses `buildSessionEvent` / `agentScopedId` (`session-identity.mjs`, which applies `projectKey` and the
worktree rules) and imports the idle constants `END_TURN_IDLE_MS` and `SUB_IDLE_MS` from `session.mjs` (which is
otherwise untouched). The newly exported helpers keep their behaviour, and the Claude modules keep theirs.

Exports: `tool-summary.mjs`: `toolSummary`, `shellProgram`, `patchFiles`, `mcpToolName`, `TOOL_KINDS`.
`session-core.mjs`: `SessionCore`, `END_TURN_IDLE_MS`, `SUB_IDLE_MS`. `session-items.mjs` (pure shaping, used by the
core): `CAPS`, `TOOL_STATUSES`, `TURN_END_REASONS`, `SYSTEM_KINDS`, `isObj`, `isFlag`, `itemTs`, `itemId`, `itemKey`,
`promptOf`, `sayText`, `thinkingFields`, `errorText`, `endFields`, `askOf`, `startFields`, `planViewOf`, `planFields`,
`systemFields`.

Tool descriptor (`tool-summary`):
- Input: a normalized, already-minimal descriptor that the adapter builds from the tool call, **never the raw tool
  input**: `{ tool, kind, path?, paths?, command?, argv?, url?, query?, mcpServer?, mcpTool?, patch?, description?,
  background? }` with `kind`: `read` | `edit` | `shell` | `web` | `search` | `plan` | `ask` | `agent` | `other` (an
  unknown kind is `other`). `command` is a shell string (an array is read as `argv`), `argv` an array. `patch` is patch
  text of which only the file names in its headers are used (`*** Update|Add|Delete File: x`, `*** Move to: x`,
  `diff --git a/x b/x`, `--- a/x` + `+++ b/x`); the body is discarded.
- Output: `{ tool, summary, room?, background? }`, the `tool_start` fields (`summary` <= 80).
- `tool` is the public tool name. MCP calls are normalized to `mcp__<server>__<tool>` (both segments to
  `[A-Za-z0-9_-]`); a server that looks like a uuid, or a uuid token inside it, is replaced by the existing ZERO_UUID
  rule (section 5, as for Claude `tool_start.tool`).
- `summary` follows the same privacy rules as `src/summarize.mjs` (3.1, section 5): files -> basename (`paths` -> the
  first + `(+N)`); shell -> program name (+ allow-listed subcommand) via `programOf`; an `argv` -> the basename of
  `argv[0]`; `bash|sh|zsh -lc "<string>"` is unwrapped to `programOf(<string>)` (at most twice); URLs -> host; `query`
  <= 60 (search: `query` <= 40 `·` basename, like Claude Grep); `description` <= 60 (it wins for shell, agent, ask and
  other); every piece goes through `cleanText`. Command arguments, file contents, full paths, full URLs and patch
  bodies never reach it.
- Shell rules: a subcommand that follows a bare option (`-n`, `--project`, no `=`) is dropped, because it may be that
  option's value (`kubectl -n prod-ns get` -> `kubectl`, `gcloud --project p run` -> `gcloud`, also `git --no-pager log`
  -> `git`). That rule lives in `programOf` (3.1), so Claude Bash and the core share one function. Stricter than Claude
  Bash (core only, for `argv`): `argv[0]` must be a program (a non-empty string without whitespace, a program-like
  basename, not a shell keyword), otherwise there is no program and the summary falls back to `description`, then the
  tool label, so an argument never takes its place; a one-element `argv` that holds a whole command line is read as a
  command string.
- `room` hint by `kind`: `read` / `search` -> `archive`, `edit` -> `dev`, `web` -> `research`, `ask` -> `desk`, `agent`
  -> `here`, `other` -> `here`. `shell` uses the program-name rule of Claude Bash (3.1): `grep`, `cat`, ... ->
  `archive`, `curl`, `wget`, `http` -> `research`, anything else -> `server`. MCP calls carry no room hint (the page
  classifies `mcp__<server>__<tool>`, ADAPTERS 6.2).

`SessionCore` (`src/core/session-core.mjs`) implements the SessionLike API that the Runner and Store use (ADAPTERS 3.2):
```js
export class SessionCore {
  constructor({ id /* charId, D2 */, agent, kind /* 'main'|'sub' */, parentId /* optional, same agent */,
    agentType /* optional */, now })
  apply(item, { replay } = {}) // one normalized item -> events[] (+ hint items)
  idle(nowMs)                  // time rules -> events[]
  setInfo(info)                // late meta: Store { parentProject, parentId, agentType } or sidecar { title, cwd, branch }
  sessionEvent()               // -> current `session` event
  snapshotEvents()             // -> session, current plan, open tool_starts
  get title(); get firstCwd(); get lastActivityMs(); get ended()
  skipped                      // count of malformed items; debugState() for tests
}
```

Normalized items (adapter -> `SessionCore`, ADAPTERS 3.2):
```js
{ k: 'meta', cwd?, branch?, title?, model?, parentId?, agentType? }
{ k: 'prompt', text }
{ k: 'tool_start', id, tool?, kind?, desc /* the tool descriptor above */, question?, options?, questions?, background?,
  items?, markdown?, source? /* the last three only on a kind 'plan' call */ }
{ k: 'tool_end', id, status?: 'ok'|'failed'|'denied'|'interrupted'|'abandoned', errorLine?, background? }
{ k: 'thinking', text /* string or null */, durationMs? }
{ k: 'say', text, final? }
{ k: 'plan', items?: [{ content /* or step */, status }], markdown?, source?: 'update_plan'|'tasks' }
{ k: 'turn_start', id? }
{ k: 'turn_end', reason }
{ k: 'system', kind: 'api_error'|'compact'|'refusal', text }
{ k: 'sub_end', childId, reason?: 'done'|'idle' }
```
Any item may carry an optional dedupe key `key` (an item whose key was seen before yields nothing, R9) and `ts` (ISO
string or epoch ms; a junk ts never reaches an event). The `desc` fields win over the item's own `tool` / `kind`, which
fill gaps. `id` is a non-empty string (<= 256) or a finite number; ids are opaque and go on the wire as `toolUseId`, so
an adapter uses the agent's call id, never text. Order rule: **a turn's `turn_start` comes before that turn's
`prompt`** (an adapter whose record carries both, such as Antigravity `USER_INPUT` or a new Grok `prompt_id`, sends
`turn_start` first). A proposal that is shown while a question waits (R34, `exit_plan_mode`) is a `plan` item with
`markdown`, sent before the ask's `tool_start`.
- `tool_end` status `abandoned` lets an adapter close one tool mid-turn that will never get a result (Antigravity
  position pairing: the next planner line, input or checkpoint arrives first). It emits the R27 shape
  (`errorKind: 'abandoned'`, `error: 'no result'`, `errorLine` ignored) and does not end the turn.
- `meta.parentId` only feeds the core's own session event. For non-Claude refs the parent is a scan-time fact on the
  FileRef (`ref.kind`, `ref.parentId` = the immediate parent, `ref.sid` = the root main used for floor inheritance),
  and the Store's `parentSessionId` wins. An adapter that learns the parent from a log line (Codex `parent_thread_id`)
  reads that line during scan (ADAPTERS 3.4).

Semantics (they mirror the Claude rules of 4.2):
- Text: every free-text field goes through `cleanText` with the section 2 caps: `prompt.text` 80, `say.text` 100,
  `thinking.text` the first sentence <= 100 or `null` (R14), `question` 160, `options` at most 4 of <= 30 each (R33,
  `questions` -> `askFields` with ` (+N)`), plan item `content` 80. The `tool_end.error` (from `errorLine`) and the
  `system.text` are the first non-empty line, reduced by `sanitizeLine` (a structured payload is cut, uuid tokens are
  masked), <= 120, with a fallback (the status; `API error`, `Conversation compacted`, `응답 거절`). For `system` this is
  stricter than Claude R31, which keeps the first line only.
- Prompts (R17-R19, section 5): a prompt whose text starts with `<` is skipped, also when invisible or control
  characters (format, control, separator, combining and default-ignorable code points such as U+200B, U+00AD, U+FEFF,
  ANSI escapes) or a fullwidth `<` come first. The first emitted prompt is the title fallback. A sub's prompt is the
  parent's task: never emitted, never a title.
- `tool_start` fields come from `tool-summary` on `desc`. `kind: 'plan'` gives no `tool_start` and no `tool_end`
  (R35); the plan it carries (`items` / `markdown`) shows only when it ends ok (see Plan). `kind: 'ask'` gives a
  `tool_start` with `question` / `options` (R33).
- Pairing (R16/R24, R9): a `tool_end` pairs with the open `tool_start` of the same `id`; unknown ids are ignored, and a
  second `tool_start` for an id that was ever opened is ignored. A missing `status` is `ok`, an unknown one `failed`;
  `ok` gives `ok: true`, the other statuses give `ok: false` with `errorKind` = the status (section 2).
- Background tools (R28): a background call ends with `tool_end` ok (no status, or `ok`); the `background` flag shows
  on its `tool_start`, never on the `tool_end`, and it never overrides an explicit `failed` / `denied` / `interrupted`.
- Turns (R30, R27): `turn_start` opens a turn. It first closes the previous turn when it is still open: its open tools
  get `tool_end` `abandoned`, then `turn_end` reason `next_turn` (a `turn_start` with the current turn id is the same
  turn and reopens it). `turn_end` closes the open tools as `abandoned` first, then emits `turn_end` with its reason (an
  unknown reason is `end_turn`; a closed turn emits nothing). A `prompt` never opens or reopens a turn. Work items
  (`thinking`, `say`, `tool_start`) reopen a closed turn only after a `turn_start` was seen (Claude: only when a
  promptId is known); work before the first `turn_start` opens no turn, so no `turn_end` is emitted for a turn that was
  never started, and a file without `turn_start` emits no turn events. A `say` with `final: true` arms the `end_turn`
  idle fallback (`END_TURN_IDLE_MS` from `src/session.mjs`), which `idle()` fires once; a later prompt or work item
  disarms it. Turn events are for mains only.
- Plan (R35, R36, D5): the source follows the shape, not the item's word for it. `markdown` goes through
  `planFromMarkdown` (<= 6 pending items) and is always `exit_plan` (a markdown plan proposal). An `items` list replaces
  the board with every item (`step` is accepted for `content`, an unknown status is `pending`) and is `tasks` when the
  item says `source: 'tasks'`, else `update_plan`, never `exit_plan`. A checklist such as Antigravity `task.md` is
  parsed by the adapter into `items` with statuses (`[ ]` pending, `[/]` in_progress, `[x]` completed) and source
  `tasks`, never sent as markdown. Every `update_plan` / `exit_plan` view is emitted, also when it equals the board
  (R34/R35); an identical `tasks` snapshot emits nothing (as `PlanBoard`). A `kind: 'plan'` call emits its view at a
  `tool_end` that resolves ok; a failed, denied, interrupted or abandoned call leaves the board as it was, and a pending
  call is not in the snapshot.
- `meta` updates title, cwd, branch, agentType and the sub's parent (an id of the same agent only, D2) through the
  existing `projectKey` / worktree rules (4.4; the floor stays on the first cwd) and re-emits the `session` event only
  when it changed. `model` is not a field.
- Session events go through the existing `buildSessionEvent` (3.4) with the core's `agent`, and keep the D2 ids
  (`<agent>-` prefix, 4.0.1 F2); the fallback title is 8 chars of the id after the prefix. The first item of a file
  emits the `session` event before any other event.
- `sub_end` returns the item `{ hint: 'end', charId: childId, reason? }` (the common end hint of 4.0.1; never an
  event); a child id of another agent or the core's own id is malformed.
- Subagents (`kind: 'sub'`) idle out like Claude (R29): `SUB_IDLE_MS` (`src/session.mjs`) with no growth and no open
  tools -> `session_end` reason `idle`; a main never idles out by itself. An ended sub comes back (re-announced, the
  `session` event first) only on accepted work: a `prompt` with string text, a `turn_start`, or a `tool_start` with a
  valid id. A malformed item is counted and skipped and never revives it.
- Growth: live items count at the server clock; replayed items at their `ts`. A replayed item without `ts` adds no
  growth (like Claude), so an old file with one untimed line still ends or closes its turn at the first `idle()` after
  attach; a replayed file without any timestamps counts from the first `idle()`; a sub with no items never idles out.
- Replay mode (`apply(item, { replay: true })`) builds the same state and returns only hint items.
- `snapshotEvents()`: the `session` event, the current plan, and the `tool_start` of every open tool (asks with
  `question` / `options`); nothing that already ended (an ended sub gives `[]`).
- It never throws on a malformed item: the item is counted in `skipped` and changes nothing.

Review fixes (P5b review, each with a regression test that failed first; the API changes for adapters are marked):
- R30 turns: work before the first `turn_start` no longer opens a phantom turn, and a `prompt` no longer reopens one
  (API: `turn_start` precedes its `prompt`).
- R31 `system.text` is the first line, `sanitizeLine`d (a multi-line error or a JSON tail no longer reaches the wire).
- D5 plan source from the shape (API: markdown is always `exit_plan`; checklists come as `items` + `source: 'tasks'`).
- R35 a `kind: 'plan'` call changes the board only at an ok `tool_end`; identical boards are deduped for `tasks` only.
- R29 replay: an untimed item adds no growth; a malformed work item no longer revives an ended sub.
- R28 `background` no longer turns an explicit failed / denied / interrupted `tool_end` into ok.
- Section 5: injected prompts behind invisible characters are skipped; shell option values and arguments behind a
  non-program `argv[0]` no longer become the summary (rules above). The option-value rule first lived only in the core;
  it now lives in `programOf` (3.1) and also covers Claude Bash/Monitor (`test/privacy-shell-options.test.mjs`).

Tests: `test/core-tool-summary.test.mjs` and `test/core-session.test.mjs` hold one unit test per rule above, named after
the rule; `test/core-session-fixes.test.mjs` holds the regression tests of the P5b review (turn order R30, system first
line R31, plan source D5, plan calls R35/R36, replay growth and revive R29, background R28, invisible-prefix prompts),
and the shell review tests are in `core-tool-summary.test.mjs` (option values, argv[0]). The conformance harness of
ADAPTERS 10 is `test/fixtures/conformance.mjs`: given an adapter descriptor and a fixture root it starts the real server
(`start()` with that adapter registered through the `adapters` test hook of section 6), collects SSE and `/state`, and
asserts the section 2 event types and per-type fields, the length caps, `session.agent` = the adapter id, `sessionId` /
`parentSessionId` that pass `publicSessionId` and carry the D2 prefix, an earlier `tool_start` for every `tool_end`, the
open tools in the snapshot, and that no privacy bait (fake home paths, fake emails, URLs with query strings, `rm -rf`
commands, shell option values, patch bodies, result bodies, multi-line system text, injected-instruction sentences
also behind invisible characters, uuid MCP server names, failed plan calls) appears anywhere in the concatenated JSON.
`test/adapter-conformance.test.mjs` runs it against a test-only `core-fixture` adapter (`test/fixtures/core-adapter.mjs`)
whose files are JSONL of normalized items read through `SessionCore`, with ids prefixed per D2 under a test agent id the
registry hook accepts. It is not registered in `src/adapters/`; each real adapter (P5c-P5e) runs the same harness.

### 4.1 Framing and dedupe
- R6 Read by byte offset, split on `\n`, buffer a trailing partial line, JSON.parse each line, skip blank or
  unparseable lines (count them, never throw). Lines can be up to ~2.7 MB.
- R7 On attach, scan the whole file once from byte 0 in replay mode to build the seen-uuid set and state. Resume
  re-appends hundreds of old records at the end of a file; without the set they would replay as new events.
- R9 Dedupe uuid-bearing records by uuid, keep the first copy. Also never open a tool twice for the same tool_use id.
- R10 In main files, records whose `sessionId` differs from the file stem are fork history: no events.
- R12 File order is authoritative; timestamps go backwards. Never sort or drop by timestamp.
- R13 One assistant API message is split across lines (one content block per line) sharing `message.id`, interleaved
  with tool_result and attachment lines. Iterate every block anyway (old builds put several blocks on one line).

### 4.2 Events
- R14 assistant `text` -> `say` (skip synthetic `No response requested.`); `thinking` -> `thinking` (empty text -> null,
  `durationMs` from the record-level `thinkingDurationMs`); `tool_use` -> `tool_start` using `message.content[].input`
  (never `wireToolInputs`) unless `summarize().ignore`.
- R16/R24 Pair `tool_result.tool_use_id` with the pending tool_use id. Results arrive out of order and before later
  tool_use lines of the same message. Unknown ids are ignored.
- R25 tool_end status: `interrupted` when the next record is the `[Request interrupted by user for tool use]` marker
  (emit the tool_end when the marker arrives; hold a user-rejected result for one record to decide). `denied` when
  `toolDenialKind` exists (`permission-rule`, `user-rejected`, `automode-blocked`) or the text starts with
  `The user doesn't want to proceed`, `Permission to use`, `Permission for this action was denied`, `PreToolUse:`,
  `<tool_use_error>Blocked:`. Else `isError === true` -> `failed` (strip a leading `<tool_use_error>` and the closing tag).
  Else ok. `error` text = first non-empty line, reduced to its category, then scrubbed (section 5) and truncated to
  120: `Permission to use X with command ...` -> `Permission to use X has been denied.`; `Permission for this
  action|command was denied by <who>. Reason: ...` -> `... denied by <who>.`; a structured payload (`{"`, `["`, `[{`,
  `[[`, Python `{'k':` / `['a',`, unquoted `{key:`, or a line ending in `{` / `[` at its start or after `:`) is cut
  with the separator before it (a payload at offset 0 gives the fallback `failed` / `denied`); a quoted brace such as
  `Unexpected token '{'` is not a payload; uuid-looking tokens become the zero uuid.
- R27 A pending tool is `abandoned` when an assistant line with a different `msgId` than the tool's own message appears
  in the same file while the tool still has no result (in 219,911 paired calls a result never arrived after a new
  msgId), on an interrupt marker without a result, or when a new turn starts. Otherwise it is still running, however long.
- R28 Async launches: Agent/Workflow `toolUseResult.status === 'async_launched'` -> tool_end ok; the subagent lives on.
  A `notification` whose `toolUseId` or `taskId` matches ends it (`session_end` reason `done` for that subagent).
- R29 Subagent end (`session_end` reason `done` unless noted), the first of:
  - its parent's sync Agent tool_result: `toolUseResult.status === 'completed'` (or the `agentId: a…` trailer of a
    nested sub's result), or any `is_error` result for that Agent call (interrupted, denied, failed: the parent stopped
    waiting). The sub is found by `toolUseResult.agentId`, the trailer, or `meta.toolUseId`. An errored result read
    before the sub is known (restart replay, `meta.json` written late) is remembered and ends the sub when it attaches
    or its meta arrives, unless a SendMessage resumed that agent since. Each result ends a sub once (replays are no-ops);
    an async launch never ends it;
  - a task notification for it (R28) or, for a workflow agent, for its run;
  - a tool_result with `endTurn` (StructuredOutput / SubagentHandback) in its own file;
  - a final assistant text (stop reason `end_turn` / `stop_sequence` / `refusal`, no tool_use in that API message, no
    open tools) followed by 15 s of no growth;
  - `idle`: 120 s of no growth with no pending tools, or 600 s while the current API message is still streaming (last
    line with stop reason null and no tool_use). Growth stamped ahead of the server clock counts from now.
  A sub that ended works again when its file gets new work (prompt, turn_start, notification, tool_use): it is
  re-announced and is back in `snapshot()` / `/state`, also when its workflow run is done. Events read within 5 s of a
  Store-side end (the first three cases) are dropped as late tail lines, except after an explicit SendMessage resume.
- R30 Turns (main files): a new `promptId` on a `prompt` / `notification` / `turn_start` record starts a turn (emit
  `turn_end` reason `next_turn` for the previous one if it never ended). `turn_end` fires on the first of:
  `stop_hook_summary` (`stop_hook`), synthetic `apiError` assistant (`api_error`), interrupt marker (`interrupt`),
  tool_result with `endTurn` from `mcp__ccd_turn__wrap_up` (`wrap_up`), or an assistant line with
  `stopReason === 'end_turn'` followed by 20 s of no growth (`end_turn`, via `idle()`). Never require
  stop_hook_summary (hook-free setups may not write it). Reused promptId = same turn: a prompt or notification with
  the current promptId reopens a closed turn, and so does any non-synthetic assistant line while the turn is closed and
  a promptId is known (compact-summary-first files, work after a reused-promptId `turn_start`). A reopened turn gets
  its `turn_end` by the same rules.
- R31 system `api_error` -> `system` kind `api_error`, text `API 재시도 <attempt>/<max> (<status>)`. Synthetic
  `apiError` assistant -> `system` kind `api_error` with the first line of its text, then `turn_end`.
- R32 `compact_boundary` -> `system` kind `compact`. A following compact summary record does not start a turn.
- R33 AskUserQuestion: `tool_start` with `question` = first question text (<= 160) plus ` (+N)` when more,
  `options` = first question's option labels (<= 4, each <= 30). Ended by its tool_result (answered -> ok,
  rejected -> denied).
- R34 ExitPlanMode: `tool_start` with `question` = `이 계획대로 진행할까요?`, `options` = `['승인', '수정 요청']`, and a
  `plan` event with `source: 'exit_plan'` from `planFromMarkdown(input.plan)`, emitted before the `tool_start` (live
  and in `snapshotEvents()`), so the board fills while the question waits. Approved = object `toolUseResult`.
- R35 update_plan: every successful call -> `plan` event (`source: 'update_plan'`) with the full replayed list, after
  reconciling with the result text. The tool itself is plumbing (no tool_start).
- R36 Tasks: `task_reminder` snapshot, then TaskCreate/TaskUpdate deltas -> `plan` event (`source: 'tasks'`) only when
  the session has no update_plan items (update_plan wins on the whiteboard). When an update_plan call leaves no
  items, the task list is shown again right after that (empty) update_plan event. TaskCreate/TaskUpdate inside
  subagent files change the same session's main task list (the Store forwards them, buffered until the main attaches).
- `prompt` events: emit for human prompts, text truncated to 80, skip text that starts with `<` (tags).

### 4.3 Titles and identity
- Main title, first that exists: latest `custom-title`, latest `agent-name`, `<sid>/custom-title.json`, legacy
  `summary`, first human prompt (<= 40), latest `last-prompt` (<= 40), first 8 chars of the stem.
- Subagent title: meta `name`, meta `description`, workflow journal label, meta `workflowPhase`, meta `agentType`, agentId.
- Branch = latest `gitBranch` (`HEAD` -> `detached`). Branch, worktree name and agentType are labels: section 5
  scrub, capped at 60, null when empty. `parentSessionId` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, else the main
  session id is used.

### 4.4 Projects (floors)
- `projectKey(cwd, worktreeState)`: `worktreeState.originalCwd` if present; else if
  `/^(.*?)\/(\.claude\/worktrees|\.worktrees)\/([^/]+)(?:\/|$)/` matches, group 1; else cwd; strip trailing `/`.
  Use the session's FIRST cwd (cwd changes mid-session). Never decode the project dir name (lossy, collisions).
- `project` = projectKey, `projectLabel` = its basename. `worktree` = worktree name when the latest cwd is inside a
  worktree (or `worktree-state` is non-null), else null.
- Subagents inherit the parent's project (subagent cwd can be a worktree of the same repo).

### 4.5 Subagent linking
- Plain sub: `meta.toolUseId` is the Agent tool_use id in the main file (depth 1) or in a sibling
  `agent-<parentAgentId>.jsonl`; if `parentAgentId` is missing, search sibling agent files. `parentSessionId` =
  owner of that tool_use (main stem or parent agentId). Meta may appear > 1 s after the jsonl: retry on later scans
  and fall back to the main session as parent.
- Wf agent: parent = the main session of the enclosing `<sid>`; label from `journal.jsonl` `started` (`label`/`phase`).
- Every record in a sub/wf file has `isSidechain: true`, `agentId` = file id, `sessionId` = parent session.

## 5. Privacy and rooms
- Never put these into any event: Bash/Monitor `command`, terminal `command`/`cwd`, Write `content`, Edit
  `old_string`/`new_string`, Agent `prompt`, Workflow `script`/`args`, SendMessage `message`/`content`, ExitPlanMode raw
  `plan` (only `planFromMarkdown` headings), StructuredOutput fields, SubagentHandback `message`, WebFetch `prompt`,
  `*javascript_tool.text`, browser typed text, form values, firestore documents/filters, emails, PR urls,
  `__unparsedToolInput.raw`, tool_result content (except the short `error` first line), full file paths (basename only),
  full URLs (host only).
- One scrub (`cleanText` in `summarize.mjs`) runs on every free-text field before it is truncated: `prompt.text`,
  `say.text`, `thinking.text`, `session.title`, `tool_start.summary` pieces, `question`, `options`, plan item
  `content` (ExitPlanMode items after the markdown links, HTML and backticks are stripped), `tool_end.error`,
  `system.text`, and the labels `branch`, `worktree`, `agentType`. In order:
  1. `mcp__<server>` whose server segment looks like a uuid (`looksLikeUuid`) -> `mcp__<ZERO_UUID>`.
  2. `file://[localhost]/path` -> the path (then rule 7).
  3. URLs with a scheme -> host (`hostOf`, `(url)` when unparsable), trailing sentence punctuation kept.
  4. scp form `user@host:path` -> host.
  5. scheme-less URLs: a dotted host (last label 2+ letters), `localhost`, IPv4 or `[IPv6]`, optional `:port`, then
     `/`, `?` or `#` -> host. Never inside a path or a word. With `user@` in front it is an email (rule 6).
  6. emails (also `me@corp.example/x`) -> `(email)`; the domain is not kept.
  7. absolute paths -> basename: `/`, `//`, `///`, `~/`, `./`, `../`, `$VAR/`, `${VAR}/`, `C:\`, `C:/`, `\\server\`.
     A path may start after any whitespace, punctuation, symbol or control character, or at the line start; glued to
     an ASCII word or path character it is not a path (`src/x`, `TCP/IP`, `and/or`); glued to a non-ASCII letter it
     needs a second separator (`설정/.claude/` is a path, `예/아니오` is not). It continues across a space when the
     next word runs straight into another separator (`Application Support/x`), across `\ ` and balanced `(...)`, never
     across a newline, and ends at whitespace or `" ' \` < > ) ] } , ; * |` and control characters. A path cut by a
     glued `* < > |` keeps no directory name (`/a/CLIENT/*.pdf` -> `*.pdf`, `**/foo/*.mjs` -> `**/*.mjs`).
  ANSI colour codes count as a boundary for these rules and are removed with the other control characters.
- `tool_start.tool` is the raw tool name except that an mcp server segment that looks like a uuid (strict, one-char
  typos, 24+ hex, bare `mcp__<uuid>` too) becomes `ZERO_UUID`; human server names are never masked.
- `session.project` is the one field that carries a full path: it is the floor key (4.4), the first cwd. The browser
  uses it as a map key and shows `projectLabel` (or the basename of the key).
- The browser classifies rooms with `public/js/rooms.js`; the server only sends `room` hints from 3.1.

## 6. Server behaviour (`src/server.mjs`, `bin/office-sim.mjs`)
- CLI flags: `--port 4317 --host 127.0.0.1 --interval 250 --active 30 --rescan 3000 --claude-root ~/.claude/projects`,
  and `--auth` (a switch without a value; `--auth=x` is an error). Replay (6.1): `--replay <file> --speed <x> --loop`;
  `--speed` (0.1..1000, default 1) and `--loop` (switch) are errors without `--replay`. `--interval` is the tail poll in ms (50..5000),
  `--active` the minutes of mtime window for attaching files, `--host` must be a loopback address.
  `--claude-root <dir>` is the Claude Code transcripts root (default `~/.claude/projects`); `--root <dir>` is an alias
  that sets the same option. Both set the `start()` option `root`.
- Adapters (P5a, 4.0.1): `--agents <id,id>` is a comma list of adapter ids, each validated against `KNOWN_AGENTS`
  (an unknown id is a usage error, exit 2). It narrows the enabled set (D3); without it every implemented adapter
  whose root exists is on. `--codex-root <dir>`, `--grok-root <dir>` and `--antigravity-root <dir>` are accepted,
  `~`-expanded and stored in the `start()` option `roots`; they are reserved for the upcoming adapters and unused in
  P5a. After the URL line the bin prints `office-sim: agents <ids>` (the enabled ids, comma-separated) or
  `office-sim: agents none`, then one line `office-sim: <id> is not implemented yet` for each requested id that is
  known but not implemented.
- RunnerGroup: one Runner per enabled adapter, all sharing one Store and one HTTP layer. It forwards `startLoops`,
  `rescan`, `setInterval` (so `POST /config` reaches every Runner) and `close`, and sums `files.size`, `badLines`,
  `skippedLines` and `applyErrors` over its Runners. A missing or unreadable adapter root disables that adapter with
  one log line without the path (`<id>: root not found, adapter off` or `<id>: root not readable (<code>), adapter
  off`); the server still starts and serves an empty office. The root check runs before the server listens and gives
  up after 2 s (`ETIMEDOUT`), so a stalled root never keeps the server from starting. A disabled adapter that was
  selected is checked again every rescan period and switched on when its root can be opened (4.0.1 F1), with one log
  line `<id>: root found, adapter on`; the bin's `office-sim: agents` line shows the set at start only.
- Loops: every `interval` ms stat each attached file and read appended bytes; every `rescan` ms run `scan()` to attach
  new files and detach files outside the active window (emit `session_end` reason `idle` for them); every 1 s call
  `idle()` on each session. Loops never overlap (skip a tick while the previous one runs). The poll loop is a
  `setTimeout` chain: the next poll runs one interval after the last one ended. An interval change only ever brings
  the pending poll earlier (last poll + new interval when that is sooner); a longer interval applies after the pending
  poll, and an unchanged value is a no-op, so repeated `POST /config` never starves polling.
- Active window: a file is inside it when its mtime is within `--active` minutes. A main transcript also stays inside
  while any sub/wf file of the same session is inside (a main that only waits for its subagents writes nothing), so
  it is not detached while its subagents are live.
- A file that fails to poll is retried with backoff (`interval * 2^n`, at most 30 s) and logged once per error code,
  with one `poll recovered` line; an attach that fails is rolled back (retried at the next rescan) and logged once per
  path and error code. A failing `scan()` skips that rescan tick (nothing is detached) and is logged as
  `scan failed: <code>` once per error code, with one `scan recovered` line. One file failing never skips the other
  files of the same rescan. Attach and poll log lines carry the error code and the file basename, scan lines the error
  code only (no root path); HTTP error log lines carry the request path without its query (no token).
- Relocation: when a session's file moves to a new path with the same inode, its tail offset and partial line move
  with it (no replay, no re-announce, lines written during the move stream live). A copy (new inode) is attached again
  from scratch; a subagent that ended while it moved still gets its `session_end`.
- Attach = `Tailer.readAll` in replay mode, then emit `session` + `snapshotEvents()` live so open pages see the
  newcomer. Process attaches one at a time and yield, so a 60 MB file never blocks polling for long.
- HTTP: `GET /` serves `public/office.html` wrapped in `<!doctype html><html lang="ko"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light}
  body{margin:0}[hidden]{display:none!important}</style></head><body>` ... `</body></html>`. `GET /js/<name>.js` serves
  `public/js` (reject `..`, only `[a-z0-9_-]+\.js`, `text/javascript; charset=utf-8`). `GET /events` SSE: headers
  `text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`; write `retry: 2000`; if `Last-Event-ID`
  is in the ring send the missed events, else a `snapshot`; then live events with `id:` = seq; `: ping` every 15 s.
  `GET /state` -> snapshot JSON. `GET /config` / `POST /config {intervalMs}` (rules below, broadcast `config`).
  `GET /healthz` -> `{ ok, files, sessions, clients, agents }` (`agents`: the enabled adapter ids, `files`: summed
  over the Runners). No CORS headers. Order of checks for every request:
  1. Host guard: the `Host` header must be `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`, and an `Origin`
     header, when present, must be `http://` + one of those; else 403 (DNS rebinding and cross-origin guard).
  2. Path guard: `..` or encoded `.` / `/` / `\` in the raw path -> 400.
  3. `--auth` (when on): `GET /?t=<token>` with the right token -> 302 to `/` with
     `Set-Cookie: osim_<port>=<token>; HttpOnly; SameSite=Strict; Path=/` and `cache-control: no-store`. Every other
     request, every route (`/`, `/index.html`, `/js/*`, `/events`, `/state`, `/config`, `/healthz`, 404s), needs that
     cookie, else 401 `unauthorized: open the URL printed by office-sim`. The token is 32 random bytes (base64url)
     made in-process per run (never argv or env), compared in constant time; the cookie name carries the port.
  4. `/events`, `/state`, `/config`: a `Sec-Fetch-Site` header other than `same-origin` or `none` -> 403 (absent passes,
     for local tools).
  5. `POST /config`: `Origin`, when present, must equal `http://` + the request's own `Host` (403 `{error:'cross-origin
     request'}`); `Content-Type` must be `application/json` (415); the body is at most 4096 bytes (a larger
     `Content-Length` or body -> 413 `{error:'body too large'}`, the rest is drained up to 1 MiB so the client gets the
     413, beyond that the socket is closed); invalid JSON -> 400; `intervalMs` must be an integer 50..5000 (400).
- Response headers: every response (pages, data, errors, SSE) carries `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`. `GET /` and `/index.html` also send
  `x-frame-options: DENY` and `Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net
  'sha256-…' (one hash per inline <script> of the served page, recomputed when office.html changes); style-src 'self'
  'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
- `start(options)` returns `{ url, token, port, store, ready, close(), stats(), agents, notImplemented }` so tests can
  run it on port 0 against a temp root (`agents`: the enabled adapter ids, read live so a late root (4.0.1 F1) shows
  up; `stats()` adds the Store's `rejectedRefs` to the Runner counters; `notImplemented`: requested ids that are
  known but not implemented, `KNOWN_AGENTS` order). Replay options: `replay` (path), `speed`, `loop`, and the test
  hook `replayTiming` (`{ maxGapMs, holdMs, restartMs, statusMs }`). Adapter test hooks: `deps` (claude-code deps
  override), `adapters` (registry override), `probe` (replaces the root check) and `probeTimeoutMs`. With `auth: true`, `url` is `http://<host>:<port>/?t=<token>` (what the bin prints) and `token` is set;
  without it `token` is null and `url` has no query.

### 6.1 Replay mode (`--replay <file> --speed <x> [--loop]`, P3)
- Input: one main transcript (`<uuid>.jsonl`) plus its `<uuid>/subagents/**` files (`sessionRefs`).
  `--claude-root` (`--root`), `--active` and `--rescan` do not apply. A main file renamed away from its uuid uses the
  first record's `sessionId` as its stem, so R10 does not treat every line as fork history.
  Replay is Claude-only (D12, 4.0.1).
- Pipeline: `ReplayRunner` extends the live `Runner` and keeps `prepare` / `publish` / `onLine` / `detach`, so
  SessionState, Store, the SSE wire format, privacy (section 5) and the page are exactly the live ones. Only the line
  source differs: instead of tailing, every poll tick (`--interval`, default 250 ms) releases the lines that are due.
- Timeline: each file's lines keep file order (R12); a line's time is the latest timestamp seen so far in its file
  (untimed leading sidecars take the first one), so time never runs backwards. Files are merged by that time, the
  main file first on ties. A line is due `sum(min(gap_i / speed, maxGapMs))` after the start: gaps are divided by
  `--speed` and every gap is capped at 5 s of real time (a one-hour break plays as 5 s). Lines over 8 MB are skipped
  and counted like the tailer.
- A file attaches (and its character is announced) when its first line is due, so a subagent appears when it really
  started, after its parent's Agent call has been indexed. The first `session` event of a fresh main has no project
  yet; the next one (first record with a `cwd`) has it.
- Clock: record times only decide when lines are released. Time rules (R25 hold, R27, R29 idle ends, R30 end_turn)
  keep running on the real clock as in live mode, so at 4x they last 4x longer in recorded time. Gaps longer than 5 s
  are cut, so idle-based ends that would have fired inside a long recorded break may fire later or not at all; the
  records that close turns and subagents (stop hook, parent results, notifications) still do.
- End: without `--loop` the last state stays on screen (`state: done`), the server keeps serving. With `--loop`
  the final state is held 3 s, every character is detached with `session_end` reason `done` (the Store index for the
  session is dropped, so R9 uuid dedupe and the done keys start fresh), and 2 s later round N+1 starts.
- The bin prints the URL, the agents lines of section 6 (always `agents claude-code` in replay, D12, then one
  `<id> is not implemented yet` line per requested unimplemented id), then `replay <speed>x[, loop]`; replay log lines
  carry error codes and basenames.

## 7. Permission-approval wait (P3 finding)

Question: can the page show "waiting for the user's permission" while a tool call waits for an approval prompt?
Answer for live mode: **no certain signal exists, so live mode shows nothing.** Evidence, from a structure-only count
over the local corpus (5,107 files, 929,610 lines, 225,155 paired tool_use/tool_result; counts in
`docs/research/permission-decision.json`):

- Nothing is written while a prompt is open. `permissionDecision {decision, source, reasonType}` exists only on the
  tool_result record (32,065 results), i.e. after the decision and after the tool ran. Between a tool_use and a
  result that a human decided, the only records are other assistant lines, sidecars (`custom-title`, `agent-name`,
  `last-prompt`, `pr-link`, `queue-operation`, ...) and 2 PreToolUse hook attachments, which also appear before
  calls that never prompted. There is no `permission_request` record and no PermissionRequest / Notification hook
  attachment in the corpus.
- `source` does not mean a click either: `user_permanent` (316, reasonType `rule`) is an allow-rule the user saved
  earlier; its Read calls finish in p50 0.3 s. Only `user_temporary` (94) is a click in that moment, and 89 of those
  are AskUserQuestion / ExitPlanMode, which already go to the desk (R33/R34). Ordinary tools: 5 (mcp).
- A time threshold would be a guess: auto-approved calls already run long (`config` Bash p99 68.6 s, WebFetch p50
  7.3 s, mcp p99 61 s) while the human-approved mcp calls took p50 38 s; the ranges overlap.
- The corpus is mostly `permissionMode: auto` (4,957 of 5,182 user records), so prompts are rare here; in `default`
  mode they would be common and still invisible in the transcript.

What would make live mode possible: a record written when the prompt opens, e.g. a user-configured
`PermissionRequest` / `Notification` hook that appends to a side file the server could tail.

Replay mode can show it without guessing, because the result line is already on disk: a tool_start gets
`awaitsApproval: true` when its result has `permissionDecision.source === 'user_temporary'` or is a user rejection
(`toolDenialKind: 'user-rejected'`, or text starting `The user doesn't want to proceed`), and the tool is not
AskUserQuestion / ExitPlanMode. `user_permanent`, `config` and `hook` decisions never set it. The page sends that
character to 내 자리 with a `승인 대기 · <tool> <summary>` bubble (`허용` / `거절` chips) until the tool_end, then shows
`승인됨`, `거절됨` (denied / interrupted) or the failure. The wait shown covers the prompt and the run of the tool,
because the transcript does not record when the click happened.

