// src/utils/surfaceMask.js
import { buildTangentFrameFromNormal } from './differentialGeometry.js';
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Canonical data shape and CPU evaluator for a node's optional "painted
// surface region" — the universal per-node mask block, structurally parallel
// to node.transform (see transform3D.js's header for that pattern). Every
// node gets one; most are empty (mask.samples.length === 0) and cost nothing.
//
// ── Why baked samples, not live geodesic/curvature computation ─────────────
// Geodesic distance and curvature-similarity flood are both expensive,
// topology-aware computations (see surfaceGraph.js) that CANNOT run per
// query point per frame — and GLSL cannot run them at all (no dynamic graph
// traversal in a fragment shader). So all the hard reasoning happens ONCE,
// on the CPU, at "bake" time (stroke release / flood click), producing a
// capped array of surface samples that already encode the topology-aware
// answer as a per-sample weight:
//
//   Euclidean brush (live drag): every raw stroke sample, weight = 1
//   Geodesic brush (on release): dense samples grown along the surface from
//                      the stroke (surfaceGraph.buildSurfaceGraph +
//                      dijkstraGeodesic), weight =
//                      wendlandC2(geodesicDistance / falloffRadius)
//   Curvature flood:  samples grown from a click seed while curvature stays
//                      similar (surfaceGraph.curvatureFlood), weight
//                      feathered near the flood boundary
//
// Once baked, EVERY mode is queried IDENTICALLY: nearest-neighbour-ish
// Euclidean/Wendland blending of the baked (position, weight) pairs. This
// is what keeps NodeEvaluator's and GLSLEvaluator's consumption code
// mode-agnostic — see evaluateMaskAt() below and its GLSL mirror in
// GLSLEvaluator._maskFieldGLSL(). Baked samples already "know" not to cross
// a fold, because the bake step never grew the graph across one; the query
// function itself does nothing topology-aware at all — it is deliberately
// as simple as embedNode's existing frame-blending code.
// ─────────────────────────────────────────────────────────────────────────────

/** A fresh, empty mask block — the default for every node. */
export function createEmptyMask() {
  return {
    enabled: false,
    mode: 'euclidean',        // 'euclidean' | 'geodesic' | 'curvatureFlood'
    falloffRadius: 0.4,
    // Off by default (gate fully open) — a hard/strict version of this
    // gate fragmented ordinary curved surfaces (sphere, capsule) into
    // disconnected "bubbles," mistaking normal amount-of-curvature for
    // an actual fold crossing. Raise only if paint visibly leaks across
    // a genuinely sharp edge.
    normalThreshold: -1,
    curvatureThreshold: 0.15,  // used by curvatureFlood bake only
    samples: [],                // [{x,y,z,nx,ny,nz,w}] — baked, see header
  };
}

/**
 * Smoothing amount for combining overlapping mask domes — see
 * smoothMaxJS/the GLSL smoothMax below. Not user-exposed; small enough
 * that it only softens genuinely adjacent domes, not the mask's overall
 * shape. If this ever needs tuning, expose it as a param at that point
 * rather than guessing now.
 */
export const MASK_BLEND_SMOOTHNESS = 1.5;

/**
 * Same smooth-min construction rUnion already uses (see GLSLEvaluator's
 * preamble) — kept here as a plain JS function so the CPU mask evaluator
 * can use the identical math instead of a hand-rolled approximation.
 */
