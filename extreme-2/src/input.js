// Keyboard + gamepad input. Digital keys are ramped into analogue axes so the
// car does not snap between lock stops; a connected pad takes over the moment
// it reports meaningful deflection.

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
};

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this.actions = new Map();
    this.padIndex = null;
    this.sensitivity = 1;

    // Free look. Accumulated in radians and consumed by the camera rig; the
    // sensitivity sliders scale the raw pointer delta on the way in.
    this.look = { yaw: 0, pitch: 0, active: false, sensH: 0.5, sensV: 0.4, multiplier: 1 };
    this._bindPointer();

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Do not swallow typing in the settings panel.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
        if (e.code === 'Escape') t.blur();
        return;
      }
      this.down.add(e.code);
      const fn = this.actions.get(e.code);
      if (fn) { e.preventDefault(); fn(); }
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
    });

    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());

    window.addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = null; });
  }

  _bindPointer() {
    const canvas = document.getElementById('gl');
    if (!canvas) return;
    let lastX = 0, lastY = 0;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      this.look.active = true;
      lastX = e.clientX; lastY = e.clientY;
      canvas.classList.add('looking');
      canvas.setPointerCapture?.(e.pointerId);
    });

    const end = (e) => {
      this.look.active = false;
      canvas.classList.remove('looking');
      if (e && e.pointerId !== undefined) canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => end());

    canvas.addEventListener('pointermove', (e) => {
      if (!this.look.active) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;

      // The fine-look multiplier rewards slow, deliberate movement: small
      // deltas get the full multiplier, fast flicks get none of it.
      const speed = Math.hypot(dx, dy);
      const fine = 1 + (this.look.multiplier - 1) * Math.max(0, 1 - speed / 26);

      this.look.yaw += dx * 0.0055 * this.look.sensH * 2 * fine;
      this.look.pitch += dy * 0.0045 * this.look.sensV * 2 * fine;
      this.look.pitch = Math.max(-0.55, Math.min(0.85, this.look.pitch));
      while (this.look.yaw > Math.PI) this.look.yaw -= Math.PI * 2;
      while (this.look.yaw < -Math.PI) this.look.yaw += Math.PI * 2;
    });
  }

  // Ease the view back behind the car once the pointer is released.
  decayLook(dt, autoReset) {
    if (this.look.active || !autoReset) return;
    const k = Math.min(1, dt * 2.6);
    this.look.yaw -= this.look.yaw * k;
    this.look.pitch -= this.look.pitch * k;
    if (Math.abs(this.look.yaw) < 1e-4) this.look.yaw = 0;
    if (Math.abs(this.look.pitch) < 1e-4) this.look.pitch = 0;
  }

  resetLook() { this.look.yaw = 0; this.look.pitch = 0; }

  on(code, fn) { this.actions.set(code, fn); return this; }

  any(list) { return list.some((c) => this.down.has(c)); }

  update(dt) {
    const s = this.state;

    let tThrottle = this.any(KEYS.throttle) ? 1 : 0;
    let tBrake = this.any(KEYS.brake) ? 1 : 0;
    let tSteer = (this.any(KEYS.right) ? 1 : 0) - (this.any(KEYS.left) ? 1 : 0);
    let hand = this.any(KEYS.handbrake);

    const pad = this._pad();
    if (pad) {
      const ax = deadzone(pad.axes[0] ?? 0, 0.14);
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      if (Math.abs(ax) > 0) tSteer = ax;
      if (rt > 0.02) tThrottle = rt;
      if (lt > 0.02) tBrake = lt;
      if (pad.buttons[0] && pad.buttons[0].pressed) hand = true;
    }

    // Pedals respond fast, steering deliberately does not.
    const kPedal = Math.min(1, dt * 14);
    s.throttle += (tThrottle - s.throttle) * kPedal;
    s.brake += (tBrake - s.brake) * kPedal;

    const target = Math.max(-1, Math.min(1, tSteer * this.sensitivity));
    const rate = Math.abs(target) > Math.abs(s.steer) ? 5.5 : 8.5; // faster to centre
    s.steer += (target - s.steer) * Math.min(1, dt * rate);
    if (Math.abs(s.steer) < 0.002) s.steer = 0;

    s.handbrake = hand;
    return s;
  }

  _pad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.padIndex !== null && pads[this.padIndex]) return pads[this.padIndex];
    for (const p of pads) if (p && p.connected) { this.padIndex = p.index; return p; }
    return null;
  }
}

function deadzone(v, dz) {
  if (Math.abs(v) < dz) return 0;
  return Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
}
