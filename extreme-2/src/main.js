// Akshat Kumar Racing Engine — entry point and frame loop.
//
// Boot order: renderer -> world (heightfield, route, terrain, scenery) ->
// vehicle -> presentation (post FX, audio, UI). The world is disposable and
// rebuildable, so changing the seed tears it down and streams a new one in
// without reloading the page.

import * as THREE from 'three';

import { alea } from './lib/alea.js';
import { Heightfield, WATER_LEVEL } from './world/heightfield.js';
import { Road } from './world/road.js';
import { RoadMesh } from './world/roadmesh.js';
import { TerrainLOD } from './world/terrain.js';
import { Scatter } from './world/scatter.js';
import { Grass } from './world/grass.js';
import { SkySystem } from './world/sky.js';
import { AOMap } from './render/aomap.js';
import { Vehicle } from './physics/vehicle.js';
import { CarModel } from './render/carmodel.js';
import { PostFX } from './render/postfx.js';
import { EngineAudio } from './audio/audio.js';
import { Input } from './input.js';
import { Autodrive } from './autodrive.js';
import { Settings, PRESETS, PRESET_KEYS } from './ui/settings.js';
import { UI } from './ui/ui.js';

const VERSION = '1.1.0';

// Mix bus -> settings key.
const AUDIO_BUSES = [
  ['master', 'volMaster'], ['music', 'volMusic'], ['voice', 'volVoice'],
  ['sfx', 'volSfx'], ['ambient', 'volAmbient'], ['ui', 'volUi'],
];
const HORIZON = 15000;   // metres of route kept generated ahead of the car

const CAMERAS = {
  chase:     { pos: [0, 2.15, -6.6], look: [0, 1.05, 7], smooth: 7.5, rigid: false },
  close:     { pos: [0, 1.72, -4.3], look: [0, 1.05, 8], smooth: 11, rigid: false },
  hood:      { pos: [0, 1.32, 0.30], look: [0, 1.28, 12], smooth: 0, rigid: true },
  bumper:    { pos: [0, 0.62, 2.05], look: [0, 0.66, 14], smooth: 0, rigid: true },
  cinematic: { pos: [0, 3.9, -11.5], look: [0, 1.2, 5], smooth: 2.6, rigid: false },
};
const CAMERA_ORDER = ['chase', 'close', 'hood', 'bumper', 'cinematic'];

// Scratch.
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();

class Engine {
  constructor() {
    this.settings = new Settings();
    this.canvas = document.getElementById('gl');

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // MSAA off by design: the scene is rendered into a half-float target and
      // multisampling that costs bandwidth we would rather not spend. FXAA at
      // the end of the composer chain does the anti-aliasing instead.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x0a0e14, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Post-processing issues several renders per frame; reset the counters
    // ourselves so the HUD reports the true per-frame totals.
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.25, 4000);
    this.camera.position.set(0, 60, 0);

