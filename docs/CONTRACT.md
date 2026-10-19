# claude-office server contract (P1/P2)

The server tails Claude Code session transcripts under `~/.claude/projects`, turns records into UI events,
and streams them to the 3D office page (`public/`) over SSE. This file is the single source of truth for
module boundaries, the event schema and the parsing rules. The format rules come from a corpus study of
5,016 local transcript files (Claude Code 2.1.181 to 2.1.299, entrypoint `claude-desktop`).

## 0. Ground rules

- Node 20 (`node -v` = 20.20), ESM (`.mjs`), **zero npm dependencies**. Tests use `node:test` + `node:assert/strict`.
  Run all tests with `node --test test/`.
- Every source file stays under 500 lines. No `console.log` in `src/` (use the injected `log` callback); `bin/` may print.
- Comments may be Korean or English; identifiers are English.
- **Never read from or write to the real `~/.claude` in tests.** Tests build synthetic fixtures in a temp dir
  (`fs.mkdtemp(os.tmpdir() + '/claude-office-')`). Fixture text must be invented, never copied from real transcripts.
- The server binds `127.0.0.1` only and serves only to the local browser. It still sends **summaries, not content**
  (see section 5). Loopback is not per-user: without `--auth` any local process or other OS user can read `/state`
  and `/events`. `--auth` (section 6) closes that for other OS users and for web pages; it does not protect against
  processes of the same user, which can read the transcripts directly anyway.

## 1. Layout

```
bin/claude-office.mjs   CLI: parse args, start server, print URL
src/cli-args.mjs        argv -> start() options (pure), USAGE text
src/summarize.mjs       tool_use -> { summary, room? } (pure); cleanText, the one section 5 text scrub
src/summarize-shell.mjs Bash/Monitor command -> program name (+ allow-listed subcommand) (pure)
src/plan.mjs            update_plan / task list / ExitPlanMode plan reconstruction (pure)
src/records.mjs         one parsed jsonl record -> normalized items (pure)
src/session.mjs         SessionState: ordered items -> UI events (stateful, per transcript file)
src/session-util.mjs    tool_result status + error line, ask fields, public tool name, project key (pure)
src/session-identity.mjs titles, branch/worktree/agentType labels, the `session` event (pure)
src/session-plan.mjs    PlanBoard: plan/task whiteboard state for one SessionState
src/discover.mjs        find transcript files + read subagent meta / workflow journal labels
src/tailer.mjs          per-file byte-offset tail with partial-line buffer
src/store.mjs           registry of sessions, projects, subagent linking, event ring buffer, snapshot
src/store-link.mjs      Store helpers: file identity, link facts, per-session index, ring lookup (pure)
src/server.mjs          start(): wires Store, Runner and the HTTP layer
src/server-runner.mjs   Runner: poll / rescan / idle loops, attach, relocation, backoff
src/server-http.mjs     http: /, /js/*, /events (SSE), /state, /config, /healthz
src/server-guard.mjs    page CSP, Sec-Fetch-Site check, --auth token and cookie
test/*.test.mjs         unit + integration tests, synthetic fixtures under test/fixtures/ or generated
public/                 the browser app; owned by the browser module (public/js/*), server work does not edit it
```

## 2. Event schema (server -> browser)

Every event is one JSON object `{ type, sessionId, ts, ...fields }`. `ts` is the record timestamp (ISO) when known,
else the server time. `sessionId` is the character id: the main session uuid, or the subagent `agentId`
(`a` + 16 hex) for subagent files.

| type | fields |
|---|---|
| `session` | `project` (stable floor key, see 4.4), `projectLabel` (basename), `title` (<= 80), `branch` (<= 60, `HEAD` -> `detached`), `worktree` (name <= 60, or null), `isSubagent`, `parentSessionId` (null for main), `agentType` (subagent only, <= 60) |
| `session_end` | `reason`: `done` \| `idle` |
| `prompt` | `text` (human prompt, <= 80 code points) |
| `tool_start` | `toolUseId`, `tool` (raw name, except a connector-uuid mcp server segment, see 5), `summary`, `room` (optional hint, see 5), `question`, `options` (ask tools only), `background` (bool, optional) |
| `tool_end` | `toolUseId`, `ok` (bool), `errorKind`: `failed` \| `denied` \| `interrupted` \| `abandoned` (absent when ok), `error` (<= 120 code points, absent when ok) |
| `thinking` | `text` (first sentence <= 100 code points, or `null` when the block is signature-only), `durationMs` (number or null) |
| `say` | `text` (<= 100 code points) |
| `plan` | `items`: `[{ content, status }]` with status `pending` \| `in_progress` \| `completed`, `source`: `update_plan` \| `tasks` \| `exit_plan`. Every `content` is scrubbed (section 5) and capped at 80 code points. `exit_plan` carries at most 6 items (`planFromMarkdown`, each raw line cut at 1000 chars before parsing); `update_plan` and `tasks` carry the whole list (no count cap) |
| `turn_end` | `reason`: `stop_hook` \| `api_error` \| `interrupt` \| `wrap_up` \| `next_turn` \| `end_turn` |
| `system` | `kind`: `api_error` \| `compact` \| `refusal`, `text` |

