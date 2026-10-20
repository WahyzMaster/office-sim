// Synthetic Grok Build updates.jsonl records shaped like the structure-only examples in docs/research/grok-format.json.
// All text, ids, paths and commands are invented; nothing here reads a real ~/.grok. Side-effect free at import
// (node --test runs every file under test/).
//
// Usage:
//   const g = createGrokBuilder({ sessionId: GROK_SESSION });
//   const recs = [g.userMessage({ text: 'hi' }), g.hook({ event: 'user_prompt_submit' }), g.thought('Plan it.'),
//     g.toolCall({ name: 'read_file', input: { target_file: '/w/repo/a.txt' } }), g.toolDone({ output: out.readFile() }),
//     g.message('Done.'), g.turnCompleted()];
//   const jsonl = toJsonl(recs);
// Every builder call advances a fake clock by `stepMs`. The user message of a turn starts a new promptId; the user
// message itself carries none (research: the id first appears on the following hook_execution and model/tool records).
// Every record is { method, params: { sessionId, update: { sessionUpdate, ... }, _meta }, timestamp (unix seconds) }.

export const GROK_SESSION = '0198f0a0-1b2c-7d3e-8f40-0123456789ab'; // UUIDv7 shape
export const GROK_CHILD = '0198f0a0-9e8d-7c6b-8a59-fedcba987654';

const DEFAULT_START = Date.UTC(2026, 9, 20, 9, 0, 0);
const pad = (n, w) => String(n).padStart(w, '0');

// x.ai/tool metadata per tool name (kind and namespace as counted in the research)
const XAI = {
  read_file: ['read', 'grok_build', true], run_terminal_command: ['execute', 'grok_build', false],
  grep: ['search', 'grok_build', true], search_replace: ['edit', 'grok_build', false],
  use_tool: ['use_tool', 'grok_build', false], get_command_or_subagent_output: ['background_task_action', 'grok_build', true],
  todo_write: ['plan', 'grok_build', false], search_tool: ['search_tool', 'grok_build', true],
  write: ['write', 'opencode', false], monitor: ['monitor', 'grok_build', false], list_dir: ['list', 'grok_build', true],
  exit_plan_mode: ['exit_plan', 'grok_build', true], spawn_subagent: ['task', 'grok_build', false],
  kill_command_or_subagent: ['kill_task_action', 'grok_build', false], web_fetch: ['web_fetch', 'grok_build', true],
  ask_user_question: ['ask_user', 'grok_build', true], enter_plan_mode: ['enter_plan', 'grok_build', true],
  scheduler_list: ['other', 'grok_build', true],
};
// ACP kind on the first tool_call_update (coarser than x.ai/tool.kind)
const ACP_KIND = {
  read_file: 'read', list_dir: 'read', run_terminal_command: 'execute', monitor: 'execute', grep: 'search',
  search_replace: 'edit', write: 'edit', todo_write: 'think', web_fetch: 'fetch',
};

export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Deep copy with update-field overrides. */
export function cloneRecord(rec, updateOverrides = {}) {
  const c = JSON.parse(JSON.stringify(rec));
  Object.assign(c.params.update, updateOverrides);
  return c;
}

/** content[] helpers of tool_call_update. */
export function textContent(text) {
  return [{ type: 'content', content: { type: 'text', text } }];
}
export function diffContent(path, oldText, newText) {
  return [{ type: 'diff', path, oldText, newText }];
}

