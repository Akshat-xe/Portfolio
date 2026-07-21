// Procedural audio.
//
// No sample assets. Every sound is synthesised from oscillators and one shared
// noise buffer, then driven live by the physics state — which means no loop
// seams, no unnatural pitch stepping under acceleration, and nothing to
// download.
//
// Routing graph:
//
//   engine osc array -> waveshaper -> lowpass -\
//   gearbox whine ----------------------------- > panner -> Doppler delay -> sfx
//   tyre roll / skid --------------------------/
//   wind ------------------------------------------------------------> ambient
//   UI blips --------------------------------------------------------> ui
//   (music / voice buses exist and are mixed, but nothing feeds them yet)
//
//   sfx | ambient | ui | music | voice -> master -> compressor -> destination
//
// Nodes are built once; only AudioParams change afterwards, so the audio thread
// never sees an allocation.

const SPEED_OF_SOUND = 343;   // m/s

// Distinct waveforms model distinct parts of the noise a combustion engine
// makes: sawtooth for the raspy exhaust tone, square for intake harshness,
// sine for the low block vibration you feel more than hear.
const HARMONICS = [
  { mul: 0.5, gain: 0.40, type: 'sawtooth', detune: -6 },
  { mul: 1.0, gain: 1.00, type: 'sawtooth', detune: 0 },
  { mul: 1.0, gain: 0.55, type: 'sine', detune: -1200 },   // block rumble
  { mul: 2.0, gain: 0.44, type: 'sawtooth', detune: 8 },
  { mul: 3.0, gain: 0.18, type: 'square', detune: -4 },
];

