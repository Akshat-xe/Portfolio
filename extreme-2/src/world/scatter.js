// Deterministic instanced scatter (conifers, broadleaf, rocks, marker posts).
//
// The world is diced into 40 m cells. Every cell's contents are a pure function
// of its integer coordinates, so scenery never shifts or re-rolls when you
// drive away and come back. Cells stream in and out of a fixed pool of
// instance slots; populating is amortised across frames from a queue.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from '../lib/alea.js';
import { WATER_LEVEL } from './heightfield.js';

const CELL = 40;
const RADIUS = 13;          // cells -> 520 m of scenery
const TREE_CAP = 4200;
const ROCK_CAP = 1600;
const POST_CAP = 900;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3(0, 0, 0);
const _one = new THREE.Vector3(1, 1, 1);

class Pool {
  constructor(geometry, material, capacity, scene) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    scene.add(this.mesh);

    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.freeTop = capacity;

    // Park every instance at zero scale.
    _m.compose(_zero, _q.identity(), _zero);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  take() { return this.freeTop > 0 ? this.free[--this.freeTop] : -1; }
  give(slot) {
    _m.compose(_zero, _q.identity(), _zero);
    this.mesh.setMatrixAt(slot, _m);
    this.free[this.freeTop++] = slot;
  }
}

export class Scatter {
  constructor(heightfield, road, scene) {
    this.hf = heightfield;
    this.road = road;
    this.density = 1;

    const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x7b7772, flatShading: true, fog: true });
    const postMat = new THREE.MeshLambertMaterial({ color: 0xe8e4d8, fog: true });

    this.trees = new Pool(makeTreeGeometry(), treeMat, TREE_CAP, scene);
    this.rocks = new Pool(makeRockGeometry(), rockMat, ROCK_CAP, scene);
    this.posts = new Pool(makePostGeometry(), postMat, POST_CAP, scene);

    this.cells = new Map();
    this.queue = [];
    this.centreCell = null;
  }

  // Scenery never casts a real shadow — the faked-AO splat map stands in for
  // it. Kept as a no-op so the settings wiring has a stable surface.
  setShadows() {}

  setDensity(d) {
    if (d === this.density) return;
    this.density = d;
    for (const key of Array.from(this.cells.keys())) this._release(key);
    this.centreCell = null;
  }

  update(camX, camZ) {
    const cx = Math.floor(camX / CELL);
    const cz = Math.floor(camZ / CELL);
    const key = cx + ':' + cz;
    if (key === this.centreCell) return;
    this.centreCell = key;

    const r2 = RADIUS * RADIUS;
    for (const k of Array.from(this.cells.keys())) {
      const [kx, kz] = k.split(':');
      const dx = +kx - cx, dz = +kz - cz;
      if (dx * dx + dz * dz > r2 * 1.35) this._release(k);
    }

    this.queue.length = 0;
    for (let i = -RADIUS; i <= RADIUS; i++) {
      for (let j = -RADIUS; j <= RADIUS; j++) {
        if (i * i + j * j > r2) continue;
        const k = (cx + i) + ':' + (cz + j);
        if (!this.cells.has(k)) this.queue.push(cx + i, cz + j);
      }
    }
    // Nearest cells first so pop-in happens far away.
    this._sortQueue(cx, cz);
  }

  _sortQueue(cx, cz) {
    const n = this.queue.length / 2;
    const idx = [];
    for (let i = 0; i < n; i++) {
      const dx = this.queue[i * 2] - cx;
      const dz = this.queue[i * 2 + 1] - cz;
      idx.push([dx * dx + dz * dz, this.queue[i * 2], this.queue[i * 2 + 1]]);
    }
    idx.sort((a, b) => b[0] - a[0]); // furthest first; we pop() from the end
    this.queue.length = 0;
    for (const e of idx) this.queue.push(e[1], e[2]);
  }

  processQueue(budget = 6) {
    let n = 0;
    while (this.queue.length >= 2 && n < budget) {
      const cz = this.queue.pop();
      const cx = this.queue.pop();
      this._populate(cx, cz);
      n++;
    }
    if (n) {
      this.trees.mesh.instanceMatrix.needsUpdate = true;
      this.rocks.mesh.instanceMatrix.needsUpdate = true;
      this.posts.mesh.instanceMatrix.needsUpdate = true;
      if (this.trees.mesh.instanceColor) this.trees.mesh.instanceColor.needsUpdate = true;
    }
    return this.queue.length / 2;
  }

  dispose() {
    this.queue.length = 0;
    this.cells.clear();
    for (const pool of [this.trees, this.rocks, this.posts]) {
      pool.mesh.geometry.dispose();
      pool.mesh.material.dispose();
      pool.mesh.removeFromParent();
      pool.mesh.dispose();
    }
  }

  _release(key) {
    const rec = this.cells.get(key);
    if (!rec) return;
    for (const s of rec.t) this.trees.give(s);
    for (const s of rec.r) this.rocks.give(s);
    for (const s of rec.p) this.posts.give(s);
    this.cells.delete(key);
    this.trees.mesh.instanceMatrix.needsUpdate = true;
    this.rocks.mesh.instanceMatrix.needsUpdate = true;
    this.posts.mesh.instanceMatrix.needsUpdate = true;
  }

  _populate(cx, cz) {
    const hf = this.hf;
    const rec = { t: [], r: [], p: [] };
    this.cells.set(cx + ':' + cz, rec);

    const attempts = Math.round(14 * this.density);

    for (let i = 0; i < attempts; i++) {
      const x = cx * CELL + hash2(cx, cz, i * 3 + 1) * CELL;
      const z = cz * CELL + hash2(cx, cz, i * 3 + 2) * CELL;
      const roll = hash2(cx, cz, i * 3 + 3);

      const y = hf.surface(x, z);
      if (y < WATER_LEVEL + 1.2) continue;

      const q = this.road.query(x, z);
      const clearance = q.dist === Infinity ? Infinity : q.dist - q.width * 0.5;
      if (clearance < 3.5) continue;

      const slope = hf.baseSlope(x, z, 3);

      if (roll < 0.14 || slope > 0.62) {
        // Rock
        if (slope < 0.05 && roll > 0.06) continue;
        const slot = this.rocks.take();
        if (slot < 0) continue;
        const sc = 0.5 + hash2(cx, cz, i + 77) * 2.4;
        _p.set(x, y - sc * 0.25, z);
        _q.setFromAxisAngle(_up, roll * 12.9);
        _s.set(sc, sc * (0.6 + roll * 0.6), sc);
        _m.compose(_p, _q, _s);
        this.rocks.mesh.setMatrixAt(slot, _m);
        rec.r.push(slot);
      } else if (clearance < 9 && roll > 0.965) {
        // Roadside marker post
        const slot = this.posts.take();
        if (slot < 0) continue;
        _p.set(x, y, z);
        _q.setFromAxisAngle(_up, hash2(cx, cz, i + 5) * 6.28);
        _m.compose(_p, _q, _one);
        this.posts.mesh.setMatrixAt(slot, _m);
        rec.p.push(slot);
      } else {
        // Tree — thins out above the treeline and on bare rock.
        const treeline = Math.max(0, Math.min(1, (150 - y) / 40));
        if (roll > 0.18 + 0.72 * treeline) continue;
        const slot = this.trees.take();
        if (slot < 0) continue;

        const sc = 0.75 + hash2(cx, cz, i + 31) * 0.85;
        _p.set(x, y - 0.4, z);
        _q.setFromAxisAngle(_up, hash2(cx, cz, i + 12) * 6.283);
        _s.set(sc * (0.85 + roll * 0.3), sc * (0.9 + roll * 0.5), sc * (0.85 + roll * 0.3));
        _m.compose(_p, _q, _s);
        this.trees.mesh.setMatrixAt(slot, _m);

        // Near-neutral multiplier: the trunk/canopy split already lives in the
        // geometry's vertex colours, so the instance tint only varies them.
        const tint = hash2(cx, cz, i + 91);
        _col.setRGB(0.80 + tint * 0.34, 0.88 + tint * 0.30, 0.74 + tint * 0.36);
        this.trees.mesh.setColorAt(slot, _col);
        rec.t.push(slot);
      }
    }
  }
}

function makeTreeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6, 1);
  trunk.translate(0, 1.6, 0);
  const c1 = new THREE.ConeGeometry(2.1, 4.6, 8, 1);
  c1.translate(0, 4.4, 0);
  const c2 = new THREE.ConeGeometry(1.5, 3.6, 8, 1);
  c2.translate(0, 6.6, 0);
  const c3 = new THREE.ConeGeometry(0.85, 2.4, 7, 1);
  c3.translate(0, 8.4, 0);

  const geo = BufferGeometryUtils.mergeGeometries([trunk, c1, c2, c3], false);
  // Vertex colours: brown trunk, green canopy. Instance colour tints the whole
  // tree, so the trunk gets a fixed dark multiplier baked in here.
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 3.3) { colors[i * 3] = 0.42; colors[i * 3 + 1] = 0.29; colors[i * 3 + 2] = 0.18; }
    else { colors[i * 3] = 0.16; colors[i * 3 + 1] = 0.33; colors[i * 3 + 2] = 0.15; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function makeRockGeometry() {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.72 + hash2(Math.round(pos.getX(i) * 40), Math.round(pos.getZ(i) * 40), i) * 0.6;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function makePostGeometry() {
  const g = new THREE.BoxGeometry(0.14, 1.15, 0.14);
  g.translate(0, 0.57, 0);
  return g;
}
