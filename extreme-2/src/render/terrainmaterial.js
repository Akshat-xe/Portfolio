// Terrain material: triplanar, slope-driven, macro-broken.
//
// A bespoke ShaderMaterial rather than a patched MeshStandardMaterial. The
// scene's lighting rig is exactly one directional key plus a hemisphere fill,
// so reimplementing it costs a dozen lines and buys full control over the
// blend, the Fresnel term and the faked-AO lookup.
//
// Fog is NOT applied here — it is a depth-based post pass, so every surface in
// the scene (terrain, road, scenery, car, water) gets the identical atmosphere
// from one implementation instead of six that drift apart.

import * as THREE from 'three';
import { env } from './env.js';
import { makeGrassTexture, makeDirtTexture, makeRockTexture, makeMacroTexture } from './textures.js';

const VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  // Terrain tiles are translated only, never rotated or scaled non-uniformly,
  // so the normal matrix would be identity work.
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */`
precision highp float;

varying vec3 vWorldPos;
varying vec3 vNormal;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFresnel;
uniform float uWaterLevel;
uniform float uSnowLine;

uniform sampler2D uGrass;
uniform sampler2D uDirt;
uniform sampler2D uRock;
uniform sampler2D uMacro;

uniform sampler2D uAOMap;
uniform vec2 uAOCentre;      // world XZ that the AO map is centred on
uniform float uAOExtent;     // half-width of the AO map footprint, metres
uniform float uAOStrength;

uniform float uDetailScale;
uniform bool uTriplanar;

// Project from three axes and blend by the squared-up normal. On a procedural
// world with 60-degree cliffs, plain XZ mapping smears the texture into streaks;
// this is the whole reason the material exists.
vec3 triplanar(sampler2D tex, vec3 wp, vec3 bw, float scale) {
  if (!uTriplanar) return texture2D(tex, wp.xz * scale).rgb;
  vec3 cx = texture2D(tex, wp.zy * scale).rgb;
  vec3 cy = texture2D(tex, wp.xz * scale).rgb;
  vec3 cz = texture2D(tex, wp.xy * scale).rgb;
  return cx * bw.x + cy * bw.y + cz * bw.z;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);

  vec3 bw = pow(abs(N), vec3(4.0));
  bw /= max(bw.x + bw.y + bw.z, 1e-4);

  float s = uDetailScale;

  // Two octaves of macro noise at very different world scales. Without this the
  // detail textures read as an obvious grid the moment you gain any altitude.
  float macroA = texture2D(uMacro, vWorldPos.xz * 0.00085).r;
  float macroB = texture2D(uMacro, vWorldPos.xz * 0.0037 + vec2(0.37, 0.19)).r;

  // dot(N, up) is the slope term the blend is built on: rock on the steeps,
  // ground cover on the flats, with the transition perturbed by macro noise so
  // it never reads as a contour line.
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  float rockW = smoothstep(0.26, 0.60, slope + (macroA - 0.5) * 0.26);
  float dirtW = (1.0 - rockW) * smoothstep(0.52, 0.82, macroB);
  float grassW = max(0.0, 1.0 - rockW - dirtW);

  // Sampled unconditionally and weighted afterwards. Guarding a fetch behind a
  // per-pixel weight test puts it in non-uniform control flow, where GLSL
  // derivatives are undefined — the hardware falls back to a coarse mip and
  // the ground renders as flat untextured colour.
  vec3 albedo =
      triplanar(uGrass, vWorldPos, bw, s) * grassW
    + triplanar(uDirt,  vWorldPos, bw, s) * dirtW
    + triplanar(uRock,  vWorldPos, bw, s * 0.6) * rockW;

  // Altitude biomes layered over the material blend.
  float beach = 1.0 - smoothstep(uWaterLevel + 0.5, uWaterLevel + 4.5, vWorldPos.y);
  albedo = mix(albedo, vec3(0.52, 0.46, 0.33), beach * (1.0 - rockW) * 0.85);

  float snow = smoothstep(uSnowLine, uSnowLine + 34.0, vWorldPos.y)
             * smoothstep(0.62, 0.30, slope);
  albedo = mix(albedo, vec3(0.86, 0.90, 0.95), snow);

  // Faked ambient occlusion: a splat map maintained around the player with a
  // soft dark disc under every tree. Replaces real-time shadow mapping for
  // static scenery, which is not affordable at this view distance.
  vec2 aoUv = (vWorldPos.xz - uAOCentre) / (2.0 * uAOExtent) + 0.5;
  vec2 inside = step(vec2(0.0), aoUv) * step(aoUv, vec2(1.0));
  float ao = 1.0 - texture2D(uAOMap, clamp(aoUv, 0.0, 1.0)).r
                 * uAOStrength * inside.x * inside.y;

  // --- lighting ---------------------------------------------------------
  float ndl = max(dot(N, uSunDir), 0.0);
  // Cheap wrapped term keeps slopes facing away from the sun from going flat
  // black, standing in for the bounce light a GI solution would provide.
  float wrapped = max(0.0, (dot(N, uSunDir) + 0.35) / 1.35) * 0.25;
  vec3 direct = uSunColor * (ndl + wrapped);
  vec3 ambient = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;

  vec3 colour = albedo * (direct * ao + ambient * mix(0.55, 1.0, ao));

  // Fresnel: grazing angles pick up a little atmosphere, which is what gives
  // distant ridgelines their sense of depth.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  colour += uFogColor * fres * uFresnel;

  gl_FragColor = vec4(colour, 1.0);
}
`;

// 1x1 black stand-in so the AO sampler is always bound to something defined,
// even before the splat map exists.
function blackPixel() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

export function createTerrainMaterial() {
  const grass = makeGrassTexture();
  const dirt = makeDirtTexture();
  const rock = makeRockTexture();
  const macro = makeMacroTexture();
  const noAO = blackPixel();

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: false,
    uniforms: Object.assign({}, env, {
      uGrass: { value: grass },
      uDirt: { value: dirt },
      uRock: { value: rock },
      uMacro: { value: macro },
      uAOMap: { value: noAO },
      uAOCentre: { value: new THREE.Vector2() },
      uAOExtent: { value: 1 },
      uAOStrength: { value: 0.55 },
      uDetailScale: { value: 0.24 },
      uTriplanar: { value: true },
    }),
  });

  material.userData.textures = [grass, dirt, rock, macro, noAO];
  return material;
}