/** rawOutput shapes ({ type: '<Variant>', '<Variant>': {...} }). */
export const out = {
  readFile: (content = 'line one\nline two') => ({ type: 'ReadFile', FileContent: { content, total_lines: 2 } }),
  fileNotFound: (path = '/Users/someone/private/missing.txt') => ({ type: 'ReadFile', FileNotFound: { path } }),
  bash: ({ exitCode = 0, command = 'npm test', output = 'ok', cwd = '/Users/someone/work/repo' } = {}) => ({
    type: 'Bash',
    Bash: { command, current_dir: cwd, description: 'Run it', exit_code: exitCode, output, output_file: null },
  }),
  background: ({ command = 'npm run dev' } = {}) => ({
    type: 'BackgroundTaskStarted',
    BackgroundTaskStarted: { pid: 4242, status: 'running', output_file: '/tmp/x/out.log', retrieval_hint: 'use task id',
      summary: 'started', command },
  }),
  grep: ({ exitCode = 0 } = {}) => ({ type: 'GrepSearch', GrepSearch: { exit_code: exitCode, file_matches: 1, match_count: 2, stdout: 'a.txt:1:x', stderr: '' } }),
  edits: () => ({ type: 'SearchReplace', EditsApplied: { replacements: 1 } }),
  noMatch: () => ({ type: 'SearchReplace', NoMatchesFound: { file_path: '/Users/someone/work/repo/a.txt' } }),
  mcp: ({ server = 'github', tool = 'get_issue', output = 'issue body', isError } = {}) => ({
    type: 'MCP', MCP: { server_name: server, tool_name: tool, output, ...(isError === undefined ? {} : { is_error: isError }) },
  }),
  error: (error = 'not_found', message = 'Not found') => ({ error, message }),
  text: (text = 'Spawned subagent') => ({ type: 'Text', Text: { text } }),
  todos: () => ({ type: 'Todo', TodosUpdated: { count: 2 } }),
  planReady: (plan = '# Plan\n- Step one\n- Step two') => ({
    type: 'ExitPlanMode', PlanReady: { message: 'approved', plan_content: plan, plan_file_path: '/Users/someone/.grok/x/plan.md' },
  }),
  answered: (message = 'User picked option A') => ({ type: 'AskUserQuestion', UserAnswered: { message } }),
  monitor: () => ({ type: 'Monitor', Monitor: { taskId: 't-1', persistent: true, timeoutMs: 0 } }),
  enteredPlan: () => ({ type: 'EnterPlanMode', Entered: {} }),
};

