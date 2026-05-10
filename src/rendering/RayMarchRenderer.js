// File: src/rendering/RayMarchRenderer.js
//
// 3D SDF renderer using sphere tracing. Extends WebGLRenderer.
// Fragment shader fires a ray per pixel, marches it via sphere tracing,
// computes surface normal via central differences, applies Phong lighting
// with soft shadows, ambient occlusion, distance fog, and up to 4 point lights.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//   const r = new RayMarchRenderer(mountElement);
//   r.setCamera([0,2,6], [0,0,0], 45);
//   r.setLight([0.6,0.8,0.4], [1,0.95,0.9], [0.08,0.08,0.10]);
//   r.addPointLight([3,3,3], [1.0,0.8,0.4], 8);
//   const { ok } = r.compile(glslSource3D);
//   r.show();
//   // each frame:
//   r.syncCamera(threeCamera, orbitControls);
//   r.render(uniforms, time);
//
// ── Camera sync ────────────────────────────────────────────────────────────────
// Call syncCamera(camera, controls) every frame so the ray march view tracks
// OrbitControls. The Three.js canvas must have pointerEvents:'auto' in rayMarch
// mode so OrbitControls still receives mouse events.

import { WebGLRenderer } from './WebGLRenderer.js';

export class RayMarchRenderer extends WebGLRenderer {
  constructor(mountElement) {
    super(mountElement);

    // Camera — kept in sync with Three.js OrbitControls via syncCamera()
    this._camPos    = [0, 2, 6];
    this._camTarget = [0, 0, 0];
    this._fov       = 45;              // degrees

    // Directional light
    this._lightDir   = [0.6, 0.8, 0.4];   // world direction (will be normalised)
    this._lightColor = [1.0, 0.95, 0.9];
    this._ambient    = [0.08, 0.08, 0.10];

    // Material
    this._matColor = [0.40, 0.55, 0.70];

    // Point lights — array of { pos:[x,y,z], color:[r,g,b], radius:number }
    this._pointLights = [];

    // Ray march tuning — changing maxSteps forces recompile (it is baked)
    this._maxSteps  = 128;
    this._maxDist   = 30.0;
    this._epsilon   = 0.001;
    // Step scale: reduce below 1.0 for non-Lipschitz SDFs (rDifference etc.)
    this._stepScale = 0.9;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Render one frame.
   * @param {Map<string,number>} uniforms  Dynamic uniforms from GLSLEvaluator
   * @param {number}             time      Seconds since start
   */
  render(uniforms = new Map(), time = 0) {
    if (!this._ready) return;

    this._beginFrame();

    // Camera
    this._u3f('uCamPos',    ...this._camPos);
    this._u3f('uCamTarget', ...this._camTarget);
    this._u1f('uFOV',       this._fov * Math.PI / 180);
    this._u2f('uResolution', this._canvas.width, this._canvas.height);
    this._u1f('uTime',      time);

    // Directional light
    const ld = this._normVec3(this._lightDir);
    this._u3f('uLightDir',   ...ld);
    this._u3f('uLightColor', ...this._lightColor);
    this._u3f('uAmbient',    ...this._ambient);

    // Material colour
    this._u3f('uMatColor', ...this._matColor);

    // Ray march tuning
    this._u1f('uMaxDist',   this._maxDist);
    this._u1f('uEpsilon',   this._epsilon);
    // Step scale: 0.4 for rDifference/schurBlend(difference) scenes whose
    // SDF gradient can be well below 1.0; 0.9 for all other SDFs.
    this._u1f('uStepScale', this._stepScale ?? 0.9);

    // Point lights — always upload all 4 slots
    const plc = Math.min(this._pointLights.length, 4);
    this._gl.uniform1i(this._getUniformLoc('uPointLightCount'), plc);
    for (let i = 0; i < 4; i++) {
      const pl = this._pointLights[i] || { pos:[0,0,0], color:[0,0,0], radius:1 };
      this._u3f(`uPointLightPos[${i}]`,   ...pl.pos);
      this._u3f(`uPointLightColor[${i}]`, ...pl.color);
      this._u1f(`uPointLightRadius[${i}]`, pl.radius);
    }

    // Dynamic uniforms from GLSLEvaluator (time-varying params)
    uniforms.forEach((v, name) => this._u1f(name, v));

    this._drawQuad();
  }

  /**
   * Sync camera from Three.js camera + OrbitControls each frame.
   */
  syncCamera(camera, controls) {
    this._camPos    = [camera.position.x, camera.position.y, camera.position.z];
    this._camTarget = [controls.target.x,  controls.target.y,  controls.target.z];
    this._fov       = camera.fov;
  }

  /**
   * Manually position the camera.
   * @param {number[]} pos     [x,y,z] world position
   * @param {number[]} target  [x,y,z] look-at point
   * @param {number}   fov     vertical FOV in degrees
   */
  setCamera(pos, target, fov = 45) {
    this._camPos    = pos;
    this._camTarget = target;
    this._fov       = fov;
  }

  /**
   * Set the directional light.
   * @param {number[]} dir     [x,y,z] direction (will be normalised)
   * @param {number[]} color   [r,g,b] 0–1 each
   * @param {number[]} ambient [r,g,b] 0–1 each
   */
  setLight(dir, color, ambient) {
    if (dir)     this._lightDir   = dir;
    if (color)   this._lightColor = color;
    if (ambient) this._ambient    = ambient;
  }

  /**
   * Set base material colour.
   * @param {number} r  0–1
   * @param {number} g  0–1
   * @param {number} b  0–1
   */
  setMaterialColor(r, g, b) {
    this._matColor = [r, g, b];
  }

  /**
   * Add a point light (max 4).
   * @param {number[]} pos     [x,y,z] world position
   * @param {number[]} color   [r,g,b] 0–1 each
   * @param {number}   radius  attenuation radius in world units
   */
  addPointLight(pos, color, radius = 5) {
    if (this._pointLights.length < 4) {
      this._pointLights.push({ pos, color, radius });
    }
  }

  /** Remove all point lights. */
  clearPointLights() {
    this._pointLights = [];
  }

  /**
   * Adjust ray march quality. Changes maxSteps forces shader recompilation
   * since it is baked into the loop bound.
   */
  setQuality(maxSteps = 128, epsilon = 0.001, maxDist = 30) {
    this._maxSteps = maxSteps;
    this._epsilon  = epsilon;
    this._maxDist  = maxDist;
  }

  resize(w, h) {
    super.resize(w, h);
    if (this._ready) this.render(new Map(), 0);
  }

  // ── Shader sources ─────────────────────────────────────────────────────────

  _buildVertexShader() {
    return `
attribute vec2 aPosition;
varying   vec2 vScreenPos;

void main() {
  vScreenPos  = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
  }

  _buildFragmentShader(injected) {
    const ext      = this._hasDerivatives
      ? '#extension GL_OES_standard_derivatives : enable'
      : '';
    const maxSteps = this._maxSteps;

    return `
${ext}
precision highp float;

varying vec2  vScreenPos;
uniform vec2  uResolution;
uniform float uTime;

// Camera
uniform vec3  uCamPos;
uniform vec3  uCamTarget;
uniform float uFOV;

// Directional light
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbient;

// Material
uniform vec3  uMatColor;

// Ray march tuning
uniform float uMaxDist;
uniform float uEpsilon;
uniform float uStepScale;

// Point lights (up to 4)
uniform vec3  uPointLightPos[4];
uniform vec3  uPointLightColor[4];
uniform float uPointLightRadius[4];
uniform int   uPointLightCount;

// ── Injected 3D SDF functions ────────────────────────────────────────────────
${injected}
// ── End injected ─────────────────────────────────────────────────────────────

// ── Surface normal via central differences ───────────────────────────────────
vec3 calcNormal(vec3 p) {
  float e = 0.0005;
  return normalize(vec3(
    sceneSDF(p + vec3(e,0,0)) - sceneSDF(p - vec3(e,0,0)),
    sceneSDF(p + vec3(0,e,0)) - sceneSDF(p - vec3(0,e,0)),
    sceneSDF(p + vec3(0,0,e)) - sceneSDF(p - vec3(0,0,e))
  ));
}

// ── Soft shadow ───────────────────────────────────────────────────────────────
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0;
  float t   = mint;
  for (int i = 0; i < 32; i++) {
    if (t >= maxt) break;
    float h = sceneSDF(ro + rd * t);
    if (h < 0.0005) return 0.0;
    res = min(res, k * h / t);
    t  += h;
  }
  return clamp(res, 0.0, 1.0);
}

// ── Ambient occlusion ─────────────────────────────────────────────────────────
float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float w   = 1.0;
  for (int i = 1; i <= 5; i++) {
    float d  = float(i) * 0.08;
    occ     += w * (d - sceneSDF(p + n * d));
    w       *= 0.5;
  }
  return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
}

// ── Sphere-tracing loop ───────────────────────────────────────────────
float rayMarch(vec3 ro, vec3 rd) {
  float t = 0.001;
  for (int i = 0; i < ${maxSteps}; i++) {
    float d = sceneSDF(ro + rd * t);
    if (d < uEpsilon) return t;
    if (t > uMaxDist) break;
    // uStepScale < 1.0 makes the marcher conservative for non-Lipschitz SDFs
    // (e.g. rDifference creates crescent boundaries where |∇SDF| << 1).
    // For standard SDFs uStepScale = 0.9 (slight understepping avoids
    // over-bounding artefacts on flat surfaces).
    t += d * uStepScale;
  }
  return -1.0;
}

// ── Main ──────────────────────────────────────────────────────────────────────
void main() {
  // ── Camera frame ────────────────────────────────────────────────────────────
  vec3 forward = normalize(uCamTarget - uCamPos);
  vec3 worldUp = abs(forward.y) < 0.999 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 right   = normalize(cross(forward, worldUp));
  vec3 up      = cross(right, forward);

  // Aspect-corrected screen UV [-1,1]²
  vec2 uv   = vScreenPos * 2.0 - 1.0;
  uv.x     *= uResolution.x / uResolution.y;

  float halfTanFOV = tan(uFOV * 0.5);
  vec3 rd = normalize(forward
                    + uv.x * right * halfTanFOV
                    + uv.y * up    * halfTanFOV);

  // ── Ray march ────────────────────────────────────────────────────────────────
  float t = rayMarch(uCamPos, rd);

  if (t < 0.0) {
    // Background gradient
    float horizon = clamp(dot(rd, vec3(0.0,1.0,0.0)) * 0.5 + 0.5, 0.0, 1.0);
    vec3  bg      = mix(vec3(0.05,0.05,0.08), vec3(0.12,0.12,0.20), horizon);
    gl_FragColor  = vec4(bg, 1.0);
    return;
  }

  // ── Surface shading ──────────────────────────────────────────────────────────
  vec3 p      = uCamPos + t * rd;
  vec3 normal = calcNormal(p);

  // Directional light
  float diff   = max(dot(normal, uLightDir), 0.0);
  vec3  halfV  = normalize(uLightDir - rd);
  float spec   = pow(max(dot(normal, halfV), 0.0), 32.0);
  float shadow = softShadow(p + normal * 0.002, uLightDir, 0.01, 6.0, 12.0);
  float ao     = ambientOcclusion(p, normal);

  vec3 col = uMatColor * (uAmbient * ao
           + uLightColor * diff * shadow)
           + uLightColor * spec * shadow * 0.3;

  // Point lights
  for (int i = 0; i < 4; i++) {
    if (i >= uPointLightCount) break;
    vec3  toLight  = uPointLightPos[i] - p;
    float distL    = length(toLight);
    if (distL < 0.001) continue;
    vec3  dirL     = toLight / distL;
    float atten    = 1.0 / (1.0 + distL * distL /
                    (uPointLightRadius[i] * uPointLightRadius[i]));
    float diffL    = max(dot(normal, dirL), 0.0);
    float shadowL  = softShadow(p + normal * 0.002, dirL, 0.01, distL, 8.0);
    col           += uMatColor * uPointLightColor[i] * diffL * atten * shadowL;
  }

  // Distance fog
  float fog = 1.0 - exp(-0.008 * t * t);
  col = mix(col, vec3(0.08,0.08,0.12), fog);

  // Gamma correction
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));

  gl_FragColor = vec4(col, 1.0);
}`;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _normVec3(v) {
    const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    if (len < 1e-6) return [0, 1, 0];
    return [v[0]/len, v[1]/len, v[2]/len];
  }
}