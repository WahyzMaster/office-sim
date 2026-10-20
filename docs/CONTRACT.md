# office-sim server contract (P1-P3, P5a-P5e)

The server tails Claude Code session transcripts under `~/.claude/projects`, turns records into UI events,
and streams them to the 3D office page (`public/`) over SSE. This file is the single source of truth for
module boundaries, the event schema and the parsing rules. The format rules come from a corpus study of
5,016 local transcript files (Claude Code 2.1.181 to 2.1.299, entrypoint `claude-desktop`).
Since P5e all four adapters are implemented: Claude Code (4.1-4.5), Grok (xAI Grok Build, 4.6), Codex (OpenAI Codex,
all clients, 4.7) and Antigravity (the CLI `agy` and the legacy IDE, 4.8; the desktop app is out of scope, D6). The
approved multi-agent design is `docs/ADAPTERS.md`; its shared groundwork (P5a) is in 4.0.1, the shared session core for
the new adapters (P5b) in 4.0.2, the Grok adapter (P5c) in 4.6, the Codex adapter (P5d) in 4.7 and the Antigravity
adapter (P5e) in 4.8.

## 0. Ground rules

- Node 20 (`node -v` = 20.20), ESM (`.mjs`), **zero npm dependencies**. Tests use `node:test` + `node:assert/strict`.
  Run all tests with `node --test test/`.
- Every source file stays under 500 lines. No `console.log` in `src/` (use the injected `log` callback); `bin/` may print.
- Comments may be Korean or English; identifiers are English.
- **Never read from or write to the real `~/.claude` in tests.** Tests build synthetic fixtures in a temp dir
  (`fs.mkdtemp(os.tmpdir() + '/office-sim-')`). Fixture text must be invented, never copied from real transcripts.
  The same holds for the other adapter roots `~/.grok`, `~/.codex` and `~/.gemini`: tests pass temp roots only.
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
src/tailer.mjs          per-file byte-offset tail with partial-line buffer; opt-in `noFollow` attach (Antigravity, 4.8)
src/store.mjs           registry of sessions and projects, entry agent, event ring buffer, snapshot, announce, patch,
                        since, endCharacter (4.0.1); calls store-claude.mjs only for entries whose agent is claude-code
src/store-claude.mjs    Claude subagent linking (4.5, R28/R29, R36 forwarding), split out of store.mjs in P5a:
                        observe, onResult, onNotification, subByToolUse, the Claude part of endAgent, task deltas,
                        buffered sub meta and journal labels
src/store-link.mjs      Store helpers: file identity, link facts, per-session index, ring lookup, the open tool ids
                        of a moved character (section 6 relocation) (pure)
src/adapters/index.mjs  adapter registry: KNOWN_AGENTS, AGENT_LABELS, ADAPTERS, enabled-adapter selection (4.0.1)
src/adapters/claude-code.mjs the claude-code descriptor; points at the Claude modules where they are (D8)
src/adapters/grok/      the Grok adapter (P5c, 4.6), every file under 500 lines: `discover.mjs` (allowlist discovery,
                        subagent linkage), `records.mjs` (one record -> item pieces, pure), `session.mjs`
                        (`GrokSession`: turn and tool state around SessionCore, the SessionLike API), and the
                        descriptor `index.mjs` (id `grok`, default root `~/.grok`, `sidecars(ref)`, `worktreeFloor`)
src/adapters/codex/     the Codex adapter (P5d, 4.7), every file under 500 lines: `discover.mjs` (allowlist discovery,
                        date-folder walk, continuation pieces, guardian hiding, parent chain), `line0.mjs` (line-0
                        facts and their cache), `titles.mjs` (`CodexTitles`, the incremental `session_index.jsonl`
                        reader), `records.mjs` (one record -> item pieces, pure), `exec.mjs` (code-mode `exec`, pure),
                        `session.mjs` (`CodexSession`: turn, tool and inherited-context state around SessionCore) and
                        the descriptor `index.mjs` (id `codex`, default root `~/.codex`, `worktreeFloor`)
src/adapters/antigravity/ the Antigravity adapter (P5e, 4.8), every file under 500 lines: `discover.mjs` (allowlist
                        discovery in the two app folders, transcript file preference by line count), `meta.mjs`
                        (`AntigravityMeta`, the metadata watcher, and the summary / annotation / `task.md` parsers),
                        `proto.mjs` (a bounded, never-throwing protobuf wire-format reader), `records.mjs` (one step ->
                        item pieces, pure), `tools.mjs` (tool name table -> descriptors, pure), `session.mjs`
                        (`AntigravitySession`: line positions, position pairing and the cwd fallback around
                        SessionCore) and the descriptor `index.mjs` (id `antigravity`, default root `~/.gemini`,
                        a `noFollow` Tailer)
src/core/tool-summary.mjs normalized tool descriptor -> { tool, summary, room?, background? } (pure, 4.0.2)
src/core/session-core.mjs SessionCore: normalized items -> UI events, the SessionLike API for the new adapters;
                        used by the Grok, Codex and Antigravity adapters (4.0.2, 4.6, 4.7, 4.8)
src/core/session-items.mjs pure shaping of normalized items into event fields for SessionCore (caps, scrub, plan view)
src/core/sidecar.mjs    SidecarWatcher (P5c, ADAPTERS 3.3): at each rescan stats the small metadata files an adapter
                        declares (`sidecars(ref)`), re-reads one only when its mtime / size / inode changed (<= 1 MB,
                        parse errors ignored) and passes the result to the session's setInfo (4.6). The Codex title
                        index is not read by it (an incremental reader of its own, 4.7); the Antigravity metadata
                        watcher is built on two of them (4.8)
src/server.mjs          start(): wires Store, RunnerGroup (one Runner per enabled adapter, defined here) and the
                        HTTP layer
src/server-runner.mjs   Runner: poll / rescan / idle loops, attach, relocation, backoff; runs the SidecarWatcher at
                        rescan only for an adapter that has the `sidecars(ref)` hook (Grok; Claude has none), or in its
                        place an adapter's own watcher `deps.sidecarWatcher` (`check(ref)` / `forget(path)`: the Codex
                        titles, 4.7, and the Antigravity metadata, 4.8); passes a ref's scan-time `facts` to the session
                        constructor (Codex, Antigravity)