export function createGrokBuilder(opts = {}) {
  const ctx = {
    sessionId: opts.sessionId ?? GROK_SESSION,
    clock: opts.startMs ?? DEFAULT_START,
    stepMs: opts.stepMs ?? 1000,
    modelId: opts.modelId ?? 'grok-4.6',
    seq: 0,
    turn: 0,
    promptId: opts.promptId ?? null,
    turnStartMs: null,
    calls: 0,
    lastToolId: null,
    tools: new Map(), // id -> name
  };
  const tick = () => {
    const ms = ctx.clock;
    ctx.clock += ctx.stepMs;
    return ms;
  };
  const eventId = () => `ev-${pad(++ctx.seq, 6)}`;

  // ACP kinds (method session/update): _meta carries the turn's promptId and the stream fields.
  function acp(update, { ms = tick(), updateType, promptId = ctx.promptId, chunkId } = {}) {
    const meta = { agentTimestampMs: ms, eventId: eventId() };
    if (promptId !== null && promptId !== undefined) {
      Object.assign(meta, { promptId, turnStartMs: ctx.turnStartMs ?? ms, streamStartMs: ms, totalTokens: 1000 + ctx.seq });
    }
    if (updateType) Object.assign(meta, { updateType, updateParams: {} });
    if (chunkId !== undefined) meta.chunkId = chunkId;
    return { method: 'session/update', params: { sessionId: ctx.sessionId, update, _meta: meta }, timestamp: Math.floor(ms / 1000) };
  }
  // xAI extension kinds (method _x.ai/session/update): _meta has only agentTimestampMs and eventId.
  function ext(update, { ms = tick(), meta = {} } = {}) {
    return {
      method: '_x.ai/session/update',
      params: { sessionId: ctx.sessionId, update, _meta: { agentTimestampMs: ms, eventId: eventId(), ...meta } },
      timestamp: Math.floor(ms / 1000),
    };
  }

  const b = {
    get sessionId() { return ctx.sessionId; },
    get promptId() { return ctx.promptId; },
    get lastToolId() { return ctx.lastToolId; },
    get clockMs() { return ctx.clock; },

    /** Starts a new turn id (done by userMessage unless { newTurn: false }). */
    newPrompt() {
      ctx.turn += 1;
      ctx.promptId = `prompt-${pad(ctx.turn, 4)}-0198f0a0`;
      ctx.turnStartMs = ctx.clock;
      return ctx.promptId;
    },

    /** user_message_chunk: no promptId. hidden -> hideFromScrollback, synthetic -> syntheticPrompt. */
    userMessage({ text = 'Please fix the login bug', hidden = false, synthetic = false, interjection = false,
      promptIndex, newTurn = !interjection } = {}) {
      if (newTurn) b.newPrompt();
      const m = { modelId: ctx.modelId };
      const index = promptIndex === undefined ? ctx.turn : promptIndex;
      if (index !== null) m.promptIndex = index;
      if (hidden) m.hideFromScrollback = true;
      if (synthetic) m.syntheticPrompt = true;
      if (interjection) m.interjection = true;
      return acp({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: m }, { promptId: null });
    },

    /** hook_execution; user_prompt_submit / pre_tool_use / post_tool_use / stop carry the turn's prompt_id. */
    hook({ event = 'user_prompt_submit', promptId = ctx.promptId, toolName, status = 'success' } = {}) {
      const u = { sessionUpdate: 'hook_execution', event_name: event, runs: [{ name: 'hook-a', status: { status } }] };
      if (toolName) u.tool_name = toolName;
      if (promptId && event !== 'session_start' && event !== 'session_end') u.prompt_id = promptId;
      return ext(u);
    },

    thought(text = 'I should read the config first.', o = {}) {
      return acp({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }, { updateType: 'AgentThoughtChunk', ...o });
    },
    message(text = 'I updated the file.', o = {}) {
      return acp({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, { updateType: 'AgentMessageChunk', chunkId: ctx.seq, ...o });
    },

    /** tool_call. name null -> no x.ai/tool (server-side web search: input { backend, variant }). */
    toolCall({ name = 'read_file', input = {}, id, title = `${name ?? 'Web search'}: /Users/someone/secret/path`, status, ...o } = {}) {
      ctx.calls += 1;
      const toolId = id ?? (name === null ? `ws_${pad(ctx.calls, 8)}` : `call-0198f0a0-0000-7000-8000-${pad(ctx.calls, 12)}-${ctx.calls}`);
      ctx.lastToolId = toolId;
      ctx.tools.set(toolId, name);
      const u = { sessionUpdate: 'tool_call', toolCallId: toolId, title, rawInput: input };
      if (status) u.status = status;
      if (name !== null) {
        const [kind, namespace, readOnly] = XAI[name] ?? ['other', 'grok_build', false];
        u._meta = { 'x.ai/tool': { name, namespace, kind, label: name.replace(/_/g, ' '), read_only: readOnly, version: 1 } };
      }
      return acp(u, { updateType: 'ToolCall', ...o });
    },

    /** The first tool_call_update: repeats rawInput with kind, title and locations (no status). */
    toolInput({ id = ctx.lastToolId, input, title = 'Display: /Users/someone/secret/path', locations, content, ...o } = {}) {
      const name = ctx.tools.get(id);
      const u = { sessionUpdate: 'tool_call_update', toolCallId: id, kind: ACP_KIND[name] ?? 'other', title };
      if (input !== undefined) u.rawInput = input;
      u.locations = locations ?? [{ path: '/Users/someone/work/repo/src/a.ts', line: 3 }];
      if (content) u.content = content;
      return acp(u, { updateType: 'ToolCallUpdate', ...o });
    },

    /** The terminal tool_call_update. output: rawOutput (omit for none). text: content[] first text. */
    toolDone({ id = ctx.lastToolId, status = 'completed', output, text, content, ...o } = {}) {
      const u = { sessionUpdate: 'tool_call_update', toolCallId: id, status };
      if (output !== undefined) u.rawOutput = output;
      if (content !== undefined) u.content = content;
      else if (text !== undefined) u.content = textContent(text);
      return acp(u, { updateType: 'ToolCallUpdate', ...o });
    },

    /** Denied tool: failed, no rawOutput, a fixed denial phrase in content. */
    toolDenied({ id = ctx.lastToolId, text, ...o } = {}) {
      const name = ctx.tools.get(id) ?? 'run_terminal_command';
      return b.toolDone({ id, status: 'failed', text: text ?? `Tool ${name} was not executed: Auto mode blocked this action`, ...o });
    },

    /** turn_completed (extension): stop_reason end_turn | cancelled | error. */
    turnCompleted({ stopReason = 'end_turn', promptId = ctx.promptId, cancelTrigger, elapsedMs = 4200 } = {}) {
      const u = {
        sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: stopReason, elapsed_ms: elapsedMs,
        usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cachedReadTokens: 0, cacheCreationTokens: 0,
          totalTokens: 160, modelCalls: 2, numTurns: 1, apiDurationMs: 900, modelUsage: {} },
      };
      const meta = {};
      if (stopReason === 'cancelled') Object.assign(meta, { cancelTrigger: cancelTrigger ?? 'esc', cancellationCategory: 'MidTurnAbort' });
      return ext(u, { meta });
    },

    /** plan (ACP): the full todo list. entries [{ content, status, cancelled? }]. */
    plan(entries = [{ content: 'Read the code', status: 'completed' }, { content: 'Fix the bug', status: 'in_progress' }], o = {}) {
      const list = entries.map((e) => {
        const it = { content: e.content, priority: 'medium', status: e.status };
        if (e.cancelled) it._meta = { cancelled: true };
        return it;
      });
      return acp({ sessionUpdate: 'plan', entries: list }, { updateType: 'Plan', ...o });
    },

    modeUpdate(currentModeId = 'plan') {
      return acp({ sessionUpdate: 'current_mode_update', currentModeId });
    },

    retry({ type = 'retrying', attempt = 1, maxRetries = 5, errorType = 'api', reason = 'overloaded', message } = {}) {
      const u = { sessionUpdate: 'retry_state', type };
      if (type === 'retrying') Object.assign(u, { attempt, max_retries: maxRetries, reason, error_type: errorType });
      else Object.assign(u, { error_type: errorType, message: message ?? 'Upstream returned 500' });
      return ext(u);
    },

    compactStarted() {
      return ext({ sessionUpdate: 'auto_compact_started', reason: 'threshold', tokens_used: 180000, context_window: 200000, percentage: 90 });
    },
    compactCompleted() {
      return ext({ sessionUpdate: 'auto_compact_completed', tokens_before: 180000, tokens_after: 20000, elapsed_ms: 3000, summary_preview: null });
    },

    subagentSpawned({ child = GROK_CHILD, type = 'explore', description = 'Look around the repo', parentPromptId = ctx.promptId } = {}) {
      return ext({
        sessionUpdate: 'subagent_spawned', child_session_id: child, parent_session_id: ctx.sessionId, subagent_id: child,
        parent_prompt_id: parentPromptId, subagent_type: type, description, model: ctx.modelId, effective_context_source: 'new',
      });
    },
    subagentFinished({ child = GROK_CHILD, status = 'completed' } = {}) {
      return ext({
        sessionUpdate: 'subagent_finished', child_session_id: child, subagent_id: child, status, duration_ms: 21700,
        tokens_used: 5000, tool_calls: 4, turns: 1, output: 'Child result body', will_wake: false,
      });
    },

    taskBackgrounded({ toolCallId = ctx.lastToolId, command = 'npm run dev -- --token=abc' } = {}) {
      return ext({ sessionUpdate: 'task_backgrounded', task_id: 'task-1', tool_call_id: toolCallId, command,
        cwd: '/Users/someone/work/repo', description: 'dev server', output_file: '/tmp/x/out.log' });
    },
    sessionRecap(summary = 'The session fixed a bug.') {
      return ext({ sessionUpdate: 'session_recap', auto: true, summary });
    },
    /** Any other kind (unknown to the adapter). */
    unknown(kind = 'model_changed', fields = { model: 'grok-9' }) {
      return ext({ sessionUpdate: kind, ...fields });
    },
  };
  return b;
}

