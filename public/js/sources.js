// 이벤트 공급원. 둘 다 같은 이벤트 스키마를 emit(ev) 로 흘려보낸다.
// - MockSource: 아티팩트용 가짜 세션(모든 경로/이름/내용은 예시 데이터). 네 에이전트(Claude Code, Codex, Grok,
//   Antigravity)가 섞여 일한다. 도구 이름과 방은 각 어댑터가 실제로 보내는 것(CONTRACT 4.6~4.8 도구 표)을 따른다.
// - LiveSource: 로컬 서버의 GET /events (SSE) 와 POST /config.

const STATUS = ['pending', 'in_progress', 'completed'];

// 에이전트마다 질문 도구와 서브에이전트를 띄우는 도구의 실제 이름. async: 띄우자마자 ok 로 끝난다(Grok, R28).
const AGENT_TOOLS = {
  'claude-code': { ask: 'AskUserQuestion', spawn: 'Agent' },
  codex: { ask: 'request_user_input', spawn: 'spawn_agent', async: true },
  grok: { ask: 'ask_user_question', spawn: 'spawn_subagent', async: true },
  antigravity: { ask: 'ask_question' },
};

// 다른 에이전트의 도구는 서버가 room 힌트를 실어 보낸다(페이지의 ROOM_RULES 는 Claude 이름과 mcp__ 만 안다).
// 셸 도구는 서버처럼 요약의 프로그램 이름으로 나눈다: grep/rg/sed 같은 읽기 -> 자료실, curl -> 정보검색실, 나머지 -> 서버실.
const ROOM_HINTS = {
  read_file: 'archive', list_dir: 'archive', grep: 'archive', grep_search: 'archive',
  search_replace: 'dev', apply_patch: 'dev', edit_file: 'dev',
  web_fetch: 'research', web_search: 'research', search_web: 'research', read_url_content: 'research',
  request_user_input: 'desk', ask_user_question: 'desk', ask_question: 'desk',
  spawn_agent: 'here', spawn_subagent: 'here', schedule: 'lounge',
};
const SHELL_TOOLS = new Set(['exec_command', 'run_terminal_command', 'run_command']);
const ARCHIVE_PROGRAMS = new Set(['grep', 'rg', 'find', 'ls', 'cat', 'head', 'tail', 'sed', 'wc', 'jq']);

// 승인 대기(Grok 라이브, P5g): 권한 창이 열린 뒤 tool_wait true 가 오기까지의 틈(초, 서버는 1초 넘게 열린 것만 보낸다)과
// 사람이 거절했을 때 Grok 어댑터가 보내는 고정 문구(records.mjs denialLine, CONTRACT 4.6).
const WAIT_LAG = 1;
const USER_DENIAL = 'User rejected the execution';

function roomHint(agent, tool, summary) {
  if (agent === 'claude-code') return undefined; // 페이지가 Claude 도구 이름으로 나눈다
  if (SHELL_TOOLS.has(tool)) {
    const program = summary.split(' ')[0];
    return ARCHIVE_PROGRAMS.has(program) ? 'archive' : program === 'curl' ? 'research' : 'server';
  }
  return ROOM_HINTS[tool];
}

