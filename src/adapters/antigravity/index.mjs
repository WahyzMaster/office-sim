// Antigravity (CLI `agy` 와 예전 IDE) 어댑터 설명자 (ADAPTERS 3.1, 5.3, 결정 D6, CONTRACT 4.0.1). 탐색은 discover.mjs, 메타
// 파일(요약 proto, annotations, task.md)은 meta.mjs 의 AntigravityMeta, 기록 정규화와 세션 상태는 records.mjs / session.mjs
// (AntigravitySession, SessionCore 위에 선다). deps() 는 Runner 가 쓰는 묶음이고 AntigravitySession 은 처음 쓸 때 불러온다
// (등록표를 import 하는 것만으로 세션 모듈을 읽지 않는다, Grok/Codex 설명자와 같은 방식). 데스크톱 앱(<root>/antigravity/)은
// 범위 밖이다 (D6).
//
// 세션과의 약속 (Runner -> AntigravitySession):
// - 생성자 옵션: Runner 의 것 그대로 (id, kind 'main', agent, now, ...) + `facts` = { full: transcript_full.jsonl 이면 true,
//   base: 'antigravity-cli' | 'antigravity-ide' }. transcript.jsonl 은 인자 값이 JSON 문자열이고 긴 값이 잘려 있다.
// - setInfo(info): AntigravityMeta.check 가 바뀐 키만 넘긴다: { title?, cwd?, branch?, status?: 'idle'|'running',
//   tasks?: [{ content, status }] }. title 은 순위가 정해진 값 (annotations > 요약 proto). title / cwd / branch 는
//   SessionCore.setInfo 가 그대로 받는다. tasks 는 { k: 'plan', items: tasks, source: 'tasks' } 로, status 는 세션이 정한
//   뜻으로 넘겨야 한다 (SessionCore 는 모르는 키를 버린다).
// - 순서: Runner 는 기록 replay 를 먼저 하고 그 뒤에 처음 check 한다 (prepare). 그래서 run_command 의 Cwd 대안은 replay 중에
//   meta 로 내지 말고, 첫 idle() (알리기 전에 불린다) 까지 setInfo 로 작업 폴더가 오지 않았을 때만 써야 첫 cwd(층)가 요약
//   proto 의 작업 폴더가 된다. 요약에 이 대화가 없으면 check 는 null 이라 setInfo 가 불리지 않는다.
import { ANTIGRAVITY_AGENT, createAntigravityScanner } from './discover.mjs';
import { AntigravityMeta } from './meta.mjs';

export { ANTIGRAVITY_AGENT };

// 붙일 때 링크를 따라가지 않는 Tailer (P5e review finding 5): 탐색이 lstat 한 그 일반 파일(ref.ino)만 읽는다. 공유 Tailer 의
// 기본값은 그대로라 다른 어댑터는 바뀌지 않는다.
function noFollowTailer(Base) {
  return class AntigravityTailer extends Base {
    constructor(o = {}) {
      super({ ...o, noFollow: true });
    }
  };
}

export const antigravity = Object.freeze({
  id: ANTIGRAVITY_AGENT,
  defaultRoot: '~/.gemini', // --antigravity-root 기본값 (bin 이 채운다, CONTRACT 6). 그 아래 antigravity-cli/, antigravity-ide/ 만 본다
  /**
   * The Runner deps: { agent, SessionState: AntigravitySession, Tailer (a noFollow Tailer: an attached transcript is the
   * lstat-ed regular file of the scan ref), scan, sidecarWatcher: AntigravityMeta }. No
   * `sidecars(ref)` hook (the watcher shares one summaries file between conversations), no `worktreeFloor` (D1: an
   * ordinary workspace goes through the shared projectKey, the same floor as the other agents), no `readSubMeta` /
   * `readJournalLabels` (Claude-only), no replay support (D12). `over` (test hook) replaces any part. `scan` and the
   * watcher are fresh per call (one per Runner: the scanner keeps its line counts and file choices, the watcher its file
   * signatures and the parsed summaries).
   */
  async deps(over = {}) {
    const deps = { ...over };
    if (!deps.SessionState) deps.SessionState = (await import('./session.mjs')).AntigravitySession;
    if (!deps.Tailer) deps.Tailer = noFollowTailer((await import('../../tailer.mjs')).Tailer);
    deps.scan ??= createAntigravityScanner();
    deps.sidecarWatcher ??= new AntigravityMeta();
    deps.agent ??= ANTIGRAVITY_AGENT;
    return deps;
  },
});
