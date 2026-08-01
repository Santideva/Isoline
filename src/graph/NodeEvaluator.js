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
import { applyInverseTransform3D, isIdentityTransform } from '../utils/transform3D.js';
import { computeLocalFrame, snapToNearestSurface, computeShapeOperator2x2 } from '../utils/differentialGeometry.js'
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

    let result = this._evaluateNode(node);
    result = this._applyNodeTransform(node, result);
    this._cache.set(nodeId, result);
    return result;
  }

  /**
   * Universally apply a node's own transform (posX/Y/Z, pivotX/Y/Z,
   * rotateX/Y/Z, scale) to its evaluated SDF/result function. This is
   * what makes every node type — primitive, blend, or transform — support
   * placement identically, without each node type having to implement its
   * own position/rotation handling.
   *
   * Origin-centered generator (_evaluateNode) → wrapped, placed function.
   * Skipped entirely (returns result unchanged) when the transform is
   * identity, which is the common case and keeps the hot path cheap.
   */
  _applyNodeTransform(node, result) {
    const fn = result.sdf || result.result;
    if (typeof fn !== 'function') return result;

    // Universal mapper port — resolved HERE, in the one wrapper every node
    // type already passes through after _evaluateNode(). This means a
    // mapper connected to a primitive, a blend, an embedNode, or any
    // transform node all work identically, with zero per-node-type wiring.
    const mapperFn = this._resolveMapper(node, 'mapper');

    const t = node.transform;
    const identity = isIdentityTransform(t);

    if (identity && !mapperFn) return result; // fast path — nothing to do

    const scale = identity ? 1 : (t.scale ?? 1);
    const wrapped = (pt, cs = [], time = 0) => {
      const local = identity ? pt : applyInverseTransform3D(pt, t);
      let d = fn(local, cs, time);
      // Mapper applied to the LOCAL, PRE-SCALE distance value — so a
      // mapper's ripple/warp amplitude scales proportionally when the
      // shape is scaled up via the Transform section, rather than staying
      // a fixed absolute size regardless of shape size.
      if (mapperFn) d = mapperFn(d, time, 0);
      return d * scale;
    };

    return result.sdf ? { sdf: wrapped } : { result: wrapped };
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

    const combinedSDF = sdfs.length === 1
      ? sdfs[0]
      : (pt, cs = [], t = 0) => {
          let d = Infinity;
          for (const fn of sdfs) d = Math.min(d, fn(pt, cs, t));
          return d;
        };

    // ── Output-level placement transform ───────────────────────────────────
    // Applies once to the FULLY COMBINED result, after every blend and
    // transform in the graph and after every source branch has been merged.
    // Repositions the whole scene as a single rigid body. Implemented via
    // the same inverse-point trick as transform3DNode, so a Position/Orient
    // node mid-graph and the output drawer sliders behave identically.
    const op = outputNode.params;
    const placement = {
      posX:    op.posX    ?? 0,
      posY:    op.posY    ?? 0,
      posZ:    op.posZ    ?? 0,
      rotateX: op.rotateX ?? 0,
      rotateY: op.rotateY ?? 0,
      rotateZ: op.rotateZ ?? 0,
    };
    const isIdentity = Object.values(placement).every(v => v === 0);
    if (isIdentity) return combinedSDF;

    return (pt, cs = [], t = 0) => {
      const local = applyInverseTransform3D(pt, placement);
      return combinedSDF(local, cs, t);
    };
  }

  // ── Private — node type evaluators ───────────────────────────────────────

  _evaluateNode(node) {
    switch (node.type) {

      // ── Geometry ──────────────────────────────────────────────────────────

      case 'lineSegment': {
        // Mapper resolution moved to the universal wrapper — see
        // _applyNodeTransform above.
        const { x1, y1, x2, y2 } = node.params;
        const shape = new ComplexShape2D({
          vertices: [
            { position: { x: x1, y: y1 } },
            { position: { x: x2, y: y2 } },
          ],
        });
        return { sdf: (pt, cs = [], t = 0) => shape.computeSDF(pt, cs, t) };
      }

      case 'triangle': {
        // Mapper resolution moved to the universal wrapper.
        const { size, cornerRounding } = node.params;
        const prim = new TrianglePrimitive({
          size,
          cornerRounding,
        });
        const rounding = cornerRounding ?? 0;
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) - rounding };
      }

      case 'arc': {
        // Mapper resolution moved to the universal wrapper.
        const { radius, startAngle, endAngle, segments } = node.params;
        const prim = new ArcPrimitive({
          radius, startAngle, endAngle, segments,
        });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'circle': {
        // Mapper resolution moved to the universal wrapper.
        const { radius } = node.params;
        const prim = new CirclePrimitive({ radius });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'polytope': {
        // Mapper resolution moved to the universal wrapper.
        const { vertices } = node.params;
        const prim = new PolytopePrimitive({ vertices });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      case 'regularPolygon': {
        // Mapper resolution moved to the universal wrapper.
        const { sides, size } = node.params;
        const prim = new RegularPolygonPrimitive({ sides, size });
        return { sdf: (pt, cs = [], t = 0) => prim.computeSDF(pt, cs, t) };
      }

      // ── Solid geometry ────────────────────────────────────────────────────────

      case 'sphere': {
        const { radius } = node.params;
        const prim = new SpherePrimitive({ radius });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'box': {
        const { width, height, depth } = node.params;
        const rounding = node.params.cornerRounding ?? 0;
        const prim = new BoxPrimitive({ width, height, depth });
        return { sdf: (pt) => prim.computeSDF(pt) - rounding };
      }

      case 'cylinder': {
        const { radius, height, capped } = node.params;
        const rounding = node.params.cornerRounding ?? 0;
        // Always Y-axis, origin-centered. Orientation is handled entirely
        // by the node's own transform.rotateX/Y/Z (a 90° rotation replaces
        // what the old axis dropdown did, and additionally allows any angle).
        const prim = new CylinderPrimitive({ radius, height, capped: capped !== 'no' });
        return { sdf: (pt) => prim.computeSDF(pt) - rounding };
      }

      case 'capsule': {
      const { radius, height } = node.params;
      const prim = new CapsulePrimitive({ radius, height });
      return { sdf: (pt) => prim.computeSDF(pt) };
      }

      case 'torus': {
        const { majorRadius, minorRadius } = node.params;
        const prim = new TorusPrimitive({ majorRadius, minorRadius });
        return { sdf: (pt) => prim.computeSDF(pt) };
      }

     case 'cone': {
        const { radius, height } = node.params;
        const prim = new ConePrimitive({ radius, height });
        return { sdf: (pt) => prim.computeSDF(pt) };
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
        const off  = node.params.offset ?? 0;
        const axis = node.params.axis   ?? 'Y';
        return {
          result: (pt) => {
            const x = pt.x, y = pt.y, z = pt.z || 0;
            // For each axis, compute the radial distance from that axis
            // and pass it as the first component to the 2D profile SDF.
            // The second component is the coordinate along the axis.
            // This is the standard surface-of-revolution formula, applied
            // to whichever axis the user selected.
            if (axis === 'X') {
              const q = Math.sqrt(y * y + z * z) - off;
              return baseSDF({ x: q, y: x });
            } else if (axis === 'Z') {
              const q = Math.sqrt(x * x + y * y) - off;
              return baseSDF({ x: q, y: z });
            } else {
              // Y (default)
              const q = Math.sqrt(x * x + z * z) - off;
              return baseSDF({ x: q, y });
            }
          }
        };
      }

      // ── Blend ─────────────────────────────────────────────────────────────────

      case 'rBlend': {
        const sdfA = this._resolveSDF(node, 'sdfA');
        const sdfB = this._resolveSDF(node, 'sdfB');
        if (!sdfA || !sdfB) return { result: () => Infinity };
        const { operation, smoothness } = node.params;
        const sdfFn = (pt, cs = [], t = 0) => {
          if (operation === 'intersection') return weightedRIntersection(sdfA(pt, cs, t), sdfB(pt, cs, t), smoothness);
          if (operation === 'difference')   return weightedRDifference(sdfA(pt, cs, t), sdfB(pt, cs, t), smoothness);
          return weightedRUnion(sdfA(pt, cs, t), sdfB(pt, cs, t), smoothness);
        };
        return { result: sdfFn };
      }

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
        // Mapper resolution moved to the universal wrapper — schurBlend's
        // dedicated 'mapper' port stays in NodeSpec, but is now resolved
        // uniformly rather than inline, avoiding a double-apply against
        // the universal wrapper.
        const { operation, smoothness, isoOffset } = node.params;

        // No affine transform here anymore — placing/rotating/scaling the
        // blended result is the job of this node's own universal transform
        // (see _applyNodeTransform), which is applied AFTER this raw
        // generator returns. Mathematically equivalent to the old approach
        // (transforming both inputs identically before blending == blending
        // in local space then rigidly placing the result) but now 3D-capable
        // and consistent with every other node type.

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

        const iso = isoOffset ?? 0.15;
        const sdfFn = (pt, cs = [], t = 0) => {
          const dA = sdfA(pt, cs, t) - (aIsRegion ? 0 : iso);
          const dB = sdfB(pt, cs, t) - (bIsRegion ? 0 : iso);
          let result;
          if (operation === 'intersection') {
            result = weightedRIntersection(dA, dB, smoothness);
          } else if (operation === 'difference') {
            result = weightedRDifference(dA, dB, smoothness);
          } else {
            result = weightedRUnion(dA, dB, smoothness);
          }
          return (aIsRegion && bIsRegion) ? result - iso : result;
        };
        return { result: sdfFn };
      }

      case 'morphBlend': {
        const sdfA = this._resolveSDF(node, 'sdfA');
        const sdfB = this._resolveSDF(node, 'sdfB');
        if (!sdfA || !sdfB) return { result: () => Infinity };
        const { animated, speed } = node.params;
        let t = node.params.t ?? 0.5;
        if (animated === 'yes') {
          // Oscillate smoothly between 0 and 1, ignoring the manual slider
          // while animating — same convention as noiseDisplaceNode's
          // 'animated' flag overriding its static behavior.
          t = (Math.sin(this._time * (speed ?? 0.8)) + 1) / 2;
        }
        const sdfFn = (pt, cs = [], time = 0) =>
          (1 - t) * sdfA(pt, cs, time) + t * sdfB(pt, cs, time);
        return { result: sdfFn };
      }

      case 'embedNode': {
        const hostSDF  = this._resolveSDF(node, 'hostSdf');
        const guestSDF = this._resolveSDF(node, 'guestSdf');
        if (!hostSDF || !guestSDF) return { result: () => Infinity };

        // ── Per-cell embedding against a tiling host ────────────────────────
        // A single fixed-world anchor is ambiguous against an infinite/
        // finite tiling host — "one anchor" doesn't say which repeated
        // cell it belongs to. Fix: if the host is directly a tilingNode,
        // fold the query point into that SAME tiling's local cell space
        // before running the ordinary single-anchor embed logic below —
        // the anchor then means "this position within ANY cell", so the
        // decoration appears identically on every tile. Reuses
        // tilingNode's own fold math verbatim rather than duplicating it.
        const hostEdgeForTiling = this.graph.getIncomingEdge(node.id, 'hostSdf');
        const hostNodeForTiling = hostEdgeForTiling ? this.graph.nodes.get(hostEdgeForTiling.fromNode) : null;
        const hostIsTiling = hostNodeForTiling && hostNodeForTiling.type === 'tilingNode';
        const tilingFoldForEmbed = hostIsTiling
          ? this._buildTilingFoldFn(hostNodeForTiling)
          : null;

        const { operation, anchorX, anchorY, anchorZ, regionSize, depth } = node.params;
        const rawAnchor = { x: anchorX ?? 0, y: anchorY ?? 0, z: anchorZ ?? 0 };

        // BUGFIX (crash): GLSLEvaluator._computeEmbedFrame ALWAYS wrapped
        // this exact frame-building step in try/catch with a fallback —
        // this CPU counterpart never had the equivalent guard, which is
        // exactly why GLSL mode silently absorbed an edge case (most
        // plausibly: an anchor at or near a shape's symmetric center-axis
        // — the default (0,0,0) — where the gradient direction can be
        // numerically unstable/ambiguous) while CPU mode threw. Now
        // matches GLSL's defensive behavior exactly.
        let c0, frame0;
        try {
          c0 = snapToNearestSurface(hostSDF, rawAnchor, 4);
          frame0 = computeLocalFrame(hostSDF, c0);
        } catch (e) {
          c0 = rawAnchor;
          frame0 = null;
        }

        // ── Curvature-corrected local frame (principled, not tuned) ─────────
        // For a host with ISOTROPIC curvature H at the anchor (verified
        // exactly for a sphere: H = div(p/|p|) = 2/R, and the tangent-
        // plane-relative SDF at tangential radius r is r²/(2R) =
        // 0.5·(2/R)·r² = 0.5·H·r² — matches this formula exactly), a
        // second-order Taylor expansion predicts how far the TRUE surface
        // departs from the fixed flat tangent frame at any tangential
        // radius r: sag ≈ 0.5·H·r². This is computed ONCE at the anchor
        // (cheap) and applied per-query below to correct localZ before
        // the guest is sampled — a real, derived correction, not a tuned
        // scaling constant. Remaining limitation (still deferred, V2):
        // this assumes ISOTROPIC curvature (same in every tangential
        // direction, like a sphere) — hosts with direction-dependent
        // principal curvatures (a cylinder, a saddle-shaped blend seam)
        // will be over/under-corrected in the low/high-curvature
        // direction respectively. Fixing that needs either the full
        // second-fundamental-form (principal curvatures + directions) or
        // multiple curvature samples across the patch — a genuinely
        // bigger, still-deferred task.
       // Frame fallback FIRST — computeShapeOperator2x2 needs a valid
        // tangent/bitangent to project the Hessian into, so the identity
        // fallback must exist before it's called, not after.
        if (!frame0) {
          frame0 = {
            normal: { x: 0, y: 1, z: 0 },
            tangent: { x: 1, y: 0, z: 0 },
            bitangent: { x: 0, y: 0, z: 1 },
          };
        }

        // ── Anisotropic curvature correction (Tier 1 — no eigensolve) ────
        // Sxx/Sxy/Syy is the shape operator projected into THIS SAME
        // (tangent, bitangent) basis already built above for guest
        // sampling — reusing frame0 here is what guarantees the sag
        // correction and the guest-sampling coordinates can never drift
        // out of basis alignment with each other, by construction.
        // sag(localX,localY) = 0.5*(Sxx*localX² + 2*Sxy*localX*localY +
        // Syy*localY²) is the direction-aware generalization of the old
        // isotropic 0.5*H*r² — Euler's formula for normal curvature in an
        // arbitrary tangential direction, expressed as a quadratic form
        // rather than cos²θ/sin²θ, so no angle/atan2 is ever computed.
        // Reduces to the old formula exactly when Sxx=Syy=H, Sxy=0 (the
        // isotropic case — any sphere point).
        let Sxx = 0, Sxy = 0, Syy = 0;
        try {
          ({ Sxx, Sxy, Syy } = computeShapeOperator2x2(hostSDF, c0, frame0));
        } catch (e) { Sxx = 0; Sxy = 0; Syy = 0; }

        const n0  = frame0.normal;
        const t0x = frame0.tangent.x,   t0y = frame0.tangent.y,   t0z = frame0.tangent.z;
        const b0x = frame0.bitangent.x, b0y = frame0.bitangent.y, b0z = frame0.bitangent.z;

        const sdfFn = (pt, cs = [], t = 0) => {
          const rawP = { x: pt.x, y: pt.y, z: pt.z || 0 };
          // If the host is a tiling node, fold the query point into its
          // local cell space FIRST — the anchor/gate math below then
          // operates identically inside every repeated cell.
          const p = tilingFoldForEmbed ? tilingFoldForEmbed(rawP) : rawP;
          const dHost = hostSDF(p, cs, t);

          const dx = p.x - c0.x, dy = p.y - c0.y, dz = p.z - c0.z;
          const localX = dx*t0x + dy*t0y + dz*t0z;
          const localY = dx*b0x + dy*b0y + dz*b0z;
          const localZ = dx*n0.x + dy*n0.y + dz*n0.z;

          // BUGFIX: gate previously only bounded TANGENTIAL distance
          // (localX/localY), never localZ (distance along the surface
          // normal). That made the affected region an INFINITE ROD —
          // extending forever through the host along the normal in both
          // directions — rather than a bounded neighborhood. Any point on
          // a DIFFERENT part of the host (e.g. the opposite face of a box)
          // that happened to share similar tangential coordinates with the
          // anchor was incorrectly gated "in" and combined with the guest —
          // this is exactly what produced mirrored/duplicate copies of the
          // guest showing up on far faces when combined with Repeat. Now
          // bounded in all three local axes — a true sphere, not a rod.
          // BUGFIX (floating disconnected fragments): the old gate bounded
          // ONLY distance from the anchor point (a sphere/rod in world
          // space, since T0/B0/N0 form an orthonormal frame — that gate
          // was mathematically equal to |p - anchor|). A sphere gate has
          // NO knowledge of where the host's REAL surface is — it can
          // extend well past the host's actual boundary (e.g. near an
          // edge/corner, or whenever regionSize exceeds the host's local
          // half-extent), and inside that overflow zone, Emboss's union
          // will mark guest material "solid" regardless of whether we're
          // anywhere near the true surface — producing exactly the
          // floating, disconnected fragments seen in testing.
          //
          // Fixed by gating on TWO independent, physically meaningful
          // things instead: (1) tangentialR — how wide a footprint on the
          // surface is affected (regionSize), and (2) |dHost| itself —
          // how far from the TRUE host surface (correctly handling edges/
          // corners, since it reads the host's real SDF, not an
          // approximation) the effect may reach (depth). Requiring
          // |dHost| < depth means any point genuinely far from the real
          // surface — including tangential overflow near a corner — is
          // excluded, no matter how large regionSize is.
          const tangentialR2 = localX*localX + localY*localY;
          const tangentialR  = Math.sqrt(tangentialR2);
          const absDHost     = Math.abs(dHost);

          // Gate uses the EXACT dHost directly — no need to compensate the
          // gate itself, since dHost already correctly reflects the true
          // surface regardless of curvature. Only the guest's SAMPLING
          // coordinate (localZ, below) needs the curvature correction.
          if (tangentialR >= regionSize || absDHost >= depth) return dHost;

          // Anisotropic Euler-formula sag as a quadratic form in
          // (localX, localY) — see the derivation comment above.
          const sag = 0.5 * (Sxx*localX*localX + 2*Sxy*localX*localY + Syy*localY*localY);
          const correctedLocalZ = localZ - sag;

          const dGuest = guestSDF({ x: localX, y: localY, z: correctedLocalZ }, cs, t);
          const embedded = operation === 'engrave'
            ? weightedRDifference(dHost, dGuest, 0)
            : weightedRUnion(dHost, dGuest, 0);

          const FALLOFF_FRACTION = 0.25;
          const innerR = regionSize * (1 - FALLOFF_FRACTION);
          const innerD = depth * (1 - FALLOFF_FRACTION);

          let wT = 1;
          if (tangentialR > innerR) {
            const x = (tangentialR - innerR) / (regionSize - innerR);
            wT = 1 - (x * x * (3 - 2 * x));
          }
          let wD = 1;
          if (absDHost > innerD) {
            const x = (absDHost - innerD) / (depth - innerD);
            wD = 1 - (x * x * (3 - 2 * x));
          }
          const w = wT * wD;
          return embedded * w + dHost * (1 - w);
        };

        return { result: sdfFn };
      }

      case 'ifsBlend': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        const { iterations, iterRotation, iterScale, iterOffsetX, iterOffsetY } = node.params;
        const T = makeAffine({
          rotation: iterRotation, scale: iterScale,
          translate: { x: iterOffsetX, y: iterOffsetY },
        })
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
            const prevZ = tp.z || 0;
            tp = {
              x: T.a * tp.x + T.b * tp.y + T.tx,
              y: T.c * tp.x + T.d * tp.y + T.ty,
              z: prevZ,   // forward z — 2D affine transform doesn't touch it
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
        const { c0, c1, c2, c3, band } = node.params;
        return { mapper: createPolynomialMapping([c0, c1, c2, c3], band ?? 1.0) };
      }

      case 'sinusoidalMapper': {
        const { a, b, c, e, band, animated, speed } = node.params;
        const phase = animated === 'yes'
          ? (c ?? 0) + Math.sin(this._time * (speed ?? 0.8)) * Math.PI
          : (c ?? 0);
        return { mapper: createSinusoidalMapping(a, b, phase, e, band ?? 1.0) };
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

        const { folds, reflectX, reflectY, foldCenterX, foldCenterY, rotation } = node.params;

        // Compute the canonical representative of a point under the symmetry group.
        // Uses round-to-nearest-sector fold (same as RegularPolygon SDF) to avoid
        // discontinuities at sector boundaries.
        const foldPoint = (pt) => {
          let x = pt.x - foldCenterX;
          let y = pt.y - foldCenterY;

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

          return { x: x + foldCenterX, y: y + foldCenterY };
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

        const { folds, reflectX, orbitCenterX, orbitCenterY, rotation,
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
            const dx = pt.x - orbitCenterX;
            const dy = pt.y - orbitCenterY;
            return {
              x: dx * c - dy * s + orbitCenterX,
              y: dx * s + dy * c + orbitCenterY,
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
              const dx = pt.x - orbitCenterX;
              const dy = pt.y - orbitCenterY;
              // Rotate then reflect X
              return {
                x: -(dx * c - dy * s) + orbitCenterX,
                y:  (dx * s + dy * c) + orbitCenterY,
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

        const { lattice, periodX, periodY, periodZ, offsetX, offsetY, extent, countX, countY, countZ } = node.params;
        const finite = extent === 'finite';
        const clampIdx = (v, half) => Math.max(-half, Math.min(half, v));
        const hx = Math.floor((countX ?? 3) / 2);
        const hy = Math.floor((countY ?? 3) / 2);

        // ── Square: exact parity with the old repeatNode when finite ────────
        const foldSquare = (pt) => {
          const x = pt.x - offsetX, y = pt.y - offsetY;
          if (finite) {
            const ix = clampIdx(Math.round(x / periodX), hx);
            const iy = clampIdx(Math.round(y / periodY), hy);
            return { x: x - ix * periodX, y: y - iy * periodY };
          }
          const tx = ((x + periodX / 2) % periodX + periodX) % periodX - periodX / 2;
          const ty = ((y + periodY / 2) % periodY + periodY) % periodY - periodY / 2;
          return { x: tx, y: ty };
        };

        // ── Hex / triangular: same lattice math; finite clamps the
        // integer lattice indices (ru, rv) before folding back. This is
        // an approximation of a hex-shaped bounded region (a true bounded
        // hex tiling has no simple rectangular clamp), but gives a
        // predictable, symmetric, limited-count result consistent with
        // the rest of the finite-extent family. ──────────────────────────
        const foldHexTri = (pt, divisor) => {
          const x = pt.x - offsetX, y = pt.y - offsetY;
          const p = periodX / divisor;
          const a1x = p, a1y = 0, a2x = p * 0.5, a2y = p * Math.sqrt(3) / 2;
          const det = a1x * a2y - a1y * a2x;
          const u = (a2y * x - a2x * y) / det;
          const v = (-a1y * x + a1x * y) / det;
          let ru = Math.round(u), rv = Math.round(v);
          if (finite) { ru = clampIdx(ru, hx); rv = clampIdx(rv, hy); }
          return { x: x - (ru * a1x + rv * a2x), y: y - (ru * a1y + rv * a2y) };
        };
        const foldHexagonal  = (pt) => foldHexTri(pt, 1);
        const foldTriangular = (pt) => foldHexTri(pt, Math.sqrt(3));

        // ── Brick: finite clamps the row index and the within-row index.
        // Approximate for the same reason as hex/triangular above — an
        // exactly-bounded brick pattern with alternating offsets has no
        // single clean rectangular clamp, but this gives a predictable,
        // limited-count result. ──────────────────────────────────────────
        const foldBrick = (pt) => {
          const x = pt.x - offsetX, y = pt.y - offsetY;
          if (finite) {
            const rowIdx = clampIdx(Math.round(y / periodY), hy);
            const xOff = ((rowIdx % 2) + 2) % 2 === 0 ? 0 : periodX / 2;
            const ix = clampIdx(Math.round((x + xOff) / periodX), hx);
            return { x: x - ix * periodX - xOff, y: y - rowIdx * periodY };
          }
          const row  = Math.floor(((y + periodY / 2) % periodY + periodY) % periodY / (periodY / 2));
          const xOff = row % 2 === 0 ? 0 : periodX / 2;
          const tx   = ((x + xOff + periodX / 2) % periodX + periodX) % periodX - periodX / 2;
          const ty   = ((y + periodY / 2) % periodY + periodY) % periodY - periodY / 2;
          return { x: tx, y: ty };
        };

        const fold = lattice === 'hexagonal'  ? foldHexagonal
                   : lattice === 'triangular' ? foldTriangular
                   : lattice === 'brick'      ? foldBrick
                   : foldSquare;

        const baseNode = this.graph.nodes.get(
          this.graph.getIncomingEdge(node.id, 'sdf')?.fromNode
        );
        const CURVE_TYPES = new Set(['lineSegment','triangle','arc']);
        const isCurve  = baseNode && CURVE_TYPES.has(baseNode.type);
        const isoOffset = node.params.isoOffset ?? (isCurve ? 0.15 : 0);

        // Z handling — ONLY touched when extent='finite' (repeatNode-style
        // 3D grid clamp). When 'infinite' (the default, matching every
        // existing scene that predates this merge), Z passes through
        // completely unchanged — byte-for-byte identical behavior to the
        // original tilingNode, guaranteeing old presets/saves render
        // exactly as before.
        const hz = Math.floor((countZ ?? 1) / 2);
        const foldZ = (z) => {
          if (!finite) return z;
          const iz = clampIdx(Math.round(z / (periodZ ?? 3)), hz);
          return z - iz * (periodZ ?? 3);
        };

        return {
          result: (pt, cs = [], t = 0) => {
            const fp = fold(pt);
            const fz = foldZ(pt.z || 0);
            const d = baseSDF({ x: fp.x, y: fp.y, z: fz }, cs, t);
            return d - isoOffset;
          }
        };
      }

      case 'transform3DNode': {
        const baseSDF = this._resolveSDF(node, 'sdf');
        if (!baseSDF) return { result: () => Infinity };

        const params = {
          posX:    node.params.posX    ?? 0,
          posY:    node.params.posY    ?? 0,
          posZ:    node.params.posZ    ?? 0,
          rotateX: node.params.rotateX ?? 0,
          rotateY: node.params.rotateY ?? 0,
          rotateZ: node.params.rotateZ ?? 0,
        };

        return {
          result: (pt, cs = [], t = 0) => {
            const local = applyInverseTransform3D(pt, params);
            return baseSDF(local, cs, t);
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
        const { amplitude, frequency, animated, speed } = node.params;
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
            const timeOffset = animated === 'yes' ? t * (speed ?? 0.4) : 0;
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
        // Defensive rounding — counts are conceptually integers; a
        // fractional value (from an old save, direct param edit, or a
        // prior snap-increment bug) should not silently produce an
        // asymmetric/undefined clamp range.
        const cX = Math.round(countX ?? 3);  const sX = spacingX ?? 3;
        const cY = Math.round(countY ?? 3);  const sY = spacingY ?? 3;
        const cZ = Math.round(countZ ?? 1);  const sZ = spacingZ ?? 3;
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

  /**
   * Extract JUST the fold logic from a tilingNode's params, as a standalone
   * (point) => foldedPoint function — reused by embedNode's per-cell
   * embedding above, so the two features share exactly one fold
   * implementation rather than risking drift between two copies.
   * Deliberately duplicated in structure from the tilingNode case's own
   * fold functions (rather than refactored to share code directly),
   * since tilingNode's case also needs to apply isoOffset/Z-handling
   * inline in a way that doesn't cleanly factor out — this keeps both
   * call sites simple. If they ever drift apart, that's a signal to
   * properly extract a shared fold utility at that point.
   */
  _buildTilingFoldFn(tilingNode) {
    const { lattice, periodX, periodY, offsetX, offsetY, extent, countX, countY } = tilingNode.params;
    const finite = extent === 'finite';
    const clampIdx = (v, half) => Math.max(-half, Math.min(half, v));
    const hx = Math.floor(Math.round(countX ?? 3) / 2);
    const hy = Math.floor(Math.round(countY ?? 3) / 2);

    const foldSquare = (pt) => {
      const x = pt.x - offsetX, y = pt.y - offsetY;
      if (finite) {
        const ix = clampIdx(Math.round(x / periodX), hx);
        const iy = clampIdx(Math.round(y / periodY), hy);
        return { x: x - ix * periodX, y: y - iy * periodY, z: pt.z };
      }
      const tx = ((x + periodX / 2) % periodX + periodX) % periodX - periodX / 2;
      const ty = ((y + periodY / 2) % periodY + periodY) % periodY - periodY / 2;
      return { x: tx, y: ty, z: pt.z };
    };

    const foldHexTri = (pt, divisor) => {
      const x = pt.x - offsetX, y = pt.y - offsetY;
      const p = periodX / divisor;
      const a1x = p, a1y = 0, a2x = p * 0.5, a2y = p * Math.sqrt(3) / 2;
      const det = a1x * a2y - a1y * a2x;
      const u = (a2y * x - a2x * y) / det;
      const v = (-a1y * x + a1x * y) / det;
      let ru = Math.round(u), rv = Math.round(v);
      if (finite) { ru = clampIdx(ru, hx); rv = clampIdx(rv, hy); }
      return { x: x - (ru * a1x + rv * a2x), y: y - (ru * a1y + rv * a2y), z: pt.z };
    };

    const foldBrick = (pt) => {
      const x = pt.x - offsetX, y = pt.y - offsetY;
      if (finite) {
        const rowIdx = clampIdx(Math.round(y / periodY), hy);
        const xOff = ((rowIdx % 2) + 2) % 2 === 0 ? 0 : periodX / 2;
        const ix = clampIdx(Math.round((x + xOff) / periodX), hx);
        return { x: x - ix * periodX - xOff, y: y - rowIdx * periodY, z: pt.z };
      }
      const row  = Math.floor(((y + periodY / 2) % periodY + periodY) % periodY / (periodY / 2));
      const xOff = row % 2 === 0 ? 0 : periodX / 2;
      const tx   = ((x + xOff + periodX / 2) % periodX + periodX) % periodX - periodX / 2;
      const ty   = ((y + periodY / 2) % periodY + periodY) % periodY - periodY / 2;
      return { x: tx, y: ty, z: pt.z };
    };

    if (lattice === 'hexagonal')  return (pt) => foldHexTri(pt, 1);
    if (lattice === 'triangular') return (pt) => foldHexTri(pt, Math.sqrt(3));
    if (lattice === 'brick')      return foldBrick;
    return foldSquare;
  }
}