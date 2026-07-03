// File: src/rendering/WebGLRenderer.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Shared base class for SDFRenderer (2D) and RayMarchRenderer (3D).
// Handles all WebGL boilerplate so subclasses only implement shader sources.
//
// ── Responsibilities ─────────────────────────────────────────────────────────
//   - Create and manage a WebGL <canvas> element
//   - Obtain and configure the WebGL context
//   - Enable standard derivatives extension (for fwidth)
//   - Build, compile, and link shader programs
//   - Create and manage the full-screen quad buffer
//   - Provide typed uniform setter helpers
//   - Handle canvas resize
//   - Annotate shader compiler errors with source context
//   - Expose show/hide/dispose lifecycle methods
//
// ── What subclasses must implement ───────────────────────────────────────────
//   _buildVertexShader()           → string
//   _buildFragmentShader(injected) → string
//
// ── What subclasses may override ─────────────────────────────────────────────
//   render(uniforms, time, ...)    → void   (called every frame)
// ─────────────────────────────────────────────────────────────────────────────

export class WebGLRenderer {
  /**
   * @param {HTMLElement} mountElement  Parent element — canvas is prepended here
   */
  constructor(mountElement) {
    this._mount   = mountElement;
    this._gl      = null;
    this._program = null;
    this._quad    = null;
    this._uloc    = {};        // cached uniform locations
    this._ready   = false;     // true after a successful compile()
    this._hasDerivatives = false;

    this._initCanvas(mountElement);
  }

  // ── Public lifecycle ───────────────────────────────────────────────────────

  /**
   * Compile a new shader program.
   * Subclasses provide _buildVertexShader() and _buildFragmentShader(injected).
   *
   * @param  {string} glslSource  Injected GLSL (node functions from GLSLEvaluator)
   * @returns {{ ok: boolean, error: string|null }}
   */
  compile(glslSource) {
    if (!glslSource || !glslSource.trim()) {
      return { ok: false, error: 'Empty GLSL source.' };
    }

    const gl      = this._gl;
    const vertSrc = this._buildVertexShader();
    const fragSrc = this._buildFragmentShader(glslSource);

    // ── Compile vertex shader ──────────────────────────────────────────────
    const vert = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(vert);
      gl.deleteShader(vert);
      return { ok: false, error: `Vertex shader:\n${err}` };
    }

