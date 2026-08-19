// File: src/rendering/GLSLEvaluator.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Compiles a NodeGraph into GLSL source code for either 2D or 3D rendering.
//
// ── Mode system ──────────────────────────────────────────────────────────────
// generate(time, mode) accepts:
//   '2d'   — generates sceneSDF(vec2 p)  used by SDFRenderer
//   '3d'   — generates sceneSDF(vec3 p)  used by RayMarchRenderer
//   'auto' — detects from graph: if any solid/extrude/revolve node is present
//             uses '3d', otherwise '2d'
//
// In '3d' mode a compatibility shim is also emitted:
//   float sceneSDF(vec2 p) { return sceneSDF(vec3(p.x, p.y, 0.0)); }
// This allows SDFRenderer to still sample the cross-section at z=0.
//
// ── Node dimensionality ───────────────────────────────────────────────────────
// 2D nodes  — circle, regularPolygon, triangle, arc, lineSegment, polytope
//             schurBlend, tilingNode, symmetryFoldNode, symmetryOrbitNode, mobiusNode
//             These emit float fn(vec2 p)
//
// 3D nodes  — sphere, box, cylinder, capsule, torus, cone, plane
//             These emit float fn(vec3 p)
//
// Bridge nodes — extrudeNode, revolveNode
//             Input: 2D SDF   Output: 3D SDF
//             These emit float fn(vec3 p) and call their 2D input with vec2
//
// ── Topological sort ─────────────────────────────────────────────────────────
// Post-order DFS ensures every function is declared before it is called.
// GLSL requires forward declarations to be in order.
//
// ── Number formatting ────────────────────────────────────────────────────────
// All JS numbers go through _f(v) which guarantees a GLSL float literal
// (always has a decimal point, non-finite values become 1e10).
// ─────────────────────────────────────────────────────────────────────────────
import { isIdentityTransform, applyForwardTransform3D } from '../utils/transform3D.js';
import { decimateSamples, decimateOrderedPath, MAX_MASK_SAMPLES, maskHasContent, deriveEmbedFramesFromMask, computeMaskDomeRadius } from '../utils/surfaceMask.js';
import { NodeEvaluator } from '../graph/NodeEvaluator.js';
import { buildAdaptiveFrameField, evaluateBlendedFrame, defaultFrameBandwidth } from '../utils/frameField.js';


function _forwardRotateDirectionGLSL(dir, t) {
  const rx = t.rotateX ?? 0, ry = t.rotateY ?? 0, rz = t.rotateZ ?? 0;
  let x = dir.x, y = dir.y, z = dir.z;
  if (rx !== 0) { const c = Math.cos(rx), s = Math.sin(rx); const ny = y*c - z*s, nz = y*s + z*c; y = ny; z = nz; }
  if (ry !== 0) { const c = Math.cos(ry), s = Math.sin(ry); const nx = x*c + z*s, nz = -x*s + z*c; x = nx; z = nz; }
  if (rz !== 0) { const c = Math.cos(rz), s = Math.sin(rz); const nx = x*c - y*s, ny = x*s + y*c; x = nx; y = ny; }
  return { x, y, z };
}

function _transformFrameToHostParentSpaceGLSL(frame, hostTransform) {
  const scale = hostTransform.scale ?? 1;
  const safeScale = Math.abs(scale) > 1e-6 ? scale : 1e-6;
  const c0 = applyForwardTransform3D(frame.c0, hostTransform);
  const N  = _forwardRotateDirectionGLSL(frame.N, hostTransform);
  const T  = _forwardRotateDirectionGLSL(frame.T, hostTransform);
  const B = {
    x: N.y*T.z - N.z*T.y, y: N.z*T.x - N.x*T.z, z: N.x*T.y - N.y*T.x,
  };
  return { c0, N, T, B, Sxx: frame.Sxx / safeScale, Sxy: frame.Sxy / safeScale, Syy: frame.Syy / safeScale };
}

// Node types that produce a 3D SDF (float fn(vec3 p))
const SOLID_TYPES = new Set([

  'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane'
]);

// Node types that bridge 2D→3D
const BRIDGE_TYPES = new Set([
  'extrudeNode', 'revolveNode'
]);

// Binary SDF blend aliases supported by NodeEvaluator and GLSLEvaluator
const BINARY_BLEND_TYPES = new Set([
  'rUnion',
  'rIntersection',
  'rDifference',
  'schurBlend',
  'rBlend',
  'morphBlend',
]);

// Mapper node types with a standalone (no chained `base` input) GLSL
// implementation. periodicMapper/temporalMapper/recursiveMapper/
// blendedMapper/compositeMapper deliberately excluded — they chain a
// `base` mapper input and need additional resolution logic, deferred.
const MAPPER_TYPES = new Set([
  'identityMapper', 'polynomialMapper', 'sinusoidalMapper',
  'exponentialMapper', 'logarithmicMapper', 'powerMapper',
]);

