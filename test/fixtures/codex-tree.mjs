// 지어낸 Codex 기록 트리 (docs/research/codex-format.json 의 구조를 따른 모양, 내용은 지어냄). 탐색, 제목 색인, 층 시험용.
//   <root>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>[_<uuid2>].jsonl   첫 줄 session_meta
//   <root>/session_index.jsonl                                              { id, thread_name, updated_at }
// 첫 줄 뒤의 줄은 시험에 따라 정규화 항목 (SessionCore 로 읽는 시험용 세션, CodexTestSession) 이다. 실제 Codex 레코드
// 매핑은 CodexSession 의 시험이 본다 (test/fixtures/codex.mjs). import 할 때 아무것도 실행하지 않는다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { codex } from '../../src/adapters/codex/index.mjs';
import { createCodexScanner, dayKey } from '../../src/adapters/codex/discover.mjs';
import { CodexTitles } from '../../src/adapters/codex/titles.mjs';
import { SessionCore } from '../../src/core/session-core.mjs';

/** A UUIDv7-shaped thread id from a small number (invented). */
export const cid = (n) => `0199c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const charOf = (n) => `codex-${cid(n)}`;
export const today = () => dayKey(Date.now());

const TS = '2026-10-20T09-00-00';
export const rolloutName = (id, piece = null, ts = TS) => `rollout-${ts}-${id}${piece ? `_${piece}` : ''}.jsonl`;
export const rolloutPath = (root, day, id, piece = null) => path.join(root, 'sessions', ...day.split('/'), rolloutName(id, piece));

/**
 * One session_meta line 0 (research "session_meta"). source: 'vscode' | 'cli' | { parent } (thread_spawn) | 'guardian'
 * | 'review' | any raw source value. Account ids and other identity fields are always present as bait. ts: the line's
 * timestamp (default now: a sub's idle clock starts at its newest record, so a fixed time would end it idle once the
 * wall clock passes it by SUB_IDLE_MS; a test that wants an old line 0 passes `meta: { ts }`).
 */
export function sessionMeta({
  id, cwd = '/work/codex', branch = 'main', source = 'vscode', cliVersion = '0.162.0-alpha.17.2', historyStart = null,
  ordinal = 0, parentField = null, role = 'explorer', extra = {}, ts = new Date().toISOString(),
} = {}) {
  let src = source;
  if (source && typeof source === 'object' && 'parent' in source) {
    src = { subagent: { thread_spawn: { parent_thread_id: source.parent, depth: 1, agent_path: '/root/helper', agent_nickname: 'Nick BAIT_NICK', agent_role: role } } };
  } else if (source === 'guardian') src = { subagent: { other: 'guardian' } };
  else if (source === 'review') src = { subagent: 'review' };
  return {
    timestamp: ts, ordinal, type: 'session_meta',
    payload: {
      id, session_id: id, timestamp: ts, cwd, originator: 'Codex Desktop', cli_version: cliVersion,
      source: src, model_provider: 'openai', base_instructions: { text: 'BAIT_BASE_INSTRUCTIONS' }, history_mode: 'paginated',
      git: branch === null ? null : { branch, commit_hash: 'BAIT_SHA', repository_url: 'https://bait.example.com/BAIT_REPO.git' },
      ...(parentField ? { parent_thread_id: parentField } : {}),
      ...(historyStart !== null ? { subagent_history_start_ordinal: historyStart } : {}),
      creator_user_id: 'BAIT_USER_ID', creator_account_id: 'BAIT_ACCOUNT_ID',
      ...extra,
    },
  };
}

/**
 * Write one rollout: line 0 = sessionMeta(meta), then `items` (normalized items or raw lines). day: 'YYYY/MM/DD'
 * (default today, local). raw: a string written as is instead of the session_meta line (bad shapes). mtimeMs: set the
 * file time. Returns the path.
 */
export async function writeRollout(root, { id, day = today(), piece = null, meta = {}, items = [], raw = null, mtimeMs = null }) {
  const file = rolloutPath(root, day, id, piece);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const head = raw ?? `${JSON.stringify(sessionMeta({ id, ...meta }))}\n`;
  await fsp.writeFile(file, head + items.map((it) => `${JSON.stringify(it)}\n`).join(''));
  if (mtimeMs !== null) await setMtime(file, mtimeMs);
  return file;
}

export async function setMtime(file, ms) {
  await fsp.utimes(file, ms / 1000, ms / 1000);
}

export async function appendLines(file, items) {
  await fsp.appendFile(file, items.map((it) => `${JSON.stringify(it)}\n`).join(''));
}

/** Append session_index.jsonl lines: [[id, thread_name], ...]. */
export async function appendIndex(root, pairs) {
  await fsp.mkdir(root, { recursive: true });
  const lines = pairs.map(([id, name]) => `${JSON.stringify({ id, thread_name: name, updated_at: '2026-10-20T09:00:00Z' })}\n`);
  await fsp.appendFile(path.join(root, 'session_index.jsonl'), lines.join(''));
}

/**
 * Test session: SessionCore reading normalized items, with line 0 (session_meta) mapped to a meta item (cwd, branch),
 * so floors work without the real record mapping. `CodexTestSession.created` keeps the Runner's constructor options.
 */
export class CodexTestSession extends SessionCore {
  static created = [];

  constructor(o = {}) {
    super(o);
    CodexTestSession.created.push(o);
  }

  apply(rec, opts) {
    if (rec?.type === 'session_meta') {
      const p = rec.payload ?? {};
      return super.apply({ k: 'meta', cwd: p.cwd, branch: p.git?.branch, ts: rec.timestamp }, opts);
    }
    return super.apply(rec, opts);
  }
}

/**
 * The real Codex descriptor (discovery, titles, D1 floor hook) with CodexTestSession, so these tests read normalized
 * items and do not depend on the record mapping. Titles refresh on every check (no 250 ms coalescing).
 */
export function codexTestAdapter(over = {}) {
  return {
    ...codex,
    deps: (o = {}) => codex.deps({
      SessionState: CodexTestSession, scan: createCodexScanner(), sidecarWatcher: new CodexTitles({ refreshMs: 0 }), ...over, ...o,
    }),
  };
}
