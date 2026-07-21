/* ============================================================
   AKSHAT PORTFOLIO — fullscreen settings (Wuthering Waves style)
   Left icon rail, section headers, label-left / control-right rows,
   sliders with 0-100 readouts, arrow selectors.
   Opens with the gear button or ESC; pauses the game while open.
   Every control is wired to window.__akGame (real engine state).
   ============================================================ */

import Hud, { METRICS } from "./hud.js";

const ICONS = {
  sounds:
    '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  graphics:
    '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="m3 14 4-4 3 3 4-5 7 7"/>',
  gameplay:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  controls:
    '<rect x="2" y="7" width="20" height="11" rx="4"/><path d="M7 12h3M8.5 10.5v3"/><circle cx="16" cy="11.5" r="1"/><circle cx="18.5" cy="14" r="1"/>',
  other:
    '<path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l2-2-3-3z"/>',
  lock:
    '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  perf:
    '<path d="M3 17.5 9 11l4 4 8-8.5"/><path d="M21 6.5V12M21 6.5h-5.5"/><path d="M3 21h18"/>',
};

const CONTROLS = [
  ["Combat and Exploration", null],
  ["Drive forward", "W"],
  ["Brake / reverse", "S"],
  ["Steer left", "A"],
  ["Steer right", "D"],
  ["Boost (hold)", "Shift"],
  ["Boost (double-tap)", "W W"],
  ["Handbrake", "Space"],
  ["Interface", null],
  ["Respawn to centre", "R"],
  ["Change camera", "C"],
  ["Toggle autodrive", "F"],
  ["Headlights", "H"],
  ["Open / close settings", "Esc"],
];

const el = (tag, attrs = {}, parent = null) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  if (parent) parent.appendChild(n);
  return n;
};
const svg = (paths) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  paths +
  "</svg>";

class Settings {
  constructor() {
    this.open = false;
    this.tab = "graphics";
    this.wasPaused = false;
    this.build();
    this.bind();
  }
  get api() {
    return window.__akGame || null;
  }

