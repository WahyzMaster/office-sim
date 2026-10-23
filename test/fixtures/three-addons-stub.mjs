// 'three/addons/...' 대신 쓰는 빈 클래스. floor.js·scene.js 가 모듈을 읽을 때 이름만 있으면 된다.
import { Object3D } from './three-record.mjs';

export class CSS2DObject extends Object3D {
  constructor(element) { super(); this.element = element; }
}
export class CSS2DRenderer {
  constructor() { this.domElement = { style: {} }; }
  setSize() {}
  render() {}
}
export class OrbitControls {
  constructor() { this.target = { x: 0, y: 0, z: 0 }; this.mouseButtons = {}; this.touches = {}; }
  addEventListener() {}
  update() {}
}