export const BUSES = ['master', 'music', 'voice', 'sfx', 'ambient', 'ui'];

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.muteWhenHidden = true;
    this.doppler = true;

    this.volumes = {
      master: 0.65, music: 0.7, voice: 0.8, sfx: 0.9, ambient: 0.7, ui: 0.5,
    };
    this.buses = {};
    this._hidden = false;
  }

  // Must be called from a user gesture — browsers will not start an
  // AudioContext otherwise, which is why the engine gates behind a start
  // overlay rather than trying to autoplay.
  async start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    // --- output chain ----------------------------------------------------
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.volumes.master;
    master.connect(comp);
    this.buses.master = master;

    // One GainNode per mix bus, exactly as the settings sliders expect.
    for (const name of BUSES) {
      if (name === 'master') continue;
      const g = ctx.createGain();
      g.gain.value = this.volumes[name];
      g.connect(master);
      this.buses[name] = g;
    }

    // --- shared noise ----------------------------------------------------
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = w * 0.7 + last * 3.2;
    }
    this.noiseBuffer = buf;

    // --- vehicle spatialisation -----------------------------------------
    // Everything that physically emanates from the car goes through one
    // panner so it is positioned relative to the listener, then through a
    // delay line whose length is distance / speed-of-sound. Modulating that
    // delay IS the Doppler shift — the Web Audio spec dropped the built-in
    // doppler controls, so this is the way to get it.
    this.vehicleBus = ctx.createGain();

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'equalpower';   // HRTF is not worth the cost here
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 4;
    this.panner.maxDistance = 260;
    this.panner.rolloffFactor = 0.9;

    this.delay = ctx.createDelay(0.5);
    this.delay.delayTime.value = 0.02;

    this.vehicleBus.connect(this.panner);
    this.panner.connect(this.delay);
    this.delay.connect(this.buses.sfx);

    // --- engine ----------------------------------------------------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDriveCurve(2.6);
    shaper.oversample = '2x';

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 0.9;

    this.oscs = [];
    const oscBus = ctx.createGain();
    oscBus.gain.value = 0.20;
    for (const h of HARMONICS) {
      const o = ctx.createOscillator();
      o.type = h.type;
      o.frequency.value = 60;
      o.detune.value = h.detune;
      const g = ctx.createGain();
      g.gain.value = h.gain;
      o.connect(g).connect(oscBus);
      o.start();
      this.oscs.push({ node: o, mul: h.mul });
    }
    oscBus.connect(shaper).connect(this.engineFilter).connect(this.engineGain)
      .connect(this.vehicleBus);

    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whine.frequency.value = 400;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.vehicleBus);
    this.whine.start();

    // --- noise layers -----------------------------------------------------
    this.tyre = this._noiseLayer('bandpass', 620, 1.1, this.vehicleBus);
    this.skid = this._noiseLayer('bandpass', 1750, 4.5, this.vehicleBus);
    // Wind is heard at the listener, not from the car, so it stays unspatialised
    // on the ambient bus.
    this.wind = this._noiseLayer('bandpass', 380, 0.6, this.buses.ambient);

    this.ready = true;
    this._applyVolumes();
  }

  _noiseLayer(type, freq, q, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filt).connect(gain).connect(dest);
    src.start();
    return { src, filt, gain };
  }

  // ------------------------------------------------------------------ mixer
  setVolume(bus, v) {
    this.volumes[bus] = v;
    this._applyVolumes();
  }

  setEnabled(on) {
    this.enabled = on;
    this._applyVolumes();
  }

  setMuteWhenHidden(on) {
    this.muteWhenHidden = on;
    this._applyVolumes();
  }

  setDoppler(on) { this.doppler = on; }

  _applyVolumes() {
    if (!this.ready) return;
    const silent = !this.enabled || (this.muteWhenHidden && this._hidden);
    for (const name of BUSES) {
      const bus = this.buses[name];
      if (!bus) continue;
      const target = name === 'master'
        ? (silent ? 0 : this.volumes.master)
        : this.volumes[name];
      bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  setHidden(hidden) {
    this._hidden = hidden;
    this._applyVolumes();
  }

  // ------------------------------------------------------------------- ui
  // Interface blips are synthesised too — a short filtered sine with a fast
  // decay. Cheap enough to allocate per click without troubling the GC.
  click(kind = 'tap') {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();

    const spec = {
      tap:    { freq: 660, type: 'sine',     dur: 0.06, gain: 0.20 },
      toggle: { freq: 880, type: 'triangle', dur: 0.05, gain: 0.16 },
      back:   { freq: 380, type: 'sine',     dur: 0.09, gain: 0.18 },
      confirm:{ freq: 1040, type: 'triangle', dur: 0.12, gain: 0.22 },
    }[kind] || { freq: 660, type: 'sine', dur: 0.06, gain: 0.2 };

    o.type = spec.type;
    o.frequency.setValueAtTime(spec.freq, t);
    o.frequency.exponentialRampToValueAtTime(spec.freq * 0.7, t + spec.dur);

    f.type = 'lowpass';
    f.frequency.value = 4200;

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(spec.gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);

    o.connect(f).connect(g).connect(this.buses.ui);
    o.start(t);
    o.stop(t + spec.dur + 0.02);
  }

  // ---------------------------------------------------------------- update
  update(vehicle, input, dt, camera) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const smooth = 0.045;

    // Firing frequency for a four-cylinder four-stroke. RPM comes from the
    // driven wheels' angular velocity, so wheelspin is audible.
    const f0 = Math.max(20, (vehicle.rpm / 60) * 2);
    for (const o of this.oscs) o.node.frequency.setTargetAtTime(f0 * o.mul, t, smooth);

    const load = Math.min(1, input.throttle * 0.85 + 0.15);
    const rpmN = Math.min(1, vehicle.rpm / 7400);

    const engV = (0.09 + rpmN * 0.30) * (0.42 + load * 0.72);
    this.engineGain.gain.setTargetAtTime(engV, t, smooth);
    // Opening the throttle raises the cutoff — the engine "opening up".
    this.engineFilter.frequency.setTargetAtTime(
      420 + rpmN * 2600 * (0.45 + load * 0.75), t, smooth
    );

    this.whine.frequency.setTargetAtTime(320 + rpmN * 2400, t, smooth);
    this.whineGain.gain.setTargetAtTime(rpmN * rpmN * 0.014, t, smooth);

    const spd = vehicle.speed;
    const spdN = Math.min(1, spd / 72);
    const rough = vehicle.surface.rumble;
    this.tyre.filt.frequency.setTargetAtTime(380 + spdN * 900 + rough * 2400, t, smooth);
    this.tyre.gain.gain.setTargetAtTime(spdN * (0.045 + rough * 0.55), t, smooth);

    const slip = vehicle.grounded ? vehicle.slipAmount : 0;
    this.skid.gain.gain.setTargetAtTime(
      Math.max(0, slip - 0.12) * 0.34 * Math.min(1, spd / 6), t, 0.03
    );
    this.skid.filt.frequency.setTargetAtTime(1400 + slip * 1400, t, 0.05);

    const air = vehicle.grounded ? 1 : 1.5;
    this.wind.gain.gain.setTargetAtTime(spdN * spdN * 0.30 * air, t, 0.08);
    this.wind.filt.frequency.setTargetAtTime(260 + spdN * 900, t, 0.08);

    if (camera) this._updateSpatial(vehicle, camera, t);
    void dt;
  }

  _updateSpatial(vehicle, camera, t) {
    const ctx = this.ctx;
    const lis = ctx.listener;

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    // Listener follows the camera, including orientation, so the car pans
    // correctly when the camera swings around it.
    if (lis.positionX) {
      lis.positionX.setTargetAtTime(cx, t, 0.02);
      lis.positionY.setTargetAtTime(cy, t, 0.02);
      lis.positionZ.setTargetAtTime(cz, t, 0.02);
      const m = camera.matrixWorld.elements;
      // Camera looks down its local -Z; up is local +Y.
      lis.forwardX.setTargetAtTime(-m[8], t, 0.02);
      lis.forwardY.setTargetAtTime(-m[9], t, 0.02);
      lis.forwardZ.setTargetAtTime(-m[10], t, 0.02);
      lis.upX.setTargetAtTime(m[4], t, 0.02);
      lis.upY.setTargetAtTime(m[5], t, 0.02);
      lis.upZ.setTargetAtTime(m[6], t, 0.02);
    } else if (lis.setPosition) {
      lis.setPosition(cx, cy, cz);
    }

    const p = this.panner;
    if (p.positionX) {
      p.positionX.setTargetAtTime(vehicle.px, t, 0.02);
      p.positionY.setTargetAtTime(vehicle.py, t, 0.02);
      p.positionZ.setTargetAtTime(vehicle.pz, t, 0.02);
    } else if (p.setPosition) {
      p.setPosition(vehicle.px, vehicle.py, vehicle.pz);
    }

    // Propagation delay = distance / c. Because the delay line resamples as
    // its length changes, a closing or opening gap pitch-shifts on its own —
    // that is the Doppler effect, obtained for free rather than faked.
    if (this.doppler) {
      const dx = vehicle.px - cx, dy = vehicle.py - cy, dz = vehicle.pz - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const target = Math.min(0.45, 0.01 + dist / SPEED_OF_SOUND);
      // Short time constant: long enough to avoid zipper noise, short enough
      // that the shift still reads as motion.
      this.delay.delayTime.setTargetAtTime(target, t, 0.05);
    } else {
      this.delay.delayTime.setTargetAtTime(0.01, t, 0.1);
    }
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}

function makeDriveCurve(amount) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}