src/server-http.mjs     http: /, /js/*, /events (SSE), /state, /config, /healthz
src/server-guard.mjs    page CSP, Sec-Fetch-Site check, --auth token and cookie
src/replay.mjs          ReplayRunner (extends Runner): --replay playback of one session (section 6.1)
src/replay-timeline.mjs replay timeline: line times, cross-file merge, speed + gap cap, approval look-ahead (pure)
test/*.test.mjs         unit + integration tests, synthetic fixtures under test/fixtures/ or generated
test/fixtures/conformance.mjs adapter conformance harness (ADAPTERS 10, 4.0.2), run by test/adapter-conformance.test.mjs
                        against the test-only core-fixture adapter (test/fixtures/core-adapter.mjs); the Grok,
                        Codex and Antigravity adapters run it too (4.6, 4.7, 4.8)
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
subagents alike) carries an agent id. It is on every `session` event, live and in snapshots. Ids: `claude-code`,
`grok`, `codex` and `antigravity`, all implemented (`grok` since P5c, 4.6, `codex` since P5d, 4.7, `antigravity` since
P5e, 4.8). The page shows the labels `Claude Code`, `Codex`, `Grok`, `Antigravity`, and an unknown id as-is. The id flows
from the file's `FileRef.agent` through its session object (`SessionState`, or the Grok, Codex or Antigravity session
around `SessionCore`) and its Store entry (4.0.1).

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
  constructor({ maxLineBytes = 8 * 1024 * 1024, chunkBytes = 4 * 1024 * 1024, noFollow = false })
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
`noFollow` (off by default; the Antigravity descriptor's `deps().Tailer` turns it on, 4.8): `readAll` opens the path
with `O_NOFOLLOW` and attaches it only when the opened file is a regular file whose inode is the ref's `ino` (when the
ref has one); a link (`ELOOP` / `EMLINK`), another kind of file or another inode at the path returns `{ gone: true }`
without a line, and the next rescan decides again. `poll` is unchanged: it only reads the inode `readAll` attached.

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
- Everything in 4.1-4.5 (R6-R36), together with the file layout in 3.5 and the record kinds in 3.3, is the Claude Code
  adapter: how Claude Code transcripts are found and read. Its `session` events carry `agent: 'claude-code'`.
- Every other adapter (Grok since P5c, 4.6; Codex since P5d, 4.7; Antigravity since P5e, 4.8) brings its own log discovery
  and record mapping, but must emit the same event schema (section 2) with its own `agent` id, and must send every
  free-text field through the shared `cleanText` scrub and the privacy rules of section 5. The Store, the SSE wire
  format and the page stay shared.

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
- `ADAPTERS = { 'claude-code': claudeCode, codex, grok, antigravity }`: the implemented adapters (P5a registered
  `claude-code` only; P5c added `grok`, 4.6; P5d added `codex`, 4.7; P5e added `antigravity`, 4.8). Since P5e every id
  in `KNOWN_AGENTS` is implemented.
- Selection (D3): an implemented adapter whose root exists is enabled. A requested list (`--agents`) narrows the set.
  A requested id that is in `KNOWN_AGENTS` but not implemented is reported as `not implemented yet` and skipped; an id
  outside `KNOWN_AGENTS` is an error. (Since P5e no known id is unimplemented, so the `not implemented yet` list is
  empty in practice; the rule stays for a future id.) Every list (enabled, off, not implemented) follows `KNOWN_AGENTS` order without
  duplicates, in live and replay mode alike. A root check that has not answered within 2 s (`PROBE_TIMEOUT_MS`, a
  stalled network or FUSE mount) counts as unreadable with code `ETIMEDOUT`. Since P5c an implemented adapter other
  than `claude-code` whose root is not given in `roots` is skipped: not probed, not enabled, not reported. Default
  roots are the caller's choice: `defaultRoots()` (`src/adapters/index.mjs`) returns every non-Claude descriptor's
  `defaultRoot` (`~` not expanded), and the bin passes it under the `--<id>-root` values (section 6).
- Descriptor (`src/adapters/claude-code.mjs`): `id: 'claude-code'`, `defaultRoot: '~/.claude/projects'`, `deps()`
  returning the bundle the server injected before P5a (`SessionState`, `Tailer`, `scan`, `readSubMeta`,
  `readJournalLabels`), and replay support (6.1, D12). It points at the existing modules in place (D8). The Grok
  descriptor (`src/adapters/grok/index.mjs`, P5c) has its own `deps()` and the optional `sidecars(ref)` hook, and no
  replay support (4.6). The Codex descriptor (`src/adapters/codex/index.mjs`, P5d) has its own `deps()` (with the
  `sidecarWatcher` title reader, no `sidecars(ref)` hook) and `worktreeFloor`, and no replay support (4.7). The
  Antigravity descriptor (`src/adapters/antigravity/index.mjs`, P5e) has its own `deps()` (with the `sidecarWatcher`
  metadata reader, no `sidecars(ref)` hook), no `worktreeFloor`, and no replay support (4.8).

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
  consumer is Grok, 4.6) and any Codex, Grok or Antigravity parsing (Grok: P5c, 4.6; Codex: P5d, 4.7; Antigravity: P5e,
  4.8).

### 4.0.2 SessionCore (공통 세션 코어)
P5b is the shared core of ADAPTERS 3.2 for the three new adapters: `src/core/tool-summary.mjs`,
`src/core/session-core.mjs` and its pure helper `src/core/session-items.mjs`. When P5b landed no adapter used it; since
P5c the Grok adapter does (4.6), since P5d the Codex adapter (4.7), and since P5e the Antigravity adapter (4.8). `claude-code` keeps its `SessionState` (D9),
so the events built from Claude transcripts do not change. The Grok, Codex and Antigravity adapters (P5c-P5e) map
their records to the normalized items below and feed them to `SessionCore`. Reuse instead of copies: `tool-summary`
builds on `src/summarize.mjs` (`cleanText`, `truncate`, `hostOf`, `looksLikeUuid`, `ZERO_UUID`, and the newly exported
`baseName`, `toolLabel`, `shellRoom`) and
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
  setInfo(info)                // late meta: Store { parentProject, parentId, agentType } or sidecar { title, cwd, branch,
                               //   subagent? }
  sessionEvent()               // -> current `session` event
  snapshotEvents()             // -> session, current plan, open tool_starts
  get title(); get firstCwd(); get lastActivityMs(); get ended()
  skipped                      // count of malformed items; debugState() for tests
}
```

Normalized items (adapter -> `SessionCore`, ADAPTERS 3.2):
```js
{ k: 'meta', cwd?, branch?, title?, model?, parentId?, agentType?, subagent? }
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
`markdown`, sent before the ask's `tool_start` (Grok usually writes the plan text only when the question is answered;
then its plan follows the ask, 4.6).
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
  parent's task: never emitted, never a title. A main that learns from `meta` / `setInfo` that it runs a parent's task
  (`subagent: true`, e.g. a Grok child attached as a main before its parent named it, 4.6) is treated the same from
  then on: no `prompt` is emitted, and the title fallback it already took is dropped (a corrected `session` event
  follows when the title changes).
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

### 4.6 Grok adapter (P5c)
The Grok adapter reads xAI Grok Build (`grok`) session transcripts. Format facts come from the structure-only study
`docs/research/grok-format.json` (105 transcripts, 127,645 lines, Grok Build 1.0.46-1.0.62, TUI sessions only); the
design is ADAPTERS 5.2, 6.1 and 6.2, and where this section differs from those proposals, this section wins. Agent id
`grok`, default root `~/.grok` (`--grok-root`, section 6). Code: `src/adapters/grok/` (the descriptor is
`src/adapters/grok/index.mjs`, registered in `src/adapters/index.mjs`) and `src/core/sidecar.mjs`. A Grok session is
`SessionCore` (4.0.2) behind a normalizer that maps each record to normalized items, so every cap, scrub, pairing, turn
and plan rule of 4.0.2 applies. Claude behaviour does not change (4.1-4.5 and section 5 are untouched; a synthetic
Claude SSE stream equals master's with `ts` stripped).

Discovery (allowlist, ADAPTERS 7.1):
- The only transcript path accepted is `<root>/sessions/<group>/<session>/updates.jsonl`. `<group>` is any directory
  directly under `sessions/` (one per cwd, URL-encoded by Grok). Every group is walked, because a subagent child often
  sits in another group than its parent (15/62, worktree cwds). Group names are never decoded (as 4.4; the cwd comes
  from `summary.json`). `<session>` is the session folder, a UUIDv7 that equals `params.sessionId` on every line.
- Read, and nothing else: directory listings (`sessions/`, the groups, the session folders, their `subagents/`),
  `stat`, `updates.jsonl` (Tailer, 3.6) and `summary.json` (sidecar, below). Never opened: `prompt_history.jsonl` and
  `chat_history.jsonl` (raw prompts, model input), `events.jsonl` (the live approval wait of D7 is a later stage,
  ADAPTERS 9 P5g), `plan.json`, `plan_mode.json`, `plan.md`, `subagents/<child>/meta.json` and `output.json`, a group's
  `.cwd` file, `*.lock`, `active_sessions.json`, `session_search.sqlite`, `worktrees.db`, auth, config and permission
  files, `AGENTS.md`, `logs/`, `memory-v2/`, `memtrace/` and the spill folders (`terminal/`, `mcp/`, `compaction*/`,
  `web_fetch/`, `images/`, ...).
- Names: a group is any directory under `sessions/` whose name does not start with `.`; session and child folders must
  have UUID names (so `grok-<uuid>` fits the D2 id rule). Symlinks are never followed: directory entries are taken by
  type, a session folder's `subagents` entry is `lstat`ed and listed only when it is a real directory (a symlinked
  `subagents` names no children), and the transcript is `lstat`ed and must be a regular file. When the same session uuid exists in two groups, the
  copy with a transcript wins, then the newer mtime, then the larger size.
- Tolerant: ENOENT, ENOTDIR, EACCES, EPERM, ELOOP and ENAMETOOLONG on a group, a session folder or a `subagents/`
  folder skip that entry (folders appear, move and vanish live); a missing `sessions/` folder is an empty list. Only a
  `sessions/` entry that exists but cannot be read as a folder, or a cap (below), fails the scan, and the Runner skips
  that rescan (section 6, `scan failed`).
- Work per rescan is capped by `SCAN_LIMITS` in `src/adapters/grok/discover.mjs`: 10,000 groups, 50,000 session
  folders, 5,000 children per parent, a parent chain of depth 16 (a full walk of 5,000 folders takes about 0.15 s). A
  walk that would pass one of the first three caps is never cut and never classified: the scan throws `SCAN_CAPPED`, the
  Runner logs `scan failed: SCAN_CAPPED` once, keeps every attached session and skips that rescan until a whole walk
  fits again. (A cut by name order would drop the newest UUIDv7 folders and turn a child whose parent was cut into a
  main for good.)
- Active window (as 3.5 and section 6): a session is returned when its transcript's mtime is inside `--active`, and so
  is every ancestor of a returned sub, even outside the window (a parent waiting on its subagent writes nothing). Mains
  come first, then subs by depth.

Ids and subagent linkage (D2, 4.0.1 F2):
- Main: `kind: 'main'`, `charId` = `sid` = `grok-<session>`.
- Sub: a session whose folder name appears as a directory `subagents/<child>/` inside another session's folder (the
  names only; the child's own files carry no parent, 61/62). When two parents name the same child, the first in sorted
  order wins. `kind: 'sub'`, `charId` = `grok-<child>`, `parentId` = `grok-<parent>` (the immediate parent), `sid` =
  `grok-<root main>` (the top of the parent chain). A cycle or a chain deeper than 16 is not trusted and the session
  counts as a main. Through `sid` the sub inherits the root main's floor (4.4). The `subagent_spawned` record and
  `meta.json` are not used for linkage (the folder name is the same fact: child folder == child session id, 62/62).
- Every ref carries `agent: 'grok'` and passes the F2 guard (`stem` = `charId`, `sessionId` = the folder uuid).
- A child waits for its parent: a sub is returned only when every ancestor has a transcript; the Runner publishes it
  after its parent (`publishOrder`); and a child whose `subagent_finished` was read in the parent's file before the
  child is announced starts ended and is never shown (4.0.1 F4).
- Link grace (`LINK_GRACE_MS`, 1 s): a session folder that appears after the scanner's first scan and that no parent
  names yet is held for 1 s before it is returned as a main, because its parent may create `subagents/<id>/` a moment
  later; a main is never turned into a sub once attached. Folders that exist at the first scan are classified at once.
  The scanner keeps this state, so each Runner gets its own (`createGrokScanner`). When the parent names a folder only
  after that, the session stays a main, but its `summary.json` (`session_kind` `subagent`) marks it as running a
  parent's task: its human text never becomes a `prompt` or its title (sidecar below, 4.0.2 Prompts).

Sidecar (`SidecarWatcher`, `src/core/sidecar.mjs`, ADAPTERS 3.3):
- An adapter declares small metadata files per session with the optional descriptor hook `sidecars(ref)` ->
  `[{ path, parse }]`, which its `deps()` hands to the Runner. The Runner runs the watcher only for an adapter that has
  the hook (Claude has none and is untouched).
- The watcher `lstat`s the declared files of a session once when its transcript is attached, before the character is
  announced (so the first `session` event already has the title and cwd when the file exists), and then at each rescan
  for every attached session. Symlinks are not followed and only regular files count: the file is `lstat`ed, opened
  with `O_NOFOLLOW`, and read only when the opened file is that same regular file (inode and device), so a file swapped
  for a link or another file between the two is skipped until it changes again. It reads a file only when its inode,
  size or mtime changed since the last check, so a file is read once and then again only after a change. A file over
  1 MB (`SIDECAR_MAX_BYTES`) is not read; a file that fails to parse is not read again until it changes; a file that
  disappears is read again when it comes back; the values already passed on stay. The merged values of the files read go
  to the session's `setInfo()`, and the events it returns (a changed `session` event) are ingested as usual; for a
  character the Store has already ended only the state changes (a rewritten metadata file never revives an ended sub).
  The watcher never throws, and it forgets a file's signatures when the transcript is detached or moves.
- Grok declares `<session folder>/summary.json` (rewritten in place by Grok). A file whose `info.id` is not this
  session's folder uuid is ignored. It keeps string fields only: `title` = `generated_title`, `cwd` = `info.cwd` (an
  absolute path only), `branch` = `head_branch`, and for a subagent session (`session_kind` `subagent` or
  `subagent_resume`) `subagent: true` and `agentType` = `agent_name` (equal to the subagent type, 62/62; a main's
  `agent_name` is the agent profile and is not used). `subagent: true` matters only for a session attached as a main
  (its parent named it too late): from then on its prompts are not sent and its first human text is no longer the title
  fallback (4.0.2 Prompts). No other field of that file is kept (`session_summary`, `last_recap`, `git_remotes`,
  `git_root_dir`, `grok_home`, `parent_session_id`, ...).
- Title: `generated_title`, else the first human prompt (4.0.2), else 8 chars of the id after `grok-`. Branch:
  `head_branch` (`HEAD` -> `detached`, section 5 scrub, <= 60). `agentType`: section 5 scrub, <= 60. Cwd: `info.cwd`;
  the first cwd fixes the floor (4.4, D1 below). A session whose `summary.json` does not exist yet has no cwd, so its
  `session` event carries no project until the file appears (like a Claude file before its first record with a
  `cwd`).

Records (`src/adapters/grok/records.mjs` pure, `src/adapters/grok/session.mjs` `GrokSession` with the state):
- Envelope `{ method, params: { sessionId, update: { sessionUpdate, ... }, _meta }, timestamp }`, with `method`
  `session/update` (ACP kinds) or `_x.ai/session/update` (xAI kinds); both are read, anything else is skipped and
  counted. `timestamp` is unix **seconds**, so an item's `ts` is `timestamp * 1000` (a value already in ms is kept,
  `_meta.agentTimestampMs` is the fallback). File order wins (R12): `agentTimestampMs` steps backwards 1,075 times and
  is never used for order. A record whose `params.sessionId` is not the session folder's uuid is skipped (as R10).
  Every unknown `sessionUpdate` kind is ignored.
- Turn id = the turn's `promptId`: `params._meta.promptId` on ACP records, `update.prompt_id` on `hook_execution` and
  `turn_completed`. A `user_message_chunk` carries none. In most real turns the `user_prompt_submit` hook with the new
  id comes first (hook first); otherwise the id first shows on the records after the message (message first). Both
  orders give one turn per prompt (rows below; `src/adapters/grok/session.mjs` header).

| Grok record | normalized items (4.0.2) |
|---|---|
| `user_message_chunk` | Stays in the open turn when that turn has no work yet (no thought, say or tool: typically the turn its `user_prompt_submit` hook just opened, so hook first and message first give one turn), when it is an `interjection`, when it has no `_meta.promptIndex` (a human message typed mid-turn), when it comes before the open turn's id is known, or when it is hidden or synthetic (an injection mid-turn). Otherwise it starts a new turn: `turn_start` without an id before its prompt (4.0.2 order rule; the core closes a still-open previous turn as `next_turn`), and the next new `promptId` is adopted as that turn's id (no second `turn_start`). Both orders occur: hook first (the `user_prompt_submit` hook with the new id comes before the message in 1,214/1,238 real turns, and every subagent file starts with it) and message first. Human text (`_meta` without `hideFromScrollback` and without `syntheticPrompt`; `interjection` counts as human) -> `prompt { text }`; a hidden or synthetic chunk (`<system-reminder>`, `<monitor-event>`) gives no `prompt` but still starts a turn when none is open |
| a record with a new `promptId` while no turn waits for its id (the `user_prompt_submit` hook in the usual order) | `turn_start { id }` (prompt_id change; the core closes an open previous turn as `next_turn`) |
| a message, thought or `tool_call` record of a turn that already ended, or of an older turn | dropped (late records, 7 in the corpus): it never reopens a turn. One exception: when a message started a new turn while the previous turn was still running (no `turn_completed` yet) and records with that previous turn's id go on before any new id, the open turn adopts the previous turn's id and keeps that work instead of dropping it; a `turn_completed` for the previous id only ends that re-adoption. A late `tool_call_update` of a closed tool is ignored too; a late `plan` record still updates the board |
| `agent_thought_chunk` | its own `thinking { text, durationMs: null }` per record: each record is a whole reasoning-summary segment (never empty, 13,539 chunks in 13,534 runs), so back-to-back thoughts are separate events with their own first sentence, never joined or suppressed |
| `agent_message_chunk` | `say { text }`, one per record: each line is a whole text segment of one model response, not a token delta, so a record is never joined to the one before it and each is scrubbed on its own (section 5). A Grok `say` is never `final`: every turn ends with its `turn_completed` (1,234/1,234), so the core's 20 s `end_turn` idle fallback stays off and a turn never ends while the agent is still working (writing a long tool input, or after a hidden `todo_write` and a `plan`); a main that dies mid-turn ends when its file leaves the active window |
| `tool_call` | `tool_start` (Tools below); a `tool_call` that already carries a terminal status also ends at once. A second `tool_call` with an open id is read as an update (R9) |
| `tool_call_update` with `status` `completed` or `failed` | `tool_end` (Tools below). Other statuses (`pending`, `in_progress`) and updates without `status` change nothing |
| `plan` | `plan { items, source: 'update_plan' }` with every entry as `{ content, status }`: always the full list (D5). `priority` and `_meta` are dropped; an entry Grok stores as `completed` with `_meta.cancelled` stays `completed`, a `cancelled` status becomes `completed` |
| `subagent_spawned` | the child is launched: the oldest open `spawn_subagent` call of the same turn (`parent_prompt_id`) ends ok (async launch, R28). The spawn's own completion may come before or after it (10/62); whichever comes first ends the call |
| `subagent_finished` | `sub_end { childId: 'grok-<child_session_id>', reason: 'done' }` (`completed` and `cancelled` alike), the common end hint of 4.0.1 |
| `turn_completed` (the current turn; a turn whose id was never learned adopts it; an older id is ignored) | `cancelled` -> `tool_end { status: 'interrupted' }` for every tool still open, then `turn_end { reason: 'interrupt' }`; `error` -> `system { kind: 'api_error', text: 'API error' }` unless a `retry_state` already gave one in this turn, then `turn_end { reason: 'api_error' }`; any other `stop_reason` (`end_turn`) -> `turn_end { reason: 'end_turn' }` |
| `retry_state` | `system { kind: 'api_error' }`: `retrying` -> `API 재시도 <attempt>/<max_retries>` (as R31) plus ` (<error_type>)` when that is a short lowercase word; `failed` -> the first line of `message` (the core reduces it; fallback `API error`) |
| `auto_compact_started` | `system { kind: 'compact' }` |
| `hook_execution` | only its `prompt_id` (any hook that carries one), as a turn boundary: the `user_prompt_submit` hook's new `prompt_id` opens the turn (`turn_start { id }`) when no turn waits for an id (hook first), or becomes the id of the turn a message just started (message first); a hook with the current id changes nothing |
| ignored | `task_backgrounded`, `task_completed`, `background_tasks`, `current_mode_update`, `session_recap`, `compaction_checkpoint`, `auto_compact_completed`, `auto_compact_failed`, `memory_dream_*`, `hook_annotation`, `rewind_marker`, every unknown kind |

Tools:
- Name: `update._meta['x.ai/tool'].name` (`[A-Za-z0-9_.:-]{1,64}`), never `title` (a display string that can carry paths
  and commands). A `tool_call` without `x.ai/tool` whose `rawInput` has `backend` is the server-side web search: tool
  `web_search`. Pairing by `toolCallId` (opaque, the item `id`, R16): the first terminal update ends the call and later
  ones are ignored.
- The descriptor (4.0.2) is built from the `rawInput` fields in the table only. Every other field (`description`,
  `prompt`, `old_string`, `new_string`, `content`, `tool_input`, `todos`, `timeout`, option `description`s, `title`,
  `locations`, ...) is never read. Rooms are the ADAPTERS 6.2 Grok column, through the core's hints (D4):

| tool (`x.ai/tool.name`) | descriptor | room |
|---|---|---|
| `read_file` | `kind: 'read'`, `path: target_file` | archive |
| `list_dir` | `kind: 'read'`, `path: target_directory` | archive |
| `grep` | `kind: 'search'`, `query: pattern`, `path: path` | archive |
| `search_replace`, `write` | `kind: 'edit'`, `path: file_path` | dev |
| `run_terminal_command` | `kind: 'shell'`, `command` (a string, never argv), `background: rawInput.background` | program rule of 3.1 (archive / research / server) |
| `monitor` | `kind: 'shell'`, `command`, `background: true` (a monitor is always a background task, 259/259) | program rule of 3.1 |
| `get_command_or_subagent_output`, `kill_command_or_subagent` | `kind: 'shell'` without a command (task ids are not read); the summary is the tool name | server |
| `web_fetch` | `kind: 'web'`, `url` (host only) | research |
| `web_search` (server side, no `x.ai/tool`) | `kind: 'web'`; its query is known only at completion and is not read | research |
| `use_tool` | `tool_name` `<server>__<tool>` split at the first `__` -> `mcpServer`, `mcpTool`, so `tool` is `mcp__<server>__<tool>` (a uuid-looking server -> ZERO_UUID, section 5); a name without `__` is the server segment alone, so `tool` is `mcp__<server>`. `tool_input`, `file` and `tool_input_file` are never read. Without a `tool_name` (the `{file}` form) -> `kind: 'web'` | MCP names: none, the page classifies them (D4); without a name: research |
| `spawn_subagent` | `kind: 'agent'`, `description: subagent_type` (the agent type label; the model-written `description` and `prompt` are not read) | here |
| `ask_user_question` | `kind: 'ask'`, `questions` (`question` and at most 4 option `label`s each) -> `question` / `options` (R33, `askFields`) | desk |
| `exit_plan_mode` | `kind: 'ask'`, `question: '이 계획대로 진행할까요?'`, `options: ['승인', '수정 요청']` (R34) | desk |
| `todo_write`, `enter_plan_mode` | hidden: no `tool_start`, no `tool_end`; the board comes from the `plan` record | - |
| `search_tool` | hidden (tool lookup plumbing like Claude `ToolSearch`; provisional, ADAPTERS 6.2) | - |
| any other name (`scheduler_list`, new tools) | `kind` from `x.ai/tool.kind` (`read`, `list` -> read; `search` -> search; `edit`, `write` -> edit; `execute` -> shell without a command; `fetch`, `web_fetch` -> web; else other), no input read; `tool` = the name (`tool` when there is none) | by kind |

  ADAPTERS 6.2 puts `enter_plan_mode` in the meeting room. The core gives that room only to `kind: 'plan'` calls, which
  show no `tool_start`, and the page does not change (D4), so it is hidden like `todo_write`.
- End status (the terminal update). Error lines come only from structured fields or fixed phrases; result bodies
  (`content` text beyond the denial check, `output`, `stdout`, `stderr`, diffs) never reach an event:
  - `completed` -> ok, except: a `rawOutput` of type `Bash` whose `exit_code` is a non-zero integer -> `failed`, error
    `Exit code <n>` (the corpus has 602 such results written as `completed`); `rawOutput.type` `BackgroundTaskStarted`
    -> ok with `background` (R28; the task's later `task_completed` is ignored); `spawn_subagent` -> ok (async launch);
    an `exit_plan_mode` completed without `rawOutput` (the user chose to revise or abandon the plan) -> `denied`, error
    `User asked to revise the plan`, `User abandoned the plan` or `Plan not approved`.
  - `failed` without `rawOutput`: a first text line that starts with a fixed denial phrase (80 in the corpus) ->
    `denied` with a fixed error line, and the rest of the text (a hook's or classifier's reason) is dropped:
    `Tool <x> was not executed: Auto mode blocked this action` / `... Denied by permission policy` -> `Tool <name> was
    not executed: <that reason>` (any other reason -> `Tool <name> was not executed`; `<name>` is the call's own tool
    name, never text from the line), `Hook denied:` -> `Hook denied`, `User rejected the execution` -> the same,
    `Rejected: file edits are not allowed in plan` -> `Rejected: file edits are not allowed in plan mode`, any other
    `Rejected:` -> `Rejected`. Without such a phrase -> `failed` with no error line (the core's fallback `failed`).
  - `failed` with `rawOutput` -> `failed`, error from the first line of `error` or `message`, else `Exit code <n>`, else
    the result's variant name (`FileNotFound`, `NoMatchesFound`, ...), else `MCP tool error` for an MCP `is_error`.
  - The core reduces every error line (`sanitizeLine`, `cleanText`, <= 120).
  - `exit_plan_mode` (R34, adapted): Grok writes the plan text only at completion (`rawInput` is `{}` in the corpus;
    the text is `rawOutput` `PlanReady.plan_content`; `plan.md` is outside the allowlist). When the `tool_call` carries
    a plan (`rawInput.plan` or `plan_content`) it is sent as `plan { markdown }` before the ask's `tool_start` (the R34
    order). Otherwise the ask comes first, and at a completed update with `PlanReady` the adapter sends
    `plan { markdown: plan_content }` (`exit_plan`, at most 6 items via `planFromMarkdown`; skipped when it equals the
    plan already shown) and then `tool_end` ok. Revise or abandon gives `denied` and no plan.
  - A call still open at `turn_completed` `cancelled` -> `interrupted` (above); one still open when the next turn
    starts -> `abandoned` (core, R27).

Floors (D1):
- An ordinary cwd goes through the shared `projectKey` (4.4), the function the Claude adapter uses, so a Grok session
  and a Claude session in the same folder share a floor. A project-local worktree (`.worktrees/<name>`,
  `.claude/worktrees/<name>`; the form the corpus shows, 15/107) joins its repository's floor with a worktree badge, as
  for Claude.
- A Grok-managed worktree, project `<root>/worktrees/<repo>/<name>[/...]` with `<root>` the Grok root (documented by
  Grok, none in the corpus): the session joins an existing floor whose `projectLabel` equals `<repo>`, else one whose
  label equals `<name>`. Candidates are the floors of live (not ended) main sessions of any adapter, announced or still
  attaching, except other tool-worktree floors. When none matches it gets its own floor keyed by the checkout
  `<root>/worktrees/<repo>/<name>` (label `<name>`). `worktree` is `<name>` in every case (a heuristic, so the HUD shows
  the badge). The floor is chosen once, the first time the Store sees that project (the first cwd), and does not move
  afterwards (4.4), so snapshots and live events agree.
- Startup order: the choice must not depend on which adapter happens to attach first. At the group's first rescan a
  Runner that has a floor rule (Grok; Codex too since P5d, 4.7) waits until every Runner without a rule (Claude) has
  finished its first attach pass (scan, replay, announce) before it scans and announces (`RunnerGroup.rescan`, the
  Runner's `gate`); its own rescan
  timer waits for the same promise, so a slow first Claude walk cannot be overtaken. The wait ends after
  `FIRST_PASS_WAIT_MS` (10 s) at most, so a stalled first walk never keeps Grok off. Runners without a rule never wait,
  later rescans run together, and an adapter switched on later (4.0.1 F1) does not wait either.
- Mechanism: the descriptor's `worktreeFloor(project, root)` (passed in `deps`) returns `{ key, names: [repo, name],
  badge }` or null; the Runner registers it with `store.setFloorRule(agent, fn)`, and the Store applies it when it
  patches a `session` event of that agent (`pickFloor` in `store-link.mjs`). Adapters without a rule (Claude) are not
  patched, so Claude events do not change.
- Subs take the floor of their root main (`sid`), as patched.

Descriptor and session end:
- `src/adapters/grok/index.mjs`: `id: 'grok'`, `defaultRoot: '~/.grok'`, `sidecars(ref)` (the session's
  `summary.json`), `worktreeFloor` (D1 above) and `deps()`: the Runner bundle `{ agent: 'grok', SessionState:
  GrokSession, Tailer, scan: a fresh createGrokScanner(), sidecars, worktreeFloor }`. No `readSubMeta` /
  `readJournalLabels` (Claude-only) and no replay support (D12). `GrokSession` (`session.mjs`) takes the Runner's
  constructor options (`id`, `kind`, `parentId`, `agentType`, `now`; the Claude-only ones are ignored) and wraps
  `SessionCore`.
- A main never idles out by itself (4.0.2); it ends when its file leaves the active window (section 6). A sub ends at
  its parent's `subagent_finished` (above) or by the core's idle rule (R29, `SUB_IDLE_MS`). `hook_execution`
  `session_end` and `active_sessions.json` are not used.

Tests: synthetic fixtures shaped from the research file (`test/fixtures/grok.mjs` record builder,
`test/fixtures/grok-tree.mjs` folder trees), under temp roots only (never the real `~/.grok` or `~/.claude`); tests that
spawn the bin set `HOME` to a temp folder, because the bin fills the default `~/.grok` root. The conformance harness
(4.0.2) runs against the Grok adapter. `test/grok-discover.test.mjs` covers linkage across groups, the active window
with ancestors, waiting children, the link grace, odd names, ENOENT, duplicates, cycles, caps and the allowlist (bait
files next to the transcripts are never opened, listed or `stat`ed, checked with an fs spy on a real server);
`test/sidecar.test.mjs` covers re-reading only on change, the size cap, parse errors, symlinks (also one swapped in
between the `lstat` and the open), the Claude Runner without the hook, the first `session` event with the summary
values and a child attached as a main that never sends its task (also `test/grok-task-runner.test.mjs`);
`test/grok-floor.test.mjs` covers the D1 floors and
the startup order; `test/grok-records.test.mjs` and the session tests cover every mapping row above (hidden prompts and
turn order, one item per chunk with no idle fallback, late records, exit codes, denial lines, cancelled turns, plan
records, `exit_plan_mode`, MCP names); `test/grok-discover.test.mjs` also covers a symlinked `subagents/` and the
`SCAN_CAPPED` skip on a real server; `test/grok-docs.test.mjs` pins the 4.6 record rows and the package description. The only real-data
use is a read-only check against `~/.grok` that prints counts only (events, unpaired tools, apply errors, privacy hits).

### 4.7 Codex adapter (P5d)
The Codex adapter reads OpenAI Codex rollouts. Every Codex client writes the same files, in the same folder and format:
the desktop app (`originator` `Codex Desktop`, `codex_work_desktop`), the CLI (`codex_cli_rs`, `codex-tui`,
`codex_exec`) and the IDE extension (`codex_vscode`), so one agent id covers them all. Format facts come from the
structure-only study `docs/research/codex-format.json` (5,233 rollouts, 4,070,420 lines, cli 0.40 to 0.163-alpha); the
design is ADAPTERS 5.1, 6.1-6.3 and D10, and where this section differs from those proposals, this section wins. Agent
id `codex`, default root `~/.codex` (`--codex-root`, section 6). Code: `src/adapters/codex/`: `discover.mjs` (allowlist
discovery, date-folder walk, continuation pieces, parent chain), `line0.mjs` (line-0 facts and their cache),
`titles.mjs` (the incremental `session_index.jsonl` reader), `records.mjs` (one record -> item pieces, pure),
`exec.mjs` (code-mode `exec`, pure), `session.mjs` (`CodexSession`: turn, tool and inherited-context state around
SessionCore, the SessionLike API) and the descriptor `index.mjs`, registered in `src/adapters/index.mjs`. Every cap,
scrub, pairing, turn and plan rule of 4.0.2 applies. Behaviour that depends on the version is keyed off each file's own
`session_meta.cli_version`, never off the installed CLI (a rollout is written by whichever client ran the thread).
Claude and Grok behaviour does not change (4.1-4.6 and section 5 keep their rules).

Discovery (allowlist, ADAPTERS 7.1):
- The only transcript paths accepted are `<root>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` and its rollback
  continuation pieces `<root>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>_<uuid2>.jsonl`: `<YYYY>` four digits,
  `<MM>` `01`-`12`, `<DD>` `01`-`31`, `<ts>` `YYYY-MM-DDTHH-MM-SS`, `<uuid>` (the thread id) and `<uuid2>` UUIDs in any
  case (lowercased). Folder dates and `<ts>` are local time; record timestamps are UTC.
- Read, and nothing else: listings of `sessions/` and its year, month and day folders, `lstat` of accepted names, line 0
  of an accepted file (below), an attached file through the Tailer (3.6), and `<root>/session_index.jsonl` through the
  title reader (Titles below). Every other name is passed over by its name, without a `stat`. Never opened: `*.jsonl.zst`
  (Codex compresses a rollout in place after 7 days; Node 20 has no zstd, and a file inside the active window is plain),
  `archived_sessions/`, `history.jsonl` (raw prompts), the auth and config files, the SQLite stores (`state_5.sqlite`,
  `thread_history_1.sqlite`, `logs_2.sqlite`, `sqlite/`), `.codex-global-state.json`, `thread-writer-locks/`,
  `external_agent_session_imports.json`, log files, and everything under `worktrees/` (a worktree path is only compared
  as a cwd string, Floors below).
- Symlinks are never followed: directory entries are taken by type (a symlinked folder or file is no entry), and a
  `sessions/` that is a symlink counts as missing. A date folder that a scan lists or re-`lstat`s without a full walk
  (the hot folders and the cold ones, below) is used only when every folder of its path (`sessions/`, year, month,
  day) is a real folder by `lstat`, so the full and the hot walks treat a linked folder the same way and nothing
  outside `<root>` is listed, `stat`ed, opened or tailed. An accepted file is `lstat`ed and must be a regular file, and
  its line 0 is read through `O_NOFOLLOW` only when the opened file is the `lstat`ed one (inode and device).
- Tolerant: ENOENT, ENOTDIR, EACCES, EPERM, ELOOP and ENAMETOOLONG on a folder or a file skip that entry; a missing
  (or symlinked) `sessions/` is an empty list. Only a `sessions/` entry that exists but is not a folder or cannot be
  read, or a cap (below), fails the scan, and the Runner skips that rescan (section 6, `scan failed`).
- Caps (`SCAN_LIMITS` in `discover.mjs`): 20,000 date folders, 200,000 accepted names in one walk, a parent chain of
  depth 16, 256 KB of line 0. A walk that would pass one of the first two throws `SCAN_CAPPED` instead of returning a
  cut list: as for Grok (4.6) the Runner logs the code once, keeps every attached session and skips that rescan.
- Date-folder walk (ADAPTERS 8.1 #17): a rescan does not walk every year. Every scan lists the hot date folders: the
  local dates that can hold a file created inside the active window (one day of margin on both sides for time zones and
  clock skew), when the last full walk saw that folder or the date is within the last two days (`RECENT_MS`; such a
  folder may be newer than the walk), and only when its path is real folders (Symlinks above). Every date folder is listed (names only) at the first scan and then at most every
  30 s (`FULL_WALK_MS`), and once early when a needed parent is not among the names of the last full walk. The rollouts
  of the other folders keep their last `lstat`, except those inside the window, which are `lstat`ed again on every scan
  while their folder path is still real folders; a folder that leaves the hot set joins them at once. So a thread started on an earlier day that is still being written
  stays attached, and a thread that Codex decompressed back to `.jsonl` in its old date folder when it was resumed is
  found within 30 s.
- Active window (as 3.5 and section 6): a thread is returned when one of its pieces has an mtime inside `--active`, and
  so is every ancestor of a returned sub, even outside the window (a parent waiting for its subagent writes nothing; as
  Grok, 4.6). Order: by depth (mains first, then subs by depth); at the same depth a thread working in a Codex-managed
  worktree (cwd under `<root>/worktrees/`, Floors below) comes after the others, then by uuid. The Runner attaches one
  `sid` group at a time in this order, so a worktree main is attached after every plain main of the same scan.

Line-0 facts (`line0.mjs`):
- Of an accepted file only line 0 (`session_meta`, line 0 in 5,233/5,233 files) is read, at most 256 KB
  (`LINE0_MAX_BYTES`). The facts are cached by path (at most 100,000 entries, pruned to the files of the last full
  walk) and stay valid while the inode is the same and the file is not shorter than line 0 (rollouts only grow);
  otherwise line 0 is read again. A line 0 that has no newline yet is read again at the next scan, and its thread (and a
  sub whose ancestor is in that state) waits. A file whose line 0 is over the cap, is not valid JSON, is not a
  `session_meta`, or whose `payload.id` is not the file name's `<uuid>` (5,233/5,233 match) is never returned; a file
  that cannot be opened is tried again later.
- Facts kept: the thread id, the guardian flag, the `/review` mark, the immediate parent
  (`source.subagent.thread_spawn.parent_thread_id`, else `payload.parent_thread_id`, for a subagent source only),
  `cwd` (an absolute path), `git.branch`, `cli_version`, `subagent_history_start_ordinal`, the sub's `agent_role` and
  the line's ordinal (for continuation pieces). The session reads the same line again (Records below) and takes from it
  only these and, for a sub, `agent_nickname` and the last segment of `agent_path` (a title fallback). No other field is
  kept or sent: the account and user ids (`creator_user_id`, `creator_account_id`), `session_id`, `originator`,
  `model_provider`, `base_instructions`, `git.repository_url`, `git.commit_hash`, `runtime_workspace_roots`,
  `forked_from_id`, ... never reach an event.
- Guardian threads (`source.subagent.other` = `'guardian'`, the automatic approval reviewer; 2,171 of 5,233 files, 41%,
  D10a) and their descendants are hidden entirely: never returned, never tailed, no character; only line 0 was read.
  The test reads `source`, never `thread_source` (guardian files carry `guardian_review`, `subagent` or no
  `thread_source`).

Ids and subagent linkage (D2, 4.0.1 F2):
- Main: `kind: 'main'`, `charId` = `sid` = `stem` = `codex-<uuid>`, `sessionId` = the uuid. Every ref carries
  `agent: 'codex'`, passes the F2 guard, and carries the rest of its line-0 facts (`facts`: `cwd`, `branch`,
  `cliVersion`, `historyStart` and a sub's `agentType`), which the Runner passes to the session constructor as `facts`
  (sessions that do not use it ignore it; `CodexSession` reads its own line 0 from the transcript as well).
- Sub: a thread whose parent chain reaches at least one ancestor. `kind: 'sub'`, `charId` = `codex-<uuid>`, `parentId`
  = `codex-<immediate parent>`, `sid` = `codex-<top of the chain>`, the root main whose floor the sub takes (4.4). The
  chain is walked through each ancestor's line 0; an ancestor outside the window is found by its uuid among the rollout
  names (names only) and only its line 0 is read. The chain stops at an ancestor without a plain rollout (only a `.zst`
  is left, or it is archived) or with an unusable line 0: the last ancestor reached is the root main, and a thread whose
  immediate parent cannot be reached is a main. A cycle or a chain deeper than 16 is not trusted and the thread counts
  as a main. (`thread_spawn` children: 1,948 files, depth 1-3, every parent present in the study.)
- `/review` threads (`source.subagent` = `'review'`, 77 files) are not hidden: they are ordinary subagents (D10d), a
  sub under the parent that their line 0 names, with `agentType` `review`.
- A thread whose own line 0 says it runs a parent's task (`thread_spawn` or `/review`) but that is attached as a main
  (its parent cannot be reached) is marked `subagent: true` (4.0.2 Prompts): its human text is never a `prompt` or its
  title.
- The Store's `parentSessionId` is `parentId`. A child is published after its parent (`publishOrder`), and a child
  whose end was read in its parent's file before the child is announced starts ended and is never shown (4.0.1 F4).

Continuation pieces:
- A rollback writes `rollout-<ts>-<uuid>_<uuid2>.jsonl` next to the thread's file (6 in the study). It is the same
  thread (`<uuid>` = its `payload.id`), so the same character. Its line 0 is a `session_meta` whose ordinal is above 0,
  and its records supersede the previous file's tail. Discovery returns one ref per thread, the winning piece: the
  newest mtime, then the higher line-0 ordinal, then the continuation piece over the base file, then the later name. The
  first piece in that order whose line 0 is usable wins (one whose line 0 is not complete yet gives way to an older
  usable piece).
- When another piece wins, the Runner moves the character to it like a relocation to a copy (section 6: the old path is
  detached without a `session_end`, and the new piece is attached and replayed from its start). The state is rebuilt
  from that piece alone and the character keeps its id.

Titles and labels:
- Title: `thread_name` from `<root>/session_index.jsonl` (lines `{ id, thread_name, updated_at }`, append-only; the last
  line for an id wins), else for a main the first human prompt (<= 40, 4.0.2), for a sub its `agent_nickname`, else the
  last segment of its `agent_path`; else 8 chars of the id after `codex-`. Only `id` and `thread_name` of the index are
  used.
- The index can grow large and is shared by every thread, so it is not read by a `SidecarWatcher` (which re-reads a
  whole file of at most 1 MB per session, 4.6) but by `CodexTitles` (`titles.mjs`). The descriptor hands it to the
  Runner as `deps.sidecarWatcher` (any object with `check(ref)` and `forget(path)`), and the Runner uses it in the place
  of a `SidecarWatcher`: `check` runs when a transcript is attached, before the character is announced, and at each
  rescan for every attached session, and its `{ title }` goes to the session's `setInfo` (a changed `session` event
  follows; for a character the Store has already ended only the state changes).
- Reading: one index reader per root, and checks within 250 ms share one refresh (`TITLE_REFRESH_MS`, so one read per
  rescan). A refresh `lstat`s the file (a regular file only; opened with `O_NOFOLLOW` and read only when it is the
  `lstat`ed file), reads only the bytes appended since the offset it remembers, at most 1 MB (`INDEX_READ_BYTES`; the
  rest follows at the next refreshes), keeps a trailing partial line for the next read, and skips a line over 64 KB
  whole and a line that is not valid JSON. An entry needs a UUID `id` and a non-empty `thread_name` of at most 1,000
  chars; at most 100,000 ids are kept (the least recently updated is dropped first). A file with a new inode, or one
  that got shorter, is read again from the start (the titles known so far are dropped). A missing index changes
  nothing. A title is handed to a transcript only when it is new or changed for that path; the reader forgets a path
  when its transcript is detached or moves.
- Branch: `git.branch` (`HEAD` -> `detached`, section 5 scrub, <= 60; `git: null` -> no branch). Cwd: `payload.cwd`
  (an absolute path; it never changed within a thread, 0/5,233), else the first absolute `turn_context.cwd`; the first
  cwd fixes the floor (4.4, Floors below). A sub's `agentType` is its `agent_role` (`explorer`, `worker`, `default` or
  a user-defined role), `review` for a `/review` thread; section 5 scrub, <= 60.

Records (`src/adapters/codex/records.mjs` and `exec.mjs` pure, `src/adapters/codex/session.mjs` `CodexSession` with the
state):
- Envelope `{ timestamp, ordinal, type, payload, metadata? }`. `timestamp` (ISO, UTC, ms) is the item `ts`; `ordinal`
  (the 0-based line index; a continuation piece starts higher) is the dedupe key (R9; at least the last 65,536 ordinals
  are remembered and older ones fall below a floor: the set is rebuilt in one pass when it passes 131,072, keeping the
  newest 65,536, so a line costs O(1) however long the file). The one legacy-mode file has no ordinals and is not deduped. File order
  wins (R12): timestamps step backwards in 16 records. A line that is not an envelope is counted and skipped. Every
  unknown `type`, `payload.type` and item `type` is ignored.
- Text source: assistant text and reasoning summaries are written twice in most files (a `response_item` and an
  `item_completed` item, ADAPTERS 8.1 #5), so each file reads them from one source only, chosen by its `cli_version`:
  0.142.5 and newer (the code-mode era) read the `item_completed` items `AgentMessage` and `Reasoning` (which carry start
  and end times); older, missing or unparsable versions read `response_item` `message` and `reasoning` (every version
  writes them). One model message gives one `say`, one reasoning block one `thinking`.
- Inherited context (subagent files, `subagent_history_start_ordinal` H): records whose ordinal is below H copy the
  parent's context (another thread's `session_meta`, `compacted` records, messages). While the attach replay runs they
  are applied provisionally (state only, no end hints). The first record at or above H drops that state (a fresh core,
  with the file's own `meta` and the `setInfo` values applied again). When the replay ends (at the first `idle()`, which
  the Runner calls before it announces the file, or at the first live record) and no record at or above H came: a file
  whose `cli_version` is older than 0.154 (or missing or unparsable) keeps the provisional state as its own, because
  older migrated files set H to the file's line count and skipping would leave nothing (research: every spawn file
  without records after H is older than 0.154); a 0.154+ file drops that state and waits for its own records (a forked
  child writes line 0 and the inherited block in a burst at birth, so an attach in between must not show the parent's
  in-flight calls as the child's). Records below H that arrive after that are dropped.

| Codex record | normalized items (4.0.2) |
|---|---|
| `session_meta` (the file's own, line 0) | `meta { cwd, branch }`; for a sub also `agentType` and the title fallback; for a main whose line names a parent's task, `subagent: true`. It also fixes the text source and H. A `session_meta` of another thread (inherited context) or a repeat changes nothing |
| `turn_context` | `meta { cwd }` only when `session_meta` had no cwd (an absolute path); otherwise ignored |
| `event_msg` `task_started` | `turn_start { id: turn_id }`; the core first closes a still-open previous turn as `next_turn`, its open tools `abandoned` (787 starts without an end in the study) |
| `event_msg` `task_complete` | `turn_end { reason: 'end_turn' }`, the open tools `abandoned` (core). With `error`: `system { kind: 'api_error', text }` from the first line of `error.message` (fallback `API error`; the core reduces it), then `turn_end { reason: 'api_error' }`. One with an older turn id is ignored; one without an open turn (279 in the study) emits nothing (core) |
| `event_msg` `turn_aborted` | every call still open ends `interrupted`, then `turn_end { reason: 'interrupt' }` (whatever its `reason`); one with an older turn id is ignored |
| `event_msg` `item_completed` `UserMessage` | `prompt { text }` from the first text part (images are ignored). The desktop and IDE clients put context sections in front of the request (`# Context from my IDE setup:`, `# Files mentioned by the user:`, ...) and mark the request with `## My request:` (legacy and TUI: `## My request for Codex:`), a marker they write only after such a prefix: a text with the marker gives only the trimmed text after its last occurrence, and nothing after it gives no prompt (injected context is never a prompt, ADAPTERS 7). The core skips text that starts with `<` (R17-R19: heartbeats, browser context, question replies) and never sends a sub's prompt |
| `response_item` `message` with role `user` or `developer` | ignored: injected context (`AGENTS.md`, `<environment_context>`, `<subagent_notification>`, permissions, ...), never a prompt |
| assistant text: `item_completed` `AgentMessage` (text source `item`), or `response_item` `message` with role `assistant` (source `response`) | `say { text }` from the joined `Text` / `output_text` parts, with `final: true` when `phase` is `final_answer` (the turn's closing answer: the core's 20 s `end_turn` fallback closes a turn whose `task_complete` never comes) |
| reasoning: `item_completed` `Reasoning` (source `item`), or `response_item` `reasoning` (source `response`) | `thinking { text, durationMs }`: the first non-empty summary entry (the core keeps its first sentence), `null` when every entry is empty; `durationMs` = the item's `completed_at_ms - started_at_ms` when both are there, else null. `encrypted_content`, `content` and `raw_content` are never read |
| `response_item` `function_call`, `custom_tool_call` | `tool_start { id: call_id }` (Tools below). Hidden plumbing gives nothing, and neither does its output; a call whose id is already open is ignored (R9) |
| `response_item` `function_call_output`, `custom_tool_call_output` | `tool_end { id: call_id, status, errorLine?, background? }` for an open call (End status below); an unknown, hidden or closed `call_id` is ignored. Pairing is by `call_id` only (R16: calls are often written back to back before their outputs) |
| `event_msg` `item_completed` `CommandExecution`, `FileChange`, `McpToolCall`, `WebSearch`, `ImageView` | while a code-mode `exec` call is open: a visit (Code mode below). Otherwise ignored: before code mode the same work already has its own call line (`exec_command`, `apply_patch`, MCP calls), and a visit would show it twice |
| `response_item` `web_search_call` (0.91-0.142.5; it has no output record) | a visit: the `tool_start` (`web_search`, `kind: 'web'`, the host of `action.url`, else `action.query` or the first of `action.queries`) and its `tool_end` at once (`failed` when the call's `status` is `failed`), keyed by the call's `id` (else `ws-<ordinal>`) |
| `event_msg` `item_completed` `Plan` | `plan { markdown: text }` -> `exit_plan` (a plan-mode proposal, at most 6 items via `planFromMarkdown`) |
| `event_msg` `item_completed` `SubAgentActivity` with kind `completed` or `interrupted` | `sub_end { childId: 'codex-<agent_thread_id>', reason: 'done' }`, the common end hint of 4.0.1 (an `agent_thread_id` that does not fit the D2 id rule is counted and skipped). The kinds `started` and `interacted` give nothing. While the attach replay runs (also when a file is attached again: a continuation switch or a truncation) no end hint is given: each child's last kind in the file is kept (at most 1,000 children), and when the replay ends the children whose last kind is `completed` or `interrupted` get the hint, before the Runner announces anything (a finished child still starts ended, 4.0.1 F4). So a child that was completed and then re-tasked (v2 multi-agent writes `interacted`, often without a new `started`) is not ended. After the replay a `completed` / `interrupted` ends the child at once; the Store's revive covers a later re-task |
| `compacted` | `system { kind: 'compact' }` (its `message` is not read); inherited copies give nothing (above). `response_item` `compaction` and the `ContextCompaction` item describe the same compaction and are ignored |
| ignored | `token_count`, `token_usage_record`, `world_state`, `thread_settings_applied`, `thread_goal_updated`, `inter_agent_communication_metadata`, `response_item` `agent_message` (a task between agents), `compaction`, `additional_tools`, `tool_search_call`, `tool_search_output`, `image_generation_call`, `retained_context`, the legacy `event_msg` `user_message` and `agent_message`, the items `ContextCompaction`, `Extension`, `CollabAgentToolCall`, `HookPrompt`, `EnteredReviewMode`, `ExitedReviewMode`, `DynamicToolCall`, and every unknown type |

Tools:
- Name: `name` (`[A-Za-z0-9_.:-]{1,128}`, else `tool`). A namespace other than `mcp__<server>` gives `<namespace>.<name>`
  (`collaboration.spawn_agent`, `clock.sleep`, `web.run`), looked up by that full name, then by the bare name. Pairing
  by `call_id` (opaque, the item `id`, R16). `arguments` is a JSON string; one that does not parse gives an empty
  argument set (2 of 498,056 in the study).
- The descriptor (4.0.2) is built from the argument fields in the table only. Every other argument (`workdir`,
  `justification`, `sandbox_permissions`, `with_escalated_permissions`, `prefix_rule`, `message`, `task_name`,
  `fork_context`, `explanation`, option `description`s, ...) is never read. Rooms come from the core's hints (D4):

| tool (`name`) | descriptor | room |
|---|---|---|
| `exec_command` | `kind: 'shell'`, `command: cmd` (a string) | program rule of 3.1 (archive / research / server) |
| `shell_command` | `kind: 'shell'`, `command` (a string) | program rule of 3.1 |
| `shell` | `kind: 'shell'`, `command` (an argv array, as the study shows, or a string); a `[bash, -lc, <script>]` argv is unwrapped by the core | program rule of 3.1 |
| `apply_patch` (custom tool, `*** Begin Patch` grammar) | `kind: 'edit'`, `patch: input` (only the file names in its headers are used, the body is discarded) | dev |
| `view_image` | `kind: 'read'`, `path` | archive |
| `web.run` | `kind: 'web'`, no argument read | research |
| `request_user_input`, `request_user_input_async` | `kind: 'ask'`, `questions` (at most 50; `question` (the async form names it `title`) and at most 4 option `label`s each (the async form gives plain strings or null); `id`, `header` and option `description`s are not read) -> `question` / `options` (R33, `askFields`); its output ends it (`{ answers }`, or `{ accepted }` for the async form) | desk |
| `update_plan` (until 0.146) | `kind: 'plan'`: no `tool_start`, no `tool_end`; `plan[{ step, status }]` (at most 1,000) -> `items` with source `update_plan` (`step` -> content, the same status words, D5), shown when its output ends it ok (R35) | - |
| MCP: name `mcp__<server>__<tool>` (until 0.118), or namespace `mcp__<server>` with name `<tool>` (0.117 on) | `tool` `mcp__<server>__<tool>` through `tool-summary` (a uuid-looking server -> ZERO_UUID, section 5); arguments are never read | none, the page classifies MCP names (D4) |
| `spawn_agent` (bare or `collaboration.`) | `kind: 'agent'`, `description: agent_type` (the summary is the agent type, such as `explorer`); its output ends it (async launch, R28) | here |
| `wait_agent`, `close_agent`, `send_input`, `send_message`, `followup_task`, `list_agents`, `interrupt_agent` (bare or `collaboration.`) | `kind: 'agent'`, no argument read | here |
| `clock.sleep` | `kind: 'other'`, no argument read; `CodexSession` puts the `lounge` room hint on its `tool_start` (ADAPTERS 6.2; the core has no lounge kind) | lounge |
| `exec` (custom tool, code mode, 0.142.5 on) | Code mode below | from the first script tool |
| `write_stdin`, `wait`, `search_tool_bm25`, `list_mcp_resources`, `list_mcp_resource_templates`, `get_goal` | hidden plumbing: no `tool_start`, no `tool_end` (`write_stdin` and `wait` only poll a command or cell that is already running) | - |
| any other name (`codex_app.*`, other custom tools, new tools) | `kind: 'other'`, no argument read, `tool` = the name | here |

- End status (the output). Error lines are fixed text or an exit code; command echoes, file contents, stdout, stderr
  and every other part of an output never reach an event. The output text is the `output` string, or the first
  `input_text` part of an array; only its first line (within 4,096 chars), the result header lines before `Output:`
  (at most 12), or a JSON result's `metadata.exit_code` are read. In this order:
  1. An exit code: `metadata.exit_code` of an object or JSON-string output (`shell` until 0.58, `apply_patch`), a first
     line `Exit code: <n>` (`shell_command`, `apply_patch` text), or a header line `Process exited with code <n>`
     (`exec_command`, `write_stdin`). `0` -> ok, else `failed` with error `Exit code <n>`. Another JSON object (answers,
     MCP results) -> ok.
  2. A header line `Process running with session ID` -> ok with `background` (R28): the command lives on in the
     background, and the later `write_stdin` that reports its end is plumbing.
  3. Fixed phrases of the first line: starts with `aborted by user` -> `interrupted` (`Aborted by user`); contains
     `rejected by user`, `exec command rejected` or `patch rejected` -> `denied` (`Rejected by user`); contains
     `approval required by policy` -> `denied` (`Approval required by policy`); contains `sandbox denied` or `failed in
     sandbox` -> `denied` (`Sandbox denied`); starts with `command timed out` -> `failed` (`Command timed out`); starts
     with `Script failed` / `Script error` -> `failed` (that phrase); `<name> failed` at the start (such as `collab
     spawn failed`) -> `failed` with `<tool> failed`, where `<tool>` is the call's own name, never words of the output.
  4. Anything else -> ok.
- A call still open at `turn_aborted` ends `interrupted` (above); one still open at `task_complete` or at the next
  `task_started` ends `abandoned` (core, R27). A line over the Tailer's 8 MB cap (Codex lines reach about 10 MB, mostly
  large outputs) is skipped and counted (3.6); when it was an output, its call ends `abandoned` with its turn.

