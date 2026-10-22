// 한 층 = 한 프로젝트. 테마별 비직사각형 건물 외형, 가구, 표지판, 자리 배정을 관리한다.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ROOMS, SLOTS, FLOOR_W, FLOOR_D, activeThemeOf, doorOf } from './rooms.js';
import { Board } from './board.js';
import { overflowPos } from './placement.js';
import {
  mats, buildArchive, buildDev, buildServer, buildResearch, buildMeeting, buildDesk, buildLoungeProps,
} from './furniture.js';
import { buildThemeGround } from './theme-grounds.js';
import { buildPalaceProps, buildHanokProps, buildStarshipProps } from './theme-props.js';

export const FLOOR_GAP = 5.4;
export const EXPLODE_GAP = 9.5;

export class Floor {
  constructor(stage, key, index, label = key) {
    this.key = key;
    this.label = label;
    this.index = index;
    this.group = new THREE.Group();
    this.archGroup = new THREE.Group();
    this.group.add(this.archGroup);
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
    const g = this.group;
    for (const [k, r] of Object.entries(ROOMS)) {
      const el = document.createElement('div');
      el.className = 'sign';
      el.dataset.room = k;
      el.style.setProperty('--rc', `var(${r.token})`);
      el.textContent = r.label;
      const o = new CSS2DObject(el);
      g.add(o);
      this.labels.push(o);
    }
    this.tagEl = document.createElement('div');
    this.tagEl.className = 'floortag';
    const tag = new CSS2DObject(this.tagEl);
    tag.position.set(FLOOR_W / 2 - 1.5, -0.3, FLOOR_D / 2 + 0.4);
    g.add(tag);
    this.labels.push(tag);
    this.rebuildTheme(activeThemeOf());
  }

  rebuildTheme(theme = activeThemeOf()) {
    this.theme = theme;
    this.archGroup.clear();
    const ag = this.archGroup;
    this.doors = buildThemeGround(ag, theme);
    if (theme === 'palace') {
      ({ leds: this.leds, globe: this.globe } = buildPalaceProps(ag, this.board));
    } else if (theme === 'hanok') {
      ({ leds: this.leds, globe: this.globe } = buildHanokProps(ag, this.board));
    } else if (theme === 'starship') {
      ({ leds: this.leds, globe: this.globe } = buildStarshipProps(ag, this.board));
    } else {
      buildArchive(ag);
      buildDev(ag);
      this.leds = buildServer(ag);
      this.globe = buildResearch(ag);
      buildMeeting(ag, this.board);
      buildDesk(ag);
      buildLoungeProps(ag);
    }
    this.setShadows(this.shadows, ag);
    this.refreshSigns(theme);
  }

  renameTag() { this.tagEl.textContent = `${this.number} · ${this.label}`; }

  refreshSigns(theme = activeThemeOf()) {
    for (const o of this.labels) {
      const k = o.element?.dataset?.room;
      if (k && ROOMS[k]) {
        o.element.textContent = ROOMS[k].label;
        const d = doorOf(k, theme);
        const [sx, sy, sz] = d.sign || (k === 'lounge' ? [-11.7, 3.0, 0] : [d.x, 1.55, d.z]);
        o.position.set(sx, sy, sz);
      }
    }
    this.renameTag();
  }

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
