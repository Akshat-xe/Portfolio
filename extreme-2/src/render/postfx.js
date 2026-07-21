// Post-processing pipeline.
//
//   scene -> HDR target (FP16 + depth) -> atmosphere -> bloom -> ACES/encode
//         -> grade -> FXAA -> screen
//
// The scene is rendered into a half-float target that carries a depth texture,
// which is what makes the atmosphere pass possible: it reconstructs world
// position per pixel and integrates height-dependent fog along the view ray.
// Doing fog here rather than in each material means terrain, road, scenery, car
// and water all share one implementation instead of six that drift apart.
//
// MSAA is off. Multisampling a half-float target costs bandwidth we would
// rather spend elsewhere, so anti-aliasing is a single FXAA pass at the very
// end of the chain, operating on the tonemapped LDR image where it belongs.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { env } from './env.js';

// ---------------------------------------------------------------- atmosphere
const AtmosphereShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjInv: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: env.uSunDir,
    uFogColor: env.uFogColor,
    uFogSunColor: env.uFogSunColor,
    uDensity: env.uFogDensity,
    uHeightFalloff: env.uFogHeightFalloff,
    uBaseHeight: env.uFogBaseHeight,
    uMaxFog: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;

    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uProjInv;
    uniform mat4 uCamWorld;
    uniform vec3 uCamPos;
    uniform vec3 uSunDir;
    uniform vec3 uFogColor;
    uniform vec3 uFogSunColor;
    uniform float uDensity;
    uniform float uHeightFalloff;
    uniform float uBaseHeight;
    uniform float uMaxFog;

    void main() {
      vec4 scene = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).x;

      // Depth 1.0 is the sky dome, which draws its own horizon haze.
      if (depth >= 0.9999) { gl_FragColor = scene; return; }

      // Reconstruct world position from window depth.
      vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 viewPos = uProjInv * ndc;
      viewPos /= viewPos.w;
      vec3 worldPos = (uCamWorld * viewPos).xyz;

      vec3 toFrag = worldPos - uCamPos;
      float dist = length(toFrag);
      vec3 dir = toFrag / max(dist, 1e-4);

      // Analytic integral of an exponential height-density field along the
      // ray. This is what puts fog thick in the valleys and thin on the peaks
      // rather than applying a flat curtain by distance alone.
      float k = uHeightFalloff;
      float dy = toFrag.y;
      float base = uDensity * exp(-k * (uCamPos.y - uBaseHeight));
      float optical;
      if (abs(dy) > 0.01) {
        optical = base * (1.0 - exp(-k * dy)) / (k * dy) * dist;
      } else {
        optical = base * dist;
      }
      float fogAmount = clamp(1.0 - exp(-max(optical, 0.0)), 0.0, uMaxFog);

      // Forward scattering: looking toward the sun, the haze picks up its
      // colour. Two-colour mix stands in for Mie/Rayleigh separation.
      float sunAmount = max(dot(dir, uSunDir), 0.0);
      vec3 fogCol = mix(uFogColor, uFogSunColor, pow(sunAmount, 6.0) * 0.85);

      gl_FragColor = vec4(mix(scene.rgb, fogCol, fogAmount), scene.a);
    }
  `,
};

// --------------------------------------------------------------------- grade
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uVignette: { value: 0.55 },
    uGrain: { value: 0.03 },
    uAberration: { value: 0.0016 },
    uBlur: { value: 0.8 },
    uSaturation: { value: 1.08 },
    uContrast: { value: 1.03 },
    uWarm: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uVignette, uGrain, uAberration, uBlur;
    uniform float uSaturation, uContrast, uWarm;
    uniform vec2 uResolution;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r = length(c);

      vec3 col;
      float amount = uSpeed * uBlur;
      if (amount > 0.001) {
        float w = 0.0;
        col = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          float t = float(i) / 7.0;
          float scale = 1.0 - t * amount * 0.055 * smoothstep(0.1, 0.75, r);
          float wi = 1.0 - t * 0.55;
          col += texture2D(tDiffuse, c * scale + 0.5).rgb * wi;
          w += wi;
        }
        col /= w;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      float ab = uAberration * (0.35 + uSpeed * 1.6);
      if (ab > 0.00001) {
        vec2 off = c * ab * (0.4 + r);
        col.r = texture2D(tDiffuse, uv + off).r;
        col.b = texture2D(tDiffuse, uv - off).b;
      }

      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // Eye comfort: a warming LUT applied to the final image. Pulls blue back
      // and lifts red slightly, the same trick as a night-shift display mode.
      if (uWarm > 0.001) {
        vec3 warm = vec3(col.r * 1.08 + 0.012, col.g * 1.005, col.b * 0.80);
        col = mix(col, warm, uWarm);
      }

      col *= 1.0 - uVignette * smoothstep(0.28, 0.95, r);

      if (uGrain > 0.0001) {
        col += (hash(uv * uResolution + fract(uTime) * 137.0) - 0.5) * uGrain;
      }

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    // HDR scene target. FP16 keeps the sun and emissives well above 1.0 for
    // the bloom threshold and the tone mapper, at half the bandwidth of FP32.
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;

    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      depthTexture,
      stencilBuffer: false,
      samples: 0,                    // MSAA off — FXAA handles edges instead
    });

    // EffectComposer already allocates half-float ping-pong buffers, so the
    // whole chain stays HDR until OutputPass tonemaps and encodes.
    this.composer = new EffectComposer(renderer);

    // Atmosphere is first and sources its colour from sceneTarget directly, so
    // it is given a bogus textureID to stop ShaderPass overwriting tDiffuse
    // with the (empty) read buffer.
    this.atmosphere = new ShaderPass(AtmosphereShader, 'tUnused');
    this.atmosphere.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.atmosphere.uniforms.tDepth.value = depthTexture;
    this.composer.addPass(this.atmosphere);

    // Threshold well above 1.0 so only genuinely bright HDR pixels bloom —
    // the sun disk, headlamps and brake lights — rather than every pale surface.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.75, 1.0);
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

    this.enabled = true;
    this.setSize(Math.max(1, renderer.domElement.width), Math.max(1, renderer.domElement.height));
  }

  // Reversed depth needs both driver and three.js support; probe rather than
  // assume, and report honestly so the caller can surface the real state.
  tryReversedDepth() {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('EXT_clip_control');
    const supported = !!ext && 'reversedDepthBuffer' in this.renderer;
    if (supported) this.renderer.reversedDepthBuffer = true;
    return { extension: !!ext, threeSupport: 'reversedDepthBuffer' in this.renderer, enabled: supported };
  }

  setSize(w, h) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    this.sceneTarget.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.fxaa.material.uniforms.resolution.value.set(1 / w, 1 / h);
  }

  set(key, value) {
    switch (key) {
      case 'bloom':
        this.bloom.enabled = value > 0;
        this.bloom.strength = value;
        break;
      case 'motionBlur': this.grade.uniforms.uBlur.value = value; break;
      case 'grain': this.grade.uniforms.uGrain.value = value; break;
      case 'vignette': this.grade.uniforms.uVignette.value = value; break;
      case 'aberration': this.grade.uniforms.uAberration.value = value; break;
      case 'saturation': this.grade.uniforms.uSaturation.value = value; break;
      case 'eyeComfort': this.grade.uniforms.uWarm.value = value; break;
      case 'contrast': this.grade.uniforms.uContrast.value = value; break;
      case 'fxaa': this.fxaa.enabled = !!value; break;
      case 'fogDensity': env.uFogDensity.value = value; break;
      case 'fogHeight': env.uFogHeightFalloff.value = value; break;
      default: break;
    }
  }

  render(dt, speed01) {
    const g = this.grade.uniforms;
    g.uTime.value += dt;
    g.uSpeed.value += (speed01 - g.uSpeed.value) * Math.min(1, dt * 5);

    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Scene into the HDR+depth target ourselves, so the depth attachment is
    // ours alone and never aliases a composer ping-pong buffer.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    const cam = this.camera;
    const a = this.atmosphere.uniforms;
    a.uProjInv.value.copy(cam.projectionMatrixInverse);
    a.uCamWorld.value.copy(cam.matrixWorld);
    a.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);

    this.composer.render(dt);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.composer.dispose();
  }
}
