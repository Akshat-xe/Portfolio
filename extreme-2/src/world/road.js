// Autonomous road router.
//
// Pipeline, in order:
//   1. vector-march the midline in 10 m increments, choosing the heading that
//      minimises grade + cross-slope + heading change, and refusing to route
//      into water or back across itself
//   2. clamp the per-step elevation delta so the result is always drivable
//      (the road becomes a cut or embankment through steep ground)
//   3. retroactively smooth midline elevation with a 9-point moving average
//   4. subdivide to 2 m with a quadratic Bezier (midpoint construction) so the
//      surface the tyres raycast against is C1-continuous
//
// Coarse nodes are a doubly-linked list; the fine points are a flat array with
// a uniform-grid spatial hash for O(1) proximity queries.

import { WATER_LEVEL } from './heightfield.js';

const STEP = 10;            // coarse midline increment, metres
const FINE_STEP = 2;        // Bezier resample spacing, metres
const SMOOTH_WINDOW = 4;    // +/- N samples -> 9-point average
const CELL = 24;            // spatial hash cell size, metres
const OCC = 48;             // coarse occupancy cell size, metres
const MAX_GRADE = 0.12;     // 12 %
const MIN_RADIUS_TURN = 0.16; // max heading change per 10 m step, radians

const TURN_CANDIDATES = [-0.16, -0.12, -0.085, -0.05, -0.022, 0, 0.022, 0.05, 0.085, 0.12, 0.16];

export class Road {
  constructor(heightfield, rng) {
    this.hf = heightfield;
    this.rng = rng;

    this.coarse = [];
    this.fine = [];
    this.grid = new Map();
    // Coarse occupancy: one Set lookup answers "could the road possibly be
    // within influence range of this point?". Terrain generation calls
    // surface() millions of times and almost every call is nowhere near the
    // road, so this early-out is worth more than any other optimisation here.
    this.occupancy = new Map();

    this.nextId = 0;
    this.smoothedTo = 0;   // index into this.coarse
    this.finedTo = 0;      // index into this.coarse
    this.sHead = 0;        // arc length of the furthest coarse node

    this._q = {
      dist: Infinity, y: 0, s: 0, lat: 0, width: 9, curvature: 0,
      nx: 0, nz: 0, barrier: 0,
    };

    this._seed();
  }

  // ---------------------------------------------------------------- seeding
  _seed() {
    const hf = this.hf;
    // Look for a start that is flat-ish and comfortably above the water line.
    let best = null;
    for (let i = 0; i < 400; i++) {
      const x = (this.rng() - 0.5) * 4000;
      const z = (this.rng() - 0.5) * 4000;
      const y = hf.base(x, z);
      if (y < WATER_LEVEL + 12) continue;
      const slope = hf.baseSlope(x, z, 12);
      const score = slope + Math.max(0, 60 - y) * 0.004;
      if (!best || score < best.score) best = { x, z, y, score };
      if (best.score < 0.03) break;
    }
    const start = best || { x: 0, z: 0, y: hf.base(0, 0) };

    this.origin = { x: start.x, z: start.z };
    this.headingBase = this.rng() * Math.PI * 2;

    this._push(start.x, start.z, start.y, this.headingBase, 0);
    this.extend(1500);
  }

  // -------------------------------------------------------------- marching
  _push(x, z, y, heading, curvature) {
    const prev = this.coarse.length ? this.coarse[this.coarse.length - 1] : null;
    const node = {
      id: this.nextId++,
      x, z, y,
      yRaw: y,
      heading,
      curvature,
      width: 8.5 + 2.5 * Math.min(1, Math.abs(curvature) * 70),
      s: prev ? prev.s + STEP : 0,
      prev,
      next: null,
    };
    if (prev) prev.next = node;
    this.coarse.push(node);
    this.sHead = node.s;
    return node;
  }

  // Meander target: a slowly-varying preferred heading keeps the route from
  // either running dead straight or spiralling.
  _targetHeading(s) {
    return this.headingBase
      + this.hf.warp.noise2D(s * 0.00055, 137.5) * 2.4
      + this.hf.warp.noise2D(s * 0.00017, -42.1) * 3.2;
  }