// ------------------------------------------------------------------------------------------------- events.jsonl
// Synthetic events.jsonl lines ({ type, ts: ISO with ms and Z, ... }) shaped like grok-format.json's events topics.
// Each builder takes { ms } for an exact time (pairing tests need tool_started within 50 ms of the tool_call's
// agentTimestampMs); otherwise the clock advances by `stepMs`. Text fields the adapter never reads (model_id,
// cancellation_context.reason, the mcp_* strings, an extra key on permission_requested) carry BAIT_EV_* text, so a leak
// shows in any BAIT_ scan. The mcp bait also holds the quoted type names, which JSON escapes (\"tool_started\"),
// so the quoted-type prefilter never lets such a line through.
//   const ev = createGrokEventsBuilder({ startMs: t });
//   const lines = [ev.turnStarted(), ...ev.prompt('run_terminal_command', { waitMs: 2000 }), ev.turnEnded()];
//   await writeSession(root, { group, id, items, events: lines });
export const EVENTS_BAIT = Object.freeze({
  model: 'BAIT_EV_MODEL_ID', reason: 'BAIT_EV_CANCEL_REASON', extra: 'BAIT_EV_EXTRA_KEY',
  mcpError: 'BAIT_EV_MCP_ERROR "tool_started" "permission_requested" "turn_ended"', mcpServer: 'BAIT_EV_MCP_SERVER',
  mcpTarget: '/Users/bait-user/BAIT_EV_MCP_TARGET',
});

