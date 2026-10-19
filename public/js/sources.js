// 이벤트 공급원. 둘 다 같은 이벤트 스키마를 emit(ev) 로 흘려보낸다.
// - MockSource: 아티팩트용 가짜 세션(모든 경로/이름은 예시 데이터).
// - LiveSource: 로컬 서버의 GET /events (SSE) 와 POST /config.

const STATUS = ['pending', 'in_progress', 'completed'];

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
    sessionId: 'demo-rules', project: 'omni-app', title: '알림 규칙 점검', branch: 'chore/notification-rules', start: 2.4, gap: 12,
    steps: [
      ['think', 'Firestore 규칙 문서부터 최신 내용을 확인하자.', 2200],
      ['tool', 'mcp__Context7__get-library-docs', 'firestore security rules'],
      ['tool', 'WebSearch', 'firestore rules request.time'],
      ['agent', 'Explore', '알림 규칙 사용처 조사', [
        ['tool', 'Glob', '**/*.rules'],
        ['tool', 'Grep', '"notifications" firestore.rules'],
        ['tool', 'Read', 'firestore.rules'],
        ['say', '사용처 4곳을 찾았어요.'],
      ]],
      ['tool', 'mcp__tavily__tavily_search', 'rules expiry best practice', { fail: '429 · 검색 한도 초과' }],
      ['think', '검색 한도에 걸렸다. 문서 결과만으로 정리하자.', 1800],
      ['tool', 'Read', 'firestore.rules'],
      ['tool', 'Edit', 'firestore.rules'],
      ['tool', 'Bash', 'firebase emulators:exec "npm run test:rules"', { dur: 2.4, fail: '사용자가 실행을 거절함', kind: 'denied' }],
      ['say', '규칙 세 곳에 만료 검증을 추가했어요.'],
      ['end'],
    ],
  },
  {
    sessionId: 'demo-score', project: 'matching-api', title: '매칭 점수 리팩터링', branch: 'refactor/score', start: 1.2, gap: 10,
    steps: [
      ['plan', [['점수 계산 위치 찾기', 1], ['계산 로직 통합', 0], ['타입 검사와 테스트', 0]]],
      ['tool', 'Glob', 'src/**/score*.ts'],
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
    this.scn = SCENARIOS.map((s) => ({ ...s, next: s.start + 0.8 }));
    for (const s of this.scn) {
      this.timeline.push([s.start, { type: 'session', sessionId: s.sessionId, project: s.project, title: s.title, branch: s.branch }]);
    }
    this.timeline.sort((a, b) => a[0] - b[0]);
  }

  start() {}

  id() {
    this.seq += 1;
    return `toolu_demo_${this.seq.toString(36)}`;
  }

  compile(steps, sid, project, t0) {
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
        out.push([t, { type: 'tool_start', sessionId: sid, toolUseId: id, tool: step[1], summary: step[2] }]);
        out.push([t + dur, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: !o.fail, error: o.fail, errorKind: o.fail ? (o.kind || 'failed') : undefined }]);
        t += dur + 0.5;
      } else if (kind === 'ask') {
        const id = this.id();
        out.push([t, { type: 'tool_start', sessionId: sid, toolUseId: id, tool: 'AskUserQuestion', summary: step[1], question: step[1], options: step[2] }]);
        t += step[3];
        out.push([t, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: true }]);
        t += 0.6;
      } else if (kind === 'say') {
        out.push([t, { type: 'say', sessionId: sid, text: step[1] }]);
        t += 1.2;
      } else if (kind === 'agent') {
        const id = this.id();
        const subId = `${sid}-sub-${id.slice(-4)}`;
        out.push([t, { type: 'tool_start', sessionId: sid, toolUseId: id, tool: 'Agent', summary: `${step[1]} · ${step[2]}` }]);
        out.push([t + 0.4, { type: 'session', sessionId: subId, project, title: step[2], agentType: step[1], isSubagent: true, parentSessionId: sid }]);
        const sub = this.compile(step[3], subId, project, t + 1.4);
        out.push(...sub.events);
        out.push([sub.end + 0.2, { type: 'session_end', sessionId: subId }]);
        out.push([sub.end + 0.6, { type: 'tool_end', sessionId: sid, toolUseId: id, ok: true }]);
        t = sub.end + 1.0;
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
      const { events, end } = this.compile(s.steps, s.sessionId, s.project, this.t);
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
