// 성능 측정용 합성 부하 (P3). `#bench` 로 열면 데모/라이브 대신 이 공급원이 돈다: 층 10개 x 직원 6명(서브에이전트 2명 포함).
// 모든 이름과 요약은 지어낸 값이다. 측정은 콘솔이나 자동화에서 window.__officeBench 로 한다:
//   await __officeBench.measure({ seconds: 5, focus: 9 })  rAF 기준 실제 프레임 시간
//   __officeBench.burn({ frames: 300, focus: 'all' })       프레임 함수를 연달아 돌린 CPU 시간 (탭이 가려져도 같다)
//   __officeBench.burn({ frames: 300, gpu: true })          프레임마다 1픽셀 readPixels 로 GPU 가 끝나길 기다린 시간까지
const TOOLS = [
  ['Read', 'parser.mjs'], ['Grep', '"tokenize" src'], ['Edit', 'parser.mjs'], ['Write', 'notes.md'],
  ['Bash', 'npm test'], ['Bash', 'git status'], ['WebSearch', 'three.js shadows'], ['mcp__codegraph__codegraph_callers', 'parse'],
];
const LINES = ['다음 파일을 보자.', '테스트가 깨졌다. 원인을 찾자.', '이 함수는 둘로 나누자.', '문서를 다시 확인하자.'];

const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const r2 = (x) => Math.round(x * 100) / 100;

export class BenchSource {
  constructor(emit, { floors = 10, mains = 4, subs = 2 } = {}) {
    this.emit = emit;
    this.agents = [];
    this.timers = [];
    this.t = 0;
    this.seq = 0;
    for (let f = 0; f < floors; f++) {
      const project = `/bench/project-${String(f + 1).padStart(2, '0')}`;
      const ids = [];
      for (let m = 0; m < mains; m++) {
        const id = `bench-${f}-${m}`;
        ids.push(id);
        this.agents.push({ id, project, sub: false, next: Math.random() * 2 });
      }
      for (let s = 0; s < subs; s++) {
        this.agents.push({ id: `bench-${f}-s${s}`, project, sub: true, parent: ids[s % ids.length], next: 1 + Math.random() * 2 });
      }
    }
  }

  start() {
    for (const a of this.agents) {
      const base = { type: 'session', sessionId: a.id, agent: 'claude-code', project: a.project, projectLabel: a.project.split('/').pop() };
      this.emit(a.sub
        ? { ...base, title: `조사 ${a.id.slice(-2)}`, isSubagent: true, parentSessionId: a.parent, agentType: 'Explore' }
        : { ...base, title: `작업 ${a.id.slice(6)}`, branch: 'bench' });
    }
  }

  // 직원마다 1.5~4초 간격으로 도구/생각/말/계획을 하나씩. 도구는 1~3초 뒤에 끝난다.
  tick(simDt) {
    this.t += simDt;
    const ts = new Date().toISOString();
    for (const a of this.agents) {
      if (this.t < a.next) continue;
      a.next = this.t + 1.5 + Math.random() * 2.5;
      const r = Math.random();
      if (r < 0.62) {
        const [tool, summary] = pick(TOOLS);
        const toolUseId = `toolu_bench_${(this.seq += 1)}`;
        this.emit({ type: 'tool_start', sessionId: a.id, ts, toolUseId, tool, summary });
        this.timers.push({ at: this.t + 1 + Math.random() * 2, ev: { type: 'tool_end', sessionId: a.id, toolUseId, ok: Math.random() > 0.08, error: '지어낸 실패' } });
      } else if (r < 0.8) {
        this.emit({ type: 'thinking', sessionId: a.id, ts, text: pick(LINES), durationMs: 1500 });
      } else if (r < 0.92 || a.sub) {
        this.emit({ type: 'say', sessionId: a.id, ts, text: '지어낸 진행 보고예요.' });
      } else {
        const k = (Math.random() * 3) | 0;
        const items = ['읽기', '고치기', '테스트'].map((content, i) => ({ content, status: i < k ? 'completed' : i === k ? 'in_progress' : 'pending' }));
        this.emit({ type: 'plan', sessionId: a.id, ts, items });
      }
    }
    const due = this.timers.filter((x) => x.at <= this.t);
    if (due.length) this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) this.emit({ ...x.ev, ts, ...(x.ev.ok ? { error: undefined } : { errorKind: 'failed' }) });
  }
}