    // ── Compile fragment shader ────────────────────────────────────────────
    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(frag);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      return { ok: false, error: `Fragment shader:\n${this._annotateError(fragSrc, err)}` };
    }

    // ── Link ───────────────────────────────────────────────────────────────
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      return { ok: false, error: `Link error:\n${err}` };
    }

    if (this._program) gl.deleteProgram(this._program);
    this._program = prog;
    this._uloc    = {};
    this._ready   = true;

    return { ok: true, error: null };
  }

  /** Show this renderer's canvas */
  show() {
    if (this._canvas) this._canvas.style.display = 'block';
  }

  /** Hide this renderer's canvas */
  hide() {
    if (this._canvas) this._canvas.style.display = 'none';
  }

  /**
   * Resize canvas to new pixel dimensions.
   * @param {number} w  CSS pixel width
   * @param {number} h  CSS pixel height
   */
  resize(w, h) {
    if (!this._canvas) return;
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width  = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._canvas.style.width  = `${w}px`;
    this._canvas.style.height = `${h}px`;
    if (this._gl) {
      this._gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  /**
   * Set a render scale multiplier. The WebGL canvas renders at
   * (viewport * scale) resolution, then CSS stretches it to fill
   * the full viewport. Lower values = faster rendering, slightly softer.
   * @param {number} scale  0.25–1.0
   */
  setRenderScale(scale) {
    const clamped = Math.max(0.25, Math.min(1.0, scale));
    const prev = this._renderScale ?? 1.0;
    this._renderScale = clamped;

    // Only perform a true WebGL canvas resize when the scale change is
    // large enough to matter (>5%). Small incremental changes from the
    // adaptive system are handled by CSS scaling alone, avoiding the
    // one-blank-frame flash that canvas dimension changes cause.
    const RESIZE_THRESHOLD = 0.05;
    if (Math.abs(clamped - prev) >= RESIZE_THRESHOLD || !this._lastResizeScale) {
      const w = Math.round(window.innerWidth  * clamped);
      const h = Math.round(window.innerHeight * clamped);
      this._canvas.width  = w;
      this._canvas.height = h;
      if (this._gl) {
        this._gl.viewport(0, 0, w, h);
      }
      this._lastResizeScale = clamped;
    }

    // Always update CSS dimensions — handles small incremental changes
    // smoothly without triggering a blank frame.
    this._canvas.style.width  = `${window.innerWidth}px`;
    this._canvas.style.height = `${window.innerHeight}px`;
  }

  /** Release all WebGL resources and remove canvas from DOM */
  dispose() {
    const gl = this._gl;
    if (!gl) return;
    if (this._program) gl.deleteProgram(this._program);
    if (this._quad)    gl.deleteBuffer(this._quad);
    if (this._canvas && this._canvas.parentElement) {
      this._canvas.parentElement.removeChild(this._canvas);
    }
    this._ready = false;
  }

  // ── Protected — subclass interface ────────────────────────────────────────

  /** Subclasses must return the vertex shader source string. */
  _buildVertexShader() {
    throw new Error('WebGLRenderer subclass must implement _buildVertexShader()');
  }

  /**
   * Subclasses must return the complete fragment shader source string.
   * @param {string} injected  GLSL node functions from GLSLEvaluator
   */
  _buildFragmentShader(injected) {
    throw new Error('WebGLRenderer subclass must implement _buildFragmentShader()');
  }

  // ── Protected — draw helpers ──────────────────────────────────────────────

  /** Clear the canvas and set viewport. Call at the start of render(). */
  _beginFrame() {
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Draw the full-screen quad. Call at the end of render(). */
  _drawQuad() {
    const gl     = this._gl;
    const posLoc = gl.getAttribLocation(this._program, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(posLoc);
  }

  // ── Protected — uniform helpers ───────────────────────────────────────────

  _getUniformLoc(name) {
    if (this._uloc[name] === undefined) {
      this._uloc[name] = this._gl.getUniformLocation(this._program, name);
    }
    return this._uloc[name];
  }

  _u1f(name, v) {
    const loc = this._getUniformLoc(name);
    if (loc !== null) this._gl.uniform1f(loc, v);
  }

  _u2f(name, x, y) {
    const loc = this._getUniformLoc(name);
    if (loc !== null) this._gl.uniform2f(loc, x, y);
  }

  _u3f(name, x, y, z) {
    const loc = this._getUniformLoc(name);
    if (loc !== null) this._gl.uniform3f(loc, x, y, z);
  }

  _u4f(name, x, y, z, w) {
    const loc = this._getUniformLoc(name);
    if (loc !== null) this._gl.uniform4f(loc, x, y, z, w);
  }

  // ── Private — initialisation ──────────────────────────────────────────────

  _initCanvas(mountElement) {
    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      display: none;
      z-index: 0;
    `;

    if (mountElement.firstChild) {
      mountElement.insertBefore(this._canvas, mountElement.firstChild);
    } else {
      mountElement.appendChild(this._canvas);
    }

    const w = mountElement.clientWidth  || window.innerWidth;
    const h = mountElement.clientHeight || window.innerHeight;
    this.resize(w, h);

    this._gl = this._canvas.getContext('webgl', {
      antialias:             false,
      premultipliedAlpha:    false,
      preserveDrawingBuffer: true,   // required for toDataURL() in PNG export
    });

    if (!this._gl) {
      console.error(`${this.constructor.name}: WebGL not available.`);
      return;
    }

    const ext = this._gl.getExtension('OES_standard_derivatives');
    this._hasDerivatives = !!ext;
    if (!ext) {
      console.warn(`${this.constructor.name}: OES_standard_derivatives unavailable.`);
    }

    this._quad = this._createQuad();
  }

  _createQuad() {
    const gl    = this._gl;
    const verts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const buf   = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    return buf;
  }

  _annotateError(src, err) {
    const lines  = src.split('\n');
    const result = [err, '\n--- Source context ---'];
    const re     = /ERROR:\s*\d+:(\d+):/g;
    let match;
    const shown = new Set();
    while ((match = re.exec(err)) !== null) {
      const ln = parseInt(match[1], 10) - 1;
      if (!shown.has(ln)) {
        shown.add(ln);
        const s = Math.max(0, ln - 2);
        const e = Math.min(lines.length - 1, ln + 2);
        for (let i = s; i <= e; i++) {
          result.push(`${String(i+1).padStart(4)}: ${lines[i]}${i===ln?' ← ERROR':''}`);
        }
        result.push('');
      }
    }
    return result.join('\n');
  }
}