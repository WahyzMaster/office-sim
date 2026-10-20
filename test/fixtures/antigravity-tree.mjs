// 지어낸 Antigravity 폴더 트리 (docs/research/antigravity-format.json 의 구조를 따른 모양, 내용은 지어냄). 탐색, 메타 파일,
// 층 시험용:
//   <root>/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl | transcript.jsonl
//   <root>/antigravity-cli/jetbox_summaries_proto.pb, annotations/<uuid>.pbtxt, brain/<uuid>/task.md
//   <root>/antigravity-ide/... (예전 IDE, 요약 파일은 agyhub_summaries_proto.pb)
// 기록 줄은 시험에 따라 정규화 항목 (SessionCore 로 읽는 시험용 세션) 이다. 실제 단계(step) 매핑은 AntigravitySession 의
// 시험이 본다. 요약 proto 는 조사의 (추정) 필드 번호로 만든다. import 할 때 아무것도 실행하지 않는다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { antigravity } from '../../src/adapters/antigravity/index.mjs';
import { createAntigravityScanner } from '../../src/adapters/antigravity/discover.mjs';
import { SessionCore } from '../../src/core/session-core.mjs';

/** A conversation uuid from a small number (invented). */
export const aid = (n) => `a9a90000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const charOf = (n) => `antigravity-${aid(n)}`;
export const CLI = 'antigravity-cli';
export const IDE = 'antigravity-ide';

export const baseDir = (root, base = CLI) => path.join(root, base);
export const brainDir = (root, id, base = CLI) => path.join(root, base, 'brain', id);
export const logsDir = (root, id, base = CLI) => path.join(brainDir(root, id, base), '.system_generated', 'logs');
export const fullOf = (root, id, base = CLI) => path.join(logsDir(root, id, base), 'transcript_full.jsonl');
export const plainOf = (root, id, base = CLI) => path.join(logsDir(root, id, base), 'transcript.jsonl');
export const summaryOf = (root, base = CLI) => path.join(root, base, base === CLI ? 'jetbox_summaries_proto.pb' : 'agyhub_summaries_proto.pb');
export const annotationOf = (root, id, base = CLI) => path.join(root, base, 'annotations', `${id}.pbtxt`);
export const tasksOf = (root, id, base = CLI) => path.join(brainDir(root, id, base), 'task.md');

const lines = (items) => items.map((it) => `${typeof it === 'string' ? it : JSON.stringify(it)}\n`).join('');

/**
 * Write one conversation. full / plain: arrays of JSONL lines (objects or raw strings) for transcript_full.jsonl and
 * transcript.jsonl, or null for no such file. mtimeMs sets both transcripts' mtime.
 */
export async function writeConversation(root, { id, base = CLI, full = [], plain = null, mtimeMs = null }) {
  await fsp.mkdir(logsDir(root, id, base), { recursive: true });
  const out = {};
  if (full) await fsp.writeFile((out.full = fullOf(root, id, base)), lines(full));
  if (plain) await fsp.writeFile((out.plain = plainOf(root, id, base)), lines(plain));
  if (mtimeMs !== null) for (const f of Object.values(out)) await fsp.utimes(f, mtimeMs / 1000, mtimeMs / 1000);
  return out;
}

export async function appendLines(file, items) {
  await fsp.appendFile(file, lines(items));
}

// ---- a tiny protobuf writer for fixtures ---------------------------------------------------------------------------

export function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}
export const tag = (no, wire) => varint(no * 8 + wire);
export const lenField = (no, bytes) => {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return Buffer.concat([tag(no, 2), varint(b.length), b]);
};
export const intField = (no, n) => Buffer.concat([tag(no, 0), varint(n)]);
export const msg = (...parts) => Buffer.concat(parts.filter(Boolean));

/**
 * One summaries file (the inferred layout: 1 { 1: uuid, 2: { 1: title, 2: steps, 5: status, 9: { 1: uri, 2: git root,
 * 3: { 1: owner/repo, 2: remote }, 4: branch }, 17: { 7: uri } } }). entries: [{ id, title?, status?, cwd?, uri?,
 * branch?, remote? }]. `cwd` is turned into a file:// URI; `remote` fills the never-read 9.3 with bait.
 */
export function summariesProto(entries) {
  return Buffer.concat(entries.map((e) => {
    const uri = e.uri ?? (e.cwd ? pathToFileURL(e.cwd).href : null);
    const ws = (uri || e.branch || e.remote) ? lenField(9, msg(
      uri ? lenField(1, uri) : null,
      uri ? lenField(2, uri) : null,
      e.remote ? lenField(3, msg(lenField(1, e.remote), lenField(2, `https://example.com/${e.remote}.git?token=BAIT`))) : null,
      e.branch ? lenField(4, e.branch) : null,
    )) : null;
    const value = msg(
      e.title ? lenField(1, e.title) : null,
      intField(2, e.steps ?? 3),
      e.status !== undefined ? intField(5, e.status) : null,
      ws,
      e.remote ? lenField(17, msg(lenField(7, 'file:///BAIT/other/workspace'))) : null,
      lenField(15, 'BAIT_UNIDENTIFIED_TEXT'),
    );
    return lenField(1, msg(lenField(1, e.id), lenField(2, value)));
  }));
}

export async function writeSummaries(root, entries, base = CLI) {
  await fsp.mkdir(baseDir(root, base), { recursive: true });
  await fsp.writeFile(summaryOf(root, base), summariesProto(entries));
}

export async function writeAnnotation(root, id, title, base = CLI) {
  await fsp.mkdir(path.join(root, base, 'annotations'), { recursive: true });
  const esc = String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await fsp.writeFile(annotationOf(root, id, base), `title: "${esc}"\nlast_user_view_time {\n  seconds: 1700000000\n}\n`);
}

export async function writeTasks(root, id, text, base = CLI) {
  await fsp.mkdir(brainDir(root, id, base), { recursive: true });
  await fsp.writeFile(tasksOf(root, id, base), text);
}

/**
 * A session for these tests: SessionCore reading normalized items, plus the setInfo contract the real
 * AntigravitySession honours for the keys SessionCore does not take (tasks -> a `tasks` plan; status is not shown).
 */
export class TestSession extends SessionCore {
  setInfo(info = {}) {
    const evs = super.setInfo(info);
    if (Array.isArray(info?.tasks)) evs.push(...this.apply({ k: 'plan', items: info.tasks, source: 'tasks' }));
    return evs;
  }
}

/** The real Antigravity descriptor (discovery, metadata watcher) with TestSession as the session class. */
export function antigravityTestAdapter(over = {}) {
  return {
    ...antigravity,
    deps: (o = {}) => antigravity.deps({ SessionState: TestSession, scan: createAntigravityScanner(), ...over, ...o }),
  };
}
