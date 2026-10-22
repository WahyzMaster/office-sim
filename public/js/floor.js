// 한 층 = 한 프로젝트. 바닥, 벽, 가구, 표지판, 자리 배정을 관리한다.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ROOMS, SLOTS, FLOOR_W, FLOOR_D, CORRIDOR, doorOf } from './rooms.js';
import { box } from './scene.js';
import { Board } from './board.js';
import { overflowPos } from './placement.js';
import {
  mats, buildArchive, buildDev, buildServer, buildResearch, buildMeeting, buildDesk, buildLounge,
} from './furniture.js';

export const FLOOR_GAP = 5.4;
export const EXPLODE_GAP = 9.5;

export class Floor {
  constructor(stage, key, index, label = key) {
    this.key = key;
    this.label = label;
    this.index = index;
    this.group = new THREE.Group();
    this.goalY = 0;
    this.agents = new Set();
    this.labels = [];
    this.busy = {};
    this.ledT = 0;
    this.elevT = 0;
    this.doorOpen = 0;
    this.occupied = Object.fromEntries(Object.entries(SLOTS).map(([k, s]) => [k, s.map(() => null)]));
    this.waiting = {}; // 자리가 없어 기다리는 직원: 방마다 빈칸을 다시 쓰는 줄(번호 = 기다리는 곳)
    this.board = new Board();
    this.animate = true; // detail.js: 숨은 층은 LED/지구본/문 애니메이션을 건너뛴다
    this.shadows = true;
    this.build();
    stage.scene.add(this.group);
  }

  get number() { return `${this.index + 1}F`; }

  build() {
    const M = mats();
    const g = this.group;
    box(g, M.slab, FLOOR_W + 0.6, 0.5, FLOOR_D + 0.6, 0, -0.5, 0);
    box(g, M.floor, FLOOR_W, 0.02, FLOOR_D, 0, 0, 0, false);
    box(g, M.corridor, FLOOR_W, 0.03, CORRIDOR * 2, 0, 0, 0, false);
    for (const [k, r] of Object.entries(ROOMS)) {
      if (k === 'lounge') continue;
      const cz = r.side === 'top' ? -5 : 5;
      box(g, M.rug[k], r.x1 - r.x0 - 1.0, 0.03, 5.0, (r.x0 + r.x1) / 2, 0.01, cz, false);
    }

    // 먼 쪽 두 벽만 높게, 나머지는 낮은 칸막이(돌하우스 구도).
    box(g, M.wall, FLOOR_W + 0.3, 2.8, 0.25, 0, 0, -FLOOR_D / 2 - 0.12);
    box(g, M.wall, 0.25, 2.8, FLOOR_D + 0.3, -FLOOR_W / 2 - 0.12, 0, 0);
    for (const z of [-CORRIDOR, CORRIDOR]) {
      let x = -FLOOR_W / 2;
      for (const dx of [-8, 0, 8]) {
        const end = dx - 1;
        if (end > x) box(g, M.part, end - x, 0.9, 0.14, (x + end) / 2, 0, z);
        x = dx + 1;
      }
      box(g, M.part, FLOOR_W / 2 - x, 0.9, 0.14, (x + FLOOR_W / 2) / 2, 0, z);
    }
    for (const x of [-4, 4]) {
      box(g, M.part, 0.14, 0.9, 6, x, 0, -5);
      box(g, M.part, 0.14, 0.9, 6, x, 0, 5);
    }

    buildArchive(g);
    buildDev(g);
    this.leds = buildServer(g);
    this.globe = buildResearch(g);
    buildMeeting(g, this.board);
    buildDesk(g);
    this.doors = buildLounge(g);

    for (const [k, r] of Object.entries(ROOMS)) {
      const el = document.createElement('div');
      el.className = 'sign';
      el.style.setProperty('--rc', `var(${r.token})`);
      el.textContent = r.label;
      const o = new CSS2DObject(el);
      if (k === 'lounge') o.position.set(-11.7, 3.0, 0);
      else {
        const d = doorOf(k);
        o.position.set(d.x, 1.55, d.z);
      }
      g.add(o);
      this.labels.push(o);
    }
    this.tagEl = document.createElement('div');
    this.tagEl.className = 'floortag';
    const tag = new CSS2DObject(this.tagEl);
    tag.position.set(FLOOR_W / 2 - 1.5, -0.3, FLOOR_D / 2 + 0.4);
    g.add(tag);
    this.labels.push(tag);
    this.renameTag();
  }

