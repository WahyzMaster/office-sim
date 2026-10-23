// 테스트 전용 three.js(r160) 부분 구현. 테마 빌더가 쓰는 Object3D·기하·재질만 같은 의미로 흉내 내고,
// 메시의 월드 변환(T*R*S, 부모 사슬 포함)과 기하 정점 샘플을 계산할 수 있게 남긴다. 그리지는 않는다.
export const stats = { geometries: 0, materials: 0, disposed: 0 };
export const FrontSide = 0;
export const BackSide = 1;
export const DoubleSide = 2;
export const SRGBColorSpace = 'srgb';
export const RepeatWrapping = 1000;

export * from './three-record-math.mjs';
import { Vector2, Vector3, Matrix4, Quaternion, Euler, Color } from './three-record-math.mjs';

// 메시를 만든 public/js 소스 위치(scene.js 의 box 도우미는 건너뛴다). 실패 메시지에 쓴다.
function creationSite() {
  const lines = (new Error().stack || '').split('\n');
  const hits = [];
  for (const l of lines) {
    const m = l.match(/public\/js\/([\w.-]+\.js):(\d+)/);
    if (m && m[1] !== 'scene.js') hits.push(`${m[1]}:${m[2]}`);
    if (hits.length === 2) break;
  }
  return hits.join(' < ');
}

// ---- 재질·텍스처 ----
class Material {
  constructor() {
    stats.materials++;
    Object.assign(this, { side: FrontSide, transparent: false, opacity: 1, depthWrite: true, polygonOffset: false,
      polygonOffsetFactor: 0, polygonOffsetUnits: 0, visible: true, needsUpdate: false });
  }
  setValues(p = {}) {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (this[k] instanceof Color) this[k].set(v); else this[k] = v;
    }
    return this;
  }
  clone() {
    const m = new this.constructor();
    for (const k of Object.keys(this)) m[k] = this[k] instanceof Color ? this[k].clone() : this[k];
    return m;
  }
  dispose() { stats.disposed++; }
}
export class MeshStandardMaterial extends Material {
  constructor(p) {
    super();
    Object.assign(this, { isMeshStandardMaterial: true, color: new Color(0xffffff), emissive: new Color(0x000000), emissiveIntensity: 1,
      roughness: 1, metalness: 0, map: null, emissiveMap: null, flatShading: false });
    this.setValues(p);
  }
}
// three 의 Mesh 는 재질이 없으면 흰 MeshBasicMaterial 을 쓴다.
export class MeshBasicMaterial extends Material {
  constructor(p) { super(); Object.assign(this, { isMeshBasicMaterial: true, color: new Color(0xffffff), map: null }); this.setValues(p); }
}
export class LineBasicMaterial extends Material {
  constructor(p) { super(); Object.assign(this, { isLineBasicMaterial: true, color: new Color(0xffffff), linewidth: 1 }); this.setValues(p); }
}
export class CanvasTexture {
  constructor(image) {
    Object.assign(this, { image, colorSpace: '', wrapS: 1001, wrapT: 1001, anisotropy: 1, needsUpdate: true,
      repeat: new Vector2(1, 1), offset: new Vector2(0, 0) });
  }
  dispose() { stats.disposed++; }
}