Code mode (D10, ADAPTERS 6.3; `exec.mjs`):
- From 0.142.5 Codex does almost everything through one custom tool `exec` whose input is a script that calls
  `tools.<name>(...)` (108,303 calls). The inner calls have no call line of their own: they appear only as
  `item_completed` items, written while the `exec` call is still open (78,579 of 101,051 `CommandExecution` items).
- The `exec` call -> `tool_start { tool: 'exec' }`. Its summary and room come from the first `tools.<name>` (or
  `tools?.<name>`) identifier in the first 64 KB of the script, read as an identifier only, by a small scanner that
  tells code from string literals, template text, regex literals and comments (the code inside a template's `${...}`
  is code; a `/` starts a regex after an operator, an opening bracket, `{`, `}`, `;`, the start of the script or a
  keyword such as `return` or `typeof`, and divides after a name, a number, `)` or `]`). A bracket form such as
  `tools["x"]` is a string and is not read; arguments and every other part of the script are never read. A script
  whose scan ends inside an unclosed string, regex, template or comment, or meets a line break inside a string or
  regex, is not JavaScript as far as the scanner can tell: it gives no name (a plain `exec`), except that a script cut
  at the 64 KB limit keeps the names read before the cut. The names `update_plan`, `write_stdin`, `wait`, `tool_search`, `search_tool_bm25`,
  `list_mcp_resources`, `list_mcp_resource_templates` and `get_goal` are passed over. The summary is that name (an MCP
  name `mcp__<server>__<tool>` normalized as above), and its kind gives the room: `exec_command`, `shell`,
  `shell_command` -> shell (no command, so server); `apply_patch` -> edit (dev); `view_image` -> read (archive);
  `web_search`, `web_fetch` or an MCP name -> web (research); the agent names of the table -> agent (here); any other
  name -> other (here). A script without such a name -> summary `exec`, kind other.