export class GLSLEvaluator {
  /**
   * @param {NodeGraph} graph
   */
  constructor(graph) {
    this.graph    = graph;
    this.uniforms = new Map();
    // Array-valued uniforms — separate from `uniforms` (always
    // float-valued) because they need a different upload call
    // (gl.uniform3fv/1fv vs gl.uniform1f) and a different GLSL
    // declaration (`uniform vec3 name[N]` vs `uniform float name`). See
    // _maskFieldGLSL for what populates these.
    this.vecUniforms = new Map(); // name → { data: Float32Array, size: 3|1 }
    this.intUniforms  = new Map(); // name → integer value
    this._time    = 0;
    // Persists ACROSS generate() calls (unlike _maskFnCache/_maskFnDecls,
    // which are correctly per-call) — the whole point is to avoid
    // rebuilding embedNode's expensive frame field every animation frame
    // when nothing relevant has changed. Keyed by embedNode id, not host
    // id, so two embeds sharing one host never thrash each other's entry.
    this._embedFrameCache = new Map();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Compile the node graph to GLSL.
   *
   * @param  {number} time   Seconds since start
   * @param  {string} mode   '2d' | '3d' | 'auto'
   * @returns {{ source: string, uniforms: Map<string,number>, rootFn: string|null }}
   */
  generate(time = 0, mode = 'auto') {
    this.uniforms.clear();
    this.vecUniforms.clear();
    this.intUniforms.clear();
    this._time = time;
    this._maskFnCache = new Map();
    this._maskFnDecls = [];
    this._maskDistFnCache = new Map();   // ← add this
    this._uniformDecls = new Set();

    // Resolve effective mode
    if (mode === 'auto') {
      mode = this._detectMode();
    }

    // Locate output node
    let outputNode = null;
    this.graph.nodes.forEach(node => {
      if (node.type === 'outputNode') outputNode = node;
    });
    if (!outputNode) {
      return { source: '', uniforms: this.uniforms, vecUniforms: this.vecUniforms, intUniforms: this.intUniforms, rootFn: null };
    }

    const allIncoming = this.graph.getAllIncomingEdges(outputNode.id, 'sdf');
    if (allIncoming.length === 0) {
      return { source: '', uniforms: this.uniforms, vecUniforms: this.vecUniforms, intUniforms: this.intUniforms, rootFn: null };
    }
    // Use first edge for backward-compat; multi-source handled in sceneSDF below
    const incoming = allIncoming[0];

    // Topological sort
    const order = this._topologicalSort();

    // Only generate GLSL for nodes actually reachable from the output —
    // see _computeReachableNodes's header for why. Without this, adding a
    // freshly-created, unlinked node to the canvas still forced a full
    // shader recompile purely because the concatenated source string grew
    // by one dead-code function block.
    const reachable = this._computeReachableNodes(outputNode);

    // Generate one function per REACHABLE node
    const functions = [];
    for (const nodeId of order) {
      const node = this.graph.nodes.get(nodeId);
      if (!node || node.type === 'outputNode') continue;
      if (!reachable.has(nodeId)) continue;
      const glsl = this._generateNode(node, mode);
      if (glsl) functions.push(glsl);
    }

    // Build sceneSDF — supports multiple inputs via implicit min-union
    const allNodes  = allIncoming.map(e => this.graph.nodes.get(e.fromNode)).filter(Boolean);
    const allFns    = allIncoming.map(e => this._fnName(e.fromNode));
    const anyIs3D   = allNodes.some(n => this._nodeOutputIs3D(n));

    let sceneSDFStr;
    const rootFn = allFns[0];   // still needed for return value

    if (mode === '3d') {
      if (allFns.length === 1) {
        const call = anyIs3D ? `${allFns[0]}(p)` : `${allFns[0]}(p.xy)`;
        sceneSDFStr = `float sceneSDF(vec3 p) {\n  return ${call};\n}`;
      } else {
        const calls = allFns.map((fn, i) => {
          const is3D = this._nodeOutputIs3D(allNodes[i]);
          return is3D ? `${fn}(p)` : `${fn}(p.xy)`;
        });
        const body = calls.map((c, i) =>
          i === 0 ? `  float d = ${c};` : `  d = min(d, ${c});`
        ).join('\n');
        sceneSDFStr = `float sceneSDF(vec3 p) {\n${body}\n  return d;\n}`;
      }
      sceneSDFStr += `\nfloat sceneSDF(vec2 p) { return sceneSDF(vec3(p.x, p.y, 0.0)); }`;
    } else {
      if (allFns.length === 1) {
        const call = anyIs3D ? `${allFns[0]}(vec3(p.x, p.y, 0.0))` : `${allFns[0]}(p)`;
        sceneSDFStr = `float sceneSDF(vec2 p) {\n  return ${call};\n}`;
      } else {
        const calls = allFns.map((fn, i) => {
          const is3D = this._nodeOutputIs3D(allNodes[i]);
          return is3D ? `${fn}(vec3(p.x, p.y, 0.0))` : `${fn}(p)`;
        });
        const body = calls.map((c, i) =>
          i === 0 ? `  float d = ${c};` : `  d = min(d, ${c});`
        ).join('\n');
        sceneSDFStr = `float sceneSDF(vec2 p) {\n${body}\n  return d;\n}`;
      }
    }

    // ── Output-level placement transform ─────────────────────────────────
    // Rename the combined body to sceneSDF_raw, then generate a wrapper
    // sceneSDF that applies the inverse output-transform before delegating.
    // This applies once to the FULLY COMBINED result regardless of how many
    // source branches feed into the output node — identical semantics to
    // the CPU getRootSDF() wrapper in NodeEvaluator.js.
    sceneSDFStr = sceneSDFStr.replace(/sceneSDF/g, 'sceneSDF_raw');

    const op = outputNode.params;
    const placeTx = this._f(op.posX    ?? 0);
    const placeTy = this._f(op.posY    ?? 0);
    const placeTz = this._f(op.posZ    ?? 0);
    const placeRx = this._f(op.rotateX ?? 0);
    const placeRy = this._f(op.rotateY ?? 0);
    const placeRz = this._f(op.rotateZ ?? 0);

    let placementWrapper;
    if (mode === '3d') {
      // Full 3D placement — translation + all three rotation axes.
      placementWrapper = `
float sceneSDF(vec3 p) {
  vec3 q = p - vec3(${placeTx}, ${placeTy}, ${placeTz});

  // Inverse Z rotation (undo roll)
  { float cz = cos(-${placeRz}); float sz = sin(-${placeRz});
    q = vec3(q.x*cz - q.y*sz, q.x*sz + q.y*cz, q.z); }

  // Inverse Y rotation (undo yaw)
  { float cy = cos(-${placeRy}); float sy = sin(-${placeRy});
    q = vec3(q.x*cy + q.z*sy, q.y, -q.x*sy + q.z*cy); }

  // Inverse X rotation (undo pitch)
  { float cx = cos(-${placeRx}); float sx = sin(-${placeRx});
    q = vec3(q.x, q.y*cx - q.z*sx, q.y*sx + q.z*cx); }

  return sceneSDF_raw(q);
}
float sceneSDF(vec2 p) { return sceneSDF(vec3(p.x, p.y, 0.0)); }`;
    } else {
      // 2D placement — translation in XY + rotation around Z only.
      // posZ/rotateX/rotateY are not meaningful in 2D render modes
      // (contours/fill/arcs) and are intentionally ignored here.
      placementWrapper = `
float sceneSDF(vec2 p) {
  vec2 q = p - vec2(${placeTx}, ${placeTy});
  { float c = cos(-${placeRz}); float s = sin(-${placeRz});
    q = vec2(q.x*c - q.y*s, q.x*s + q.y*c); }
  return sceneSDF_raw(q);
}`;
    }

    sceneSDFStr += '\n' + placementWrapper;

    // Defensive consistency check: every mask function name handed out by
    // _maskFieldGLSL() during this generate() call must have a matching
    // declaration queued in _maskFnDecls, or the shader will compile-fail
    // with a cryptic "no matching overloaded function found" at the CALL
    // site rather than pointing at the real problem (a missing
    // declaration). Surfaces that mismatch immediately and loudly instead
    // of silently producing a broken shader.
    this._maskFnCache.forEach((fnName) => {
      const hasDecl = this._maskFnDecls.some(d => d.includes(`float ${fnName}(`));
      if (!hasDecl) {
        console.error(
          `GLSLEvaluator: mask function "${fnName}" was referenced but never ` +
          `declared — the generated shader will fail to compile. This means ` +
          `_maskFnDecls is not being included in the final source assembly, ` +
          `or _maskFieldGLSL's push() is not running for this node.`
        );
      }
    });

    const uniformDeclBlock = [...this._uniformDecls].map(n => `uniform float ${n};`).join('\n');
    const source = [this._preamble(), uniformDeclBlock, ...this._maskFnDecls, ...functions, sceneSDFStr].join('\n\n');
    return { source, uniforms: this.uniforms, vecUniforms: this.vecUniforms, intUniforms: this.intUniforms, rootFn };
  }

  // ── Mode detection ────────────────────────────────────────────────────────

  /**
   * Detect rendering mode from graph content.
   * Returns '3d' if any solid, extrude, or revolve node is present.
   */
  _detectMode() {
    let has3D = false;
    this.graph.nodes.forEach(node => {
      if (SOLID_TYPES.has(node.type) || BRIDGE_TYPES.has(node.type)) {
        has3D = true;
      }
    });
    return has3D ? '3d' : '2d';
  }

  /**
   * Returns true if a node produces a 3D SDF output (float fn(vec3 p)).
   * For passthrough transform nodes this depends on whether their input is 3D.
   * For binary blend nodes we check both inputs, because either one can force 3D.
   */
  _nodeOutputIs3D(node, visited = new Set()) {
    if (!node) return false;

    // Prevent infinite loops on malformed graphs
    if (visited.has(node.id)) return false;
    visited.add(node.id);

    // Solid primitives are always 3D
    if (SOLID_TYPES.has(node.type)) return true;

    // Bridge nodes (extrude, revolve) always output 3D
    if (BRIDGE_TYPES.has(node.type)) return true;

    // Binary blend nodes: output dimension follows either input
    if (BINARY_BLEND_TYPES.has(node.type)) {
      const ports = ['sdfA', 'sdfB'];
      for (const portName of ports) {
        const edge = this.graph.getIncomingEdge(node.id, portName);
        if (!edge) continue;
        const inputNode = this.graph.nodes.get(edge.fromNode);
        if (this._nodeOutputIs3D(inputNode, visited)) return true;
      }
      return false;
    }

    // twistNode, bendNode, and transform3DNode always emit float fn(vec3 p)
    // regardless of input — their GLSL templates are inherently 3D
    // (they translate/rotate in 3D space). _nodeOutputIs3D must return
    // true for them unconditionally.
    const ALWAYS_3D_OUTPUT = new Set(['twistNode', 'bendNode', 'transform3DNode', 'embedNode']);;
    if (ALWAYS_3D_OUTPUT.has(node.type)) return true;

    // Passthrough transform nodes inherit dimensionality from their input
    const PASSTHROUGH = new Set([
      'noiseDisplaceNode', 'repeatNode',
      'symmetryFoldNode', 'symmetryOrbitNode', 'tilingNode', 'mobiusNode',
      'ifsBlend'
    ]);
    if (PASSTHROUGH.has(node.type)) {
      const edge = this.graph.getIncomingEdge(node.id, 'sdf');
      if (!edge) return false;
      const inputNode = this.graph.nodes.get(edge.fromNode);
      return this._nodeOutputIs3D(inputNode, visited);
    }

    return false;
  }

  // ── Preamble ──────────────────────────────────────────────────────────────

  _preamble() {
    return `// ── GLSLEvaluator generated preamble ──────────────────────────

float rUnion(float a, float b, float s) {
  // Smooth minimum — correct for negative-inside SDF convention.
  // Returns min(a,b) far from the boundary; smooth transition within k units.
  // Mapping: k = s*0.05 so that default s=8 gives a 0.4-unit blend zone.
  //
  // Correctness check (all cases):
  //   outside both (a>0,b>0)  → min → positive ✓
  //   inside A only (a<0,b>0) → min → a (negative) ✓
  //   inside B only (a>0,b<0) → min → b (negative) ✓
  //   inside both  (a<0,b<0)  → min → more negative ✓
  float k = max(s * 0.05, 0.05);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float rIntersection(float a, float b, float s) {
  // Hard max — correct for all intersection sizes including thin regions.
  // Smooth max with the previous k=0.4 added +0.1 correction, shrinking
  // thin intersections to zero and making them invisible.
  // max(a,b) is Lipschitz-1 and gives exact SDF convention in all cases.
  return max(a, b);
}
float rDifference(float a, float b, float s) {
  // max(a, −b): positive outside A−B, negative inside crescent.
  return rIntersection(a, -b, s);
}
float smoothMax(float a, float b, float s) {
  // -smoothMin(-a,-b) — the max-side counterpart to rUnion's smooth min,
  // used to blend overlapping mask domes into a continuous ridge instead
  // of a chain of visibly separate petals (see mask_N below).
  return -rUnion(-a, -b, s);
}

// ── Shared noise helpers ────────────────────────────────────────────────────
// Declared once in the preamble so that any number of noiseDisplaceNode
// instances in the same graph can reference these functions without each
// one redefining them — which would cause a GLSL "function already has a
// body" compile error. Both 2D and 3D variants are declared here so either
// can be called from any noise node regardless of its input dimensionality.
float ndHash(float n) { return fract(sin(n) * 43758.5453); }

float ndNoise3(vec3 p) {
  float ix=floor(p.x); float iy=floor(p.y); float iz=floor(p.z);
  float fx=fract(p.x); float fy=fract(p.y); float fz=fract(p.z);
  float ux=fx*fx*(3.0-2.0*fx);
  float uy=fy*fy*(3.0-2.0*fy);
  float uz=fz*fz*(3.0-2.0*fz);
  return mix(
    mix(mix(ndHash(ix    +iy*57.0+iz*113.0), ndHash(ix+1.0+iy*57.0    +iz*113.0), ux),
        mix(ndHash(ix    +(iy+1.0)*57.0+iz*113.0), ndHash(ix+1.0+(iy+1.0)*57.0+iz*113.0), ux), uy),
    mix(mix(ndHash(ix    +iy*57.0+(iz+1.0)*113.0), ndHash(ix+1.0+iy*57.0+(iz+1.0)*113.0), ux),
        mix(ndHash(ix    +(iy+1.0)*57.0+(iz+1.0)*113.0), ndHash(ix+1.0+(iy+1.0)*57.0+(iz+1.0)*113.0), ux), uy),
    uz);
}

float ndNoise2(vec2 p) {
  float ix=floor(p.x); float iy=floor(p.y);
  float fx=fract(p.x); float fy=fract(p.y);
  float ux=fx*fx*(3.0-2.0*fx);
  float uy=fy*fy*(3.0-2.0*fy);
  return mix(
    mix(ndHash(ix    +iy*57.0), ndHash(ix+1.0+iy*57.0),     ux),
    mix(ndHash(ix    +(iy+1.0)*57.0), ndHash(ix+1.0+(iy+1.0)*57.0), ux),
    uy);
}
// ── End shared noise helpers ────────────────────────────────────────────────
`;
  }

  // ── Per-node dispatch ─────────────────────────────────────────────────────

  /**
   * Generate a GLSL function for one node.
   * Dispatches to 2D or 3D template based on node type.
   */
  _generateNode(node, mode) {
    let glsl;
    if (SOLID_TYPES.has(node.type)) {
      glsl = this._generate3DNode(node);
    } else if (BRIDGE_TYPES.has(node.type)) {
      glsl = this._generateBridgeNode(node);
    } else if (node.type === 'embedNode') {
      // CORRECTED: embedNode's function IS a normal float fn(vec3 p) SDF
      // signature and SHOULD go through the wrap step below like any
      // other 3D node. It was previously special-cased to return
      // directly, which silently meant embedNode's own Transform section
      // (position/rotate/scale) never applied in GLSL — even though the
      // identical CPU path applied it correctly (NodeEvaluator's
      // _applyNodeTransform runs on every node type unconditionally).
      // Fixed by falling through to the same wrap step as everything else.
      glsl = this._generateEmbedNode(node);
    } else if (MAPPER_TYPES.has(node.type)) {
      // Mapper functions are float-in/float-out (no spatial position of
      // their own), so _wrapWithNodeTransform — which assumes a
      // point-in/distance-out SDF signature — does not apply. Return
      // directly rather than falling through to the wrap step below.
      return this._generateMapperNode(node);
    } else {
      glsl = this._generate2DNode(node, mode);
    }
    // Nodes with no GLSL representation (outputNode, time/oscillator, and
    // the not-yet-implemented chained mapper types) return null — nothing
    // to wrap.
    if (!glsl) return glsl;
    return this._wrapWithNodeTransform(node, glsl);
  }

  _mapperFnName(nodeId) { return `map_${nodeId}`; }

  /**
   * Generate a GLSL function for a standalone mapper node: float fn(float d).
   * This is the DistanceMapper case from GeometryMapper.js — reads/writes
   * only the distance field, so a plain float→float GLSL function is the
   * complete and correct implementation.
   *
   * CONFIDENCE NOTE: polynomialMapper and sinusoidalMapper match
   * NodeEvaluator's CPU formulas (DistanceMapping.js) exactly, confirmed
   * against that file. exponential/logarithmic/power below now ALSO match
   * DistanceMapping.js exactly (createExponentialMapping/
   * createLogarithmicMapping/createPowerMapping), including logarithmic's
   * guard against log(non-positive) — ported directly from its `arg > 0 ?
   * ... : e` fallback.
   */
  _generateMapperNode(node) {
    const fn = this._mapperFnName(node.id);
    const p  = node.params;

    switch (node.type) {
      case 'identityMapper':
        return `// identityMapper node ${node.id}
float ${fn}(float d) { return d; }`;

      case 'polynomialMapper': {
        const c0 = this._f(p.c0 ?? 0), c1 = this._f(p.c1 ?? 1),
              c2 = this._f(p.c2 ?? 0), c3 = this._f(p.c3 ?? 0);
        const band = this._f(Math.max(p.band ?? 1.0, 1e-4));
        // Windowed/additive — matches DistanceMapping.js's
        // createPolynomialMapping exactly. f(d) === d exactly once |d| >= band.
        return `// polynomialMapper node ${node.id}
float ${fn}(float d) {
  float raw = ${c0} + ${c1}*d + ${c2}*d*d + ${c3}*d*d*d;
  float perturb = raw - d;
  float ad = abs(d);
  if (ad >= ${band}) return d;
  float x = ad / ${band};
  float w = 1.0 - x*x*(3.0-2.0*x);
  return d + w * perturb;
}`;
      }

      case 'sinusoidalMapper': {
        const a = this._f(p.a ?? 1), b = this._f(p.b ?? 4), e = this._f(p.e ?? 0);
        const band = this._f(Math.max(p.band ?? 1.0, 1e-4));
        const animated = (p.animated ?? 'no') === 'yes';
        const speed = this._f(p.speed ?? 0.8);
        const phase = animated
          ? `${this._f(p.c ?? 0)} + sin(uTime * ${speed}) * 3.14159265`
          : this._f(p.c ?? 0);
        // Windowed/additive — see DistanceMapping.js's createSinusoidalMapping
        // for the full derivation of why this is required (spurious
        // concentric zero-crossing "shells" otherwise). f(d) === d exactly
        // once |d| >= band, so no shell can exist beyond that radius.
        return `// sinusoidalMapper node ${node.id} (animated=${animated})
float ${fn}(float d) {
  float ad = abs(d);
  if (ad >= ${band}) return d;
  float x = ad / ${band};
  float w = 1.0 - x*x*(3.0-2.0*x);
  float perturb = ${a} * sin(${b}*d + ${phase}) + ${e};
  return d + w * perturb;
}`;
      }

      case 'exponentialMapper': {
        // f(d) = a * exp(b*d) + c — matches createExponentialMapping exactly.
        const a = this._f(p.a ?? 1), b = this._f(p.b ?? 1), c = this._f(p.c ?? 0);
        return `// exponentialMapper node ${node.id}
float ${fn}(float d) { return ${a} * exp(${b}*d) + ${c}; }`;
      }
      case 'logarithmicMapper': {
        // f(d) = a*log(b*d+c)+e if (b*d+c)>0, else e — matches
        // createLogarithmicMapping's guard against log(non-positive) exactly.
        const a = this._f(p.a ?? 1), b = this._f(p.b ?? 1),
              c = this._f(p.c ?? 1), e = this._f(p.e ?? 0);
        return `// logarithmicMapper node ${node.id}
float ${fn}(float d) {
  float arg = ${b}*d + ${c};
  return arg > 0.0 ? ${a} * log(arg) + ${e} : ${e};
}`;
      }
      case 'powerMapper': {
        // f(d) = a * d^b + c — matches createPowerMapping exactly.
        // GLSL's pow() is undefined for negative base — SDF distances are
        // routinely negative (inside the shape), so guard the sign the
        // same way sign()*pow(abs(d),b) would, preserving odd-power
        // symmetry (matches Math.pow's behavior for integer b; for
        // non-integer b Math.pow(negative,fractional) is already NaN in
        // JS too, so this GLSL guard is at least as correct as the CPU path).
        const a = this._f(p.a ?? 1), b = this._f(p.b ?? 2), c = this._f(p.c ?? 0);
        return `// powerMapper node ${node.id}
float ${fn}(float d) { return ${a} * sign(d) * pow(abs(d), ${b}) + ${c}; }`;
      }

      default:
        return `// mapper fallback node ${node.id}
float ${fn}(float d) { return d; }`;
    }
  }

  _resolveMapperFn(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;
    return this._mapperFnName(edge.fromNode);
  }

  /**
   * Resolve a mapper port to both its GLSL function name AND, where an
   * honest bound exists, its Lipschitz constant L (max |df/dd| over the
   * assumed operating range). This is the RIGOROUS fix for mapper +
   * ray-march incompatibility: a function with bounded |f'| ≤ L, applied
   * to an exact SDF, is itself Lipschitz-L in world space — dividing its
   * output by L makes it Lipschitz-1 (i.e. once again a safe, correct
   * distance-like value), BEFORE it's combined with anything else via
   * min/max. Since min/max of already-safe bounds is still a safe bound,
   * no other part of codegen needs to change — this is a per-node fix,
   * not a parallel "safe step" function threaded through the graph.
   *
   * lipschitz === null means no honest global/operating-range bound
   * exists for that mapper type (exponential, logarithmic, power — see
   * class-level notes). Those fall back to the existing heuristic
   * conservative-step mitigation in SceneManager, which is NOT a
   * mathematical guarantee, only a practical improvement.
   */
  _resolveMapperInfo(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;
    const mapperNode = this.graph.nodes.get(edge.fromNode);
    if (!mapperNode) return null;
    return {
      fnName: this._mapperFnName(edge.fromNode),
      lipschitz: this._computeMapperLipschitz(mapperNode),
    };
  }

  _computeMapperLipschitz(mapperNode) {
    const p = mapperNode.params || {};
    switch (mapperNode.type) {
      case 'identityMapper':
        return 1;
      case 'polynomialMapper': {
        // Now that the polynomial's deviation from identity is confined
        // to |d|<band (see the windowed GLSL/CPU implementations), the
        // bound only needs to hold WITHIN that band — no more "assume a
        // reasonable operating range" guesswork needed; this is now a
        // genuinely tight, honest bound.
        const band = Math.max(p.band ?? 1.0, 1e-4);
        const c0 = Math.abs(p.c0 ?? 0), c1m1 = Math.abs((p.c1 ?? 1) - 1),
              c2 = Math.abs(p.c2 ?? 0), c3 = Math.abs(p.c3 ?? 0);
        // |perturbation(d)| <= c0 + |c1-1|*band + c2*band² + c3*band³ for |d|<=band
        const Pmax  = c0 + c1m1 * band + c2 * band * band + c3 * band * band * band;
        // |perturbation'(d)| <= |c1-1| + 2*c2*band + 3*c3*band² for |d|<=band
        const Pmax1 = c1m1 + 2 * c2 * band + 3 * c3 * band * band;
        return 1 + (2 / band) * Pmax + Pmax1;
      }
      case 'sinusoidalMapper': {
        const a = Math.abs(p.a ?? 1), b = Math.abs(p.b ?? 4), e = Math.abs(p.e ?? 0);
        const band = Math.max(p.band ?? 1.0, 1e-4);
        return 1 + (2 / band) * (a + e) + a * b;
      }
      default:
        return null;
    }
  }

  /**
   * embedNode — implements the EmbeddingMapper contract from
   * GeometryMapper.js directly in GLSL (GLSL has no dynamic dispatch, so
   * the map(ctx) pattern that class documents has to be emitted as literal
   * shader code here, not routed through a runtime call).
   *
   * V1 scope: host and guest must both be 3D solids — this is the bounded
   * "basic" single-level version. A full recursive Geometry Node hierarchy
   * with pluggable coordinate providers is Phase 8 (advanced tier).
   */
  /**
   * embedNode — corrected version. See NodeEvaluator.js's matching case
   * for the full derivation of the bug this fixes: the tangent frame is
   * now built ONCE at the anchor's projected point (baked as GLSL
   * constants at generation time) rather than per-pixel from each query
   * point's own projection — which was provably degenerate (always
   * collapsed to a 1D line along the normal). This is also cheaper than
   * before: no per-pixel gradient recomputation, just one fixed frame.
   */
  _generateEmbedNode(node) {
    const fn = this._fnName(node.id);
    const p  = node.params;

    const hostFn = this._resolveInputFn(node, 'hostSdf');
    if (!hostFn) return this._fallback3D(fn, node.id, 'embedNode missing host');

    const edgeH = this.graph.getIncomingEdge(node.id, 'hostSdf');
    const hostNode = edgeH ? this.graph.nodes.get(edgeH.fromNode) : null;
    if (hostNode && !this._nodeOutputIs3D(hostNode)) {
      return this._fallback3D(fn, node.id, 'embedNode requires a 3D host');
    }

    // guestSdf is OPTIONAL. When nothing is wired into it AND the host has
    // a PAINTED (non-flood) Surface Region, the painted stroke itself
    // becomes the geometry (no guest shape evaluated at all). Flood mode
    // still REQUIRES a connected guest.
    const guestFn = this._resolveInputFn(node, 'guestSdf');
    const edgeG = this.graph.getIncomingEdge(node.id, 'guestSdf');
    const guestNode = edgeG ? this.graph.nodes.get(edgeG.fromNode) : null;
    if (guestNode && !this._nodeOutputIs3D(guestNode)) {
      console.warn(`embedNode ${node.id}: guest must be a 3D solid if connected.`);
      return this._fallback3D(fn, node.id, 'embedNode requires a 3D guest when one is connected');
    }

    const useMaskFrames = !!(hostNode && maskHasContent(hostNode.mask));
    const isPaintMaskGLSL = useMaskFrames && hostNode.mask.mode !== 'curvatureFlood';

    const hostIsTiling = hostNode && hostNode.type === 'tilingNode';
    const tilingFoldGLSL = hostIsTiling ? this._buildTilingFoldGLSL(hostNode) : null;

    // ── NO-GUEST STROKE-RELIEF PATH ─────────────────────────────────────
    if (!guestFn) {
      if (!isPaintMaskGLSL) {
        return `// embedNode ${node.id}  (no guest, no paint — passthrough)
float ${fn}(vec3 p) {
  return ${hostFn}(p);
}`;
      }

      const maskDistFnName = this._maskDistanceGLSL(hostNode);
      const opStroke = p.operation ?? 'emboss';
      const wStroke = this._uniformFloat(node, 'embedStrokeWidth', Math.max(p.width ?? 0.06, 1e-4));
      const dStroke = this._uniformFloat(node, 'embedDepth', Math.max(p.depth ?? 0.08, 1e-4));
      const softStroke = Math.min(Math.max(p.edgeSoftness ?? 0.15, 0), 0.9);
      const seamStroke = this._uniformFloat(node, 'embedStrokeSeamSm', p.seamSmoothness ?? 0);

      // Same raw-relief, sign-handled-only-by-combiner pattern as the
      // CPU path (see NodeEvaluator.js's identical comment) — relief is
      // NEVER pre-negated by operation; only the combine step differs.
      const combineCallStroke = opStroke === 'engrave'
        ? `(-rUnion(-dHost, relief, ${seamStroke}))`
        : `rUnion(dHost, relief, ${seamStroke})`;

      const wStrokeNum = Math.max(p.width ?? 0.06, 1e-4);
      const coreRNum = wStrokeNum * (1 - softStroke);
      const coreRVal = this._uniformFloat(node, 'embedStrokeCoreR2', coreRNum);

      return `// embedNode ${node.id}  (${opStroke}, no-guest stroke relief)
float ${fn}(vec3 p) {
  vec3 foldedP = p;
${tilingFoldGLSL ? tilingFoldGLSL : ''}
  float dHost = ${hostFn}(${tilingFoldGLSL ? 'foldedP' : 'p'});
  float rejectBeyond = ${wStroke} + ${dStroke};
  if (abs(dHost) >= rejectBeyond) return dHost;
  float dist = ${maskDistFnName}(${tilingFoldGLSL ? 'foldedP' : 'p'});
  if (dist >= rejectBeyond) return dHost;
  float relief = max(dist - ${wStroke}, abs(dHost) - ${dStroke});
  float combined = ${combineCallStroke};
  float edgeW = 1.0;
  if (dist > ${coreRVal}) {
    float x = min(1.0, (dist - ${coreRVal}) / max(${wStroke} - ${coreRVal}, 1e-4));
    edgeW = 1.0 - x*x*(3.0-2.0*x);
  }
  return dHost + (combined - dHost) * edgeW;
}`;
    }

    // ── GUEST-PROJECTION PATH ────────────────────────────────────────────
    // CPU/GLSL PARITY FIX: NodeEvaluator's embedNode case only overrides w
    // via evaluateMaskAt() when hostMask.mode !== 'curvatureFlood' — for
    // curvatureFlood it deliberately leaves w to the tangential/depth
    // radial falloff (wT*wD) instead, since a flood selection's shape is
    // already encoded in WHICH points became mask samples, not in a
    // separate coverage function. This GLSL version applied the mask
    // function UNCONDITIONALLY regardless of mode — the actual cause of
    // the CPU-says-no-effect / GPU-shows-an-effect divergence measured by
    // window.__torusDiag.inspectEmbed(). Matched to CPU's behavior here.
    const embedMaskFnName = (useMaskFrames && hostNode.mask.mode !== 'curvatureFlood')
      ? this._maskFieldGLSL(hostNode)
      : null;

    const op = p.operation ?? 'emboss';
    const depthVal = this._uniformFloat(node, 'embedDepth', p.depth ?? 0.35);
    const edgeSoftnessVal = Math.min(Math.max(p.edgeSoftness ?? 0.25, 0), 0.9);
    const innerFracVal = this._uniformFloat(node, 'embedInnerFrac', 1 - edgeSoftnessVal);
    const seamSm = this._uniformFloat(node, 'embedSeamSm', p.seamSmoothness ?? 0);

    let maskFootprintRadius = 0;
    if (useMaskFrames) {
      let mcx = 0, mcy = 0, mcz = 0;
      hostNode.mask.samples.forEach(s => { mcx += s.x; mcy += s.y; mcz += s.z; });
      const sN = hostNode.mask.samples.length || 1;
      mcx /= sN; mcy /= sN; mcz /= sN;
      let maxDist = 0;
      hostNode.mask.samples.forEach(s => {
        const dx = s.x - mcx, dy = s.y - mcy, dz = s.z - mcz;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d > maxDist) maxDist = d;
      });
      const domePad = computeMaskDomeRadius(hostNode.mask.samples, hostNode.mask.falloffRadius);
      const hostScale = Math.abs(hostNode.transform?.scale ?? 1);
      maskFootprintRadius = (maxDist + domePad) * (hostScale > 1e-6 ? hostScale : 1);
    }

    let frames, bandwidth;
    if (useMaskFrames) {
      // Kept in sync with MAX_EMBED_FRAMES above — requesting more frames
      // here than the GLSL unroll below can hold would just have the
      // extras silently discarded by the fixed-slot loop.
      const rawFrames = deriveEmbedFramesFromMask(hostNode.mask, 3);
      const hostTransform = hostNode.transform;
      frames = (hostTransform && !isIdentityTransform(hostTransform))
        ? rawFrames.map(f => _transformFrameToHostParentSpaceGLSL(f, hostTransform))
        : rawFrames;
      bandwidth = defaultFrameBandwidth(Math.max(maskFootprintRadius, 1e-4), frames.length);
    } else {
      ({ frames, bandwidth } = this._computeEmbedFrameField(
        edgeH.fromNode,
        { x: p.anchorX ?? 0, y: p.anchorY ?? 0, z: p.anchorZ ?? 0 },
        p.regionSize ?? 1.0,
        node.id
      ));
    }
    const hStr = this._f(bandwidth);

    let rs;
    if (useMaskFrames) {
      const userScale = hostNode.mask.mode === 'curvatureFlood'
        ? Math.max(p.regionSize ?? 1.0, 0.05)
        : 1;
      rs = this._uniformFloat(node, 'embedRegionSize', Math.max(maskFootprintRadius * userScale, 1e-4));
    } else {
      rs = this._uniformFloat(node, 'embedRegionSize', p.regionSize ?? 1.0);
    }

    // Reduced from 6 → 3. Each unrolled frame slot below carries its own
    // mat3 Hessian/sag-correction block, and this entire loop is called
    // from inside the ray-march loop (192+ iterations) which is ITSELF
    // called again from two 32-step shadow loops and a 6-step AO loop.
    // ANGLE must statically unroll all of that nesting before D3DCompile
    // even starts — measured compile times of 7-16 SECONDS per shader at
    // 6 frames, uniformly across every host/guest combination tested
    // (see the embed-diag sweep). Halving the unrolled frame count is a
    // partial mitigation, not a fix — the ray-march-loop × mask-sample-
    // loop nesting is the other major contributor and is untouched here.
    const MAX_EMBED_FRAMES = 3;
    const FAR_SENTINEL = { x: 1e6, y: 1e6, z: 1e6 };

    const frameDecls = [];
    const blendTerms = [];
    for (let i = 0; i < MAX_EMBED_FRAMES; i++) {
      const f = frames[i] || {
        c0: FAR_SENTINEL, T:{x:1,y:0,z:0}, B:{x:0,y:0,z:1}, N:{x:0,y:1,z:0},
        Sxx: 0, Sxy: 0, Syy: 0,
      };
      frameDecls.push(`
  vec3 fc${i}  = ${this._f3(f.c0)};
  vec3 fT${i}  = ${this._f3(f.T)};
  vec3 fB${i}  = ${this._f3(f.B)};
  vec3 fN${i}  = ${this._f3(f.N)};
  float fSxx${i} = ${this._f(f.Sxx)};
  float fSxy${i} = ${this._f(f.Sxy)};
  float fSyy${i} = ${this._f(f.Syy)};`);

      blendTerms.push(`
  { vec3 dd = foldedP - fc${i};
    float dist = length(dd);
    float r = dist / ${hStr};
    float ww = r >= 1.0 ? 0.0 : (1.0-r)*(1.0-r)*(1.0-r)*(1.0-r)*(4.0*r+1.0);
    sumW  += ww;
    c0sum += ww * fc${i};
    Nsum  += ww * fN${i};
    Tsum  += ww * fT${i};
    Hrow0 += ww * vec3(
      fSxx${i}*fT${i}.x*fT${i}.x + fSyy${i}*fB${i}.x*fB${i}.x + 2.0*fSxy${i}*fT${i}.x*fB${i}.x,
      fSxx${i}*fT${i}.x*fT${i}.y + fSyy${i}*fB${i}.x*fB${i}.y + fSxy${i}*(fT${i}.x*fB${i}.y + fT${i}.y*fB${i}.x),
      fSxx${i}*fT${i}.x*fT${i}.z + fSyy${i}*fB${i}.x*fB${i}.z + fSxy${i}*(fT${i}.x*fB${i}.z + fT${i}.z*fB${i}.x)
    );
    Hrow1 += ww * vec3(
      fSxx${i}*fT${i}.x*fT${i}.y + fSyy${i}*fB${i}.x*fB${i}.y + fSxy${i}*(fT${i}.x*fB${i}.y + fT${i}.y*fB${i}.x),
      fSxx${i}*fT${i}.y*fT${i}.y + fSyy${i}*fB${i}.y*fB${i}.y + 2.0*fSxy${i}*fT${i}.y*fB${i}.y,
      fSxx${i}*fT${i}.y*fT${i}.z + fSyy${i}*fB${i}.y*fB${i}.z + fSxy${i}*(fT${i}.y*fB${i}.z + fT${i}.z*fB${i}.y)
    );
    Hrow2 += ww * vec3(
      fSxx${i}*fT${i}.x*fT${i}.z + fSyy${i}*fB${i}.x*fB${i}.z + fSxy${i}*(fT${i}.x*fB${i}.z + fT${i}.z*fB${i}.x),
      fSxx${i}*fT${i}.y*fT${i}.z + fSyy${i}*fB${i}.y*fB${i}.z + fSxy${i}*(fT${i}.y*fB${i}.z + fT${i}.z*fB${i}.y),
      fSxx${i}*fT${i}.z*fT${i}.z + fSyy${i}*fB${i}.z*fB${i}.z + 2.0*fSxy${i}*fT${i}.z*fB${i}.z
    );
    if (ww > bestW) { bestW = ww; bestC0 = fc${i}; bestN = fN${i}; bestT = fT${i}; bestB = fB${i}; bestSxx = fSxx${i}; bestSxy = fSxy${i}; bestSyy = fSyy${i}; }
  }`);
    }

    const blendCall = op === 'engrave'
      ? `(-rUnion(-dHost, dGuest, ${seamSm}))`
      : `rUnion(dHost, dGuest, ${seamSm})`;

    return `// embedNode ${node.id}  (${op}, multi-frame: ${frames.length})${hostIsTiling ? '  [per-cell, tiling host]' : ''}
float ${fn}(vec3 p) {
  vec3 foldedP = p;
${tilingFoldGLSL ? tilingFoldGLSL : ''}
  float dHost = ${hostFn}(${tilingFoldGLSL ? 'foldedP' : 'p'});
  float absDHost = abs(dHost);

  if (absDHost >= ${depthVal}) return dHost;

${frameDecls.join('\n')}

  float sumW = 0.0;
  vec3 c0sum = vec3(0.0);
  vec3 Nsum  = vec3(0.0);
  vec3 Tsum  = vec3(0.0);
  vec3 Hrow0 = vec3(0.0);
  vec3 Hrow1 = vec3(0.0);
  vec3 Hrow2 = vec3(0.0);
  float bestW = -1.0;
  vec3 bestC0 = fc0, bestN = fN0, bestT = fT0, bestB = fB0;
  float bestSxx = fSxx0, bestSxy = fSxy0, bestSyy = fSyy0;
${blendTerms.join('\n')}

  float lx, ly, lzCorrected;
  bool resolved = false;
  if (sumW > 1e-8) {
    vec3 c0b = c0sum / sumW;
    vec3 NbRaw = Nsum / sumW;
    float nLen = length(NbRaw);
    if (nLen > 1e-6) {
      vec3 Nb = NbRaw / nLen;
      vec3 Traw = Tsum / sumW;
      float tDotN = dot(Traw, Nb);
      vec3 Tb0 = Traw - tDotN * Nb;
      float tLen = length(Tb0);
      if (tLen < 1e-6) {
        vec3 helper = (abs(Nb.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        Tb0 = cross(helper, Nb);
        tLen = max(length(Tb0), 1e-6);
      }
      vec3 Tb = Tb0 / tLen;
      vec3 Bb = cross(Nb, Tb);

      mat3 Hb = mat3(Hrow0, Hrow1, Hrow2) / sumW;
      vec3 HT = Hb * Tb;
      vec3 HB = Hb * Bb;
      float Sxxb = dot(Tb, HT);
      float Syyb = dot(Bb, HB);
      float Sxyb = dot(Tb, HB);

      vec3 dd2 = foldedP - c0b;
      lx = dot(dd2, Tb);
      ly = dot(dd2, Bb);
      float lz = dot(dd2, Nb);
      float sag = 0.5 * (Sxxb*lx*lx + 2.0*Sxyb*lx*ly + Syyb*ly*ly);
      lzCorrected = lz - sag;
      resolved = true;
    }
  }
  if (!resolved) {
    vec3 dd2 = foldedP - bestC0;
    lx = dot(dd2, bestT);
    ly = dot(dd2, bestB);
    float lz = dot(dd2, bestN);
    float sag = 0.5 * (bestSxx*lx*lx + 2.0*bestSxy*lx*ly + bestSyy*ly*ly);
    lzCorrected = lz - sag;
  }

  float tangentialR2 = lx*lx + ly*ly;
  float tangentialR = sqrt(tangentialR2);
  if (tangentialR >= ${rs}) return dHost;

  float dGuest = ${guestFn}(vec3(lx, ly, lzCorrected));
  float embedded = ${blendCall};

  float innerR = ${rs} * ${innerFracVal};
  float innerD = ${depthVal} * ${innerFracVal};

  float wT = 1.0;
  if (tangentialR > innerR) {
    float x = (tangentialR - innerR) / (${rs} - innerR);
    wT = 1.0 - x*x*(3.0-2.0*x);
  }
  float wD = 1.0;
  if (absDHost > innerD) {
    float x = (absDHost - innerD) / (${depthVal} - innerD);
    wD = 1.0 - x*x*(3.0-2.0*x);
  }
  float w = wT * wD;
${embedMaskFnName ? `  w = ${embedMaskFnName}(${tilingFoldGLSL ? 'foldedP' : 'p'});` : ''}
  return embedded * w + dHost * (1.0 - w);
}`;
  }

