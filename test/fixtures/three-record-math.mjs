// 테스트 전용 three.js(r160) 수학 클래스: 벡터·행렬·사원수·오일러각·색. three-record.mjs 가 다시 내보낸다.
export class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
  clone() { return new Vector2(this.x, this.y); }
}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { return this.set(s, s, s); }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
  multiplyScalar(s) { return this.set(this.x * s, this.y * s, this.z * s); }
  negate() { return this.multiplyScalar(-1); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this.multiplyScalar(1 / (this.length() || 1)); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerp(v, t) { return this.set(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
  crossVectors(a, b) { return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
  applyMatrix4(m) {
    const e = m.elements;
    const { x, y, z } = this;
    return this.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
  }
  toArray() { return [this.x, this.y, this.z]; }
}

export class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  identity() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; return this; }
  copy(m) { this.elements = m.elements.slice(); return this; }
  clone() { return new Matrix4().copy(this); }
  multiply(m) { return this.multiplyMatrices(this, m); }
  premultiply(m) { return this.multiplyMatrices(m, this); }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        te[c * 4 + r] = ae[r] * be[c * 4] + ae[4 + r] * be[c * 4 + 1] + ae[8 + r] * be[c * 4 + 2] + ae[12 + r] * be[c * 4 + 3];
      }
    }
    this.elements = te;
    return this;
  }
  makeScale(x, y, z) { this.identity(); this.elements[0] = x; this.elements[5] = y; this.elements[10] = z; return this; }
  makeTranslation(x, y, z) { this.identity(); return this.setPosition(x, y, z); }
  setPosition(x, y, z) {
    if (x?.isVector3 || typeof x === 'object') ({ x, y, z } = x);
    this.elements[12] = x; this.elements[13] = y; this.elements[14] = z;
    return this;
  }
  makeRotationX(a) { const c = Math.cos(a), s = Math.sin(a); this.identity(); Object.assign(this.elements, { 5: c, 6: s, 9: -s, 10: c }); return this; }
  makeRotationY(a) { const c = Math.cos(a), s = Math.sin(a); this.identity(); Object.assign(this.elements, { 0: c, 2: -s, 8: s, 10: c }); return this; }
  makeRotationZ(a) { const c = Math.cos(a), s = Math.sin(a); this.identity(); Object.assign(this.elements, { 0: c, 1: s, 4: -s, 5: c }); return this; }
  compose(p, q, s) {
    const { x, y, z, w } = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    this.elements = [
      (1 - (yy + zz)) * s.x, (xy + wz) * s.x, (xz - wy) * s.x, 0,
      (xy - wz) * s.y, (1 - (xx + zz)) * s.y, (yz + wx) * s.y, 0,
      (xz + wy) * s.z, (yz - wx) * s.z, (1 - (xx + yy)) * s.z, 0,
      p.x, p.y, p.z, 1,
    ];
    return this;
  }
  // 아핀 행렬의 역행렬(마지막 행 0,0,0,1 가정).
  invert() {
    const e = this.elements;
    const a = e[0], b = e[4], c = e[8], d = e[1], f = e[5], g = e[9], h = e[2], i = e[6], j = e[10];
    const det = a * (f * j - g * i) - b * (d * j - g * h) + c * (d * i - f * h);
    const k = 1 / det;
    const r = [
      (f * j - g * i) * k, -(d * j - g * h) * k, (d * i - f * h) * k,
      -(b * j - c * i) * k, (a * j - c * h) * k, -(a * i - b * h) * k,
      (b * g - c * f) * k, -(a * g - c * d) * k, (a * f - b * d) * k,
    ];
    const tx = e[12], ty = e[13], tz = e[14];
    this.elements = [
      r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0,
      -(r[0] * tx + r[3] * ty + r[6] * tz), -(r[1] * tx + r[4] * ty + r[7] * tz), -(r[2] * tx + r[5] * ty + r[8] * tz), 1,
    ];
    return this;
  }
  // three 의 Matrix4.lookAt: z 축이 eye - target 을 향하는 회전.
  lookAt(eye, target, up) {
    const z = eye.clone().sub(target);
    if (z.length() === 0) z.z = 1;
    z.normalize();
    const x = new Vector3().crossVectors(up, z);
    if (x.length() === 0) { z.z += 0.0001; z.normalize(); x.crossVectors(up, z); }
    x.normalize();
    const y = new Vector3().crossVectors(z, x);
    const e = this.elements;
    e[0] = x.x; e[4] = y.x; e[8] = z.x; e[1] = x.y; e[5] = y.y; e[9] = z.y; e[2] = x.z; e[6] = y.z; e[10] = z.z;
    return this;
  }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this._x = x; this._y = y; this._z = z; this._w = w; this._cb = () => {}; }
  get x() { return this._x; } set x(v) { this._x = v; this._cb(); }
  get y() { return this._y; } set y(v) { this._y = v; this._cb(); }
  get z() { return this._z; } set z(v) { this._z = v; this._cb(); }
  get w() { return this._w; } set w(v) { this._w = v; this._cb(); }
  _onChange(cb) { this._cb = cb; return this; }
  set(x, y, z, w, update = true) { this._x = x; this._y = y; this._z = z; this._w = w; if (update) this._cb(); return this; }
  copy(q) { return this.set(q.x, q.y, q.z, q.w); }
  clone() { return new Quaternion(this._x, this._y, this._z, this._w); }
  setFromEuler(e, update = true) {
    const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
    const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
    return this.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3, update);
  }
  setFromUnitVectors(a, b) {
    let r = a.dot(b) + 1;
    let q;
    if (r < 1e-8) {
      r = 0;
      q = Math.abs(a.x) > Math.abs(a.z) ? [-a.y, a.x, 0, r] : [0, -a.z, a.y, r];
    } else {
      q = [a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, r];
    }
    const l = Math.hypot(...q);
    return this.set(q[0] / l, q[1] / l, q[2] / l, q[3] / l);
  }
  setFromRotationMatrix(m) {
    const e = m.elements;
    const m11 = e[0], m12 = e[4], m13 = e[8], m21 = e[1], m22 = e[5], m23 = e[9], m31 = e[2], m32 = e[6], m33 = e[10];
    const tr = m11 + m22 + m33;
    let s;
    if (tr > 0) {
      s = 0.5 / Math.sqrt(tr + 1);
      return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
    }
    if (m11 > m22 && m11 > m33) {
      s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
    }
    if (m22 > m33) {
      s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
    }
    s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
}

