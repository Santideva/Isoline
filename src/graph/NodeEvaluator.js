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
import { SpherePrimitive, BoxPrimitive, CylinderPrimitive,
         CapsulePrimitive, TorusPrimitive,
         ConePrimitive, InfinitePlanePrimitive } from '../Primitives/solidPrimitives.js';

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
   * Evaluate a node and return its full result object.
   * Port selection is handled by callers, not by the cache layer.
   */
  evaluate(nodeId) {
    if (this._cache.has(nodeId)) {
      return this._cache.get(nodeId);
    }

    const node = this.graph.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    const result = this._evaluateNode(node);
    this._cache.set(nodeId, result);
    return result;
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

    const allEdges = this.graph.getAllIncomingEdges(outputNode.id, 'sdf');
    if (allEdges.length === 0) return null;

    const sdfs = allEdges.map(e => {
      const result = this.evaluate(e.fromNode);
      return result?.sdf || result?.result || null;
    }).filter(Boolean);

    if (sdfs.length === 0) return null;
    if (sdfs.length === 1) return sdfs[0];

    return (pt, cs = [], t = 0) => {
      let d = Infinity;
      for (const fn of sdfs) d = Math.min(d, fn(pt, cs, t));
      return d;
    };
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

      // ── Solid geometry ────────────────────────────────────────────────────────

      case 'sphere': {
        const { radius, posX, posY, posZ } = node.params;
        const prim = new SpherePrimitive({ radius, posX, posY, posZ });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'box': {
        const { width, height, depth, posX, posY, posZ } = node.params;
        const prim = new BoxPrimitive({ width, height, depth, posX, posY, posZ });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'cylinder': {
        const { radius, height, capped, posX, posY, posZ } = node.params;
        const axis = node.params.axis ?? 'Y';
        // Create at origin — we handle position + swizzle manually
        // so the axis rotation and position offset compose correctly.
        const prim = new CylinderPrimitive({
          radius, height,
          posX: 0, posY: 0, posZ: 0,
          capped: capped !== 'no'
        });
        return {
          sdf: (pt) => {
            // Step 1: translate to local (primitive) coordinates
            const lx = pt.x - (posX || 0);
            const ly = pt.y - (posY || 0);
            const lz = (pt.z || 0) - (posZ || 0);
            // Step 2: swizzle to match axis selection.
            // The cylinder formula always treats Y as the long axis internally.
            // Swizzling maps the chosen world axis onto Y before evaluation.
            let sx, sy, sz;
            if (axis === 'X') {
              // World X becomes the cylinder axis: swap X and Y
              sx = ly; sy = lx; sz = lz;
            } else if (axis === 'Z') {
              // World Z becomes the cylinder axis: swap Y and Z
              sx = lx; sy = lz; sz = ly;
            } else {
              // Default Y axis: no swap
              sx = lx; sy = ly; sz = lz;
            }
            return prim.computeSDF({ x: sx, y: sy, z: sz });
          }
        };
      }

      case 'capsule': {
        const { ax, ay, az, bx, by, bz, radius } = node.params;
        const prim = new CapsulePrimitive({ ax, ay, az, bx, by, bz, radius });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'torus': {
        const { majorRadius, minorRadius, posX, posY, posZ } = node.params;
        const prim = new TorusPrimitive({ majorRadius, minorRadius, posX, posY, posZ });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'cone': {
        const { radius, height, posX, posY, posZ } = node.params;
        const axis = node.params.axis ?? 'Y';
        const prim = new ConePrimitive({
          radius, height,
          posX: 0, posY: 0, posZ: 0
        });
        return {
          sdf: (pt) => {
            const lx = pt.x - (posX || 0);
            const ly = pt.y - (posY || 0);
            const lz = (pt.z || 0) - (posZ || 0);
            let sx, sy, sz;
            if (axis === 'X') {
              sx = ly; sy = lx; sz = lz;
            } else if (axis === 'Z') {
              sx = lx; sy = lz; sz = ly;
            } else {
              sx = lx; sy = ly; sz = lz;
            }
            return prim.computeSDF({ x: sx, y: sy, z: sz });
          }
        };
      }

      case 'plane': {
        const { nx, ny, nz, offset } = node.params;
        const prim = new InfinitePlanePrimitive({ nx, ny, nz, offset });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'extrudeNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };
        const { height } = node.params;
        const h = (height ?? 1) / 2;
        return {
          result: (pt) => {
            const d2D = baseSDF({ x: pt.x, y: pt.y });
            const dz  = Math.abs(pt.z || 0) - h;
            return Math.min(Math.max(d2D, dz), 0) +
                   Math.sqrt(Math.max(d2D, 0) ** 2 + Math.max(dz, 0) ** 2);
          }
        };
      }

      case 'revolveNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };
        const { offset } = node.params;
        const off = offset ?? 0;
        return {
          result: (pt) => {
            const q = Math.sqrt(pt.x * pt.x + (pt.z || 0) * (pt.z || 0)) - off;
            return baseSDF({ x: q, y: pt.y });
          }
        };
      }

      // ── Blend ─────────────────────────────────────────────────────────────────

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

      case 'symmetryFoldNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };

        const { folds, reflectX, reflectY, centerX, centerY, rotation } = node.params;

        // Compute the canonical representative of a point under the symmetry group.
        // Uses round-to-nearest-sector fold (same as RegularPolygon SDF) to avoid
        // discontinuities at sector boundaries.
        const foldPoint = (pt) => {
          let x = pt.x - centerX;
          let y = pt.y - centerY;

          // Optional pre-rotation
          if (rotation !== 0) {
            const c = Math.cos(-rotation);
            const s = Math.sin(-rotation);
            const rx = x * c - y * s;
            const ry = x * s + y * c;
            x = rx;
            y = ry;
          }

          // N-fold fold — round to nearest sector center (smooth, no seams)
          if (folds > 1) {
            const sectorAngle = (Math.PI * 2) / folds;
            let angle = Math.atan2(y, x);
            angle = angle - sectorAngle * Math.round(angle / sectorAngle);
            const r = Math.sqrt(x * x + y * y);
            x = r * Math.cos(angle);
            y = r * Math.sin(angle);
          }

          // Reflection
          if (reflectX === 'yes') x = Math.abs(x);
          if (reflectY === 'yes') y = Math.abs(y);

          return { x: x + centerX, y: y + centerY };
        };

        return {
          result: (pt, cs = [], t = 0) => {
            const fp = foldPoint(pt);
            // Forward z — fold only operates on XY, z must pass through unchanged
            return baseSDF({ x: fp.x, y: fp.y, z: pt.z || 0 }, cs, t);
          }
        };
      }

      case 'symmetryOrbitNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };

        const { folds, reflectX, centerX, centerY, rotation,
                combiner, smoothness } = node.params;

        const sector = (Math.PI * 2) / folds;

        // Build the full transform list for the orbit.
        // Full dihedral group D_N = N rotations + N reflections (if reflectX).
        const transforms = [];

        // N rotations
        for (let k = 0; k < folds; k++) {
          const theta = rotation + k * sector;
          const c = Math.cos(-theta);
          const s = Math.sin(-theta);
          transforms.push((pt) => {
            const dx = pt.x - centerX;
            const dy = pt.y - centerY;
            return {
              x: dx * c - dy * s + centerX,
              y: dx * s + dy * c + centerY,
              z: pt.z || 0   // forward z — orbit only rotates XY
            };
          });
        }

        // N reflections (dihedral extension)
        if (reflectX === 'yes') {
          for (let k = 0; k < folds; k++) {
            const theta = rotation + k * sector;
            const c = Math.cos(-theta);
            const s = Math.sin(-theta);
            transforms.push((pt) => {
              const dx = pt.x - centerX;
              const dy = pt.y - centerY;
              // Rotate then reflect X
              return {
                x: -(dx * c - dy * s) + centerX,
                y:  (dx * s + dy * c) + centerY,
                z:  pt.z || 0   // forward z — reflection only affects XY
              };
            });
          }
        }

        return {
          result: (pt, cs = [], t = 0) => {
            const values = transforms.map(tf => baseSDF(tf(pt), cs, t));
            if (combiner === 'max') {
              return Math.max(...values);
            } else if (combiner === 'smoothMin') {
              return values.reduce((acc, v) =>
                weightedRUnion(acc, v, smoothness), values[0]);
            } else {
              // default: min
              return Math.min(...values);
            }
          }
        };
      }

      case 'mobiusNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };

        const { aRe, aIm, bRe, bIm, cRe, cIm, dRe, dIm } = node.params;

        // Complex multiplication: (p + qi)(r + si) = (pr - qs) + (ps + qr)i
        const cmul = (pr, qi, rr, si) => [pr*rr - qi*si, pr*si + qi*rr];

        // Complex division: (nRe + nIm*i) / (dRe + dIm*i)
        const cdiv = (nRe, nIm, dRe, dIm) => {
          const denom = dRe*dRe + dIm*dIm;
          if (denom < 1e-10) return [Infinity, Infinity];
          return [(nRe*dRe + nIm*dIm) / denom, (nIm*dRe - nRe*dIm) / denom];
        };

        // Check determinant ad - bc ≠ 0
        const [adRe, adIm] = cmul(aRe, aIm, dRe, dIm);
        const [bcRe, bcIm] = cmul(bRe, bIm, cRe, cIm);
        const detRe = adRe - bcRe;
        const detIm = adIm - bcIm;
        const detMag = Math.sqrt(detRe*detRe + detIm*detIm);

        if (detMag < 1e-10) {
          // Degenerate transform — return identity
          return { result: (pt, cs = [], t = 0) => baseSDF(pt, cs, t) };
        }

        const sdfFn = (pt, cs = [], t = 0) => {
          const x = pt.x;
          const y = pt.y;

          // Compute numerator: az + b
          const [numRe, numIm] = [
            aRe*x - aIm*y + bRe,
            aRe*y + aIm*x + bIm
          ];

          // Compute denominator: cz + d
          const [denRe, denIm] = [
            cRe*x - cIm*y + dRe,
            cRe*y + cIm*x + dIm
          ];

          // Compute f(z) = numerator / denominator
          const [tx, ty] = cdiv(numRe, numIm, denRe, denIm);

          if (!isFinite(tx) || !isFinite(ty)) return Infinity;

          // Forward z — Möbius transform only remaps XY (complex plane)
          return baseSDF({ x: tx, y: ty, z: pt.z || 0 }, cs, t);
        };

        return { result: sdfFn };
      }

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

        const foldBrick = (pt) => {
          const x    = pt.x - offsetX;
          const y    = pt.y - offsetY;
          // Which row are we in?
          const row  = Math.floor(((y + periodY / 2) % periodY + periodY) % periodY / (periodY / 2));
          // Offset alternating rows by half a period
          const xOff = row % 2 === 0 ? 0 : periodX / 2;
          const tx   = ((x + xOff + periodX / 2) % periodX + periodX) % periodX - periodX / 2;
          const ty   = ((y + periodY / 2) % periodY + periodY) % periodY - periodY / 2;
          return { x: tx, y: ty };
        };

        const fold = lattice === 'hexagonal'  ? foldHexagonal
                   : lattice === 'triangular' ? foldTriangular
                   : lattice === 'brick'      ? foldBrick
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
            const fp = fold(pt);
            // Forward z — tiling only folds XY, z passes through unchanged
            const d = baseSDF({ x: fp.x, y: fp.y, z: pt.z || 0 }, cs, t);
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

      case 'noiseDisplaceNode': {
        const baseSDF  = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };
        const { amplitude, frequency, animated } = node.params;
        const amp  = amplitude ?? 0.3;
        const freq = frequency ?? 3.0;
        // Simple hash-based noise — no dependency, pure math
        const hash = (n) => {
          let x = Math.sin(n) * 43758.5453;
          return x - Math.floor(x);
        };
        const noise3 = (x, y, z) => {
          const ix = Math.floor(x); const fx = x - ix;
          const iy = Math.floor(y); const fy = y - iy;
          const iz = Math.floor(z); const fz = z - iz;
          const ux = fx*fx*(3-2*fx);
          const uy = fy*fy*(3-2*fy);
          const uz = fz*fz*(3-2*fz);
          const h000 = hash(ix     + iy*57     + iz*113);
          const h100 = hash(ix+1   + iy*57     + iz*113);
          const h010 = hash(ix     + (iy+1)*57 + iz*113);
          const h110 = hash(ix+1   + (iy+1)*57 + iz*113);
          const h001 = hash(ix     + iy*57     + (iz+1)*113);
          const h101 = hash(ix+1   + iy*57     + (iz+1)*113);
          const h011 = hash(ix     + (iy+1)*57 + (iz+1)*113);
          const h111 = hash(ix+1   + (iy+1)*57 + (iz+1)*113);
          return h000*(1-ux)*(1-uy)*(1-uz) + h100*ux*(1-uy)*(1-uz)
               + h010*(1-ux)*uy*(1-uz)     + h110*ux*uy*(1-uz)
               + h001*(1-ux)*(1-uy)*uz     + h101*ux*(1-uy)*uz
               + h011*(1-ux)*uy*uz         + h111*ux*uy*uz;
        };
        return {
          result: (pt, cs = [], t = 0) => {
            const timeOffset = animated === 'yes' ? t * 0.5 : 0;
            const n = noise3(
              pt.x * freq + timeOffset,
              pt.y * freq,
              (pt.z || 0) * freq
            );
            return baseSDF(pt, cs, t) + (n * 2 - 1) * amp;
          }
        };
      }

      case 'twistNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };
        const strength = node.params.strength ?? 1.0;
        return {
          result: (pt, cs = [], t = 0) => {
            const y     = pt.y || 0;
            const angle = y * strength;
            const cosA  = Math.cos(angle);
            const sinA  = Math.sin(angle);
            const tx    = cosA * pt.x - sinA * (pt.z || 0);
            const tz    = sinA * pt.x + cosA * (pt.z || 0);
            return baseSDF({ x: tx, y, z: tz }, cs, t);
          }
        };
      }

      case 'bendNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };
        const strength = node.params.strength ?? 0.5;
        return {
          result: (pt, cs = [], t = 0) => {
            const x     = pt.x || 0;
            const angle = x * strength;
            const cosA  = Math.cos(angle);
            const sinA  = Math.sin(angle);
            const tx    = cosA * x    - sinA * (pt.y || 0);
            const ty    = sinA * x    + cosA * (pt.y || 0);
            return baseSDF({ x: tx, y: ty, z: pt.z || 0 }, cs, t);
          }
        };
      }

      case 'repeatNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };
        const { countX, countY, countZ, spacingX, spacingY, spacingZ } = node.params;
        const cX = countX   ?? 3;  const sX = spacingX ?? 3;
        const cY = countY   ?? 3;  const sY = spacingY ?? 3;
        const cZ = countZ   ?? 1;  const sZ = spacingZ ?? 3;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        return {
          result: (pt, cs = [], t = 0) => {
            const rx = clamp(Math.round(pt.x / sX), -Math.floor(cX/2), Math.floor(cX/2));
            const ry = clamp(Math.round(pt.y / sY), -Math.floor(cY/2), Math.floor(cY/2));
            const rz = clamp(Math.round((pt.z||0)/sZ), -Math.floor(cZ/2), Math.floor(cZ/2));
            return baseSDF({
              x: pt.x - rx * sX,
              y: pt.y - ry * sY,
              z: (pt.z||0) - rz * sZ
            }, cs, t);
          }
        };
      }

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


    _pickSDF(result) {
    return result?.sdf || result?.result || null;
  }
  
  /**
   * Resolve the SDF function connected to an input port.
   * Returns null if unconnected.
   */
    _resolveSDF(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;

    return this._pickSDF(this.evaluate(edge.fromNode));
  }

  /**
   * Resolve the mapper function connected to an input port.
   * Returns null if unconnected.
   */
  _resolveMapper(node, portName) {
    const edge = this.graph.getIncomingEdge(node.id, portName);
    if (!edge) return null;

    const result = this.evaluate(edge.fromNode);
    return result?.mapper || null;
  }
}