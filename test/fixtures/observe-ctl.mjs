// 기록 관찰 제어 테스트가 함께 쓰는 도우미 (test/observe-limits.test.mjs, test/observe-retention.test.mjs): 가짜 타이머와
// 시계, 임시 Codex 루트, 지어낸 rollout 줄, 출력 파일 쓰기 훅. 임시 폴더만 쓴다. 불러올 때 아무것도 하지 않는다
// (node --test 가 test/ 아래의 파일을 모두 테스트 파일로 돌린다).
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nearDays } from '../../src/observe/observer.mjs';

/** Temp folders made through tmp(); remove them with cleanup() in an after() hook. */
export function tempDirs() {
  const dirs = [];
  return {
    async tmp(prefix = 'office-sim-observe-lim-') {
      const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    async cleanup() {
      for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
    },
  };
}

// 가짜 타이머: fire() 가 가장 먼저 걸린 콜백을 부르고 그 약속을 기다린다
export function fakeTimers() {
  const q = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) {
      const h = { id: ++id, fn, ms, unref() {} };
      q.set(h.id, h);
      return h;
    },
    clearTimeout(h) {
      if (h) q.delete(h.id);
    },
    get pending() { return q.size; },
    get delays() { return [...q.values()].map((h) => h.ms); },
    async fire() {
      const [h] = q.values();
      if (!h) return false;
      q.delete(h.id);
      await h.fn();
      return true;
    },
  };
}

export function clock(start = Date.now()) {
  let ms = start;
  const now = () => ms;
  now.add = (d) => { ms += d; };
  return now;
}

/** A temp Codex root with one rollout in today's day folder and an empty session_index.jsonl. */
export async function codexRoot(tmp) {
  const root = await tmp('office-sim-observe-codex-');
  const day = path.join(root, 'sessions', ...nearDays(Date.now())[0].split('/'));
  await fsp.mkdir(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-10-20T09-00-00-0199c0de-0000-7000-8000-000000000002.jsonl');
  await fsp.writeFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: {} })}\n`);
  await fsp.writeFile(path.join(root, 'session_index.jsonl'), '');
  return { root, file };
}

export const item = () => `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message' } })}\n`;

/** Let pending promise callbacks run (n event-loop turns). */
export async function turns(n = 5) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// fs/promises 에서 출력 파일(observe-*.jsonl)의 핸들만 감싼다: 쓰기마다 그 전에 write(name) 을 부르고, 약속을 돌려주면
// 그것을 기다린다 (멈춘 마운트처럼). 원본 기록 파일은 Observer 도 같은 fsImpl 로 열므로 이름으로 가린다.
export function outputHooks({ write }) {
  return Object.assign(Object.create(null), fsp, {
    open: async (p, ...a) => {
      const fh = await fsp.open(p, ...a);
      const name = path.basename(String(p));
      if (!/^observe-.*\.jsonl$/.test(name)) return fh;
      return {
        chmod: (...x) => fh.chmod(...x),
        close: () => fh.close(),
        async write(...x) {
          await write(name);
          return fh.write(...x);
        },
      };
    },
  });
}

export const readRecords = async (dir, name) => (await fsp.readFile(path.join(dir, name), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
