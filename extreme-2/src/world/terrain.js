// Dual-grid (actually tri-grid) terrain LOD.
//
//   far    5x5 tiles of 1000 m at 12.5 m/vertex  -> the horizon
//   near   5x5 tiles of  200 m at    4 m/vertex  -> the corridor around the car
//   micro  3x3 tiles of   40 m at    1 m/vertex  -> tyre-contact geometry
//
// Every tile is allocated once and recycled: an x/z lattice is baked into the
// position buffer at construction and only the Y component, the normals and
// the vertex colours are rewritten when a tile is reassigned to new ground.
//
// Seam handling: near and micro vertices lerp toward `heightfield.coarse()`
// (the far-grid lattice, bilinearly sampled) as they approach the outer border
// of their ring, so adjacent rings agree exactly on height and no cracks or
// z-fighting appear. Rings also carry a small descending Y bias so the coarser
// ring always loses the depth test where they do overlap.

import * as THREE from 'three';
import { WATER_LEVEL } from './heightfield.js';
import { createTerrainMaterial } from '../render/terrainmaterial.js';
import { env } from '../render/env.js';

const RING_SPECS = [
  { name: 'far',   cols: 5, size: 1000, segments: 80, yBias: -0.9,  blendStart: 2.0, order: 0 },
  { name: 'near',  cols: 5, size: 200,  segments: 50, yBias: -0.05, blendStart: 0.72, order: 1 },
  { name: 'micro', cols: 3, size: 40,   segments: 40, yBias: 0,     blendStart: 0.70, order: 2 },
];

class Tile {
  constructor(spec, material) {
    const n = spec.segments;
    const count = (n + 1) * (n + 1);

    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const step = spec.size / n;

    // Local lattice is fixed for the lifetime of the tile.
    for (let j = 0, k = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++, k++) {
        positions[k * 3] = i * step;
        positions[k * 3 + 1] = 0;
        positions[k * 3 + 2] = j * step;
        normals[k * 3 + 1] = 1;
      }
    }

    const indices = new Uint32Array(n * n * 6);
    let t = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices[t++] = a; indices[t++] = c; indices[t++] = b;
        indices[t++] = b; indices[t++] = c; indices[t++] = d;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(spec.size / 2, 0, spec.size / 2),
      spec.size * 1.4
    );

    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = true;
    this.mesh.renderOrder = spec.order;
    this.mesh.matrixAutoUpdate = false;

    this.spec = spec;
    this.positions = positions;
    this.normals = normals;
    this.heights = new Float32Array(count);
    this.col = null;
    this.row = null;
    this.dirty = true;
  }
}

export class TerrainLOD {
  constructor(heightfield, scene) {
    this.hf = heightfield;
    this.scene = scene;

    this.material = createTerrainMaterial();

    this.rings = RING_SPECS.map((spec) => {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      scene.add(group);
      const tiles = [];
      for (let i = 0; i < spec.cols * spec.cols; i++) {
        const tile = new Tile(spec, this.material);
        group.add(tile.mesh);
        tiles.push(tile);
      }
      return { spec, tiles, group, centreCol: null, centreRow: null };
    });

    this.queue = [];
    this._buildWater(scene);
  }

