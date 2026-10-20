// Adapter conformance harness (ADAPTERS 10). Given an adapter descriptor and a fixture root, it starts the real server
// with that adapter registered through the P5a test hook (start({ adapters, roots, agents })), collects SSE + /state and
// checks the wire against CONTRACT 2 and section 5. Reusable for every new adapter (P5c-P5e). Side-effect free at import
// (node --test runs every file under test/).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../../src/server.mjs';
import { ADAPTERS } from '../../src/adapters/index.mjs';
import { publicSessionId, agentScopedId } from '../../src/session-identity.mjs';
import { request, sse, until } from './sse.mjs';

const PUBLIC = fileURLToPath(new URL('../../public', import.meta.url));

// CONTRACT 2: per-type fields besides type/sessionId/ts. awaitsApproval is replay-only (section 7), so never live.
const FIELDS = {
  session: { required: ['agent', 'project', 'projectLabel', 'title', 'branch', 'worktree', 'isSubagent', 'parentSessionId'], optional: ['agentType'] },
  session_end: { required: ['reason'], optional: [] },
  prompt: { required: ['text'], optional: [] },
  tool_start: { required: ['toolUseId', 'tool', 'summary'], optional: ['room', 'question', 'options', 'background'] },
  tool_end: { required: ['toolUseId', 'ok'], optional: ['errorKind', 'error'] },
  thinking: { required: ['text', 'durationMs'], optional: [] },
  say: { required: ['text'], optional: [] },
  plan: { required: ['items', 'source'], optional: [] },
  turn_end: { required: ['reason'], optional: [] },
  system: { required: ['kind', 'text'], optional: [] },
};
const COMMON = new Set(['type', 'sessionId', 'ts']);
const ROOMS = new Set(['archive', 'dev', 'server', 'research', 'meeting', 'desk', 'lounge', 'here']);
const END_REASONS = new Set(['done', 'idle']);
const ERROR_KINDS = new Set(['failed', 'denied', 'interrupted', 'abandoned']);
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const PLAN_SOURCES = new Set(['update_plan', 'tasks', 'exit_plan']);
const TURN_REASONS = new Set(['stop_hook', 'api_error', 'interrupt', 'wrap_up', 'next_turn', 'end_turn']);
const SYSTEM_KINDS = new Set(['api_error', 'compact', 'refusal']);

const cps = (s) => Array.from(s).length;
const text = (v, max, { empty = false } = {}) => typeof v === 'string' && (empty || v !== '') && cps(v) <= max;
const label = (v) => v === null || text(v, 60);

