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
]);

export class GLSLEvaluator {
  /**
   * @param {NodeGraph} graph
   */
  constructor(graph) {
    this.graph    = graph;
    this.uniforms = new Map();
    this._time    = 0;
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
    this._time = time;

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
      return { source: '', uniforms: this.uniforms, rootFn: null };
    }

    const allIncoming = this.graph.getAllIncomingEdges(outputNode.id, 'sdf');
    if (allIncoming.length === 0) {
      return { source: '', uniforms: this.uniforms, rootFn: null };
    }
    // Use first edge for backward-compat; multi-source handled in sceneSDF below
    const incoming = allIncoming[0];

    // Topological sort
    const order = this._topologicalSort();

    // Generate one function per node
    const functions = [];
    for (const nodeId of order) {
      const node = this.graph.nodes.get(nodeId);
      if (!node || node.type === 'outputNode') continue;
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

    const source = [this._preamble(), ...functions, sceneSDFStr].join('\n\n');
    return { source, uniforms: this.uniforms, rootFn };
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

    // twistNode and bendNode always emit float fn(vec3 p) regardless of input —
    // their GLSL templates are inherently 3D (they rotate in 3D space).
    // _nodeOutputIs3D must return true for them unconditionally.
    const ALWAYS_3D_OUTPUT = new Set(['twistNode', 'bendNode']);
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
}`;
  }

  // ── Per-node dispatch ─────────────────────────────────────────────────────

  /**
   * Generate a GLSL function for one node.
   * Dispatches to 2D or 3D template based on node type.
   */
  _generateNode(node, mode) {
    if (SOLID_TYPES.has(node.type)) {
      return this._generate3DNode(node);
    }
    if (BRIDGE_TYPES.has(node.type)) {
      return this._generateBridgeNode(node);
    }
    return this._generate2DNode(node, mode);
  }

  // ── 3D node templates ─────────────────────────────────────────────────────

  _generate3DNode(node) {
    const fn = this._fnName(node.id);
    const p  = node.params;

    switch (node.type) {

      case 'sphere': {
        const r  = this._f(p.radius ?? 1);
        const cx = this._f(p.posX   ?? 0);
        const cy = this._f(p.posY   ?? 0);
        const cz = this._f(p.posZ   ?? 0);
        return `// sphere node ${node.id}
float ${fn}(vec3 p) {
  return length(p - vec3(${cx}, ${cy}, ${cz})) - ${r};
}`;
      }

      case 'box': {
        const bx = this._f((p.width  ?? 2) / 2);
        const by = this._f((p.height ?? 2) / 2);
        const bz = this._f((p.depth  ?? 2) / 2);
        const cx = this._f(p.posX           ?? 0);
        const cy = this._f(p.posY           ?? 0);
        const cz = this._f(p.posZ           ?? 0);
        const cr = this._f(p.cornerRounding ?? 0);
        return `// box node ${node.id}
float ${fn}(vec3 p) {
  vec3 q = abs(p - vec3(${cx}, ${cy}, ${cz})) - vec3(${bx}, ${by}, ${bz});
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - ${cr};
}`;
      }

      case 'cylinder': {
        const r      = this._f(p.radius ?? 1);
        const h      = this._f((p.height ?? 2) / 2);
        const cx     = this._f(p.posX ?? 0);
        const cy     = this._f(p.posY ?? 0);
        const cz     = this._f(p.posZ ?? 0);
        const capped = p.capped !== 'no';
        const axis   = p.axis ?? 'Y';

        // Axis selector: swizzle q so that the cylinder axis is always
        // treated as 'Y' internally, regardless of world orientation.
        // Y (default): no swap — cylinder is vertical
        // X: swap X↔Y — cylinder points left-right
        // Z: swap Y↔Z — cylinder points front-back
        const swizzle =
          axis === 'X' ? 'q = vec3(q.y, q.x, q.z);' :
          axis === 'Z' ? 'q = vec3(q.x, q.z, q.y);' :
                         '';   // Y — no swap

        const cr = this._f(p.cornerRounding ?? 0);
        if (!capped) {
          return `// cylinder (infinite, axis=${axis}) node ${node.id}
float ${fn}(vec3 p) {
  vec3 q = p - vec3(${cx}, ${cy}, ${cz});
  ${swizzle}
  return length(vec2(q.x, q.z)) - ${r} - ${cr};
}`;
        }
        return `// cylinder (capped, axis=${axis}) node ${node.id}
float ${fn}(vec3 p) {
  vec3 q = p - vec3(${cx}, ${cy}, ${cz});
  ${swizzle}
  vec2 d = vec2(length(vec2(q.x, q.z)) - ${r}, abs(q.y) - ${h});
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - ${cr};
}`;
      }

      case 'capsule': {
  const r  = this._f(p.radius ?? 0.5);
  const h  = this._f(p.height ?? 2);
  const cx = this._f(p.posX   ?? 0);
  const cy = this._f(p.posY   ?? 0);
  const cz = this._f(p.posZ   ?? 0);
  const half = this._f((p.height ?? 2) / 2);

  return `// capsule node ${node.id}
  float ${fn}(vec3 p) {
    vec3 a  = vec3(${cx}, ${cy} - ${half}, ${cz});
    vec3 b  = vec3(${cx}, ${cy} + ${half}, ${cz});
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
        const cx = this._f(p.posX ?? 0);
        const cy = this._f(p.posY ?? 0);
        const cz = this._f(p.posZ ?? 0);
        return `// torus node ${node.id}
float ${fn}(vec3 p) {
  vec3 q  = p - vec3(${cx}, ${cy}, ${cz});
  vec2 t  = vec2(length(vec2(q.x, q.z)) - ${R}, q.y);
  return length(t) - ${r};
}`;
      }

