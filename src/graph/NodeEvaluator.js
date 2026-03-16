// src/graph/NodeEvaluator.js
import { NODE_TYPES } from './NodeSpec.js';
import {
  weightedRUnion,
  weightedRIntersection,
  weightedRDifference,
} from '../utils/SDFBlending.js';
import {
  identityMapping,
  createPolynomialMapping,
  createSinusoidalMapping,
  createExponentialMapping,
  createLogarithmicMapping,
  createPowerMapping,
  createPeriodicMapping,
  createTemporalMapping,
  createRecursiveMapping,
  createBlendedMapping,
  createCompositeMapping,
  combiningFunctions,
} from '../utils/DistanceMapping.js';
import {
  makeAffine,
  invertAffine,
  isInvertible,
} from '../utils/affine.js';
import { ComplexShape2D } from '../Geometry/ComplexShape2d.js';
import { TrianglePrimitive, ArcPrimitive } from '../Primitives/primaryDerivativePrimitives.js';
import { CirclePrimitive, RegularPolygonPrimitive, PolytopePrimitive } from '../Primitives/regionPrimitives.js';

/**
 * NodeEvaluator takes a NodeGraph and a query point, walks the graph
 * in topological order, and returns the SDF value at that point.
 *
 * Evaluation is lazy and cached per-frame. The cache is keyed by nodeId.
 * Call invalidate() at the start of each frame (or on graph mutation)
 * to clear cached kernel instances.
 *
 * The evaluator produces two kinds of output per node:
 *  - For SDF nodes:    a function (point, callStack, t) → number
 *  - For Mapper nodes: a function (d) → number
 *  - For Scalar nodes: a number
 *  - For Transform nodes: an affine matrix object
 */
export class NodeEvaluator {
  constructor(graph) {
    this.graph   = graph;
    this._cache  = new Map();   // nodeId → evaluated output
    this._time   = 0;
  }

  setTime(t) {
    this._time = t;
  }

  invalidate() {
    this._cache.clear();
  }

  invalidateTemporalNodes() {
    this.graph.nodes.forEach((node, id) => {
      const spec = NODE_TYPES[node.type];
      if (spec && spec.timeVarying) {
        this._cache.delete(id);
      }
    });
  }

  /**
   * Evaluate the output of a specific node's specific port.
   * Returns the appropriate typed value for that port.
   */
  evaluate(nodeId, portName = null) {
    // Return cached result if available
    if (this._cache.has(nodeId)) {
      const cached = this._cache.get(nodeId);
      return portName ? cached[portName] : cached;
    }

    const node = this.graph.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    const result = this._evaluateNode(node);
    this._cache.set(nodeId, result);
    return portName ? result[portName] : result;
  }

  /**
   * Find the output node and return its SDF function.
   * This is the main entry point called by SceneManager.
   */
  getRootSDF() {
    let outputNode = null;
    this.graph.nodes.forEach(node => {
      if (node.type === 'outputNode') outputNode = node;
    });
    if (!outputNode) return null;

    const incoming = this.graph.getIncomingEdge(outputNode.id, 'sdf');
    if (!incoming) return null;

    const sdfFn = this.evaluate(incoming.fromNode, incoming.fromPort);
    return sdfFn;
  }

  // ── Private — node type evaluators ───────────────────────────────────────

