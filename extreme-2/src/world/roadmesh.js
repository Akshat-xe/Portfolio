// Rolling road ribbon.
//
// The spec calls for 100 m chunks that are cycled and recycled as the car
// advances. This is that idea taken to its limit: one fixed-capacity buffer
// covering a sliding window of the fine polyline, rewritten in place. Nothing
// is allocated after construction and there is no per-chunk draw call.

import * as THREE from 'three';

const BEHIND = 180;   // metres of road kept behind the car
const AHEAD = 950;    // metres of road drawn in front
const RESHAPE_AT = 24; // rebuild once the window has slid this far

export class RoadMesh {
  constructor(road, scene) {
    this.road = road;

    const capacity = Math.ceil((BEHIND + AHEAD) / 2) + 32; // fine nodes
    this.capacity = capacity;

    const verts = capacity * 2;
    this.positions = new Float32Array(verts * 3);
    this.normals = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);

    // a = right edge of node i, b = left edge, c/d the same for node i+1.
    // Wound a-b-c / b-d-c so the face normal points up: with the ribbon
    // running along +Z and a on the +X side, the other order produces
    // downward-facing triangles that vanish to backface culling.
    const indices = new Uint32Array((capacity - 1) * 6);
    for (let i = 0, t = 0; i < capacity - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices[t++] = a; indices[t++] = b; indices[t++] = c;
      indices[t++] = b; indices[t++] = d; indices[t++] = c;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;

    this.material = new THREE.MeshLambertMaterial({
      map: makeAsphaltTexture(),
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    this.lastS = -1e9;
  }

  update(s, force = false) {
    if (!force && Math.abs(s - this.lastS) < RESHAPE_AT) return;
    this.lastS = s;

    const road = this.road;
    const fine = road.fine;
    if (fine.length < 4) return;

    const sStart = s - BEHIND;
    const sEnd = s + AHEAD;

    let idx = fine.indexOf(road.nodeAt(sStart));
    if (idx < 0) idx = 0;

    const pos = this.positions;
    const nor = this.normals;
    const uv = this.uvs;

    let v = 0;
    for (let i = idx; i < fine.length && v < this.capacity; i++) {
      const n = fine[i];
      if (n.s > sEnd) break;

      const hw = n.width * 0.5;
      const bank = n.bank;

      // Lateral basis: moving +hw along the right-hand normal raises Y by
      // hw*bank, which is exactly what Road.query() reports, so the rendered
      // surface and the surface the tyres raycast against are one surface.
      const lx = n.nx, ly = bank, lz = n.nz;

      const next = n.next || n;
      const ds = Math.max(0.001, next.s - n.s);
      const tx = n.tx, ty = (next.y - n.y) / ds, tz = n.tz;

      // normal = normalize(L x T)
      let nx = ly * tz - lz * ty;
      let ny = lz * tx - lx * tz;
      let nz = lx * ty - ly * tx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= inv; ny *= inv; nz *= inv;

      const y = n.y + 0.04;

      const a = v * 2, b = a + 1;
      pos[a * 3]     = n.x + lx * hw;
      pos[a * 3 + 1] = y + ly * hw;
      pos[a * 3 + 2] = n.z + lz * hw;
      pos[b * 3]     = n.x - lx * hw;
      pos[b * 3 + 1] = y - ly * hw;
      pos[b * 3 + 2] = n.z - lz * hw;

      nor[a * 3] = nx; nor[a * 3 + 1] = ny; nor[a * 3 + 2] = nz;
      nor[b * 3] = nx; nor[b * 3 + 1] = ny; nor[b * 3 + 2] = nz;

      uv[a * 2] = 0; uv[a * 2 + 1] = n.s / 8;
      uv[b * 2] = 1; uv[b * 2 + 1] = n.s / 8;

      v++;
    }

    this.count = v;
    this.geometry.setDrawRange(0, Math.max(0, (v - 1) * 6));
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.map.dispose();
    this.material.dispose();
  }
}

// 128 x 512 asphalt strip: u runs across the carriageway, v runs 8 m along it,
// which makes the centre dashes fall out of the texture repeat for free.
function makeAsphaltTexture() {
  const W = 128, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#3a3a3d';
  ctx.fillRect(0, 0, W, H);

  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // Darker, polished wheel tracks.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(W * 0.20, 0, W * 0.14, H);
  ctx.fillRect(W * 0.66, 0, W * 0.14, H);

  // Solid edge lines.
  ctx.fillStyle = '#d9d5c8';
  ctx.fillRect(W * 0.055, 0, W * 0.026, H);
  ctx.fillRect(W * 0.919, 0, W * 0.026, H);

  // Dashed centreline: 4 m painted, 4 m gap over the 8 m repeat.
  ctx.fillStyle = '#e6e2d4';
  ctx.fillRect(W * 0.487, 0, W * 0.026, H * 0.5);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
