// Synthetic Antigravity transcript steps shaped like the structure-only examples in docs/research/antigravity-format.json.
// All text, ids, paths and commands are invented; nothing here reads a real ~/.gemini. Side-effect free at import
// (node --test runs every file under test/).
//
// Usage:
//   const b = createAntigravityBuilder({ format: 'full' });            // transcript_full.jsonl: native arg types
//   const t = createAntigravityBuilder({ format: 'truncated' });       // transcript.jsonl: every arg JSON-encoded
//   const steps = [b.userInput('Fix the login bug'), b.planner({ thinking: 'Reading.', calls: [call.viewFile()] }),
//     b.result(), b.planner({ content: 'Done.' })];
//   const jsonl = toJsonl(steps);  const pos = linePositions(steps);   // the byte position of every line
// Every step is { step_index, type, source, status, created_at, ... } and advances a fake clock by `stepMs`. One step
// per line; no message id, turn id, tool-call id or cwd. Free-text fields that must never reach an event carry bait
// (BAIT_*, fake emails, URLs with query strings, `rm -rf`, uuid MCP server names); paths live under a fake home.

export const AG_CONV = '3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6c4e19';
export const AG_CONV2 = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const AG_ID = `antigravity-${AG_CONV}`;
/** Fake home under which the test file paths live: never more than their basename may reach an event. */
export const FAKE_HOME = '/Users/agtester';
export const WORK = '/work/ag-repo';
export const UUID_SERVER = '0b3c5d7e-1f2a-4b6c-8d0e-2f4a6c8e0b1d';

const DEFAULT_START = Date.UTC(2026, 9, 20, 9, 0, 0);

export function toJsonl(steps) {
  return steps.map((s) => JSON.stringify(s)).join('\n') + '\n';
}

/** The byte position (UTF-8) of every line of toJsonl(steps): what AntigravitySession counts, from 0. */
export function linePositions(steps) {
  let pos = 0;
  return steps.map((s) => {
    const p = pos;
    pos += Buffer.byteLength(JSON.stringify(s), 'utf8') + 1;
    return p;
  });
}

/** Deep copy (to apply the same step twice, or to edit one). */
export function cloneStep(step, overrides = {}) {
  return { ...JSON.parse(JSON.stringify(step)), ...overrides };
}

// Labels written by the model on almost every call (old CLI): free text that must never be read.
const LABELS = { toolAction: 'BAIT_TOOL_ACTION rm -rf /', toolSummary: 'BAIT_TOOL_SUMMARY agtester@example.com' };