    this.sky = new SkySystem(this.scene, this.renderer);
    this.car = new CarModel(this.scene);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);
    // Reversed depth massively improves precision at range; probe rather than
    // assume, and keep the result for the diagnostics readout.
    this.depthInfo = this.postfx.tryReversedDepth();
    this.audio = new EngineAudio();
    this.input = new Input();

    this.camMode = 'chase';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camReady = false;
    this.paused = false;
    this.hudVisible = true;

    this.fps = 60;
    this.frameMs = 16.7;
    this.routePoints = [];
    this._routeTimer = 0;

    this.camDistance = 1;
    this._started = false;
    this._autoInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    this.ui = new UI(this.settings, {
      onPause: (open) => { this.paused = open; },
      onAction: (a) => this._action(a),
      onStart: () => this._onStart(),
      playClick: (k) => this.audio.click(k),
      getDiagnostics: () => this._diagnostics(),
    });

    this._bindInput();
    this._bindSettings();
    this._bindWindow();
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    const ui = this.ui;
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    this._resize();

    ui.setLoading(0.05, 'Seeding topography…');
    await frame();
    this._buildWorld();

    ui.setLoading(0.22, 'Routing carriageway…');
    await frame();
    this.road.extend(HORIZON);
    this.vehicle.respawn(30);

    // Streaming under the loading screen is time-budgeted rather than
    // count-budgeted: work until the frame is nearly spent, then yield. That
    // keeps the progress bar animating without wasting whole frames on a
    // handful of cheap tiles.
    const drain = async (label, base, span, remaining, step) => {
      const total = Math.max(1, remaining());
      while (remaining() > 0) {
        const t0 = performance.now();
        while (remaining() > 0 && performance.now() - t0 < 14) step();
        ui.setLoading(base + span * (1 - remaining() / total), label);
        await frame();
      }
    };

    ui.setLoading(0.32, 'Tessellating terrain…');
    await frame();
    this.terrain.update(this.vehicle.px, this.vehicle.pz);
    await drain('Tessellating terrain…', 0.32, 0.42,
      () => this.terrain.queue.length, () => this.terrain.processQueue(1));

    ui.setLoading(0.76, 'Planting scenery…');
    await frame();
    this.scatter.update(this.vehicle.px, this.vehicle.pz);
    await drain('Planting scenery…', 0.76, 0.12,
      () => this.scatter.queue.length / 2, () => this.scatter.processQueue(8));

    this.grass.update(this.vehicle.px, this.vehicle.pz);
    await drain('Seeding grass…', 0.88, 0.06,
      () => this.grass.queue.length / 2, () => this.grass.processQueue(6));
    this.aoMap.update(this.vehicle.px, this.vehicle.pz, this.scatter);
    this.terrain.setAOMap(this.aoMap.texture, this.aoMap.centre, this.aoMap.extent);

    ui.setLoading(0.94, 'Compiling shaders…');
    await frame();
    this.roadMesh.update(this.vehicle.roadS, true);
    this._placeCamera(true);
    this.renderer.compile(this.scene, this.camera);

    ui.setLoading(1, 'Ready');
    this.settings.applyAll();
    await frame();

    ui.finishLoading(this.seed);
    if (this._started) ui.dismissStart();   // regeneration: already past the gate

    this.clock = performance.now();
    if (!this._running) { this._running = true; this._loop(); }
  }

  _onStart() {
    this._started = true;
    this.ui.dismissStart();
    this._startAudio().catch(() => this.ui.toast('Audio unavailable in this browser'));
  }

  _buildWorld() {
    const seed = this.settings.get('seed') || 'akshat';
    this.seed = seed;

    this.heightfield = new Heightfield(seed);
    this.road = new Road(this.heightfield, alea(seed + ':route'));
    this.heightfield.attachRoad(this.road);

    this.terrain = new TerrainLOD(this.heightfield, this.scene);
    this.roadMesh = new RoadMesh(this.road, this.scene);
    this.scatter = new Scatter(this.heightfield, this.road, this.scene);
    this.grass = new Grass(this.heightfield, this.road, this.scene);
    this.vehicle = new Vehicle(this.heightfield, this.road);
    this.autodrive = new Autodrive(this.road, this.vehicle);

    if (!this.aoMap) this.aoMap = new AOMap(this.renderer);
    this.terrain.setAOMap(this.aoMap.texture, this.aoMap.centre, this.aoMap.extent);
  }

  async _regenerate() {
    this.paused = true;
    this.ui.el.loading.classList.remove('done');
    this.ui.setLoading(0.05, 'Reseeding world…');
    this.ui.toggleMenu(false);

    this.terrain.dispose();
    this.roadMesh.dispose();
    this.scatter.dispose();
    this.grass.dispose();

    this.camReady = false;
    await this.boot();
    this.paused = false;
  }

  // --------------------------------------------------------------- binding
  _bindInput() {
    const i = this.input;
    i.on('Escape', () => this.ui.toggleMenu());
    i.on('Tab', () => this.ui.toggleMenu());
    i.on('KeyR', () => { this.vehicle.respawn(); this.ui.toast('Returned to the road'); });
    i.on('KeyT', () => {
      this.vehicle.respawn(this.vehicle.roadS + 1000);
      this.ui.toast('Skipped ahead 1 km');
    });
    i.on('KeyC', () => {
      const n = CAMERA_ORDER[(CAMERA_ORDER.indexOf(this.camMode) + 1) % CAMERA_ORDER.length];
      this.settings.set('camera', n);
      this.ui.toast('Camera: ' + n);
    });
    i.on('KeyL', () => {
      const order = ['auto', 'on', 'off'];
      const next = order[(order.indexOf(this.settings.get('headlights')) + 1) % 3];
      this.settings.set('headlights', next);
      this.ui.toast('Headlights: ' + next);
    });
    i.on('KeyH', () => this.settings.set('showHud', !this.settings.get('showHud')));
    i.on('KeyK', () => {
      const on = !this.settings.get('autodrive');
      this.settings.set('autodrive', on);
      this.ui.toast('Autodrive ' + (on ? 'engaged' : 'disengaged'));
    });
    i.on('KeyP', () => {
      this.hudVisible = !this.hudVisible;
      this.ui.setHudVisible(this.hudVisible);
      this.ui.toast(this.hudVisible ? 'Photo mode off' : 'Photo mode');
    });
  }

  // Audio may only start from a user gesture, which is what the start overlay
  // exists to provide.
  async _startAudio() {
    await this.audio.start();
    const s = this.settings;
    this.audio.setEnabled(s.get('audioEnabled'));
    this.audio.setMuteWhenHidden(s.get('muteWhenHidden'));
    this.audio.setDoppler(s.get('doppler'));
    for (const [bus, key] of AUDIO_BUSES) this.audio.setVolume(bus, s.get(key));
  }

  _bindSettings() {
    const s = this.settings;
    const fx = this.postfx;

    s.on('resolutionScale', () => this._resize());
    s.on('fov', () => this._resize());
    s.on('renderDistance', (v) => {
      this.terrain.setRenderScale(v);
      this.camera.far = 900 + v * 3100;
      this.camera.updateProjectionMatrix();
    });
    s.on('fogDensity', (v) => this.sky.setFogDensity(v));
    s.on('timeOfDay', (v) => this.sky.setTimeOfDay(v));
    s.on('autoCycle', (v) => { this.sky.autoCycle = v; });

    // Shadow mapping is deliberately narrow in scope: it covers the car onto
    // the road only. Static scenery uses the faked-AO splat map instead, since
    // a real shadow map spanning the view distance is not affordable.
    s.on('shadows', (v) => {
      const q = parseInt(v, 10);
      const on = q > 0;
      this.renderer.shadowMap.enabled = on;
      this.sky.setShadows(on, q);
      this.car.setShadows(on);
      this.roadMesh.mesh.receiveShadow = on;
      this.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    });

    s.on('fxaa', (v) => this.postfx.set('fxaa', v));
    s.on('clouds', (v) => this.sky.setCloudOpacity(v));
    s.on('fogHeight', (v) => this.postfx.set('fogHeight', v));
    s.on('triplanar', (v) => this.terrain.setDetail({ triplanar: v }));
    s.on('detailScale', (v) => this.terrain.setDetail({ detailScale: v }));
    s.on('fresnel', (v) => this.terrain.setDetail({ fresnel: v }));
    s.on('aoStrength', (v) => this.terrain.setDetail({ aoStrength: v }));

    const fxKeys = [
      ['bloom', 'bloom'], ['motionBlur', 'motionBlur'], ['grain', 'grain'],
      ['vignette', 'vignette'], ['aberration', 'aberration'], ['saturation', 'saturation'],
    ];
    for (const [key, fxKey] of fxKeys) s.on(key, () => fx.set(fxKey, s.effective(key)));
    s.on('reduceMotion', () => {
      for (const [key, fxKey] of fxKeys) fx.set(fxKey, s.effective(key));
      document.body.classList.toggle('reduce-motion', !!s.get('reduceMotion'));
    });

    s.on('scatterDensity', (v) => this.scatter.setDensity(v));
    s.on('grassDensity', (v) => this.grass.setDensity(v));
    s.on('showHud', (v) => this.ui.setHudVisible(v));
    s.on('showStats', (v) => this.ui.setStatsVisible(v));
    s.on('camera', (v) => { this.camMode = v; this.camReady = false; });
    s.on('assists', (v) => { this.vehicle.assists = v; });
    s.on('driftAssist', (v) => { this.vehicle.driftAssist = v; });
    s.on('gripScale', (v) => { this.vehicle.gripScale = v; });
    s.on('barriers', (v) => { this.vehicle.barriersEnabled = v; });
    s.on('steerSensitivity', (v) => { this.input.sensitivity = v; });
    s.on('carColor', (v) => this.car.setColor(parseInt(v.slice(1), 16)));

    s.on('autodrive', (v) => {
      this.autodrive.enabled = v;
      this.ui.setAutodrive(v);
    });
    s.on('autodriveSpeed', (v) => { this.autodrive.targetSpeed = v; });

    // --- audio buses ------------------------------------------------------
    s.on('audioEnabled', (v) => this.audio.setEnabled(v));
    s.on('muteWhenHidden', (v) => this.audio.setMuteWhenHidden(v));
    s.on('doppler', (v) => this.audio.setDoppler(v));
    for (const [bus, key] of AUDIO_BUSES) s.on(key, (v) => this.audio.setVolume(bus, v));

    // --- camera -----------------------------------------------------------
    s.on('cameraDistance', (v) => { this.camDistance = v; });
    s.on('lookSensitivityH', (v) => { this.input.look.sensH = v; });
    s.on('lookSensitivityV', (v) => { this.input.look.sensV = v; });
    s.on('lookMultiplier', (v) => { this.input.look.multiplier = v; });
    s.on('shakeIntensity', () => { /* read live via settings.shakeAmount() */ });

    // --- display ----------------------------------------------------------
    s.on('eyeComfort', (v) => this.postfx.set('eyeComfort', v));
    s.on('screenMode', (v) => this._setScreenMode(v));
    s.on('qualityPreset', (v) => this._applyPreset(v));

    // Touching any preset-controlled option by hand drops the selector to
    // Custom, so it never claims a preset the settings no longer match.
    for (const key of PRESET_KEYS) {
      s.on(key, () => {
        if (this._applyingPreset) return;
        if (s.get('qualityPreset') !== 'custom') {
          s.set('qualityPreset', 'custom', { silent: true });
          this.ui._refreshControls();
        }
      });
    }

    s.on('highContrast', (v) => document.body.classList.toggle('high-contrast', !!v));
    s.on('largeText', (v) => document.body.classList.toggle('large-text', !!v));
    s.on('hudScale', (v) => document.documentElement.style.setProperty('--hud-scale', v));
    s.on('colourFilter', (v) => {
      document.getElementById('viewport').style.filter = v === 'none' ? '' : `url(#cvd-${v})`;
    });
  }

  _applyPreset(name) {
    const bundle = PRESETS[name];
    if (!bundle) return;                      // 'custom' is a label, not a bundle
    this._applyingPreset = true;
    for (const [k, v] of Object.entries(bundle)) this.settings.set(k, v);
    this._applyingPreset = false;
    this.ui._refreshControls();
    this.ui.toast('Quality preset: ' + name);
  }

  _setScreenMode(mode) {
    const want = mode === 'fullscreen';
    const isFull = !!document.fullscreenElement;
    if (want && !isFull) {
      document.documentElement.requestFullscreen?.().catch(() => {
        this.ui.status('Full screen was refused by the browser', 'bad');
        this.settings.set('screenMode', 'windowed');
      });
    } else if (!want && isFull) {
      document.exitFullscreen?.();
    }
  }

  _bindWindow() {
    window.addEventListener('resize', () => this._resize());
    document.addEventListener('fullscreenchange', () => {
      const mode = document.fullscreenElement ? 'fullscreen' : 'windowed';
      if (this.settings.get('screenMode') !== mode) {
        this.settings.set('screenMode', mode, { silent: true });
        this.ui._refreshControls();
      }
      this._resize();
    });
    document.addEventListener('visibilitychange', () => {
      this.audio.setHidden(document.hidden);
      if (document.hidden && this.settings.get('muteWhenHidden')) this.audio.suspend();
      else if (this.settings.get('audioEnabled')) this.audio.resume();
    });
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui.toast('Graphics context lost — reload to recover', 8000);
    });
  }

  _action(name) {
    if (name === 'respawn') {
      this.vehicle.respawn();
      this.input.resetLook();
      this.ui.toggleMenu(false);
      this.ui.toast('Returned to the road');
      return;
    }
    if (name === 'regenerate') this._regenerate();
    else if (name === 'randomSeed') {
      const words = ['ridge', 'cobalt', 'monsoon', 'apex', 'basalt', 'ember', 'quartz', 'drift', 'vector', 'summit'];
      const seed = words[(Math.random() * words.length) | 0] + '-' + Math.floor(Math.random() * 9000 + 1000);
      this.settings.set('seed', seed);
      this.ui._refreshControls();
      this._regenerate();
    }
  }

  _resize() {
    const scale = this.settings.get('resolutionScale') || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.baseFov = this.settings.get('fov') || 74;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
  }

  // ---------------------------------------------------------------- camera
  _placeCamera(snap) {
    const v = this.vehicle;
    const rig = CAMERAS[this.camMode] || CAMERAS.chase;
    const look = this.input.look;

    // Free look orbits the boom around the car. The chase rigs also scale with
    // the regular-distance setting; the hood and bumper views are fixed to the
    // body and ignore both.
    const boom = rig.rigid ? 1 : this.camDistance;
    const yaw = v.yaw + (rig.rigid ? 0 : look.yaw);
    const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    const lift = rig.rigid ? 0 : look.pitch * 6;

    const local = (o, out, scale) => out.set(
      v.px + (cosY * o[0] + sinY * o[2]) * scale,
      v.py - v.restLength + o[1] + (out === _desired ? lift : 0),
      v.pz + (-sinY * o[0] + cosY * o[2]) * scale
    );

    local(rig.pos, _desired, boom);
    local(rig.look, _look, 1);

    if (snap || !this.camReady || rig.rigid) {
      this.camPos.copy(_desired);
      this.camLook.copy(_look);
      this.camReady = true;
    }
    return rig;
  }

  _updateCamera(dt) {
    const v = this.vehicle;
    const s = this.settings;
    const rig = this._placeCamera(false);

    if (!rig.rigid) {
      const k = 1 - Math.exp(-rig.smooth * dt);
      this.camPos.lerp(_desired, k);
      this.camLook.lerp(_look, Math.min(1, k * 1.6));

      // Never let the chase camera clip into the ground.
      const floor = this.heightfield.surface(this.camPos.x, this.camPos.z) + 0.9;
      if (this.camPos.y < floor) this.camPos.y = floor;
    }

    // Shake: scales with speed, surface roughness and how much the tyres are
    // giving up. Zeroed entirely by reduce-motion.
    const shake = s.shakeAmount();
    let sx = 0, sy = 0;
    if (shake > 0) {
      const t = performance.now() * 0.001;
      const amp = shake * (v.speed / 80 * 0.028 + v.surface.rumble * 0.5 + v.slipAmount * 0.05);
      sx = (Math.sin(t * 27.3) + Math.sin(t * 11.7) * 0.6) * amp;
      sy = (Math.sin(t * 31.1) + Math.sin(t * 9.3) * 0.6) * amp;
    }

    this.camera.position.set(this.camPos.x + sx, this.camPos.y + sy, this.camPos.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);

    // Body roll bleeds into the camera unless the horizon is locked.
    if (!s.get('horizonLock')) {
      this.camera.rotateZ(-v.roll * (rig.rigid ? 0.85 : 0.35));
      if (rig.rigid) this.camera.rotateX(v.pitch * 0.6);
    }

    // Speed-reactive FOV.
    const dyn = s.effective('dynamicFov');
    const target = this.baseFov + (dyn ? Math.min(20, v.speed * 0.42) : 0);
    this.camera.fov += (target - this.camera.fov) * Math.min(1, dt * 3.5);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ loop
  _loop = () => {
    requestAnimationFrame(this._loop);

    const now = performance.now();
    let dt = (now - this.clock) / 1000;
    this.clock = now;
    if (dt > 0.25) dt = 0.25;

    this.renderer.info.reset();
    let input = this.input.update(dt);
    const v = this.vehicle;

    // Autodrive writes into its own struct so releasing it hands control back
    // to whatever the human is already holding down.
    if (this.autodrive.enabled && !this.paused) {
      input = this.autodrive.apply(this._autoInput);
    }
    this.input.decayLook(dt, this.settings.get('cameraAutoReset'));

    if (!this.paused) {
      v.update(dt, input);

      // Keep the route generated well past the horizon, and drop what is
      // behind so memory stays flat over a long drive.
      this.road.extend(v.roadS + HORIZON);
      if (v.roadS > 2000) this.road.trim(v.roadS - 1400);

      this.terrain.update(v.px, v.pz);
      this.scatter.update(v.px, v.pz);
      this.grass.update(v.px, v.pz);
      this.roadMesh.update(v.roadS);
    }

    // Streaming budget: hold a little back on slow frames so we degrade
    // gracefully instead of stuttering harder.
    const slow = this.frameMs > 22;
    this.terrain.processQueue(slow ? 1 : 2);
    this.scatter.processQueue(slow ? 3 : 8);
    this.grass.processQueue(slow ? 2 : 5);

    // The AO splat only re-renders when the player crosses a cell boundary,
    // and only after the scenery it reads from has settled.
    if (this.scatter.queue.length === 0) {
      if (this.aoMap.update(v.px, v.pz, this.scatter)) {
        this.terrain.setAOMap(this.aoMap.texture, this.aoMap.centre, this.aoMap.extent);
      }
    }

    this.sky.update(dt, this.camPos.x, this.camPos.y, this.camPos.z);
    this.car.update(v, input);
    this._updateCamera(dt);
    this._updateHeadlights();

    this.audio.update(v, input, dt, this.camera);

    const speed01 = Math.min(1, v.speed / 62);
    this.postfx.render(dt, speed01);

    // --- readouts ---------------------------------------------------------
    const ms = performance.now() - now;
    this.frameMs += (ms - this.frameMs) * 0.08;
    this.fps += (1 / Math.max(dt, 0.0001) - this.fps) * 0.06;

    this._routeTimer -= dt;
    if (this._routeTimer <= 0) { this._routeTimer = 0.15; this._sampleRoute(); }

    if (this.ui.open && this.ui.section === 'analytics') {
      this.ui.updateTelemetry({
        speedKmh: v.speedKmh, rpm: v.rpm, gear: v.gearLabel(), driftAngle: v.driftAngle,
        odometer: v.odometer, altitude: v.py, fps: this.fps, frameMs: this.frameMs,
        draws: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles,
        tyre: v.tyre, compression: v.compression, maxTravel: v.maxTravel,
        grassBlades: 14000 - this.grass.freeTop,
        sceneryCount: (4200 - this.scatter.trees.freeTop) + (1600 - this.scatter.rocks.freeTop),
      });
    }

    if (this.hudVisible && this.settings.get('showHud')) {
      this.ui.update({
        speedKmh: v.speedKmh,
        rpm: v.rpm,
        gear: v.gearLabel(),
        seed: this.seed,
        odometer: v.odometer,
        altitude: v.py,
        surface: v.py < WATER_LEVEL + 1 ? 'WATER'
          : v.surface.grip >= 1 ? 'ROAD' : v.surface.grip > 0.7 ? 'VERGE' : 'OFF-ROAD',
        fps: this.fps,
        frameMs: this.frameMs,
        draws: this.renderer.info.render.calls,
        tris: this.renderer.info.render.triangles,
        x: v.px, z: v.pz, yaw: v.yaw,
        driftAngle: v.driftAngle,
        routePoints: this.routePoints,
      });
    }
  };

  _updateHeadlights() {
    const mode = this.settings.get('headlights');
    const night = this.sky.uniforms.uNight.value > 0.12 || this.sky.sun.intensity < 1.0;
    const on = mode === 'on' || (mode === 'auto' && night);
    if (on !== this.car.headlightsOn) this.car.setHeadlights(on);
  }

  _sampleRoute() {
    const pts = this.routePoints;
    pts.length = 0;
    const v = this.vehicle;
    for (let s = v.roadS - 140; s < v.roadS + 620; s += 16) {
      const n = this.road.nodeAt(s);
      if (!n) break;
      pts.push(n.x, n.z);
    }
  }

  _diagnostics() {
    const gl = this.renderer.getContext();
    let rendererName = 'unknown';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) rendererName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch { /* blocked by the browser — fine */ }

    return {
      version: VERSION,
      seed: this.seed,
      odometer: this.vehicle.odometer,
      fps: this.fps,
      renderer: rendererName,
      viewport: `${window.innerWidth}x${window.innerHeight}@${this.renderer.getPixelRatio().toFixed(2)}`,
      settings: this.settings.values,
    };
  }
}

// ---------------------------------------------------------------- bootstrap
const engine = new Engine();
window.akshatEngine = engine;   // handy for poking at things from the console
engine.boot().catch((err) => {
  console.error(err);
  document.getElementById('load-msg').textContent = 'Failed to start: ' + err.message;
});