// ---- 기하: 원시 공간의 정점 샘플 + rotateX/Y/Z·translate·scale 로 구운 행렬(bake) ----
const TAU = Math.PI * 2;
let geomIds = 0;
class BufferGeometry {
  constructor(type, parameters) {
    stats.geometries++;
    this.type = type;
    this.parameters = parameters;
    this.uuid = `g${geomIds++}`;
    this.bake = new Matrix4();
    this.baked = false;
    this._cache = null;
  }
  _raw() { return []; }
  _inside() { return false; }
  get samples() {
    if (!this._cache) this._cache = this._raw().map((p) => new Vector3(...p).applyMatrix4(this.bake).toArray());
    return this._cache;
  }
  // 기하 로컬 좌표의 점이 이 도형의 속(부피) 안인지. 열린 껍질·평면은 언제나 false.
  contains(p) {
    const q = new Vector3(...p).applyMatrix4(this.bake.clone().invert());
    return this._inside(q.x, q.y, q.z);
  }
  _applyBake(m) { this.bake.premultiply(m); this.baked = true; this._cache = null; return this; }
  rotateX(a) { return this._applyBake(new Matrix4().makeRotationX(a)); }
  rotateY(a) { return this._applyBake(new Matrix4().makeRotationY(a)); }
  rotateZ(a) { return this._applyBake(new Matrix4().makeRotationZ(a)); }
  translate(x, y, z) { return this._applyBake(new Matrix4().makeTranslation(x, y, z)); }
  scale(x, y, z) { return this._applyBake(new Matrix4().makeScale(x, y, z)); }
  clone() {
    const g = Object.create(Object.getPrototypeOf(this));
    Object.assign(g, this, { parameters: { ...this.parameters }, bake: this.bake.clone(), _cache: null, uuid: `g${geomIds++}` });
    stats.geometries++;
    return g;
  }
  dispose() { stats.disposed++; }
}

export class BoxGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, depth = 1) { super('BoxGeometry', { width, height, depth }); }
  _raw() {
    const { width: w, height: h, depth: d } = this.parameters;
    const out = [[0, 0, 0]];
    for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) out.push([x, y, z]);
    return out;
  }
  _inside(x, y, z) {
    const { width: w, height: h, depth: d } = this.parameters;
    return Math.abs(x) <= w / 2 + 1e-9 && Math.abs(y) <= h / 2 + 1e-9 && Math.abs(z) <= d / 2 + 1e-9;
  }
}

export class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1) { super('PlaneGeometry', { width, height }); }
  _raw() {
    const { width: w, height: h } = this.parameters;
    return [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [-w / 2, h / 2, 0], [w / 2, h / 2, 0]];
  }
}

// three 와 같은 정점 각도: theta = thetaStart + k/n * thetaLength, x = r sin(theta), z = r cos(theta)
export class CylinderGeometry extends BufferGeometry {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = TAU) {
    super('CylinderGeometry', { radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength });
  }
  get _cyl() { const p = this.parameters; return { rt: p.radiusTop, rb: p.radiusBottom, h: p.height, n: p.radialSegments, open: p.openEnded, t0: p.thetaStart, tl: p.thetaLength }; }
  _raw() {
    const { rt, rb, h, n, t0, tl } = this._cyl;
    const out = [[0, h / 2, 0], [0, -h / 2, 0]];
    const last = tl >= TAU - 1e-9 ? n - 1 : n;
    for (let k = 0; k <= last; k++) {
      const t = t0 + (k / n) * tl;
      if (rt > 0) out.push([rt * Math.sin(t), h / 2, rt * Math.cos(t)]);
      if (rb > 0) out.push([rb * Math.sin(t), -h / 2, rb * Math.cos(t)]);
    }
    return out;
  }
  _inside(x, y, z) {
    const { rt, rb, h, n, open, t0, tl } = this._cyl;
    if (open || tl < TAU - 1e-9 || Math.abs(y) > h / 2 + 1e-9) return false;
    const r = rb + (rt - rb) * (y / h + 0.5);
    const step = TAU / n;
    const rel = (((Math.atan2(x, z) - t0) % TAU) + TAU) % TAU;
    const a = t0 + (Math.floor(rel / step) + 0.5) * step;
    return x * Math.sin(a) + z * Math.cos(a) <= r * Math.cos(Math.PI / n) + 1e-9;
  }
}

export class ConeGeometry extends CylinderGeometry {
  constructor(radius = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = TAU) {
    super(0, radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength);
    this.type = 'ConeGeometry';
    this.parameters = { radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength };
  }
  get _cyl() { const p = this.parameters; return { rt: 0, rb: p.radius, h: p.height, n: p.radialSegments, open: p.openEnded, t0: p.thetaStart, tl: p.thetaLength }; }
}