const SCENARIOS = [
  {
    sessionId: 'demo-qr', project: 'omni-app', title: '식권 QR 배포 가드', branch: 'fix/qr-deploy-guard', start: 0.4, gap: 9,
    steps: [
      ['think', '배포 가드부터 보자. 기존 QR 검증 흐름을 먼저 읽어야겠다.', 2600],
      ['plan', [['QR 검증 흐름 파악', 1], ['가드 테스트 작성', 0], ['배포 가드 구현', 0], ['테스트 실행', 0]]],
      ['tool', 'Grep', '"verifyQr" src/'],
      ['tool', 'Read', 'src/qr/verifyQr.ts'],
      ['tool', 'mcp__codegraph__codegraph_callers', 'authenticateTerminal'],
      ['plan', [['QR 검증 흐름 파악', 2], ['가드 테스트 작성', 1], ['배포 가드 구현', 0], ['테스트 실행', 0]]],
      ['tool', 'Write', 'test/qr/deployGuard.test.ts'],
      ['tool', 'Edit', 'src/qr/deployGuard.ts'],
      ['tool', 'Bash', 'npm test -- deployGuard', { dur: 3.2, fail: 'Exit code 1 · expected 403, received 200' }],
      ['think', null, 1600],
      ['think', '개발 모드 플래그에서 가드가 우회되고 있다. 환경 분기를 고치자.', 2400],
      ['tool', 'Edit', 'src/qr/deployGuard.ts'],
      ['tool', 'Bash', 'npm test -- deployGuard', { dur: 3 }],
      ['plan', [['QR 검증 흐름 파악', 2], ['가드 테스트 작성', 2], ['배포 가드 구현', 2], ['테스트 실행', 2]]],
      ['ask', '테스트 통과. 바로 머지할까요, PR을 열까요?', ['PR 열기', '바로 머지'], 6],
      ['tool', 'Bash', 'git commit -m "fix(qr): enforce deploy guard"'],
      ['say', 'PR용 커밋을 만들었어요.'],
      ['end'],
    ],
  },
  {
    sessionId: 'grok-demo-rules', agent: 'grok', project: 'omni-app', title: '알림 규칙 점검', branch: 'chore/notification-rules',
    start: 2.4, gap: 12,
    steps: [
      ['think', 'Firestore 규칙 문서부터 최신 내용을 확인하자.', 2200],
      ['plan', [['규칙 사용처 조사', 1], ['만료 검증 추가', 0], ['규칙 테스트', 0]]],
      ['tool', 'mcp__context7__get-library-docs', 'firestore security rules'],
      ['tool', 'web_search', 'web_search'],
      ['agent', 'explore', '알림 규칙 사용처 조사', [
        ['tool', 'list_dir', 'rules'],
        ['tool', 'grep', 'notifications · firestore.rules'],
        ['tool', 'read_file', 'firestore.rules'],
        ['say', '사용처 4곳을 찾았어요.'],
      ]],
      ['tool', 'web_fetch', 'firebase.google.com', { fail: '429 · 요청 한도 초과' }],
      ['think', '요청 한도에 걸렸다. 문서 결과만으로 정리하자.', 1800],
      ['plan', [['규칙 사용처 조사', 2], ['만료 검증 추가', 1], ['규칙 테스트', 0]]],
      ['tool', 'read_file', 'firestore.rules'],
      ['tool', 'search_replace', 'firestore.rules'],
      // 승인 대기 둘: 테스트는 내 자리에서 허용을 받고 서버실로 돌아가 돌리고, 배포는 내 자리에서 거절된다.
      ['tool', 'run_terminal_command', 'npm test', { approval: 5, dur: 2.4 }],
      ['plan', [['규칙 사용처 조사', 2], ['만료 검증 추가', 2], ['규칙 테스트', 2]]],
      ['tool', 'run_terminal_command', 'firebase', { approval: 6, deny: true }],
      ['say', '규칙 세 곳에 만료 검증을 추가했어요. 배포는 승인받지 못했어요.'],
      ['end'],
    ],
  },
  {
    sessionId: 'codex-demo-push', agent: 'codex', project: 'omni-app', title: '푸시 알림 재시도', branch: 'fix/push-retry',
    start: 1.6, gap: 11,
    steps: [
      ['think', '실패한 푸시가 다시 나가지 않는다. 발송 큐부터 보자.', 2000],
      ['plan', [['발송 큐 흐름 파악', 1], ['재시도 백오프 추가', 0], ['테스트 실행', 0]]],
      ['tool', 'exec_command', 'rg'],
      ['tool', 'exec_command', 'sed'],
      ['tool', 'apply_patch', 'sendPush.ts (+1)'],
      ['tool', 'exec_command', 'npm test', { dur: 3, fail: 'Exit code 1' }],
      ['think', '백오프 상한이 빠져 있다. 재시도 정책을 따로 두자.', 1600],
      ['tool', 'apply_patch', 'retryPolicy.ts'],
      ['tool', 'exec_command', 'npm test', { dur: 2.8 }],
      ['plan', [['발송 큐 흐름 파악', 2], ['재시도 백오프 추가', 2], ['테스트 실행', 2]]],
      ['ask', '재시도 상한을 몇 번으로 둘까요?', ['5회', '3회'], 6],
      ['tool', 'exec_command', 'git status'],
      ['say', '재시도 백오프를 넣고 테스트를 통과시켰어요.'],
      ['end'],
    ],
  },
  {
    sessionId: 'antigravity-demo-scan', agent: 'antigravity', project: 'omni-app', title: 'QR 스캐너 화면 정리',
    branch: 'ui/qr-scanner', start: 3.0, gap: 13,
    steps: [
      ['think', '스캐너 화면의 카메라 권한 안내부터 확인하자.', 2400],
      ['tool', 'list_dir', 'scanner'],
      ['tool', 'grep_search', 'CameraPermission · scanner'],
      ['tool', 'read_file', 'ScannerPage.tsx'],
      ['tool', 'search_web', 'camera permission prompt copy'],
      ['tool', 'read_url_content', 'web.dev'],
      ['tool', 'edit_file', 'ScannerPage.tsx'],
      ['tool', 'edit_file', 'scanner.ko.json'],
      ['tool', 'run_command', 'npm run lint', { dur: 2.2 }],
      ['tool', 'schedule', 'schedule', { dur: 4 }],
      ['tool', 'run_command', 'npm test', { dur: 3 }],
      ['ask', '안내 문구를 두 줄로 줄일까요?', ['두 줄로', '그대로'], 6],
      ['say', '권한 안내 문구와 레이아웃을 정리했어요.'],
      ['end'],
    ],
  },
  {
    sessionId: 'demo-score', project: 'matching-api', title: '매칭 점수 리팩터링', branch: 'refactor/score', start: 1.2, gap: 10,
    steps: [
      ['plan', [['점수 계산 위치 찾기', 1], ['계산 로직 통합', 0], ['타입 검사와 테스트', 0]]],
      ['agent', 'Explore', '점수 계산 사용처 조사', [
        ['tool', 'Glob', 'src/**/score*.ts'],
        ['tool', 'Grep', '"calcScore" src/'],
        ['say', '계산하는 곳 3곳을 찾았어요.'],
      ]],
      ['tool', 'Read', 'src/match/score.ts'],
      ['tool', 'Read', 'src/match/rank.ts'],
      ['think', '점수 계산이 세 군데에 중복돼 있다. 하나로 모으자.', 2200],
      ['plan', [['점수 계산 위치 찾기', 2], ['계산 로직 통합', 1], ['타입 검사와 테스트', 0]]],
      ['tool', 'Write', 'src/match/scoring.ts'],
      ['tool', 'Edit', 'src/match/score.ts'],
      ['tool', 'Edit', 'src/match/rank.ts'],
      ['tool', 'Bash', 'npm run typecheck', { dur: 2.6 }],
      ['tool', 'Bash', 'npm test', { dur: 3 }],
      ['plan', [['점수 계산 위치 찾기', 2], ['계산 로직 통합', 2], ['타입 검사와 테스트', 2]]],
      ['end'],
    ],
  },
  {
    sessionId: 'demo-hero', project: 'landing-site', title: '랜딩 카피 수정', branch: 'copy/hero', start: 3.6, gap: 14,
    steps: [
      ['tool', 'WebFetch', 'brand guide'],
      ['tool', 'Read', 'content/hero.md'],
      ['think', null, 1400],
      ['tool', 'Edit', 'content/hero.md'],
      ['ask', '헤드라인 후보 두 개 중 어느 쪽으로 갈까요?', ['A: 더 빠르게', 'B: 더 가볍게'], 7],
      ['tool', 'Edit', 'content/hero.md'],
      ['tool', 'Bash', 'git status'],
      ['end'],
    ],
  },
];

