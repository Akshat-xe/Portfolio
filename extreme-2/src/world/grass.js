// Procedural instanced grass.
//
// One InstancedMesh, one draw call, streamed by cell exactly like the scenery
// scatter. A probability density function decides placement as the near grid
// comes into range; the ground normal at the placement point tilts the blade so
// it grows out of the slope rather than standing plumb on a hillside; and a
// per-instance random selects one of four sub-rects from the blade atlas so
// neighbouring tufts are not clones.
//
// Wind is done entirely in the vertex shader, weighted by blade height so the
// base stays planted and only the tip travels.

import * as THREE from 'three';
import { hash2 } from '../lib/alea.js';
import { WATER_LEVEL } from './heightfield.js';
import { makeGrassBladeTexture } from '../render/textures.js';
import { env } from '../render/env.js';

const CELL = 8;              // metres
const RADIUS = 7;            // cells -> 56 m of grass
const PER_CELL = 44;         // attempts per cell at density 1
const CAPACITY = 14000;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
const _norm = [0, 0, 0];
const _zero = new THREE.Vector3(0, 0, 0);

const VERT = /* glsl */`
attribute vec2 aAtlas;
attribute float aPhase;

varying vec2 vUv;
varying float vHeight;
varying vec3 vWorld;

uniform float uTime;
uniform float uWind;

void main() {
  // Blade-local Y in 0..1 drives both the wind weighting and the shading.
  float h = uv.y;
  vHeight = h;
  vUv = uv * vec2(0.5, 0.5) + aAtlas;

  vec3 p = position;

  vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);

  // Sway is applied in world space so every blade in a gust leans the same
  // way regardless of its own random Y rotation.
  float gust = sin(uTime * 1.7 + world.x * 0.09 + world.z * 0.07 + aPhase)
             + 0.5 * sin(uTime * 3.1 + world.z * 0.15 + aPhase * 1.7);
  float bend = gust * uWind * h * h;
  world.x += bend * 0.45;
  world.z += bend * 0.22;

  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vHeight;
varying vec3 vWorld;

uniform sampler2D uMap;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform float uFadeStart;
uniform float uFadeEnd;

void main() {
  vec4 texel = texture2D(uMap, vUv);
  if (texel.a < 0.35) discard;

  // Distance fade: blades thin out rather than popping at the stream edge.
  float d = length(vWorld.xz - cameraPosition.xz);
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);
  if (fade < 0.02) discard;
  // Dithered cutout so the fade does not read as a soft transparent band.
  if (fade < 0.99) {
    float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    if (n > fade) discard;
  }

  // Grass is lit softly: a vertical gradient standing in for self-shadowing
  // within the tuft, plus the shared hemisphere ambient.
  vec3 ambient = mix(uGroundColor, uSkyColor, 0.65) * uAmbient;
  vec3 lit = texel.rgb * (uSunColor * (0.35 + 0.65 * vHeight) + ambient);
  gl_FragColor = vec4(lit, 1.0);
}
`;