/** Tool calls in the research shapes (both CLI eras). Arguments are native here; the builder encodes them per format. */
export const call = {
  // old era (view_file / write_to_file, with toolAction / toolSummary)
  viewFile: (p = `${FAKE_HOME}/secret-dir/src/auth/login.ts`) => ({
    name: 'view_file', args: { AbsolutePath: p, StartLine: 1, EndLine: 80, ContentOffset: 0, IsSkillFile: false, ...LABELS },
  }),
  writeToFile: (p = `${FAKE_HOME}/secret-dir/src/auth/session.ts`) => ({
    name: 'write_to_file', args: {
      TargetFile: p, CodeContent: 'BAIT_FILE_CONTENT export const k = 1;', Overwrite: true, Description: 'BAIT_DESCRIPTION',
      ArtifactMetadata: { Summary: 'BAIT_ARTIFACT_SUMMARY', UserFacing: false, RequestFeedback: false }, ...LABELS,
    },
  }),
  replace: (p = `${FAKE_HOME}/secret-dir/src/auth/token.ts`) => ({
    name: 'replace_file_content', args: {
      TargetFile: p, TargetContent: 'BAIT_OLD_TEXT', ReplacementContent: 'BAIT_NEW_TEXT', StartLine: 3, EndLine: 9,
      AllowMultiple: false, Instruction: 'BAIT_INSTRUCTION', Description: 'BAIT_DESCRIPTION', ...LABELS,
    },
  }),
  multiReplace: (p = `${FAKE_HOME}/secret-dir/src/auth/guard.ts`) => ({
    name: 'multi_replace_file_content', args: {
      TargetFile: p, ReplacementChunks: [{ TargetContent: 'BAIT_OLD_TEXT', ReplacementContent: 'BAIT_NEW_TEXT' }],
      Instruction: 'BAIT_INSTRUCTION', Description: 'BAIT_DESCRIPTION', ...LABELS,
    },
  }),
  grep: (q = 'refreshToken', p = `${FAKE_HOME}/secret-dir/src`) => ({
    name: 'grep_search', args: { Query: q, SearchPath: p, Includes: ['*.ts'], IsRegex: false, CaseInsensitive: true, MatchPerLine: true, ...LABELS },
  }),
  findByName: (pattern = '*.spec.ts', dir = `${FAKE_HOME}/secret-dir/test`) => ({
    name: 'find_by_name', args: { Pattern: pattern, SearchDirectory: dir, MaxDepth: 4, ...LABELS },
  }),
  listDir: (p = `${FAKE_HOME}/secret-dir/src`) => ({ name: 'list_dir', args: { DirectoryPath: p, ...LABELS } }),
  runCommand: (cmd = 'npm test -- --token=BAIT_SECRET', cwd = WORK, extra = {}) => ({
    name: 'run_command', args: { CommandLine: cmd, Cwd: cwd, WaitMsBeforeAsync: 500, BypassSandbox: false, ...LABELS, ...extra },
  }),
  commandStatus: () => ({ name: 'command_status', args: { CommandId: 'BAIT_COMMAND_ID', WaitDurationSeconds: 5, OutputCharacterCount: 2000, ...LABELS } }),
  manageTask: (action = 'status') => ({ name: 'manage_task', args: { Action: action, TaskId: 'BAIT_TASK_ID', ...LABELS } }),
  searchWeb: (query = 'oauth refresh token rotation', domain = 'BAIT-domain.example') => ({ name: 'search_web', args: { query, domain, ...LABELS } }),
  readUrl: (url = 'https://docs.example.com/oauth?key=BAIT_QUERY_SECRET') => ({ name: 'read_url_content', args: { Url: url, ...LABELS } }),
  mcp: (server = 'github', tool = 'get_issue') => ({
    name: 'call_mcp_tool', args: { ServerName: server, ToolName: tool, Arguments: { body: 'BAIT_MCP_ARGUMENT', owner: 'agtester@example.com' }, ...LABELS },
  }),
  askQuestion: (questions = [{ question: 'Which database should the session store use?', options: ['Postgres', 'SQLite', 'Redis'], is_multi_select: false }]) => ({
    name: 'ask_question', args: { questions, ...LABELS },
  }),
  schedule: () => ({ name: 'schedule', args: { DurationSeconds: 120, TimerCondition: 'BAIT_TIMER_CONDITION', Prompt: 'BAIT_SCHEDULE_PROMPT', ...LABELS } }),
  defineSubagent: () => ({ name: 'define_subagent', args: { Name: 'helper', Description: 'BAIT_DESC', SystemPrompt: 'BAIT_SYS_PROMPT' } }),
  invokeSubagent: () => ({ name: 'invoke_subagent', args: { TypeName: 'research', Role: 'BAIT_ROLE', Prompt: 'BAIT_SUB_PROMPT' } }),
  sendMessage: () => ({ name: 'send_message', args: { Recipient: 'BAIT_RECIPIENT', Message: 'BAIT_MESSAGE' } }),
  listResources: () => ({ name: 'list_resources', args: { ServerName: 'BAIT_SERVER' } }),
  readResource: () => ({ name: 'read_resource', args: { ServerName: 'BAIT_SERVER', Uri: 'BAIT_URI' } }),
  manageSubagents: () => ({ name: 'manage_subagents', args: { Action: 'list', ...LABELS } }),
  browserSubagent: () => ({
    name: 'browser_subagent', args: {
      Task: 'BAIT_BROWSER_TASK', TaskName: 'BAIT_TASK_NAME', TaskSummary: 'BAIT_TASK_SUMMARY', RecordingName: 'BAIT_REC',
      ReusedSubagentId: 'BAIT_SUBAGENT_ID', MediaPaths: [`${FAKE_HOME}/secret-dir/shot.png`],
    },
  }),
  generateImage: () => ({ name: 'generate_image', args: { Prompt: 'BAIT_IMAGE_PROMPT', ImageName: 'BAIT_IMAGE_NAME', AspectRatio: '16:9', ...LABELS } }),
  listPermissions: () => ({ name: 'list_permissions', args: {} }),
  // 1.4.x era (read_file / write_file, no labels)
  readFile: (p = `${FAKE_HOME}/secret-dir/src/auth/login.ts`) => ({ name: 'read_file', args: { Path: p, StartLine: 1, EndLine: 80 } }),
  writeFile: (p = `${FAKE_HOME}/secret-dir/src/auth/session.ts`) => ({
    name: 'write_file', args: { Path: p, Content: 'BAIT_FILE_CONTENT export const k = 2;', Overwrite: true },
  }),
  // 1.4.x edit (found by the real-data count of the integration, not in the research): Path, Target, Replacement
  editFile: (p = `${FAKE_HOME}/secret-dir/src/auth/token.ts`) => ({
    name: 'edit_file', args: { Path: p, Target: 'BAIT_OLD_TEXT', Replacement: 'BAIT_NEW_TEXT', ArtifactMetadata: { Summary: 'BAIT_ARTIFACT_SUMMARY' } },
  }),
  unknown: (name = 'future_tool') => ({ name, args: { Anything: 'BAIT_UNKNOWN_ARG', Path: `${FAKE_HOME}/secret-dir/x.ts` } }),
};