  renameTag() { this.tagEl.textContent = `${this.number} · ${this.label}`; }

  // 라벨을 숨길 때는 DOM 도 바로 숨긴다: 렌더러가 이 층을 더 돌지 않아 display 를 다시 쓰지 않는다 (detail.js).
  setLabelsVisible(v) {
    for (const o of this.labels) {
      o.visible = v;
      if (!v) o.element.style.display = 'none';
    }
  }

  // 그림자를 드리울지 (detail.js). 메시가 원래 드리우던 값은 userData 에 남겨 두고 그 값만 켜고 끈다.
  setShadows(on, root = this.group) {
    if (root === this.group) this.shadows = on; // 직원 하나(root)만 맞출 때는 층의 값을 바꾸지 않는다
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData.castShadow === undefined) o.userData.castShadow = o.castShadow;
      o.castShadow = on && o.userData.castShadow;
    });
  }

  claim(room, agent, prefer = -1) {
    const occ = this.occupied[room];
    if (!occ) return -1;
    if (prefer >= 0 && prefer < occ.length && (!occ[prefer] || occ[prefer] === agent)) {
      const old = occ.indexOf(agent);
      if (old >= 0) occ[old] = null;
      occ[prefer] = agent;
      return prefer;
    }
    let i = occ.indexOf(agent);
    if (i >= 0) return i;
    i = occ.indexOf(null);
    if (i >= 0) occ[i] = agent;
    return i;
  }

  release(room, agent) {
    const occ = this.occupied[room];
    if (occ) {
      const i = occ.indexOf(agent);
      if (i >= 0) occ[i] = null;
    }
    const w = this.waiting[room];
    if (w) {
      const k = w.indexOf(agent);
      if (k >= 0) w[k] = null;
    }
  }

  // 자리가 꽉 차면 문 앞(라운지는 복도 왼쪽)에 줄을 선다. 줄 번호는 비어 있는 가장 앞 칸.
  waitSpot(room, agent) {
    const w = (this.waiting[room] ||= []);
    let k = w.indexOf(agent);
    if (k < 0) {
      k = w.indexOf(null);
      if (k < 0) k = w.length;
      w[k] = agent;
    }
    return k;
  }

  slotPos(room, i, agent) {
    if (i >= 0) return SLOTS[room][i];
    return overflowPos(room, this.waitSpot(room, agent));
  }

  // 이 층에서 아직 아무도 쓰지 않는 가장 작은 lane 번호.
  laneIndex() {
    const used = new Set([...this.agents].map((a) => a.laneIdx));
    let k = 0;
    while (used.has(k)) k += 1;
    return k;
  }

  openElevator() { this.elevT = 1.4; }

  update(dt, realDt) {
    this.group.position.y += (this.goalY - this.group.position.y) * Math.min(1, realDt * 5);
    if (!this.animate) return;
    const M = mats();
    this.ledT -= dt;
    if (this.ledT <= 0) {
      const busy = !!this.busy.server;
      this.ledT = busy ? 0.06 : 0.22;
      for (let n = 0; n < (busy ? 8 : 4); n++) {
        const led = this.leds[(Math.random() * this.leds.length) | 0];
        const r = Math.random();
        led.material = r < 0.55 ? M.ledOn : r < (busy ? 0.92 : 0.62) ? M.ledBusy : M.ledOff;
      }
    }
    this.globe.rotation.y += dt * (this.busy.research ? 1.8 : 0.3);
    this.elevT = Math.max(0, this.elevT - dt);
    this.doorOpen += ((this.elevT > 0 ? 1 : 0) - this.doorOpen) * Math.min(1, dt * 6);
    const o = 0.46 + this.doorOpen * 0.78;
    this.doors[0].position.z = -o;
    this.doors[1].position.z = o;
  }

  dispose(stage) {
    for (const o of this.labels) o.element.remove();
    stage.scene.remove(this.group);
  }
}