  /* ---------- shell ---------- */
  build() {
    this.btn = el(
      "button",
      { id: "ak-settings-btn", type: "button", "aria-label": "Settings", title: "Settings (Esc)" },
      document.body
    );
    this.btn.innerHTML = svg(
      '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.4.64.74.83H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    );

    this.root = el("div", { id: "ak-set-root" }, document.body);

    /* header */
    const top = el("div", { class: "ak-set-topbar" }, this.root);
    this.crumb = el("div", { class: "ak-set-crumb" }, top);
    this.crumbIcon = el("span", { class: "ak-set-crumb-ico" }, this.crumb);
    this.crumbText = el("span", { class: "ak-set-crumb-txt", text: "Graphics" }, this.crumb);
    const topRight = el("div", { class: "ak-set-topright" }, top);
    this.closeBtn = el("button", { class: "ak-set-x", type: "button", "aria-label": "Close" }, topRight);
    this.closeBtn.innerHTML = svg('<path d="M6 6l12 12M18 6L6 18"/>');

    /* rail */
    this.rail = el("nav", { class: "ak-set-rail", "aria-label": "Settings categories" }, this.root);
    this.tabs = {};
    [
      ["sounds", "Sounds"],
      ["graphics", "Graphics"],
      ["perf", "Performance"],
      ["gameplay", "Gameplay"],
      ["controls", "Controls"],
      ["other", "Other"],
    ].forEach(([id, label]) => {
      const b = el("button", { class: "ak-rail-btn", type: "button", title: label, "aria-label": label }, this.rail);
      b.innerHTML = svg(ICONS[id]);
      b.addEventListener("click", () => this.setTab(id));
      this.tabs[id] = { btn: b, label };
    });

    this.panel = el("div", { class: "ak-set-panel" }, this.root);
    this.body = el("div", { class: "ak-set-scroll" }, this.panel);

    const foot = el("div", { class: "ak-set-foot" }, this.root);
    this.status = el("div", { class: "ak-set-status" }, foot);
    const acts = el("div", { class: "ak-set-acts" }, foot);
    this.defaultsBtn = el("button", { class: "ak-btn", type: "button", text: "Recommended" }, acts);
    this.respawnBtn = el("button", { class: "ak-btn", type: "button", text: "Respawn" }, acts);
    this.applyBtn = el("button", { class: "ak-btn ak-btn-primary", type: "button", text: "Apply" }, acts);
  }

  /* ---------- row builders ---------- */
  header(title, icon) {
    const h = el("div", { class: "ak-head" }, this.body);
    el("span", { class: "ak-head-ico", html: svg(ICONS[icon] || ICONS.other) }, h);
    el("span", { text: title }, h);
    return h;
  }

  row(label, keyHint) {
    const r = el("div", { class: "ak-row", tabindex: "0" }, this.body);
    const lab = el("div", { class: "ak-row-label" }, r);
    el("span", { text: label }, lab);
    /* faded, non-interactive hint showing the key bound to this action */
    if (keyHint) {
      const h = el("span", { class: "ak-keyhint", title: "Shortcut key" }, lab);
      el("span", { class: "ak-keyhint-ico", html: svg(ICONS.lock) }, h);
      el("span", { text: keyHint }, h);
    }
    const c = el("div", { class: "ak-row-ctrl" }, r);
    return c;
  }

  /* arrow selector: ◀  Value  ▶ */
  selector(label, options, index, onChange, help, keyHint) {
    const c = this.row(label, keyHint);
    let i = Math.max(0, index);
    const left = el("button", { class: "ak-arrow", type: "button", "aria-label": "Previous" }, c);
    left.innerHTML = svg('<path d="M14 6l-6 6 6 6"/>');
    const val = el("div", { class: "ak-selval", text: String(options[i]) }, c);
    const right = el("button", { class: "ak-arrow", type: "button", "aria-label": "Next" }, c);
    right.innerHTML = svg('<path d="M10 6l6 6-6 6"/>');
    const sync = () => {
      val.textContent = String(options[i]);
      left.classList.toggle("ak-dim", i <= 0);
      right.classList.toggle("ak-dim", i >= options.length - 1);
    };
    const step = (d) => {
      const n = Math.min(options.length - 1, Math.max(0, i + d));
      if (n === i) return;
      i = n;
      sync();
      onChange(i, options[i]);
      this.dirty();
    };
    left.addEventListener("click", () => step(-1));
    right.addEventListener("click", () => step(1));
    sync();
    if (help) el("span", { class: "ak-help", title: help, text: "?" }, c);
    return { set: (n) => ((i = n), sync()) };
  }

  /* slider 0..100 with numeric readout */
  slider(label, value01, onChange) {
    const c = this.row(label);
    const s = el(
      "input",
      { class: "ak-range", type: "range", min: "0", max: "100", step: "1", value: String(Math.round(value01 * 100)) },
      c
    );
    const v = el("div", { class: "ak-rangeval", text: String(Math.round(value01 * 100)) }, c);
    const paint = () => {
      s.style.setProperty("--pct", s.value + "%");
      v.textContent = s.value;
    };
    paint();
    s.addEventListener("input", () => {
      paint();
      onChange(parseInt(s.value, 10) / 100);
      this.dirty();
    });
    return s;
  }

  /* ---------- tabs ---------- */
  setTab(id) {
    this.tab = id;
    Object.entries(this.tabs).forEach(([k, t]) => t.btn.classList.toggle("ak-on", k === id));
    this.crumbText.textContent = this.tabs[id].label;
    this.crumbIcon.innerHTML = svg(ICONS[id]);
    this.render();
  }

  render() {
    const api = this.api;
    this.body.innerHTML = "";
    this.body.scrollTop = 0;
    if (!api) {
      el("div", { class: "ak-empty", text: "World still loading — settings will be available in a moment." }, this.body);
      return;
    }
    const g = api.get();
    const o = api.options;
    this[
      {
        sounds: "renderSounds",
        graphics: "renderGraphics",
        perf: "renderPerf",
        gameplay: "renderGameplay",
        controls: "renderControls",
        other: "renderOther",
      }[this.tab]
    ](g, o, api);
    this.setStatus("");
  }

  renderSounds(g, o, api) {
    this.header("Volume", "sounds");
    this.slider("Master Volume", g.master, (v) => api.setMaster(v));
    this.slider("Vehicle Volume", g.vehicleVol, (v) => api.setBus("vehicle", v));
    this.slider("Ambient Volume", g.ambient, (v) => api.setBus("ambient", v));
    this.slider("Interface Volume", g.ui, (v) => api.setBus("ui", v));
    this.selector(
      "Mute when Game is in the Background",
      o.onOff,
      g.muteOnBlur ? 0 : 1,
      (i) => api.setMuteOnBlur(i === 0),
      "Silences all audio when you switch to another tab or window."
    );
  }

  renderGraphics(g, o, api) {
    this.header("Basic", "graphics");
    this.selector(
      "View Distance",
      o.viewDist,
      g.viewDist,
      (i) => (this.pendingViewDist = i),
      "How far terrain and scenery are drawn before being culled. Higher costs more GPU."
    );
    this.selector(
      "Level of Detail (LOD)",
      o.lod,
      g.lod,
      (i) => (this.pendingLod = i),
      "Density of grass and foliage, plus shadow map resolution. Lower swaps to simpler detail sooner."
    );
    this.selector(
      "Render Scale",
      o.renderScale,
      g.renderScale,
      (i) => api.setRenderScale(i),
      "Renders the scene at a fraction of your screen resolution, then upscales. Below 1.0 is faster but softer."
    );
    el(
      "p",
      {
        class: "ak-note",
        text: "View Distance and Level of Detail rebuild the world, so they are applied when you press Apply.",
      },
      this.body
    );
  }

  /* toggle switch row used by the Performance tab
     (named switchRow, NOT toggle — `toggle()` is the open/close method) */
  switchRow(parent, label, on, onChange, note) {
    const r = el("div", { class: "ak-row ak-row-compact", tabindex: "0" }, parent || this.body);
    const lab = el("div", { class: "ak-row-label" }, r);
    el("span", { text: label }, lab);
    if (note) el("span", { class: "ak-sublabel", text: note }, lab);
    const c = el("div", { class: "ak-row-ctrl ak-row-ctrl-narrow" }, r);
    const sw = el("button", { class: "ak-switch" + (on ? " ak-on" : ""), type: "button", role: "switch", "aria-checked": on ? "true" : "false" }, c);
    el("span", { class: "ak-switch-knob" }, sw);
    sw.addEventListener("click", () => {
      const next = !sw.classList.contains("ak-on");
      sw.classList.toggle("ak-on", next);
      sw.setAttribute("aria-checked", next ? "true" : "false");
      onChange(next);
    });
    return sw;
  }

  renderPerf(g, o, api) {
    const hud = window.__akHud;

    this.header("Frame rate", "perf");
    /* rAF is vsynced to the display, so a cap can only ever go BELOW refresh. */
    const caps = ["Off (display refresh)", "30", "60", "120"];
    const capVals = [0, 30, 60, 120];
    const curCap = capVals.indexOf(api.getFpsCap ? api.getFpsCap() : 0);
    this.selector(
      "V-Sync / Frame Cap",
      caps,
      curCap < 0 ? 0 : curCap,
      (i) => api.setFpsCap && api.setFpsCap(capVals[i]),
      "Browsers sync frames to your display, so a cap can only limit below your refresh rate — it can never exceed it. 'Off' runs at your monitor's full rate."
    );

    if (!hud) {
      el("div", { class: "ak-empty", text: "Performance HUD is still starting up." }, this.body);
      return;
    }

    /* group the metric toggles exactly as declared in hud.js */
    const groups = {};
    for (const id in METRICS) {
      const m = METRICS[id];
      (groups[m.group] = groups[m.group] || []).push([id, m]);
    }
    const first = true;
    for (const gname in groups) {
      this.header(gname === "Framerate" ? "On-screen display" : gname, "perf");
      for (const [id, m] of groups[gname]) {
        const probe = this.probeMetric(id, m);
        this.switchRow(
          this.body,
          m.label === "FPS" ? "FPS" : m.label + (probe ? "" : ""),
          hud.isOn(id),
          (on) => hud.set(id, on),
          probe ? null : "Not available in this browser"
        );
        if (!probe) {
          const rows = this.body.querySelectorAll(".ak-row");
          rows[rows.length - 1].classList.add("ak-row-na");
        }
      }
    }

    el(
      "p",
      {
        class: "ak-note",
        text:
          "Only metrics a browser can genuinely measure are listed. CPU/GPU temperature, wattage and utilisation are deliberately absent — no web API exposes them, so any such readout would be invented.",
      },
      this.body
    );
  }

  /* returns false when a metric has no data source on this browser */
  probeMetric(id, m) {
    try {
      const ctx = {
        fps: 60,
        frameMs: 16,
        low1: 55,
        gpu: window.__akHud && window.__akHud.gpu,
        pressure: window.__akHud && window.__akHud.pressure,
        battery: window.__akHud && window.__akHud.battery,
        uptime: 1,
        render: window.__akGame && window.__akGame.renderStats ? window.__akGame.renderStats() : null,
      };
      return !!m.get(ctx);
    } catch (e) {
      return false;
    }
  }

  renderGameplay(g, o, api) {
    this.header("World", "gameplay");
    this.selector("Time of Day", o.time, g.time, (i) => api.setTime(i));
    this.selector("Vehicle", o.vehicle, Math.max(0, o.vehicle.indexOf(g.vehicle)), (i, v) => api.setVehicle(v));
    this.header("Driving", "gameplay");
    this.selector(
      "Autodrive",
      o.onOff,
      g.autodrive ? 0 : 1,
      (i) => api.setAutodrive(i === 0),
      null,
      "F"
    );
    this.selector(
      "Double-tap to Boost",
      o.onOff,
      g.doubleTap === 0 ? 0 : 1,
      (i) => api.setDoubleTap(i),
      "Tap W twice quickly for a burst of acceleration.",
      "W W"
    );
    this.selector("Units", o.units, g.units, (i) => api.setUnits(i));
    this.selector(
      "Pause when Inactive",
      o.onOff,
      g.autoPause === 0 ? 0 : 1,
      (i) => api.setAutoPause(i),
      "Pauses the world when the window loses focus."
    );
    const c = this.row("Camera", "C");
    const b = el("button", { class: "ak-btn ak-btn-inline", type: "button", text: "Change" }, c);
    b.addEventListener("click", () => api.cycleCamera());
  }

  renderControls() {
    /* explain up-front why nothing here is editable */
    const banner = el("div", { class: "ak-banner" }, this.body);
    el("span", { class: "ak-banner-ico", html: svg(ICONS.lock) }, banner);
    el(
      "span",
      { text: "Key bindings are fixed for this experience — the lock icon marks keys that cannot be reassigned." },
      banner
    );
    CONTROLS.forEach(([label, key]) => {
      if (key === null) return this.header(label, "controls");
      const c = this.row(label);
      const wrap = el("div", { class: "ak-kbd-wrap" }, c);
      el("span", { class: "ak-kbd-lock", html: svg(ICONS.lock), title: "Fixed binding" }, wrap);
      el("kbd", { class: "ak-kbd", text: key }, wrap);
    });
  }

  renderOther(g, o, api) {
    this.header("World", "other");
    const c = this.row("Return to the centre of the arena");
    const b = el("button", { class: "ak-btn ak-btn-inline", type: "button", text: "Respawn" }, c);
    b.addEventListener("click", () => {
      this.hide();
      api.respawn();
    });

    this.header("Contact", "other");
    el("p", { class: "ak-note", text: "Question, opportunity, or just saying hello? This comes straight to me." }, this.body);
    const form = el("form", { class: "ak-form", id: "ak-contact-form" }, this.body);
    const email = el("input", { class: "ak-input", type: "email", name: "email", placeholder: "Your email (optional)", autocomplete: "email" }, form);
    const msg = el("textarea", { class: "ak-input ak-textarea", name: "message", rows: "4", maxlength: "500", placeholder: "Your message", required: "required" }, form);
    const row = el("div", { class: "ak-form-row" }, form);
    const note = el("span", { class: "ak-form-note" }, row);
    const send = el("button", { class: "ak-btn", type: "submit", text: "Send" }, row);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!msg.value.trim()) return;
      send.disabled = true;
      note.className = "ak-form-note";
      note.textContent = "Sending…";
      try {
        const res = await fetch("https://formspree.io/f/xykrwbrb", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            message: msg.value.trim(),
            email: email.value.trim() || undefined,
            _replyto: email.value.trim() || undefined,
            _subject: "Portfolio — new message",
            page: location.href,
          }),
        });
        if (!res.ok) throw new Error(res.status);
        note.className = "ak-form-note ak-ok";
        note.textContent = "Thanks — message sent.";
        email.value = "";
        msg.value = "";
      } catch (err) {
        note.className = "ak-form-note ak-bad";
        note.textContent = "Couldn’t send. Try again shortly.";
      } finally {
        send.disabled = false;
      }
    });
  }

  /* ---------- status / apply ---------- */
  dirty() {
    if (this.pendingViewDist !== undefined || this.pendingLod !== undefined)
      this.setStatus("Press Apply to rebuild the world", "warn");
    else this.setStatus("Applied", "ok");
  }
  setStatus(t, c = "") {
    this.status.textContent = t;
    this.status.className = "ak-set-status " + c;
  }

  apply() {
    const api = this.api;
    if (!api) return;
    const needsRebuild = this.pendingViewDist !== undefined || this.pendingLod !== undefined;
    if (needsRebuild) {
      /* The rebuild runs on the game ticker — it must be resumed, or the
         world silently never regenerates. Close first, then resume, then set. */
      this.hide();
      api.resume();
      const vd = this.pendingViewDist, lod = this.pendingLod;
      this.pendingViewDist = this.pendingLod = undefined;
      setTimeout(() => {
        /* one atomic call — setting them separately made the second one get
           dropped, because a rebuild was already in flight */
        if (api.setGraphics) api.setGraphics(vd, lod);
        else {
          if (lod !== undefined) api.setLod(lod);
          if (vd !== undefined) api.setViewDist(vd);
        }
      }, 60);
      return;
    }
    this.setStatus("Applied", "ok");
  }

  applyRecommended() {
    const api = this.api;
    if (!api) return;
    api.setRenderScale(2);
    api.setMaster(0.5);
    api.setBus("ambient", 1);
    api.setBus("vehicle", 1);
    api.setBus("ui", 1);
    this.pendingViewDist = 1;
    this.pendingLod = 2;
    this.render();
    this.setStatus("Press Apply to rebuild the world", "warn");
  }

  /* ---------- open / close ---------- */
  show() {
    if (this.open) return;
    this.open = true;
    const api = this.api;
    this.wasPaused = api ? api.isPaused() : false;
    if (api) api.pause();
    this.root.classList.add("ak-on");
    document.body.classList.add("ak-settings-open");
    window.__akLockKeys && window.__akLockKeys(true);
    this.setTab(this.tab);
  }
  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("ak-on");
    document.body.classList.remove("ak-settings-open");
    window.__akLockKeys && window.__akLockKeys(false);
    const api = this.api;
    if (api && !this.wasPaused) api.resume();
  }
  toggle() {
    this.open ? this.hide() : this.show();
  }

  bind() {
    this.btn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.hide());
    this.applyBtn.addEventListener("click", () => this.apply());
    this.respawnBtn.addEventListener("click", () => {
      this.hide();
      this.api && this.api.respawn();
    });
    this.defaultsBtn.addEventListener("click", () => this.applyRecommended());
    addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) {
          t.blur();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      },
      true
    );
  }
}

function mount() {
  if (window.__akSettings) return;
  if (!window.__akHud) window.__akHud = new Hud();
  window.__akSettings = new Settings();
}
const poll = setInterval(() => {
  if (document.getElementById("game-ui")) {
    mount();
    clearInterval(poll);
  }
}, 200);

export default mount;