- While an `exec` call is open, each inner item becomes a visit: a `tool_start` and its `tool_end` at once, keyed by
  the item's own `id`:

| inner item | visit `tool_start` | visit `tool_end` |
|---|---|---|
| `CommandExecution` (`command` is always `[zsh\|bash, -lc, <script>]`) | `exec_command`, `kind: 'shell'`, `command` = `parsed_cmd[0].cmd`, else the argv (the core unwraps the `-lc` script). `cwd`, `aggregated_output`, `stdout`, `stderr` and `formatted_output` are never read | `declined` -> `denied` (`Command declined`); a non-zero `exit_code` -> `failed` (`Exit code <n>`); `failed` -> `failed` (`Command failed`); else ok |
| `FileChange` | `apply_patch`, `kind: 'edit'`, `paths` = the keys of `changes` (basenames; `content`, `unified_diff` and `move_path` are never read) | `failed` -> `failed` (`Patch failed`); `declined` -> `denied` (`Patch declined`); else ok |
| `McpToolCall` | `mcp__<server>__<tool>` from `server` / `tool` (arguments, results and `error` are never read) | `failed` -> `failed` (`MCP tool error`); `declined` -> `denied` (`MCP call declined`); else ok |
| `WebSearch` | `web_search`, `kind: 'web'`, the host of `action.url`, else `query` / `action.query` | `failed` -> `failed` (`Search failed`); `declined` -> `denied` (`Search declined`); else ok |
| `ImageView` | `view_image`, `kind: 'read'`, `path` | ok |

  The page's catch-up rule (the same room shows `외 N건`) absorbs a burst of visits.