  _evaluateNode(node) {
    switch (node.type) {

      // ── Geometry ──────────────────────────────────────────────────────────

      case 'lineSegment': {
        const mapper = this._resolveMapper(node, 'mapper');
        const { x1, y1, x2, y2 } = node.params;
        const shape = new ComplexShape2D({
          vertices: [
            { position: { x: x1, y: y1 } },
            { position: { x: x2, y: y2 } },
          ],
          distanceMapper: mapper,
        });
        return { sdf: (pt, cs = [], t = 0) => shape.computeSDF(pt, cs, t) };
      }

      case 'triangle': {
        const mapper = this._resolveMapper(node, 'mapper');
        const { size, rotation, posX, posY, cornerRounding } = node.params;
        const prim = new TrianglePrimitive({
          size, rotation,
          position: { x: posX, y: posY },
          cornerRounding,
        });
        // Propagate mapper to inner edges
        if (mapper) {
          prim.shapes.forEach(s => { s.distanceMapper = mapper; });
        }
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'arc': {
        const mapper = this._resolveMapper(node, 'mapper');
        const { radius, startAngle, endAngle, segments, posX, posY } = node.params;
        const prim = new ArcPrimitive({
          radius, startAngle, endAngle, segments,
          position: { x: posX, y: posY },
        });
        if (mapper) {
          prim.shapes.forEach(s => { s.distanceMapper = mapper; });
        }
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'circle': {
        const mapper = this._resolveMapper(node, 'mapper');
        const { radius, posX, posY } = node.params;
        const prim = new CirclePrimitive({
          radius,
          posX,
          posY,
          distanceMapper: mapper || undefined,
        });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'polytope': {
        const mapper = this._resolveMapper(node, 'mapper');
        const { vertices, posX, posY, rotation } = node.params;
        const prim = new PolytopePrimitive({
          vertices,
          posX,
          posY,
          rotation,
          distanceMapper: mapper || undefined,
        });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'regularPolygon': {
        const mapper = this._resolveMapper(node, 'mapper');
        const { sides, size, rotation, posX, posY } = node.params;
        const prim = new RegularPolygonPrimitive({
          sides,
          size,
          rotation,
          posX,
          posY,
          distanceMapper: mapper || undefined,
        });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      // ── Blend ─────────────────────────────────────────────────────────────

      case 'rUnion': {
        const sdfA = this._resolveSDF(node, 'sdfA');
        const sdfB = this._resolveSDF(node, 'sdfB');
        const { smoothness } = node.params;
        const sdfFn = (pt, cs = [], t = 0) =>
          weightedRUnion(sdfA(pt, cs, t), sdfB(pt, cs, t), smoothness);
        return { result: sdfFn };
      }

      case 'rIntersection': {
        const sdfA = this._resolveSDF(node, 'sdfA');
        const sdfB = this._resolveSDF(node, 'sdfB');
        const { smoothness } = node.params;
        const sdfFn = (pt, cs = [], t = 0) =>
          weightedRIntersection(sdfA(pt, cs, t), sdfB(pt, cs, t), smoothness);
        return { result: sdfFn };
      }

      case 'rDifference': {
        const sdfA = this._resolveSDF(node, 'sdfA');
        const sdfB = this._resolveSDF(node, 'sdfB');
        const { smoothness } = node.params;
        const sdfFn = (pt, cs = [], t = 0) =>
          weightedRDifference(sdfA(pt, cs, t), sdfB(pt, cs, t), smoothness);
        return { result: sdfFn };
      }

      case 'schurBlend': {
        const sdfA = this._resolveSDF(node, 'sdfA');
        const sdfB = this._resolveSDF(node, 'sdfB');
        const compMapper = this._resolveMapper(node, 'mapper');
        const { operation, smoothness, rotation, scale, posX, posY, isoOffset } = node.params;

        const T = makeAffine({ rotation, scale, translate: { x: posX, y: posY } });
        const scaleFactor = isInvertible(T)
          ? Math.sqrt(Math.abs(T.a * T.d - T.b * T.c))
          : 1;

        // Resolve the base shape instances so we can check their family
        const shapeA = this.graph.nodes.get(
          this.graph.getIncomingEdge(node.id, 'sdfA')?.fromNode
        );
        const shapeB = this.graph.nodes.get(
          this.graph.getIncomingEdge(node.id, 'sdfB')?.fromNode
        );
        const REGION_TYPES = new Set([
          'circle','regularPolygon','polytope','ellipse'
        ]);
        const aIsRegion = shapeA && REGION_TYPES.has(shapeA.type);
        const bIsRegion = shapeB && REGION_TYPES.has(shapeB.type);

        const sdfFn = (pt, cs = [], t = 0) => {
          const tp = {
            x: T.a * pt.x + T.b * pt.y + T.tx,
            y: T.c * pt.x + T.d * pt.y + T.ty,
          };
          const dA = sdfA(tp, cs, t) - (aIsRegion ? 0 : isoOffset);
          const dB = sdfB(tp, cs, t) - (bIsRegion ? 0 : isoOffset);
          let result;
          if (operation === 'intersection') {
            result = weightedRIntersection(dA, dB, smoothness);
          } else if (operation === 'difference') {
            result = weightedRDifference(dA, dB, smoothness);
          } else {
            result = weightedRUnion(dA, dB, smoothness);
          }
          const worldDist = result / scaleFactor;
          return compMapper ? compMapper(worldDist) : worldDist;
        };
        return { result: sdfFn };
      }

      case 'ifsBlend': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        const { iterations, rotation, scale, posX, posY } = node.params;
        const T = makeAffine({ rotation, scale, translate: { x: posX, y: posY } });
        const scaleFactor = isInvertible(T)
          ? Math.sqrt(Math.abs(T.a * T.d - T.b * T.c))
          : 1;

        const sdfFn = (pt, cs = [], t = 0) => {
          let result = Infinity;
          let tp = { ...pt };
          for (let i = 0; i < iterations; i++) {
            const d = baseSDF(tp, cs, t) / Math.pow(scaleFactor, i);
            result = i === 0 ? d : weightedRUnion(result, d, 8);
            // Apply transform for next iteration
            tp = {
              x: T.a * tp.x + T.b * tp.y + T.tx,
              y: T.c * tp.x + T.d * tp.y + T.ty,
            };
          }
          return result;
        };
        return { result: sdfFn };
      }

      // ── Mapper ────────────────────────────────────────────────────────────

      case 'identityMapper':
        return { mapper: identityMapping };

      case 'polynomialMapper': {
        const { c0, c1, c2, c3 } = node.params;
        return { mapper: createPolynomialMapping([c0, c1, c2, c3]) };
      }

      case 'sinusoidalMapper': {
        const { a, b, c, e } = node.params;
        return { mapper: createSinusoidalMapping(a, b, c, e) };
      }

      case 'exponentialMapper': {
        const { a, b, c } = node.params;
        return { mapper: createExponentialMapping(a, b, c) };
      }

      case 'logarithmicMapper': {
        const { a, b, c, e } = node.params;
        return { mapper: createLogarithmicMapping(a, b, c, e) };
      }

      case 'powerMapper': {
        const { a, b, c } = node.params;
        return { mapper: createPowerMapping(a, b, c) };
      }

      case 'periodicMapper': {
        const base   = this._resolveMapper(node, 'base') || identityMapping;
        const { period } = node.params;
        return { mapper: createPeriodicMapping(base, period) };
      }

      case 'temporalMapper': {
        const base      = this._resolveMapper(node, 'base') || identityMapping;
        const { frequency, amplitude } = node.params;
        const t         = this._time;
        return { mapper: createTemporalMapping(base, frequency, amplitude) };
      }

      case 'recursiveMapper': {
        const base          = this._resolveMapper(node, 'base') || identityMapping;
        const { iterations, strength } = node.params;
        return { mapper: createRecursiveMapping(base, iterations, strength) };
      }

      case 'blendedMapper': {
        const mA          = this._resolveMapper(node, 'mapperA') || identityMapping;
        const mB          = this._resolveMapper(node, 'mapperB') || identityMapping;
        const { blendFactor } = node.params;
        return { mapper: createBlendedMapping(mA, mB, blendFactor) };
      }

      case 'compositeMapper': {
        const mA         = this._resolveMapper(node, 'mapperA') || identityMapping;
        const mB         = this._resolveMapper(node, 'mapperB') || identityMapping;
        const { combiner } = node.params;
        const fn         = combiningFunctions[combiner] || combiningFunctions.add;
        return { mapper: createCompositeMapping(mA, mB, fn) };
      }

      // ── Transform ─────────────────────────────────────────────────────────────

      case 'tilingNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };

        const { lattice, periodX, periodY, offsetX, offsetY } = node.params;

        const foldSquare = (pt) => {
          const x  = pt.x - offsetX;
          const y  = pt.y - offsetY;
          const tx = ((x + periodX / 2) % periodX + periodX) % periodX - periodX / 2;
          const ty = ((y + periodY / 2) % periodY + periodY) % periodY - periodY / 2;
          return { x: tx, y: ty };
        };

        const foldHexagonal = (pt) => {
          const x   = pt.x - offsetX;
          const y   = pt.y - offsetY;
          const p   = periodX;
          const a1x = p,       a1y = 0;
          const a2x = p * 0.5, a2y = p * Math.sqrt(3) / 2;
          const det = a1x * a2y - a1y * a2x;
          const u   = ( a2y * x - a2x * y) / det;
          const v   = (-a1y * x + a1x * y) / det;
          const ru  = Math.round(u);
          const rv  = Math.round(v);
          return {
            x: x - (ru * a1x + rv * a2x),
            y: y - (ru * a1y + rv * a2y)
          };
        };

        const foldTriangular = (pt) => {
          // Triangular lattice uses a denser hex lattice with period/sqrt(3)
          // No reflection — pure lattice folding preserves shape orientation
          const x   = pt.x - offsetX;
          const y   = pt.y - offsetY;
          const p   = periodX / Math.sqrt(3);
          const a1x = p,       a1y = 0;
          const a2x = p * 0.5, a2y = p * Math.sqrt(3) / 2;
          const det = a1x * a2y - a1y * a2x;
          const u   = ( a2y * x - a2x * y) / det;
          const v   = (-a1y * x + a1x * y) / det;
          const ru  = Math.round(u);
          const rv  = Math.round(v);
          return {
            x: x - (ru * a1x + rv * a2x),
            y: y - (ru * a1y + rv * a2y)
          };
        };

        const fold = lattice === 'hexagonal'  ? foldHexagonal
                   : lattice === 'triangular' ? foldTriangular
                   : foldSquare;

        // Detect if the base shape is a curve primitive (SDF always >= 0)
        // by checking the node type of the connected shape
        const baseNode = this.graph.nodes.get(
          this.graph.getIncomingEdge(node.id, 'sdf')?.fromNode
        );
        const CURVE_TYPES = new Set([
          'lineSegment','triangle','arc'
        ]);
        const isCurve  = baseNode && CURVE_TYPES.has(baseNode.type);
        const { isoOffset = 0.15 } = node.params;

        return {
          result: (pt, cs = [], t = 0) => {
            const d = baseSDF(fold(pt), cs, t);
            return isCurve ? d - isoOffset : d;
          }
        };
      }

      case 'affineTransform': {
        const { rotation, scale, posX, posY } = node.params;
        return { transform: makeAffine({ rotation, scale, translate: { x: posX, y: posY } }) };
      }

      // ── Temporal ──────────────────────────────────────────────────────────

      case 'timeNode':
        return { value: this._time };

      case 'oscillatorNode': {
        const { frequency, amplitude, phase, waveform } = node.params;
        const t   = this._time;
        const raw = t * frequency * 2 * Math.PI + phase;
        let value;
        switch (waveform) {
          case 'square':   value = Math.sign(Math.sin(raw)); break;
          case 'sawtooth': value = (((t * frequency) % 1) * 2 - 1); break;
          case 'triangle': value = Math.asin(Math.sin(raw)) / (Math.PI / 2); break;
          case 'noise':    value = (Math.sin(raw * 127.1) * 43758.5453) % 1 * 2 - 1; break;
          default:         value = Math.sin(raw); break;
        }
        return { value: value * amplitude };
      }

      // ── Output ────────────────────────────────────────────────────────────

      case 'outputNode': {
        // Output node has no computed value — its connected SDF is retrieved
        // directly by getRootSDF(). Return empty object.
        return {};
      }

      default:
        throw new Error(`No evaluator for node type: ${node.type}`);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the SDF function connected to an input port.
   * Returns null if unconnected.
   */
  _resolveSDF(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;
    const result = this.evaluate(edge.fromNode);
    // SDF nodes use different output port names — try 'sdf' and 'result'
    return result.sdf || result.result || null;
  }

  /**
   * Resolve the mapper function connected to an input port.
   * Returns null if unconnected.
   */
  _resolveMapper(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;
    const result = this.evaluate(edge.fromNode);
    return result.mapper || null;
  }
}