export class MockSource {
  constructor(emit) {
    this.emit = emit;
    this.t = 0;
    this.acc = 0;
    this.seq = 0;
    this.timeline = [];
    this.buffer = [];
    this.onBatch = null;
    this.scn = SCENARIOS.map((s) => ({ agent: 'claude-code', ...s, next: s.start + 0.8 }));
    for (const s of this.scn) {
      this.timeline.push([s.start, { type: 'session', sessionId: s.sessionId, agent: s.agent, project: s.project, title: s.title, branch: s.branch }]);
    }
    this.timeline.sort((a, b) => a[0] - b[0]);
  }

  start() {}

  id() {
    this.seq += 1;
    return `toolu_demo_${this.seq.toString(36)}`;
  }

  compile(steps, sid, project, t0, agent = 'claude-code') {
    const tools = AGENT_TOOLS[agent];
    const out = [];
    let t = t0;
    for (const step of steps) {
      const kind = step[0];
      if (kind === 'think') {
        out.push([t, { type: 'thinking', sessionId: sid, text: step[1], durationMs: step[2] }]);
        t += (step[2] / 1000) * 0.7 + 0.4;
      } else if (kind === 'plan') {
        out.push([t, { type: 'plan', sessionId: sid, items: step[1].map(([content, s]) => ({ content, status: STATUS[s] })) }]);
        t += 1.6;
      } else if (kind === 'tool') {
        const o = step[3] || {};
        const id = this.id();
        const dur = o.dur ?? 1.4 + Math.random() * 1.2;
        const room = roomHint(agent, step[1], step[2]);
        out.push([t, { type: 'tool_start', sessionId: sid, toolUseId: id, tool: step[1], summary: step[2], ...(room ? { room } : {}) }]);
        if (o.approval) {
          // approval: 승인을 기다린 초. 허용은 tool_wait false 뒤에 실행하고, 거절은 tool_end denied 만 온다(false 없음).
          const asked = t + WAIT_LAG;
          out.push([asked, { type: 'tool_wait', sessionId: sid, toolUseId: id, waiting: true }]);
          t = asked + o.approval;
          if (o.deny) {
            out.push([t, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: false, error: USER_DENIAL, errorKind: 'denied' }]);
            t += 0.5;
            continue;
          }
          out.push([t, { type: 'tool_wait', sessionId: sid, toolUseId: id, waiting: false }]);
        }
        out.push([t + dur, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: !o.fail, error: o.fail, errorKind: o.fail ? (o.kind || 'failed') : undefined }]);
        t += dur + 0.5;
      } else if (kind === 'ask') {
        const id = this.id();
        const room = roomHint(agent, tools.ask, step[1]);
        out.push([t, { type: 'tool_start', sessionId: sid, toolUseId: id, tool: tools.ask, summary: step[1], question: step[1], options: step[2], ...(room ? { room } : {}) }]);
        t += step[3];
        out.push([t, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: true }]);
        t += 0.6;
      } else if (kind === 'say') {
        out.push([t, { type: 'say', sessionId: sid, text: step[1] }]);
        t += 1.2;
      } else if (kind === 'agent') {
        // Claude 는 서브에이전트가 끝날 때 Agent 가 끝나고, Grok 은 띄우자마자 끝난다(async). 요약은 서버처럼 종류.
        const id = this.id();
        const subId = `${sid}-sub-${id.slice(-4)}`;
        const summary = agent === 'claude-code' ? `${step[1]} · ${step[2]}` : step[1];
        const room = roomHint(agent, tools.spawn, summary);
        out.push([t, { type: 'tool_start', sessionId: sid, toolUseId: id, tool: tools.spawn, summary, ...(room ? { room } : {}) }]);
        out.push([t + 0.4, { type: 'session', sessionId: subId, agent, project, title: step[2], agentType: step[1], isSubagent: true, parentSessionId: sid }]);
        const sub = this.compile(step[3], subId, project, t + 1.4, agent);
        out.push(...sub.events);
        out.push([sub.end + 0.2, { type: 'session_end', sessionId: subId }]);
        if (tools.async) {
          out.push([t + 0.8, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: true }]);
          t += 1.4;
        } else {
          out.push([sub.end + 0.6, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: true }]);
          t = sub.end + 1.0;
        }
      } else if (kind === 'end') {
        out.push([t, { type: 'turn_end', sessionId: sid }]);
      }
    }
    return { events: out, end: t };
  }

  // simDt: 재생 속도가 반영된 시간, realDt: 실제 시간. 버퍼는 tail 간격마다 한 번에 비운다(서버 폴링 흉내).
  tick(simDt, realDt, intervalMs) {
    this.t += simDt;
    for (const s of this.scn) {
      if (this.t < s.next) continue;
      const { events, end } = this.compile(s.steps, s.sessionId, s.project, this.t, s.agent);
      this.timeline.push(...events);
      this.timeline.sort((a, b) => a[0] - b[0]);
      s.next = end + s.gap;
    }
    while (this.timeline.length && this.timeline[0][0] <= this.t) this.buffer.push(this.timeline.shift()[1]);
    this.acc += realDt * 1000;
    if (this.acc < intervalMs) return;
    this.acc = 0;
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    const ts = new Date().toISOString();
    for (const ev of batch) this.emit({ ts, ...ev });
    this.onBatch?.(batch.length);
  }
}

