// Sky dome, sun, lighting rig and fog. One shader, no cubemaps, no HDRIs —
// everything is evaluated per-pixel from the sun direction so the time of day
// can be scrubbed continuously with no asset reload.

import * as THREE from 'three';
import { env } from '../render/env.js';
import { makeCloudTexture } from '../render/textures.js';

// Cloud sheets live on their own planes, deliberately decoupled from the sky
// gradient. The gradient and the sun are a function of time of day; the clouds
// drift on their own clock. Baking them together would mean a cubemap swap to
// change either one.
const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
uniform sampler2D uMap;
uniform vec3 uTint;
uniform vec3 uSunColor;
uniform vec2 uScroll;
uniform float uOpacity;
uniform float uFade;

void main() {
  // Two offset samples at different rates keep the sheet from reading as one
  // sliding texture.
  float a = texture2D(uMap, vUv + uScroll).a;
  float b = texture2D(uMap, vUv * 1.9 - uScroll * 1.7).a;
  float alpha = a * (0.55 + b * 0.75);

  // Fade toward the horizon so the plane never shows its own edge.
  float d = length(vWorld.xz - cameraPosition.xz);
  alpha *= smoothstep(1.0, 0.55, d / uFade);
  alpha *= uOpacity;
  if (alpha < 0.004) discard;

  vec3 col = uTint * (0.55 + 0.45 * uSunColor);
  gl_FragColor = vec4(col, alpha);
}
`;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSun;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform float uNight;
uniform float uHaze;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // Vertical gradient, compressed toward the horizon so the band reads tight.
  float t = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, t);

  // Below the horizon fades into a haze-matched ground tone.
  col = mix(col, uGround, clamp(-h * 6.0, 0.0, 1.0));

  // Sun disk plus a wide forward-scattering lobe.
  float cosA = dot(d, uSun);
  float disk = smoothstep(0.9994, 0.99975, cosA);
  float glow = pow(max(cosA, 0.0), 220.0) * 0.55 + pow(max(cosA, 0.0), 8.0) * 0.22;
  col += uSunColor * (disk * 12.0 + glow);

  // Horizon haze band.
  col = mix(col, uHorizon, exp(-abs(h) * 9.0) * uHaze);

  // Stars, only once the sun is well below the horizon.
  if (uNight > 0.01 && h > -0.05) {
    vec2 sp = d.xz / max(0.12, abs(d.y) + 0.35);
    float s = hash(floor(sp * 190.0));
    float star = smoothstep(0.9975, 1.0, s) * uNight * clamp(h * 3.0, 0.0, 1.0);
    col += vec3(star * 1.4);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const PALETTE = {
  day:   { zenith: 0x2f6fc4, horizon: 0xb9cfe4, ground: 0x8a9aa8, sun: 0xfff3d6, fog: 0xb9cfe4, amb: 0x9fb4c8, dir: 0xfff6e2, dirI: 2.5, ambI: 0.9 },
  gold:  { zenith: 0x2b4d84, horizon: 0xf0a765, ground: 0x77675c, sun: 0xffbb63, fog: 0xe8a978, amb: 0xb08a76, dir: 0xffb765, dirI: 2.1, ambI: 0.8 },
  dusk:  { zenith: 0x161f3d, horizon: 0xc25c3f, ground: 0x3d3138, sun: 0xff7a3d, fog: 0x9c5a4a, amb: 0x5c5670, dir: 0xff8a52, dirI: 1.1, ambI: 0.6 },
  night: { zenith: 0x050914, horizon: 0x121c2e, ground: 0x090c14, sun: 0x2a3550, fog: 0x0d1420, amb: 0x38455f, dir: 0x7c8cae, dirI: 0.45, ambI: 0.75 },
};

const _a = new THREE.Color();
const _b = new THREE.Color();

export class SkySystem {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    const geo = new THREE.SphereGeometry(1, 32, 20);
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0.3, 0.6, 0.5) },
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uNight: { value: 0 },
      uHaze: { value: 0.5 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
    scene.add(this.mesh);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = false;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 320;
    this.sun.shadow.camera.left = -85;
    this.sun.shadow.camera.right = 85;
    this.sun.shadow.camera.top = 85;
    this.sun.shadow.camera.bottom = -85;
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x5a5348, 0.9);
    scene.add(this.hemi);

    // No scene.fog: atmosphere is a depth-based post pass now, so every
    // surface shares one implementation. Colours live in the shared env block.
    scene.fog = null;
    this._buildClouds(scene);

    this.timeOfDay = 0.34;
    this.fogDensity = 0.0016;
    this.autoCycle = false;
    this.cycleSpeed = 1 / 900; // one full day every 15 minutes
    this.setTimeOfDay(this.timeOfDay);
  }

  _buildClouds(scene) {
    const tex = makeCloudTexture();
    this.cloudTexture = tex;
    this.clouds = [];

    const layers = [
      { y: 780, size: 26000, repeat: 7, speed: 0.0042, opacity: 0.85, tint: 0xffffff, fade: 13000 },
      { y: 1350, size: 34000, repeat: 4, speed: 0.0021, opacity: 0.55, tint: 0xdfe6f2, fade: 17000 },
    ];

    for (const L of layers) {
      const geo = new THREE.PlaneGeometry(L.size, L.size, 1, 1);
      geo.rotateX(-Math.PI / 2);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * L.repeat, uv.getY(i) * L.repeat);
      }
      const mat = new THREE.ShaderMaterial({
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
        uniforms: {
          uMap: { value: tex },
          uTint: { value: new THREE.Color(L.tint) },
          uSunColor: { value: new THREE.Color(1, 1, 1) },
          uScroll: { value: new THREE.Vector2() },
          uOpacity: { value: L.opacity },
          uFade: { value: L.fade },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = L.y;
      mesh.renderOrder = -900;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.clouds.push({ mesh, mat, speed: L.speed, y: L.y });
    }
  }

  setCloudOpacity(v) {
    for (let i = 0; i < this.clouds.length; i++) {
      const base = i === 0 ? 0.85 : 0.55;
      this.clouds[i].mat.uniforms.uOpacity.value = base * v;
      this.clouds[i].mesh.visible = v > 0.01;
    }
  }

  setShadows(enabled, quality) {
    this.sun.castShadow = enabled;
    if (enabled) {
      const size = quality >= 2 ? 4096 : quality >= 1 ? 2048 : 1024;
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }
  }

  setFogDensity(d) {
    this.fogDensity = d;
    env.uFogDensity.value = d;
  }

  setTimeOfDay(t) {
    this.timeOfDay = ((t % 1) + 1) % 1;

    // Sun travels a tilted arc; 0.0 = midnight, 0.5 = solar noon.
    const ang = (this.timeOfDay - 0.25) * Math.PI * 2;
    const elev = Math.sin(ang);
    const azim = this.timeOfDay * Math.PI * 2 * 0.4 + 0.7;
    const sx = Math.cos(azim) * Math.cos(ang * 0.5) * 0.85;
    const sz = Math.sin(azim) * Math.cos(ang * 0.5) * 0.85;
    const dir = this.uniforms.uSun.value.set(sx, elev, sz).normalize();

    // Blend the four palette keys by sun elevation.
    let A, B, k;
    if (elev > 0.35) { A = PALETTE.gold; B = PALETTE.day; k = Math.min(1, (elev - 0.35) / 0.4); }
    else if (elev > 0.06) { A = PALETTE.dusk; B = PALETTE.gold; k = (elev - 0.06) / 0.29; }
    else if (elev > -0.12) { A = PALETTE.night; B = PALETTE.dusk; k = (elev + 0.12) / 0.18; }
    else { A = PALETTE.night; B = PALETTE.night; k = 0; }

    const mix = (key, target) => target.copy(_a.setHex(A[key])).lerp(_b.setHex(B[key]), k);

    mix('zenith', this.uniforms.uZenith.value);
    mix('horizon', this.uniforms.uHorizon.value);
    mix('ground', this.uniforms.uGround.value);
    mix('sun', this.uniforms.uSunColor.value);
    mix('fog', env.uFogColor.value);
    mix('amb', this.hemi.color);
    mix('dir', this.sun.color);

    this.uniforms.uNight.value = Math.max(0, Math.min(1, -elev * 3.2));
    this.sun.intensity = A.dirI + (B.dirI - A.dirI) * k;
    this.hemi.intensity = A.ambI + (B.ambI - A.ambI) * k;
    this.sunDir = dir;

    // Publish the lighting state to the shared env block. Every custom
    // material and the atmosphere pass read these same uniform objects, so
    // this is the single point where time of day takes effect.
    env.uSunDir.value.copy(dir);
    env.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    env.uSkyColor.value.copy(this.hemi.color);
    env.uGroundColor.value.copy(this.hemi.groundColor);
    env.uAmbient.value = this.hemi.intensity;

    // Inscatter takes the sun's own colour, warmed at low elevations.
    env.uFogSunColor.value.copy(this.uniforms.uSunColor.value)
      .lerp(env.uFogColor.value, 0.25);

    for (const c of this.clouds) c.mat.uniforms.uSunColor.value.copy(this.sun.color);
  }

  update(dt, camX, camY, camZ) {
    if (this.autoCycle) this.setTimeOfDay(this.timeOfDay + dt * this.cycleSpeed);
    env.uTime.value += dt;

    this.mesh.position.set(camX, camY, camZ);
    this.mesh.scale.setScalar(9000);

    // Clouds follow the camera in XZ and scroll on their own clock, which is
    // the point of keeping them off the sky dome.
    for (const c of this.clouds) {
      c.mat.uniforms.uScroll.value.x += dt * c.speed;
      c.mat.uniforms.uScroll.value.y += dt * c.speed * 0.35;
      c.mesh.position.set(camX, c.y, camZ);
      c.mesh.updateMatrix();
    }

    // Keep the shadow frustum glued to the car.
    const d = this.sunDir;
    this.sun.position.set(camX + d.x * 140, camY + d.y * 140, camZ + d.z * 140);
    this.sun.target.position.set(camX, camY, camZ);
    this.sun.target.updateMatrixWorld();
  }
}