  /** Bake a vec3 as a GLSL literal. */
  _f3(v) { return `vec3(${this._f(v.x)}, ${this._f(v.y)}, ${this._f(v.z)})`; }

  /**
   * Return the GLSL function name for a node's baked mask field
   * (mask_<nodeId>), generating and queuing its declaration on first
   * request within this generate() call, and reusing the same name on
   * subsequent requests for the SAME node — a node's mask can be read
   * from more than one place (a masked mapper AND a masked embedNode
   * host in the same graph) without ever emitting a duplicate GLSL
   * function, which would be a compile error.
   *
   * Mirrors evaluateMaskAt() in surfaceMask.js EXACTLY — see that
   * function's header for why CPU and GLSL must agree here: the hard
   * topology-aware work (geodesic/curvature reasoning) already happened
   * at CPU bake time, so this is deliberately simple Euclidean/Wendland
   * blending over the already-baked samples, nothing more — same
   * fixed-slot-unroll pattern as _generateEmbedNode's frame array, for
   * the same GLSL-ES-1.0-has-no-non-const-array-indexing reason.
   *
   * @returns {string|null} the function name, or null if the node has no
   *   painted content — callers must treat null as "mask value is always
   *   0" and skip calling this a second time for the same node/call.
   */
  _maskFieldGLSL(node) {
    if (!maskHasContent(node?.mask)) {
      return null;
    }
    if (this._maskFnCache.has(node.id)) return this._maskFnCache.get(node.id);

    const fn = `mask_${node.id}`;
    this._maskFnCache.set(node.id, fn);

    const GLSL_MASK_CAP = 24;
    // Paint modes ('euclidean'/'geodesic') are an ORDERED PATH and need
    // order-preserving decimation; 'curvatureFlood' is an unordered
    // cloud and uses farthest-point decimation as before. Mixing these
    // up would either scramble a stroke's connectivity or waste spread
    // on a flood that doesn't need it.
    const isPath = node.mask.mode !== 'curvatureFlood';

    let samples, strokeBreaksDecimated;
    if (isPath) {
      const decimated = decimateOrderedPath(node.mask.samples, node.mask.strokeBreaks, GLSL_MASK_CAP);
      samples = decimated.samples;
      strokeBreaksDecimated = decimated.strokeBreaks;
    } else {
      samples = decimateSamples(node.mask.samples, GLSL_MASK_CAP);
      strokeBreaksDecimated = [];
    }

    const radius  = this._uniformFloat(node, 'maskRadius',  computeMaskDomeRadius(samples, node.mask.falloffRadius));
    const nThresh = this._uniformFloat(node, 'maskNThresh', 1 - (node.mask.normalThreshold ?? -1));

    if (samples.length === 0) {
      this._maskFnDecls.push(`// mask ${fn} (empty)\nfloat ${fn}(vec3 p) { return 0.0; }`);
      return fn;
    }

    let bcx = 0, bcy = 0, bcz = 0;
    samples.forEach(s => { bcx += s.x; bcy += s.y; bcz += s.z; });
    bcx /= samples.length; bcy /= samples.length; bcz /= samples.length;
    let maxSpread = 0;
    samples.forEach(s => {
      const d = Math.hypot(s.x - bcx, s.y - bcy, s.z - bcz);
      if (d > maxSpread) maxSpread = d;
    });
    // UNIFORMS, not baked literals — see _uniformFloat's header comment.
    // These are a cheap early-reject bounding sphere, recomputed from
    // node.mask.samples on every call. Baking them as GLSL literals meant
    // every new paint sample during a live drag changed the generated
    // shader's SOURCE TEXT, forcing a full recompile per mousemove — the
    // actual cause of the mid-stroke freeze / dropped-sample corruption.
    // Now only a genuine sample-COUNT change (which alters the unrolled
    // loop bound) still requires a recompile; moving/adding samples
    // within that count does not.
    const boundCx = this._uniformFloat(node, 'maskBoundCx', bcx);
    const boundCy = this._uniformFloat(node, 'maskBoundCy', bcy);
    const boundCz = this._uniformFloat(node, 'maskBoundCz', bcz);
    const boundSpread = this._uniformFloat(node, 'maskBoundSpread', maxSpread);

    const posName    = `u_${node.id}_maskPos`;
    const normName   = `u_${node.id}_maskN`;
    const weightName = `u_${node.id}_maskW`;
    const breakName  = `u_${node.id}_maskBreak`;
    const countName  = `u_${node.id}_maskCount`;

    const posArr    = new Float32Array(GLSL_MASK_CAP * 3);
    const normArr   = new Float32Array(GLSL_MASK_CAP * 3);
    const weightArr = new Float32Array(GLSL_MASK_CAP);
    const breakArr  = new Float32Array(GLSL_MASK_CAP); // 1.0 = "this sample starts a NEW stroke"
    const breakSet  = new Set(strokeBreaksDecimated);
    samples.forEach((s, i) => {
      posArr[i * 3]     = s.x;
      posArr[i * 3 + 1] = s.y;
      posArr[i * 3 + 2] = s.z;
      normArr[i * 3]     = s.nx;
      normArr[i * 3 + 1] = s.ny;
      normArr[i * 3 + 2] = s.nz;
      weightArr[i] = s.w ?? 1;
      breakArr[i]  = breakSet.has(i) ? 1 : 0;
    });
    this.vecUniforms.set(posName,    { data: posArr,    size: 3 });
    this.vecUniforms.set(normName,   { data: normArr,   size: 3 });
    this.vecUniforms.set(weightName, { data: weightArr, size: 1 });
    this.vecUniforms.set(breakName,  { data: breakArr,  size: 1 });
    this.intUniforms.set(countName, samples.length);

    if (isPath) {
      // PATH mode — swept-tube distance to the stroke's own segments.
      // This is the GLSL counterpart that was previously MISSING
      // entirely: ray-march rendering always used point-cloud
      // interpolation regardless of mode, which is why baked paint kept
      // looking beaded/patterned even after the CPU-side fix. Mirrors
      // surfaceMask.js's _evaluateSegmentedMask exactly, including the
      // per-index isolated-point fallback for single-click dabs.
      this._maskFnDecls.push(`
// mask ${fn}  (node ${node.id}, PATH/stroke — up to ${GLSL_MASK_CAP} samples)
uniform vec3  ${posName}[${GLSL_MASK_CAP}];
uniform vec3  ${normName}[${GLSL_MASK_CAP}];
uniform float ${weightName}[${GLSL_MASK_CAP}];
uniform float ${breakName}[${GLSL_MASK_CAP}];
uniform int   ${countName};
float ${fn}(vec3 p) {
  if (length(p - vec3(${boundCx}, ${boundCy}, ${boundCz})) > ${boundSpread} + ${radius}) return 0.0;
  float sumW = 0.0;
  float sumWeighted = 0.0;
  float missProduct = 1.0;
  for (int i = 0; i < ${GLSL_MASK_CAP}; i++) {
    if (i >= ${countName}) break;
    bool isStart = (i == 0) || (${breakName}[i] > 0.5);
    bool isEnd = (i == ${countName} - 1);
    if (!isEnd && (i + 1 < ${GLSL_MASK_CAP}) && ${breakName}[i + 1] > 0.5) isEnd = true;

    if (isStart && isEnd) {
      // Isolated single-point stroke (a click/dab) — point contribution.
      vec3 dd = p - ${posName}[i];
      float dist = length(dd);
      if (dist < ${radius}) {
        float r = dist / ${radius};
        float wl = (1.0-r)*(1.0-r)*(1.0-r)*(1.0-r)*(4.0*r+1.0);
        float nDot = dist > 1e-6 ? dot(dd, ${normName}[i]) / dist : 0.0;
        float foldGate = ${nThresh} >= 1.0 ? 1.0 : 1.0 - smoothstep(${nThresh} - 0.15, ${nThresh}, abs(nDot));
        float wlg = wl * foldGate;
        sumW += wlg; sumWeighted += wlg * ${weightName}[i]; missProduct *= (1.0 - wlg);
      }
    } else if (!isEnd) {
      // Segment i -> i+1 contribution.
      vec3 a = ${posName}[i];
      vec3 b = ${posName}[i + 1];
      vec3 ab = b - a;
      float abLenSq = dot(ab, ab);
      vec3 ap = p - a;
      float tt = abLenSq > 1e-10 ? clamp(dot(ap, ab) / abLenSq, 0.0, 1.0) : 0.0;
      vec3 c = a + ab * tt;
      vec3 dd = p - c;
      float dist = length(dd);
      if (dist < ${radius}) {
        vec3 na = ${normName}[i];
        vec3 nb = ${normName}[i + 1];
        vec3 ni = na + (nb - na) * tt;
        float nlen = max(length(ni), 1e-6);
        float nDot = dist > 1e-6 ? dot(dd, ni / nlen) / dist : 0.0;
        float foldGate = ${nThresh} >= 1.0 ? 1.0 : 1.0 - smoothstep(${nThresh} - 0.15, ${nThresh}, abs(nDot));
        float r = dist / ${radius};
        float wl = (1.0-r)*(1.0-r)*(1.0-r)*(1.0-r)*(4.0*r+1.0);
        float segW = ${weightName}[i] + (${weightName}[i+1] - ${weightName}[i]) * tt;
        float wlg = wl * foldGate;
        sumW += wlg; sumWeighted += wlg * segW; missProduct *= (1.0 - wlg);
      }
    }
  }
  if (sumW <= 1e-6) return 0.0;
  float envelope = 1.0 - missProduct;
  float localAverage = clamp(sumWeighted / sumW, 0.0, 1.0);
  return clamp(envelope * localAverage, 0.0, 1.0);
}`);
    } else {
      // FLOOD mode — unordered point cloud, unchanged from before.
      this._maskFnDecls.push(`
// mask ${fn}  (node ${node.id}, FLOOD — up to ${GLSL_MASK_CAP} samples)
uniform vec3  ${posName}[${GLSL_MASK_CAP}];
uniform vec3  ${normName}[${GLSL_MASK_CAP}];
uniform float ${weightName}[${GLSL_MASK_CAP}];
uniform int   ${countName};
float ${fn}(vec3 p) {
  if (length(p - vec3(${boundCx}, ${boundCy}, ${boundCz})) > ${boundSpread} + ${radius}) return 0.0;
  float sumW = 0.0;
  float sumWeighted = 0.0;
  float missProduct = 1.0;
  for (int i = 0; i < ${GLSL_MASK_CAP}; i++) {
    if (i >= ${countName}) break;
    vec3 dd = p - ${posName}[i];
    float dist = length(dd);
    if (dist < ${radius}) {
      float r = dist / ${radius};
      float wl = (1.0-r)*(1.0-r)*(1.0-r)*(1.0-r)*(4.0*r+1.0);
      float nDot = dist > 1e-6 ? dot(dd, ${normName}[i]) / dist : 0.0;
      float foldGate = ${nThresh} >= 1.0 ? 1.0 : 1.0 - smoothstep(${nThresh} - 0.15, ${nThresh}, abs(nDot));
      float wlg = wl * foldGate;
      sumW += wlg;
      sumWeighted += wlg * ${weightName}[i];
      missProduct *= (1.0 - wlg);
    }
  }
  if (sumW <= 1e-6) return 0.0;
  float envelope = 1.0 - missProduct;
  float localAverage = clamp(sumWeighted / sumW, 0.0, 1.0);
  return clamp(envelope * localAverage, 0.0, 1.0);
}`);
    }

    return fn;
  }