export class Grass {
  constructor(heightfield, road, scene) {
    this.hf = heightfield;
    this.road = road;
    this.density = 1;
    this.enabled = true;

    // Two crossed quads per blade cluster gives volume from any angle for the
    // price of four triangles.
    // Tuft footprint, not bush footprint: roughly knee-high once the instance
    // scale is applied.
    const quad = new THREE.PlaneGeometry(0.40, 0.42, 1, 1);
    quad.translate(0, 0.21, 0);
    const quadB = quad.clone();
    quadB.rotateY(Math.PI / 2);

    const geo = mergeTwo(quad, quadB);
    quad.dispose();
    quadB.dispose();

    this.texture = makeGrassBladeTexture();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: Object.assign({}, env, {
        uMap: { value: this.texture },
        uWind: { value: 0.10 },
        uFadeStart: { value: 28 },
        uFadeEnd: { value: 46 },
      }),
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.count = CAPACITY;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    // Per-instance atlas cell and wind phase.
    this.atlas = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 2), 2);
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    geo.setAttribute('aAtlas', this.atlas);
    geo.setAttribute('aPhase', this.phase);

    this.free = new Int32Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) this.free[i] = CAPACITY - 1 - i;
    this.freeTop = CAPACITY;

    _m.compose(_zero, _q.identity(), _zero);
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.cells = new Map();
    this.queue = [];
    this.centreCell = null;
  }

  setDensity(d) {
    if (d === this.density) return;
    this.density = d;
    this.enabled = d > 0.001;
    this.mesh.visible = this.enabled;
    for (const k of Array.from(this.cells.keys())) this._release(k);
    this.centreCell = null;
  }

  update(camX, camZ) {
    if (!this.enabled) return;
    const cx = Math.floor(camX / CELL);
    const cz = Math.floor(camZ / CELL);
    const key = cx + ':' + cz;
    if (key === this.centreCell) return;
    this.centreCell = key;

    const r2 = RADIUS * RADIUS;
    for (const k of Array.from(this.cells.keys())) {
      const [kx, kz] = k.split(':');
      const dx = +kx - cx, dz = +kz - cz;
      if (dx * dx + dz * dz > r2 * 1.4) this._release(k);
    }

    this.queue.length = 0;
    const pending = [];
    for (let i = -RADIUS; i <= RADIUS; i++) {
      for (let j = -RADIUS; j <= RADIUS; j++) {
        const d2 = i * i + j * j;
        if (d2 > r2) continue;
        const k = (cx + i) + ':' + (cz + j);
        if (!this.cells.has(k)) pending.push([d2, cx + i, cz + j]);
      }
    }
    pending.sort((a, b) => b[0] - a[0]);   // nearest last; we pop from the end
    for (const p of pending) this.queue.push(p[1], p[2]);
  }

  processQueue(budget = 4) {
    if (!this.enabled) return 0;
    let n = 0;
    while (this.queue.length >= 2 && n < budget) {
      const cz = this.queue.pop();
      const cx = this.queue.pop();
      this._populate(cx, cz);
      n++;
    }
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.atlas.needsUpdate = true;
      this.phase.needsUpdate = true;
    }
    return this.queue.length / 2;
  }

  _release(key) {
    const slots = this.cells.get(key);
    if (!slots) return;
    _m.compose(_zero, _q.identity(), _zero);
    for (const s of slots) {
      this.mesh.setMatrixAt(s, _m);
      this.free[this.freeTop++] = s;
    }
    this.cells.delete(key);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _populate(cx, cz) {
    const hf = this.hf;
    const slots = [];
    this.cells.set(cx + ':' + cz, slots);

    const attempts = Math.round(PER_CELL * this.density);
    for (let i = 0; i < attempts; i++) {
      const x = cx * CELL + hash2(cx, cz, i * 5 + 1) * CELL;
      const z = cz * CELL + hash2(cx, cz, i * 5 + 2) * CELL;

      const y = hf.surface(x, z);
      if (y < WATER_LEVEL + 0.6 || y > 165) continue;

      // Keep off the carriageway; a fringe on the verge is wanted though.
      const q = this.road.query(x, z);
      if (q.dist !== Infinity && q.dist < q.width * 0.5 + 0.4) continue;

      // The probability density falls away on steep ground — grass does not
      // grow on scree.
      hf.normal(x, z, _norm, 1.0);
      const slope = 1 - _norm[1];
      if (slope > 0.42) continue;
      if (hash2(cx, cz, i * 5 + 3) < slope * 1.6) continue;

      const slot = this.freeTop > 0 ? this.free[--this.freeTop] : -1;
      if (slot < 0) break;

      // Tilt the blade toward the ground normal so it grows out of the slope.
      _axis.set(_norm[0], _norm[1], _norm[2]);
      _q.setFromUnitVectors(_up, _axis);
      _spin.setFromAxisAngle(_up, hash2(cx, cz, i * 5 + 4) * 6.283);
      _q.multiply(_spin);

      const scale = 0.7 + hash2(cx, cz, i * 5 + 5) * 0.6;
      _p.set(x, y - 0.04, z);
      _s.set(scale, scale * (0.8 + hash2(cx, cz, i + 91) * 0.6), scale);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(slot, _m);

      // One of four atlas quadrants.
      const pick = Math.floor(hash2(cx, cz, i * 5 + 6) * 4);
      this.atlas.setXY(slot, (pick % 2) * 0.5, Math.floor(pick / 2) * 0.5);
      this.phase.setX(slot, hash2(cx, cz, i * 5 + 7) * 6.283);

      slots.push(slot);
    }
  }

  dispose() {
    this.queue.length = 0;
    this.cells.clear();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

// Minimal two-geometry merge: enough for the crossed-quad blade, without
// pulling in BufferGeometryUtils for a fixed pair.
function mergeTwo(a, b) {
  const geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.attributes[name], B = b.attributes[name];
    const out = new Float32Array(A.array.length + B.array.length);
    out.set(A.array, 0);
    out.set(B.array, A.array.length);
    geo.setAttribute(name, new THREE.BufferAttribute(out, A.itemSize));
  }
  const ai = a.index.array, bi = b.index.array;
  const offset = a.attributes.position.count;
  const idx = new Uint16Array(ai.length + bi.length);
  idx.set(ai, 0);
  for (let i = 0; i < bi.length; i++) idx[ai.length + i] = bi[i] + offset;
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}