- `tools.update_plan(...)` calls inside a script are not shown (D10c): reading their argument would mean parsing
  model-written JavaScript.
- The `exec` output closes the outer tool from the start of its first line only (an `exec` output carries no exit
  code): `Script failed` / `Script error` -> `failed`; `aborted by user` -> `interrupted`; `rejected by user`, `exec
  rejected`, `approval required by policy`, `sandbox denied` -> `denied`; anything else -> ok. The error lines are fixed
  text (`Script failed`, `Script error`, `Aborted by user`, `Rejected by user`, `Approval required by policy`, `Sandbox
  denied`).

Floors (D1):
- An ordinary cwd goes through the shared `projectKey` (4.4), so a Codex session and a Claude or Grok session in the
  same folder share a floor. A project-local worktree (`<repo>/.worktrees/<name>`, `<repo>/.claude/worktrees/<name>`;
  218 cwds in the study) joins its repository's floor with a worktree badge, as for Claude.
- A Codex-managed worktree, cwd `<root>/worktrees/<id>/<name>[/...]` with `<root>` the Codex root (152 cwds in the
  study; the path does not name the repository, `<id>` is opaque): the session joins an existing floor whose
  `projectLabel` equals `<name>`. Candidates are the floors of live (not ended) main sessions of any adapter, announced
  or still attaching, except other tool-worktree floors. When none matches it gets its own floor keyed by
  `<root>/worktrees/<id>/<name>` (label `<name>`). `worktree` is `<name>` in every case (a heuristic, so the HUD shows
  the badge). The floor is chosen once, the first time the Store sees that project, and does not move afterwards (4.4).
