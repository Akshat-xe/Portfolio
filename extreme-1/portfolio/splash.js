/* ============================================================
   AKSHAT PORTFOLIO — splash overlay
   - Liquid warp shader background (vendored Paper Shaders engine)
   - 6 atmosphere presets, default Plasma, persisted selection
   - Mouse-proximity text effect on the name
   - Glassy magnetic Explore button with cursor-tracking glow ring
   - Theme-adaptive cursor trail (persists into the game)
   ============================================================ */

import { ShaderMount } from "./shader_mount.js";
import { warpFragmentShader, PatternShapes } from "./warp.js";
import { getShaderColorFromString } from "./get_color.js";

/* ---------- atmosphere presets (from the Framer AnimatedLiquidBackground) ---------- */
const THEMES = {
  Prism: {
    accent: "#66B3FF",
    params: { color1: "#050505", color2: "#66B3FF", color3: "#FFFFFF", rotation: -50, proportion: 1, scale: 0.01, speed: 30, distortion: 0, swirl: 50, swirlIterations: 16, softness: 47, offset: -299, shape: "Checks", shapeSize: 45 },
  },
  Lava: {
    accent: "#FF9F21",
    params: { color1: "#FF9F21", color2: "#FF0303", color3: "#000000", rotation: 114, proportion: 100, scale: 0.52, speed: 30, distortion: 7, swirl: 18, swirlIterations: 20, softness: 100, offset: 717, shape: "Edge", shapeSize: 12 },
  },
  Plasma: {
    accent: "#B566FF",
    params: { color1: "#B566FF", color2: "#000000", color3: "#000000", rotation: 0, proportion: 63, scale: 0.75, speed: 30, distortion: 5, swirl: 61, swirlIterations: 5, softness: 100, offset: -168, shape: "Checks", shapeSize: 28 },
  },
  Pulse: {
    accent: "#66FF85",
    params: { color1: "#66FF85", color2: "#000000", color3: "#000000", rotation: -167, proportion: 92, scale: 0, speed: 20, distortion: 54, swirl: 75, swirlIterations: 3, softness: 28, offset: -813, shape: "Checks", shapeSize: 79 },
  },
  Vortex: {
    accent: "#EAEAEA",
    params: { color1: "#000000", color2: "#FFFFFF", color3: "#000000", rotation: 50, proportion: 41, scale: 0.4, speed: 20, distortion: 0, swirl: 100, swirlIterations: 3, softness: 5, offset: -744, shape: "Stripes", shapeSize: 80 },
  },
  Mist: {
    accent: "#FF66B8",
    params: { color1: "#050505", color2: "#FF66B8", color3: "#050505", rotation: 0, proportion: 33, scale: 0.48, speed: 39, distortion: 4, swirl: 65, swirlIterations: 5, softness: 100, offset: -235, shape: "Edge", shapeSize: 48 },
  },
};
const DEFAULT_THEME = "Plasma";
const THEME_KEY = "ak-theme";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* cubic-bezier(.65,0,.88,.77) — same speed easing the Framer component uses */
function cubicBezier(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) break;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(Math.min(1, Math.max(0, t)));
  };
}
const speedEase = cubicBezier(0.65, 0, 0.88, 0.77);

function themeUniforms(p) {
  return {
    u_scale: p.scale,
    u_rotation: (p.rotation * Math.PI) / 180,
    u_color1: getShaderColorFromString(p.color1, "hsla(0,0%,15%,1)"),
    u_color2: getShaderColorFromString(p.color2, "hsla(203,80%,70%,1)"),
    u_color3: getShaderColorFromString(p.color3, "hsla(0,0%,100%,1)"),
    u_proportion: p.proportion / 100,
    u_softness: p.softness / 100,
    u_distortion: p.distortion / 50,
    u_swirl: p.swirl / 100,
    u_swirlIterations: p.swirl === 0 ? 0 : p.swirlIterations,
    u_shapeScale: p.shapeSize / 100,
    u_shape: PatternShapes[p.shape],
  };
}
/* Speed 0 makes ShaderMount cancel its rAF loop entirely, which froze the
   background into a still image and read as "broken/paused". With reduced
   motion we slow it to a gentle drift instead of stopping it dead. */
const themeSpeed = (p) => {
  const s = speedEase(p.speed / 100) * 5;
  return reducedMotion ? Math.max(0.15, s * 0.25) : s;
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Storage can throw outright when a browser blocks it (Brave shields,
   Safari private mode, third-party-cookie blocking). Never let that kill
   the page — it previously threw inside the constructor and left a blank
   screen with no Explore button. */
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {}
  },
};