function _smoothMinJS(a, b, s) {
  const k = Math.max(s * 0.05, 0.05);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** smoothMax(a,b) = -smoothMin(-a,-b) — the max-side counterpart. */
export function smoothMaxJS(a, b, s) {
  return -_smoothMinJS(-a, -b, s);
}

const FOLD_SOFTNESS = 0.15;

function _smoothstepLocal(edge0, edge1, x) {
  if (edge0 >= edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Effective dome radius for a set of mask samples — the ACTUAL radius
 * used to draw each sample's Wendland falloff, as opposed to the raw
 * falloffRadius param alone. Floors the radius at roughly the samples'
 * own nearest-neighbor spacing, so adjacent domes meaningfully overlap
 * (a continuous ridge) instead of merely touching or leaving gaps —
 * which is what produced the scalloped/cauliflower silhouette: a union
 * of same-sized circles spaced farther apart than their own radius
 * necessarily has visible petals between centers.
 *
 * O(n²) — fine at the sample counts these paths actually see (≤64 CPU,
 * ≤24 GLSL, both already capped elsewhere).
 *
 * @param {Array}  samples          Mask sample array ({x,y,z,...})
 * @param {number} [explicitRadius] The user's own falloffRadius setting
 * @returns {number}
 */
export function computeMaskDomeRadius(samples, explicitRadius) {
  const explicit = Math.max(explicitRadius ?? 0.4, 1e-4);
  if (!Array.isArray(samples) || samples.length < 2) return explicit;

  let maxNearest = 0;
  for (let i = 0; i < samples.length; i++) {
    let best = Infinity;
    for (let j = 0; j < samples.length; j++) {
      if (i === j) continue;
      const dx = samples[i].x - samples[j].x;
      const dy = samples[i].y - samples[j].y;
      const dz = samples[i].z - samples[j].z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < best) best = d;
    }
    if (isFinite(best) && best > maxNearest) maxNearest = best;
  }
  if (maxNearest === 0) return explicit;

  // COVERAGE FLOOR, not the final answer on its own: the previous
  // version returned maxNearest*2.0 UNCONDITIONALLY once >=2 samples
  // existed, silently ignoring the user's own Falloff Radius slider —
  // which is why that slider appeared to do nothing for ordinary
  // painted strokes. Now: take whichever is LARGER of (a) the user's
  // explicit radius — the real "how wide/sharp is this stroke" control
  // — and (b) the coverage floor, which exists ONLY to guarantee no
  // interpolation gaps between samples. Shrinking Falloff Radius now
  // genuinely thins/sharpens the stroke, down to whatever density it
  // was actually painted at (bake-time sample spacing already scales
  // with it — see SceneManager.bakeGeodesicMaskForNode's stepSize) —
  // so for a sharper result, lower Falloff Radius BEFORE painting.
  const coverageFloor = maxNearest * 2.0;
  return Math.max(explicit, coverageFloor);
}

/** True if this node's mask has any painted content worth evaluating. */
export function maskHasContent(mask) {
  return !!(mask && mask.enabled !== false && Array.isArray(mask.samples) && mask.samples.length > 0);
}

/**
 * Evaluate the baked mask field at a world/local query point. This is the
 * single CPU-side source of truth GLSLEvaluator._maskFieldGLSL() must
 * mirror exactly (see that method's own header comment for the mirror).
 *
 * Combine rule: MAX across samples, not sum — overlapping brush strokes
 * (or a flood region touching itself) must not push the value past 1.0.
 *
 * @param {object} mask   from createEmptyMask() / node.mask
 * @param {{x,y,z}} pt
 * @returns {number} in [0,1]
 */
  export function evaluateMaskAt(mask, pt) {
  if (!maskHasContent(mask)) return 0;
  const radius  = computeMaskDomeRadius(mask.samples, mask.falloffRadius);
  const nThresh = 1 - (mask.normalThreshold ?? -1);
  const samples = mask.samples;

  // 'euclidean' (live-drag, pre-bake) samples are a genuine path — the
  // mouse's actual trajectory across the surface — so distance is
  // measured to the nearest SEGMENT between consecutive samples, giving
  // a smooth capsule-swept-tube falloff instead of a chain of slightly
  // scalloped circles when sample spacing is coarse relative to the
  // falloff radius. Once geodesic/curvature-flood baking has run, the
  // samples represent a dense AREA grown outward from the stroke (see
  // surfaceGraph.js) — consecutive baked samples have no meaningful
  // "next point" relationship, so point-distance max is the correct (and
  // already smooth, given the graph's own even sampling) representation
  // there; a literal curve fit through an area's points would be fitting
  // a line to something that isn't one.
  if (mask.mode === 'euclidean' && samples.length >= 2) {
    return _evaluateSegmentedMask(samples, pt, radius, nThresh);
  }
  return _evaluatePointMask(samples, pt, radius, nThresh);
}

function _evaluatePointMask(samples, pt, radius, nThresh) {
  let sumW = 0;
  let sumWeighted = 0;
  let missProduct = 1;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dx = pt.x - s.x, dy = pt.y - s.y, dz = pt.z - s.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist >= radius) continue;

    // PINHOLE FIX: at dist≈0 (right at a stroke/flood-seed center) the
    // direction is undefined. Defaulting to 0 ("no deviation") rather
    // than 1 ("maximally misaligned") is required — the old "1" default
    // made a sample reject ITSELF at its own location, producing a
    // visible pinhole (or, for engrave, a bump) exactly where painted.
    const nDotOffset = dist > 1e-6
      ? (dx*s.nx + dy*s.ny + dz*s.nz) / dist
      : 0;

    const foldGate = nThresh >= 1
      ? 1
      : 1 - _smoothstepLocal(nThresh - FOLD_SOFTNESS, nThresh, Math.abs(nDotOffset));
    if (foldGate <= 1e-4) continue;

    const r = dist / radius;
    const kernel = ((1 - r) ** 4 * (4 * r + 1)) * foldGate;
    sumW += kernel;
    sumWeighted += kernel * (s.w ?? 1);
    missProduct *= (1 - kernel);
  }

  if (sumW <= 1e-6) return 0;
  const envelope = 1 - missProduct;
  const localAverage = Math.min(sumWeighted / sumW, 1);
  return Math.max(0, Math.min(envelope * localAverage, 1));
}