- Mechanism and startup order as for Grok (4.6): the descriptor's `worktreeFloor(project, root)` returns
  `{ key, names: [name], badge: name }` or null, the Runner registers it with `store.setFloorRule('codex', fn)`, and at
  the group's first rescan the Codex Runner waits for the Runners without a floor rule (Claude), at most
  `FIRST_PASS_WAIT_MS` (10 s). The Grok and Codex Runners both have a rule and do not wait for each other, so at
  startup a Codex worktree whose only match is a Grok floor (or the reverse) can depend on which attaches first.
  Within one Codex rescan a worktree main is attached after the plain mains (the scan order above), so it joins a
  plain Codex main of the same scan whatever their uuids.
- Subs take the floor of their root main (`sid`), as patched.

Descriptor and session end:
- `src/adapters/codex/index.mjs`: `id: 'codex'`, `defaultRoot: '~/.codex'`, `worktreeFloor` (Floors above) and
  `deps()`: the Runner bundle `{ agent: 'codex', SessionState: CodexSession, Tailer, scan: a fresh
  createCodexScanner(), sidecarWatcher: a fresh CodexTitles, worktreeFloor }`, one scanner (with its date-folder and
  line-0 caches) and one title reader (with its offset) per Runner. No `readSubMeta` / `readJournalLabels` (Claude-only),
  no `sidecars(ref)` hook and no replay support (D12). `CodexSession` takes the Runner's constructor options (`id`,
  `kind`, `parentId`, `agentType`, `now`; the Claude-only ones are ignored) and wraps `SessionCore`.
- A main never idles out by itself (4.0.2); it ends when its file leaves the active window (section 6). A sub ends at
  its parent's `SubAgentActivity` (above) or by the core's idle rule (R29, `SUB_IDLE_MS`). The writer lock files, the
  SQLite thread catalog and its spawn edges are not used.

Tests: synthetic fixtures shaped from the research file (`test/fixtures/codex.mjs` record builder,
`test/fixtures/codex-tree.mjs` folder trees and title index), under temp roots only (never the real `~/.codex`,
`~/.grok` or `~/.claude`); tests that spawn the bin set `HOME` to a temp folder, because the bin fills the default
`~/.codex` and `~/.grok` roots. The conformance harness (4.0.2) runs against the Codex adapter. Fixtures cover both
eras (ADAPTERS 9): files before code mode (`exec_command`, `shell`, `shell_command`, `apply_patch`, `update_plan`, MCP
names, `response_item` text) and code-mode files (`exec` with inner items, `item_completed` text).
`test/codex-discover.test.mjs` covers the allowlist (bait files such as `.zst`, `history.jsonl`, auth files, SQLite
files and `archived_sessions/` are never opened, checked with an fs spy on a real server), the line-0 cap and cache,
guardian hiding, `/review` threads, parent chains across date folders, continuation pieces, the hot and cold date
folders, symlinked `sessions/`, year, month and day folders in the full and the hot walk, and the scan order (worktree
mains after plain mains); `test/codex-titles.test.mjs` the incremental title index; `test/codex-records.test.mjs`,
`test/codex-session.test.mjs` and `test/codex-exec.test.mjs` every mapping row above (text source by version, the
inherited prefix with its reset, fallback and live drop, ordinal dedupe, the IDE request marker, failure, denial,
interrupt and background rules, plumbing, code-mode visits, regex literals and template expressions in scripts,
`update_plan` inside scripts, replay state equal to live state); `test/codex-session-attach.test.mjs` what the attach
replay decides (the `SubAgentActivity` lifecycle, the 0.154+ wait instead of the fallback, the dedupe cost past 65,536
ordinals); `test/codex-mixed.test.mjs` a re-tasked child on attach (real descriptor); `test/codex-floor.test.mjs` the D1 worktree floors, the startup order (also within one Codex scan) and the
bin's `office-sim: agents claude-code,codex,grok` line. The only real-data use is a read-only check against `~/.codex` that prints counts only
(events, unpaired tools, apply errors, privacy hits).

### 4.8 Antigravity adapter (P5e)
The Antigravity adapter reads the step transcripts of Google Antigravity's CLI (`agy`) and of the legacy Antigravity
IDE. Scope (D6): those two only. The Antigravity desktop app (Antigravity.app 2.x, data root `<root>/antigravity/`) is
out of scope: its conversations (`conversations/<uuid>.pb`) look encrypted (a distinct prefix per file, entropy 8.0
bits/byte, no protobuf parse from offset 0) and are rewritten whole, and its brain folders hold no logs, so it has no
tool events; nothing under `<root>/antigravity/` is listed, `stat`ed or opened, not even its task lists or its summary
file. Format facts come from the structure-only study `docs/research/antigravity-format.json` (34 CLI transcripts and 2
legacy IDE transcripts, about 16,800 lines, CLI language servers 1.3.5-1.4.2); the design is ADAPTERS 5.3, 6.1 and 6.2,
and where this section differs from those proposals, this section wins. Agent id `antigravity`, default root `~/.gemini`
(`--antigravity-root`, section 6). Code: `src/adapters/antigravity/`: `discover.mjs` (allowlist discovery, transcript
file preference), `meta.mjs` (`AntigravityMeta`, the metadata watcher, and the summary, annotation and `task.md`
parsers), `proto.mjs` (the protobuf wire-format reader), `records.mjs` (one step -> item pieces, pure), `tools.mjs` (the
tool name table -> descriptors, pure), `session.mjs` (`AntigravitySession`: line positions, position pairing and the cwd
fallback around SessionCore, the SessionLike API) and the descriptor `index.mjs`, registered in `src/adapters/index.mjs`;
every file stays under 500 lines. Every cap, scrub, pairing, turn and plan rule of 4.0.2 applies. Claude, Grok and
Codex behaviour does not change (4.1-4.7 and section 5 keep their rules).

Discovery (allowlist, ADAPTERS 7.1; `discover.mjs`):
- `<root>` (`~/.gemini`) is shared with the Gemini CLI and holds credentials and raw input history, so `<root>` itself
  is never listed; only two app folders under it are entered: `<root>/antigravity-cli/` (the CLI) and
  `<root>/antigravity-ide/` (the legacy IDE). In each, the only transcript paths accepted are
  `<app>/brain/<uuid>/.system_generated/logs/transcript_full.jsonl` and
  `<app>/brain/<uuid>/.system_generated/logs/transcript.jsonl`, with `<uuid>` the conversation id (a UUID folder name; it
  equals the summary key and the `conversations/<uuid>.db` stem, 37/37). When the same uuid exists in both app folders,
  the copy with the newer transcript mtime wins, then the larger transcripts, then `antigravity-cli`.
- File preference (one file per conversation): `transcript_full.jsonl` holds every step with untruncated values and
  native JSON arguments, and is preferred. `transcript.jsonl` holds the same steps with long `content`, `thinking` and
  `tool_calls` cut (listed in `truncated_fields`) and every argument JSON-encoded as a string; it is used when the full
  file is missing or holds fewer lines (one conversation's full file started at step 220: 44 lines against 118). The
  comparison counts lines (newlines), never bytes. The counts are kept per path and extended by the bytes appended since
  the last scan (from 0 again after an inode change or a shrink; opened with `O_NOFOLLOW`, read only when the opened file
  is the `lstat`ed regular file), at most 64 MB of counting per rescan (`SCAN_LIMITS.countBytes`; the rest is counted at
  the next rescans, and meanwhile a conversation keeps its previous file, else the full one). The two files are appended
  one after the other, so they can differ by a few lines for a moment: a conversation that reads the full file moves to
  `transcript.jsonl` only when that one has more than 16 lines more (`FULL_SLACK_LINES`), and any conversation reads the
  full file again once it has at least as many lines.
- The preferred file can change while a conversation runs (the full file appears late, or falls behind or catches up).
  Then the Runner moves the character to the other file as it does for a Codex continuation piece (4.7): the old path is
  detached without a `session_end`, the new file is attached and replayed from byte 0, the state is rebuilt from that
  file alone, and the character keeps its id. Tool ids carry the line position (Records below), and the positions differ
  between the two files (`transcript.jsonl` arguments are JSON-encoded), so a call still open at the switch gets a new
  id: the Store closes the old id with `tool_end` `abandoned` right after the re-announce (section 6, relocation), and
  the new id stays open until its result line.
- Read, and nothing else: `lstat` of `<app>`, `brain/`, each conversation's `.system_generated/` and `logs/` (each must be
  a real folder) and of the two transcript names (regular files only), the listing of `brain/` (UUID-named real
  directories only), the line counts above, an attached transcript through the Tailer (3.6) with `noFollow` (opened with
  `O_NOFOLLOW` and attached only when it is the regular file the scan `lstat`ed, its `ino`: a link or another file
  planted between the scan and the attach is not read), and the metadata files below. Never opened, listed or `stat`ed: `<root>/antigravity/` (the desktop app, D6), `conversations/` (`*.db` with
  `-wal` / `-shm`, `*.pb`), `conversation_summaries.db`, `implicit/`, the brain folders' `.system_generated/messages/`
  (`*.json`, `read.json`), `steps/*/output.txt`, `tasks/*.log` and `logs/chunks/`, the brain artifacts other than
  `task.md` (`walkthrough.md`, `implementation_plan.md`, `*.metadata.json`, `*.resolved*`, `scratch/`, `.git/`),
  `history.jsonl` and every `history` folder or file (raw input; they also hold workspace keys and are still never
  read), `cache/`, `log/`, `daemon/`, `presence/`, `browser_recordings/`, and the files of `<root>` itself:
  `oauth_creds.json`, `google_accounts.json`, `settings*.json`, `state.json`, `trustedFolders.json`, `projects.json`,
  `sandbox/`, `tmp/`, `config/`.
- Symlinks are never followed: a linked app folder, `.system_generated/` or `logs/` counts as missing, a linked `brain/`
  is an empty list, a linked conversation folder or transcript is no entry, and a linked `annotations/` folder counts as
  missing (Metadata files below). ENOENT, ENOTDIR, EACCES, EPERM, ELOOP and
  ENAMETOOLONG on a folder or a file skip that entry; a missing app folder or `brain/` is an empty list. A `brain/` that
  exists but is not a folder or cannot be listed, or more than 50,000 conversation folders in one walk
  (`SCAN_LIMITS.conversations`; the walk throws `SCAN_CAPPED` instead of returning a cut list), fails the scan, and the
  Runner skips that rescan as for Grok and Codex (section 6, `scan failed`).
- Active window (as 3.5 and section 6): a conversation is returned when the newer mtime of its two transcripts is inside
  `--active`. Refs are returned in uuid order.
- The root check of D3 (section 6) opens `<root>` itself, and `~/.gemini` exists for anyone who uses the Gemini CLI, so
  the adapter can be on without any Antigravity install; its scan then finds no app folder and returns an empty list.

Ids (D2, 4.0.1 F2):
- Every conversation is a main: no structural subagent link exists in these files (summary db `parent_conversation_id`
  null and `nesting_depth` 0 in 166/166 rows, `has_subtrajectory` 0 in every step). `kind: 'main'`, `charId` = `sid` =
  `stem` = `antigravity-<uuid>`, `sessionId` = the uuid, `agent: 'antigravity'`; every ref passes the F2 guard. A ref
  also carries `facts: { full, base }` (which file and which app folder), which the Runner passes to the session
  constructor: `full` tells the session how argument values are written (Tools below).
  `manage_subagents` and `browser_subagent` calls are the conversation's own tools (Tools below).

Metadata files (`AntigravityMeta`, `meta.mjs`):
- Three small files describe a conversation, all in its own app folder: the summaries file
  (`antigravity-cli/jetbox_summaries_proto.pb` for a CLI conversation, `antigravity-ide/agyhub_summaries_proto.pb` for a
  legacy IDE conversation, read when present), `<app>/annotations/<uuid>.pbtxt` and `<app>/brain/<uuid>/task.md`.
- The summaries file lists every conversation of its app folder and is replaced whole on change (inode changed twice in
  240 s), so it is not a per-session sidecar: the descriptor has no `sidecars(ref)` hook and hands the Runner an
  `AntigravityMeta` as `deps.sidecarWatcher` (`check(ref)` / `forget(path)`, the slot the Codex titles use, 4.7). The
  Runner calls `check` when a transcript is attached (after its replay, before the character is announced) and at each
  rescan for every attached session, and passes what it returns to the session's `setInfo`; for a character the Store
  has already ended only the state changes. `AntigravityMeta` is built on two `SidecarWatcher`s (4.6), so every file is
  `lstat`ed, opened with `O_NOFOLLOW`, read only when it is the `lstat`ed regular file and only after its inode, size or
  mtime changed: the summaries file once per file, not once per conversation, and parsed once per change (at most
  8 MB, `SUMMARY_MAX_BYTES`), the annotation and `task.md` per conversation (at most 256 KB each,
  `META_FILE_MAX_BYTES`). The `lstat` of a file does not cover its folders, so every check also `lstat`s them: nothing
  is read when `<app>` is not a real folder, the annotation only when `<app>/annotations/` is a real folder, and
  `task.md` only when `<app>/brain/` and `brain/<uuid>/` are; a linked folder counts as missing, so no file outside
  `<app>/` (or under the desktop root `antigravity/`) is opened. A file that fails to parse is ignored until it changes.
  It never throws.
