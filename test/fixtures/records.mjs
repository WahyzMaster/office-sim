// Synthetic transcript records shaped like the redacted examples in docs/research/jsonl-format.json.
// All text is invented. Nothing here reads or copies a real transcript.
//
// Usage:
//   const b = createRecordBuilder({ sessionId: 'sess-1', cwd: '/tmp/demo' });
//   const recs = [b.humanPrompt({ text: 'hi' }), b.assistantText({ text: 'hello', stopReason: 'end_turn' })];
//   const jsonl = toJsonl(recs);
// Every builder call advances a fake clock by `stepMs` and returns a fresh uuid, so streams are
// deterministic per builder instance.

const DEFAULT_START = Date.UTC(2026, 0, 1, 0, 0, 0);

function pad(n, width) {
  return String(n).padStart(width, '0');
}

export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Deep copy with field overrides, e.g. a resume re-append copy: clone(rec, { cwd: '/other' }). */
export function clone(rec, overrides = {}) {
  return { ...JSON.parse(JSON.stringify(rec)), ...overrides };
}

export function createRecordBuilder(opts = {}) {
  const ctx = {
    sessionId: opts.sessionId ?? '11111111-1111-4111-8111-111111111111',
    cwd: opts.cwd ?? '/tmp/claude-office-fixture/repo',
    gitBranch: opts.gitBranch ?? 'main',
    agentId: opts.agentId ?? null, // set for subagent files (isSidechain true)
    version: opts.version ?? '2.1.299',
    clock: opts.startMs ?? DEFAULT_START,
    stepMs: opts.stepMs ?? 1000,
    promptId: opts.promptId ?? null,
    seq: 0,
    lastUuid: null,
  };

  const nextUuid = () => {
    ctx.seq += 1;
    const tag = ctx.agentId ? 'b' : 'a';
    return `${tag}0000000-0000-4000-8000-${pad(ctx.seq, 12)}`;
  };
  const nextTs = () => {
    const ts = new Date(ctx.clock).toISOString();
    ctx.clock += ctx.stepMs;
    return ts;
  };
  const newPromptId = () => `p0000000-0000-4000-8000-${pad(ctx.seq + 1, 12)}`;

  // Common envelope for user / assistant / attachment / system records.
  function envelope(type, extra = {}, o = {}) {
    const uuid = o.uuid ?? nextUuid();
    const rec = {
      parentUuid: o.parentUuid !== undefined ? o.parentUuid : ctx.lastUuid,
      isSidechain: Boolean(ctx.agentId),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      type,
      ...extra,
      uuid,
      timestamp: o.ts ?? nextTs(),
      userType: 'external',
      entrypoint: 'claude-desktop',
      cwd: o.cwd ?? ctx.cwd,
      sessionId: o.sessionId ?? ctx.sessionId,
      version: ctx.version,
      gitBranch: o.gitBranch ?? ctx.gitBranch,
    };
    ctx.lastUuid = uuid;
    return rec;
  }

  function assistant(msgId, block, o = {}) {
    const message = {
      model: o.model ?? 'claude-opus-5-5',
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: Array.isArray(block) ? block : [block],
      stop_reason: o.stopReason !== undefined ? o.stopReason : null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const extra = { message, requestId: o.requestId ?? `req_${msgId}` };
    if (o.apiBlockIndex !== undefined) extra.apiBlockIndex = o.apiBlockIndex;
    if (o.thinkingDurationMs !== undefined) extra.thinkingDurationMs = o.thinkingDurationMs;
    if (o.extra) Object.assign(extra, o.extra);
    return envelope('assistant', extra, o);
  }

  function userRecord(content, extra = {}, o = {}) {
    const pid = o.promptId !== undefined ? o.promptId : ctx.promptId;
    const fields = { ...(pid ? { promptId: pid } : {}), message: { role: 'user', content }, ...extra };
    return envelope('user', fields, o);
  }

  function attachment(att, o = {}) {
    return envelope('attachment', { attachment: att }, o);
  }

  function system(subtype, extra = {}, o = {}) {
    return envelope('system', { subtype, ...extra }, o);
  }

  const b = {
    ctx,
    get promptId() { return ctx.promptId; },
    setPromptId(id) { ctx.promptId = id; },
    setCwd(cwd) { ctx.cwd = cwd; },
    setBranch(branch) { ctx.gitBranch = branch; },
    tick(ms) { ctx.clock += ms; },
    nowMs() { return ctx.clock; },

    // ---------------------------------------------------------------- assistant
    assistantToolUse({ msgId = 'msg_1', id, name, input = {}, stopReason = 'tool_use', ...o } = {}) {
      const block = { type: 'tool_use', id: id ?? `toolu_${pad(ctx.seq + 1, 6)}`, name, input, caller: { type: 'direct' } };
      return assistant(msgId, block, { stopReason, ...o, extra: { wireToolInputs: { [block.id]: input }, ...(o.extra || {}) } });
    },
    assistantText({ msgId = 'msg_1', text = 'Working on it.', stopReason = null, ...o } = {}) {
      return assistant(msgId, { type: 'text', text }, { stopReason, ...o });
    },
    assistantThinking({ msgId = 'msg_1', text = '', durationMs, stopReason = null, ...o } = {}) {
      return assistant(msgId, { type: 'thinking', thinking: text, signature: 'c2lnbmF0dXJl' },
        { stopReason, thinkingDurationMs: durationMs, ...o });
    },
    /** Old-build line holding several blocks at once. */
    assistantMulti({ msgId = 'msg_1', blocks, stopReason = null, ...o } = {}) {
      return assistant(msgId, blocks, { stopReason, ...o });
    },
    advisorBlocks({ msgId = 'msg_1', ...o } = {}) {
      return assistant(msgId, [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} },
        { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'advisor_redacted_result', encrypted_content: 'eA==' } },
      ], o);
    },
    syntheticApiError({ text = 'API Error: Server is temporarily limiting requests', msgId, ...o } = {}) {
      const id = msgId ?? `5e000000-0000-4000-8000-${pad(ctx.seq + 1, 12)}`;
      return assistant(id, { type: 'text', text }, {
        model: '<synthetic>', stopReason: 'stop_sequence', ...o,
        extra: { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429 },
      });
    },
    syntheticNoResponse({ msgId, ...o } = {}) {
      const id = msgId ?? `5f000000-0000-4000-8000-${pad(ctx.seq + 1, 12)}`;
      return assistant(id, { type: 'text', text: 'No response requested.' }, { model: '<synthetic>', stopReason: 'stop_sequence', ...o });
    },

    // ---------------------------------------------------------------- user
    humanPrompt({ text = 'Please tidy the demo module.', promptId, newTurn = true, ...o } = {}) {
      const pid = promptId ?? (newTurn ? newPromptId() : ctx.promptId);
      ctx.promptId = pid;
      return userRecord(text, {
        permissionMode: 'auto', origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human',
        turnPosition: { promptIndex: 0, turnIndex: 0 },
      }, { ...o, promptId: pid });
    },
    /** pre-2.1.187 prompt without origin. */
    legacyPrompt({ text = 'Old style prompt text.', promptId, ...o } = {}) {
      const pid = promptId ?? newPromptId();
      ctx.promptId = pid;
      return userRecord(text, { permissionMode: 'auto', promptSource: 'sdk' }, { ...o, promptId: pid });
    },
    metaUser({ text = 'Injected skill body.', sourceToolUseID, promptId, ...o } = {}) {
      const pid = promptId ?? ctx.promptId;
      if (pid) ctx.promptId = pid;
      return userRecord([{ type: 'text', text }], { isMeta: true, ...(sourceToolUseID ? { sourceToolUseID } : {}) }, { ...o, promptId: pid });
    },
    commandEcho({ text = '<command-name>/demo</command-name>', promptId, ...o } = {}) {
      const pid = promptId ?? ctx.promptId;
      if (pid) ctx.promptId = pid;
      return userRecord(text, {}, { ...o, promptId: pid });
    },
    peerMessage({ text = 'Note from a peer agent.', promptId, ...o } = {}) {
      const pid = promptId ?? newPromptId();
      ctx.promptId = pid;
      return userRecord(text, { isMeta: true, origin: { kind: 'peer' } }, { ...o, promptId: pid });
    },
    /** First record of a subagent file: the parent's task prompt (no origin, parentUuid null). */
    subagentPrompt({ text = 'Investigate the demo module.', promptId, ...o } = {}) {
      const pid = promptId ?? newPromptId();
      ctx.promptId = pid;
      return userRecord(text, {}, { parentUuid: null, ...o, promptId: pid });
    },
    toolResult({ toolUseId, content = 'ok', isError, toolUseResult, toolDenialKind, endTurn = false, toolEndsTurn = false, ...o } = {}) {
      const block = { tool_use_id: toolUseId, type: 'tool_result', content };
      if (isError !== undefined) block.is_error = isError;
      const extra = { sourceToolAssistantUUID: ctx.lastUuid };
      if (toolUseResult !== undefined) extra.toolUseResult = toolUseResult;
      if (toolDenialKind) extra.toolDenialKind = toolDenialKind;
      if (endTurn) extra.mcpMeta = { _meta: { 'claude/endTurn': true } };
      if (toolEndsTurn) extra.toolEndsTurn = true;
      return userRecord([block], extra, o);
    },
    userRejected({ toolUseId, ...o } = {}) {
      return b.toolResult({
        toolUseId, isError: true, toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use',
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
        ...o,
      });
    },
    interruptMarker({ forTool = true, promptId, ...o } = {}) {
      const text = forTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]';
      return userRecord([{ type: 'text', text }], {}, { ...o, promptId: promptId ?? ctx.promptId });
    },
    compactSummary({ promptId, ...o } = {}) {
      const pid = promptId ?? newPromptId();
      ctx.promptId = pid;
      return userRecord('Summary of the earlier conversation (invented).', {
        isVisibleInTranscriptOnly: true, isCompactSummary: true, turnPosition: { promptIndex: 0, turnIndex: 0 },
      }, { ...o, promptId: pid });
    },
    notification({ toolUseId, taskId = 'a0123456789abcdef', status = 'completed', summary = 'Agent finished', carrier = 'user', promptId, ...o } = {}) {
      const parts = ['<task-notification>', `<task-id>${taskId}</task-id>`];
      if (toolUseId) parts.push(`<tool-use-id>${toolUseId}</tool-use-id>`);
      parts.push('<output-file>/tmp/out.output</output-file>');
      if (status) parts.push(`<status>${status}</status>`);
      parts.push(`<summary>${summary}</summary>`, '<result>invented result</result>', '</task-notification>');
      const text = parts.join('\n');
      if (carrier === 'attachment') {
        return attachment({
          type: 'queued_command', prompt: text, source_uuid: 'c0000000-0000-4000-8000-000000000001',
          delivery_id: 'd1', commandMode: 'task-notification', origin: { kind: 'task-notification' },
          timestamp: new Date(ctx.clock).toISOString(),
        }, o);
      }
      const pid = promptId ?? newPromptId();
      ctx.promptId = pid;
      return userRecord(text, { origin: { kind: 'task-notification' }, promptSource: 'sdk' }, { ...o, promptId: pid });
    },

    // ---------------------------------------------------------------- attachments
    taskReminder({ content = [], ...o } = {}) {
      return attachment({ type: 'task_reminder', content, itemCount: content.length }, o);
    },
    queuedPrompt({ text = 'One more thing while you work.', isMeta = false, origin = { kind: 'human' }, ...o } = {}) {
      const att = {
        type: 'queued_command', prompt: text, source_uuid: 'c0000000-0000-4000-8000-000000000002',
        delivery_id: 'd2', commandMode: 'prompt', timestamp: new Date(ctx.clock).toISOString(),
      };
      if (origin) att.origin = origin;
      const rec = attachment(att, o);
      if (isMeta) rec.isMeta = true;
      return rec;
    },
    hookAttachment(o = {}) {
      return attachment({ type: 'hook_success', hookName: 'PostToolUse' }, o);
    },

    // ---------------------------------------------------------------- system
    stopHookSummary(o = {}) {
      return system('stop_hook_summary', {
        hookCount: 1, hookInfos: [{ command: 'true', durationMs: 3 }], hookErrors: [], hookAdditionalContext: [],
        preventedContinuation: false, stopReason: '', hasOutput: false, level: 'suggestion', toolUseID: 'f0000000-0000-4000-8000-000000000001',
      }, o);
    },
    apiErrorRetry({ attempt = 1, max = 10, status = 529, ...o } = {}) {
      return system('api_error', {
        level: 'error',
        error: { message: `${status} overloaded`, status, formatted: 'overloaded', connection: null, isNetworkDown: false },
        retryInMs: 500, retryAttempt: attempt, maxRetries: max, source: 'request_retry',
      }, o);
    },
    compactBoundary(o = {}) {
      return system('compact_boundary', {
        content: 'Conversation compacted', isMeta: false, level: 'info', logicalParentUuid: ctx.lastUuid,
        compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 10, durationMs: 5 },
      }, { parentUuid: null, ...o });
    },
    modelRefusalFallback(o = {}) {
      return system('model_refusal_fallback', {
        direction: 'retry', scope: 'session', content: 'Retrying with another model.', level: 'warning', trigger: 'refusal',
        originalModel: 'model-a', fallbackModel: 'model-b', retractedMessageUuids: [], refusedUserMessageUuid: null, isMeta: false,
      }, o);
    },
    localCommand(o = {}) {
      return system('local_command', { content: '<local-command-stdout>ok</local-command-stdout>', level: 'info', isMeta: false }, o);
    },

    // ---------------------------------------------------------------- uuid-less sidecars
    customTitle(title = 'Invented title') {
      return { type: 'custom-title', customTitle: title, sessionId: ctx.sessionId };
    },
    agentName(name = 'invented-agent') {
      return { type: 'agent-name', agentName: name, sessionId: ctx.sessionId };
    },
    lastPrompt(text = 'last invented prompt') {
      return { type: 'last-prompt', lastPrompt: text, leafUuid: ctx.lastUuid, sessionId: ctx.sessionId };
    },
    worktreeState(ws) {
      return { type: 'worktree-state', worktreeSession: ws === undefined ? null : ws, sessionId: ctx.sessionId };
    },
    relocated(cwd) {
      return { type: 'relocated', sessionId: ctx.sessionId, relocatedCwd: cwd };
    },
    legacySummary(text = 'Legacy summary') {
      return { type: 'summary', summary: text, leafUuid: ctx.lastUuid };
    },
    queueOperation(content = 'queued text') {
      return { type: 'queue-operation', operation: 'enqueue', timestamp: new Date(ctx.clock).toISOString(), sessionId: ctx.sessionId, content };
    },
    modeRecord() {
      return { type: 'mode', mode: 'normal', sessionId: ctx.sessionId };
    },

    // ---------------------------------------------------------------- tool pairs
    updatePlanUse({ input, ...o } = {}) {
      return b.assistantToolUse({ name: 'mcp__ccd_turn__update_plan', input, ...o });
    },
    updatePlanResult({ toolUseId, text, ...o } = {}) {
      const content = [{ type: 'text', text }];
      return b.toolResult({ toolUseId, content, toolUseResult: content, ...o });
    },
    wrapUpUse({ input = { recap: 'Done with the invented task.' }, ...o } = {}) {
      return b.assistantToolUse({ name: 'mcp__ccd_turn__wrap_up', input, ...o });
    },
    wrapUpResult({ toolUseId, endTurn = true, ...o } = {}) {
      const content = [{ type: 'text', text: 'Shown in the next-step box.' }];
      return b.toolResult({ toolUseId, content, toolUseResult: content, endTurn, ...o });
    },
    askUse({ questions, ...o } = {}) {
      const qs = questions ?? [{
        question: 'Which layout should the demo use?', header: 'Layout', multiSelect: false,
        options: [{ label: 'Grid', description: 'a grid' }, { label: 'List', description: 'a list' }],
      }];
      return b.assistantToolUse({ name: 'AskUserQuestion', input: { questions: qs }, ...o });
    },
    askResult({ toolUseId, answered = true, ...o } = {}) {
      if (!answered) return b.userRejected({ toolUseId, ...o });
      return b.toolResult({
        toolUseId,
        content: 'User has answered your questions: "Which layout should the demo use?"="Grid". You can now continue.',
        toolUseResult: { questions: [], answers: { 'Which layout should the demo use?': 'Grid' } },
        ...o,
      });
    },
    exitPlanUse({ plan = '# Plan\n\n## Step one\n\n## Step two\n', ...o } = {}) {
      return b.assistantToolUse({ name: 'ExitPlanMode', input: { plan, planFilePath: '/tmp/plans/invented.md' }, ...o });
    },
    exitPlanResult({ toolUseId, approved = true, plan = '# Plan', ...o } = {}) {
      if (approved) {
        return b.toolResult({
          toolUseId, content: 'User has approved your plan. You can now start coding.',
          toolUseResult: { plan, isAgent: false, filePath: '/tmp/plans/invented.md', hasTaskTool: true }, ...o,
        });
      }
      return b.toolResult({
        toolUseId, isError: true, toolDenialKind: 'permission-rule',
        content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\ninvented feedback",
        toolUseResult: "Error: The user doesn't want to proceed with this tool use.", ...o,
      });
    },
    agentUse({ description = 'Explore the demo', subagentType = 'Explore', background = false, ...o } = {}) {
      const input = { description, prompt: 'invented prompt', subagent_type: subagentType };
      if (background) input.run_in_background = true;
      return b.assistantToolUse({ name: 'Agent', input, ...o });
    },
    agentAsyncResult({ toolUseId, agentId = 'a0123456789abcdef', ...o } = {}) {
      return b.toolResult({
        toolUseId,
        content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)` }],
        toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'Explore the demo', prompt: 'invented', outputFile: '/tmp/x.output', canReadOutputFile: true },
        ...o,
      });
    },
    agentSyncResult({ toolUseId, agentId = 'a0123456789abcdef', ...o } = {}) {
      return b.toolResult({
        toolUseId,
        content: [{ type: 'text', text: 'Invented agent report.' }, { type: 'text', text: `agentId: ${agentId} (use SendMessage to continue)` }],
        toolUseResult: { status: 'completed', agentId, agentType: 'Explore', content: [{ type: 'text', text: 'Invented agent report.' }], totalDurationMs: 0 },
        ...o,
      });
    },
    workflowAsyncResult({ toolUseId, taskId = 'wtask0001', runId = 'wf_00000000-000', ...o } = {}) {
      return b.toolResult({
        toolUseId, isError: false, content: `Workflow launched in background. Task ID: ${taskId}`,
        toolUseResult: { status: 'async_launched', taskType: 'local_workflow', taskId, runId, summary: 'invented' }, ...o,
      });
    },
    taskCreateUse({ subject = 'Invented task', activeForm, ...o } = {}) {
      const input = { subject, description: 'invented description' };
      if (activeForm) input.activeForm = activeForm;
      return b.assistantToolUse({ name: 'TaskCreate', input, ...o });
    },
    taskCreateResult({ toolUseId, taskId = '1', subject = 'Invented task', ...o } = {}) {
      return b.toolResult({ toolUseId, content: `Task #${taskId} created successfully: ${subject}`, toolUseResult: { task: { id: taskId, subject } }, ...o });
    },
    taskUpdateUse({ taskId = '1', status = 'in_progress', ...o } = {}) {
      return b.assistantToolUse({ name: 'TaskUpdate', input: { taskId, status }, ...o });
    },
    taskUpdateResult({ toolUseId, taskId = '1', ...o } = {}) {
      return b.toolResult({ toolUseId, content: `Updated task #${taskId} status`, toolUseResult: { success: true, taskId, updatedFields: ['status'] }, ...o });
    },
    bashUse({ command = 'ls -la', description = 'List files', ...o } = {}) {
      return b.assistantToolUse({ name: 'Bash', input: { command, description }, ...o });
    },
    bashResult({ toolUseId, ok = true, ...o } = {}) {
      if (ok) {
        return b.toolResult({ toolUseId, content: 'file-a\nfile-b', isError: false, toolUseResult: { stdout: 'file-a', stderr: '', interrupted: false }, ...o });
      }
      return b.toolResult({ toolUseId, content: 'Exit code 1\ninvented failure output', isError: true, toolUseResult: 'Error: Exit code 1', ...o });
    },
  };
  return b;
}