// office.update / renderer.render / labels.render 시간을 프레임마다 모은다.
export function installBench({ office, stage, frame }) {
  const acc = { update: 0, gl: 0, labels: 0 };
  const wrap = (obj, key, slot) => {
    const fn = obj[key].bind(obj);
    obj[key] = (...args) => {
      const t0 = performance.now();
      const out = fn(...args);
      acc[slot] += performance.now() - t0;
      return out;
    };
  };
  wrap(office, 'update', 'update');
  wrap(stage.renderer, 'render', 'gl');
  wrap(stage.labels, 'render', 'labels');
  const take = () => {
    const out = { ...acc };
    acc.update = acc.gl = acc.labels = 0;
    return out;
  };
  const focus = (f) => {
    if (f !== undefined) office.focus(f);
  };
  const snapshot = () => {
    const info = stage.renderer.info;
    const labels = [...document.querySelectorAll('.labels > *')];
    return {
      floors: office.floors.length,
      agents: office.agents.size,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      labelsShown: labels.filter((el) => el.style.display !== 'none').length,
      labelsTotal: labels.length,
      domNodes: document.getElementsByTagName('*').length,
      heapMB: performance.memory ? r2(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  };
  const api = {
    // rAF 로 실제 프레임 간격을 잰다. 탭이 보일 때만 의미가 있다.
    async measure({ seconds = 5, focus: f } = {}) {
      focus(f);
      await new Promise((r) => setTimeout(r, 600)); // 카메라/층 이동이 가라앉을 때까지
      take();
      const gaps = [];
      let frames = 0;
      let last = performance.now();
      const end = last + seconds * 1000;
      await new Promise((resolve) => {
        const step = (now) => {
          gaps.push(now - last);
          last = now;
          frames += 1;
          if (now < end) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      const t = take();
      gaps.sort((a, b) => a - b);
      return {
        mode: 'raf', focus: office.overview ? 'all' : office.focusIndex, frames,
        fps: r2(frames / seconds), frameP50: r2(pct(gaps, 0.5)), frameP95: r2(pct(gaps, 0.95)),
        updateMs: r2(t.update / frames), glMs: r2(t.gl / frames), labelsMs: r2(t.labels / frames), ...snapshot(),
      };
    },
    // 프레임 함수를 연달아 돌려 프레임당 CPU 시간을 잰다. gpu: true 면 GPU 가 그 프레임을 끝낼 때까지 기다린 시간도 넣는다.
    burn({ frames = 300, focus: f, gpu = false } = {}) {
      focus(f);
      const gl = stage.renderer.getContext();
      const px = new Uint8Array(4);
      const run = () => {
        frame(1 / 60);
        if (gpu) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      };
      for (let i = 0; i < 60; i++) run(); // 데우기 + 카메라 이동 가라앉히기
      take();
      const times = [];
      for (let i = 0; i < frames; i++) {
        const t0 = performance.now();
        run();
        times.push(performance.now() - t0);
      }
      const t = take();
      times.sort((a, b) => a - b);
      return {
        mode: gpu ? 'burn+gpu' : 'burn', focus: office.overview ? 'all' : office.focusIndex, frames,
        cpuP50: r2(pct(times, 0.5)), cpuP95: r2(pct(times, 0.95)),
        updateMs: r2(t.update / frames), glMs: r2(t.gl / frames), labelsMs: r2(t.labels / frames), ...snapshot(),
      };
    },
  };
  window.__officeBench = api;
  return api;
}