/** The metadata blocks that follow the request in every real USER_INPUT (all bait: environment context). */
export function userContent(text, { settings = false, plan = false } = {}) {
  let s = `<USER_REQUEST>\n${text}\n</USER_REQUEST>`;
  s += '<ADDITIONAL_METADATA>\nBAIT_METADATA The current local time is 09:00. Active document: '
    + `${FAKE_HOME}/secret-dir/src/auth/login.ts. Cursor on line 12. Contact agtester@example.com.\n</ADDITIONAL_METADATA>`;
  if (settings) s += '<USER_SETTINGS_CHANGE>\nBAIT_SETTINGS The user changed the model.\n</USER_SETTINGS_CHANGE>';
  if (plan) s += '<PLAN>\nBAIT_PLAN_BLOCK 1. do the thing\n</PLAN>';
  return s;
}

/**
 * @param {{ format?: 'full'|'truncated', start?: number, stepMs?: number, cut?: number }} o
 *   format 'full' (transcript_full.jsonl, native argument types) or 'truncated' (transcript.jsonl: every argument value
 *   is a JSON-encoded string; content / thinking longer than `cut` chars are cut and named in truncated_fields).
 */
export function createAntigravityBuilder({ format = 'full', start = DEFAULT_START, stepMs = 1000, cut = 3000 } = {}) {
  const ctx = { t: start, idx: 0 };
  const truncated = format === 'truncated';

  function step(type, { source = 'MODEL', status = 'DONE', index, ...extra } = {}) {
    ctx.t += stepMs;
    const s = { step_index: index ?? ctx.idx, type, source, status, created_at: new Date(ctx.t).toISOString() };
    if (index === undefined) ctx.idx += 1;
    const fields = [];
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      if (truncated && (k === 'content' || k === 'thinking') && typeof v === 'string' && v.length > cut) {
        s[k] = v.slice(0, cut);
        fields.push(k);
      } else {
        s[k] = v;
      }
    }
    if (truncated && fields.length) s.truncated_fields = fields;
    return s;
  }

  // transcript.jsonl: every argument value JSON-encoded (paths start with a quote, ints as "10", bools as "false").
  // cutArgs: argument names whose encoded value is cut mid-string (a truncated tool_calls field).
  function encodeCall(c, cutArgs = []) {
    if (!truncated) return { name: c.name, args: c.args };
    const args = {};
    for (const [k, v] of Object.entries(c.args)) {
      const enc = JSON.stringify(v);
      args[k] = cutArgs.includes(k) ? enc.slice(0, Math.max(2, Math.floor(enc.length / 2))) : enc;
    }
    return { name: c.name, args };
  }

  return {
    format,
    /** The clock (ms) of the last step. */
    get now() { return ctx.t; },
    /** USER_INPUT (source USER_EXPLICIT): the request wrapped in USER_REQUEST + metadata blocks, or `raw` content. */
    userInput(text = 'Fix the login bug', { raw, settings, plan, ...o } = {}) {
      return step('USER_INPUT', { source: 'USER_EXPLICIT', content: raw ?? userContent(text, { settings, plan }), ...o });
    },
    /** PLANNER_RESPONSE: { content?, thinking?, calls?: call.*()[], cutArgs?, tokens? }. */
    planner({ content, thinking, calls, cutArgs = [], tokens = true, ...o } = {}) {
      const extra = { content, thinking, ...o };
      if (calls !== undefined) extra.tool_calls = calls.map((c) => encodeCall(c, cutArgs));
      if (tokens) Object.assign(extra, { input_tokens: 5120, output_tokens: 210, cache_read_tokens: 4096 });
      const s = step('PLANNER_RESPONSE', extra);
      if (truncated && cutArgs.length) s.truncated_fields = [...(s.truncated_fields ?? []), 'tool_calls'];
      return s;
    },
    /** A result step (GENERIC by default; typed results in older CLI versions). The content is a tool output body. */
    result({ type = 'GENERIC', status = 'DONE', error, exitCode, content = 'BAIT_RESULT_BODY total 12 agtester@example.com', ...o } = {}) {
      return step(type, { status, content, error, exit_code: exitCode, ...o });
    },
    /** RUN_COMMAND typed result (older CLI): exit_code when the command finished, none while RUNNING. */
    runResult({ exitCode = 0, status = 'DONE', ...o } = {}) {
      return step('RUN_COMMAND', { status, content: 'BAIT_COMMAND_OUTPUT rm -rf build', exit_code: status === 'RUNNING' ? undefined : exitCode, ...o });
    },
    systemMessage(o = {}) {
      return step('SYSTEM_MESSAGE', { source: 'SYSTEM', content: 'The following is a BAIT_SYSTEM_MESSAGE system message about agtester@example.com', ...o });
    },
    conversationHistory(o = {}) {
      return step('CONVERSATION_HISTORY', { source: 'SYSTEM', content: '', ...o });
    },
    checkpoint(o = {}) {
      return step('CHECKPOINT', { source: 'SYSTEM', content: 'BAIT_CHECKPOINT summary from a compaction of the conversation\nline two', ...o });
    },
    errorMessage(error = 'Model provider overloaded, retrying\nBAIT_ERROR_DETAIL agtester@example.com', o = {}) {
      return step('ERROR_MESSAGE', { source: 'SYSTEM', status: 'ERROR', error, ...o });
    },
    /** Any step type (unknown future types, KNOWLEDGE_ARTIFACTS, ...). */
    step(type, o = {}) {
      return step(type, o);
    },
  };
}

