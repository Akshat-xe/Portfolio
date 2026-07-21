// Interface layer: side navigation, settings panes, live analytics, HUD,
// minimap, toasts, loading and start gates.
//
// Everything is a DOM overlay above the canvas. The per-frame path only ever
// writes textContent and a couple of inline widths — it never reads layout, so
// it cannot force a synchronous reflow in the middle of a render.

import { SECTIONS, SCHEMA } from './settings.js';
import * as Feedback from './feedback.js';

const TACHO_LEN = Math.PI * 88;

const SECTION_SUB = {
  home: 'World generation and atmosphere',
  settings: 'Audio, graphics, camera and gameplay',
  analytics: 'Live telemetry from the physics solver and renderer',
  report: 'Send a report about anything that felt wrong',
};

const KEYMAP = [
  ['Throttle', 'W / ↑'],
  ['Brake · reverse', 'S / ↓'],
  ['Steer', 'A D / ← →'],
  ['Handbrake', 'Space'],
  ['Free look', 'Drag / right-drag'],
  ['Cycle camera', 'C'],
  ['Headlights', 'L'],
  ['Autodrive', 'K'],
  ['Reset to road', 'R'],
  ['Skip ahead 1 km', 'T'],
  ['Toggle HUD', 'H'],
  ['Photo mode', 'P'],
  ['Menu', 'Esc / Tab'],
];

export class UI {
  constructor(settings, hooks) {
    this.settings = settings;
    this.hooks = hooks;
    this.open = false;
    this.section = 'home';
    this.tab = null;

    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      seed: $('hud-seed'), dist: $('hud-dist'), alt: $('hud-alt'),
      surface: $('hud-surface'), drift: $('hud-drift'), driftChip: $('chip-drift'),
      autoChip: $('chip-auto'), auto: $('hud-auto'),
      fps: $('hud-fps'), ms: $('hud-ms'), draws: $('hud-draws'), tris: $('hud-tris'),
      speed: $('speed-val'), speedUnit: $('speed-unit'), gear: $('gear'), rpm: $('rpm-val'),
      tachoFill: $('tacho-fill'), tachoRed: $('tacho-red'),
      minimap: $('minimap'), toast: $('toast'), hint: $('hint'),
      menu: $('menu'), sections: $('menu-sections'), tabs: $('menu-tabs'),
      body: $('menu-body'), status: $('menu-status'),
      title: $('menu-title'), sub: $('menu-sub'),
      loading: $('loading'), loadBar: $('load-bar'), loadMsg: $('load-msg'),
      start: $('start'), startBtn: $('start-btn'), startSeed: $('start-seed'),
      statsGroup: document.querySelector('.hud-tr'),
    };

    this.mm = this.el.minimap.getContext('2d');
    this._last = {};
    this._toastTimer = 0;

    this.el.tachoFill.style.strokeDasharray = TACHO_LEN;
    this.el.tachoFill.style.strokeDashoffset = TACHO_LEN;
    const red = this.el.tachoRed;
    red.setAttribute('d', document.getElementById('tacho-track').getAttribute('d'));
    red.style.strokeDasharray = `${TACHO_LEN * 0.07} ${TACHO_LEN}`;
    red.style.strokeDashoffset = `${-TACHO_LEN * 0.93}`;

