// Antigravity 메타 파일 (ADAPTERS 3.3, 5.3, docs/research/antigravity-format.json). 기록(JSONL)은 Tailer 가 읽고, 여기서는
// 통째로 다시 쓰이는 작은 파일 셋만 SidecarWatcher 로 (바뀔 때만, 크기 상한 안에서, 링크는 따라가지 않고) 읽는다:
//   <base>/jetbox_summaries_proto.pb (CLI) | <base>/agyhub_summaries_proto.pb (예전 IDE)  대화마다 제목, 작업 폴더, branch, 상태
//   <base>/annotations/<uuid>.pbtxt   제목 (text format 의 top-level title 키 하나만)
//   <base>/brain/<uuid>/task.md       체크리스트 -> plan items ([ ] pending, [/] in_progress, [x] completed), source 'tasks'
// <base> 는 <root>/antigravity-cli 또는 <root>/antigravity-ide 다. <root>/antigravity/ (데스크톱 앱, D6), history 파일(작업 폴더
// 키가 있어도 원문 입력이 같이 있다), 설정과 인증 파일은 열지 않는다.
//
// 요약 proto 의 필드 번호는 조사에서 교차 확인으로 추정한 것이다 (공식 스키마 없음, research "Summary proto"):
//   top 1 (repeated map entry) { 1: conversation uuid, 2: summary {
//     1: title, 5: status (1 idle, 2 running), 9: workspace { 1: workspace file:// URI, 4: branch } } }
// 이 넷(1.2.1, 1.2.5, 1.2.9.1, 1.2.9.4)만 읽는다. 9.2 (git root), 9.3 (owner/repo, remote URL), 15, 17 (프로젝트, 다른 URI),
// 그 밖의 필드는 읽지 않는다. 틀린 값이면 비워 둔다 (제목은 annotations, 작업 폴더는 run_command Cwd 가 대안, 위험 15).
//
// setInfo 로 넘기는 값 (AntigravitySession.setInfo 가 받는 모양, 바뀐 키만):
//   { title?, cwd?, branch?, status?: 'idle'|'running', tasks?: [{ content, status }] }
//   title 은 이미 순위가 정해진 값이다: annotations 제목이 있으면 그것, 없으면 요약 proto 제목 (요약 파일이 매 단계 다시 쓰여도
//   annotations 제목을 덮지 않는다). 첫 USER_REQUEST 대안은 SessionCore 의 몫. status 와 tasks 는 SessionCore.setInfo 가
//   모르는 키라 세션이 넘겨야 한다 (tasks -> { k: 'plan', items: tasks, source: 'tasks' }).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarWatcher } from '../../core/sidecar.mjs';
import { readFields, firstField, allFields, textOf, smallIntOf, WIRE } from './proto.mjs';

/** The summaries file of each sub-root (CLI and legacy IDE; the desktop app root antigravity/ is never read, D6). */
export const SUMMARY_FILES = Object.freeze({
  'antigravity-cli': 'jetbox_summaries_proto.pb',
  'antigravity-ide': 'agyhub_summaries_proto.pb',
});
export const TRANSCRIPTS = Object.freeze(['transcript_full.jsonl', 'transcript.jsonl']);

/** Size caps: the shared summaries file (one entry per conversation, ~3 KB each) and the per-conversation files. */
export const SUMMARY_MAX_BYTES = 8 * 1024 * 1024;
export const META_FILE_MAX_BYTES = 256 * 1024;
/** At most this many checklist items are kept from one task.md (the file cap bounds the rest). */
export const TASKS_MAX_ITEMS = 1000;

