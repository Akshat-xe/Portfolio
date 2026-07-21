// Autodrive.
//
// Feeds steering, throttle and brake straight back into the physics controller
// from the road's own routing data — the same midline and curvature the router
// produced when it carved the road. It does not cheat: it drives through the
// normal input struct, so the tyre model, the barriers and the drift system all
// apply exactly as they do for a human.
//
// This started life as the harness used to regression-test the solver over long
// distances, which is why it is tuned to hold a line rather than to be quick.

const LOOKAHEAD = 22;     // metres ahead for the heading target
const SCAN_START = 25;    // corner-speed scan window
const SCAN_END = 130;
const SCAN_STEP = 15;

export class Autodrive {
  constructor(road, vehicle) {
    this.road = road;
    this.vehicle = vehicle;
    this.enabled = false;
    this.targetSpeed = 78;      // km/h ceiling on open road
    this.corneringG = 0.75;     // fraction of available grip spent on corners
    this.lastCap = 0;
  }

  // Mutates and returns the same input object the human controls populate.
  apply(input) {
    const v = this.vehicle;
    const road = this.road;
    const q = road.query(v.px, v.pz);
    if (q.dist === Infinity) return input;

    const node = road.nodeAt(q.s + LOOKAHEAD);
    if (!node) return input;

    // Heading error plus lateral error. Both terms are positive-right, matching
    // the solver's steer convention.
    let dy = Math.atan2(node.tx, node.tz) - v.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    input.steer = clamp(dy * 2.4 - q.lat * 0.20, -1, 1);

    // Corner-speed lookahead: find the tightest radius in the scan window and
    // cap entry speed at what the tyres can actually hold on it.
    let maxCurv = 0;
    for (let s = SCAN_START; s < SCAN_END; s += SCAN_STEP) {
      const n = road.nodeAt(q.s + s);
      if (n) maxCurv = Math.max(maxCurv, Math.abs(n.curvature));
    }

    let cap = this.targetSpeed;
    if (maxCurv > 1e-4) {
      const radius = 1 / maxCurv;
      const grip = v.peakMu * v.surface.grip * v.gripScale * this.corneringG;
      cap = Math.min(cap, Math.sqrt(grip * 9.81 * radius) * 3.6);
    }
    this.lastCap = cap;

    const kmh = v.speedKmh;
    input.throttle = kmh < cap ? Math.min(1, (cap - kmh) / 12 + 0.25) : 0;
    input.brake = kmh > cap * 1.06 ? Math.min(1, (kmh - cap) / 18) : 0;
    input.handbrake = false;
    return input;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