export class Euler {
  constructor(x = 0, y = 0, z = 0) { this._x = x; this._y = y; this._z = z; this.order = 'XYZ'; this._cb = () => {}; }
  get x() { return this._x; } set x(v) { this._x = v; this._cb(); }
  get y() { return this._y; } set y(v) { this._y = v; this._cb(); }
  get z() { return this._z; } set z(v) { this._z = v; this._cb(); }
  _onChange(cb) { this._cb = cb; return this; }
  set(x, y, z) { this._x = x; this._y = y; this._z = z; this._cb(); return this; }
  copy(e) { return this.set(e.x, e.y, e.z); }
  setFromQuaternion(q, update = true) {
    const m = new Matrix4().compose(new Vector3(), q, new Vector3(1, 1, 1)).elements;
    const m11 = m[0], m12 = m[4], m13 = m[8], m22 = m[5], m23 = m[9], m32 = m[6], m33 = m[10];
    this._y = Math.asin(Math.min(1, Math.max(-1, m13)));
    if (Math.abs(m13) < 0.9999999) { this._x = Math.atan2(-m23, m33); this._z = Math.atan2(-m12, m11); } else { this._x = Math.atan2(m32, m22); this._z = 0; }
    if (update) this._cb();
    return this;
  }
}

export class Color {
  constructor(v) { this.r = 1; this.g = 1; this.b = 1; if (v !== undefined) this.set(v); }
  set(v) {
    if (v instanceof Color) return this.copy(v);
    if (typeof v === 'number') return this.setHex(v);
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^#[0-9a-f]{6}$/i.test(s)) return this.setHex(parseInt(s.slice(1), 16));
      if (/^#[0-9a-f]{3}$/i.test(s)) return this.setHex(parseInt(s.slice(1).replace(/./g, '$&$&'), 16));
    }
    return this;
  }
  setHex(h) { this.r = ((h >> 16) & 255) / 255; this.g = ((h >> 8) & 255) / 255; this.b = (h & 255) / 255; return this; }
  setHSL() { return this; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color().copy(this); }
  getHex() { return (Math.round(this.r * 255) << 16) + (Math.round(this.g * 255) << 8) + Math.round(this.b * 255); }
  getHexString() { return this.getHex().toString(16).padStart(6, '0'); }
}
Vector3.prototype.isVector3 = true;
