/* ============================================================
   AKSHAT PORTFOLIO — performance HUD
   Glassmorphic pill, top-centre. Shows ONLY metrics a browser can
   genuinely measure. Deliberately absent: CPU/GPU temperature,
   wattage and utilisation — no web API exposes those, so showing
   them would be fabricated.
   Each metric is individually toggleable from Settings > Performance.
   ============================================================ */

const LS_KEY = "ak-hud-metrics";

/* id -> { label, group, get(ctx) -> {v, unit, tone} | null }
   tone: ok | warn | bad | plain  (drives the value colour)          */
export const METRICS = {
  fps: {
    label: "FPS",
    group: "Framerate",
    always: true,
    get: (c) => ({ v: Math.round(c.fps), tone: c.fps >= 50 ? "ok" : c.fps >= 30 ? "warn" : "bad" }),
  },
  /* --- renderer (THREE counters) --- */
  tris: {
    label: "Tris",
    group: "Renderer",
    get: (c) => (c.render ? { v: fmtK(c.render.triangles), tone: "plain" } : null),
  },
  /* --- memory --- */
  heap: {
    label: "Heap",
    group: "Memory",
    get: () => {
      const m = performance.memory;
      if (!m) return null;
      const mb = m.usedJSHeapSize / 1048576;
      const pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
      return { v: Math.round(mb), unit: "MB", tone: pct < 0.6 ? "ok" : pct < 0.85 ? "warn" : "bad" };
    },
  },
  heapLimit: {
    label: "Heap Max",
    group: "Memory",
    get: () => {
      const m = performance.memory;
      return m ? { v: Math.round(m.jsHeapSizeLimit / 1048576), unit: "MB", tone: "plain" } : null;
    },
  },
  ram: {
    label: "RAM",
    group: "Memory",
    get: () => (navigator.deviceMemory ? { v: navigator.deviceMemory, unit: "GB", tone: "plain" } : null),
  },
  /* --- system --- */
  cores: {
    label: "Cores",
    group: "System",
    get: () => (navigator.hardwareConcurrency ? { v: navigator.hardwareConcurrency, tone: "plain" } : null),
  },
  cpuPressure: {
    label: "CPU",
    group: "System",
    get: (c) =>
      c.pressure
        ? {
            v: c.pressure,
            tone: c.pressure === "nominal" ? "ok" : c.pressure === "fair" ? "ok" : c.pressure === "serious" ? "warn" : "bad",
          }
        : null,
  },
  gpu: {
    label: "GPU",
    group: "System",
    get: (c) => (c.gpu ? { v: shortGpu(c.gpu), tone: "plain" } : null),
  },
  res: {
    label: "Res",
    group: "System",
    get: () => ({ v: `${Math.round(innerWidth * devicePixelRatio)}×${Math.round(innerHeight * devicePixelRatio)}`, tone: "plain" }),
  },
  uptime: {
    label: "Session",
    group: "System",
    get: (c) => ({ v: fmtTime(c.uptime), tone: "plain" }),
  },
};

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return m + ":" + String(Math.floor(s % 60)).padStart(2, "0");
};
const shortGpu = (s) => {
  const m = s.match(/(NVIDIA|AMD|Radeon|Intel|Apple|Mali|Adreno|PowerVR)[^,()]*/i);
  let out = (m ? m[0] : s).replace(/\s+/g, " ").trim();
  return out.length > 22 ? out.slice(0, 21) + "…" : out;
};

/* which metrics are enabled by default */
const DEFAULTS = { fps: true };

