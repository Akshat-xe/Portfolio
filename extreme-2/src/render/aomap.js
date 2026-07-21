// Faked ambient occlusion for static scenery.
//
// Real-time shadow mapping across this draw distance is not affordable, and
// scenery shadows are the least interesting thing to spend a shadow map on.
// Instead a splat map is maintained around the player: a soft dark disc is
// rendered under every tree and rock into an offscreen texture, which the
// terrain shader samples by world XZ. One extra texture fetch buys most of the
// grounding effect that a shadow map would.
//
// The map re-renders only when the player crosses a cell boundary, and it reads
// scenery positions straight out of the InstancedMesh matrix buffers, so the
// scatter system needs no bookkeeping on its behalf.

import * as THREE from 'three';

const RESOLUTION = 512;
const EXTENT = 260;      // half-width of the footprint, metres
const SNAP = 32;         // re-render when the centre moves this far
const CAPACITY = 4096;

const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _scale = new THREE.Vector3();
const _zero = new THREE.Vector3(0, 0, 0);

function discTexture(size = 64) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Soft-edged, never fully opaque — this is contact darkening, not a shadow.
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export class AOMap {
  constructor(renderer) {
    this.renderer = renderer;
    this.centre = new THREE.Vector2(NaN, NaN);
    this.extent = EXTENT;

    this.target = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-EXTENT, EXTENT, EXTENT, -EXTENT, -100, 100);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, -1, 0);

    this.discTex = discTexture();
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: this.discTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.mesh);

    this.count = 0;
  }

  get texture() { return this.target.texture; }

  // Pull world positions out of a pool's instance matrix buffer. Free slots are
  // parked at zero scale, which is exactly how we identify them.
  _collect(pool, radiusScale, cx, cz, limit) {
    if (!pool) return;
    const arr = pool.mesh.instanceMatrix.array;
    const n = pool.mesh.count;
    for (let i = 0; i < n && this.count < limit; i++) {
      const o = i * 16;
      const sx = arr[o];           // first basis vector x — zero when parked
      if (sx === 0 && arr[o + 1] === 0 && arr[o + 2] === 0) continue;

      const x = arr[o + 12];
      const z = arr[o + 14];
      if (Math.abs(x - cx) > EXTENT || Math.abs(z - cz) > EXTENT) continue;

      // Instance uniform scale drives the disc size, so bigger trees drop
      // bigger patches.
      const s = Math.hypot(arr[o], arr[o + 1], arr[o + 2]) * radiusScale;
      _pos.set(x, 0, z);
      _scale.set(s, s, s);
      _m.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(this.count++, _m);
    }
  }

  update(camX, camZ, scatter) {
    const cx = Math.round(camX / SNAP) * SNAP;
    const cz = Math.round(camZ / SNAP) * SNAP;
    if (cx === this.centre.x && cz === this.centre.y) return false;
    this.centre.set(cx, cz);

    this.count = 0;
    if (scatter) {
      this._collect(scatter.trees, 7.5, cx, cz, CAPACITY);
      this._collect(scatter.rocks, 2.6, cx, cz, CAPACITY);
    }
    // Park the unused tail so stale discs do not linger.
    _m.compose(_zero, _quat, _zero);
    for (let i = this.count; i < CAPACITY; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.camera.position.set(cx, 50, cz);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();

    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClear, prevAlpha);
    return true;
  }

  dispose() {
    this.target.dispose();
    this.discTex.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