  /**
   * GLSL counterpart of surfaceMask.js's evaluateMaskDistance — returns a
   * TRUE minimum distance to the stroke path (or 1e6 if out of range),
   * not a kernel-weighted coverage value. See that function's header for
   * the full rationale.
   */
  _maskDistanceGLSL(node) {
    if (!maskHasContent(node?.mask)) return null;
    if (!this._maskDistFnCache) this._maskDistFnCache = new Map();
    if (this._maskDistFnCache.has(node.id)) return this._maskDistFnCache.get(node.id);

    const fn = `maskDist_${node.id}`;
    this._maskDistFnCache.set(node.id, fn);

    const GLSL_MASK_CAP = 24;
    const decimated = decimateOrderedPath(node.mask.samples, node.mask.strokeBreaks, GLSL_MASK_CAP);
    const samples = decimated.samples;
    const strokeBreaksDecimated = decimated.strokeBreaks;

    const radius  = this._uniformFloat(node, 'maskDistRadius', computeMaskDomeRadius(samples, node.mask.falloffRadius));
    const nThresh = this._uniformFloat(node, 'maskDistNThresh', 1 - (node.mask.normalThreshold ?? -1));

    if (samples.length === 0) {
      this._maskFnDecls.push(`// maskDist ${fn} (empty)\nfloat ${fn}(vec3 p) { return 1e6; }`);
      return fn;
    }

    let bcx=0,bcy=0,bcz=0;
    samples.forEach(s => { bcx+=s.x; bcy+=s.y; bcz+=s.z; });
    bcx/=samples.length; bcy/=samples.length; bcz/=samples.length;
    let maxSpread = 0;
    samples.forEach(s => { const d = Math.hypot(s.x-bcx, s.y-bcy, s.z-bcz); if (d>maxSpread) maxSpread=d; });
    // UNIFORMS, not baked literals — see the identical fix in
    // _maskFieldGLSL above for the full rationale (this was the other
    // half of the mid-paint-stroke recompile storm).
    const boundCx = this._uniformFloat(node, 'maskDistBoundCx', bcx);
    const boundCy = this._uniformFloat(node, 'maskDistBoundCy', bcy);
    const boundCz = this._uniformFloat(node, 'maskDistBoundCz', bcz);
    const boundSpread = this._uniformFloat(node, 'maskDistBoundSpread', maxSpread);

    const posName   = `u_${node.id}_mdPos`;
    const normName  = `u_${node.id}_mdN`;
    const breakName = `u_${node.id}_mdBreak`;
    const countName = `u_${node.id}_mdCount`;

    const posArr   = new Float32Array(GLSL_MASK_CAP * 3);
    const normArr  = new Float32Array(GLSL_MASK_CAP * 3);
    const breakArr = new Float32Array(GLSL_MASK_CAP);
    const breakSet = new Set(strokeBreaksDecimated);
    samples.forEach((s,i) => {
      posArr[i*3]=s.x; posArr[i*3+1]=s.y; posArr[i*3+2]=s.z;
      normArr[i*3]=s.nx; normArr[i*3+1]=s.ny; normArr[i*3+2]=s.nz;
      breakArr[i] = breakSet.has(i) ? 1 : 0;
    });
    this.vecUniforms.set(posName,   { data: posArr,   size: 3 });
    this.vecUniforms.set(normName,  { data: normArr,  size: 3 });
    this.vecUniforms.set(breakName, { data: breakArr, size: 1 });
    this.intUniforms.set(countName, samples.length);

    this._maskFnDecls.push(`
// maskDist ${fn}  (node ${node.id}, true min distance)
uniform vec3  ${posName}[${GLSL_MASK_CAP}];
uniform vec3  ${normName}[${GLSL_MASK_CAP}];
uniform float ${breakName}[${GLSL_MASK_CAP}];
uniform int   ${countName};
float ${fn}(vec3 p) {
  if (length(p - vec3(${boundCx}, ${boundCy}, ${boundCz})) > ${boundSpread} + ${radius}) return 1e6;
  float best = 1e6;
  for (int i = 0; i < ${GLSL_MASK_CAP}; i++) {
    if (i >= ${countName}) break;
    bool isStart = (i == 0) || (${breakName}[i] > 0.5);
    bool isEnd = (i == ${countName} - 1);
    if (!isEnd && (i + 1 < ${GLSL_MASK_CAP}) && ${breakName}[i + 1] > 0.5) isEnd = true;

    if (isStart && isEnd) {
      vec3 dd = p - ${posName}[i];
      float dist = length(dd);
      if (dist < ${radius} && dist < best) {
        float nDot = dist > 1e-6 ? dot(dd, ${normName}[i]) / dist : 0.0;
        bool pass = ${nThresh} >= 1.0 ? true : (abs(nDot) <= ${nThresh});
        if (pass) best = dist;
      }
    } else if (!isEnd) {
      vec3 a = ${posName}[i];
      vec3 b = ${posName}[i + 1];
      vec3 ab = b - a;
      float abLenSq = dot(ab, ab);
      vec3 ap = p - a;
      float tt = abLenSq > 1e-10 ? clamp(dot(ap, ab) / abLenSq, 0.0, 1.0) : 0.0;
      vec3 c = a + ab * tt;
      vec3 dd = p - c;
      float dist = length(dd);
      if (dist < ${radius} && dist < best) {
        vec3 na = ${normName}[i];
        vec3 nb = ${normName}[i + 1];
        vec3 ni = na + (nb - na) * tt;
        float nlen = max(length(ni), 1e-6);
        float nDot = dist > 1e-6 ? dot(dd, ni / nlen) / dist : 0.0;
        bool pass = ${nThresh} >= 1.0 ? true : (abs(nDot) <= ${nThresh});
        if (pass) best = dist;
      }
    }
  }
  return best;
}`);

    return fn;
  }

