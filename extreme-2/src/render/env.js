// Shared environment uniforms.
//
// Every custom material (terrain, road, grass, water) and the fog pass point at
// these *same* uniform objects, so the sky system writes the lighting and
// atmosphere state exactly once per frame and the whole scene follows. Handing
// each material its own copy is how time-of-day transitions end up half-applied.

import * as THREE from 'three';

export const env = {
  uTime: { value: 0 },

  // Key light.
  uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.5) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },   // colour * intensity, linear

  // Hemisphere ambient.
  uSkyColor: { value: new THREE.Color(0.5, 0.6, 0.7) },
  uGroundColor: { value: new THREE.Color(0.3, 0.28, 0.24) },
  uAmbient: { value: 0.9 },

  // Atmosphere. uFogColor is the base haze; uFogSunColor is the forward
  // scattering lobe blended in when looking toward the sun.
  uFogColor: { value: new THREE.Color(0.72, 0.81, 0.89) },
  uFogSunColor: { value: new THREE.Color(1.0, 0.85, 0.62) },
  uFogDensity: { value: 0.0016 },
  uFogHeightFalloff: { value: 0.011 },  // 1/m — larger means fog hugs valleys
  uFogBaseHeight: { value: 4.0 },

  // Terrain shading.
  uWaterLevel: { value: 6.0 },
  uSnowLine: { value: 150.0 },
  uFresnel: { value: 0.35 },
};

// Convenience: merge the shared uniforms into a material's own uniform block
// without cloning them, preserving the shared references.
export function withEnv(uniforms) {
  return Object.assign({}, env, uniforms);
}