  _buildWater(scene) {
    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.waterMat = new THREE.MeshLambertMaterial({
      color: 0x2b5f78,
      transparent: true,
      opacity: 0.86,
      fog: true,
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.y = WATER_LEVEL;
    this.water.renderOrder = 3;
    this.water.matrixAutoUpdate = false;
    scene.add(this.water);
  }

  // Draw distance: hides the outer bands of the far ring rather than rebuilding
  // it, so the setting is free to scrub.
  setRenderScale(scale) {
    this._farScale = scale;
    const far = this.rings[0];
    if (far.centreCol === null) return;
    const keep = Math.max(0, Math.round(((far.spec.cols - 1) / 2) * scale));
    for (const tile of far.tiles) {
      if (tile.col === null) { tile.mesh.visible = false; continue; }
      const d = Math.max(Math.abs(tile.col - far.centreCol), Math.abs(tile.row - far.centreRow));
      tile.mesh.visible = d <= keep;
    }
  }

  update(camX, camZ) {
    for (const ring of this.rings) {
      const { spec } = ring;
      const cc = Math.round(camX / spec.size);
      const cr = Math.round(camZ / spec.size);
      if (cc === ring.centreCol && cr === ring.centreRow) continue;

      ring.centreCol = cc;
      ring.centreRow = cr;
      const half = (spec.cols - 1) / 2;

      // Reassign tiles to the new footprint, reusing any that already sit on
      // the right ground (the common case: only one row/column changes).
      const wanted = [];
      for (let r = -half; r <= half; r++) {
        for (let c = -half; c <= half; c++) wanted.push([cc + c, cr + r]);
      }

      const free = [];
      const held = new Set();
      for (const tile of ring.tiles) {
        const key = tile.col === null ? null : tile.col + ':' + tile.row;
        if (key !== null && wanted.some((w) => w[0] + ':' + w[1] === key)) held.add(key);
        else free.push(tile);
      }

      for (const [c, r] of wanted) {
        if (held.has(c + ':' + r)) continue;
        const tile = free.pop();
        if (!tile) continue;
        tile.col = c;
        tile.row = r;
        tile.mesh.position.set(c * spec.size - spec.size / 2, spec.yBias, r * spec.size - spec.size / 2);
        tile.mesh.updateMatrix();
        tile.dirty = true;
        this.queue.push(tile);
      }
    }

    this.water.position.x = Math.round(camX / 500) * 500;
    this.water.position.z = Math.round(camZ / 500) * 500;
    this.water.updateMatrix();

    if (this._farScale !== undefined) this.setRenderScale(this._farScale);
  }

  // Rebuild up to `budget` tiles. Pass Infinity for the initial synchronous
  // warm-up behind the loading screen.
  processQueue(budget = 1) {
    let done = 0;
    while (this.queue.length && done < budget) {
      const tile = this.queue.shift();
      if (tile.dirty) { this._build(tile); done++; }
    }
    return this.queue.length;
  }

  _build(tile) {
    const hf = this.hf;
    const spec = tile.spec;
    const n = spec.segments;
    const step = spec.size / n;
    const ox = tile.col * spec.size - spec.size / 2;
    const oz = tile.row * spec.size - spec.size / 2;

    const H = tile.heights;
    const pos = tile.positions;
    const nor = tile.normals;

    const ring = this.rings.find((r) => r.spec === spec);
    const ringHalfExtent = (spec.cols * spec.size) / 2;
    const ringCx = ring.centreCol * spec.size;
    const ringCz = ring.centreRow * spec.size;
    const blendStart = spec.blendStart;

    // --- heights ---------------------------------------------------------
    for (let j = 0, k = 0; j <= n; j++) {
      const wz = oz + j * step;
      for (let i = 0; i <= n; i++, k++) {
        const wx = ox + i * step;
        let h = hf.surface(wx, wz);

        if (blendStart < 1) {
          const u = Math.max(Math.abs(wx - ringCx), Math.abs(wz - ringCz)) / ringHalfExtent;
          if (u > blendStart) {
            let t = (u - blendStart) / (1 - blendStart);
            if (t > 1) t = 1;
            t = t * t * (3 - 2 * t);
            h += (hf.coarse(wx, wz) - h) * t;
          }
        }
        H[k] = h;
        pos[k * 3 + 1] = h;
      }
    }

    // --- normals from the height grid (no extra noise evaluations) --------
    // Surface colour is now entirely the terrain shader's job: it has world
    // position and the normal, which is everything the slope/altitude blend
    // needs. Dropping the vertex-colour attribute removes a Float32Array per
    // tile and a colour computation per vertex from every rebuild.
    const inv2 = 1 / (2 * step);
    for (let j = 0, k = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++, k++) {
        const l = H[i > 0 ? k - 1 : k];
        const r = H[i < n ? k + 1 : k];
        const d = H[j > 0 ? k - (n + 1) : k];
        const u = H[j < n ? k + (n + 1) : k];
        const sx = (l - r) * (i > 0 && i < n ? inv2 : 1 / step);
        const sz = (d - u) * (j > 0 && j < n ? inv2 : 1 / step);

        const len = Math.hypot(sx, 1, sz);
        nor[k * 3] = sx / len;
        nor[k * 3 + 1] = 1 / len;
        nor[k * 3 + 2] = sz / len;
      }
    }

    tile.mesh.geometry.attributes.position.needsUpdate = true;
    tile.mesh.geometry.attributes.normal.needsUpdate = true;
    tile.dirty = false;
  }

  // Point the terrain shader at the faked-AO splat map.
  setAOMap(texture, centre, extent) {
    const u = this.material.uniforms;
    u.uAOMap.value = texture;
    u.uAOCentre.value.copy(centre);
    u.uAOExtent.value = extent;
  }

  setDetail({ triplanar, detailScale, aoStrength, fresnel }) {
    const u = this.material.uniforms;
    if (triplanar !== undefined) u.uTriplanar.value = triplanar;
    if (detailScale !== undefined) u.uDetailScale.value = detailScale;
    if (aoStrength !== undefined) u.uAOStrength.value = aoStrength;
    if (fresnel !== undefined) env.uFresnel.value = fresnel;
  }

  dispose() {
    this.queue.length = 0;
    for (const ring of this.rings) {
      for (const tile of ring.tiles) tile.mesh.geometry.dispose();
      this.scene.remove(ring.group);
    }
    for (const t of this.material.userData.textures) t.dispose();
    this.material.dispose();
    this.water.geometry.dispose();
    this.waterMat.dispose();
    this.scene.remove(this.water);
  }
}