  /**
   * Self-corrects an embedNode's anchor onto the host's CURRENT surface,
   * via a few Newton iterations against a throwaway CPU NodeEvaluator over
   * the same graph. Only used at shader-generation time (i.e., not on
   * every frame) — cheap enough to run each time the graph changes, and
   * guarantees GLSL bakes the same corrected anchor the CPU evaluator
   * would independently arrive at.
   */
  
  /**
   * Compute the FIXED local frame (c0, T, B, N) at an embedNode's anchor —
   * the GLSL-generation-time counterpart to NodeEvaluator's CPU frame
   * computation. Refines the anchor onto the host's current surface (same
   * Newton iteration as before), then builds the tangent frame ONCE there
   * via a throwaway CPU evaluator. Re-runs whenever the shader source is
   * regenerated (any graph/param change), keeping GLSL and CPU visually
   * identical through resizes, moves, and rotations.
   */
  /**
   * BUGFIX: the previous version computed `curvature` locally but never
   * included it in this function's return object — `frame.curvature` at
   * the _generateEmbedNode call site was therefore always undefined, and
   * curvatureStr always baked as 0. GLSL's "curvature correction" has been
   * a silent no-op in every prior version despite matching CPU comments
   * claiming parity. Now returns Sxx/Sxy/Syy (Tier 1) instead — computed
   * in this SAME frame's (tangent,bitangent) basis, so they are guaranteed
   * aligned with the T0/B0 this function also returns, by construction.
   */
  _computeEmbedFrameField(hostNodeId, anchor, regionSize, cacheKey) {
    const hostNode = this.graph.nodes.get(hostNodeId);
    const fingerprint = JSON.stringify({
      hostNodeId, anchor, regionSize,
      hostParams: hostNode?.params, hostTransform: hostNode?.transform,
    });
    const cached = this._embedFrameCache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprint) {
      return { frames: cached.frames, bandwidth: cached.bandwidth };
    }

    const fallbackFrames = [{
      c0: anchor, T: {x:1,y:0,z:0}, B: {x:0,y:0,z:1}, N: {x:0,y:1,z:0},
      Sxx: 0, Sxy: 0, Syy: 0,
    }];
    let out;
    try {
      const tempEval = new NodeEvaluator(this.graph);
      const hostResult = tempEval.evaluate(hostNodeId);
      const hostFn = hostResult?.sdf || hostResult?.result;
      if (typeof hostFn !== 'function') {
        out = { frames: fallbackFrames, bandwidth: defaultFrameBandwidth(regionSize, 1) };
      } else {
        // No maxFrames cap here — buildAdaptiveFrameField enforces its own
        // default cap internally. Do NOT re-truncate here; that would be a
        // second, independent capping rule risking drift from the CPU path
        // (see frameField.js's module header).
        let frames;
        try {
          frames = buildAdaptiveFrameField(hostFn, anchor, regionSize);
        } catch (e) {
          frames = fallbackFrames;
        }
        out = { frames, bandwidth: defaultFrameBandwidth(regionSize, frames.length) };
      }
    } catch (e) {
      out = { frames: fallbackFrames, bandwidth: defaultFrameBandwidth(regionSize, 1) };
    }

