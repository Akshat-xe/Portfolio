// Procedural texture generation.
//
// Everything the renderer samples is synthesised on a canvas at boot — no image
// fetches, no CDN, no CORS. The noise is built on a wrapping lattice so the
// results tile seamlessly, which matters because the terrain shader repeats
// these across an endless world.

import * as THREE from 'three';
import { alea } from '../lib/alea.js';

// Value-noise fBm on a periodic lattice. Grid indices wrap modulo the octave's
// period, so the field is seamless by construction rather than by mirroring.
function noiseField(size, basePeriod, octaves, persistence, rng) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, period = basePeriod;

  for (let o = 0; o < octaves; o++) {
    const g = new Float32Array(period * period);
    for (let i = 0; i < g.length; i++) g[i] = rng();

    for (let y = 0; y < size; y++) {
      const fy = (y / size) * period;
      const iy = Math.floor(fy);
      const y0 = iy % period, y1 = (iy + 1) % period;
      const ty = fy - iy;
      const wy = ty * ty * (3 - 2 * ty);

      for (let x = 0; x < size; x++) {
        const fx = (x / size) * period;
        const ix = Math.floor(fx);
        const x0 = ix % period, x1 = (ix + 1) % period;
        const tx = fx - ix;
        const wx = tx * tx * (3 - 2 * tx);

        const a = g[y0 * period + x0] + (g[y0 * period + x1] - g[y0 * period + x0]) * wx;
        const b = g[y1 * period + x0] + (g[y1 * period + x1] - g[y1 * period + x0]) * wx;
        out[y * size + x] += (a + (b - a) * wy) * amp;
      }
    }
    norm += amp;
    amp *= persistence;
    period *= 2;
  }

  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function toTexture(canvas, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Shared helper: build an RGB canvas from a colouring callback over two noise
// fields (a coarse one for patches, a fine one for grain).
function materialCanvas(size, seed, colour) {
  const rng = alea(seed);
  const coarse = noiseField(size, 4, 4, 0.55, rng);
  const fine = noiseField(size, 16, 4, 0.5, rng);
  // Near-texel grain. Without a strong high-frequency octave the material is
  // all low-order blobs, which reads as a smooth gradient the moment the
  // camera gets close to the ground — the texture only "appears" at distance.
  const grain = noiseField(size, 96, 2, 0.42, rng);

  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rgb = [0, 0, 0];

  for (let i = 0; i < size * size; i++) {
    colour(coarse[i], fine[i], grain[i], rgb);
    d[i * 4] = Math.max(0, Math.min(255, rgb[0] * 255));
    d[i * 4 + 1] = Math.max(0, Math.min(255, rgb[1] * 255));
    d[i * 4 + 2] = Math.max(0, Math.min(255, rgb[2] * 255));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export function makeGrassTexture(size = 256) {
  return toTexture(materialCanvas(size, 'grass', (c, f, g, out) => {
    const lush = c * 0.55 + f * 0.45;
    // Grain is squared around its midpoint so it produces distinct blades
    // rather than a uniform dither.
    const blade = (g - 0.5) * 2.0;
    const speckle = blade * Math.abs(blade) * 0.30;
    out[0] = 0.14 + lush * 0.22 + speckle * 0.55;
    out[1] = 0.24 + lush * 0.34 + speckle * 0.85;
    out[2] = 0.09 + lush * 0.15 + speckle * 0.35;
    const dry = Math.max(0, f - 0.60) * 2.6;
    out[0] += dry * 0.30; out[1] += dry * 0.23; out[2] += dry * 0.02;
  }));
}

export function makeDirtTexture(size = 256) {
  return toTexture(materialCanvas(size, 'dirt', (c, f, g, out) => {
    const v = c * 0.5 + f * 0.5;
    const speckle = (g - 0.5) * 0.34;
    out[0] = 0.28 + v * 0.28 + speckle;
    out[1] = 0.21 + v * 0.22 + speckle * 0.9;
    out[2] = 0.14 + v * 0.14 + speckle * 0.75;
    const peb = Math.max(0, g - 0.66) * 3.4;
    out[0] += peb * 0.22; out[1] += peb * 0.21; out[2] += peb * 0.19;
  }));
}

export function makeRockTexture(size = 256) {
  return toTexture(materialCanvas(size, 'rock', (c, f, g, out) => {
    // Stratified banding plus fracture grain reads as sedimentary rock.
    const band = Math.sin(c * 18.0) * 0.5 + 0.5;
    const v = f * 0.45 + g * 0.55;
    const base = 0.26 + band * 0.12 + v * 0.30;
    out[0] = base * 1.05;
    out[1] = base * 1.00;
    out[2] = base * 0.94;
    const fracture = Math.max(0, f - 0.62) * 2.6;
    out[0] -= fracture * 0.17; out[1] -= fracture * 0.17; out[2] -= fracture * 0.16;
  }));
}

// Low-frequency macro breakup, sampled at very large world scale to defeat the
// obvious repetition of the detail textures. Single channel is enough.
export function makeMacroTexture(size = 256) {
  const rng = alea('macro');
  const a = noiseField(size, 2, 5, 0.6, rng);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, a[i] * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(cv, { srgb: false });
}

// Soft cloud sheet: alpha-only billowing noise, used on the decoupled cloud
// planes so they can drift independently of the sky gradient.
export function makeCloudTexture(size = 512) {
  const rng = alea('clouds');
  const a = noiseField(size, 3, 6, 0.55, rng);
  const b = noiseField(size, 6, 5, 0.5, rng);

  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let i = 0; i < size * size; i++) {
    // Ridged combination gives billows rather than smooth blobs.
    let v = a[i] * 0.65 + (1 - Math.abs(b[i] * 2 - 1)) * 0.35;
    v = Math.max(0, (v - 0.52) / 0.48);
    v = v * v * (3 - 2 * Math.min(1, v));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
    d[i * 4 + 3] = Math.min(255, v * 255);
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(cv, { srgb: false });
}

// Grass blade ATLAS: a 2x2 grid of four tuft variants. Each cell holds a few
// tapered blades with a darker base, so the bottom grounds into the terrain
// instead of floating. The instanced grass picks a cell per blade, which is
// what stops neighbouring tufts from reading as clones.
export function makeGrassBladeTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const rng = alea('blades');
  const cell = size / 2;

  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * cell;
    // Canvas Y grows downward while the atlas cell index grows upward in UV
    // space; row 0 of the atlas is the BOTTOM half of the canvas.
    const oy = (1 - Math.floor(q / 2)) * cell;

    const blades = 3 + Math.floor(rng() * 3);
    for (let b = 0; b < blades; b++) {
      const cx = ox + cell * (0.18 + rng() * 0.64);
      const width = cell * (0.055 + rng() * 0.05);
      const height = cell * (0.55 + rng() * 0.42);
      const lean = (rng() - 0.5) * cell * 0.30;

      const grad = ctx.createLinearGradient(0, oy + cell, 0, oy + cell - height);
      const tint = 0.82 + rng() * 0.36;
      grad.addColorStop(0, `rgb(${Math.round(38 * tint)},${Math.round(56 * tint)},${Math.round(24 * tint)})`);
      grad.addColorStop(0.5, `rgb(${Math.round(74 * tint)},${Math.round(106 * tint)},${Math.round(44 * tint)})`);
      grad.addColorStop(1, `rgb(${Math.round(126 * tint)},${Math.round(158 * tint)},${Math.round(70 * tint)})`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx - width, oy + cell);
      ctx.quadraticCurveTo(cx - width * 0.6 + lean * 0.5, oy + cell - height * 0.55,
                           cx + lean, oy + cell - height);
      ctx.quadraticCurveTo(cx + width * 0.7 + lean * 0.5, oy + cell - height * 0.55,
                           cx + width, oy + cell);
      ctx.closePath();
      ctx.fill();
    }
  }

  return toTexture(cv, { repeat: false, aniso: 4 });
}