      case 'cone': {
        const r    = this._f(p.radius ?? 1);
        const h    = this._f(p.height ?? 2);
        const cx   = this._f(p.posX ?? 0);
        const cy   = this._f(p.posY ?? 0);
        const cz   = this._f(p.posZ ?? 0);
        const axis = p.axis ?? 'Y';

        // Same axis swizzle as cylinder — cone apex points along the axis
        const swizzle =
          axis === 'X' ? 'q = vec3(q.y, q.x, q.z);' :
          axis === 'Z' ? 'q = vec3(q.x, q.z, q.y);' :
                         '';

        return `// cone (axis=${axis}) node ${node.id}
float ${fn}(vec3 p) {
  vec3  q    = p - vec3(${cx}, ${cy}, ${cz});
  ${swizzle}
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

        const off = this._f(p.offset ?? 0);
        return `// revolveNode ${node.id}
float ${fn}(vec3 p) {
  float q = length(vec2(p.x, p.z)) - ${off};
  return ${inputFn}(vec2(q, p.y));
}`;
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
        const cx = this._f(p.posX   ?? 0);
        const cy = this._f(p.posY   ?? 0);
        return `// circle node ${node.id}
float ${fn}(vec2 p) {
  return length(p - vec2(${cx}, ${cy})) - ${r};
}`;
      }

      case 'regularPolygon': {
        const N    = Math.max(3, Math.round(p.sides ?? 6));
        const size = this._f(p.size     ?? 1);
        const rot  = this._f((p.rotation ?? 0) + Math.PI / 2);
        const cx   = this._f(p.posX     ?? 0);
        const cy   = this._f(p.posY     ?? 0);
        const apo  = this._f(Math.cos(Math.PI / N));
        const sec  = this._f((Math.PI * 2) / N);
        return `// regularPolygon node ${node.id}  (${N} sides)
float ${fn}(vec2 p) {
  vec2 q = p - vec2(${cx}, ${cy});
  float c = cos(-${rot}); float s = sin(-${rot});
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
        const cx  = this._f(p.posX     ?? 0);
        const cy  = this._f(p.posY     ?? 0);
        const rot = this._f(p.rotation ?? 0);
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
  vec2 q=p-vec2(${cx},${cy});
  float c=cos(-${rot}); float s=sin(-${rot});
  vec2 lp=vec2(q.x*c-q.y*s, q.x*s+q.y*c);
${vertLines}
  float maxD=-1e10;
${edgeLines}
  return maxD;
}`;
      }

      // ── Curve primitives (SDF >= 0, needs isoOffset) ─────────────────────

      case 'triangle': {
        const sz  = this._f(p.size           ?? 1);
        const rot = this._f(p.rotation       ?? 0);
        const cx  = this._f(p.posX           ?? 0);
        const cy  = this._f(p.posY           ?? 0);
        const h   = this._f((p.size ?? 1) * Math.sqrt(3) / 2);
        const cr  = this._f(p.cornerRounding ?? 0);
        return `// triangle node ${node.id}
float ${fn}(vec2 p) {
  vec2 q=p-vec2(${cx},${cy});
  float c=cos(-${rot}); float s=sin(-${rot});
  q=vec2(q.x*c-q.y*s, q.x*s+q.y*c);
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
        const cx = this._f(p.posX       ?? 0);
        const cy = this._f(p.posY       ?? 0);
        return `// arc node ${node.id}
float ${fn}(vec2 p) {
  vec2 q=p-vec2(${cx},${cy});
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
        return this._generateBinaryBlendNode(node);

      case 'schurBlend': {
        const fnA = this._resolveInputFn(node, 'sdfA');
        const fnB = this._resolveInputFn(node, 'sdfB');
        if (!fnA || !fnB) return this._fallback2D(fn, node.id, 'schurBlend missing inputs');

        const op  = p.operation  ?? 'union';
        const sm  = this._f(p.smoothness ?? 8);
        const rot = this._f(p.rotation   ?? 0);
        const sc  = this._f(p.scale      ?? 1);
        const tx  = this._f(p.posX       ?? 0);
        const ty  = this._f(p.posY       ?? 0);
        const iso = this._f(p.isoOffset  ?? 0.15);

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
        // Determine if inputs are 3D
        const aIs3D = nodeA && this._nodeOutputIs3D(nodeA);
        const bIs3D = nodeB && this._nodeOutputIs3D(nodeB);
        const dim   = (aIs3D || bIs3D) ? 'vec3' : 'vec2';
        // isoOffset was applied per-input for curve primitives only (converts
        // unsigned→signed). For region-only blends subtract it from the final
        // output so the NodeCard slider expands/contracts the blend boundary.
        const bothRegion = (nodeA && REGION.has(nodeA.type)) &&
                           (nodeB && REGION.has(nodeB.type));
        const outputOff  = bothRegion ? iso : '0.0';
        return `// schurBlend node ${node.id}  (${op})
float ${fn}(${dim} p) {
  float c=cos(${rot}); float s=sin(${rot});
  ${dim === 'vec3'
    ? `vec3 tp=vec3(${sc}*(c*p.x-s*p.y)+${tx}, ${sc}*(s*p.x+c*p.y)+${ty}, p.z);`
    : `vec2 tp=vec2(${sc}*(c*p.x-s*p.y)+${tx}, ${sc}*(s*p.x+c*p.y)+${ty});`
  }
  float dA=${fnA}(${aIs3D ? 'tp' : dim==='vec3'?'tp.xy':'tp'})-${offA};
  float dB=${fnB}(${bIs3D ? 'tp' : dim==='vec3'?'tp.xy':'tp'})-${offB};
  return ${blendCall}/${sc} - ${outputOff};
}`;
      }

      // ── Transform nodes ───────────────────────────────────────────────────

      case 'tilingNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback2D(fn, node.id, 'tilingNode missing sdf');

        const lattice = p.lattice    ?? 'square';
        const pX      = this._f(p.periodX   ?? 3);
        const pY      = this._f(p.periodY   ?? 3);
        const oX      = this._f(p.offsetX   ?? 0);
        const oY      = this._f(p.offsetY   ?? 0);
        const iso     = this._f(p.isoOffset ?? 0);

        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const CURVE    = new Set(['lineSegment','triangle','arc']);
        const isCurve  = baseNode && CURVE.has(baseNode.type);
        // Apply isoOffset to all input types: for curve inputs converts unsigned→signed;
        // for region inputs expands/contracts the tiled boundary. With iso=0.0 (default
        // for regions) this is a GLSL no-op; non-zero values give visible boundary control.
        const isoLine  = `  d = d - ${iso};`;

        // Detect 3D input — tiling folds XY only, preserves Z
        const is3D = baseNode && this._nodeOutputIs3D(baseNode);
        const dim  = is3D ? 'vec3' : 'vec2';

        let foldBody;
        if (lattice === 'hexagonal') {
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

        // Build call expression — preserve Z for 3D
        const callExpr = is3D
          ? `${inputFn}(vec3(x+${oX},y+${oY},p.z))`
          : `${inputFn}(vec2(x+${oX},y+${oY}))`;

        return `// tilingNode ${node.id}  (${lattice})
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
        const cx     = this._f(p.centerX  ?? 0);
        const cy     = this._f(p.centerY  ?? 0);
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
        const cx       = this._f(p.centerX   ?? 0);
        const cy       = this._f(p.centerY   ?? 0);
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

        const aRe = this._f(p.aRe ?? 1);
        const aIm = this._f(p.aIm ?? 0);
        const bRe = this._f(p.bRe ?? 0);
        const bIm = this._f(p.bIm ?? 0);
        const cRe = this._f(p.cRe ?? 0);
        const cIm = this._f(p.cIm ?? 0);
        const dRe = this._f(p.dRe ?? 1);
        const dIm = this._f(p.dIm ?? 0);

        // Detect 3D input — Möbius operates on XY complex plane, preserves Z
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const is3D     = baseNode && this._nodeOutputIs3D(baseNode);
        const dim      = is3D ? 'vec3' : 'vec2';
        const callExpr = is3D
          ? `${inputFn}(vec3(tx,ty,p.z))`
          : `${inputFn}(vec2(tx,ty))`;

        return `// mobiusNode ${node.id}
float ${fn}(${dim} p) {
  float x=p.x; float y=p.y;
  float nRe=${aRe}*x-${aIm}*y+${bRe};
  float nIm=${aRe}*y+${aIm}*x+${bIm};
  float dnRe=${cRe}*x-${cIm}*y+${dRe};
  float dnIm=${cRe}*y+${cIm}*x+${dIm};
  float denom=dnRe*dnRe+dnIm*dnIm;
  if(denom<1e-10) return 1e10;
  float tx=(nRe*dnRe+nIm*dnIm)/denom;
  float ty=(nIm*dnRe-nRe*dnIm)/denom;
  return ${callExpr};
}`;
      }

      case 'noiseDisplaceNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'noiseDisplace missing sdf');
        const amp      = this._f(node.params.amplitude ?? 0.3);
        const freq     = this._f(node.params.frequency  ?? 3.0);
        const animated = (node.params.animated ?? 'no') === 'yes';

        // Determine if input is 3D
        const edge     = this.graph.getIncomingEdge(node.id, 'sdf');
        const baseNode = edge ? this.graph.nodes.get(edge.fromNode) : null;
        const is3D     = baseNode && this._nodeOutputIs3D(baseNode);
        const dim      = is3D ? 'vec3' : 'vec2';

        // When animated=yes, add uTime to the Z (or Y for 2D) noise coordinate
        // so the pattern shifts over time. uTime is provided as a uniform by
        // the renderer each frame. The 0.5 factor keeps the animation speed
        // comfortable — fast enough to be visible, slow enough to read.
        const timeOffset = animated ? '+ uTime * 0.5' : '';

        const sampleCoord = is3D
          ? `vec3(p.x * ${freq}, p.y * ${freq}, p.z * ${freq} ${timeOffset})`
          : `vec2(p.x * ${freq}, p.y * ${freq} ${timeOffset})`;

        return `// noiseDisplaceNode ${node.id}  (animated=${animated})
float ndHash(float n) { return fract(sin(n) * 43758.5453); }
float ndNoise(${dim} p) {
  ${is3D
    ? `float ix=floor(p.x); float iy=floor(p.y); float iz=floor(p.z);
  float fx=fract(p.x); float fy=fract(p.y); float fz=fract(p.z);
  float ux=fx*fx*(3.0-2.0*fx); float uy=fy*fy*(3.0-2.0*fy); float uz=fz*fz*(3.0-2.0*fz);
  return mix(mix(mix(ndHash(ix+iy*57.0+iz*113.0),ndHash(ix+1.0+iy*57.0+iz*113.0),ux),
                 mix(ndHash(ix+(iy+1.0)*57.0+iz*113.0),ndHash(ix+1.0+(iy+1.0)*57.0+iz*113.0),ux),uy),
             mix(mix(ndHash(ix+iy*57.0+(iz+1.0)*113.0),ndHash(ix+1.0+iy*57.0+(iz+1.0)*113.0),ux),
                 mix(ndHash(ix+(iy+1.0)*57.0+(iz+1.0)*113.0),ndHash(ix+1.0+(iy+1.0)*57.0+(iz+1.0)*113.0),ux),uy),uz);`
    : `float ix=floor(p.x); float iy=floor(p.y);
  float fx=fract(p.x); float fy=fract(p.y);
  float ux=fx*fx*(3.0-2.0*fx); float uy=fy*fy*(3.0-2.0*fy);
  return mix(mix(ndHash(ix+iy*57.0),ndHash(ix+1.0+iy*57.0),ux),
             mix(ndHash(ix+(iy+1.0)*57.0),ndHash(ix+1.0+(iy+1.0)*57.0),ux),uy);`}
}
float ${fn}(${dim} p) {
  float n = ndNoise(${sampleCoord}) * 2.0 - 1.0;
  return ${inputFn}(p) + n * ${amp};
}`;
      }