/* ============================================================ */
class Splash {
  constructor() {
    this.themeName = store.get(THEME_KEY);
    if (!THEMES[this.themeName]) this.themeName = DEFAULT_THEME;
    this.shader = null;
    this.left = false;
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, seen: false };
    this.buildDOM();
    /* Everything below is enhancement — if any of it fails on a locked-down
       browser the page must still be usable, so guard each step. */
    try {
      this.initShader();
    } catch (e) {
      console.warn("[ak] shader init failed:", e);
    }
    try {
      this.initNameEffect();
      this.initMagnetic();
    } catch (e) {
      console.warn("[ak] effects failed:", e);
    }
    try {
      this.applyTheme(this.themeName, true);
    } catch (e) {
      console.warn("[ak] theme failed:", e);
    }
    this.bindExplore();
    this.autoSkipPoll();
  }

  /* If the game reloads its world internally (its "reloading" flag), it
     auto-begins with no splash — step aside instead of covering the game. */
  autoSkipPoll() {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (this.left || document.getElementById("splash-container")) {
        clearInterval(iv); /* normal flow — old splash mounted, we own the screen */
        return;
      }
      if (document.getElementById("game-ui")) {
        clearInterval(iv);
        this.leave(true); /* game already running — get out of the way */
        return;
      }
      if (performance.now() - t0 > 6000) clearInterval(iv);
    }, 120);
  }

  /* ---------- DOM ---------- */
  buildDOM() {
    const el = (tag, attrs = {}, parent = null) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "text") n.textContent = v;
        else if (k === "class") n.className = v;
        else n.setAttribute(k, v);
      }
      if (parent) parent.appendChild(n);
      return n;
    };

    this.root = el("div", { id: "ak-splash" }, document.body);
    this.canvas = el("canvas", { id: "ak-bg" }, this.root);
    el("div", { id: "ak-vignette" }, this.root);
    this.veil = el("div", { id: "ak-veil" }, this.root);

    /* sticky top info bar — lives outside the overlay so it stays in-game */

    /* hero */
    const hero = el("div", { id: "ak-hero" }, this.root);
    el("div", { class: "ak-eyebrow ak-glass ak-in", text: "Immersive 3D Website" }, hero);

    this.nameEl = el("h1", { id: "ak-name", class: "ak-in" }, hero);
    this.nameEl.style.animationDelay = "0.08s";
    for (const word of ["Akshat", "Kumar"]) {
      const w = el("span", { class: "ak-word" }, this.nameEl);
      for (const ch of word) el("span", { class: "ak-ch", text: ch }, w);
    }

    const sub = el("div", { id: "ak-sub", class: "ak-in", text: "Portfolio" }, hero);
    sub.style.animationDelay = "0.16s";

    const tag = el("div", {
      id: "ak-tagline",
      class: "ak-in",
      text: "Step into a living 3D world — drive through my projects, experiments and story, rendered in real time in your browser.",
    }, hero);
    tag.style.animationDelay = "0.24s";

    this.explore = el("button", { id: "ak-explore", class: "ak-glass ak-glow ak-in", type: "button" }, hero);
    this.explore.style.animationDelay = "0.32s";
    el("span", { text: "Explore Portfolio" }, this.explore);
    el("span", { class: "ak-arrow", text: "→" }, this.explore);

    /* theme dock */
    this.dock = el("div", { id: "ak-themes", class: "ak-glass ak-glow ak-in" }, this.root);
    this.dock.style.animationDelay = "0.4s";
    el("span", { class: "ak-themes-label", text: "Atmosphere" }, this.dock);
    this.pills = {};
    for (const name of Object.keys(THEMES)) {
      const b = el("button", { class: "ak-pill", type: "button", text: name }, this.dock);
      b.addEventListener("click", () => this.applyTheme(name));
      this.pills[name] = b;
    }

  }

  /* ---------- shader background ---------- */
  initShader() {
    const t = THEMES[this.themeName];
    try {
      this.shader = new ShaderMount(
        this.canvas,
        warpFragmentShader,
        themeUniforms(t.params),
        undefined,
        themeSpeed(t.params),
        t.params.offset * 10
      );
    } catch (e) {
      /* WebGL2 unavailable → graceful gradient fallback */
      console.warn("Shader background unavailable:", e);
      this.canvas.style.background =
        "radial-gradient(80% 120% at 30% 20%, " + t.accent + "33, #050505 70%)";
    }
  }

  applyTheme(name, instant = false) {
    const t = THEMES[name];
    if (!t) return;
    this.themeName = name;
    store.set(THEME_KEY, name);

    for (const [n, pill] of Object.entries(this.pills))
      pill.classList.toggle("ak-active", n === name);

    const rgb = hexToRgb(t.accent);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ak-accent", t.accent);
    rootStyle.setProperty("--ak-accent-soft", `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`);
    this.trailColor = rgb;

    const swap = () => {
      if (this.shader) {
        this.shader.setUniforms(themeUniforms(t.params));
        this.shader.setSeed(t.params.offset * 10);
        this.shader.setSpeed(themeSpeed(t.params));
      } else {
        this.canvas.style.background =
          "radial-gradient(80% 120% at 30% 20%, " + t.accent + "33, #050505 70%)";
      }
    };

    if (instant || !this.shader) return swap();
    /* brief veil crossfade so the uniform jump feels intentional */
    this.veil.classList.add("ak-active");
    setTimeout(() => {
      swap();
      this.veil.classList.remove("ak-active");
    }, 360);
  }

  /* ---------- mouse-proximity name effect ---------- */
  initNameEffect() {
    this.chars = Array.from(this.nameEl.querySelectorAll(".ak-ch")).map((n) => ({
      n, x: 0, y: 0, cur: 0,
    }));
    const measure = () => {
      for (const c of this.chars) {
        const r = c.n.getBoundingClientRect();
        c.x = r.left + r.width / 2;
        c.y = r.top + r.height / 2;
      }
    };
    measure();
    addEventListener("resize", measure);
    /* re-measure once entrance animation settles */
    setTimeout(measure, 1200);
    this.measureChars = measure;

    document.addEventListener("pointermove", (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.seen = true;
    }, { passive: true });

    /* Reduced motion: soften rather than disable — a cursor-driven hover
       is not the kind of motion that setting is meant to suppress, and
       silently removing it made the effect look broken. */
    const M = reducedMotion ? 0.4 : 1;
    const R = 170;
    const tick = () => {
      if (this.left) return;
      for (const c of this.chars) {
        const d = Math.hypot(this.mouse.x - c.x, this.mouse.y - c.y);
        const target = this.mouse.seen ? Math.max(0, 1 - d / R) : 0;
        c.cur += (target - c.cur) * 0.18;
        if (c.cur > 0.004) {
          const s = c.cur;
          c.n.style.transform = `translateY(${(-14 * s * M).toFixed(2)}px) scale(${(1 + 0.22 * s * M).toFixed(3)})`;
          c.n.style.color = s > 0.25 ? "var(--ak-accent)" : "";
          c.n.style.textShadow = s > 0.1 ? `0 0 ${(24 * s) | 0}px var(--ak-accent-soft)` : "";
        } else if (c.n.style.transform) {
          c.n.style.transform = "";
          c.n.style.color = "";
          c.n.style.textShadow = "";
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- magnetic button + glow-ring tracking ---------- */
  initMagnetic() {
    /* glow ring follows cursor on every .ak-glow surface */
    document.addEventListener("pointermove", (e) => {
      for (const g of document.querySelectorAll(".ak-glow")) {
        const r = g.getBoundingClientRect();
        g.style.setProperty("--mx", `${e.clientX - r.left}px`);
        g.style.setProperty("--my", `${e.clientY - r.top}px`);
      }
    }, { passive: true });

    const btn = this.explore;
    const RANGE = 140, PULL = reducedMotion ? 0.12 : 0.32;
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = null;
    const loop = () => {
      cx += (tx - cx) * 0.16;
      cy += (ty - cy) * 0.16;
      btn.style.translate = `${cx.toFixed(2)}px ${cy.toFixed(2)}px`;
      if (Math.abs(tx - cx) > 0.1 || Math.abs(ty - cy) > 0.1) raf = requestAnimationFrame(loop);
      else raf = null;
    };
    document.addEventListener("pointermove", (e) => {
      if (this.left) return;
      const r = btn.getBoundingClientRect();
      const bx = r.left + r.width / 2, by = r.top + r.height / 2;
      const dx = e.clientX - bx, dy = e.clientY - by;
      const d = Math.hypot(dx, dy);
      if (d < RANGE + Math.max(r.width, r.height) / 2) {
        tx = dx * PULL * Math.max(0, 1 - d / (RANGE * 2.2));
        ty = dy * PULL * Math.max(0, 1 - d / (RANGE * 2.2));
      } else {
        tx = 0; ty = 0;
      }
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
  }


  /* ---------- enter the world ---------- */
  bindExplore() {
    this.explore.addEventListener("click", () => {
      if (this.entering) return;
      this.entering = true;

      const begin = document.getElementById("splash-loader");
      if (begin) begin.click();

      /* show progress on the button instead of freezing */
      const label = this.explore.querySelector("span");
      const baseText = label ? label.textContent : "";
      this.explore.classList.add("ak-busy");

      /* Hold the splash until the engine has actually drawn frames.
         Leaving immediately used to reveal an un-rendered canvas. */
      const t0 = performance.now();
      const ready = () => (window.__akFrames || 0) >= 3;
      const poll = setInterval(() => {
        const pct = document.body.innerText.match(/(\d+)%/);
        if (label) label.textContent = pct ? `Building world ${pct[1]}%` : "Building world…";
        /* leave once the engine is drawing, or bail out after 45s */
        if (ready() || performance.now() - t0 > 45000) {
          clearInterval(poll);
          if (label) label.textContent = baseText;
          this.leave();
          setTimeout(() => document.getElementById("game-main")?.focus(), 700);
        }
      }, 120);
    });
  }

  leave(instant = false) {
    if (this.left) return;
    this.left = true;
    this.root.classList.add("ak-leaving");
    const finish = () => {
      this.root.classList.add("ak-gone");
      /* free the shader's WebGL context so the game gets full GPU budget */
      if (this.shader) {
        this.shader.dispose();
        this.shader = null;
      }
    };
    instant ? finish() : setTimeout(finish, 650);
  }
}

const boot = () => new Splash();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