- `check` returns only the fields whose value changed since the last delivery to that transcript: `{ title?, cwd?,
  branch?, status?, tasks? }`. Values never go back to empty: a file that disappears or no longer names the conversation
  leaves what was delivered. `forget(path)` drops a transcript's state when it is detached or moves.
- The study found `agyhub_summaries_proto.pb` only under the desktop app root `antigravity/`, which is never read (D6),
  and no summaries file under `antigravity-ide/`; a legacy IDE conversation therefore usually has no summary entry, and
  its title and cwd come from the fallbacks below.

Summary protobuf (`proto.mjs`, `parseSummaries` in `meta.mjs`):
- `proto.mjs` reads the protobuf wire format without a schema: varint (at most 10 bytes), 64-bit, length-delimited and
  32-bit fields; a group or an unknown wire type stops the read. It reads one message flat and returns views into the
  input (never a copy, never past the end); nested messages are decoded only along the fixed paths below, never by
  guessing that a byte string looks like a message. It is bounded (`PROTO_LIMITS`: input 16 MB, 100,000 fields per
  message, path depth 16) and never throws: a cut-off or malformed field ends the read of that message and the fields
  before it stay. Text values must be strict UTF-8 without control characters other than tab and line breaks.
- Field numbers are **inferred**, not published: they come from cross-checks of the study against the summary SQLite
  columns and the repositories' git state (no schema exists; `unverified` in the research file). Of the entry whose key
  is the conversation's uuid (keys that are not UUIDs are skipped; for a repeated key the last entry wins) only these
  paths are kept:

| path (inferred) | kept as | cross-check in the study |
|---|---|---|
| `1` (repeated) | one entry per conversation | 35-37 CLI entries, 64 IDE entries |
| `1.1` | the entry key, the conversation uuid | equals the brain folder name |
| `1.2.1` | `title` (a generated title, <= 1,000 chars) | equals the db preview in 61/64 and 32/35; equals the first prompt in 0/30 |
| `1.2.5` | `status`: varint 1 = `idle`, 2 = `running` (other values are not used) | 1 with db IDLE (98), 2 with db RUNNING (1) |
| `1.2.9.1` | `cwd`: the workspace `file://` URI as an absolute path (`fileURLToPath`: percent-decoded, `file://localhost/x` = `file:///x`, no trailing `/`; another host or scheme, an encoded `/`, a NUL or a relative result is dropped) | equals the db `workspace_uris[0]` in 48/48 and 34/34 |
| `1.2.9.4` | `branch` (one line, <= 256 chars) | the repository's current branch in 35/41 and 26/29 checkable cases, never a sha |

- Nothing else of an entry is kept: the step count (`1.2.2`), times (`1.2.7`, `1.2.10`), the git root (`1.2.9.2`), the
  owner/repo and remote URL (`1.2.9.3`, never shown), the project id (`1.2.17.18`) and the unidentified fields (`1.2.3`,
  `1.2.15`, `1.2.16`, `1.2.17`, `1.2.22`, `1.2.28`).

Titles, cwd, branch, status:
- Title: the annotation `title`, else the summary `1.2.1`, else the first prompt (the inner `USER_REQUEST`, <= 40,
  4.0.2), else 8 chars of the id after `antigravity-`. Section 5 scrub, <= 80. The annotation is protobuf text format:
  only a top-level `title` key whose value is one or more adjacent quoted strings is read (C-style escapes, strict
  UTF-8); every other key (IDE annotations hold only `last_user_view_time`), nested block and comment is skipped.
