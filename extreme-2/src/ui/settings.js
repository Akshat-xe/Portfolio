// Settings model: a declarative schema plus a tiny observable store backed by
// localStorage. The UI layer renders straight off SECTIONS + SCHEMA, so adding
// an option anywhere in the engine means adding one object here and one
// listener in main.js.

const KEY = 'akshat-racing-engine/settings/v2';

// Primary navigation. The sidebar renders these; each may hold several tabs.
export const SECTIONS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'report', label: 'Report', icon: 'report' },
];

export const SCHEMA = [
  // ------------------------------------------------------------------ home
  {
    section: 'home', tab: 'World',
    groups: [{
      title: 'Generation',
      fields: [
        { key: 'seed', label: 'World seed', type: 'text', default: 'akshat',
          hint: 'Any string. The same seed always regenerates the identical terrain and route.' },
        { key: 'regenerate', label: 'Apply seed', type: 'action', action: 'regenerate',
          hint: 'Rebuilds the heightfield, reroutes the road and returns you to the start line.' },
        { key: 'randomSeed', label: 'Random seed', type: 'action', action: 'randomSeed' },
        { key: 'respawn', label: 'Return to road', type: 'action', action: 'respawn' },
      ],
    }, {
      title: 'Atmosphere',
      fields: [
        { key: 'timeOfDay', label: 'Time of day', type: 'range', min: 0, max: 1, step: 0.005, default: 0.34,
          format: (v) => formatClock(v) },
        { key: 'autoCycle', label: 'Day / night cycle', type: 'toggle', default: false,
          hint: 'Advances the sun continuously — one full day every 15 minutes.' },
      ],
    }],
  },

  // -------------------------------------------------------------- settings
  {
    section: 'settings', tab: 'Audio',
    groups: [{
      title: 'Mix',
      fields: [
        { key: 'audioEnabled', label: 'Audio', type: 'toggle', default: true },
        { key: 'volMaster', label: 'Master', type: 'range', min: 0, max: 1, step: 0.01, default: 0.65, format: pct },
        { key: 'volMusic', label: 'Music', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7, format: pct,
          hint: 'Bus exists and is mixed, but nothing feeds it — the engine ships with no music.' },
        { key: 'volVoice', label: 'Voice', type: 'range', min: 0, max: 1, step: 0.01, default: 0.8, format: pct,
          hint: 'As above: routed and ready, no sources yet.' },
        { key: 'volSfx', label: 'Sound effects', type: 'range', min: 0, max: 1, step: 0.01, default: 0.9, format: pct,
          hint: 'Engine, gearbox, tyre roll and skid — everything spatialised from the car.' },
        { key: 'volAmbient', label: 'Ambient', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7, format: pct,
          hint: 'Wind, heard at the listener rather than from the car.' },
        { key: 'volUi', label: 'Interface', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, format: pct },
      ],
    }, {
      title: 'Behaviour',
      fields: [
        { key: 'muteWhenHidden', label: 'Mute when in background', type: 'toggle', default: true },
        { key: 'doppler', label: 'Doppler simulation', type: 'toggle', default: true,
          hint: 'Routes the car through a delay line whose length is distance / speed of sound. The resampling as that gap changes is the pitch shift.' },
      ],
    }],
  },

  {
    section: 'settings', tab: 'Graphics',
    groups: [{
      title: 'Presets & display',
      fields: [
        { key: 'qualityPreset', label: 'Quality preset', type: 'select', default: 'high',
          options: [['custom', 'Custom'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
          hint: 'Changing any option below switches this to Custom.' },
        { key: 'screenMode', label: 'Screen mode', type: 'select', default: 'windowed',
          options: [['windowed', 'Windowed'], ['fullscreen', 'Full screen']] },
        { key: 'resolutionScale', label: 'Render scale', type: 'range', min: 0.5, max: 2, step: 0.05, default: 1,
          format: (v) => v.toFixed(2) + '×' },
        { key: 'renderDistance', label: 'Draw distance', type: 'range', min: 0.4, max: 1, step: 0.05, default: 1,
          format: (v) => Math.round(v * 2500) + ' m' },
      ],
    }, {
      title: 'Lighting & effects',
      fields: [
        { key: 'shadows', label: 'Vehicle shadow', type: 'select', default: '1',
          options: [['0', 'Off'], ['1', 'Standard'], ['2', 'High']],
          hint: 'Shadow mapping covers the car onto the road only; scenery uses the faked-AO map.' },
        { key: 'fxaa', label: 'FXAA', type: 'toggle', default: true,
          hint: 'MSAA is off by design — multisampling the half-float HDR target is not worth the bandwidth.' },
        { key: 'bloom', label: 'Bloom', type: 'range', min: 0, max: 1.2, step: 0.02, default: 0.5 },
        { key: 'eyeComfort', label: 'Eye comfort', type: 'range', min: 0, max: 1, step: 0.05, default: 0, format: pct,
          hint: 'Warming filter applied in the final grade pass — shifts the whole image toward amber and pulls back blue.' },
        { key: 'motionBlur', label: 'Motion blur', type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8 },
        { key: 'grain', label: 'Film grain', type: 'range', min: 0, max: 0.09, step: 0.002, default: 0.03 },
        { key: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.02, default: 0.55 },
        { key: 'aberration', label: 'Chromatic aberration', type: 'range', min: 0, max: 0.005, step: 0.0002, default: 0.0016,
          format: (v) => (v * 1000).toFixed(1) },
        { key: 'saturation', label: 'Saturation', type: 'range', min: 0.4, max: 1.6, step: 0.02, default: 1.08 },
      ],
    }, {
      title: 'Terrain shading',
      fields: [
        { key: 'triplanar', label: 'Triplanar mapping', type: 'toggle', default: true,
          hint: 'Projects ground textures from three axes. Off is faster but smears on cliffs.' },
        { key: 'detailScale', label: 'Detail texture scale', type: 'range', min: 0.04, max: 0.3, step: 0.005, default: 0.24,
          format: (v) => (1 / v).toFixed(1) + ' m' },
        { key: 'fresnel', label: 'Fresnel depth cue', type: 'range', min: 0, max: 1, step: 0.02, default: 0.35 },
        { key: 'aoStrength', label: 'Foliage ambient occlusion', type: 'range', min: 0, max: 1, step: 0.05, default: 0.55 },
      ],
    }, {
      title: 'Atmosphere & scatter',
      fields: [
        { key: 'fogDensity', label: 'Haze density', type: 'range', min: 0.0002, max: 0.005, step: 0.0001, default: 0.0016,
          format: (v) => (v * 1000).toFixed(2) },
        { key: 'fogHeight', label: 'Fog height falloff', type: 'range', min: 0.002, max: 0.04, step: 0.001, default: 0.011,
          format: (v) => Math.round(1 / v) + ' m' },
        { key: 'clouds', label: 'Cloud cover', type: 'range', min: 0, max: 1.4, step: 0.05, default: 1, format: pct },
        { key: 'grassDensity', label: 'Grass density', type: 'range', min: 0, max: 1.5, step: 0.1, default: 1 },
        { key: 'scatterDensity', label: 'Scenery density', type: 'range', min: 0, max: 1.6, step: 0.1, default: 1 },
      ],
    }, {
      title: 'Interface',
      fields: [
        { key: 'showHud', label: 'Show HUD', type: 'toggle', default: true },
        { key: 'showStats', label: 'Show performance readout', type: 'toggle', default: true },
      ],
    }],
  },

  {
    section: 'settings', tab: 'Camera',
    groups: [{
      title: 'View',
      fields: [
        { key: 'camera', label: 'Camera', type: 'select', default: 'chase',
          options: [['chase', 'Chase'], ['close', 'Close chase'], ['hood', 'Hood'], ['bumper', 'Bumper'], ['cinematic', 'Cinematic']] },
        { key: 'cameraDistance', label: 'Regular distance', type: 'range', min: 0.6, max: 1.8, step: 0.05, default: 1,
          format: (v) => v.toFixed(2) + '×',
          hint: 'Scales the chase camera boom. No effect on the hood and bumper views.' },
        { key: 'fov', label: 'Field of view', type: 'range', min: 55, max: 110, step: 1, default: 74, format: (v) => v + '°' },
        { key: 'dynamicFov', label: 'Speed-reactive FOV', type: 'toggle', default: true },
      ],
    }, {
      title: 'Free look',
      fields: [
        { key: 'lookSensitivityH', label: 'Horizontal sensitivity', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
          hint: 'Drag with the mouse (or hold right button) to look around the car.' },
        { key: 'lookSensitivityV', label: 'Vertical sensitivity', type: 'range', min: 0, max: 1, step: 0.01, default: 0.4, format: pct },
        { key: 'lookMultiplier', label: 'Fine-look multiplier', type: 'range', min: 0.2, max: 2, step: 0.05, default: 1,
          format: (v) => v.toFixed(2) + '×',
          hint: 'Applied on top of both axes while a slow, deliberate look is in progress.' },
        { key: 'cameraAutoReset', label: 'Auto-reset view', type: 'toggle', default: true,
          hint: 'Eases the camera back behind the car once you stop looking around.' },
      ],
    }, {
      title: 'Motion',
      fields: [
        { key: 'shakeIntensity', label: 'Camera shake', type: 'select', default: 'medium',
          options: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
      ],
    }],
  },

  {
    section: 'settings', tab: 'Gameplay',
    groups: [{
      title: 'Assistance',
      fields: [
        { key: 'autodrive', label: 'Autodrive AI', type: 'toggle', default: false,
          hint: 'Hands the car to the routing algorithm, which feeds steering and pedals through the ordinary input path — the tyre model and barriers still apply.' },
        { key: 'autodriveSpeed', label: 'Autodrive target speed', type: 'range', min: 40, max: 130, step: 5, default: 78,
          format: (v) => v + ' km/h' },
        { key: 'assists', label: 'Stability assists', type: 'toggle', default: true,
          hint: 'ABS and traction control, applied to wheel angular velocity.' },
      ],
    }, {
      title: 'Handling',
      fields: [
        { key: 'steerSensitivity', label: 'Steering sensitivity', type: 'range', min: 0.4, max: 1.8, step: 0.05, default: 1 },
        { key: 'driftAssist', label: 'Drift assist', type: 'range', min: 0, max: 1, step: 0.05, default: 0.55,
          format: (v) => (v === 0 ? 'Off (pure sim)' : Math.round(v * 100) + '%'),
          hint: 'How far the momentum vector may detach from the steering vector once the rears break traction.' },
        { key: 'gripScale', label: 'Tyre grip', type: 'range', min: 0.7, max: 1.3, step: 0.02, default: 1, format: pct },
        { key: 'barriers', label: 'Road barriers', type: 'toggle', default: true },
      ],
    }, {
      title: 'Vehicle',
      fields: [
        { key: 'headlights', label: 'Headlights', type: 'select', default: 'auto',
          options: [['auto', 'Automatic'], ['on', 'Always on'], ['off', 'Off']] },
        { key: 'carColor', label: 'Paint', type: 'color', default: '#c2222c' },
        { key: 'units', label: 'Speed units', type: 'select', default: 'kmh',
          options: [['kmh', 'km/h'], ['mph', 'mph']] },
      ],
    }],
  },

  {
    section: 'settings', tab: 'Accessibility',
    groups: [{
      title: 'Motion',
      fields: [
        { key: 'reduceMotion', label: 'Reduce motion', type: 'toggle', default: false,
          hint: 'Disables motion blur, chromatic aberration, film grain, camera shake and dynamic FOV. Overrides the graphics settings while it is on.' },
        { key: 'horizonLock', label: 'Lock horizon', type: 'toggle', default: false },
      ],
    }, {
      title: 'Readability',
      fields: [
        { key: 'highContrast', label: 'High-contrast HUD', type: 'toggle', default: false },
        { key: 'largeText', label: 'Larger interface text', type: 'toggle', default: false },
        { key: 'hudScale', label: 'HUD scale', type: 'range', min: 0.75, max: 1.6, step: 0.05, default: 1, format: pct },
      ],
    }, {
      title: 'Colour vision',
      fields: [
        { key: 'colourFilter', label: 'Colour filter', type: 'select', default: 'none',
          options: [['none', 'None'], ['protanopia', 'Protanopia'], ['deuteranopia', 'Deuteranopia'], ['tritanopia', 'Tritanopia']] },
      ],
    }],
  },

  { section: 'settings', tab: 'Controls', custom: 'controls' },
  { section: 'analytics', tab: 'Telemetry', custom: 'analytics' },
  { section: 'report', tab: 'Feedback', custom: 'feedback' },
];

// Bundles applied by the quality preset selector.
export const PRESETS = {
  low: {
    resolutionScale: 0.7, renderDistance: 0.5, shadows: '0', fxaa: true,
    bloom: 0, motionBlur: 0, grain: 0, aberration: 0,
    triplanar: false, detailScale: 0.16, aoStrength: 0.3,
    clouds: 0.4, grassDensity: 0, scatterDensity: 0.4, fogHeight: 0.011,
  },
  medium: {
    resolutionScale: 1, renderDistance: 0.75, shadows: '1', fxaa: true,
    bloom: 0.35, motionBlur: 0.5, grain: 0.02, aberration: 0.001,
    triplanar: true, detailScale: 0.24, aoStrength: 0.45,
    clouds: 0.8, grassDensity: 0.6, scatterDensity: 0.8, fogHeight: 0.011,
  },
  high: {
    resolutionScale: 1, renderDistance: 1, shadows: '1', fxaa: true,
    bloom: 0.5, motionBlur: 0.8, grain: 0.03, aberration: 0.0016,
    triplanar: true, detailScale: 0.24, aoStrength: 0.55,
    clouds: 1, grassDensity: 1, scatterDensity: 1, fogHeight: 0.011,
  },
};

// Keys that, when changed by hand, drop the preset selector back to Custom.
export const PRESET_KEYS = Object.keys(PRESETS.high);

export const SHAKE_LEVELS = { off: 0, low: 0.35, medium: 0.7, high: 1.25 };

function pct(v) { return Math.round(v * 100) + '%'; }

function formatClock(v) {
  const mins = Math.round(v * 24 * 60);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

export function defaults() {
  const out = {};
  for (const tab of SCHEMA) {
    if (!tab.groups) continue;
    for (const g of tab.groups) {
      for (const f of g.fields) if (f.type !== 'action') out[f.key] = f.default;
    }
  }
  out.feedbackEndpoint = '';
  return out;
}

export class Settings {
  constructor() {
    this.values = defaults();
    this.listeners = new Map();
    this.load();

    if (!this._stored && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.values.reduceMotion = true;
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      this._stored = !!raw;
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch { this._stored = false; }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* private mode */ }
  }

  get(key) { return this.values[key]; }

  set(key, value, { silent = false } = {}) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.save();
    if (!silent) this.emit(key, value);
  }

  on(key, fn) {
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(fn);
    return this;
  }

  emit(key, value) {
    const ls = this.listeners.get(key);
    if (ls) for (const fn of ls) fn(value, this);
    const all = this.listeners.get('*');
    if (all) for (const fn of all) fn(key, value, this);
  }

  applyAll() {
    for (const key of Object.keys(this.values)) this.emit(key, this.values[key]);
  }

  reset() {
    this.values = defaults();
    this.save();
    this.applyAll();
  }

  // Reduce-motion is an override, not a second copy of the settings: the
  // engine asks for the effective value rather than the stored one.
  effective(key) {
    if (this.values.reduceMotion) {
      if (key === 'motionBlur' || key === 'grain' || key === 'aberration') return 0;
      if (key === 'shakeIntensity') return 'off';
      if (key === 'dynamicFov') return false;
    }
    return this.values[key];
  }

  shakeAmount() { return SHAKE_LEVELS[this.effective('shakeIntensity')] ?? 0.7; }
}
