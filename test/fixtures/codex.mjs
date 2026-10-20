// Synthetic Codex rollout records shaped like the structure-only examples in docs/research/codex-format.json.
// All text, ids, paths and commands are invented; nothing here reads a real ~/.codex. Side-effect free at import
// (node --test runs every file under test/).
//
// Usage:
//   const b = createCodexBuilder({ threadId: CODEX_THREAD, cliVersion: '0.162.0-alpha.17.2' });
//   const recs = [b.sessionMeta(), b.taskStarted(), b.userMessage('Fix the login bug'), ...b.think('Reading.'),
//     b.exec('const r = await tools.exec_command({ cmd: "rg login src" });'),
//     b.commandItem({ script: 'rg login src', parsed: 'rg login src' }), b.execOutput(),
//     ...b.say('Done.', { phase: 'final_answer' }), b.taskComplete()];
//   const jsonl = toJsonl(recs);
// Every record is { timestamp (ISO ms, Z), ordinal (0-based line index of this file), type, payload, metadata? }.
// Every builder call advances a fake clock by `stepMs` and the ordinal by one. Old (< 0.142.5) threads use per-tool
// function calls (exec_command, shell, shell_command, apply_patch, update_plan, mcp__<server>__<tool>); code-mode threads
// (>= 0.142.5) use one custom `exec` tool whose inner calls surface only as item_completed items while it is open.
// In paginated files an assistant message and a reasoning block are written twice (item_completed + response_item):
// `say()` / `think()` return both records as an array (spread them into the list).

export const CODEX_THREAD = '019a2b3c-4d5e-7f60-8a91-b2c3d4e5f607';
export const CODEX_CHILD = '019a2b3c-9e8d-7c6b-8a59-fedcba987654';
export const CODEX_GRANDCHILD = '019a2b3c-1111-7222-8333-444455556666';
export const OLD_VERSION = '0.128.0';
export const NEW_VERSION = '0.162.0-alpha.17.2';

const DEFAULT_START = Date.UTC(2026, 9, 20, 9, 0, 0);
const pad = (n, w) => String(n).padStart(w, '0');

export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Deep copy (to replay the same record twice, or to edit one). */
export function cloneRecord(rec, payloadOverrides = {}) {
  const c = JSON.parse(JSON.stringify(rec));
  Object.assign(c.payload, payloadOverrides);
  return c;
}

/** Tool output texts and shapes as counted in the research ("Tool output formats, exit codes, background processes"). */
export const out = {
  /** exec_command / write_stdin text: Chunk ID header, exit or still running, then the body. */
  execCommand: ({ exitCode = 0, running = false, body = 'ok' } = {}) => [
    'Chunk ID: 7f3a2c', 'Wall time: 0.1820 seconds',
    running ? 'Process running with session ID 41234' : `Process exited with code ${exitCode}`,
    'Original token count: 12', 'Output:', body,
  ].join('\n'),
  /** shell_command (and apply_patch text) output. */
  shellCommand: ({ exitCode = 0, body = 'ok' } = {}) => `Exit code: ${exitCode}\nWall time: 0.5 seconds\nOutput:\n${body}`,
  /** shell (<= 0.58) and apply_patch JSON output string. */
  json: ({ exitCode = 0, body = 'ok' } = {}) => JSON.stringify({ output: body, metadata: { exit_code: exitCode, duration_seconds: 0.1 } }),
  aborted: () => 'aborted by user after 3.2s',
  rejected: (body = 'BAIT_DENY_REASON') => `exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\") ${body}" }`,
  execRejected: () => 'exec command rejected by user',
  patchRejected: () => 'patch rejected: BAIT_DENY_REASON',
  policy: () => 'approval required by policy, but AskForApproval is set to Never',
  sandbox: (body = 'BAIT_DENY_REASON') => `sandbox denied exec error, exit code: 1, stdout: ${body}`,
  failedInSandbox: () => 'failed in sandbox: operation not permitted BAIT_DENY_REASON',
  timedOut: () => 'command timed out after 10000 milliseconds',
  toolFailed: (prefix = 'collab spawn', reason = 'agent thread limit reached BAIT_RESULT_BODY') => `${prefix} failed: ${reason}`,
  answers: () => JSON.stringify({ answers: { q1: { answers: ['BAIT_ANSWER'] } } }),
  planUpdated: () => 'Plan updated',
  spawned: () => JSON.stringify({ agent_id: CODEX_CHILD, nickname: 'Hume' }),
  mcpResult: (body = 'BAIT_RESULT_BODY') => JSON.stringify({ result: { content: [{ type: 'text', text: body }] } }),
  /** code-mode exec output: an array of input_text items. */
  script: (text = 'Script completed\nBAIT_RESULT_BODY') => [{ type: 'input_text', text }],
  scriptFailed: (body = 'TypeError: BAIT_RESULT_BODY') => [{ type: 'input_text', text: `Script failed\n${body}` }],
  scriptError: () => [{ type: 'input_text', text: 'Script error: SyntaxError: BAIT_RESULT_BODY' }],
  image: () => [{ type: 'input_image', image_url: 'data:image/png;base64,QkFJVA==', detail: 'high' }],
};