function _evaluateSegmentedMask(samples, pt, radius, nThresh) {
  let sumW = 0;
  let sumWeighted = 0;
  let missProduct = 1;

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const abLenSq = abx*abx + aby*aby + abz*abz;
    const apx = pt.x - a.x, apy = pt.y - a.y, apz = pt.z - a.z;
    const t = abLenSq > 1e-10
      ? Math.max(0, Math.min(1, (apx*abx + apy*aby + apz*abz) / abLenSq))
      : 0;
    const cx = a.x + abx*t, cy = a.y + aby*t, cz = a.z + abz*t;
    const dx = pt.x - cx, dy = pt.y - cy, dz = pt.z - cz;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist >= radius) continue;

    const nx = a.nx + (b.nx - a.nx) * t, ny = a.ny + (b.ny - a.ny) * t, nz = a.nz + (b.nz - a.nz) * t;
    const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    // Same pinhole fix as _evaluatePointMask — see its comment.
    const nDotOffset = dist > 1e-6 ? (dx*nx + dy*ny + dz*nz) / (dist*nLen) : 0;

    const foldGate = nThresh >= 1
      ? 1
      : 1 - _smoothstepLocal(nThresh - FOLD_SOFTNESS, nThresh, Math.abs(nDotOffset));
    if (foldGate <= 1e-4) continue;

    const r = dist / radius;
    const kernel = ((1 - r) ** 4 * (4 * r + 1)) * foldGate;
    const aw = a.w ?? 1, bw = b.w ?? 1;
    const segW = aw + (bw - aw) * t;
    sumW += kernel;
    sumWeighted += kernel * segW;
    missProduct *= (1 - kernel);
  }

  if (sumW <= 1e-6) return 0;
  const envelope = 1 - missProduct;
  const localAverage = Math.min(sumWeighted / sumW, 1);
  return Math.max(0, Math.min(envelope * localAverage, 1));
}

// Hard cap shared by the bake step (surfaceGraph.js) and GLSLEvaluator's
// fixed-slot unroll — same reasoning as frameField.js's MAX_EMBED_FRAMES:
// GLSL ES 1.0 has no non-const array indexing, so the baked array must
// have a compile-time-known maximum size. If this ever changes, change
// GLSLEvaluator's usage in the same commit.
export const MAX_MASK_SAMPLES = 64;

/**
 * Decimate a baked sample array down to MAX_MASK_SAMPLES via even striding
 * rather than blind truncation — keeps a representative spread across the
 * whole painted region instead of silently dropping everything after the
 * first 64 (which, for a long stroke, would only keep the start).
 */