/** The tool id AntigravitySession gives call `i` of the line at byte position `pos` (conversation AG_CONV). */
export function toolId(pos, i, conv = AG_CONV) {
  return `${conv}:${pos}:${i}`;
}

/**
 * A long mixed conversation in one builder's format: three turns, both CLI tool eras, typed and GENERIC results, a hidden
 * call, background results, a missing result closed by the planner line after a checkpoint, an ERROR_MESSAGE, passing
 * steps, an unknown result type, and three calls still waiting at the end (an unknown tool, command_status, manage_task).
 */
export function mixedSteps(b) {
  return [
    b.userInput('Fix the login bug'), b.conversationHistory(),
    b.planner({ thinking: 'Reading the auth module first.', calls: [call.viewFile(), call.grep()] }),
    b.result({ type: 'VIEW_FILE' }), b.result({ type: 'GREP_SEARCH' }),
    b.planner({ content: 'Found the expiry check.', calls: [call.replace(), call.runCommand('npm test', WORK)] }),
    b.result({ type: 'CODE_ACTION' }), b.runResult({ exitCode: 1 }),
    b.planner({ thinking: 'The tests fail. Start the dev server.', calls: [call.runCommand('npm run dev', WORK), call.listPermissions(), call.schedule()] }),
    b.runResult({ status: 'RUNNING' }), b.result(), b.result({ status: 'RUNNING' }),
    b.errorMessage(),
    b.planner({ calls: [call.readFile(), call.writeFile()] }), b.result(), // write_file has no result: abandoned at the planner after the checkpoint
    b.checkpoint(),
    b.planner({ content: 'Done. The token check is fixed.' }), b.systemMessage(),
    b.userInput('Now ask me about the store', { settings: true }),
    b.planner({ calls: [call.askQuestion()] }), b.result({ type: 'ASK_QUESTION' }),
    b.planner({ calls: [call.mcp('github', 'get_issue'), call.searchWeb(), call.readUrl()] }),
    b.result({ type: 'MCP_TOOL', status: 'ERROR', error: 'MCP server unavailable\nBAIT_DETAIL' }), b.result(), b.step('FUTURE_RESULT'),
    b.planner({ content: 'Here is what I found.', thinking: 'Summarize.' }),
    b.userInput('One more', { plan: true }),
    b.planner({ calls: [call.findByName(), call.listDir(), call.unknown(), call.commandStatus(), call.manageTask()] }),
    b.result(), b.step('SEARCH_WEB'),
  ];
}