/** A small apply_patch body (headers name the files; the body is bait). */
export function patchText(files = ['src/auth/login.ts'], body = 'BAIT_PATCH_BODY') {
  const parts = ['*** Begin Patch'];
  for (const f of files) parts.push(`*** Update File: ${f}`, '@@', `-old ${body}`, `+new ${body}`);
  parts.push('*** End Patch');
  return parts.join('\n');
}

export function createCodexBuilder(opts = {}) {
  const ctx = {
    threadId: opts.threadId ?? CODEX_THREAD,
    cliVersion: opts.cliVersion ?? NEW_VERSION,
    cwd: opts.cwd ?? '/work/codex-repo',
    branch: opts.branch === undefined ? 'feat/login' : opts.branch,
    clock: opts.startMs ?? DEFAULT_START,
    stepMs: opts.stepMs ?? 1000,
    ordinal: opts.ordinal ?? 0,
    turn: 0,
    turnId: null,
    calls: 0,
    items: 0,
    lastCallId: null,
    lastItemId: null,
  };
  const tick = () => {
    const ms = ctx.clock;
    ctx.clock += ctx.stepMs;
    return ms;
  };
  const line = (type, payload, { metadata, ms = tick(), ordinal } = {}) => {
    const rec = { timestamp: new Date(ms).toISOString(), ordinal: ordinal ?? ctx.ordinal, type, payload };
    ctx.ordinal = (ordinal ?? ctx.ordinal) + 1;
    if (metadata) rec.metadata = metadata;
    return rec;
  };
  const event = (payload, o) => line('event_msg', payload, o);
  const resp = (payload, o) => line('response_item', payload, o);
  const nextItemId = (prefix = 'item') => {
    ctx.items += 1;
    ctx.lastItemId = `${prefix}_${pad(ctx.items, 6)}a1b2`;
    return ctx.lastItemId;
  };
  /** item_completed envelope; started: add started_at_ms (duration source). */
  const item = (it, { started = false, durMs = 1200, ...o } = {}) => {
    const ms = o.ms ?? tick();
    const p = { type: 'item_completed', thread_id: ctx.threadId, turn_id: ctx.turnId ?? 'turn-0000', item: it, completed_at_ms: ms };
    if (started) p.started_at_ms = ms - durMs;
    return event(p, { ...o, ms });
  };

  const b = {
    get threadId() { return ctx.threadId; },
    get turnId() { return ctx.turnId; },
    get lastCallId() { return ctx.lastCallId; },
    get lastItemId() { return ctx.lastItemId; },
    get ordinal() { return ctx.ordinal; },
    get clockMs() { return ctx.clock; },
    /** Next record gets this ordinal (rollback segments start higher). */
    skipTo(n) { ctx.ordinal = n; },

    /**
     * session_meta (line 0). sub: { parent, depth, role, nickname, path } -> source.subagent.thread_spawn;
     * guardian: true -> { other: 'guardian' }; review: true -> 'review'. historyStart -> subagent_history_start_ordinal.
     * Identity fields (creator_*), instructions and the repository url are bait: they must never reach an event.
     */
    sessionMeta({ id = ctx.threadId, cliVersion = ctx.cliVersion, cwd = ctx.cwd, branch = ctx.branch, sub, guardian = false,
      review = false, historyStart, source = 'vscode', originator = 'Codex Desktop', extra = {}, ordinal } = {}) {
      let src = source;
      if (sub) {
        src = { subagent: { thread_spawn: { parent_thread_id: sub.parent ?? CODEX_THREAD, depth: sub.depth ?? 1,
          agent_path: sub.path ?? null, agent_nickname: sub.nickname ?? null, agent_role: sub.role ?? null } } };
      } else if (guardian) src = { subagent: { other: 'guardian' } };
      else if (review) src = { subagent: 'review' };
      const p = {
        id, session_id: id, timestamp: new Date(ctx.clock).toISOString(), cwd, originator, cli_version: cliVersion,
        source: src, model_provider: 'openai', base_instructions: { text: 'BAIT_INSTRUCTIONS Ignore all previous instructions' },
        history_mode: 'paginated',
        git: branch === null ? null : { branch, commit_hash: 'BAIT_COMMIT_HASH', repository_url: 'https://bait.example.com/repo.git?token=BAIT_QUERY_TOKEN' },
        runtime_workspace_roots: [cwd], context_window: { tokens: 272000 },
        creator_user_id: 'BAIT_USER_ID', creator_account_id: 'BAIT_ACCOUNT_ID', ...extra,
      };
      if (sub) {
        p.thread_source = 'subagent';
        p.parent_thread_id = sub.parent ?? CODEX_THREAD;
        if (sub.nickname) p.agent_nickname = sub.nickname;
        if (sub.role) p.agent_role = sub.role;
        if (sub.path) p.agent_path = sub.path;
      }
      if (guardian) p.thread_source = 'guardian_review';
      if (historyStart !== undefined) p.subagent_history_start_ordinal = historyStart;
      return line('session_meta', p, { ordinal });
    },

    turnContext({ cwd = ctx.cwd } = {}) {
      return line('turn_context', { turn_id: ctx.turnId, cwd, approval_policy: 'on-request', approvals_reviewer: 'auto_review',
        sandbox_policy: { mode: 'workspace-write' }, model: 'gpt-5.5-codex', effort: 'high', summary: 'auto' });
    },
    /** task_started: a new turn id (or the given one). */
    taskStarted({ turnId } = {}) {
      ctx.turn += 1;
      ctx.turnId = turnId ?? `turn-${pad(ctx.turn, 4)}-019a`;
      return event({ type: 'task_started', turn_id: ctx.turnId, root_turn_id: ctx.turnId, started_at: Math.floor(ctx.clock / 1000),
        model_context_window: 272000, collaboration_mode_kind: 'default', turn_attribution: { kind: 'user' } });
    },
    /** task_complete; error: a message -> error { codex_error_info, message }. */
    taskComplete({ turnId = ctx.turnId, error, lastMessage = 'BAIT_LAST_MESSAGE' } = {}) {
      const p = { type: 'task_complete', turn_id: turnId, root_turn_id: turnId, last_agent_message: lastMessage,
        started_at: 1, completed_at: 2, duration_ms: 4200, time_to_first_token_ms: 300 };
      if (error !== undefined) p.error = { codex_error_info: 'other', message: error };
      return event(p);
    },
    turnAborted({ turnId = ctx.turnId, reason = 'interrupted' } = {}) {
      return event({ type: 'turn_aborted', reason, turn_id: turnId, root_turn_id: turnId, duration_ms: 900 });
    },

    /** The human prompt: item_completed UserMessage. */
    userMessage(text = 'Please fix the login bug', { image = false } = {}) {
      const content = [{ type: 'text', text, text_elements: [] }];
      if (image) content.push({ type: 'local_image', path: '/Users/bait-user/Pictures/bait.png' });
      return item({ type: 'UserMessage', id: nextItemId('msg'), content, client_id: 'client-1' });
    },
    /** response_item message role=user (injected context, never a prompt). */
    userContext(text = '# AGENTS.md instructions for /Users/bait-user/proj\nBAIT_INJECTED') {
      return resp({ type: 'message', id: nextItemId('rmsg'), role: 'user', content: [{ type: 'input_text', text }] });
    },
    developer(text = '<permissions>BAIT_INJECTED</permissions>') {
      return resp({ type: 'message', id: nextItemId('rmsg'), role: 'developer', content: [{ type: 'input_text', text }] });
    },

    /** AgentMessage item (item_completed). */
    agentMessageItem(text = 'I updated the file.', { phase = 'commentary' } = {}) {
      const it = { type: 'AgentMessage', id: nextItemId('msg'), content: [{ type: 'Text', text }] };
      if (phase) it.phase = phase;
      return item(it);
    },
    /** response_item message role=assistant output_text. */
    assistantMessage(text = 'I updated the file.', { phase = 'commentary' } = {}) {
      const p = { type: 'message', id: nextItemId('rmsg'), role: 'assistant', content: [{ type: 'output_text', text }], status: 'completed' };
      if (phase) p.phase = phase;
      return resp(p);
    },
    /** Both duplicates, as paginated files write them: the item, then the response_item. */
    say(text, o = {}) { return [b.agentMessageItem(text, o), b.assistantMessage(text, o)]; },

    /** Reasoning item; started: also started_at_ms (durationMs). texts [] = an empty summary. */
    reasoningItem(texts = ['I should read the config first.'], { started = true, durMs = 1200 } = {}) {
      return item({ type: 'Reasoning', id: nextItemId('rs'), summary_text: texts, raw_content: [] }, { started, durMs });
    },
    reasoningResponse(texts = ['I should read the config first.']) {
      return resp({ type: 'reasoning', id: nextItemId('rs'), summary: texts.map((text) => ({ type: 'summary_text', text })),
        content: null, encrypted_content: 'gAAAAABAIT_ENCRYPTED' });
    },
    think(text, o = {}) {
      const texts = text === null ? [] : [text];
      return [b.reasoningItem(texts, o), b.reasoningResponse(texts)];
    },

    /** function_call. args: an object (serialized) or a raw string. */
    functionCall({ name, args = {}, namespace, callId } = {}) {
      ctx.calls += 1;
      const id = callId ?? `call_${pad(ctx.calls, 6)}Xy9`;
      ctx.lastCallId = id;
      const p = { type: 'function_call', id: `fc_${pad(ctx.calls, 6)}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args), call_id: id };
      if (namespace) p.namespace = namespace;
      return resp(p);
    },
    functionOutput({ callId = ctx.lastCallId, output = 'ok' } = {}) {
      return resp({ type: 'function_call_output', call_id: callId, output });
    },
    customCall({ name, input = '', callId } = {}) {
      ctx.calls += 1;
      const id = callId ?? `call_${pad(ctx.calls, 6)}Cz7`;
      ctx.lastCallId = id;
      return resp({ type: 'custom_tool_call', id: `ctc_${pad(ctx.calls, 6)}`, status: 'completed', call_id: id, name, input });
    },
    customOutput({ callId = ctx.lastCallId, output = out.script() } = {}) {
      return resp({ type: 'custom_tool_call_output', id: `ctco_${pad(ctx.calls, 6)}`, call_id: callId, output });
    },

    // ---- old (< 0.142.5) tool calls
    execCommand(cmd = 'rg -n login src', extra = {}) {
      return b.functionCall({ name: 'exec_command', args: { cmd, workdir: '/Users/bait-user/proj', yield_time_ms: 1000, ...extra } });
    },
    shellCommand(command = 'npm test', extra = {}) {
      return b.functionCall({ name: 'shell_command', args: { command, workdir: '/Users/bait-user/proj', timeout_ms: 60000, ...extra } });
    },
    shell(argv = ['bash', '-lc', 'git status'], extra = {}) {
      return b.functionCall({ name: 'shell', args: { command: argv, workdir: '/Users/bait-user/proj', ...extra } });
    },
    writeStdin(sessionId = 41234) { return b.functionCall({ name: 'write_stdin', args: { session_id: sessionId, chars: 'BAIT_STDIN' } }); },
    waitCall(args = { cell_id: 'cell-1', yield_time_ms: 1000, max_tokens: 2000 }) { return b.functionCall({ name: 'wait', args }); },
    updatePlan(plan = [{ step: 'Read the code', status: 'completed' }, { step: 'Fix the bug', status: 'in_progress' }],
      explanation = 'BAIT_EXPLANATION') {
      return b.functionCall({ name: 'update_plan', args: { explanation, plan } });
    },
    requestUserInput(questions = [{ id: 'q1', header: 'BAIT_HEADER', question: 'Which database should I use?',
      options: [{ label: 'Postgres', description: 'BAIT_OPTION_DESC' }, { label: 'SQLite', description: 'BAIT_OPTION_DESC' }] }]) {
      return b.functionCall({ name: 'request_user_input', args: { questions } });
    },
    /** request_user_input_async (0.154+): questions [{ title, options?: string[] | null }], output { accepted }. */
    requestUserInputAsync(questions = [{ title: 'Ship the fix now?', options: ['Yes', 'Later'] }, { title: 'Notify the team?' }]) {
      return b.functionCall({ name: 'request_user_input_async', args: { questions } });
    },
    spawnAgent({ agentType = 'explorer', message = 'BAIT_SUB_TASK look around', namespaced = true } = {}) {
      return b.functionCall({ name: 'spawn_agent', namespace: namespaced ? 'collaboration' : undefined,
        args: { agent_type: agentType, message, task_name: 'BAIT_TASK_NAME', fork_context: true } });
    },
    collab(name = 'wait_agent', args = { timeout_ms: 30000, targets: ['/root/BAIT_TARGET'] }) {
      return b.functionCall({ name, namespace: 'collaboration', args });
    },
    /** MCP call: old name form mcp__<server>__<tool>, or (namespaced) namespace mcp__<server> + name <tool>. */
    mcp({ server = 'github', tool = 'get_issue', args = { query: 'BAIT_TOOL_INPUT' }, namespaced = false } = {}) {
      return namespaced
        ? b.functionCall({ name: tool, namespace: `mcp__${server}`, args })
        : b.functionCall({ name: `mcp__${server}__${tool}`, args });
    },
    viewImage(path = '/Users/bait-user/proj/shot.png') { return b.functionCall({ name: 'view_image', args: { path } }); },
    clockSleep(ms = 5000) { return b.functionCall({ name: 'sleep', namespace: 'clock', args: { duration_ms: ms } }); },
    applyPatch(patch = patchText()) { return b.customCall({ name: 'apply_patch', input: patch }); },

    // ---- code mode (>= 0.142.5)
    exec(script = 'const r = await tools.exec_command({ cmd: "rg -n login src" });\ntext(r.output);') {
      return b.customCall({ name: 'exec', input: script });
    },
    execOutput(output = out.script(), callId = ctx.lastCallId) { return b.customOutput({ callId, output }); },

    /** Inner CommandExecution item: argv [zsh, -lc, script], parsed_cmd from `parsed` (string, null = none). */
    commandItem({ script = 'rg -n login src', parsed = script, parsedType = 'search', exitCode = 0, status, id } = {}) {
      const it = {
        type: 'CommandExecution', id: id ?? nextItemId('cmd'), command: ['/bin/zsh', '-lc', script], cwd: '/Users/bait-user/proj',
        process_id: 'proc-1', source: 'unified_exec_startup', status: status ?? (exitCode === 0 ? 'completed' : 'failed'),
        exit_code: exitCode, duration: { secs: 0, nanos: 182000000 }, aggregated_output: 'BAIT_STDOUT', stdout: 'BAIT_STDOUT',
        stderr: 'BAIT_STDERR', formatted_output: 'BAIT_STDOUT',
        parsed_cmd: parsed === null ? [] : [{ type: parsedType, cmd: parsed, name: 'BAIT_PARSED_NAME' }],
      };
      return item(it, { started: true });
    },
    fileChangeItem({ paths = ['/Users/bait-user/proj/src/auth/login.ts'], status = 'completed', id } = {}) {
      const changes = {};
      for (const p of paths) changes[p] = { type: 'update', unified_diff: '@@ -1 +1 @@\n-BAIT_OLD\n+BAIT_NEW', move_path: null };
      return item({ type: 'FileChange', id: id ?? nextItemId('fchg'), changes, status, stdout: 'BAIT_STDOUT', stderr: '' }, { started: true });
    },
    mcpItem({ server = 'github', tool = 'get_issue', status = 'completed', error, id } = {}) {
      const it = { type: 'McpToolCall', id: id ?? nextItemId('mcp'), server, tool, status, duration: { secs: 1, nanos: 0 },
        arguments: { query: 'BAIT_TOOL_INPUT' }, result: { content: [{ type: 'text', text: 'BAIT_RESULT_BODY' }] } };
      if (error) it.error = { message: error };
      return item(it, { started: true });
    },
    webSearchItem({ query = 'codex rollout format', url, id } = {}) {
      const action = url ? { type: 'open_page', url } : { type: 'search', query };
      return item({ type: 'WebSearch', id: id ?? nextItemId('ws'), query: url ? '' : query, action, results: ['BAIT_RESULT_BODY'] });
    },
    imageViewItem({ path = '/Users/bait-user/proj/shot.png', id } = {}) {
      return item({ type: 'ImageView', id: id ?? nextItemId('img'), path });
    },
    planItem(text = '# Plan\n\n1. Read the auth code\n2. Fix the token check\n3. Add a test') {
      return item({ type: 'Plan', id: nextItemId('plan'), text });
    },
    subAgentActivity({ child = CODEX_CHILD, kind = 'completed' } = {}) {
      return item({ type: 'SubAgentActivity', id: nextItemId('sa'), agent_thread_id: child, agent_path: '/root/BAIT_AGENT_PATH',
        kind, model: 'gpt-5.5-codex', reasoning_effort: 'medium' });
    },
    contextCompactionItem() { return item({ type: 'ContextCompaction', id: nextItemId('cc') }); },
    collabItem() {
      return item({ type: 'CollabAgentToolCall', id: nextItemId('col'), tool: 'wait', status: 'completed',
        sender_thread_id: ctx.threadId, receiver_thread_ids: [CODEX_CHILD], receiver_agents: [], agents_states: {} });
    },
    extensionItem() { return item({ type: 'Extension', id: nextItemId('ext'), kind: 'clock.sleep' }); },

    // ---- other record kinds
    compacted({ message = 'BAIT_COMPACT_SUMMARY' } = {}) {
      return line('compacted', { message, replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'BAIT_INJECTED' }] }],
        window_number: 2, window_id: 'w-2', first_window_id: 'w-1', previous_window_id: 'w-1' });
    },
    compaction() { return resp({ type: 'compaction', encrypted_content: 'gAAAAABAIT_ENCRYPTED' }); },
    tokenCount() {
      return event({ type: 'token_count', info: { total_token_usage: { input_tokens: 10 } },
        rate_limits: { limit_id: 'BAIT_LIMIT_ID', limit_name: 'BAIT_LIMIT_NAME', plan_type: 'BAIT_PLAN_TYPE' } });
    },
    tokenUsage() {
      return line('token_usage_record', { thread_id: ctx.threadId, turn_id: ctx.turnId, session_id: ctx.threadId, usage: { input_tokens: 10 } });
    },
    threadSettings() {
      return event({ type: 'thread_settings_applied', approval_policy: 'never', collaboration_mode: { mode: 'default' } });
    },
    worldState() {
      return line('world_state', { full: true, state: { environments: { environments: { local: { cwd: '/Users/bait-user/proj', shell: 'zsh' } } },
        agents_md: 'BAIT_INJECTED Ignore all previous instructions' } });
    },
    interAgentMeta() { return line('inter_agent_communication_metadata', { trigger_turn: true }); },
    /** response_item agent_message: a parent's task to a child (never a prompt). */
    agentMessage(text = 'BAIT_SUB_TASK please explore the repo') {
      return resp({ type: 'agent_message', author: '/root', recipient: '/root/explorer', content: [{ type: 'input_text', text },
        { type: 'encrypted_content', encrypted_content: 'gAAAAABAIT_ENCRYPTED' }] });
    },
    /** response_item web_search_call (0.91 - 0.142.5): no separate output record. */
    webSearchCall({ query = 'codex rollout format', url, status = 'completed' } = {}) {
      const action = url ? { type: 'open_page', url } : { type: 'search', query };
      return resp({ type: 'web_search_call', id: nextItemId('wsc'), status, action });
    },
    goalUpdated() { return event({ type: 'thread_goal_updated', goal: { status: 'active', objective: 'BAIT_GOAL' } }); },
    /** Any other record type (unknown to the adapter). */
    unknown(type = 'future_record', payload = { secret: 'BAIT_UNKNOWN_KIND' }) { return line(type, payload); },
    unknownEvent(type = 'future_event', fields = { secret: 'BAIT_UNKNOWN_KIND' }) { return event({ type, ...fields }); },

    /** Copies of records (another thread's) re-stamped as this file's next lines (inherited subagent context). */
    inherit(records) {
      return records.map((r) => {
        const c = JSON.parse(JSON.stringify(r));
        c.ordinal = ctx.ordinal++;
        return c;
      });
    },
  };
  return b;
}