export class Hud {
  constructor() {
    this.enabled = this.load();
    this.frames = 0;
    this.fps = 0;
    this.frameMs = 0;
    this.low1 = 0;
    this.samples = [];
    this.gpu = null;
    this.pressure = null;
    this.battery = null;
    this.start = performance.now();
    this.cells = {};
    this.build();
    this.initSensors();
    this.loop();
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw && typeof raw === "object") return raw;
    } catch (e) {}
    return { ...DEFAULTS };
  }
  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.enabled));
    } catch (e) {}
  }
  isOn(id) {
    return !!this.enabled[id];
  }
  set(id, on) {
    this.enabled[id] = !!on;
    this.save();
    this.rebuild();
  }
  anyOn() {
    return Object.values(this.enabled).some(Boolean);
  }

  build() {
    this.root = document.createElement("div");
    this.root.id = "ak-hud";
    document.body.appendChild(this.root);
    this.rebuild();
  }

  rebuild() {
    this.root.innerHTML = "";
    this.cells = {};
    const on = Object.keys(METRICS).filter((id) => this.isOn(id));
    this.root.classList.toggle("ak-hud-hidden", on.length === 0);
    for (const id of on) {
      const cell = document.createElement("span");
      cell.className = "ak-hud-cell";
      const lab = document.createElement("span");
      lab.className = "ak-hud-lab";
      lab.textContent = METRICS[id].label;
      const val = document.createElement("span");
      val.className = "ak-hud-val";
      val.textContent = "–";
      cell.appendChild(lab);
      cell.appendChild(val);
      this.root.appendChild(cell);
      this.cells[id] = { cell, val };
    }
  }

  /* async / event-driven sources */
  async initSensors() {
    /* GPU model via WEBGL_debug_renderer_info */
    try {
      const g = window.__akGame && window.__akGame.gpuInfo && window.__akGame.gpuInfo();
      if (g) this.gpu = g;
      else {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) this.gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      }
    } catch (e) {}

    /* Compute Pressure API — real thermal/CPU pressure state (not a temperature) */
    try {
      if ("PressureObserver" in window) {
        this.pressureObserver = new PressureObserver((records) => {
          const last = records[records.length - 1];
          if (last) this.pressure = last.state;
        });
        await this.pressureObserver.observe("cpu", { sampleInterval: 1000 });
      }
    } catch (e) {}

    /* Battery */
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        const sync = () => (this.battery = { level: b.level, charging: b.charging });
        sync();
        b.addEventListener("levelchange", sync);
        b.addEventListener("chargingchange", sync);
      }
    } catch (e) {}
  }

  loop() {
    let last = performance.now();
    let acc = 0;
    let lastGameFrames = window.__akFrames || 0;
    let lastRenderAt = last;

    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      acc += dt;

      /* Prefer the engine's real rendered-frame counter. Falling back to our
         own rAF would over-report whenever the game is capped or paused. */
      const gameFrames = window.__akFrames;
      if (typeof gameFrames === "number") {
        const drawn = gameFrames - lastGameFrames;
        if (drawn > 0) {
          /* sample the interval between actual draws for the 1% low */
          const per = (now - lastRenderAt) / drawn;
          for (let i = 0; i < drawn && i < 8; i++) this.samples.push(per);
          lastRenderAt = now;
        }
        this.frames += drawn;
        lastGameFrames = gameFrames;
      } else {
        this.frames++;
        this.samples.push(dt);
      }
      if (this.samples.length > 240) this.samples.shift();

      if (acc >= 500) {
        this.fps = (this.frames * 1000) / acc;
        this.frameMs = this.frames > 0 ? acc / this.frames : 0;
        const sorted = [...this.samples].sort((a, b) => b - a);
        const worst = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.01)));
        const avgWorst = worst.reduce((s, x) => s + x, 0) / worst.length;
        this.low1 = avgWorst > 0 ? 1000 / avgWorst : 0;
        this.frames = 0;
        acc = 0;
        this.paint();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  paint() {
    if (!this.anyOn()) return;
    const ctx = {
      fps: this.fps,
      frameMs: this.frameMs,
      low1: this.low1,
      gpu: this.gpu,
      pressure: this.pressure,
      battery: this.battery,
      uptime: (performance.now() - this.start) / 1000,
      render: window.__akGame && window.__akGame.renderStats ? window.__akGame.renderStats() : null,
    };
    for (const id in this.cells) {
      let out = null;
      try {
        out = METRICS[id].get(ctx);
      } catch (e) {}
      const { cell, val } = this.cells[id];
      if (!out) {
        cell.classList.add("ak-hud-na");
        val.textContent = "n/a";
        val.dataset.tone = "plain";
        continue;
      }
      cell.classList.remove("ak-hud-na");
      val.textContent = out.unit ? `${out.v}${out.unit}` : String(out.v);
      val.dataset.tone = out.tone || "plain";
    }
  }
}

export default Hud;