      case 'twistNode': {
        const inputFn  = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'twistNode missing sdf');
        const strength = this._f(node.params.strength ?? 1.0);

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
        const strength = this._f(node.params.strength ?? 0.5);

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

      case 'repeatNode': {
        const inputFn = this._resolveInputFn(node, 'sdf');
        if (!inputFn) return this._fallback3D(fn, node.id, 'repeatNode missing sdf');
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

      // Nodes without GLSL representation — skip
      case 'outputNode':
      case 'identityMapper': case 'polynomialMapper': case 'sinusoidalMapper':
      case 'exponentialMapper': case 'logarithmicMapper': case 'powerMapper':
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
      return this._fallback2D(fn, node.id, `${node.type} missing inputs`);
    }

    const edgeA = this.graph.getIncomingEdge(node.id, 'sdfA');
    const edgeB = this.graph.getIncomingEdge(node.id, 'sdfB');
    const nodeA  = edgeA ? this.graph.nodes.get(edgeA.fromNode) : null;
    const nodeB  = edgeB ? this.graph.nodes.get(edgeB.fromNode) : null;

    const aIs3D = nodeA && this._nodeOutputIs3D(nodeA);
    const bIs3D = nodeB && this._nodeOutputIs3D(nodeB);
    const dim   = (aIs3D || bIs3D) ? 'vec3' : 'vec2';

    const sm = this._f(p.smoothness ?? 8);
    const blendCall =
      node.type === 'rIntersection' ? `rIntersection(dA, dB, ${sm})` :
      node.type === 'rDifference'   ? `rDifference(dA, dB, ${sm})`   :
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

    return `// ${node.type} node ${node.id}
float ${fn}(${dim} p) {
  ${tpDecl}
  float dA = ${fnA}(${callA});
  float dB = ${fnB}(${callB});
  return ${blendCall};
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

  _f(v) {
    if (!isFinite(v)) return '1e10';
    let s = Number(v).toFixed(7);
    if (!s.includes('.')) s += '.0';
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
}