/** Summary status values (field 1.2.5): 1 idle, 2 running (research: 98 and 1 cross-checks). Others are not used. */
export const STATUS = Object.freeze({ 1: 'idle', 2: 'running' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 진짜 폴더인가 (lstat: 링크는 폴더로 치지 않는다). 없거나 볼 수 없으면 false. 메타 파일의 부모 폴더를 볼 때 쓴다
async function isRealDir(p) {
  try {
    return (await fsp.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a transcript lives: `<root>/<base>/brain/<uuid>/.system_generated/logs/<transcript>` ->
 * { root, base, baseDir, uuid, brainDir }, or null for any other path.
 */
export function locate(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  const logs = path.dirname(transcriptPath);
  const gen = path.dirname(logs);
  const brainDir = path.dirname(gen);
  const brain = path.dirname(brainDir);
  const baseDir = path.dirname(brain);
  const base = path.basename(baseDir);
  const uuid = path.basename(brainDir);
  if (!TRANSCRIPTS.includes(path.basename(transcriptPath)) || path.basename(logs) !== 'logs'
    || path.basename(gen) !== '.system_generated' || path.basename(brain) !== 'brain'
    || !UUID_RE.test(uuid) || !Object.hasOwn(SUMMARY_FILES, base)) return null;
  return { root: path.dirname(baseDir), base, baseDir, uuid, brainDir };
}

/** The metadata files of one transcript: { summary, annotation, tasks } paths, or null when the path is not a transcript. */
export function metaPaths(transcriptPath) {
  const at = locate(transcriptPath);
  if (!at) return null;
  return {
    summary: path.join(at.baseDir, SUMMARY_FILES[at.base]),
    annotation: path.join(at.baseDir, 'annotations', `${at.uuid}.pbtxt`),
    tasks: path.join(at.brainDir, 'task.md'),
  };
}

// ---- summaries proto -----------------------------------------------------------------------------------------------

/**
 * A workspace `file://` URI -> an absolute path (percent-decoded, no trailing `/`), or null. `file://localhost/x` is the
 * same as `file:///x`; another host, another scheme, an encoded `/`, a NUL or a relative result give null.
 */
export function workspacePath(uri) {
  if (typeof uri !== 'string' || !/^file:\/\//i.test(uri) || uri.length > 4096) return null;
  let p;
  try {
    p = fileURLToPath(new URL(uri));
  } catch {
    return null;
  }
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\u0000')) return null;
  const trimmed = p.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

// summary 메시지 (1.2) 하나 -> { title?, cwd?, branch?, status? }. 정해진 필드만 읽는다
function summaryFields(bytes) {
  const { fields } = readFields(bytes);
  const out = {};
  const title = textOf(firstField(fields, 1, WIRE.LEN)?.value, 1000);
  if (title && title.trim() !== '') out.title = title;
  const status = STATUS[smallIntOf(firstField(fields, 5, WIRE.VARINT))];
  if (status) out.status = status;
  const ws = firstField(fields, 9, WIRE.LEN);
  if (ws) {
    const wsFields = readFields(ws.value).fields;
    const cwd = workspacePath(textOf(firstField(wsFields, 1, WIRE.LEN)?.value, 4096));
    if (cwd) out.cwd = cwd;
    const branch = textOf(firstField(wsFields, 4, WIRE.LEN)?.value, 256);
    if (branch && branch.trim() !== '' && !/[\r\n]/.test(branch)) out.branch = branch;
  }
  return out;
}

/**
 * The summaries file -> Map(lowercased conversation uuid -> { title?, cwd?, branch?, status? }). Entries whose key is
 * not a UUID are skipped; for a repeated key the last entry wins (protobuf map semantics). A cut-off or malformed file
 * gives the entries read before the bad spot. Never throws.
 */
export function parseSummaries(buf) {
  const out = new Map();
  for (const entry of allFields(readFields(buf).fields, 1, WIRE.LEN)) {
    const ef = readFields(entry.value).fields;
    const key = textOf(firstField(ef, 1, WIRE.LEN)?.value, 64);
    const value = firstField(ef, 2, WIRE.LEN);
    if (!key || !UUID_RE.test(key) || !value) continue;
    out.set(key.toLowerCase(), summaryFields(value.value));
  }
  return out;
}

// ---- annotations pbtxt ---------------------------------------------------------------------------------------------

const SIMPLE_ESC = { n: 10, r: 13, t: 9, a: 7, b: 8, f: 12, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63 };
const UTF8 = new TextDecoder('utf-8', { fatal: true });

// text format 문자열 하나 (s[i] 는 따옴표). C 식 이스케이프를 바이트로 풀고, 끝 따옴표 뒤의 위치와 함께 돌려준다.
// 모르는 이스케이프는 버린다. 줄바꿈이나 끝이 먼저 오면 null.
function readQuoted(s, i) {
  const q = s[i];
  const bytes = [];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === q) return { bytes, next: j + 1 };
    if (c === '\n') return null;
    if (c !== '\\') {
      const cp = s.codePointAt(j);
      for (const b of Buffer.from(String.fromCodePoint(cp), 'utf8')) bytes.push(b);
      j += cp > 0xffff ? 2 : 1;
      continue;
    }
    const e = s[j + 1];
    if (e === undefined) return null;
    if (Object.hasOwn(SIMPLE_ESC, e)) {
      bytes.push(SIMPLE_ESC[e]);
      j += 2;
    } else if (/[0-7]/.test(e)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4));
      bytes.push(parseInt(m[0], 8) & 0xff);
      j += 1 + m[0].length;
    } else if (e === 'x' || e === 'X') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2, j + 4));
      if (m) bytes.push(parseInt(m[0], 16));
      j += 2 + (m ? m[0].length : 0);
    } else if (e === 'u' || e === 'U') {
      const n = e === 'u' ? 4 : 8;
      const hex = s.slice(j + 2, j + 2 + n);
      const cp = /^[0-9a-fA-F]+$/.test(hex) && hex.length === n ? parseInt(hex, 16) : NaN;
      if (Number.isInteger(cp) && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
        for (const b of Buffer.from(String.fromCodePoint(cp), 'utf8')) bytes.push(b);
      }
      j += 2 + n;
    } else {
      j += 2; // 모르는 이스케이프: 버린다
    }
  }
  return null;
}