export function decimateSamples(samples, cap = MAX_MASK_SAMPLES) {
  if (!Array.isArray(samples) || samples.length <= cap) return samples || [];
  if (cap <= 0) return [];

  // Farthest-point sampling: greedily keep whichever remaining point is
  // farthest (by minimum distance) from everything already kept. This
  // keeps the decimated set spatially REPRESENTATIVE of the full
  // painted area. Plain index-striding has no such guarantee — it can
  // silently retain a tight cluster while dropping every sample that
  // was bridging a gap elsewhere, which is exactly what starved
  // evaluateMaskAt of nearby samples and produced visible facets in the
  // embedded geometry. O(cap * n): trivial at the sample counts this
  // ever runs on (n <= 64, cap <= 64/24).
  const n = samples.length;
  const minDistSq = new Float64Array(n).fill(Infinity);
  const selected = [];

  let current = 0; // deterministic seed
  for (let picked = 0; picked < cap; picked++) {
    selected.push(samples[current]);
    minDistSq[current] = -1; // mark selected — never re-picked

    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < n; i++) {
      if (minDistSq[i] < 0) continue;
      const s = samples[i], c = samples[current];
      const dx = s.x - c.x, dy = s.y - c.y, dz = s.z - c.z;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < minDistSq[i]) minDistSq[i] = d;
      if (minDistSq[i] > bestDist) { bestDist = minDistSq[i]; bestIdx = i; }
    }
    if (bestIdx === -1) break; // fewer than `cap` distinct points available
    current = bestIdx;
  }

  return selected;
}

/**
 * Convert baked mask samples into the {c0,T,B,N,Sxx,Sxy,Syy} frame-array
 * shape evaluateBlendedFrame() (frameField.js) expects, so a painted
 * region can build embedNode's OWN local coordinate frame — REPLACING
 * buildAdaptiveFrameField's anchor-centered field when
 * maskSource==='paintedRegion', rather than only reshaping its boundary.
 *
 * Decimated independently from the mask's own (possibly much denser)
 * sample array — good FRAMING needs a handful of well-spread points, not
 * a dense point cloud; using all of them would multiply per-pixel cost in
 * the GLSL unroll for no positional benefit. Falls back to reconstructing
 * a tangent frame from the normal alone (via the same Gram-Schmidt method
 * computeLocalFrame itself uses) for any sample missing tangent data —
 * e.g. a scene saved before this frame-carrying upgrade.
 *
 * @param {object} mask
 * @param {number} [maxFrames=6]  Must not exceed GLSLEvaluator's
 *   MAX_EMBED_FRAMES — kept at the frameField.js default.
 * @returns {Array<{c0,T,B,N,Sxx,Sxy,Syy}>}
 */
export function deriveEmbedFramesFromMask(mask, maxFrames = 6) {
  if (!maskHasContent(mask)) return [];
  const picked = decimateSamples(mask.samples, maxFrames);
  return picked.map(s => {
    const N = { x: s.nx, y: s.ny, z: s.nz };
    let T, B;
    if (isFinite(s.tx) && isFinite(s.ty) && isFinite(s.tz)) {
      T = { x: s.tx, y: s.ty, z: s.tz };
      B = { x: s.bx, y: s.by, z: s.bz };
    } else {
      const rebuilt = buildTangentFrameFromNormal(N);
      T = rebuilt.tangent;
      B = rebuilt.bitangent;
    }
    return {
      c0: { x: s.x, y: s.y, z: s.z },
      T, B, N,
      Sxx: s.Sxx ?? 0, Sxy: s.Sxy ?? 0, Syy: s.Syy ?? 0,
    };
  });
}

/**
 * Collapse an entire painted/flooded mask into ONE coherent local frame —
 * the average position and average (renormalized) facing direction of
 * every sample — rather than deriveEmbedFramesFromMask's 6 scattered
 * anchor points. Curvature (Sxx/Sxy/Syy) is combined as TENSORS in a
 * shared ambient basis (each sample's own T/B are already 3-vectors in
 * one common coordinate system, so their outer products can be summed
 * validly), then re-projected into the collapsed frame's own (T,B) —
 * summing raw Sxx/Sxy/Syy across samples directly would be invalid,
 * since those numbers are only meaningful relative to each sample's OWN
 * tangent basis.
 */