Wire messages on `/events` (each SSE `data:` line is one JSON object, every message has an `id:` line = seq):
- `{ "type": "snapshot", "events": [ ...events ] }` first message on every connection (or replay, see 6).
- `{ "type": "config", "intervalMs": n, "activeMinutes": n }` after a config change and right after the snapshot.
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
  and `VAR=val` tokens and dropping tokens containing `/` or `=`. Read/Edit/Write/NotebookEdit: basename of
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
                now = Date.now })
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

### 3.5 `src/discover.mjs`
```js
export async function scan(root, { activeMs, nowMs }) // -> FileRef[] for files with mtime >= nowMs - activeMs
// FileRef = { path, kind:'main'|'sub'|'wf', stem, sessionId, agentId, runId, projectDir, mtimeMs, size, ino }
export async function readSubMeta(jsonlPath)        // agent-<id>.meta.json -> object | null (missing is normal)
export async function readJournalLabels(runDir)     // journal.jsonl 'started' -> Map(agentId -> label)
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
  attachFile(ref, sessionState)            // registers; links subagents (4.5)
  ingest(path, events)                     // assigns seq ids, pushes to ring, notifies listeners
  subscribe(fn) / unsubscribe(fn)
  snapshot()                               // { seq, events } built from every live SessionState.snapshotEvents()
  since(seq)                               // events after seq if still in the ring, else null
  rekey(from, ref)                         // same-inode relocation: move the entry, no replay, no re-announce
}
```
Outgoing subagent `session` events are patched by the Store: `parentSessionId` is the linked owner (validated as an
id, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, else the main session), `agentType` is `meta.agentType` through the section 5
scrub capped at 60, `title` per 4.3. `meta.parentAgentId` is used for linking only when it looks like an agent id.

## 4. Parsing rules (from the corpus study; R-numbers are referenced by tests)

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

## 6. Server behaviour (`src/server.mjs`, `bin/claude-office.mjs`)
- CLI flags: `--port 4317 --host 127.0.0.1 --interval 250 --active 30 --rescan 3000 --root ~/.claude/projects`,
  and `--auth` (a switch without a value; `--auth=x` is an error). `--interval` is the tail poll in ms (50..5000),
  `--active` the minutes of mtime window for attaching files, `--host` must be a loopback address.
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
  path and error code. One file failing never skips the other files of the same rescan. Attach and poll log lines carry
  the error code and the file basename; HTTP error log lines carry the request path without its query (no token).
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
  `GET /healthz` -> `{ ok, files, sessions, clients }`. No CORS headers. Order of checks for every request:
  1. Host guard: the `Host` header must be `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`, and an `Origin`
     header, when present, must be `http://` + one of those; else 403 (DNS rebinding and cross-origin guard).
  2. Path guard: `..` or encoded `.` / `/` / `\` in the raw path -> 400.
  3. `--auth` (when on): `GET /?t=<token>` with the right token -> 302 to `/` with
     `Set-Cookie: co_<port>=<token>; HttpOnly; SameSite=Strict; Path=/` and `cache-control: no-store`. Every other
     request, every route (`/`, `/index.html`, `/js/*`, `/events`, `/state`, `/config`, `/healthz`, 404s), needs that
     cookie, else 401 `unauthorized: open the URL printed by claude-office`. The token is 32 random bytes (base64url)
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
- `start(options)` returns `{ url, token, port, store, ready, close(), stats() }` so tests can run it on port 0 against
  a temp root. With `auth: true`, `url` is `http://<host>:<port>/?t=<token>` (what the bin prints) and `token` is set;
  without it `token` is null and `url` has no query.