/**
 * annotations/<uuid>.pbtxt (protobuf text format) -> { title } or null. Only a top-level `title` key whose value is
 * one or more adjacent quoted strings is read (C-style escapes; octal and `\x` bytes are UTF-8 decoded strictly); every
 * other key (IDE files hold only `last_user_view_time`), nested blocks and comments are skipped. The first title wins.
 */
export function parseAnnotation(buf) {
  let s;
  try {
    s = typeof buf === 'string' ? buf : UTF8.decode(buf);
  } catch {
    return null;
  }
  let depth = 0;
  let i = 0;
  let expectValueOf = null; // 지금 읽은 키 (값을 기다리는 중)
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '#') { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl + 1; continue; }
    if (c === '{' || c === '<') { depth += 1; expectValueOf = null; i += 1; continue; }
    if (c === '}' || c === '>') { depth = Math.max(0, depth - 1); expectValueOf = null; i += 1; continue; }
    if (c === ':' || c === ',' || c === ';' || c === '[' || c === ']') { i += 1; continue; }
    if (c === '"' || c === "'") {
      const parts = [];
      let at = i;
      while (at < s.length && (s[at] === '"' || s[at] === "'")) { // 붙어 있는 문자열은 이어 붙인다
        const q = readQuoted(s, at);
        if (!q) return null;
        parts.push(...q.bytes);
        at = q.next;
        while (at < s.length && /[ \t]/.test(s[at])) at += 1;
      }
      if (expectValueOf === 'title' && depth === 0) {
        let title;
        try {
          title = UTF8.decode(Uint8Array.from(parts));
        } catch {
          return null;
        }
        return title.trim() !== '' ? { title } : null;
      }
      expectValueOf = null;
      i = at;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*|^[^\s{}<>:,;"'#[\]]+/.exec(s.slice(i, i + 256));
    const word = m ? m[0] : c;
    expectValueOf = expectValueOf === null ? word : null; // 키 다음에 오는 낱말은 값 (숫자, enum)
    i += word.length;
  }
  return null;
}

// ---- task.md -------------------------------------------------------------------------------------------------------

const TASK_RE = /^\s{0,40}(?:[-*+]|\d{1,9}[.)])\s+\[([ xX/])\]\s+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MARK_STATUS = { ' ': 'pending', '/': 'in_progress', x: 'completed', X: 'completed' };
const RAW_LINE_MAX = 1000;

/**
 * brain/<uuid>/task.md -> [{ content, status }] or null when it has no checklist item. `- [ ]` pending, `- [/]`
 * in_progress, `- [x]` / `- [X]` completed, at any indent (also `*`, `+`, `1.`); headings, plain bullets, other markers
 * and fenced code are skipped. HTML comments (`<!-- id: 3 -->`), link targets and backticks are dropped; the core scrubs
 * and caps the rest (section 5, 80 code points). Each raw line is cut at 1000 chars; at most 1000 items.
 */
export function parseTaskMd(buf) {
  let s;
  try {
    s = typeof buf === 'string' ? buf : UTF8.decode(buf);
  } catch {
    return null;
  }
  const items = [];
  let fence = null;
  for (let line of s.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    if (line.length > RAW_LINE_MAX) line = line.slice(0, RAW_LINE_MAX);
    const m = TASK_RE.exec(line);
    if (!m) continue;
    const content = m[2]
      .replace(/<!--.*?(-->|$)/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!content) continue;
    items.push({ content, status: MARK_STATUS[m[1]] });
    if (items.length >= TASKS_MAX_ITEMS) break;
  }
  return items.length ? items : null;
}

// ---- the watcher ---------------------------------------------------------------------------------------------------

