// 지어낸 Grok 세션 폴더 트리 (docs/research/grok-format.json 의 구조를 따른 모양, 내용은 지어냄). 탐색, 메타 파일, 층 시험용.
//   <root>/sessions/<URL 인코딩한 cwd>/<uuid>/updates.jsonl, summary.json, subagents/<자식 uuid>/
// 기록 줄은 시험에 따라 정규화 항목 (SessionCore 로 읽는 시험용 세션) 이다. 실제 Grok 레코드 매핑은 GrokSession 의 시험이 본다.
// import 할 때 아무것도 실행하지 않는다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { grok } from '../../src/adapters/grok/index.mjs';
import { createGrokScanner } from '../../src/adapters/grok/discover.mjs';
import { SessionCore } from '../../src/core/session-core.mjs';

/** A UUIDv7-shaped id from a small number (invented). */
export const gid = (n) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const charOf = (n) => `grok-${gid(n)}`;
export const groupOf = (cwd) => encodeURIComponent(cwd);

export const sessionDir = (root, group, id) => path.join(root, 'sessions', group, id);
export const transcriptOf = (root, group, id) => path.join(sessionDir(root, group, id), 'updates.jsonl');

export function summaryJson({ id, cwd = null, title = null, branch = null, extra = {} } = {}) {
  return JSON.stringify({
    info: { id, ...(cwd ? { cwd } : {}) },
    ...(title ? { generated_title: title, session_summary: title } : {}),
    ...(branch ? { head_branch: branch } : {}),
    current_model_id: 'model-x', agent_name: 'profile-x', ...extra,
  });
}

/**
 * Write one session folder. items: JSONL lines (objects); summary: summary.json fields ({ cwd, title, branch, extra })
 * or null for none; children: child ids named under subagents/ (directories only); mtimeMs: set the transcript mtime;
 * events: events.jsonl lines (objects, or strings written as they are plus a newline) or one raw string written as is
 * (partial or garbage lines), or null for no events.jsonl.
 */
export async function writeSession(root, { group, id, items = [], summary = null, children = [], mtimeMs = null, events = null }) {
  const dir = sessionDir(root, group, id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'updates.jsonl');
  await fsp.writeFile(file, items.map((it) => `${JSON.stringify(it)}\n`).join(''));
  if (summary) await fsp.writeFile(path.join(dir, 'summary.json'), summaryJson({ id, ...summary }));
  if (events !== null && events !== undefined) await fsp.writeFile(path.join(dir, 'events.jsonl'), eventsJsonl(events));
  for (const child of children) await fsp.mkdir(path.join(dir, 'subagents', child), { recursive: true });
  if (mtimeMs !== null) await fsp.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

/** events.jsonl text: an array of lines (objects are JSON-encoded, strings kept) or one raw string. */
export function eventsJsonl(events) {
  if (typeof events === 'string') return events;
  return events.map((it) => `${typeof it === 'string' ? it : JSON.stringify(it)}\n`).join('');
}

export async function appendLines(file, items) {
  await fsp.appendFile(file, items.map((it) => `${JSON.stringify(it)}\n`).join(''));
}

/**
 * The real Grok descriptor (discovery, sidecars, D1 floor hook) with SessionCore as the session class, so these tests
 * read normalized items and do not depend on the record mapping. linkGraceMs 0: new folders are classified at once.
 */
export function grokTestAdapter(over = {}) {
  return {
    ...grok,
    deps: (o = {}) => grok.deps({ SessionState: SessionCore, scan: createGrokScanner({ linkGraceMs: 0 }), ...over, ...o }),
  };
}