- Cwd: the summary workspace. When no workspace is known, the first absolute `Cwd` argument of a `run_command` call is
  the cwd (it is read for this only and never shown). During the attach replay that `Cwd` is only remembered; when the
  replay ends (the first `idle()`, which comes after the Runner's first metadata check, or the first live line) it is
  applied if the metadata gave no workspace by then, so a conversation that has a summary entry gets the workspace as
  its first cwd. After the replay the first such `Cwd` is applied at once while no cwd is known. The first cwd fixes the
  floor (4.4): a new conversation whose summary entry appears only after a `run_command` gave its `Cwd` keeps the floor
  of that `Cwd`, which can be a subfolder of the workspace. `history.jsonl` also maps conversations to workspaces and is
  never read.
- Branch: the summary `1.2.9.4` (`HEAD` -> `detached`, section 5 scrub, <= 60); none when the workspace is not a git
  repository (absent in 6/35 CLI entries).
- Status: a delivered `status` of `idle` ends the open turn at once (`turn_end` reason `end_turn`, instead of waiting for
  the quiet time below) when that turn's last work was a closing answer (a final `say`) and no call waits for its
  result. The summaries file is read at rescan and the transcript at poll, so `idle` can arrive before the closing
  answer is read: it is then remembered, and the next closing answer ends the turn at once (after its `say`); a
  `USER_INPUT`, a `PLANNER_RESPONSE` with calls (or with `tool_calls` that cannot be read) or a delivered `running`
  forgets it. `running` changes nothing else. Status never ends a session: a main ends when its file leaves the active
  window.

Plan (`task.md`, D5):
- A checklist line, at any indent and with a `-`, `*`, `+` or numbered (`1.`, `1)`) bullet, gives an item
  `{ content, status }`: `[ ]` pending, `[/]` in_progress, `[x]` / `[X]` completed. Headings, plain bullets, other markers
  and fenced code blocks give nothing; HTML comments, link targets and backticks are dropped from the content (the core
  scrubs and caps the rest, 80 code points). Each raw line is cut at 1,000 chars, and at most 1,000 items are kept. A
  file without a checklist item gives no list (the board stays as it was).
- The list reaches the session as `setInfo({ tasks })`, and `AntigravitySession` turns it into a
  `plan { items, source: 'tasks' }` item through the core (`SessionCore.setInfo` takes no plan), so the board shows the
  whole list with source `tasks` and an identical snapshot emits nothing (4.0.2). An empty list only clears a board that
  `task.md` filled. Before the attach replay has ended this builds state only (no events). The file is never sent as
  markdown.
  The study found no `task.md` in any CLI brain folder (and no checkbox in any CLI artifact), so in practice only legacy
  IDE conversations fill the board; `manage_task` is background-job control, not a plan.

Records (`records.mjs` and `tools.mjs` pure, `AntigravitySession` with the state):
- One line is one step: `{ step_index, type, source, status, created_at, content?, thinking?, tool_calls?, error?,
  exit_code?, ... }`. There is no message id, turn id, tool-call id or cwd in a record. A record without a string `type`
  (`[A-Za-z0-9_]{1,64}`) is counted and skipped. `created_at` (ISO, the step's start) is the item `ts`; file order wins
  (R12: a line is written when its step completes, so `created_at` is not monotonic with write order). `step_index` is
  never used: it repeats (43 indexes appear twice, each time as a different step) and steps backwards around
  compaction.
- Positions: a line is known by its position in the file, counted by the session over the lines it receives: each
  line's UTF-8 bytes plus its newline, from 0 at every attach (the attach replay starts at byte 0, and a re-attach or a
  file switch builds a fresh session that counts from 0 again). The count uses the raw line when the caller passes it
  (`apply(rec, { line })`); the Runner passes parsed records, so it is the byte length of the re-serialized record plus
  one, a pseudo offset that is the same for the same lines whether replayed or read live, not the file offset (blank
  and unparseable lines, which the Runner drops, are not counted). The position is the middle part of the line's tool
  ids, never `step_index`. A caller that knows the real offset passes `{ offset }`, and a line that starts before the
  position already reached is then a repeat and is skipped (the position is the dedupe key; the core's R9 rule also
  ignores a second `tool_start` for an id that was ever opened).
- Pairing is positional (the JSONL has no call id): the result lines that follow a `PLANNER_RESPONSE` with N calls, in
  file order, are the results of its calls 0..N-1. A result line is a line of any type other than those named in the
  table below (`GENERIC`, `RUN_COMMAND`, `VIEW_FILE`, `CODE_ACTION`, `GREP_SEARCH`, `LIST_DIRECTORY`, `MCP_TOOL`,
  `ASK_QUESTION`, `SEARCH_WEB`, `READ_URL_CONTENT`, `GENERATE_IMAGE`, `BROWSER_SUBAGENT`, `KNOWLEDGE_ARTIFACTS` and
  unknown future types). A `PLANNER_RESPONSE`, `USER_INPUT` or `ERROR_MESSAGE` line that arrives while calls are still
  waiting closes each of them first with `tool_end` status `abandoned` (4.0.2; at least 51 of about 8,990 calls in the
  study met a later step before a result). A `CHECKPOINT` (compaction marker) is not a closer: the result line of a
  waiting call can still come after it, and then keeps its real outcome. `SYSTEM_MESSAGE` and `CONVERSATION_HISTORY`
  lines are neither results nor closers. A result line with no waiting call is ignored (counted).
- `tool_calls`: an array is the call list (at most 256 calls per line; every entry keeps its slot, also one that cannot
  be read, which becomes a nameless `tool`). A string (a value cut in `transcript.jsonl`) is tried as a JSON array; when
  it cannot be read the number of calls is unknown: no `tool_start` is shown for that line, its `say` is not `final`
  (the line had calls), and the result lines after it are skipped until the next closer (a `CHECKPOINT` does not stop
  the skipping).

| Antigravity step (`type`) | normalized items (4.0.2) |
|---|---|
| `USER_INPUT` | the waiting calls end `abandoned`; `turn_start` (no id; the core closes a still-open previous turn: its open tools `abandoned`, then `turn_end { reason: 'next_turn' }`), then `prompt { text }` with the trimmed inner text of the first non-empty top-level `<USER_REQUEST>...</USER_REQUEST>` block only (a block cut by the truncation, without its closing tag, ends at the next tag). The opening tags are walked from the start and every other block (`ADDITIONAL_METADATA` environment context, `USER_SETTINGS_CHANGE`, `PLAN`) is jumped over to its own closing tag, so a `<USER_REQUEST>` written inside another block (a selection or a file excerpt in the environment context) is never read, as prompt or as title; another block that never closes holds the rest of the content (no prompt). A content without a top-level `USER_REQUEST` block, or with only empty ones (the legacy IDE template), gives no prompt (the turn still starts). The raw content always starts with `<` (201/201), so the block is taken out before the core's `<` skip of 4.0.2, which then applies to the extracted text |
| `PLANNER_RESPONSE` | the waiting calls of an earlier planner line end `abandoned`; then `thinking { text, durationMs: null }` when `thinking` is non-empty (there is no duration field); `say { text, final }` when `content` is non-empty, with `final: true` when the line has no `tool_calls` (the turn's closing answer: it arms the core's 20 s `end_turn` fallback); then one `tool_start` per `tool_calls[i]` (Tools below) with the id `<conversation uuid>:<position>:<i>`, and those calls wait for their results. A line with neither text nor calls only closes |
| a result line (above) while calls wait | `tool_end` for the oldest waiting call (End status below) |
| `CHECKPOINT` | `system { kind: 'compact' }` (`content`, a long template, is never read; the core's fallback text `Conversation compacted`). Not a closer: the waiting calls keep waiting, and a result line after it is still their result. The turn goes on |
| `ERROR_MESSAGE` | the waiting calls end `abandoned`; `system { kind: 'api_error' }` from the first line of `error`, else of `content` (the core reduces it: `sanitizeLine`, `cleanText`, <= 120; fallback `API error`). The turn is not ended: the agent retries (10 of 11 were followed by another `PLANNER_RESPONSE`) |
| `SYSTEM_MESSAGE`, `CONVERSATION_HISTORY` | ignored (boilerplate system text, always-empty history marker); they do not touch the pairing |

- Turns: a turn starts at `USER_INPUT`. There is no turn-end record: a `PLANNER_RESPONSE` with text and no calls is
  the closing answer (`say` `final`), and 20 s of quiet after it end the turn `end_turn` (`END_TURN_IDLE_MS`, 4.0.2), or
  earlier a summary `status` of `idle` (above); a `USER_INPUT` that comes first ends it `next_turn`. Calls still open
  when a turn ends are `abandoned` (core, R27).
- Timing: a step's line is written when the step completes, so nothing appears while the model generates: a planner
  line lands 6-35 s after its start, a result line 0.25-2 s after its planner line. `tool_start` shows when the planner
  line lands and `tool_end` when the result line lands.
- A truncated last line (no newline yet) is kept by the Tailer for the next poll (3.6); a line over 8 MB is skipped and
  counted, and a call whose result line was skipped stays waiting until a closer above ends it `abandoned` (or a later
  result line takes its slot).

Tools (`tools.mjs`):
- Name: `tool_calls[i].name` (`[A-Za-z0-9_.:-]{1,128}`, else `tool`). The descriptor (4.0.2) is built from the argument
  fields in the table only. In `transcript_full.jsonl` arguments are native JSON values (a string is taken as is); in
  `transcript.jsonl` every argument value is a JSON-encoded string, and each allowed field is decoded on its own
  (`JSON.parse` of that one value); a value that does not decode to a string (cut by the truncation) is dropped, and the
  summary falls back to the tool name. The session knows the format from the ref's `facts.full`; without it a value
  that starts with `"` is decoded and any other string is taken as is. Never read: `toolAction` and `toolSummary` (model-written labels on almost every call,
  8,874/8,993, that can carry command text), `CodeContent`, `Content`, `TargetContent`, `ReplacementContent`,
  `ReplacementChunks`, `Target`, `Replacement`, `Instruction`, `Description`, `ArtifactMetadata`, `Arguments`, `Prompt`, `TimerCondition`,
  `DurationSeconds`, `Task`, `TaskName`, `TaskSummary`, `RecordingName`, `MediaPaths`, `CommandId`, `TaskId`, `Action`,
  `domain`, `is_multi_select` and every other argument; `Cwd` only for the cwd fallback above. Old and new names are
  both mapped (the 1.4.x CLI emits `read_file` / `write_file` where older versions emit `view_file` / `write_to_file`,
  and adds `edit_file` with `Path`, `Target` and `Replacement`: found by the integration's real-data count, not in the
  research file).
  Rooms are the ADAPTERS 6.2 Antigravity column, through the core's hints (D4):

| tool (`name`) | descriptor | room |
|---|---|---|
| `view_file` (older), `read_file` (1.4.x) | `kind: 'read'`, `path: AbsolutePath` (`read_file`: `Path`, else `AbsolutePath`) | archive |
| `list_dir` | `kind: 'read'`, `path: DirectoryPath` | archive |
| `grep_search` | `kind: 'search'`, `query: Query`, `path: SearchPath` | archive |
| `find_by_name` | `kind: 'search'`, `query: Pattern`, `path: SearchDirectory` | archive |
| `write_to_file` (older), `write_file` (1.4.x) | `kind: 'edit'`, `path: TargetFile` (`write_file`: `Path`, else `TargetFile`) | dev |
| `edit_file` (1.4.x) | `kind: 'edit'`, `path: Path`, else `TargetFile` (`Target` and `Replacement`, the old and new text, are never read) | dev |
| `replace_file_content`, `multi_replace_file_content` | `kind: 'edit'`, `path: TargetFile` | dev |
| `run_command` | `kind: 'shell'`, `command: CommandLine` (a string; the summary is its program name via `programOf`, 3.1) | program rule of 3.1 (archive / research / server) |
| `command_status`, `manage_task` | `kind: 'shell'` without a command (background command and task control; ids and actions are not read) | server |
| `search_web` | `kind: 'web'`, `query` | research |
| `read_url_content` | `kind: 'web'`, `url: Url` (host only) | research |
| `call_mcp_tool` | `kind: 'web'`, `mcpServer: ServerName`, `mcpTool: ToolName`, so `tool` is `mcp__<server>__<tool>` (a uuid-looking server -> ZERO_UUID, section 5); `Arguments` is never read. Without both names: a plain web call | MCP names: none, the page classifies them (D4); without names: research |
| `ask_question` | `kind: 'ask'`, `questions` (at most 50; the `question` and at most 4 `options` each, an option being a string or a `label`) -> `question` / `options` (R33, `askFields`); its result line ends it | desk |
| `manage_subagents`, `browser_subagent` | `kind: 'agent'`, no argument read | here |
| `generate_image` | `kind: 'other'`, no argument read | here |
| `schedule` | `kind: 'other'`, no argument read; `AntigravitySession` puts the `lounge` room hint on its `tool_start` (as Codex `clock.sleep`, 4.7; the core has no lounge kind) | lounge |
| `list_permissions` | hidden plumbing: no `tool_start` and no `tool_end`, but the call keeps its place in the pairing, so its result line is taken and gives nothing | - |
| any other name (new tools) | `kind: 'other'`, no argument read, `tool` = the name | here |

- End status (the result line). Error lines come only from structured fields; result bodies (`content` of a result
  step, `steps/*/output.txt`) never reach an event:
  - `status` `ERROR`, a non-empty `error`, or an integer `exit_code` (a number or a numeric string) other than 0 ->
    `failed`. The error line is `Exit code <n>` for a non-zero exit code, else the first line of `error` (the core
    reduces it: `sanitizeLine`, `cleanText`, <= 120).
  - `status` `RUNNING` -> ok with `background` (R28): the command or timer went to the background, and the line is never
    rewritten. Its later completion notice (`messages/<uuid>.json`) is never opened, so the call simply ends here.
  - `DONE` or no status (with `exit_code` 0 or absent) -> ok; `INVALID` and any unknown status -> `failed` without an
    error line (the core's fallback `failed`).
  - `denied` and `interrupted` are never produced: the study found no structural marker for a user denial or a user
    interrupt (permission decisions live only in the SQLite store, all granted).

Floors (D1):
- An ordinary workspace goes through the shared `projectKey` (4.4), so an Antigravity conversation and a Claude, Grok
  or Codex session in the same folder share a floor; a project-local worktree (`.worktrees/<name>`,
  `.claude/worktrees/<name>`) joins its repository's floor with a worktree badge, as for Claude. No Antigravity-managed
  worktree exists in the study, so the descriptor has no `worktreeFloor` rule. The Antigravity Runner is therefore one
  of the Runners without a floor rule: at the group's first rescan the Grok and Codex Runners also wait for its first
  attach pass (4.6 startup order, at most `FIRST_PASS_WAIT_MS`), and it never waits itself.

Descriptor and session end:
- `src/adapters/antigravity/index.mjs`: `id: 'antigravity'`, `defaultRoot: '~/.gemini'` and `deps()`: the Runner bundle
  `{ agent: 'antigravity', SessionState: AntigravitySession, Tailer, scan: a fresh createAntigravityScanner(),
  sidecarWatcher: a fresh AntigravityMeta }`, one scanner (with its line counts and file choices) and one metadata
  watcher (with its file signatures and parsed summaries) per Runner. No `sidecars(ref)` hook, no `readSubMeta` /
  `readJournalLabels` (Claude-only), no `worktreeFloor` and no replay support (D12). `AntigravitySession` takes the
  Runner's constructor options (`id`, `kind`, `parentId`, `agentType`, `now`, and `facts` for the argument format; the
  Claude-only ones are ignored) and wraps `SessionCore`.
- A main never idles out by itself (4.0.2); it ends when its file leaves the active window (section 6).

Tests (the P5e end condition, ADAPTERS 9): synthetic fixtures shaped from the research file (`test/fixtures/antigravity.mjs`
record builder, `test/fixtures/antigravity-tree.mjs` folder trees with both app folders), under temp roots only (never
the real `~/.gemini`, `~/.codex`, `~/.grok` or `~/.claude`); tests that spawn the bin set `HOME` to a temp folder,
because the bin fills the default `~/.gemini` root. Unit tests per module (`test/antigravity-discover.test.mjs`,
`antigravity-meta`, `antigravity-proto`, `antigravity-records`, `antigravity-session`), the review fixes
(`antigravity-fixes`: checkpoint pairing, top-level `USER_REQUEST`, early idle; `antigravity-symlinks`: linked metadata
folders and the `noFollow` Tailer; `antigravity-switch`: open tools across a file switch; `antigravity-docs`: this
section against the name table); the conformance harness (4.0.2)
must run against the Antigravity adapter too. Fixtures must cover both tool vocabularies (`view_file` / `write_to_file` with
`toolAction` / `toolSummary` bait, and `read_file` / `write_file`), both transcript forms (native and JSON-string
arguments), the file preference and its switch, the allowlist (bait files such as `history.jsonl`, `oauth_creds.json`,
`conversations/*.db`, `messages/*.json` and a desktop-app `antigravity/` folder are never opened, checked with an fs
spy), the proto reader (malformed and oversized input, depth bounds, no throw), the metadata files (annotation, summary
entry, `task.md` statuses, re-read only on change), every mapping row above (USER_REQUEST extraction, positional
pairing, abandoned closes, `list_permissions`, `RUNNING` results, exit codes, quiet-time turn ends), a truncated last
line, and a mixed start with Claude, Codex, Grok and Antigravity on one floor and the bin's `office-sim: agents
claude-code,codex,grok,antigravity` line. The only real-data use is a read-only check against `~/.gemini` that prints
counts only (events, unpaired tools, apply errors, privacy hits).

## 5. Privacy and rooms
- Never put these into any event: Bash/Monitor `command`, terminal `command`/`cwd`, Write `content`, Edit
  `old_string`/`new_string`, Agent `prompt`, Workflow `script`/`args`, SendMessage `message`/`content`, ExitPlanMode raw
  `plan` (only `planFromMarkdown` headings), StructuredOutput fields, SubagentHandback `message`, WebFetch `prompt`,
  `*javascript_tool.text`, browser typed text, form values, firestore documents/filters, emails, PR urls,
  `__unparsedToolInput.raw`, tool_result content (except the short `error` first line), full file paths (basename only),
  full URLs (host only).
- Codex (4.7) adds to that list: `exec` scripts (only the first `tools.<name>` identifier is read), `cmd` / `command`
  strings and argv beyond the program name, `apply_patch` bodies, call arguments outside the descriptor table
  (`justification`, `message`, ...), tool outputs (only exit codes and fixed phrases), `CommandExecution` output and
  `cwd`, `FileChange` contents and diffs, `role: user` / `developer` messages, the IDE / desktop context sections in
  front of a `## My request:` marker (active file, open tabs, mentioned files), `agent_message` task text, encrypted
  reasoning, and every `session_meta` field other than the ones 4.7 names (account and user ids above all).
  `history.jsonl` and the SQLite stores are never opened.
- Antigravity (4.8) adds to that list: the `toolAction` / `toolSummary` labels, `run_command` `CommandLine` beyond the
  program name and its `Cwd` (a cwd fallback only), file contents and replacement chunks (`CodeContent`, `Content`,
  `TargetContent`, `ReplacementContent`, `ReplacementChunks`, `Instruction`, `Description`), `call_mcp_tool`
  `Arguments`, the prompts of `schedule`, `generate_image` and `browser_subagent`, result step bodies and
  `steps/*/output.txt`, the `USER_INPUT` blocks other than `USER_REQUEST` (`ADDITIONAL_METADATA`,
  `USER_SETTINGS_CHANGE`, `PLAN`), `SYSTEM_MESSAGE`, `CHECKPOINT` and `CONVERSATION_HISTORY` content, and every summary
  protobuf field other than the ones 4.8 names (the git remote URL and owner/repo above all). `history.jsonl`, the
  background-message files (`messages/*.json`), the SQLite stores, the encrypted `.pb` conversations, the credential and
  settings files of `~/.gemini` and the whole desktop-app folder `antigravity/` are never opened.
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
- Adapters (P5a, 4.0.1): `--agents <id,id>` is a comma list of adapter ids, each validated against `KNOWN_AGENTS` (an
  unknown id is a usage error, exit 2). It narrows the enabled set (D3); without it every implemented adapter whose root
  exists is on. `--codex-root <dir>`, `--grok-root <dir>` and `--antigravity-root <dir>` are accepted, `~`-expanded and
  stored in the `start()` option `roots`. `--grok-root` is live since P5c: it is the Grok root (default `~/.grok`, 4.6).
  `--codex-root` is live since P5d: it is the Codex root (default `~/.codex`, 4.7). `--antigravity-root` is live since
  P5e: it is the Antigravity root (default `~/.gemini`; the adapter enters only its `antigravity-cli/` and
  `antigravity-ide/` folders, 4.8). The bin fills the
  root of every implemented non-Claude adapter that has no flag with the descriptor's default
  (`roots: { ...defaultRoots(), ...flags }`); `start()` itself never falls back to a default root, so a `start()` call
  without `roots.grok` (every test that does not pass one) never checks or reads `~/.grok`, one without
  `roots.codex` never checks or reads `~/.codex`, and one without `roots.antigravity` never checks or reads `~/.gemini`.
  After the URL line the bin
  prints `office-sim: agents <ids>` (the enabled ids, comma-separated in `KNOWN_AGENTS` order, e.g.
  `office-sim: agents claude-code,codex,grok,antigravity` when all four roots exist) or `office-sim: agents none`, then
  one line `office-sim: <id> is not implemented yet` for each requested id that is known but not implemented (since P5e
  every known id is implemented, so this line no longer appears; the rule stays for a future id).
- RunnerGroup: one Runner per enabled adapter, all sharing one Store and one HTTP layer. It forwards `startLoops`,
  `rescan`, `setInterval` (so `POST /config` reaches every Runner) and `close`, and sums `files.size`, `badLines`,
  `skippedLines` and `applyErrors` over its Runners. Its first `rescan` lets a Runner with a D1 floor rule (Grok,
  Codex) scan only after the first rescans of the Runners without a rule (Claude, Antigravity) are done, or after 10 s at
  most (4.6 Floors, startup order, 4.7 Floors and 4.8 Floors); the result array keeps the Runner order. A missing or unreadable adapter root disables that adapter with
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
  from scratch; a subagent that ended while it moved still gets its `session_end`. When the character was on the open
  pages, the Store keeps the ids of the tools it had open there (`detachFile(path, { moved: true })`, at most 1,000
  characters) and, right after the re-announce (`session` + `snapshotEvents()`), sends `tool_end` `abandoned` (the
  core's shape, 4.0.2) for each of them that is not open in the new snapshot, so the pages hold exactly the server's
  open tools and asks. Ids that come back unchanged and still open (Claude, Codex, Grok) get nothing; a tool that ended
  during the move (its end was read only in the new file's replay) now closes `abandoned` instead of staying open on the
  pages. Antigravity ids carry the line position, which differs between its two transcripts (4.8). A character that is
  ended when announced gets only its `session_end`. Only a move is covered: a file attached again at the same path
  (truncation, or a new inode at that path) is announced as before.
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
  override), `adapters` (registry override), `probe` (replaces the root check) and `probeTimeoutMs`. `roots` gives the
  root of each non-Claude adapter (an adapter without one is not started, see above). With `auth: true`, `url` is
  `http://<host>:<port>/?t=<token>` (what the bin prints) and `token` is set; without it `token` is null and `url` has
  no query.

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