  _selfIntersects(px, pz, currentId) {
    const cx = Math.floor(px / CELL);
    const cz = Math.floor(pz / CELL);
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const bucket = this.grid.get(((cx + i) & 0xffff) * 65536 + ((cz + j) & 0xffff));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const n = bucket[k];
          if (currentId - n.coarseId < 30) continue; // our own recent trail
          const dx = n.x - px;
          const dz = n.z - pz;
          if (dx * dx + dz * dz < 46 * 46) return true;
        }
      }
    }
    return false;
  }

  _step() {
    const hf = this.hf;
    const head = this.coarse[this.coarse.length - 1];
    const aTarget = this._targetHeading(head.s);

    let bestScore = Infinity;
    let bestA = head.heading;
    let bestX = 0, bestZ = 0, bestY = 0;

    for (let c = 0; c < TURN_CANDIDATES.length; c++) {
      const da = TURN_CANDIDATES[c];
      const a = head.heading + da;
      const px = head.x + Math.cos(a) * STEP;
      const pz = head.z + Math.sin(a) * STEP;
      const py = hf.base(px, pz);

      // Longitudinal grade.
      const grade = Math.abs(py - head.yRaw) / STEP;

      // Cross-slope over the carriageway: a road on a side-hill needs a big
      // cut/fill, so penalise it.
      const lx = Math.sin(a), lz = -Math.cos(a);
      const w = 6;
      const cross = Math.abs(hf.base(px + lx * w, pz + lz * w) - hf.base(px - lx * w, pz - lz * w)) / (2 * w);

      // Water and heading terms.
      const water = py < WATER_LEVEL + 3 ? 4 + (WATER_LEVEL + 3 - py) * 0.5 : 0;
      let dTarget = a - aTarget;
      while (dTarget > Math.PI) dTarget -= Math.PI * 2;
      while (dTarget < -Math.PI) dTarget += Math.PI * 2;

      let score =
        grade * 5.2 +
        cross * 2.4 +
        water +
        Math.abs(da) * 1.9 +
        Math.abs(dTarget) * 0.42;

      if (score < bestScore && !this._selfIntersects(px, pz, head.id)) {
        bestScore = score;
        bestA = a;
        bestX = px; bestZ = pz; bestY = py;
      }
    }

    if (bestScore === Infinity) {
      // Boxed in — force a hard left and carry on rather than deadlocking.
      bestA = head.heading + MIN_RADIUS_TURN;
      bestX = head.x + Math.cos(bestA) * STEP;
      bestZ = head.z + Math.sin(bestA) * STEP;
      bestY = hf.base(bestX, bestZ);
    }

    // Grade clamp: the road cuts through the hill rather than climbing it.
    const maxDy = MAX_GRADE * STEP;
    if (bestY > head.yRaw + maxDy) bestY = head.yRaw + maxDy;
    else if (bestY < head.yRaw - maxDy) bestY = head.yRaw - maxDy;
    if (bestY < WATER_LEVEL + 1.5) bestY = WATER_LEVEL + 1.5;

    let da = bestA - head.heading;
    // curvature is left-positive; increasing heading angle turns right.
    const curvature = -da / STEP;

    this._push(bestX, bestZ, bestY, bestA, curvature);
  }

  // 9-point moving average over the raw elevations, applied only to nodes that
  // already have their full window available.
  _smooth() {
    const c = this.coarse;
    const limit = c.length - SMOOTH_WINDOW;
    for (let i = Math.max(this.smoothedTo, SMOOTH_WINDOW); i < limit; i++) {
      let sum = 0;
      for (let k = -SMOOTH_WINDOW; k <= SMOOTH_WINDOW; k++) sum += c[i + k].yRaw;
      c[i].y = sum / (SMOOTH_WINDOW * 2 + 1);
      this.smoothedTo = i + 1;
    }
  }

  // Barriers exist only as a number on the midline — the lateral offset past
  // which the vehicle is constrained. No collision mesh, no colliders.
  //
  // The offset is found by walking outward from the carriageway edge until the
  // ground stops being drivable (a real drop, or water), then stopping just
  // short of it. A single far probe is not enough: it misses a lake that
  // begins one metre off the tarmac and happily places the barrier out in the
  // water.
  _annotateBarrier(node) {
    const hf = this.hf;
    const half = node.width * 0.5;
    const nx = Math.sin(node.heading);
    const nz = -Math.cos(node.heading);

    let safe = 8.0;   // metres of verge beyond the carriageway edge
    for (let d = 1.0; d <= 8.0; d += 1.0) {
      const off = half + d;
      const r = hf.base(node.x + nx * off, node.z + nz * off);
      const l = hf.base(node.x - nx * off, node.z - nz * off);
      const drop = Math.max(node.yRaw - r, node.yRaw - l);
      if (drop > 2.5 || Math.min(r, l) < WATER_LEVEL + 1.0) { safe = d - 1.0; break; }
    }
    let barrier = half + Math.max(0.6, safe);

    // Rate-limit along the route. A step change in the barrier offset strands
    // the car outside the new line when a wide section narrows — it gets
    // clamped to the barrier and scrapes along it indefinitely. Limiting the
    // change per 10 m node turns every step into a taper the car can follow.
    const prev = node.prev;
    if (prev && prev.barrier !== undefined) {
      const maxDelta = 0.35;
      if (barrier > prev.barrier + maxDelta) barrier = prev.barrier + maxDelta;
      else if (barrier < prev.barrier - maxDelta) barrier = prev.barrier - maxDelta;
    }
    node.barrier = barrier;
  }

  _insertFine(node) {
    const cx = Math.floor(node.x / CELL);
    const cz = Math.floor(node.z / CELL);
    const key = (cx & 0xffff) * 65536 + (cz & 0xffff);
    node.cellKey = key;
    let bucket = this.grid.get(key);
    if (!bucket) { bucket = []; this.grid.set(key, bucket); }
    bucket.push(node);
    this._occupancy(node, 1);
  }

  // Stamp (or unstamp) the node into the 3x3 block of OCC-sized cells around
  // it, so a single lookup covers everything within OCC metres.
  _occupancy(node, delta) {
    const cx = Math.floor(node.x / OCC);
    const cz = Math.floor(node.z / OCC);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const k = ((cx + i) & 0xffff) * 65536 + ((cz + j) & 0xffff);
        const n = (this.occupancy.get(k) || 0) + delta;
        if (n > 0) this.occupancy.set(k, n);
        else this.occupancy.delete(k);
      }
    }
  }

  isNear(x, z) {
    const k = ((Math.floor(x / OCC)) & 0xffff) * 65536 + ((Math.floor(z / OCC)) & 0xffff);
    return this.occupancy.has(k);
  }

  // Quadratic Bezier, midpoint construction: the curve for coarse node i runs
  // from midpoint(i-1, i) to midpoint(i, i+1) with P_i as the control point.
  // Consecutive segments share tangents, so the result is C1 across the whole
  // route with no extra fitting step.
  _subdivide() {
    const c = this.coarse;
    const limit = this.smoothedTo - 1;
    for (let i = Math.max(this.finedTo, 1); i < limit; i++) {
      const p0 = c[i - 1], p1 = c[i], p2 = c[i + 1];
      if (p1.barrier === undefined) this._annotateBarrier(p1);

      const ax = (p0.x + p1.x) * 0.5, az = (p0.z + p1.z) * 0.5, ay = (p0.y + p1.y) * 0.5;
      const bx = (p1.x + p2.x) * 0.5, bz = (p1.z + p2.z) * 0.5, by = (p1.y + p2.y) * 0.5;

      const segLen = Math.hypot(bx - ax, bz - az);
      const n = Math.max(2, Math.round(segLen / FINE_STEP));

      for (let k = 0; k < n; k++) {
        const t = k / n;
        const u = 1 - t;
        const w0 = u * u, w1 = 2 * u * t, w2 = t * t;

        const x = w0 * ax + w1 * p1.x + w2 * bx;
        const z = w0 * az + w1 * p1.z + w2 * bz;
        const y = w0 * ay + w1 * p1.y + w2 * by;

        // Derivative of the quadratic gives an exact tangent.
        let tx = 2 * (u * (p1.x - ax) + t * (bx - p1.x));
        let tz = 2 * (u * (p1.z - az) + t * (bz - p1.z));
        const inv = 1 / (Math.hypot(tx, tz) || 1);
        tx *= inv; tz *= inv;

        const curvature = p1.curvature + (p2.curvature - p1.curvature) * t;
        const prev = this.fine.length ? this.fine[this.fine.length - 1] : null;

        const fnode = {
          x, y, z,
          tx, tz,
          nx: tz, nz: -tx,               // right-hand normal
          width: p1.width,
          barrier: p1.barrier,
          curvature,
          // Superelevation, capped near the 8 % real roads use.
          bank: Math.max(-0.075, Math.min(0.075, curvature * 14)),
          coarseId: p1.id,
          s: prev ? prev.s + Math.hypot(x - prev.x, z - prev.z) : 0,
          next: null,
        };
        if (prev) prev.next = fnode;
        this.fine.push(fnode);
        this._insertFine(fnode);
      }
      this.finedTo = i + 1;
    }
  }

  // Grow the route until the fine polyline reaches `sTarget` metres.
  extend(sTarget) {
    let guard = 0;
    while (this.sHead < sTarget + 60 && guard++ < 40000) this._step();
    this._smooth();
    this._subdivide();
  }

  get length() {
    return this.fine.length ? this.fine[this.fine.length - 1].s : 0;
  }

  // Drop geometry behind the player so memory stays flat on long drives.
  trim(sMin) {
    let cut = 0;
    while (cut < this.fine.length && this.fine[cut].s < sMin) cut++;
    if (cut < 64) return;
    for (let i = 0; i < cut; i++) {
      const n = this.fine[i];
      this._occupancy(n, -1);
      const bucket = this.grid.get(n.cellKey);
      if (bucket) {
        const idx = bucket.indexOf(n);
        if (idx !== -1) bucket.splice(idx, 1);
        if (bucket.length === 0) this.grid.delete(n.cellKey);
      }
    }
    this.fine.splice(0, cut);
    if (this.fine.length) this.fine[0].prev = null;

    const firstId = this.fine.length ? this.fine[0].coarseId : 0;
    let ccut = 0;
    while (ccut < this.coarse.length - 12 && this.coarse[ccut].id < firstId - 2) ccut++;
    if (ccut > 0) {
      this.coarse.splice(0, ccut);
      this.smoothedTo = Math.max(0, this.smoothedTo - ccut);
      this.finedTo = Math.max(0, this.finedTo - ccut);
      if (this.coarse.length) this.coarse[0].prev = null;
    }
  }

  // ---------------------------------------------------------------- queries
  // Nearest point on the road to (x, z). Result object is reused — read the
  // fields you need before calling again.
  query(x, z) {
    const q = this._q;
    q.dist = Infinity;

    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);

    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = this.grid.get(((cx + i) & 0xffff) * 65536 + ((cz + j) & 0xffff));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const a = bucket[k];
          const b = a.next;
          if (!b) continue;

          const ex = b.x - a.x, ez = b.z - a.z;
          const len2 = ex * ex + ez * ez;
          let t = len2 > 0 ? ((x - a.x) * ex + (z - a.z) * ez) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;

          const px = a.x + ex * t;
          const pz = a.z + ez * t;
          const dx = x - px, dz = z - pz;
          const d2 = dx * dx + dz * dz;

          if (d2 < q.dist * q.dist) {
            const d = Math.sqrt(d2);
            const centreY = a.y + (b.y - a.y) * t;
            const nx = a.nx, nz = a.nz;
            const lat = dx * nx + dz * nz;            // + = right of centreline
            const bank = a.bank + (b.bank - a.bank) * t;

            q.dist = d;
            q.lat = lat;
            q.s = a.s + (b.s - a.s) * t;
            q.width = a.width + (b.width - a.width) * t;
            q.curvature = a.curvature;
            q.nx = nx;
            q.nz = nz;
            q.barrier = a.barrier + (b.barrier - a.barrier) * t;
            // Banked cross-section. Curvature is left-positive and lat is
            // right-positive, so on a left-hander the outside (right) edge
            // rises and the inside drops — camber into the corner.
            q.y = centreY + Math.max(-q.width * 0.5, Math.min(q.width * 0.5, lat)) * bank;
          }
        }
      }
    }
    return q;
  }

  // Fine node at (or just before) arc length s. Binary search.
  nodeAt(s) {
    const f = this.fine;
    if (!f.length) return null;
    let lo = 0, hi = f.length - 1;
    if (s <= f[0].s) return f[0];
    if (s >= f[hi].s) return f[hi];
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid].s <= s) lo = mid; else hi = mid;
    }
    return f[lo];
  }
}
