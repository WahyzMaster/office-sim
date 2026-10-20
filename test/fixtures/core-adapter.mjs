// 'core-fixture' 어댑터 (테스트 전용, P5b). 기록 파일이 정규화 항목(ADAPTERS 3.2)의 JSONL 이라서 줄 하나가 곧
// SessionCore 의 항목이다. 실제 Codex/Grok/Antigravity 형식이 아니고, src/adapters/ 에 등록하지 않는다: 테스트가 start() 의
// adapters 훅으로 KNOWN_AGENTS 안의 id (기본 'grok') 자리에 끼워 넣는다. import 할 때 아무것도 실행하지 않는다
// (node --test 가 test/ 아래 파일을 모두 실행한다).
//
// 배치 (허용 목록, 이름 규칙에 맞는 것만 받고 나머지 파일은 열지도 stat 하지도 않는다):
//   <root>/sessions/<name>/items.jsonl                          메인, charId `${id}-${name}`
//   <root>/sessions/<name>/subagents/<child>/items.jsonl        서브, charId `${id}-${child}`, 부모 = 메인
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Tailer } from '../../src/tailer.mjs';
import { SessionCore } from '../../src/core/session-core.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const ITEMS = 'items.jsonl';

async function dirs(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

async function fileRef(file, fields, { activeMs, nowMs }) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile() || (Number.isFinite(activeMs) && Number.isFinite(nowMs) && st.mtimeMs < nowMs - activeMs)) return null;
  return { path: file, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, ...fields };
}

/** Allow-list scan: mains first, then their subs (the Runner's publish order). Refs carry D2 ids, no `agent`. */
export async function scanCore(root, id, opts = {}) {
  const refs = [];
  const base = path.join(root, 'sessions');
  for (const name of await dirs(base)) {
    const charId = `${id}-${name}`;
    const main = await fileRef(path.join(base, name, ITEMS), { kind: 'main', sid: charId, charId, stem: charId }, opts);
    if (main) refs.push(main);
    for (const child of await dirs(path.join(base, name, 'subagents'))) {
      const sub = await fileRef(path.join(base, name, 'subagents', child, ITEMS),
        { kind: 'sub', sid: charId, charId: `${id}-${child}`, parentId: charId, stem: `${id}-${child}` }, opts);
      if (sub) refs.push(sub);
    }
  }
  return refs;
}

/** The descriptor: deps() is the Runner bundle (SessionCore reads the parsed items directly). */
export function coreAdapter({ id = 'grok' } = {}) {
  return {
    id,
    defaultRoot: '/nonexistent-office-sim-core-fixture-root',
    async deps() {
      return { agent: id, SessionState: SessionCore, Tailer, scan: (root, opts) => scanCore(root, id, opts) };
    },
  };
}

/** Fixture paths for a root. */
export function corePaths(root) {
  return {
    main: (name) => path.join(root, 'sessions', name, ITEMS),
    sub: (name, child) => path.join(root, 'sessions', name, 'subagents', child, ITEMS),
  };
}

/** Write items as JSONL (creates the directories). */
export async function writeItems(file, items) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, items.map((it) => `${JSON.stringify(it)}\n`).join(''));
}

export async function appendItems(file, items) {
  await fsp.appendFile(file, items.map((it) => `${JSON.stringify(it)}\n`).join(''));
}
