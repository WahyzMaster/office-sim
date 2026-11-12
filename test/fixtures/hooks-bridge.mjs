// Shared by test/hooks-bridge*.test.mjs: a HooksBridge with a fake store and a fake clock, and invented hook bodies
// shaped like the Claude Code hook reference describes them. The fake store pushes like the wrapper in
// src/server-http.mjs: the event is kept first, then the bridge observes it. Nothing here opens a socket or a file.
import os from 'node:os';
import path from 'node:path';
import { HooksBridge } from '../../src/hooks-bridge.mjs';

export const ROOT = path.join(os.tmpdir(), 'office-sim-hooks-unit', 'projects');
export const SID = '0a1b2c3d-1111-4222-8333-444455556666';
export const SUB = 'a1b2c3d4e5f607182';
export const TRANSCRIPT = path.join(ROOT, '-work-demo', `${SID}.jsonl`);
export const T0 = Date.parse('2026-01-01T00:00:00.000Z');
export const CLAUDE = 'claude-code';
export const WAIT_KEYS = ['sessionId', 'toolUseId', 'ts', 'type', 'waiting'];
export const OK = { status: 200, body: {} };

export function setup({ chars = { [SID]: { agent: CLAUDE, sid: SID, kind: 'main' } }, ...opts } = {}) {
  const clock = { ms: T0 };
  const events = [];
  const store = {
    byChar: new Map(Object.entries(chars)),
    push(ev) { events.push(ev); bridge.observeEvent(ev); },
  };
  const bridge = new HooksBridge({ store, claudeRoot: ROOT, now: () => clock.ms, ...opts });
  const start = (toolUseId, tool = 'Bash', extra = {}) => store.push({
    type: 'tool_start', sessionId: SID, ts: new Date(clock.ms).toISOString(), toolUseId, tool, summary: tool, ...extra,
  });
  const end = (toolUseId, sessionId = SID) => store.push({ type: 'tool_end', sessionId, ts: new Date(clock.ms).toISOString(), toolUseId, ok: true });
  const waits = () => events.filter((e) => e.type === 'tool_wait');
  return { clock, events, store, bridge, start, end, waits };
}

export const permission = (extra = {}) => ({
  session_id: SID, transcript_path: TRANSCRIPT, cwd: '/work/demo', permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...extra,
});
export const notification = (extra = {}) => ({
  session_id: SID, transcript_path: TRANSCRIPT, cwd: '/work/demo', hook_event_name: 'Notification',
  notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', ...extra,
});