export class LiveSource {
  constructor(emit, onStatus) {
    this.emit = emit;
    this.onStatus = onStatus;
    this.es = null;
    this.opened = false;
  }

  start() {
    // 연결마다 서버가 먼저 snapshot 을 보내고(재연결이면 놓친 이벤트만), 이어서 실시간 이벤트를 보낸다.
    this.es = new EventSource('/events');
    this.es.onopen = () => {
      this.opened = true;
      this.onStatus('live');
    };
    this.es.onerror = () => this.onStatus(this.opened ? 'retry' : 'down');
    this.es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot') {
        if (this.onSnapshot) this.onSnapshot(msg.events || [], msg);
        else for (const ev of msg.events || []) this.emit({ ...ev, replay: true });
      } else if (msg.type === 'config') this.onConfig?.(msg);
      else {
        this.emit(msg);
        this.count(1);
      }
    };
  }

  // 같은 폴링 회차에 온 이벤트를 한 프레임 단위로 묶어 "tail +N" 표시에 넘긴다.
  count(n) {
    this.pending = (this.pending || 0) + n;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.onBatch?.(this.pending);
      this.pending = 0;
      this.raf = 0;
    });
  }

  stop() { this.es?.close(); }

  setInterval(ms) {
    fetch('/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMs: ms }),
    }).catch(() => {});
  }
}