export function createGrokEventsBuilder(opts = {}) {
  const ctx = { clock: opts.startMs ?? DEFAULT_START, stepMs: opts.stepMs ?? 1, sessionId: opts.sessionId ?? GROK_SESSION, turn: 0 };
  const ts = (ms) => {
    const t = ms ?? ctx.clock;
    ctx.clock = t + ctx.stepMs;
    return new Date(t).toISOString();
  };
  const b = {
    get clockMs() { return ctx.clock; },
    /** Move the clock (e.g. a wait) without writing a line. */
    advance(ms) { ctx.clock += ms; return ctx.clock; },

    started(name = 'run_terminal_command', { ms } = {}) {
      return { ts: ts(ms), type: 'tool_started', tool_name: name };
    },
    phase(phase = 'permission_prompt', { ms } = {}) {
      return { ts: ts(ms), type: 'phase_changed', phase };
    },
    /** permission_requested; `extra` adds a never-read key (bait by default). */
    requested(name = 'run_terminal_command', { ms, extra = { request_note: EVENTS_BAIT.extra } } = {}) {
      return { ts: ts(ms), type: 'permission_requested', tool_name: name, ...extra };
    },
    resolved(name = 'run_terminal_command', { decision = 'allow', waitMs = 0, ms } = {}) {
      return { ts: ts(ms), type: 'permission_resolved', tool_name: name, decision, wait_ms: waitMs };
    },
    yoloToggled(enabled = true, { ms } = {}) {
      return { ts: ts(ms), type: 'yolo_toggled', enabled };
    },
    turnStarted({ yolo = false, ms, sessionId = ctx.sessionId, modelId = EVENTS_BAIT.model } = {}) {
      ctx.turn += 1;
      return { ts: ts(ms), type: 'turn_started', session_id: sessionId, turn_number: ctx.turn, model_id: modelId,
        conversation_message_count: 2 * ctx.turn, session_relationship: 'primary', yolo_mode: yolo, schema_version: '1.0' };
    },
    /** turn_ended; outcome cancelled gets cancellation_category (mid_turn_abort by default) and a bait context. */
    turnEnded({ outcome = 'completed', category = 'mid_turn_abort', reason = EVENTS_BAIT.reason, ms } = {}) {
      const r = { ts: ts(ms), type: 'turn_ended', outcome };
      if (outcome === 'cancelled') {
        r.cancellation_category = category;
        r.cancellation_context = { trigger: 'esc', tool_name: 'run_terminal_command', reason };
      }
      return r;
    },
    toolCompleted(name = 'run_terminal_command', { id = 'call-bait-completed', outcome = 'success', ms } = {}) {
      return { ts: ts(ms), type: 'tool_completed', tool_name: name, tool_call_id: id, outcome, duration_ms: 12 };
    },
    mcpFailed({ server = EVENTS_BAIT.mcpServer, message = EVENTS_BAIT.mcpError, ms } = {}) {
      return { ts: ts(ms), type: 'mcp_server_failed', server_name: server, error_message: message };
    },
    mcpStarting({ server = EVENTS_BAIT.mcpServer, target = EVENTS_BAIT.mcpTarget, ms } = {}) {
      return { ts: ts(ms), type: 'mcp_server_starting', server_name: server, target };
    },
    /**
     * One permission prompt: tool_started, phase permission_prompt, permission_requested, then (unless decision is
     * null) permission_resolved `waitMs` later and phase tool_execution. { ms } is the tool_started time.
     */
    prompt(name = 'run_terminal_command', { decision = 'allow', waitMs = 0, ms } = {}) {
      const lines = [b.started(name, { ms }), b.phase('permission_prompt'), b.requested(name)];
      if (decision === null) return lines;
      b.advance(waitMs);
      lines.push(b.resolved(name, { decision, waitMs }), b.phase('tool_execution'));
      return lines;
    },
  };
  return b;
}