/** Field checks of one event; returns the problems (strings). */
function eventProblems(ev, agent) {
  const out = [];
  const bad = (what) => out.push(`${ev?.type ?? '?'} ${ev?.sessionId ?? '?'}: ${what}`);
  const spec = FIELDS[ev?.type];
  if (!spec) return [`unknown event type ${JSON.stringify(ev?.type)}`];
  for (const k of Object.keys(ev)) if (!COMMON.has(k) && !spec.required.includes(k) && !spec.optional.includes(k)) bad(`field ${k} not allowed`);
  for (const k of spec.required) if (!(k in ev)) bad(`missing ${k}`);
  if (!agentScopedId(agent, ev.sessionId)) bad('sessionId is not an id of this agent (D2)');
  if (typeof ev.ts !== 'string' || !Number.isFinite(Date.parse(ev.ts))) bad('ts is not a timestamp');
  switch (ev.type) {
    case 'session': {
      if (ev.agent !== agent) bad(`agent ${JSON.stringify(ev.agent)}`);
      if (typeof ev.project !== 'string' || typeof ev.projectLabel !== 'string') bad('project');
      if (!text(ev.title, 80)) bad('title');
      if (!label(ev.branch) || !label(ev.worktree)) bad('branch/worktree');
      if (typeof ev.isSubagent !== 'boolean') bad('isSubagent');
      if (ev.isSubagent ? !(publicSessionId(ev.parentSessionId) && agentScopedId(agent, ev.parentSessionId)) : ev.parentSessionId !== null) bad('parentSessionId');
      if ('agentType' in ev && (!ev.isSubagent || !label(ev.agentType))) bad('agentType');
      break;
    }
    case 'session_end': if (!END_REASONS.has(ev.reason)) bad('reason'); break;
    case 'prompt': if (!text(ev.text, 80)) bad('text'); break;
    case 'say': if (!text(ev.text, 100)) bad('text'); break;
    case 'thinking':
      if (ev.text !== null && !text(ev.text, 100)) bad('text');
      if (ev.durationMs !== null && !(Number.isFinite(ev.durationMs) && ev.durationMs >= 0)) bad('durationMs');
      break;
    case 'tool_start': {
      if (!text(ev.toolUseId, 256) || typeof ev.tool !== 'string' || ev.tool === '' || !text(ev.summary, 80)) bad('toolUseId/tool/summary');
      if ('room' in ev && !ROOMS.has(ev.room)) bad('room');
      if ('background' in ev && ev.background !== true) bad('background');
      if (('question' in ev) !== ('options' in ev)) bad('question and options come together (ask tools)');
      if ('question' in ev && ev.question !== null && !text(ev.question.replace(/ \(\+\d+\)$/, ''), 160)) bad('question');
      if ('options' in ev && !(Array.isArray(ev.options) && ev.options.length <= 4 && ev.options.every((o) => text(o, 30)))) bad('options');
      break;
    }
    case 'tool_end':
      if (typeof ev.ok !== 'boolean') bad('ok');
      else if (ev.ok && ('errorKind' in ev || 'error' in ev)) bad('error fields on an ok tool_end');
      else if (!ev.ok && (!ERROR_KINDS.has(ev.errorKind) || !text(ev.error, 120))) bad('errorKind/error');
      break;
    case 'plan': {
      if (!PLAN_SOURCES.has(ev.source) || !Array.isArray(ev.items)) { bad('source/items'); break; }
      if (ev.source === 'exit_plan' && ev.items.length > 6) bad('exit_plan has more than 6 items');
      for (const it of ev.items) {
        const keys = it && typeof it === 'object' ? Object.keys(it).sort().join(',') : '';
        if (keys !== 'content,status' || !text(it.content, 80, { empty: true }) || !PLAN_STATUSES.has(it.status)) bad(`plan item ${JSON.stringify(it)}`);
      }
      break;
    }
    case 'turn_end': if (!TURN_REASONS.has(ev.reason)) bad('reason'); break;
    case 'system': if (!SYSTEM_KINDS.has(ev.kind) || !text(ev.text, 120)) bad('kind/text'); break;
    default: break;
  }
  return out;
}

const toolKey = (ev) => `${ev.sessionId}|${ev.toolUseId}`;

/**
 * The pure conformance checks. Returns the list of problems ([] = conformant).
 * @param {{ agent: string, stream: object[], state: object[], raw?: string[], bait?: string[], mustSee?: string[] }} o
 *   stream: the events in wire order (the SSE snapshot's events, then live events, up to the /state seq);
 *   state: the /state events; raw: every wire text (SSE frames, /state body) for the privacy scan.
 */
export function conformanceProblems({ agent, stream, state, raw = [], bait = [], mustSee = ['session'] }) {
  const out = [];
  const announced = new Set();
  const open = new Map(); // toolKey -> tool_start event
  const ended = new Set();
  for (const ev of stream) {
    out.push(...eventProblems(ev, agent));
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'session') {
      announced.add(ev.sessionId);
      ended.delete(ev.sessionId);
    } else if (!announced.has(ev.sessionId)) {
      out.push(`${ev.type} ${ev.sessionId}: event before the character's session event`);
    }
    if (ev.type === 'tool_start') open.set(toolKey(ev), ev);
    else if (ev.type === 'tool_end') {
      if (!open.has(toolKey(ev))) out.push(`tool_end ${toolKey(ev)} has no earlier tool_start`);
      open.delete(toolKey(ev));
    } else if (ev.type === 'session_end') {
      ended.add(ev.sessionId);
      for (const k of [...open.keys()]) if (k.startsWith(`${ev.sessionId}|`)) open.delete(k);
    }
  }
  for (const t of mustSee) if (!stream.some((ev) => ev?.type === t)) out.push(`no ${t} event on the wire`);
  // /state: the same events, live characters only, and exactly the tools that are still open (with their ask fields)
  for (const ev of state) out.push(...eventProblems(ev, agent).map((p) => `/state ${p}`));
  const stateTools = new Map(state.filter((ev) => ev?.type === 'tool_start').map((ev) => [toolKey(ev), ev]));
  for (const [k, ev] of open) {
    if (ended.has(ev.sessionId)) continue;
    if (!stateTools.has(k)) out.push(`open tool ${k} missing from /state`);
    else if (JSON.stringify(stateTools.get(k)) !== JSON.stringify(ev)) out.push(`open tool ${k} differs in /state`);
  }
  for (const k of stateTools.keys()) if (!open.has(k)) out.push(`/state tool ${k} already ended (or never started) on the wire`);
  for (const ev of state) {
    if (ev?.sessionId && ended.has(ev.sessionId)) out.push(`/state has ended character ${ev.sessionId}`);
    else if (ev?.sessionId && !announced.has(ev.sessionId)) out.push(`/state has character ${ev.sessionId} never announced on the wire`);
  }
  // section 5: no bait anywhere on the wire; internal hint items never leave the server
  const all = raw.join('\n');
  for (const b of bait) if (all.includes(b)) out.push(`privacy bait on the wire: ${JSON.stringify(b)}`);
  if (all.includes('"hint"')) out.push('an internal hint item reached the wire');
  return out;
}