export class SphereGeometry extends BufferGeometry {
  constructor(radius = 1, widthSegments = 32, heightSegments = 16, phiStart = 0, phiLength = TAU, thetaStart = 0, thetaLength = Math.PI) {
    super('SphereGeometry', { radius, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength });
  }
  _raw() {
    const { radius: r, widthSegments: ws, heightSegments: hs, phiStart, phiLength, thetaStart, thetaLength } = this.parameters;
    const out = [];
    for (let j = 0; j <= hs; j++) {
      const th = thetaStart + (j / hs) * thetaLength;
      for (let i = 0; i <= ws; i++) {
        const ph = phiStart + (i / ws) * phiLength;
        out.push([-r * Math.cos(ph) * Math.sin(th), r * Math.cos(th), r * Math.sin(ph) * Math.sin(th)]);
      }
    }
    return out;
  }
  _inside(x, y, z) {
    const p = this.parameters;
    if (p.phiLength < TAU - 1e-9 || p.thetaLength < Math.PI - 1e-9) return false;
    return Math.hypot(x, y, z) <= p.radius * Math.cos(Math.PI / Math.min(p.widthSegments, 2 * p.heightSegments)) + 1e-9;
  }
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map((v) => v.map((c) => c / Math.hypot(...v)));
export class IcosahedronGeometry extends BufferGeometry {
  constructor(radius = 1, detail = 0) { super('IcosahedronGeometry', { radius, detail }); }
  _raw() {
    const { radius: r, detail } = this.parameters;
    const pts = ICO.slice();
    if (detail > 0) {
      const edge = 2 / Math.hypot(1, PHI); // 단위 구 위 이웃 꼭짓점 거리(1.0515)
      for (let a = 0; a < ICO.length; a++) for (let b = a + 1; b < ICO.length; b++) {
        const d = Math.hypot(ICO[a][0] - ICO[b][0], ICO[a][1] - ICO[b][1], ICO[a][2] - ICO[b][2]);
        if (Math.abs(d - edge) < 0.05) {
          const m = [0, 1, 2].map((k) => ICO[a][k] + ICO[b][k]);
          const l = Math.hypot(...m);
          pts.push(m.map((c) => c / l));
        }
      }
    }
    return pts.map((v) => v.map((c) => c * r));
  }
  _inside(x, y, z) {
    const { radius: r, detail } = this.parameters;
    return Math.hypot(x, y, z) <= r * (detail > 0 ? 0.93 : 0.7947) + 1e-9;
  }
}

// three 와 같이 고리는 XY 평면, 관의 축은 z.
export class TorusGeometry extends BufferGeometry {
  constructor(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc = TAU) {
    super('TorusGeometry', { radius, tube, radialSegments, tubularSegments, arc });
  }
  _raw() {
    const { radius: R, tube: t, arc } = this.parameters;
    const out = [];
    for (let i = 0; i < 24; i++) {
      const u = (i / 24) * arc;
      for (let j = 0; j < 8; j++) {
        const v = (j / 8) * TAU;
        out.push([(R + t * Math.cos(v)) * Math.cos(u), (R + t * Math.cos(v)) * Math.sin(u), t * Math.sin(v)]);
      }
    }
    return out;
  }
  _inside(x, y, z) {
    const { radius: R, tube: t, arc } = this.parameters;
    if (arc < TAU - 1e-9) return false;
    const d = Math.hypot(x, y) - R;
    return d * d + z * z <= t * t + 1e-9;
  }
}

export class WireframeGeometry extends BufferGeometry {
  constructor(geometry) { super('WireframeGeometry', {}); this.source = geometry; }
  _raw() { return this.source.samples; }
}

export class Shape {
  constructor(points = []) { this.points = points.map((p) => new Vector2(p.x, p.y)); }
  moveTo(x, y) { this.points.push(new Vector2(x, y)); return this; }
  lineTo(x, y) { this.points.push(new Vector2(x, y)); return this; }
  getPoints() { return this.points; }
}

// three 는 도형(XY)을 +z 방향으로 depth 만큼 밀어낸다.
export class ExtrudeGeometry extends BufferGeometry {
  constructor(shapes, options = {}) {
    super('ExtrudeGeometry', { depth: options.depth ?? 1, bevelEnabled: options.bevelEnabled ?? true });
    this.shapes = Array.isArray(shapes) ? shapes : [shapes];
  }
  get polygon() { return this.shapes[0].getPoints().map((p) => [p.x, p.y]); }
  _raw() {
    const out = [];
    for (const [x, y] of this.polygon) out.push([x, y, 0], [x, y, this.parameters.depth]);
    return out;
  }
  _inside(x, y, z) {
    if (z < -1e-9 || z > this.parameters.depth + 1e-9) return false;
    let inside = false;
    const poly = this.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}

// ---- 장면 그래프 ----
let objIds = 0;
export class Object3D {
  constructor() {
    this.id = objIds++;
    this.type = 'Object3D';
    this.name = '';
    this.parent = null;
    this.children = [];
    this.position = new Vector3();
    this.rotation = new Euler();
    this.quaternion = new Quaternion();
    this.scale = new Vector3(1, 1, 1);
    this.rotation._onChange(() => this.quaternion.setFromEuler(this.rotation, false));
    this.quaternion._onChange(() => this.rotation.setFromQuaternion(this.quaternion, false));
    this.userData = {};
    this.visible = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.src = creationSite();
  }
  add(...objs) {
    for (const o of objs) {
      if (!o || o === this) continue;
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }
  remove(...objs) {
    for (const o of objs) {
      const i = this.children.indexOf(o);
      if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    }
    return this;
  }
  clear() { return this.remove(...this.children); }
  traverse(fn) { fn(this); for (const c of this.children.slice()) c.traverse(fn); }
  updateMatrixWorld() {}
  matrixLocal() { return new Matrix4().compose(this.position, this.quaternion, this.scale); }
  matrixWorldOf() { return this.parent ? this.parent.matrixWorldOf().multiply(this.matrixLocal()) : this.matrixLocal(); }
  getWorldPosition(v = new Vector3()) { return v.set(0, 0, 0).applyMatrix4(this.matrixWorldOf()); }
  // three 의 Object3D.lookAt(카메라가 아닌 물체): +z 가 목표를 향한다. 부모는 회전이 없다고 본다.
  lookAt(x, y, z) {
    const target = x?.isVector3 || typeof x === 'object' ? x.clone() : new Vector3(x, y, z);
    const m = new Matrix4().lookAt(target, this.getWorldPosition(), new Vector3(0, 1, 0));
    this.quaternion.setFromRotationMatrix(m);
  }
}
export class Group extends Object3D {
  constructor() { super(); this.type = 'Group'; this.isGroup = true; }
}
export class Mesh extends Object3D {
  constructor(geometry, material = new MeshBasicMaterial()) { super(); this.type = 'Mesh'; this.isMesh = true; this.geometry = geometry; this.material = material; }
}
export class InstancedMesh extends Mesh {
  constructor(geometry, material, count) {
    super(geometry, material);
    this.type = 'InstancedMesh';
    this.isInstancedMesh = true;
    this.count = count;
    this.matrices = [];
    this.disposed = false;
  }
  setMatrixAt(i, m) { this.matrices[i] = m.clone(); }
  setColorAt() {}
  dispose() { this.disposed = true; stats.disposed++; }
}
export class LineSegments extends Object3D {
  constructor(geometry, material) { super(); this.type = 'LineSegments'; this.isLineSegments = true; this.geometry = geometry; this.material = material; }
}
