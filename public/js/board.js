// 회의실 화이트보드. 계획(할 일 목록)을 손글씨로 그린다.
import * as THREE from 'three';
import { glowing } from './scene.js';
import { tr } from './rooms.js';

const W = 1024;
const H = 488;
const MAX_HISTORY = 8;
const INK = { title: '#1d3f8f', text: '#22303d', done: '#7b8794', doing: '#c8372d', box: '#22303d', check: '#2f8a4e' };
const pen = (size) => `${size}px "Nanum Pen Script", "Gaegu", cursive`;

function clip(g, s, width) {
  if (g.measureText(s).width <= width) return s;
  let t = s;
  while (t.length > 1 && g.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

export class Board {
  constructor() {
    this.canvas = typeof document !== 'undefined'
      ? document.createElement('canvas')
      : { width: W, height: H, getContext: () => null };
    this.canvas.width = W;
    this.canvas.height = H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.material = glowing(
      new THREE.MeshStandardMaterial({ map: this.tex, emissive: 0xffffff, emissiveMap: this.tex, roughness: 0.35 }),
      0.3,
    );
    this.owner = null;
    this.title = '';
    this.items = [];
    this.ink = INK.title;
    this.updatedAt = 0;
    this.history = [];
    this.listeners = new Set();
    this.draw();
  }

  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  syncOwnerTitle(owner, title) {
    if (!owner || !title) return;
    let changed = false;
    if (this.owner === owner && this.title !== title) {
      this.title = title;
      changed = true;
    }
    for (const h of this.history) {
      if (h.owner === owner && h.title !== title) {
        h.title = title;
        changed = true;
      }
    }
    if (changed) {
      this.draw();
      for (const fn of this.listeners) fn(this);
    }
  }

  set(owner, title, items, ink) {
    this.owner = owner;
    this.title = title;
    this.items = Array.isArray(items)
      ? items.map((it) => ({ content: String(it?.content ?? ''), status: it?.status || 'pending' }))
      : [];
    this.ink = ink || INK.title;
    this.updatedAt = Date.now();
    if (this.items.length > 0 && owner) {
      const entry = { owner, title: title || String(owner), items: this.items, ink: this.ink, updatedAt: this.updatedAt };
      this.history = [entry, ...this.history.filter((h) => h.owner !== owner)].slice(0, MAX_HISTORY);
    }
    this.draw();
    for (const fn of this.listeners) fn(this);
  }

  sameContent(owner, items) {
    return this.owner === owner
      && this.items.length === items.length
      && this.items.every((it, i) => it.content === items[i].content);
  }

  draw() {
    const g = this.canvas.getContext?.('2d');
    if (!g) return;
    g.textAlign = 'left';
    g.fillStyle = '#fbfbf7';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(110, 130, 150, 0.06)';
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.ellipse(140 + i * 190, 280 + ((i * 53) % 130), 150, 30, -0.2, 0, Math.PI * 2);
      g.fill();
    }
    if (!this.items.length) {
      g.fillStyle = '#8f9aa5';
      g.font = pen(60);
      g.fillText(tr('아직 세운 계획이 없어요', 'No active plan yet'), 56, 130);
      g.font = pen(42);
      g.fillText(tr('계획을 세우면 여기에 적어 둘게요', 'Task checklists will appear here'), 56, 196);
      this.tex.needsUpdate = true;
      return;
    }
    const done = this.items.filter((i) => i.status === 'completed').length;
    g.fillStyle = this.ink;
    g.font = pen(66);
    g.fillText(clip(g, this.title, 760), 48, 78);
    g.strokeStyle = this.ink;
    g.lineWidth = 4;
    g.beginPath();
    for (let x = 48; x < 520; x += 8) {
      const y = 94 + Math.sin(x / 18) * 3;
      if (x === 48) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.font = pen(50);
    g.fillStyle = INK.doing;
    g.textAlign = 'right';
    g.fillText(`${done}/${this.items.length}`, W - 48, 78);
    g.textAlign = 'left';

    const max = this.items.length > 6 ? 5 : 6;
    let y = 160;
    for (const it of this.items.slice(0, max)) {
      const st = it.status;
      g.lineWidth = 4;
      g.strokeStyle = INK.box;
      g.strokeRect(58, y - 34, 34, 34);
      if (st === 'completed') {
        g.strokeStyle = INK.check;
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(62, y - 18);
        g.lineTo(74, y - 4);
        g.lineTo(100, y - 44);
        g.stroke();
      } else if (st === 'in_progress') {
        g.fillStyle = INK.doing;
        g.beginPath();
        g.moveTo(22, y - 32);
        g.lineTo(44, y - 17);
        g.lineTo(22, y - 2);
        g.closePath();
        g.fill();
      }
      g.font = pen(st === 'in_progress' ? 50 : 46);
      g.fillStyle = st === 'completed' ? INK.done : st === 'in_progress' ? INK.doing : INK.text;
      const text = clip(g, it.content, W - 190);
      g.fillText(text, 112, y - 4);
      if (st === 'completed') {
        const w = g.measureText(text).width;
        g.strokeStyle = INK.done;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(110, y - 18);
        g.lineTo(114 + w, y - 20);
        g.stroke();
      }
      y += 54;
    }
    if (this.items.length > max) {
      g.font = pen(40);
      g.fillStyle = INK.done;
      g.fillText(tr(`+ ${this.items.length - max}개 더`, `+ ${this.items.length - max} more`), 112, y - 6);
    }
    g.font = pen(34);
    g.fillStyle = INK.done;
    g.textAlign = 'right';
    g.fillText(tr('클릭 · 상세 보기', 'Click · full plan'), W - 48, H - 18);
    g.textAlign = 'left';
    this.tex.needsUpdate = true;
  }
}