    // KNOWN LIMITATION: the fingerprint covers the host node's OWN
    // params/transform, not further-upstream nodes feeding it. If the
    // host is itself fed by another node (e.g. noiseDisplace over a
    // sphere) and you edit the upstream sphere without touching the host
    // or the embed's own anchor/regionSize, this cache can go briefly
    // stale. Acceptable for now; a full fix needs a graph-wide dirty
    // counter.
    this._embedFrameCache.set(cacheKey, { fingerprint, ...out });
    return out;
  }

  /**
   * GLSL counterpart to NodeEvaluator._buildTilingFoldFn — emits inline
   * GLSL statements that fold `p` into `foldedP`, one lattice type at a
   * time. Kept separate from tilingNode's own _generate2DNode case (same
   * reasoning as the CPU side): both need slightly different surrounding
   * context, so a small amount of duplication here is simpler than a
   * forced shared abstraction.
   */
  _buildTilingFoldGLSL(tilingNode) {
    const p = tilingNode.params;
    const lattice = p.lattice ?? 'square';
    const pX = this._f(p.periodX ?? 3);
    const pY = this._f(p.periodY ?? 3);
    const oX = this._f(p.offsetX ?? 0);
    const oY = this._f(p.offsetY ?? 0);
    const finite = (p.extent ?? 'infinite') === 'finite';
    const hx = this._f(Math.floor(Math.round(p.countX ?? 3) / 2));
    const hy = this._f(Math.floor(Math.round(p.countY ?? 3) / 2));

    if (finite) {
      if (lattice === 'hexagonal' || lattice === 'triangular') {
        const div = lattice === 'triangular' ? '1.7320508' : '1.0';
        return `
  { float x = foldedP.x - ${oX}; float y = foldedP.y - ${oY};
    float p2=${pX}/${div};
    float a1x=p2; float a1y=0.0; float a2x=p2*0.5; float a2y=p2*0.8660254;
    float det=a1x*a2y-a1y*a2x;
    float u=(a2y*x-a2x*y)/det; float v=(-a1y*x+a1x*y)/det;
    float ru=clamp(floor(u+0.5),-${hx},${hx});
    float rv=clamp(floor(v+0.5),-${hy},${hy});
    foldedP.x = x-(ru*a1x+rv*a2x); foldedP.y = y-(ru*a1y+rv*a2y); }`;
      }
      if (lattice === 'brick') {
        return `
  { float x = foldedP.x - ${oX}; float y = foldedP.y - ${oY};
    float rowIdx=clamp(floor(y/${pY}+0.5),-${hy},${hy});
    float xOff=(mod(rowIdx,2.0)==0.0)?0.0:${pX}*0.5;
    float ix=clamp(floor((x+xOff)/${pX}+0.5),-${hx},${hx});
    foldedP.x = x-ix*${pX}-xOff; foldedP.y = y-rowIdx*${pY}; }`;
      }
      return `
  { float x = foldedP.x - ${oX}; float y = foldedP.y - ${oY};
    float ix=clamp(floor(x/${pX}+0.5),-${hx},${hx});
    float iy=clamp(floor(y/${pY}+0.5),-${hy},${hy});
    foldedP.x = x-ix*${pX}; foldedP.y = y-iy*${pY}; }`;
    }
    // Infinite lattices — same fold formulas as tilingNode's own
    // _generate2DNode case, just written into foldedP instead of x/y locals.
    if (lattice === 'hexagonal' || lattice === 'triangular') {
      const div = lattice === 'triangular' ? '1.7320508' : '1.0';
      return `
  { float x = foldedP.x - ${oX}; float y = foldedP.y - ${oY};
    float p2=${pX}/${div};
    float a1x=p2; float a1y=0.0; float a2x=p2*0.5; float a2y=p2*0.8660254;
    float det=a1x*a2y-a1y*a2x;
    float u=(a2y*x-a2x*y)/det; float v=(-a1y*x+a1x*y)/det;
    foldedP.x = x-(floor(u+0.5)*a1x+floor(v+0.5)*a2x);
    foldedP.y = y-(floor(u+0.5)*a1y+floor(v+0.5)*a2y); }`;
    }
    if (lattice === 'brick') {
      return `
  { float x = foldedP.x - ${oX}; float y = foldedP.y - ${oY};
    float row=floor(mod(y+${pY}*0.5,${pY})/(${pY}*0.5));
    float xOff=mod(row,2.0)<0.5?0.0:${pX}*0.5;
    foldedP.x = mod(x+xOff+${pX}*0.5,${pX})-${pX}*0.5;
    foldedP.y = mod(y+${pY}*0.5,${pY})-${pY}*0.5; }`;
    }
    return `
  { float x = foldedP.x - ${oX}; float y = foldedP.y - ${oY};
    foldedP.x = mod(x+${pX}*0.5,${pX})-${pX}*0.5;
    foldedP.y = mod(y+${pY}*0.5,${pY})-${pY}*0.5; }`;
  }

  /**
   * Universally apply a node's own transform (posX/Y/Z, pivotX/Y/Z,
   * rotateX/Y/Z, scale) as a GLSL wrapper around its raw generated function.
   *
   * The raw function keeps its original name internally (renamed to
   * `<fn>_raw`); a new function under the ORIGINAL name (`<fn>`) is emitted
   * that applies the inverse transform to the query point, calls `_raw`,
   * and multiplies the result by scale. Every other node's generated code
   * calls inputs by their original unwrapped name, so this rename-and-wrap
   * is completely transparent to every call site in the graph — a node
   * either has a transform or it doesn't, and callers never need to know
   * which.
   *
   * Mirrors NodeEvaluator._applyNodeTransform exactly, just emitted as GLSL
   * text instead of a JS closure.
   */
  _wrapWithNodeTransform(node, glsl) {
    const t = node.transform;
    const identity = isIdentityTransform(t);
    // Universal mapper port — resolved here so it applies uniformly to
    // every node type that reaches this wrapper.
    const mapperInfo = this._resolveMapperInfo(node, 'mapper');
    const mapFn = mapperInfo?.fnName || null;

    // Universal painted-region gate for that mapper — mirrors
    // NodeEvaluator._applyNodeTransform's identical change exactly. A
    // node's OWN mask (painted directly on its own card) confines the
    // mapper's visible effect to the painted area.
    const maskFnName = mapFn ? this._maskFieldGLSL(node) : null;

    if (identity && !mapFn) return glsl;

    const fn      = this._fnName(node.id);
    const rawName = `${fn}_raw`;
    const wrapped = glsl.replace(new RegExp(`${fn}\\(`, 'g'), `${rawName}(`);

    const is3D = this._nodeOutputIs3D(node);

    const tx  = this._f(t.posX    ?? 0);
    const ty  = this._f(t.posY    ?? 0);
    const tz  = this._f(t.posZ    ?? 0);
    const pvx = this._f(t.pivotX  ?? 0);
    const pvy = this._f(t.pivotY  ?? 0);
    const pvz = this._f(t.pivotZ  ?? 0);
    const rx  = this._f(t.rotateX ?? 0);
    const ry  = this._f(t.rotateY ?? 0);
    const rz  = this._f(t.rotateZ ?? 0);
    const rawScale   = t.scale ?? 1;
    const safeScale  = Math.abs(rawScale) > 1e-6 ? rawScale : 1e-6;
    const sc  = this._f(safeScale);

    // Mapper applied to the LOCAL, PRE-SCALE distance value — matches
    // NodeEvaluator._applyNodeTransform's ordering exactly. When an
    // honest Lipschitz bound L is available, divide by it here so the
    // resulting value is safe for sphere tracing (see
    // _computeMapperLipschitz's doc comment for which mappers qualify).
    let mapLine = '';
    // Masked mapper reads the mask in the SAME local-space point `q` the
    // wrapper templates below already compute — for a 3D node q is vec3
    // and needs no adjustment; for a 2D node q is vec2, and the mask
    // function (always vec3-in, see _maskFieldGLSL) needs it lifted to
    // vec3(q, 0.0). is3D is computed just below this block in the
    // original source — see the full method for its declaration.
    const maskArg = is3D ? 'q' : 'vec3(q, 0.0)';
    if (mapFn && mapperInfo.lipschitz !== null) {
      const Lval = this._f(Math.max(mapperInfo.lipschitz, 1e-6));
      mapLine = maskFnName
        ? `{ float dMapped = ${mapFn}(d) / ${Lval}; float mw = ${maskFnName}(${maskArg}); d = mix(d, dMapped, mw); }`
        : `d = ${mapFn}(d); d = d / ${Lval};`;
    } else if (mapFn) {
      // No rigorous bound available for this mapper type (exponential/
      // logarithmic/power) — applied as-is. SceneManager's quality
      // heuristic still forces very conservative step sizes for these
      // three, which mitigates but does not mathematically guarantee
      // correctness.
      mapLine = maskFnName
        ? `{ float dMapped = ${mapFn}(d); float mw = ${maskFnName}(${maskArg}); d = mix(d, dMapped, mw); }`
        : `d = ${mapFn}(d);`;
    }

    let wrapperFn;
    if (is3D) {
      wrapperFn = `
// transform + mapper wrapper for node ${node.id}
float ${fn}(vec3 p) {
  vec3 q = p - vec3(${tx}, ${ty}, ${tz}) - vec3(${pvx}, ${pvy}, ${pvz});

  { float cz = cos(-${rz}); float sz = sin(-${rz});
    q = vec3(q.x*cz - q.y*sz, q.x*sz + q.y*cz, q.z); }
  { float cy = cos(-${ry}); float sy = sin(-${ry});
    q = vec3(q.x*cy + q.z*sy, q.y, -q.x*sy + q.z*cy); }
  { float cx = cos(-${rx}); float sx = sin(-${rx});
    q = vec3(q.x, q.y*cx - q.z*sx, q.y*sx + q.z*cx); }

  q = q / ${sc} + vec3(${pvx}, ${pvy}, ${pvz});
  float d = ${rawName}(q);
  ${mapLine}
  return d * ${sc};
}`;
    } else {
      wrapperFn = `
// transform + mapper wrapper for node ${node.id}
float ${fn}(vec2 p) {
  vec2 q = p - vec2(${tx}, ${ty}) - vec2(${pvx}, ${pvy});
  { float c = cos(-${rz}); float s = sin(-${rz});
    q = vec2(q.x*c - q.y*s, q.x*s + q.y*c); }
  q = q / ${sc} + vec2(${pvx}, ${pvy});
  float d = ${rawName}(q);
  ${mapLine}
  return d * ${sc};
}`;
    }

    return wrapped + '\n' + wrapperFn;
  }

  // ── 3D node templates ─────────────────────────────────────────────────────

  _generate3DNode(node) {
    const fn = this._fnName(node.id);
    const p  = node.params;

    switch (node.type) {

      case 'sphere': {
        const r  = this._f(p.radius ?? 1);
        return `// sphere node ${node.id}
float ${fn}(vec3 p) {
  return length(p) - ${r};
}`;
      }

      case 'box': {
        const bx = this._f((p.width  ?? 2) / 2);
        const by = this._f((p.height ?? 2) / 2);
        const bz = this._f((p.depth  ?? 2) / 2);
        const cr = this._f(p.cornerRounding ?? 0);
        return `// box node ${node.id}
float ${fn}(vec3 p) {
  vec3 q = abs(p) - vec3(${bx}, ${by}, ${bz});
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - ${cr};
}`;
      }

      case 'cylinder': {
        const r      = this._f(p.radius ?? 1);
        const h      = this._f((p.height ?? 2) / 2);
        const capped = p.capped !== 'no';
        const cr     = this._f(p.cornerRounding ?? 0);
        // Always Y-axis, origin-centered. Orientation is now handled
        // entirely by the node's own transform.rotateX/Y/Z.
        if (!capped) {
          return `// cylinder (infinite) node ${node.id}
float ${fn}(vec3 p) {
  return length(vec2(p.x, p.z)) - ${r} - ${cr};
}`;
        }
        return `// cylinder (capped) node ${node.id}
float ${fn}(vec3 p) {
  vec2 d = vec2(length(vec2(p.x, p.z)) - ${r}, abs(p.y) - ${h});
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - ${cr};
}`;
      }

      case 'capsule': {
  const r    = this._f(p.radius ?? 0.5);
  const half = this._f((p.height ?? 2) / 2);

  return `// capsule node ${node.id}
  float ${fn}(vec3 p) {
    vec3 a  = vec3(0.0, -${half}, 0.0);
    vec3 b  = vec3(0.0,  ${half}, 0.0);
    vec3 pa = p - a;
    vec3 ba = b - a;
    float denom = max(dot(ba, ba), 1e-10);
    float t = clamp(dot(pa, ba) / denom, 0.0, 1.0);
    return length(pa - ba * t) - ${r};
  }`;
    }

      case 'torus': {
        const R  = this._f(p.majorRadius ?? 2);
        const r  = this._f(p.minorRadius ?? 0.5);
        return `// torus node ${node.id}
float ${fn}(vec3 p) {
  vec2 t  = vec2(length(vec2(p.x, p.z)) - ${R}, p.y);
  return length(t) - ${r};
}`;
      }

      case 'cone': {
        const r    = this._f(p.radius ?? 1);
        const h    = this._f(p.height ?? 2);

        return `// cone node ${node.id}
float ${fn}(vec3 p) {
  vec3  q    = p;
  float rba  = -${r};
  float baba = ${h} * ${h};
  float paba = q.y / ${h};
  float x    = length(vec2(q.x, q.z));
  float cax  = max(0.0, x - ${r} * (1.0 - clamp(paba, 0.0, 1.0)));
  float cay  = abs(paba - 0.5) - 0.5;
  float k    = rba*rba + baba;
  float f    = clamp((rba*(x-${r}) + paba*baba)/k, 0.0, 1.0);
  float cbx  = x - ${r} - f*rba;
  float cby  = paba - f;
  float s    = (cbx < 0.0 && cay < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(cax*cax + cay*cay*baba,
                      cbx*cbx + cby*cby*baba));
}`;
      }

      case 'plane': {
        const nx  = this._f(p.nx     ?? 0);
        const ny  = this._f(p.ny     ?? 1);
        const nz  = this._f(p.nz     ?? 0);
        const off = this._f(p.offset ?? 0);
        return `// plane node ${node.id}
float ${fn}(vec3 p) {
  return dot(p, normalize(vec3(${nx}, ${ny}, ${nz}))) - ${off};
}`;
      }

      default:
        return this._fallback3D(fn, node.id, `unknown 3D type: ${node.type}`);
    }
  }

  // ── Bridge node templates (2D input → 3D output) ──────────────────────────

  _generateBridgeNode(node) {
    const fn = this._fnName(node.id);
    const p  = node.params;

    switch (node.type) {

      case 'extrudeNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'extrudeNode missing sdf');

        // Check if input is 3D — extruding a 3D solid would be 4D (v2+)
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        if (baseNode && this._nodeOutputIs3D(baseNode)) {
          console.warn(
            `ExtrudeNode ${node.id}: input is a 3D solid (${baseNode.type}). ` +
            `Extruding a 3D solid into a 4th dimension is not supported in isoline v1. ` +
            `Connect a 2D primitive (circle, polygon, arc) to Extrude instead. ` +
            `4D operations are planned for isoline v2.`
          );
          return this._fallback3D(fn, node.id,
            `extrudeNode: 3D→4D not supported in v1. Connect a 2D shape.`
          );
        }

        const h = this._f((p.height ?? 1) / 2);
        return `// extrudeNode ${node.id}  (height=${this._f(p.height ?? 1)})
float ${fn}(vec3 p) {
  float d2 = ${inputFn}(p.xy);
  float dz = abs(p.z) - ${h};
  return min(max(d2, dz), 0.0) + length(max(vec2(d2, dz), 0.0));
}`;
      }

      case 'revolveNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'revolveNode missing sdf');

        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        if (baseNode && this._nodeOutputIs3D(baseNode)) {
          console.warn(
            `RevolveNode ${node.id}: input is a 3D solid (${baseNode.type}). ` +
            `Revolving a 3D solid is not supported in isoline v1. ` +
            `Connect a 2D primitive (circle, polygon, line) to Revolve instead. ` +
            `Advanced revolution operations are planned for isoline v2.`
          );
          return this._fallback3D(fn, node.id,
            `revolveNode: 3D input not supported in v1. Connect a 2D shape.`
          );
        }

        const off  = this._f(p.offset ?? 0);
        const axis = p.axis ?? 'Y';

        // For each axis, compute the radial distance from that axis (q)
        // and the axial coordinate (h), then evaluate the 2D profile SDF
        // at (q, h). This is the standard surface-of-revolution formula
        // applied to whichever world axis the user selected.
        // Y (default): revolves around the vertical axis — profile in XY
        //              plane, sweeping around Y, same as a standard lathe.
        // X: revolves around the horizontal axis — useful for shapes that
        //    are naturally described in side view (a dome, an arch profile).
        // Z: revolves around the depth axis — useful for front-facing profiles.
        if (axis === 'X') {
          return `// revolveNode (axis=X) ${node.id}
float ${fn}(vec3 p) {
  float q = length(vec2(p.y, p.z)) - ${off};
  return ${inputFn}(vec2(q, p.x));
}`;
        } else if (axis === 'Z') {
          return `// revolveNode (axis=Z) ${node.id}
float ${fn}(vec3 p) {
  float q = length(vec2(p.x, p.y)) - ${off};
  return ${inputFn}(vec2(q, p.z));
}`;
        } else {
          return `// revolveNode (axis=Y) ${node.id}
float ${fn}(vec3 p) {
  float q = length(vec2(p.x, p.z)) - ${off};
  return ${inputFn}(vec2(q, p.y));
}`;
        }
      }

      default:
        return this._fallback3D(fn, node.id, `unknown bridge type: ${node.type}`);
    }
  }

  // ── 2D node templates ─────────────────────────────────────────────────────

  _generate2DNode(node, mode) {
    // NOTE: the `mode` parameter ('2d'|'3d') is not used for source geometry
    // nodes (circle, polygon, arc etc) because they are always 2D by definition.
    // For transform nodes, dimension is determined by _nodeOutputIs3D() which
    // walks the graph to detect whether the input chain is 3D.
    // The `mode` parameter is retained for future use (e.g. generating
    // dimension-specific variants of mapper nodes in a later version).
    const fn = this._fnName(node.id);
    const p  = node.params;

    switch (node.type) {

      // ── Region primitives (exact SDF, negative inside) ──────────────────

      case 'circle': {
        const r  = this._f(p.radius ?? 1);
        return `// circle node ${node.id}
float ${fn}(vec2 p) {
  return length(p) - ${r};
}`;
      }

      case 'regularPolygon': {
        const N    = Math.max(3, Math.round(p.sides ?? 6));
        const size = this._f(p.size     ?? 1);
        // The + π/2 offset is baked in purely so the polygon's flat top
        // faces up by default — a fixed visual convention, not user rotation
        // (use transform.rotateZ for that).
        const rot  = this._f(Math.PI / 2);
        const apo  = this._f(Math.cos(Math.PI / N));
        const sec  = this._f((Math.PI * 2) / N);
        return `// regularPolygon node ${node.id}  (${N} sides)
float ${fn}(vec2 p) {
  vec2 q = p;
  // NOTE: rotating by +rot here (NOT cos(-rot)/sin(-rot) as this
  // previously read) — the negated version rotated the opposite direction
  // from the CPU NodeEvaluator implementation, causing GLSL (Ray March)
  // and CPU (Marching Squares) rendering of the same node to disagree by
  // 180°. Fixed to match CPU exactly.
  float c = cos(${rot}); float s = sin(${rot});
  q = vec2(q.x*c - q.y*s, q.x*s + q.y*c);
  float sector = ${sec};
  float a = atan(q.y, q.x);
  a = a - sector * floor(a / sector + 0.5);
  float r = length(q);
  return r * cos(a) - ${size} * ${apo};
}`;
      }

      case 'polytope': {
        let verts;
        try {
          verts = typeof p.vertices === 'string' ? JSON.parse(p.vertices) : p.vertices;
          if (!Array.isArray(verts) || verts.length < 3) throw new Error();
        } catch(_) {
          verts = [[-1,-1],[1,-1],[1,1],[-1,1]];
        }
        const N   = verts.length;
        const vertLines = verts.map(([x,y],i) =>
          `  vec2 v${i} = vec2(${this._f(x)}, ${this._f(y)});`
        ).join('\n');
        const edgeLines = Array.from({length:N},(_,i) => {
          const j = (i+1)%N;
          return `  { vec2 e=v${j}-v${i}; vec2 n=vec2(e.y,-e.x);` +
                 ` maxD=max(maxD, dot(lp-v${i},normalize(n))); }`;
        }).join('\n');
        return `// polytope node ${node.id}  (${N} verts)
float ${fn}(vec2 p) {
  vec2 lp=p;
${vertLines}
  float maxD=-1e10;
${edgeLines}
  return maxD;
}`;
      }

      // ── Curve primitives (SDF >= 0, needs isoOffset) ─────────────────────

      case 'triangle': {
        const sz  = this._f(p.size           ?? 1);
        const h   = this._f((p.size ?? 1) * Math.sqrt(3) / 2);
        const cr  = this._f(p.cornerRounding ?? 0);
        return `// triangle node ${node.id}
float ${fn}(vec2 p) {
  vec2 q=p;
  float h=${h};
  vec2 v0=vec2(0.0, h*0.6667);
  vec2 v1=vec2(-${sz}*0.5,-h*0.3333);
  vec2 v2=vec2( ${sz}*0.5,-h*0.3333);
  vec2 e0=v1-v0; vec2 e1=v2-v1; vec2 e2=v0-v2;
  float d0=length(q-v0-e0*clamp(dot(q-v0,e0)/dot(e0,e0),0.0,1.0));
  float d1=length(q-v1-e1*clamp(dot(q-v1,e1)/dot(e1,e1),0.0,1.0));
  float d2=length(q-v2-e2*clamp(dot(q-v2,e2)/dot(e2,e2),0.0,1.0));
  return min(d0,min(d1,d2)) - ${cr};
}`;
      }

      case 'arc': {
        const r  = this._f(p.radius     ?? 1);
        const sa = this._f(p.startAngle ?? 0);
        const ea = this._f(p.endAngle   ?? Math.PI);
        return `// arc node ${node.id}
float ${fn}(vec2 p) {
  vec2 q=p;
  float phi=atan(q.y,q.x);
  float sweep=${ea}-${sa};
  float phiN=mod(phi-${sa},6.2831853);
  if(phiN<=sweep){ return abs(length(q)-${r}); }
  vec2 ps=vec2(${r}*cos(${sa}),${r}*sin(${sa}));
  vec2 pe=vec2(${r}*cos(${ea}),${r}*sin(${ea}));
  return min(length(q-ps),length(q-pe));
}`;
      }

      case 'lineSegment': {
        const x1 = this._f(p.x1 ?? 0);
        const y1 = this._f(p.y1 ?? 0);
        const x2 = this._f(p.x2 ?? 1);
        const y2 = this._f(p.y2 ?? 0);
        return `// lineSegment node ${node.id}
float ${fn}(vec2 p) {
  vec2 a=vec2(${x1},${y1}); vec2 b=vec2(${x2},${y2});
  vec2 pa=p-a; vec2 ba=b-a;
  float t=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0);
  return length(pa-ba*t);
}`;
      }

      // ── Blend nodes ───────────────────────────────────────────────────────

      case 'rUnion':
      case 'rIntersection':
      case 'rDifference':
      case 'rBlend':
        return this._generateBinaryBlendNode(node);

      case 'morphBlend': {
        const fnA = this._resolveInputFn(node, 'sdfA');
        const fnB = this._resolveInputFn(node, 'sdfB');
        if (!fnA || !fnB) {
          return this._fallbackAdaptive(fn, node.id, 'morphBlend missing inputs', this._nodeOutputIs3D(node));
        }

        const edgeA = this.graph.getIncomingEdge(node.id, 'sdfA');
        const edgeB = this.graph.getIncomingEdge(node.id, 'sdfB');
        const nodeA = edgeA ? this.graph.nodes.get(edgeA.fromNode) : null;
        const nodeB = edgeB ? this.graph.nodes.get(edgeB.fromNode) : null;
        const aIs3D = nodeA && this._nodeOutputIs3D(nodeA);
        const bIs3D = nodeB && this._nodeOutputIs3D(nodeB);
        const dim   = (aIs3D || bIs3D) ? 'vec3' : 'vec2';

        const animated = (p.animated ?? 'no') === 'yes';
        const speed = this._f(p.speed ?? 0.8);
        // Matches the CPU formula exactly: (sin(time*speed)+1)/2 stays in [0,1].
        const tExpr = animated ? `((sin(uTime * ${speed}) + 1.0) * 0.5)` : this._f(p.t ?? 0.5);
        const callA = dim === 'vec3' ? (aIs3D ? 'p' : 'p.xy') : 'p';
        const callB = dim === 'vec3' ? (bIs3D ? 'p' : 'p.xy') : 'p';

        // Painted-region gate — mirrors rUnion/rIntersection/rDifference/
        // rBlend's identical maskFrom treatment above.
        const maskFrom = p.maskFrom ?? 'none';
        const gateHostNode = maskFrom === 'sdfB' ? nodeB : maskFrom === 'sdfA' ? nodeA : null;
        const maskFnName = gateHostNode ? this._maskFieldGLSL(gateHostNode) : null;
        const maskQueryArg = dim === 'vec3' ? 'p' : 'vec3(p, 0.0)';

        return `// morphBlend node ${node.id}
float ${fn}(${dim} p) {
  float t = ${tExpr};
  float dA = ${fnA}(${callA});
  float dB = ${fnB}(${callB});
  float morphed = mix(dA, dB, t);
${maskFnName ? `  float mw = ${maskFnName}(${maskQueryArg});
  float base = ${maskFrom === 'sdfB' ? 'dB' : 'dA'};
  return base + (morphed - base) * mw;` : '  return morphed;'}
}`;
      }

      case 'schurBlend': {
        const fnA = this._resolveInputFn(node, 'sdfA');
        const fnB = this._resolveInputFn(node, 'sdfB');
        if (!fnA || !fnB) {
          return this._fallbackAdaptive(fn, node.id, 'schurBlend missing inputs', this._nodeOutputIs3D(node));
        }

        const op  = p.operation  ?? 'union';
        const sm  = this._f(p.smoothness ?? 8);
        const iso = this._f(p.isoOffset  ?? 0.15);

        // No affine transform here anymore — placing/rotating/scaling the
        // blended result is now the job of this node's own universal
        // transform (applied by _wrapWithNodeTransform AFTER this raw
        // generator runs). Mathematically equivalent to the old approach.

        const REGION = new Set(['circle','regularPolygon','polytope',
                                'sphere','box','cylinder','capsule','torus','cone','plane']);
        const edgeA  = this.graph.getIncomingEdge(node.id, 'sdfA');
        const edgeB  = this.graph.getIncomingEdge(node.id, 'sdfB');
        const nodeA  = edgeA ? this.graph.nodes.get(edgeA.fromNode) : null;
        const nodeB  = edgeB ? this.graph.nodes.get(edgeB.fromNode) : null;
        const offA   = (nodeA && REGION.has(nodeA.type)) ? '0.0' : iso;
        const offB   = (nodeB && REGION.has(nodeB.type)) ? '0.0' : iso;

        const blendCall =
          op === 'intersection' ? `rIntersection(dA,dB,${sm})` :
          op === 'difference'   ? `rDifference(dA,dB,${sm})`   :
                                  `rUnion(dA,dB,${sm})`;
        const aIs3D = nodeA && this._nodeOutputIs3D(nodeA);
        const bIs3D = nodeB && this._nodeOutputIs3D(nodeB);
        const dim   = (aIs3D || bIs3D) ? 'vec3' : 'vec2';
        const bothRegion = (nodeA && REGION.has(nodeA.type)) &&
                           (nodeB && REGION.has(nodeB.type));
        const outputOff  = bothRegion ? iso : '0.0';
        return `// schurBlend node ${node.id}  (${op})
float ${fn}(${dim} p) {
  float dA=${fnA}(${aIs3D ? 'p' : dim==='vec3'?'p.xy':'p'})-${offA};
  float dB=${fnB}(${bIs3D ? 'p' : dim==='vec3'?'p.xy':'p'})-${offB};
  return ${blendCall} - ${outputOff};
}`;
      }

      // ── Transform nodes ───────────────────────────────────────────────────

      case 'tilingNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback2D(fn, node.id, 'tilingNode missing sdf');

        const lattice = p.lattice    ?? 'square';
        const pX      = this._f(p.periodX   ?? 3);
        const pY      = this._f(p.periodY   ?? 3);
        const pZ      = this._f(p.periodZ   ?? 3);
        const oX      = this._f(p.offsetX   ?? 0);
        const oY      = this._f(p.offsetY   ?? 0);
        const iso     = this._f(p.isoOffset ?? 0);
        // extent/count params: this whole block previously did NOT exist
        // in this file — the Tiling/Repeat merge landed in NodeSpec.js and
        // NodeEvaluator.js but was never applied here, so GLSL tilingNode
        // had no finite-extent capability at all until now.
        const finite  = (p.extent ?? 'infinite') === 'finite';
        const hx      = this._f(Math.floor(Math.round(p.countX ?? 3) / 2));
        const hy      = this._f(Math.floor(Math.round(p.countY ?? 3) / 2));
        const hz      = this._f(Math.floor(Math.round(p.countZ ?? 1) / 2));

        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const CURVE    = new Set(['lineSegment','triangle','arc']);
        const isCurve  = baseNode && CURVE.has(baseNode.type);
        const isoLine  = `  d = d - ${iso};`;

        const is3D = baseNode && this._nodeOutputIs3D(baseNode);
        const dim  = is3D ? 'vec3' : 'vec2';

        let foldBody;
        if (finite) {
          // Finite: clamp-round (parity with the old standalone repeatNode's
          // square grid). Hex/triangular/brick clamp their integer lattice
          // indices the same way — an approximation for those three (see
          // NodeEvaluator.js's matching CPU comment), not a perfectly
          // hex/brick-shaped bounded region.
          if (lattice === 'hexagonal' || lattice === 'triangular') {
            const div = lattice === 'triangular' ? '1.7320508' : '1.0';
            foldBody = `
  float p2=${pX}/${div};
  float a1x=p2; float a1y=0.0;
  float a2x=p2*0.5; float a2y=p2*0.8660254;
  float det=a1x*a2y-a1y*a2x;
  float u=(a2y*x-a2x*y)/det; float v=(-a1y*x+a1x*y)/det;
  float ru=clamp(floor(u+0.5),-${hx},${hx});
  float rv=clamp(floor(v+0.5),-${hy},${hy});
  x=x-(ru*a1x+rv*a2x);
  y=y-(ru*a1y+rv*a2y);`;
          } else if (lattice === 'brick') {
            foldBody = `
  float rowIdx=clamp(floor(y/${pY}+0.5),-${hy},${hy});
  float xOff=(mod(rowIdx,2.0)==0.0)?0.0:${pX}*0.5;
  float ix=clamp(floor((x+xOff)/${pX}+0.5),-${hx},${hx});
  x=x-ix*${pX}-xOff;
  y=y-rowIdx*${pY};`;
          } else {
            foldBody = `
  float ix=clamp(floor(x/${pX}+0.5),-${hx},${hx});
  float iy=clamp(floor(y/${pY}+0.5),-${hy},${hy});
  x=x-ix*${pX};
  y=y-iy*${pY};`;
          }
        } else if (lattice === 'hexagonal') {
          foldBody = `
  float a1x=${pX}; float a1y=0.0;
  float a2x=${pX}*0.5; float a2y=${pX}*0.8660254;
  float det=a1x*a2y-a1y*a2x;
  float u=(a2y*x-a2x*y)/det; float v=(-a1y*x+a1x*y)/det;
  x=x-(floor(u+0.5)*a1x+floor(v+0.5)*a2x);
  y=y-(floor(u+0.5)*a1y+floor(v+0.5)*a2y);`;
        } else if (lattice === 'triangular') {
          foldBody = `
  float p2=${pX}/1.7320508;
  float a1x=p2; float a1y=0.0;
  float a2x=p2*0.5; float a2y=p2*0.8660254;
  float det=a1x*a2y-a1y*a2x;
  float u=(a2y*x-a2x*y)/det; float v=(-a1y*x+a1x*y)/det;
  x=x-(floor(u+0.5)*a1x+floor(v+0.5)*a2x);
  y=y-(floor(u+0.5)*a1y+floor(v+0.5)*a2y);`;
        } else if (lattice === 'brick') {
          foldBody = `
  float row=floor(mod(y+${pY}*0.5,${pY})/(${pY}*0.5));
  float xOff=mod(row,2.0)<0.5?0.0:${pX}*0.5;
  x=mod(x+xOff+${pX}*0.5,${pX})-${pX}*0.5;
  y=mod(y+${pY}*0.5,${pY})-${pY}*0.5;`;
        } else {
          foldBody = `
  x=mod(x+${pX}*0.5,${pX})-${pX}*0.5;
  y=mod(y+${pY}*0.5,${pY})-${pY}*0.5;`;
        }

        // Z — only touched when finite; infinite leaves Z completely
        // unchanged for full backward compatibility with every pre-merge
        // scene (matches NodeEvaluator.js's CPU case exactly).
        const zExpr = finite
          ? `p.z - clamp(floor(p.z/${pZ}+0.5),-${hz},${hz})*${pZ}`
          : `p.z`;

        const callExpr = is3D
          ? `${inputFn}(vec3(x+${oX},y+${oY},${zExpr}))`
          : `${inputFn}(vec2(x+${oX},y+${oY}))`;

        return `// tilingNode ${node.id}  (${lattice}, extent=${finite ? 'finite' : 'infinite'})
float ${fn}(${dim} p) {
  float x=p.x-${oX}; float y=p.y-${oY};
${foldBody}
  float d=${callExpr};
${isoLine}
  return d;
}`;
      }

      case 'symmetryFoldNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback2D(fn, node.id, 'symmetryFoldNode missing sdf');

        const folds  = Math.max(1, Math.round(p.folds ?? 6));
        const cx     = this._f(p.foldCenterX  ?? 0);
        const cy     = this._f(p.foldCenterY  ?? 0);
        const rot    = this._f(p.rotation ?? 0);
        const refX   = p.reflectX === 'yes';
        const refY   = p.reflectY === 'yes';
        const sector = this._f((Math.PI * 2) / folds);

        // Detect if input is 3D — fold only XY, preserve Z
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const is3D     = baseNode && this._nodeOutputIs3D(baseNode);
        const dim      = is3D ? 'vec3' : 'vec2';

        const rotBlock = (p.rotation ?? 0) !== 0 ? `
  float cR=cos(-${rot}); float sR=sin(-${rot});
  float xr=x*cR-y*sR; float yr=x*sR+y*cR; x=xr; y=yr;` : '';

        const callExpr = is3D
          ? `${inputFn}(vec3(x+${cx},y+${cy},p.z))`
          : `${inputFn}(vec2(x+${cx},y+${cy}))`;

        return `// symmetryFoldNode ${node.id}  (${folds}-fold)
float ${fn}(${dim} p) {
  float x=p.x-${cx}; float y=p.y-${cy};
${rotBlock}
  float sector=${sector};
  float a=atan(y,x);
  a=a-sector*floor(a/sector+0.5);
  float r=length(vec2(x,y));
  x=r*cos(a); y=r*sin(a);
  ${refX?'x=abs(x);':''} ${refY?'y=abs(y);':''}
  return ${callExpr};
}`;
      }

      case 'symmetryOrbitNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback2D(fn, node.id, 'symmetryOrbitNode missing sdf');

        const folds    = Math.max(1, Math.round(p.folds ?? 6));
        const cx       = this._f(p.orbitCenterX   ?? 0);
        const cy       = this._f(p.orbitCenterY   ?? 0);
        const rot      = this._f(p.rotation  ?? 0);
        const refX     = p.reflectX === 'yes';
        const combiner = p.combiner ?? 'min';
        const sm       = this._f(p.smoothness ?? 8);
        const sector   = this._f((Math.PI * 2) / folds);

        // Detect 3D input — orbit folds XY only, preserves Z
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const is3D     = baseNode && this._nodeOutputIs3D(baseNode);
        const dim      = is3D ? 'vec3' : 'vec2';

        const combineExpr =
          combiner === 'max'       ? 'max(d,di)'           :
          combiner === 'smoothMin' ? `rUnion(d,di,${sm})`  :
                                     'min(d,di)';

        // Build the inner call expression depending on dimension
        const makeCall = (tpExpr) => is3D
          ? `${inputFn}(vec3(${tpExpr},p.z))`
          : `${inputFn}(vec2(${tpExpr}))`;

        const fwdCall = makeCall(`dx*c-dy*s+${cx},dx*s+dy*c+${cy}`);
        const reflCall = refX
          ? makeCall(`-(dx*c-dy*s)+${cx},(dx*s+dy*c)+${cy}`)
          : null;

        const reflBlock = refX ? `
  for(int k=0;k<${folds};k++){
    float theta=${rot}+float(k)*sector;
    float c=cos(-theta); float s=sin(-theta);
    float dx=p.x-${cx}; float dy=p.y-${cy};
    float di=${reflCall}; d=${combineExpr};
  }` : '';

        return `// symmetryOrbitNode ${node.id}  (${folds}-fold)
float ${fn}(${dim} p) {
  float d=1e10; float sector=${sector};
  for(int k=0;k<${folds};k++){
    float theta=${rot}+float(k)*sector;
    float c=cos(-theta); float s=sin(-theta);
    float dx=p.x-${cx}; float dy=p.y-${cy};
    float di=${fwdCall}; d=${combineExpr};
  }
${reflBlock}
  return d;
}`;
      }

      case 'mobiusNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback2D(fn, node.id, 'mobiusNode missing sdf');

        // Wrap each coefficient in parentheses so that negative values
        // like -1.87 produce (1.0)*x+(-1.87)*y rather than 1.0*x--1.87*y.
        // The double-minus (--) is a GLSL parse error on some drivers even
        // though it is mathematically identical to subtraction.
        const aRe = `(${this._f(p.aRe ?? 1)})`;
        const aIm = `(${this._f(p.aIm ?? 0)})`;
        const bRe = `(${this._f(p.bRe ?? 0)})`;
        const bIm = `(${this._f(p.bIm ?? 0)})`;
        const cRe = `(${this._f(p.cRe ?? 0)})`;
        const cIm = `(${this._f(p.cIm ?? 0)})`;
        const dRe = `(${this._f(p.dRe ?? 1)})`;
        const dIm = `(${this._f(p.dIm ?? 0)})`;

        // Detect 3D input — Möbius operates on XY complex plane, preserves Z
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const is3D     = baseNode && this._nodeOutputIs3D(baseNode);
        const dim      = is3D ? 'vec3' : 'vec2';
        const callExpr = is3D
          ? `${inputFn}(vec3(tx,ty,p.z))`
          : `${inputFn}(vec2(tx,ty))`;

        // Use only addition throughout — all signs are carried by the
        // parenthesised coefficient literals, so no -- can ever appear.
        return `// mobiusNode ${node.id}
float ${fn}(${dim} p) {
  float x = p.x; float y = p.y;
  float nRe  = ${aRe}*x + (${this._f(-(p.aIm ?? 0))})*y + ${bRe};
  float nIm  = ${aRe}*y + ${aIm}*x + ${bIm};
  float dnRe = ${cRe}*x + (${this._f(-(p.cIm ?? 0))})*y + ${dRe};
  float dnIm = ${cRe}*y + ${cIm}*x + ${dIm};
  float denom = dnRe*dnRe + dnIm*dnIm;
  if (denom < 1e-10) return 1e10;
  float tx = (nRe*dnRe + nIm*dnIm) / denom;
  float ty = (nIm*dnRe - nRe*dnIm) / denom;
  return ${callExpr};
}`;
      }

      case 'noiseDisplaceNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallbackAdaptive(fn, node.id, 'noiseDisplace missing sdf', this._nodeOutputIs3D(node));

        // amplitude/frequency/speed are now UNIFORMS, not baked literals
        // — previously every slider tick changed the generated shader
        // SOURCE TEXT, correctly triggering a recompile (the diff check
        // itself was working as intended), but a recompile per drag
        // frame is exactly what made this node's sliders feel slow.
        const amp      = this._uniformFloat(node, 'ndAmplitude', node.params.amplitude ?? 0.3);
        const freq     = this._uniformFloat(node, 'ndFrequency', node.params.frequency ?? 3.0);
        const animated = (node.params.animated ?? 'no') === 'yes';
        const speedVal = this._uniformFloat(node, 'ndSpeed', node.params.speed ?? 0.4);

        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const is3D     = baseNode && this._nodeOutputIs3D(baseNode);
        const dim      = is3D ? 'vec3' : 'vec2';

        const useMaskFromInput = node.params.useMaskFromInput ?? 'no';
        const maskFnName = (useMaskFromInput === 'yes' && baseNode)
          ? this._maskFieldGLSL(baseNode)
          : null;

        const timeOffset = animated ? ` + uTime * ${speedVal}` : '';

        if (is3D) {
          const sampleCoord =
            `vec3(p.x * ${freq}, p.y * ${freq}, p.z * ${freq}${timeOffset})`;
          return `// noiseDisplaceNode ${node.id}  (3D, animated=${animated})
float ${fn}(vec3 p) {
  float baseVal = ${inputFn}(p);
  float n = ndNoise3(${sampleCoord}) * 2.0 - 1.0;
  float displaced = baseVal + n * ${amp};
${maskFnName ? `  float mw = ${maskFnName}(p);
  return baseVal + (displaced - baseVal) * mw;` : '  return displaced;'}
}`;
        } else {
          const sampleCoord =
            `vec2(p.x * ${freq}, p.y * ${freq}${timeOffset})`;
          return `// noiseDisplaceNode ${node.id}  (2D, animated=${animated})
float ${fn}(vec2 p) {
  float baseVal = ${inputFn}(p);
  float n = ndNoise2(${sampleCoord}) * 2.0 - 1.0;
  float displaced = baseVal + n * ${amp};
${maskFnName ? `  float mw = ${maskFnName}(vec3(p, 0.0));
  return baseVal + (displaced - baseVal) * mw;` : '  return displaced;'}
}`;
        }
      }

      case 'twistNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'twistNode missing sdf');
        const strength = this._uniformFloat(node, 'twistStrength', node.params.strength ?? 1.0);

        // Detect input dimension. Twist is inherently 3D (rotates XZ by Y).
        // For 2D input, we lift to 3D (z=0) so the operation is still valid.
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const inputIs3D = baseNode && this._nodeOutputIs3D(baseNode);
        const inputCall = inputIs3D ? `${inputFn}(tp)` : `${inputFn}(tp.xy)`;

        return `// twistNode ${node.id}
float ${fn}(vec3 p) {
  float angle = p.y * ${strength};
  float c = cos(angle); float s = sin(angle);
  vec3 tp = vec3(c*p.x - s*p.z, p.y, s*p.x + c*p.z);
  return ${inputCall};
}`;
      }

      case 'bendNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'bendNode missing sdf');
        const strength = this._uniformFloat(node, 'bendStrength', node.params.strength ?? 0.5);

        const edge      = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode  = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const inputIs3D = baseNode && this._nodeOutputIs3D(baseNode);
        const inputCall = inputIs3D ? `${inputFn}(tp)` : `${inputFn}(tp.xy)`;

        return `// bendNode ${node.id}
float ${fn}(vec3 p) {
  float angle = p.x * ${strength};
  float c = cos(angle); float s = sin(angle);
  vec3 tp = vec3(c*p.x - s*p.y, s*p.x + c*p.y, p.z);
  return ${inputCall};
}`;
      }

      case 'transform3DNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'transform3DNode missing sdf');

        const tx = this._f(p.posX    ?? 0);
        const ty = this._f(p.posY    ?? 0);
        const tz = this._f(p.posZ    ?? 0);
        const rx = this._f(p.rotateX ?? 0);
        const ry = this._f(p.rotateY ?? 0);
        const rz = this._f(p.rotateZ ?? 0);

        const edge      = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode  = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const inputIs3D = baseNode && this._nodeOutputIs3D(baseNode);
        const inputCall = inputIs3D ? `${inputFn}(q)` : `${inputFn}(q.xy)`;

        // Inverse transform applied to the query point — identical math to
        // the CPU evaluator (transform3DNode case in NodeEvaluator.js) and
        // to the output-level placement wrapper generated below in
        // generate(). Applied in order: translate, inverse-Z, inverse-Y,
        // inverse-X. Each step reassigns q from a vec3 constructor, so all
        // components on the right-hand side are read BEFORE any are
        // overwritten — sequential rotation composition is correct.
        return `// transform3DNode ${node.id}
float ${fn}(vec3 p) {
  vec3 q = p - vec3(${tx}, ${ty}, ${tz});

  // Inverse Z rotation (undo roll)
  { float cz = cos(-${rz}); float sz = sin(-${rz});
    q = vec3(q.x*cz - q.y*sz, q.x*sz + q.y*cz, q.z); }

  // Inverse Y rotation (undo yaw)
  { float cy = cos(-${ry}); float sy = sin(-${ry});
    q = vec3(q.x*cy + q.z*sy, q.y, -q.x*sy + q.z*cy); }

  // Inverse X rotation (undo pitch)
  { float cx = cos(-${rx}); float sx = sin(-${rx});
    q = vec3(q.x, q.y*cx - q.z*sx, q.y*sx + q.z*cx); }

  return ${inputCall};
}`;
      }

      case 'repeatNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallbackAdaptive(fn, node.id, 'repeatNode missing sdf', this._nodeOutputIs3D(node));
        const cX = Math.floor(node.params.countX  ?? 3);
        const cY = Math.floor(node.params.countY  ?? 3);
        const cZ = Math.floor(node.params.countZ  ?? 1);
        const sX = this._f(node.params.spacingX ?? 3);
        const sY = this._f(node.params.spacingY ?? 3);
        const sZ = this._f(node.params.spacingZ ?? 3);
        const hX = this._f(Math.floor(cX / 2));
        const hY = this._f(Math.floor(cY / 2));
        const hZ = this._f(Math.floor(cZ / 2));

        const edge      = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode  = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const inputIs3D = baseNode && this._nodeOutputIs3D(baseNode);

        if (!inputIs3D) {
          // 2D repeat — tile in XY plane only, ignore Z
          return `// repeatNode ${node.id}  (2D)
float ${fn}(vec2 p) {
  vec2 id = clamp(floor(p / vec2(${sX},${sY}) + 0.5),
                  vec2(-${hX},-${hY}),
                  vec2( ${hX}, ${hY}));
  vec2 rp = p - id * vec2(${sX},${sY});
  return ${inputFn}(rp);
}`;
        }

        return `// repeatNode ${node.id}  (3D)
float ${fn}(vec3 p) {
  vec3 id = clamp(floor(p / vec3(${sX},${sY},${sZ}) + 0.5),
                  vec3(-${hX},-${hY},-${hZ}),
                  vec3( ${hX}, ${hY}, ${hZ}));
  vec3 rp = p - id * vec3(${sX},${sY},${sZ});
  return ${inputFn}(rp);
}`;
      }

      // Nodes without GLSL representation — skip.
      // identityMapper/polynomialMapper/sinusoidalMapper/exponentialMapper/
      // logarithmicMapper/powerMapper removed from this list — they are now
      // intercepted earlier in _generateNode() via MAPPER_TYPES and never
      // reach this switch at all.
      case 'outputNode':
      case 'periodicMapper': case 'temporalMapper': case 'recursiveMapper':
      case 'blendedMapper': case 'compositeMapper': case 'affineTransform':
      case 'timeNode': case 'oscillatorNode':
        return null;

      default:
        return this._fallback2D(fn, node.id, `unknown 2D type: ${node.type}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _fnName(nodeId) { return `sdf_${nodeId}`; }

  _resolveInputFns(node, portNames) {
    const fns = [];
    for (const portName of portNames) {
      const edge = this.graph.getIncomingEdge(node.id, portName);
      if (!edge) return null;
      fns.push(this._fnName(edge.fromNode));
    }
    return fns;
  }

 _generateBinaryBlendNode(node) {
    const fn = this._fnName(node.id);
    const p  = node.params || {};

    const fnA = this._resolveInputFn(node, 'sdfA');
    const fnB = this._resolveInputFn(node, 'sdfB');
    if (!fnA || !fnB) {
      return this._fallbackAdaptive(fn, node.id, `${node.type} missing inputs`, this._nodeOutputIs3D(node));
    }

    const edgeA = this.graph.getIncomingEdge(node.id, 'sdfA');
    const edgeB = this.graph.getIncomingEdge(node.id, 'sdfB');
    const nodeA  = edgeA ? this.graph.nodes.get(edgeA.fromNode) : null;
    const nodeB  = edgeB ? this.graph.nodes.get(edgeB.fromNode) : null;

    const aIs3D = nodeA && this._nodeOutputIs3D(nodeA);
    const bIs3D = nodeB && this._nodeOutputIs3D(nodeB);
    const dim   = (aIs3D || bIs3D) ? 'vec3' : 'vec2';

    const sm = this._f(p.smoothness ?? 8);
    // rBlend reads its operation from a param (like schurBlend); the three
    // legacy standalone types still read it from node.type directly.
    const op = node.type === 'rBlend' ? (p.operation ?? 'union') : null;
    const blendCall =
      (node.type === 'rIntersection' || op === 'intersection') ? `rIntersection(dA, dB, ${sm})` :
      (node.type === 'rDifference'   || op === 'difference')   ? `rDifference(dA, dB, ${sm})`   :
                                                                  `rUnion(dA, dB, ${sm})`;

    const tpDecl = dim === 'vec3'
      ? 'vec3 tp = p;'
      : 'vec2 tp = p;';

    const callA = dim === 'vec3'
      ? (aIs3D ? 'tp' : 'tp.xy')
      : 'tp';

    const callB = dim === 'vec3'
      ? (bIs3D ? 'tp' : 'tp.xy')
      : 'tp';

    // Painted-region gate — mirrors NodeEvaluator's identical maskFrom
    // treatment for these same four node types.
    const maskFrom = p.maskFrom ?? 'none';
    const gateHostNode = maskFrom === 'sdfB' ? nodeB : maskFrom === 'sdfA' ? nodeA : null;
    const maskFnName = gateHostNode ? this._maskFieldGLSL(gateHostNode) : null;
    const maskQueryArg = dim === 'vec3' ? 'tp' : 'vec3(tp, 0.0)';

    return `// ${node.type} node ${node.id}
float ${fn}(${dim} p) {
  ${tpDecl}
  float dA = ${fnA}(${callA});
  float dB = ${fnB}(${callB});
  float blended = ${blendCall};
${maskFnName ? `  float mw = ${maskFnName}(${maskQueryArg});
  float base = ${maskFrom === 'sdfB' ? 'dB' : 'dA'};
  return base + (blended - base) * mw;` : '  return blended;'}
}`;
  }

  /**
   * Emit a float value as either a baked constant or a uniform.
   * If the param is time-varying, emit a uniform and record the value.
   * @param {object} node      The node owning this param
   * @param {string} paramName The param name
   * @param {number} value     Current JS value
   */
  _fp(node, paramName, value) {
    // Check if this node is time-varying
    const spec = node._spec || {};
    if (spec.timeVarying) {
      const uName = `u_${node.id}_${paramName}`;
      this.uniforms.set(uName, value);
      return uName;
    }
    return this._f(value);
  }

  /**
   * Register a plain numeric threshold (NOT frame/anchor geometry) as a
   * GLSL uniform instead of a baked literal. This is what lets a slider
   * like depth/regionSize/falloffRadius update at render time via a cheap
   * gl.uniform1f call, instead of forcing a full shader recompile on
   * every settle — recompiling a shader this size (up to 64 unrolled mask
   * terms, 6-frame embed unroll) is the actual source of the freeze
   * during rapid slider adjustment, not per-pixel/per-step runtime cost.
   */
  _uniformFloat(node, key, value) {
    const name = `u_${node.id}_${key}`;
    this.uniforms.set(name, value);
    this._uniformDecls.add(name);
    return name;
  }

  _f(v) {
    if (!isFinite(v)) return '1e10';
    let s = Number(v).toFixed(7);
    if (!s.includes('.')) s += '.0';
    // Wrap negative literals in parentheses so they never produce a double
    // operator when interpolated into arithmetic expressions.
    // Example: without wrapping,  a - _f(-1.87)  →  a--1.87  (GLSL parse error)
    //          with wrapping,     a - _f(-1.87)  →  a-(-1.87)  (valid GLSL)
    if (s.startsWith('-')) return `(${s})`;
    return s;
  }

  _resolveInputFn(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;
    return this._fnName(edge.fromNode);
  }

  _fallback2D(fn, nodeId, reason) {
    return `// FALLBACK 2D node ${nodeId}: ${reason}
float ${fn}(vec2 p) { return 1e10; }`;
  }

  _fallback3D(fn, nodeId, reason) {
    return `// FALLBACK 3D node ${nodeId}: ${reason}
float ${fn}(vec3 p) { return 1e10; }`;
  }

  // Dimension-aware fallback — emits the correct signature based on
  // whether the node's input chain is 3D
  _fallbackAdaptive(fn, nodeId, reason, is3D) {
    return is3D
      ? this._fallback3D(fn, nodeId, reason)
      : this._fallback2D(fn, nodeId, reason);
  }

  _topologicalSort() {
    const visited = new Set();
    const order   = [];
    const visit   = (nodeId) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      this.graph.edges.forEach(edge => {
        if (edge.toNode === nodeId) visit(edge.fromNode);
      });
      order.push(nodeId);
    };
    this.graph.nodes.forEach((_, id) => visit(id));
    return order;
  }

  /**
   * BFS backward from outputNode's connected 'sdf' inputs, following
   * EVERY incoming edge regardless of port name (sdf, hostSdf, guestSdf,
   * mapper, sdfA, sdfB, base, mapperA, mapperB, ...) — anything that some
   * chain of edges ultimately feeds into the rendered output. Used by
   * generate() to skip GLSL generation for nodes sitting in the graph but
   * not actually wired to anything downstream, so adding/editing an
   * unlinked node never changes the generated shader source string (and
   * therefore never triggers a needless recompile).
   */
  _computeReachableNodes(outputNode) {
    const reachable = new Set();
    const stack = [];
    this.graph.getAllIncomingEdges(outputNode.id, 'sdf').forEach(e => stack.push(e.fromNode));
    while (stack.length > 0) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      this.graph.edges.forEach(edge => {
        if (edge.toNode === id) stack.push(edge.fromNode);
      });
    }
    return reachable;
  }
}