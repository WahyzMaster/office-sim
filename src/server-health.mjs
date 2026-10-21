// 오류를 숫자와 코드로 다루는 곳 (contract 6): Runner 로그의 오류 문구/코드와 GET /healthz 의 본문.
// /healthz 의 처음 다섯 키(ok, files, sessions, agents, clients)는 예전 그대로이고, 그 뒤에 빌드(version, commit), 시작
// 시각, 오류 카운터의 합, 어댑터별 탐색 시간과 카운터가 온다. 본문에는 숫자, 시각, 오류 코드(EACCES, SCAN_CAPPED)만 있다: 경로, 파일
// 이름, 세션 id, 오류 문구는 없다. 요청마다 fs 를 부르지 않는다 (Runner 의 필드를 읽기만 한다).
import fs from 'node:fs';

/** git 의 짧은 sha (bin 이 `--short=12` 로 구한다). start() 의 `build.commit` 은 이 모양이거나 null 이다. */
export const COMMIT_RE = /^[0-9a-f]{7,40}$/;
// 오류 코드 모양: 대문자로 시작하는 대문자, 숫자, _ 뿐 (EACCES, ERR_..., 어댑터의 SCAN_CAPPED). 경로, 점, 빈칸, 문구는 들지 못한다
const CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;
/** 어댑터별 카운터 (/healthz runners.<id>). 위쪽의 같은 이름 키는 이 값들의 합이다. */
export const RUNNER_COUNTERS = Object.freeze(['badLines', 'skippedLines', 'applyErrors', 'loopErrors', 'linkErrors']);

export function errText(err) {
  return err?.message ?? String(err);
}

// 로그에는 경로가 든 전체 메시지 대신 오류 코드만 (EACCES, EIO ...). 코드가 없으면 메시지.
export function errCode(err) {
  return typeof err?.code === 'string' ? err.code : errText(err);
}

// /healthz 에는 코드 모양의 값만: Runner 의 scanErr 는 코드가 없을 때 문구(경로가 들 수 있다)를 담으므로 EUNKNOWN 으로 바꾼다
const codeOnly = (v) => (v == null ? null : CODE_RE.test(v) ? v : 'EUNKNOWN');
const count = (v) => (Number.isFinite(v) ? v : 0);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** package.json 의 version (이 모듈 기준 경로). 읽지 못하면 null. start() 가 한 번만 부른다. */
export function packageVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/** One Runner's /healthz entry. Missing fields (a fake runner, the replay Runner's scan time) read as 0 / null. */
export function runnerHealth(runner) {
  const out = {
    files: runner?.files?.size ?? 0,
    lastScanMs: Number.isFinite(runner?.lastScanMs) ? runner.lastScanMs : null,
    lastScanAt: iso(runner?.lastScanAt),
    scanErr: codeOnly(runner?.scanErr),
  };
  for (const k of RUNNER_COUNTERS) out[k] = count(k === 'skippedLines' ? runner?.tailer?.skippedLines : runner?.[k]);
  return out;
}

/**
 * The GET /healthz body builder. `group`: the RunnerGroup (entries in agents order, late adapters included once on),
 * `store`: sessionCount and stats().rejectedRefs, `build`: { version, commit }, `startedAt`: epoch ms.
 * @returns {(clients: number) => object}
 */
export function createHealth({ group, store, build, startedAt }) {
  const head = { version: build?.version ?? null, commit: build?.commit ?? null, startedAt: iso(startedAt) };
  return (clients) => {
    const runners = {};
    for (const { id, runner } of group.entries) runners[id] = runnerHealth(runner);
    const sums = {};
    for (const k of RUNNER_COUNTERS) sums[k] = Object.values(runners).reduce((n, r) => n + r[k], 0);
    return {
      ok: true, files: group.fileCount, sessions: store.sessionCount, agents: group.ids, clients,
      ...head, uptimeMs: Math.max(0, Date.now() - startedAt),
      ...sums, rejectedRefs: count(store.stats?.().rejectedRefs), runners,
    };
  };
}