    this._buildMenu();
    this._wireChrome();
  }

  click(kind) { this.hooks.playClick?.(kind); }

  // ------------------------------------------------------- loading / start
  setLoading(pct, msg) {
    this.el.loadBar.style.width = Math.round(pct * 100) + '%';
    if (msg) this.el.loadMsg.textContent = msg;
  }

  finishLoading(seed) {
    this.el.loading.classList.add('done');
    this.el.startSeed.textContent = seed;
    this.el.start.hidden = false;
  }

  dismissStart() {
    this.el.start.classList.add('done');
    setTimeout(() => { this.el.start.hidden = true; }, 520);
    setTimeout(() => this.el.hint.classList.add('fade'), 11000);
  }

  toast(msg, ms = 2200) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------------ menu
  toggleMenu(force) {
    this.open = force === undefined ? !this.open : force;
    this.el.menu.hidden = !this.open;
    if (this.open) this._refreshControls();
    this.hooks.onPause?.(this.open);
  }

  _wireChrome() {
    this.el.startBtn.onclick = () => { this.click('confirm'); this.hooks.onStart?.(); };
    document.getElementById('menu-close').onclick = () => { this.click('back'); this.toggleMenu(false); };
    document.getElementById('menu-resume').onclick = () => { this.click('back'); this.toggleMenu(false); };
    document.getElementById('btn-reset-settings').onclick = () => {
      this.click('toggle');
      this.settings.reset();
      this._refreshControls();
      this.status('Defaults restored', 'ok');
    };
    this.el.menu.addEventListener('click', (e) => {
      if (e.target === this.el.menu) { this.click('back'); this.toggleMenu(false); }
    });
  }

  status(msg, kind = '') {
    this.el.status.textContent = msg;
    this.el.status.className = kind;
    if (msg) setTimeout(() => {
      if (this.el.status.textContent === msg) { this.el.status.textContent = ''; this.el.status.className = ''; }
    }, 4500);
  }

  _buildMenu() {
    this.panes = new Map();     // "section/tab" -> element
    this.controls = new Map();
    this.sectionTabs = new Map();

    for (const s of SECTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.role = 'tab';
      btn.setAttribute('aria-selected', s.id === this.section ? 'true' : 'false');
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-${s.icon}"/></svg><span>${s.label}</span>`;
      btn.onclick = () => { this.click('tap'); this.selectSection(s.id); };
      this.el.sections.appendChild(btn);
      this.sectionTabs.set(s.id, { btn, tabs: [] });
    }

    for (const entry of SCHEMA) {
      const pane = document.createElement('div');
      pane.hidden = true;
      if (entry.custom === 'controls') this._buildControlsPane(pane);
      else if (entry.custom === 'feedback') this._buildFeedbackPane(pane);
      else if (entry.custom === 'analytics') this._buildAnalyticsPane(pane);
      else this._buildFieldPane(pane, entry);
      this.el.body.appendChild(pane);
      this.panes.set(entry.section + '/' + entry.tab, pane);
      this.sectionTabs.get(entry.section).tabs.push(entry.tab);
    }

    this.selectSection('home');
  }

  selectSection(id) {
    this.section = id;
    const meta = SECTIONS.find((s) => s.id === id);
    this.el.title.textContent = meta.label;
    this.el.sub.textContent = SECTION_SUB[id] || '';

    for (const [sid, rec] of this.sectionTabs) {
      rec.btn.setAttribute('aria-selected', sid === id ? 'true' : 'false');
    }

    const tabs = this.sectionTabs.get(id).tabs;
    this.el.tabs.innerHTML = '';
    this.el.tabs.hidden = tabs.length < 2;
    if (tabs.length >= 2) {
      for (const t of tabs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.role = 'tab';
        b.textContent = t.toUpperCase();
        b.onclick = () => { this.click('tap'); this.selectTab(t); };
        this.el.tabs.appendChild(b);
      }
    }
    this.selectTab(tabs[0]);
  }

  selectTab(name) {
    this.tab = name;
    for (const [key, pane] of this.panes) {
      pane.hidden = key !== this.section + '/' + name;
    }
    for (const b of this.el.tabs.children) {
      b.setAttribute('aria-selected', b.textContent === name.toUpperCase() ? 'true' : 'false');
    }
    this.el.body.scrollTop = 0;
  }

  _buildFieldPane(pane, entry) {
    for (const group of entry.groups) {
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = group.title;
      pane.appendChild(h);
      for (const f of group.fields) pane.appendChild(this._buildField(f));
    }
  }

  _buildField(f) {
    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('div');
    label.className = 'field-label';
    label.textContent = f.label;
    if (f.hint) {
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      hint.textContent = f.hint;
      label.appendChild(hint);
    }
    row.appendChild(label);

    const wrap = document.createElement('div');
    wrap.className = 'field-control';
    const s = this.settings;

    if (f.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = f.min; input.max = f.max; input.step = f.step;
      input.value = s.get(f.key);
      const val = document.createElement('span');
      val.className = 'field-value';
      const fmt = f.format || ((v) => (f.step < 1 ? v.toFixed(2) : String(v)));
      val.textContent = fmt(+input.value);
      input.oninput = () => { const v = +input.value; val.textContent = fmt(v); s.set(f.key, v); };
      input.onchange = () => this.click('tap');
      wrap.append(input, val);
      this.controls.set(f.key, { sync: () => { input.value = s.get(f.key); val.textContent = fmt(+input.value); } });

    } else if (f.type === 'toggle') {
      const sw = document.createElement('label');
      sw.className = 'switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!s.get(f.key);
      input.setAttribute('aria-label', f.label);
      const track = document.createElement('span');
      sw.append(input, track);
      input.onchange = () => { this.click('toggle'); s.set(f.key, input.checked); };
      wrap.appendChild(sw);
      this.controls.set(f.key, { sync: () => { input.checked = !!s.get(f.key); } });

    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', f.label);
      for (const [v, t] of f.options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      }
      sel.value = String(s.get(f.key));
      sel.onchange = () => { this.click('tap'); s.set(f.key, sel.value); };
      wrap.appendChild(sel);
      this.controls.set(f.key, { sync: () => { sel.value = String(s.get(f.key)); } });

    } else if (f.type === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = s.get(f.key);
      input.setAttribute('aria-label', f.label);
      input.oninput = () => s.set(f.key, input.value);
      wrap.appendChild(input);
      this.controls.set(f.key, { sync: () => { input.value = s.get(f.key); } });

    } else if (f.type === 'text') {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = s.get(f.key);
      input.setAttribute('aria-label', f.label);
      input.onchange = () => s.set(f.key, input.value.trim() || 'akshat');
      wrap.appendChild(input);
      this.controls.set(f.key, { sync: () => { input.value = s.get(f.key); } });

    } else if (f.type === 'action') {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.type = 'button';
      btn.textContent = f.label;
      btn.onclick = () => { this.click('confirm'); this.hooks.onAction?.(f.action); };
      wrap.appendChild(btn);
    }

    row.appendChild(wrap);
    return row;
  }

  _buildControlsPane(pane) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Keyboard and gamepad are both live. A connected pad uses the left stick to steer, the triggers as pedals and A/cross for the handbrake.';
    pane.appendChild(p);

    const grid = document.createElement('div');
    grid.className = 'keymap';
    for (const [action, key] of KEYMAP) {
      const row = document.createElement('div');
      const a = document.createElement('span');
      a.textContent = action;
      const k = document.createElement('kbd');
      k.textContent = key;
      row.append(a, k);
      grid.appendChild(row);
    }
    pane.appendChild(grid);
  }

  // ------------------------------------------------------------- analytics
  _buildAnalyticsPane(pane) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'Live readouts straight off the solver and renderer. Tyre saturation is how much of each tyre’s friction circle is spent; suspension is strut compression against total travel.';
    pane.appendChild(note);

    const cards = document.createElement('div');
    cards.className = 'telemetry';
    this.tele = {};
    const CARDS = [
      ['speed', 'SPEED', 'km/h'], ['rpm', 'ENGINE', 'rpm'], ['gear', 'GEAR', ''],
      ['drift', 'DRIFT', '°'], ['dist', 'DISTANCE', 'km'], ['alt', 'ALTITUDE', 'm'],
      ['fps', 'FRAME RATE', 'fps'], ['ms', 'FRAME TIME', 'ms'],
      ['draws', 'DRAW CALLS', ''], ['tris', 'TRIANGLES', ''],
      ['grass', 'GRASS BLADES', ''], ['trees', 'SCENERY', ''],
    ];
    for (const [id, label, unit] of CARDS) {
      const c = document.createElement('div');
      c.className = 'tele-card';
      c.innerHTML = `<div class="k">${label}</div><div class="v"><span data-v></span>${unit ? `<span class="u">${unit}</span>` : ''}</div>`;
      cards.appendChild(c);
      this.tele[id] = c.querySelector('[data-v]');
    }
    pane.appendChild(cards);

    const mk = (title, rows, store) => {
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = title;
      pane.appendChild(h);
      const wrap = document.createElement('div');
      wrap.className = 'bars';
      wrap.style.marginTop = '12px';
      for (const [id, label] of rows) {
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `<span>${label}</span><span class="track"><i class="fill"></i></span><span class="num"></span>`;
        wrap.appendChild(row);
        store[id] = { fill: row.querySelector('.fill'), num: row.querySelector('.num') };
      }
      pane.appendChild(wrap);
    };

    this.bars = {};
    mk('Tyre saturation', [
      ['satFL', 'Front left'], ['satFR', 'Front right'],
      ['satRL', 'Rear left'], ['satRR', 'Rear right'],
    ], this.bars);
    mk('Suspension travel', [
      ['comFL', 'Front left'], ['comFR', 'Front right'],
      ['comRL', 'Rear left'], ['comRR', 'Rear right'],
    ], this.bars);
  }

  updateTelemetry(t) {
    if (!this.open || this.section !== 'analytics' || !this.tele) return;
    const set = (id, v) => { if (this.tele[id]) this.tele[id].textContent = v; };
    set('speed', Math.round(t.speedKmh));
    set('rpm', Math.round(t.rpm));
    set('gear', t.gear);
    set('drift', (t.driftAngle * 180 / Math.PI).toFixed(1));
    set('dist', (t.odometer / 1000).toFixed(2));
    set('alt', Math.round(t.altitude));
    set('fps', Math.round(t.fps));
    set('ms', t.frameMs.toFixed(1));
    set('draws', t.draws);
    set('tris', formatCount(t.tris));
    set('grass', t.grassBlades);
    set('trees', t.sceneryCount);

    const bar = (id, frac) => {
      const b = this.bars[id];
      if (!b) return;
      const f = Math.max(0, Math.min(1, frac));
      b.fill.style.width = (f * 100).toFixed(1) + '%';
      b.fill.className = 'fill' + (f > 0.985 ? ' hot' : f > 0.8 ? ' warn' : '');
      b.num.textContent = (f * 100).toFixed(0) + '%';
    };
    const names = ['FL', 'FR', 'RL', 'RR'];
    for (let i = 0; i < 4; i++) {
      bar('sat' + names[i], t.tyre[i].sat);
      bar('com' + names[i], t.compression[i] / t.maxTravel);
    }
  }

  // -------------------------------------------------------------- feedback
  _buildFeedbackPane(pane) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      'Reports are stored in this browser. They are transmitted nowhere unless you supply a collection endpoint below, and even then only when you press Send.';
    pane.appendChild(note);

    const mk = (labelText, control, hint) => {
      const row = document.createElement('div');
      row.className = 'field';
      const l = document.createElement('div');
      l.className = 'field-label';
      l.textContent = labelText;
      if (hint) {
        const h = document.createElement('span');
        h.className = 'field-hint';
        h.textContent = hint;
        l.appendChild(h);
      }
      const w = document.createElement('div');
      w.className = 'field-control';
      w.appendChild(control);
      row.append(l, w);
      pane.appendChild(row);
      return control;
    };

    const cat = document.createElement('select');
    for (const [v, t] of [['bug', 'Bug'], ['performance', 'Performance'], ['handling', 'Handling / feel'],
      ['audio', 'Audio'], ['worldgen', 'World generation'], ['accessibility', 'Accessibility'], ['idea', 'Idea']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      cat.appendChild(o);
    }
    mk('Category', cat);

    const contact = document.createElement('input');
    contact.type = 'email';
    contact.placeholder = 'optional';
    mk('Contact', contact, 'Only included if you fill it in.');

    const endpoint = document.createElement('input');
    endpoint.type = 'text';
    endpoint.placeholder = 'Formspree form ID, or any https:// URL';
    endpoint.value = this.settings.get('feedbackEndpoint') || '';
    endpoint.onchange = () => this.settings.set('feedbackEndpoint', endpoint.value.trim());
    mk('Collection endpoint', endpoint,
      'A bare Formspree form ID (e.g. mzbqwxyz) is expanded to its endpoint automatically. Blank means nothing is ever sent.');

    const msg = document.createElement('textarea');
    msg.placeholder = 'What happened, and what did you expect instead?';
    const msgRow = document.createElement('div');
    msgRow.style.padding = '14px 0';
    msgRow.appendChild(msg);
    pane.appendChild(msgRow);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.style.justifyContent = 'flex-end';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'ghost';
    exportBtn.textContent = 'Export saved';
    exportBtn.onclick = () => {
      this.click('tap');
      if (!Feedback.readQueue().length) return this.status('Nothing saved yet', 'bad');
      Feedback.exportQueue();
      this.status('Exported', 'ok');
    };

    const clearBtn = document.createElement('button');
    clearBtn.className = 'ghost';
    clearBtn.textContent = 'Clear saved';
    clearBtn.onclick = () => { this.click('tap'); Feedback.clearQueue(); this.status('Local reports cleared', 'ok'); };

    const send = document.createElement('button');
    send.className = 'primary';
    send.textContent = 'Send';
    send.onclick = async () => {
      const text = msg.value.trim();
      if (text.length < 4) { this.click('back'); return this.status('Please describe the issue first', 'bad'); }
      this.click('confirm');
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        const report = Feedback.buildReport(
          { category: cat.value, message: text, contact: contact.value.trim() },
          this.hooks.getDiagnostics()
        );
        const res = await Feedback.submit(report, (this.settings.get('feedbackEndpoint') || '').trim());
        msg.value = '';
        this.status(res.delivered ? 'Sent — thank you' : `Saved locally (${res.queued} queued)`, 'ok');
      } catch (err) {
        this.status('Send failed: ' + err.message, 'bad');
      } finally {
        send.disabled = false;
        send.textContent = 'Send';
      }
    };

    actions.append(exportBtn, clearBtn, send);
    pane.appendChild(actions);
  }

  _refreshControls() {
    for (const { sync } of this.controls.values()) sync();
  }

  // ------------------------------------------------------------------- HUD
  setHudVisible(on) { this.el.hud.classList.toggle('hidden', !on); }
  setStatsVisible(on) { this.el.statsGroup.style.display = on ? '' : 'none'; }
  setAutodrive(on) {
    this.el.autoChip.hidden = !on;
    if (on) this.el.auto.textContent = 'ON';
  }

  update(state) {
    const set = (el, key, value) => {
      if (this._last[key] === value) return;
      this._last[key] = value;
      el.textContent = value;
    };

    const mph = this.settings.get('units') === 'mph';
    set(this.el.speed, 'speed', String(Math.round(state.speedKmh * (mph ? 0.621371 : 1))));
    set(this.el.speedUnit, 'unit', mph ? 'mph' : 'km/h');
    set(this.el.gear, 'gear', state.gear);
    set(this.el.rpm, 'rpm', Math.round(state.rpm) + ' rpm');
    set(this.el.seed, 'seed', state.seed);
    set(this.el.dist, 'dist', (state.odometer / 1000).toFixed(2) + ' km');
    set(this.el.alt, 'alt', Math.round(state.altitude) + ' m');
    set(this.el.surface, 'surf', state.surface);
    set(this.el.fps, 'fps', String(Math.round(state.fps)));
    set(this.el.ms, 'ms', state.frameMs.toFixed(1) + ' ms');
    set(this.el.draws, 'draws', String(state.draws));
    set(this.el.tris, 'tris', formatCount(state.tris));

    const deg = Math.round(state.driftAngle * 180 / Math.PI);
    set(this.el.drift, 'drift', (deg > 0 ? '+' : '') + deg + '°');
    const hot = Math.abs(deg) > 8;
    if (this._last.driftHot !== hot) {
      this._last.driftHot = hot;
      this.el.driftChip.style.color = hot ? 'var(--accent)' : '';
    }

    this.el.tachoFill.style.strokeDashoffset = String(TACHO_LEN * (1 - Math.min(1, state.rpm / 7400)));
    this._drawMinimap(state);
  }

  _drawMinimap(state) {
    const ctx = this.mm;
    const W = 220, R = 104, cx = 110, cy = 110;
    ctx.clearRect(0, 0, W, W);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, W, W);

    const pts = state.routePoints;
    if (pts && pts.length >= 4) {
      const scale = R / 420;
      const s = Math.sin(state.yaw), c = Math.cos(state.yaw);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const dx = pts[i] - state.x;
        const dz = pts[i + 1] - state.z;
        const rx = dx * c - dz * s;
        const rz = dx * s + dz * c;
        const px = cx + rx * scale;
        const py = cy - rz * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.20)';
      ctx.lineWidth = 9; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,138,31,0.85)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx + 5.5, cy + 6);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx - 5.5, cy + 6);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    const na = -state.yaw;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx + Math.sin(na) * (R - 12), cy - Math.cos(na) * (R - 12));
  }
}

function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
}