/** Wrap an adapter so every path its scan reports or its Tailer reads is recorded (scan allow-list check). */
function watched(adapter, opened) {
  return {
    ...adapter,
    async deps(over) {
      const d = await adapter.deps(over);
      class RecordingTailer extends d.Tailer {
        readAll(ref, ...rest) { opened.add(ref.path); return super.readAll(ref, ...rest); }
        poll(ref, ...rest) { opened.add(ref.path); return super.poll(ref, ...rest); }
      }
      const scan = async (...args) => {
        const refs = await d.scan(...args);
        for (const r of refs) opened.add(r.path);
        return refs;
      };
      return { ...d, Tailer: RecordingTailer, scan };
    },
  };
}

/**
 * Run the conformance checks for one adapter against one fixture root (written before the call).
 * @param {{ id: string, deps: Function }} adapter  registered as `adapters[adapter.id]`; the id must be in KNOWN_AGENTS.
 * @param {string} fixtureRoot  the adapter root (a temp dir with invented content; never a real ~/.codex, ~/.grok, ~/.gemini).
 * @param {{ live?: (ctx) => Promise<void>, bait?: string[], neverOpen?: string[], mustSee?: string[], timeoutMs?: number }} options
 *   live: appends lines after attach and waits for its own markers; ctx = { app, es, waitFor(pred, ms) }.
 *   neverOpen: fixture paths (auth files, raw prompt history ...) the scan must never report and the Tailer never read.
 * @returns {Promise<{ stream, state, frames, opened: Set<string>, logs: string[], stats }>}
 */
export async function runConformance(adapter, fixtureRoot, options = {}) {
  const { live = null, bait = [], neverOpen = [], mustSee = ['session'], timeoutMs = 4000 } = options;
  const id = adapter.id;
  const opened = new Set();
  const logs = [];
  const app = await start({
    port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 100, idleMs: 50, activeMinutes: 30,
    root: path.join(fixtureRoot, '.no-claude-root'), // claude-code is not selected; never the real default root
    agents: [id], roots: { [id]: fixtureRoot }, adapters: { ...ADAPTERS, [id]: watched(adapter, opened) },
    log: (line) => logs.push(line),
  });
  let es = null;
  try {
    assert.deepEqual(app.agents, [id], 'the adapter under test is the only one running');
    await app.ready;
    es = await sse(app.port);
    const snap = await es.next((fr) => fr.data?.type === 'snapshot', timeoutMs);
    const waitFor = (pred, ms = timeoutMs) => es.next((fr) => fr.data !== null && fr.data.type !== 'snapshot' && pred(fr.data), ms);
    if (live) await live({ app, es, waitFor });
    const stateRes = await request(app.port, { path: '/state' });
    const state = JSON.parse(stateRes.body);
    // the stream up to the /state seq: wait until those frames arrived, ignore later ones
    const evFrames = () => es.frames.filter((fr) => fr.data && fr.data.type !== 'snapshot' && fr.data.type !== 'config');
    await until(() => Number(snap.id) >= state.seq || evFrames().some((fr) => Number(fr.id) >= state.seq), timeoutMs);
    const stream = [...snap.data.events,
      ...evFrames().filter((fr) => Number(fr.id) > Number(snap.id) && Number(fr.id) <= state.seq).map((fr) => fr.data)];
    const problems = conformanceProblems({
      agent: id, stream, state: state.events, raw: [...es.frames.map((fr) => fr.raw), stateRes.body], bait, mustSee,
    });
    for (const p of neverOpen) if (opened.has(p)) problems.push(`opened a file outside the allow-list: ${path.basename(p)}`);
    const stats = app.stats();
    if (stats.applyErrors || stats.badLines || stats.rejectedRefs) problems.push(`runner counters ${JSON.stringify(stats)}`);
    for (const line of logs) if (/rejected ref|failed/.test(line)) problems.push(`log: ${line}`);
    assert.deepEqual(problems, [], `${id} conformance`);
    return { stream, state: state.events, frames: es.frames, opened, logs, stats };
  } finally {
    es?.close();
    await app.close();
  }
}