export function deriveCentroidEmbedFrame(mask) {
  if (!maskHasContent(mask)) return [];
  const samples = mask.samples;
  const n = samples.length;

  // Curvature-magnitude weight per sample. A sample sitting on a
  // distinctive feature (an edge, a fillet, a bump) now pulls the
  // collapsed anchor and its facing direction toward itself more than a
  // sample on an ambient flat part of the same patch. EPS is a floor so
  // an all-flat patch (curvature ~0 everywhere) degrades gracefully to
  // plain uniform averaging rather than every weight collapsing to 0/0.
  const EPS = 1e-3;
  const weights = samples.map(s => {
    if (!isFinite(s.Sxx)) return EPS;
    return Math.sqrt(s.Sxx*s.Sxx + 2*s.Sxy*s.Sxy + s.Syy*s.Syy) + EPS;
  });
  let wSum = 0; weights.forEach(w => wSum += w);

  let cx = 0, cy = 0, cz = 0;
  samples.forEach((s, i) => { cx += s.x*weights[i]; cy += s.y*weights[i]; cz += s.z*weights[i]; });
  cx /= wSum; cy /= wSum; cz /= wSum;

  // Normal — now ALSO curvature-weighted (previously a plain average).
  // Still fundamentally a linear combination: two flat facets meeting at
  // a hard fold can share IDENTICAL (near-zero) curvature while facing
  // completely different directions, so curvature weighting cannot
  // rescue a region that genuinely spans a fold — the degeneracy check
  // below is the honest signal for that case, not a fix for it.
  let nx = 0, ny = 0, nz = 0;
  samples.forEach((s, i) => { nx += s.nx*weights[i]; ny += s.ny*weights[i]; nz += s.nz*weights[i]; });
  const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz);
  const degenerate = nLen < wSum * 0.4; // summed normals mostly cancelled out
  const N = degenerate
    ? { x: 0, y: 1, z: 0 }   // stable but arbitrary fallback
    : { x: nx / nLen, y: ny / nLen, z: nz / nLen };
  const { tangent: T, bitangent: B } = buildTangentFrameFromNormal(N);

  // Curvature tensor combination is UNCHANGED — it is already
  // self-weighting, since a near-flat sample's own Sxx/Sxy/Syy contribute
  // near-nothing to the sum regardless of any extra factor.
  const M = [[0,0,0],[0,0,0],[0,0,0]];
  let curvCount = 0;
  samples.forEach(s => {
    if (!isFinite(s.Sxx) || !isFinite(s.tx)) return;
    const sT = { x: s.tx, y: s.ty, z: s.tz };
    const sB = { x: s.bx, y: s.by, z: s.bz };
    const addOuter = (u, v, w) => {
      M[0][0] += w*u.x*v.x; M[0][1] += w*u.x*v.y; M[0][2] += w*u.x*v.z;
      M[1][0] += w*u.y*v.x; M[1][1] += w*u.y*v.y; M[1][2] += w*u.y*v.z;
      M[2][0] += w*u.z*v.x; M[2][1] += w*u.z*v.y; M[2][2] += w*u.z*v.z;
    };
    addOuter(sT, sT, s.Sxx);
    addOuter(sB, sB, s.Syy);
    addOuter(sT, sB, s.Sxy);
    addOuter(sB, sT, s.Sxy);
    curvCount++;
  });

  let Sxx = 0, Sxy = 0, Syy = 0;
  if (curvCount > 0) {
    const inv = 1 / curvCount;
    const applyM = (v) => ({
      x: M[0][0]*v.x + M[0][1]*v.y + M[0][2]*v.z,
      y: M[1][0]*v.x + M[1][1]*v.y + M[1][2]*v.z,
      z: M[2][0]*v.x + M[2][1]*v.y + M[2][2]*v.z,
    });
    const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
    const MT = applyM(T), MB = applyM(B);
    Sxx = inv * dot(T, MT);
    Syy = inv * dot(B, MB);
    Sxy = inv * dot(T, MB);
  }

  return [{
    c0: { x: cx, y: cy, z: cz }, T, B, N, Sxx, Sxy, Syy,
    _degenerateNormal: degenerate,
  }];
}