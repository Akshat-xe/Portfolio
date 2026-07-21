// Topographical sampler. Stacked fBm gives the macro landform; a ridge term
// sharpens mountain crests; a warp term breaks up the grid-aligned look you
// otherwise get from raw simplex.
//
// base(x,z)    raw terrain, no road
// surface(x,z) terrain after the road corridor has been carved into it
// coarse(x,z)  surface sampled on the far-grid lattice (used to weld LOD seams)

import { Simplex } from '../lib/simplex.js';
import { alea } from '../lib/alea.js';

export const WATER_LEVEL = 6.0;

export class Heightfield {
  constructor(seed) {
    const rng = alea(seed);
    this.seed = seed;
    this.n1 = new Simplex(rng);
    this.n2 = new Simplex(rng);
    this.warp = new Simplex(rng);

    // fBm parameters. Lacunarity/persistence chosen so octave 5 lands around
    // 1m features, which is the micro-grid vertex spacing.
    this.octaves = 6;
    this.lacunarity = 2.03;   // non-integral: avoids octave alignment artefacts
    this.persistence = 0.47;
    this.baseFrequency = 1 / 1400;
    this.amplitude = 190;

    this.road = null;
    this.coarseStep = 12.5; // must match TerrainLOD far-ring vertex spacing
  }

  attachRoad(road) { this.road = road; }

  // --- raw landform -------------------------------------------------------
  base(x, z) {
    // Domain warp: displaces the sample point by a low-frequency noise field.
    const wf = this.baseFrequency * 0.5;
    const wx = x + this.warp.noise2D(x * wf, z * wf) * 260;
    const wz = z + this.warp.noise2D(x * wf + 71.3, z * wf - 19.7) * 260;

    let freq = this.baseFrequency;
    let amp = 1;
    let sum = 0;
    let norm = 0;

    for (let o = 0; o < this.octaves; o++) {
      let v = this.n1.noise2D(wx * freq, wz * freq);
      if (o < 3) {
        // Ridged: |n| inverted, squared. Produces sharp crests on the big
        // octaves while the small ones stay smooth and rolling.
        v = 1 - Math.abs(v);
        v = v * v * 2 - 1;
      }
      sum += v * amp;
      norm += amp;
      amp *= this.persistence;
      freq *= this.lacunarity;
    }

    let h = (sum / norm) * this.amplitude;

    // Broad continental mask so the world has plains as well as ranges.
    const m = this.n2.noise2D(x * this.baseFrequency * 0.28, z * this.baseFrequency * 0.28);
    h *= 0.55 + 0.75 * (m * 0.5 + 0.5);

    // Flatten everything near sea level into beaches/lakebeds.
    if (h < WATER_LEVEL + 14) {
      const t = Math.max(0, (h - (WATER_LEVEL - 26)) / 40);
      h = (WATER_LEVEL - 26) + 40 * t * t * (3 - 2 * t) * 0.98;
    }
    return h;
  }

  // Slope magnitude of the raw landform, in metres per metre.
  baseSlope(x, z, d = 8) {
    const hx = (this.base(x + d, z) - this.base(x - d, z)) / (2 * d);
    const hz = (this.base(x, z + d) - this.base(x, z - d)) / (2 * d);
    return Math.sqrt(hx * hx + hz * hz);
  }

  // --- terrain with the road cut in --------------------------------------
  surface(x, z) {
    const b = this.base(x, z);
    if (!this.road || !this.road.isNear(x, z)) return b;

    const info = this.road.query(x, z);
    if (info.dist === Infinity) return b;

    const half = info.width * 0.5;
    if (info.dist <= half) return info.y;

    const shoulder = 16;
    const d = info.dist - half;
    if (d >= shoulder) return b;

    // Smoothstep blend from carriageway height out to natural ground.
    const t = d / shoulder;
    const s = t * t * (3 - 2 * t);
    return info.y + (b - info.y) * s;
  }

  // Bilinear sample of `surface` on the far-ring lattice. Near/micro tiles
  // lerp toward this at their outer border so adjacent LOD rings agree
  // exactly on height and no cracks appear.
  coarse(x, z) {
    const s = this.coarseStep;
    const x0 = Math.floor(x / s) * s;
    const z0 = Math.floor(z / s) * s;
    const fx = (x - x0) / s;
    const fz = (z - z0) / s;
    const h00 = this.surface(x0, z0);
    const h10 = this.surface(x0 + s, z0);
    const h01 = this.surface(x0, z0 + s);
    const h11 = this.surface(x0 + s, z0 + s);
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  // Surface normal by central difference. Writes into `out` (a 3-array) to
  // keep the hot path allocation-free.
  normal(x, z, out, d = 1.0) {
    const hl = this.surface(x - d, z);
    const hr = this.surface(x + d, z);
    const hd = this.surface(x, z - d);
    const hu = this.surface(x, z + d);
    let nx = hl - hr;
    let ny = 2 * d;
    let nz = hd - hu;
    const inv = 1 / Math.hypot(nx, ny, nz);
    out[0] = nx * inv;
    out[1] = ny * inv;
    out[2] = nz * inv;
    return out;
  }
}