/**
 * The Runner's metadata watcher for Antigravity (`deps.sidecarWatcher`: `check(ref)` / `forget(path)`), built on two
 * SidecarWatchers so every file is lstat-ed, opened with O_NOFOLLOW, checked to be the lstat-ed regular file and
 * re-read only when its inode, size or mtime changed. Their folders are lstat-ed at every check too (P5e review finding
 * 4: SidecarWatcher's lstat only covers the last path part): nothing is read when `<app>` is not a real folder, the
 * annotation only when `<app>/annotations/` is one, and task.md only when `<app>/brain/` and `brain/<uuid>/` are. A
 * linked folder counts as missing, so no file outside `<app>/` (or under the desktop root) is ever opened:
 * - the summaries file is shared by every conversation of its sub-root, so it is watched once per file (not once per
 *   transcript) and parsed once per change, up to SUMMARY_MAX_BYTES;
 * - annotations/<uuid>.pbtxt and brain/<uuid>/task.md are watched per transcript, up to META_FILE_MAX_BYTES.
 * `check(ref)` returns the setInfo fields (header) whose value changed since the last delivery to that transcript, or
 * null. The title is ranked here (annotation over summary). Values never go back to empty: a file that disappears or
 * stops naming the conversation leaves what was delivered. Never throws.
 */
export class AntigravityMeta {
  constructor({ summaryMaxBytes = SUMMARY_MAX_BYTES, fileMaxBytes = META_FILE_MAX_BYTES } = {}) {
    this.summaries = new Map(); // summary file path -> Map(uuid -> fields), the last good parse
    this.summaryWatch = new SidecarWatcher((key) => [{
      path: key.path,
      parse: (buf) => ({ entries: parseSummaries(buf) }),
    }], { maxBytes: summaryMaxBytes });
    this.files = new Map(); // transcript path -> { at, paths, annotationTitle, tasks, sent: {} }
    this.fileWatch = new SidecarWatcher((ref) => this.#fileSpecs(ref), { maxBytes: fileMaxBytes });
  }

  // SidecarWatcher calls this synchronously: the folder checks are made in #check before it (annotationsOk, tasksOk)
  #fileSpecs(ref) {
    const slot = this.files.get(ref?.path);
    if (!slot) return [];
    const specs = [];
    if (slot.annotationsOk) {
      specs.push({ path: slot.paths.annotation, parse: (buf) => { slot.annotationTitle = parseAnnotation(buf)?.title ?? null; return null; } });
    }
    if (slot.tasksOk) specs.push({ path: slot.paths.tasks, parse: (buf) => { slot.tasks = parseTaskMd(buf); return null; } });
    return specs;
  }

  async check(ref) {
    try {
      return await this.#check(ref);
    } catch {
      return null;
    }
  }

  async #check(ref) {
    const p = ref?.path;
    const paths = metaPaths(p);
    if (!paths) return null;
    const at = locate(p);
    let slot = this.files.get(p);
    if (!slot) {
      slot = { at, paths, annotationTitle: null, tasks: null, sent: {}, annotationsOk: false, tasksOk: false };
      this.files.set(p, slot);
    }
    const [appOk, annotationsOk, brainOk, convOk] = await Promise.all(
      [at.baseDir, path.dirname(paths.annotation), path.dirname(at.brainDir), at.brainDir].map(isRealDir),
    );
    if (!appOk || this.files.get(p) !== slot) return null; // 링크가 된 앱 폴더: 아무것도 읽지 않는다
    slot.annotationsOk = annotationsOk;
    slot.tasksOk = brainOk && convOk;
    const got = await this.summaryWatch.check({ path: paths.summary });
    if (isObj(got) && got.entries instanceof Map) this.summaries.set(paths.summary, got.entries);
    await this.fileWatch.check(ref);
    if (this.files.get(p) !== slot) return null; // forget() 가 사이에 불렸다
    const entry = this.summaries.get(paths.summary)?.get(at.uuid.toLowerCase()) ?? {};
    const want = {
      title: slot.annotationTitle ?? entry.title ?? null,
      cwd: entry.cwd ?? null,
      branch: entry.branch ?? null,
      status: entry.status ?? null,
      tasks: slot.tasks,
    };
    const out = {};
    for (const [k, v] of Object.entries(want)) {
      if (v === null || v === undefined) continue;
      const sig = k === 'tasks' ? JSON.stringify(v) : v;
      if (slot.sent[k] === sig) continue;
      slot.sent[k] = sig;
      out[k] = k === 'tasks' ? v.map((it) => ({ ...it })) : v;
    }
    return Object.keys(out).length ? out : null;
  }

  /** Drop what was remembered for a transcript (detached or moved): the next check delivers everything again. */
  forget(transcriptPath) {
    this.files.delete(transcriptPath);
    this.fileWatch.forget(transcriptPath);
  }
}
