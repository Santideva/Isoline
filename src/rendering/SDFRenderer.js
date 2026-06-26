// File: src/rendering/SDFRenderer.js
//
// 2D SDF field renderer. Extends WebGLRenderer.
// Fragment shader evaluates sceneSDF(vec2 p) at each pixel,
// colours inside blue, outside red, draws iso-contour lines,
// highlights the zero crossing in white.

import { WebGLRenderer } from './WebGLRenderer.js';

export class SDFRenderer extends WebGLRenderer {
  constructor(mountElement) {
    super(mountElement);
    this._bounds  = [-4, -4, 4, 4];
    this._isoStep = 0.5;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  render(uniforms = new Map(), time = 0, bounds = null, isoStep = null) {
    if (!this._ready) return;
    if (bounds)           this._bounds  = bounds;
    if (isoStep !== null) this._isoStep = isoStep;

    this._beginFrame();

    this._u1f('uTime',       time);
    this._u2f('uResolution', this._canvas.width, this._canvas.height);
    this._u4f('uBounds',
      this._bounds[0], this._bounds[1],
      this._bounds[2], this._bounds[3]
    );
    this._u1f('uIsoStep', this._isoStep);

    uniforms.forEach((v, name) => this._u1f(name, v));

    this._drawQuad();
  }

  setBounds(xMin, yMin, xMax, yMax) {
    this._bounds = [xMin, yMin, xMax, yMax];
  }

  setIsoStep(s) {
    this._isoStep = s;
  }

  resize(w, h) {
    super.resize(w, h);
    if (this._ready) this.render(new Map(), 0);
  }

  /**
   * Set a render scale factor to improve performance on integrated graphics.
   * The shader renders at (w * scale) × (h * scale) and CSS upscales the
   * canvas to fill the full viewport — trading slight softness for
   * dramatically better frame rates during orbit and animated noise scenes.
   *
   * @param {number} scale  0.5 = half resolution (4× faster), 1.0 = native.
   *                        Recommended: 0.6 for integrated graphics during
   *                        recording, 1.0 for final still captures.
   */
  setRenderScale(scale = 1.0) {
    this._renderScale = Math.max(0.25, Math.min(1.0, scale));
    const w = Math.round(window.innerWidth  * this._renderScale);
    const h = Math.round(window.innerHeight * this._renderScale);
    // Resize the underlying WebGL canvas to the reduced resolution
    super.resize(w, h);
    // CSS scales the canvas back up to fill the viewport — browser does
    // this with bilinear filtering which looks smooth at 0.5-0.75× scale
    this._canvas.style.width  = `${window.innerWidth}px`;
    this._canvas.style.height = `${window.innerHeight}px`;
    this._canvas.style.transformOrigin = '0 0';
  }

  // ── Shader sources ────────────────────────────────────────────────────────

  _buildVertexShader() {
    return `
attribute vec2 aPosition;
uniform   vec4 uBounds;
varying   vec2 vWorldPos;

void main() {
  float wx  = mix(uBounds.x, uBounds.z, (aPosition.x + 1.0) * 0.5);
  float wy  = mix(uBounds.y, uBounds.w, (aPosition.y + 1.0) * 0.5);
  vWorldPos   = vec2(wx, wy);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
  }

  _buildFragmentShader(injected) {
    const ext = this._hasDerivatives
      ? '#extension GL_OES_standard_derivatives : enable'
      : '';
    return `
${ext}
precision highp float;

varying vec2  vWorldPos;
uniform float uTime;
uniform vec2  uResolution;
uniform vec4  uBounds;
uniform float uIsoStep;

// ── Injected SDF functions from GLSLEvaluator ─────────────────────────────
${injected}
// ── End injected ─────────────────────────────────────────────────────────

void main() {
  vec2  p = vWorldPos;
  float d = sceneSDF(p);

  // Inside/outside colour gradient
  vec3 inside  = mix(
    vec3(0.08, 0.25, 0.70),
    vec3(0.03, 0.08, 0.35),
    clamp(-d * 0.4, 0.0, 1.0)
  );
  vec3 outside = mix(
    vec3(0.70, 0.08, 0.08),
    vec3(0.30, 0.03, 0.03),
    clamp( d * 0.4, 0.0, 1.0)
  );
  vec3 col = d < 0.0 ? inside : outside;

  // Iso-contour lines at multiples of uIsoStep
  float bandPos     = abs(d) / uIsoStep;
  float contourEdge = abs(fract(bandPos) - 0.5);
  #ifdef GL_OES_standard_derivatives
    float lw = fwidth(bandPos) * 1.5;
    float pw = fwidth(d);
  #else
    float lw = 0.02;
    float pw = 0.02;
  #endif
  float contour = 1.0 - smoothstep(lw, lw * 2.0, contourEdge);
  col = mix(col, vec3(0.9, 0.9, 0.9), contour * 0.6);

  // Zero crossing — shape boundary in white
  float boundary = smoothstep(pw * 2.0, 0.0, abs(d));
  col = mix(col, vec3(1.0, 1.0, 1.0), boundary);

  gl_FragColor = vec4(col, 1.0);
}`;
  }
}