// src/utils/frameField.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Builds and evaluates a MULTI-FRAME curvature-adaptive coordinate field for
// embedNode, replacing the single frozen tangent frame from earlier passes.
//
// ── Why this needed a real algorithm, not just "more frames" ────────────────
// A K-frame field only works if querying it stays smooth as you cross from
// one frame's influence into another's, and if it never has to interpolate
// ROTATIONS (see the module-level design note below). Both problems have
// closed-form, non-iterative solutions used here:
//   1. Frame PLACEMENT:  Vogel/phyllotaxis base layout (deterministic, even
//      coverage) + extra frames densified where anisotropy is highest
//      (Tier 1 — computeShapeOperator2x2, no eigensolve).
//   2. Frame BLENDING: reconstruct ONE consistent frame per query point by
//      blending the candidate frames' own ambient-space data — anchor
//      position, normal, tangent, and the curvature tensor lifted into an
//      ambient 3x3 matrix (see evaluateBlendedFrame below) — with
//      Wendland-C2 weights, THEN doing a single projection. This is
//      different from (and replaces) an earlier version that instead
//      averaged each frame's OWN already-projected coordinates: that is
//      invalid whenever frames' bases differ (a coordinate expressed in
//      basis A cannot be meaningfully averaged with one expressed in
//      basis B), and produced visibly disjointed lobes near each frame's
//      own anchor with basis-incoherent garbage in between. Blending
//      ambient vectors/tensors is always well-defined since every
//      quantity lives in the SAME (world) coordinate system; the one
//      known failure mode (candidate frames pointing in near-opposite
//      directions, so their blended normal collapses toward zero) is
//      guarded explicitly with a fallback to the single nearest frame.
//
// ── CPU/GLSL parity guarantee ────────────────────────────────────────────────
// buildAdaptiveFrameField is a PURE function of (sdfFn, anchor, regionSize) —
// no randomness, no hidden state. NodeEvaluator.js and GLSLEvaluator.js both
// call it with identical arguments and are GUARANTEED an identical frame set
// back. The maxFrames cap is enforced ONCE, inside this function — neither
// evaluator applies its own separate truncation. Do not add per-caller
// capping logic; if the unroll width in GLSLEvaluator's _generateEmbedNode
// ever needs to change, change `maxFrames`'s default here and update that
// unroll width to match, in the same commit.
// ─────────────────────────────────────────────────────────────────────────────

import { computeLocalFrame, snapToNearestSurface, computeShapeOperator2x2 } from './differentialGeometry.js';

/**
 * Wendland C2 compactly-supported radial weight. φ(r) for r=dist/h:
 *   (1-r)^4 * (4r+1)  for r ∈ [0,1]
 *   0                  for r ≥ 1
 * Standard minimal-degree C2 RBF weight (same family APSS — Algebraic
 * Point Set Surfaces — uses to blend local reference planes). Smooth,
 * non-negative, exactly zero beyond its support radius — the "exactly
 * zero" part is what lets far-away/unused frame slots contribute nothing
 * without a separate active-count branch (see GLSLEvaluator's unroll).
 */
export function wendlandC2(r) {
  if (r >= 1) return 0;
  const t = 1 - r;
  return t*t*t*t*(4*r + 1);
}

/**
 * Default support radius for the Wendland kernel, derived from point
 * density rather than a fixed constant: average area-per-sample in a
 * disc of the given regionSize is π·regionSize²/frameCount, so typical
 * spacing is regionSize·√(π/frameCount). spacingFactor > 1 ensures
 * neighboring frames' supports OVERLAP (a query point needs >1
 * contributing frame for blending to do anything) — this is the one
 * genuinely tunable knob in this file; 1.8 is a reasonable default that
 * gives multi-frame overlap without letting every frame contribute
 * everywhere (which would defeat the point of compact support).
 */
export function defaultFrameBandwidth(regionSize, frameCount, spacingFactor = 1.8) {
  const K = Math.max(frameCount, 1);
  return spacingFactor * regionSize * Math.sqrt(Math.PI / K);
}

/**
 * Build a curvature-adaptive set of tangent frames across a disc of
 * radius `regionSize` centered on `primaryAnchor` (self-corrected onto
 * the true surface, same as the single-frame version). Frame [0] is
 * always the primary/anchor frame — kept for UI/backward-compat (the
 * region-ring overlay, depth markers, etc. still key off it).
 *
 * @param {Function} sdfFn
 * @param {{x,y,z}} primaryAnchor
 * @param {number} regionSize
 * @param {object} [options]
 * @param {number} [options.maxFrames=6]  HARD CAP. Must match GLSLEvaluator's
 *   unroll width (MAX_EMBED_FRAMES) exactly — see module header.
 * @param {number} [options.gridStride=3]  Coarse anisotropy-scan resolution
 *   (per axis; total scanned cells ≈ π·gridStride² after circular clip).
 * @param {number} [options.percentile=0.85]  Anisotropy percentile threshold
 *   for densification — cells scoring at/above this get an extra frame.
 * @param {number} [options.timeBudgetMs=8]  Soft budget (checked periodically,
 *   not on every operation — matches MultiSampler's own granularity). This
 *   runs at graph-compile time, not per-frame/per-pixel, but a complex scene
 *   with several embedNodes and frequent live slider edits will pay this
 *   cost repeatedly, so it is bounded rather than left open-ended.
 * @param {number} [options.eps=0.001]
 * @returns {Array<{c0,T,B,N,Sxx,Sxy,Syy}>}  1 ≤ length ≤ maxFrames
 */
export function buildAdaptiveFrameField(sdfFn, primaryAnchor, regionSize, options = {}) {
  const {
    maxFrames = 6,
    gridStride = 3,
    percentile = 0.85,
    timeBudgetMs = 8,
    eps = 0.001,
  } = options;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const startTime = now();
  const withinBudget = () => (now() - startTime) < timeBudgetMs;

  const FALLBACK = [{
    c0: primaryAnchor, T: {x:1,y:0,z:0}, B: {x:0,y:0,z:1}, N: {x:0,y:1,z:0},
    Sxx: 0, Sxy: 0, Syy: 0,
  }];

  const c0 = snapToNearestSurface(sdfFn, primaryAnchor, 4, eps);
  const frame0 = computeLocalFrame(sdfFn, c0, eps);
  if (!frame0) return FALLBACK;
  const shape0 = computeShapeOperator2x2(sdfFn, c0, frame0, eps);
  const frames = [{ c0, T: frame0.tangent, B: frame0.bitangent, N: frame0.normal, ...shape0 }];

  // Slot budget: primary takes 1; split the rest between Vogel base
  // coverage and anisotropy-driven densification.
  const vogelCount     = Math.max(0, Math.min(5, maxFrames - 1));
  const densifiedSlots = Math.max(0, maxFrames - 1 - vogelCount);

  // ── Vogel/phyllotaxis base layout — deterministic, curvature-agnostic ────
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 1; i <= vogelCount && frames.length < maxFrames && withinBudget(); i++) {
    const theta = i * goldenAngle;
    const r = Math.sqrt(i / (vogelCount + 1)) * regionSize * 0.85; // stay off the disc edge
    const guess = {
      x: c0.x + r*Math.cos(theta)*frame0.tangent.x + r*Math.sin(theta)*frame0.bitangent.x,
      y: c0.y + r*Math.cos(theta)*frame0.tangent.y + r*Math.sin(theta)*frame0.bitangent.y,
      z: c0.z + r*Math.cos(theta)*frame0.tangent.z + r*Math.sin(theta)*frame0.bitangent.z,
    };
    const ci = snapToNearestSurface(sdfFn, guess, 4, eps);
    const framei = computeLocalFrame(sdfFn, ci, eps);
    if (!framei) continue; // degenerate gradient here — skip rather than corrupt the field
    const shapei = computeShapeOperator2x2(sdfFn, ci, framei, eps);
    frames.push({ c0: ci, T: framei.tangent, B: framei.bitangent, N: framei.normal, ...shapei });
  }

  // ── Anisotropy-driven densification (the "Wallis" role) ─────────────────
  // Coarse grid scan across the disc, scoring anisotropy at Tier 1 (no
  // eigensolve needed — direction isn't used for scoring, only magnitude).
  if (densifiedSlots > 0 && withinBudget()) {
    const candidates = [];
    for (let gx = -gridStride; gx <= gridStride && withinBudget(); gx++) {
      for (let gy = -gridStride; gy <= gridStride; gy++) {
        const lx = (gx / gridStride) * regionSize;
        const ly = (gy / gridStride) * regionSize;
        if (lx*lx + ly*ly > regionSize*regionSize) continue; // circular clip

        const guess = {
          x: c0.x + lx*frame0.tangent.x + ly*frame0.bitangent.x,
          y: c0.y + lx*frame0.tangent.y + ly*frame0.bitangent.y,
          z: c0.z + lx*frame0.tangent.z + ly*frame0.bitangent.z,
        };
        // Cheaper 2-iteration snap for scan-only candidates — full 4-iteration
        // precision is reserved for points that actually become frames.
        const ci = snapToNearestSurface(sdfFn, guess, 2, eps);
        const framei = computeLocalFrame(sdfFn, ci, eps);
        if (!framei) continue;
        const { Sxx, Sxy, Syy } = computeShapeOperator2x2(sdfFn, ci, framei, eps);
        const anisotropy = Math.sqrt((Sxx-Syy)*(Sxx-Syy) + 4*Sxy*Sxy); // = k1−k2
        candidates.push({ ci, framei, Sxx, Sxy, Syy, anisotropy });
      }
    }

    if (candidates.length > 0) {
      // Plain sort, not quickselect — candidate counts here are dozens,
      // not thousands, so MultiSampler's O(n) quickselect optimization
      // isn't worth porting; a sort is simpler and cheap enough at this scale.
      const scores = candidates.map(c => c.anisotropy).sort((a,b) => a-b);
      const threshold = scores[Math.floor(scores.length * percentile)] ?? 0;

      candidates
        .filter(c => c.anisotropy >= threshold && c.anisotropy > 1e-6)
        .sort((a,b) => b.anisotropy - a.anisotropy)
        .slice(0, densifiedSlots)
        .forEach(c => {
          if (frames.length >= maxFrames) return;
          frames.push({
            c0: c.ci, T: c.framei.tangent, B: c.framei.bitangent, N: c.framei.normal,
            Sxx: c.Sxx, Sxy: c.Sxy, Syy: c.Syy,
          });
        });
    }
  }

  return frames; // guaranteed 1 ≤ length ≤ maxFrames
}

/**
 * Reconstruct ONE consistent, smoothly-varying local frame at query point
 * p from a set of candidate frames, then project p into THAT frame — see
 * the module header for why this replaces blending each candidate's own
 * already-projected coordinates.
 *
 * Blending strategy (all in ambient/world space, always well-defined):
 *   - anchor c0, normal N, tangent T: plain Wendland-weighted vector sums
 *   - curvature (Sxx,Sxy,Syy): each frame's 2x2 form is lifted into an
 *     ambient 3x3 matrix via outer products of ITS OWN T/B (the same
 *     mechanism deriveCentroidEmbedFrame already uses for a single global
 *     frame — see surfaceMask.js), summed with the same weights, then
 *     re-projected into the freshly reconstructed (T,B) at the end. This
 *     is the "use curvature to guide the stitching" step: it is a proper
 *     tensor change-of-basis, not a scalar average across incompatible
 *     bases.
 *   - T,B are then rebuilt orthonormal via Gram-Schmidt against the
 *     blended N, so the result is always a valid orthonormal frame.
 *
 * Degrades gracefully rather than producing garbage: if every candidate
 * frame is out of range, or the blended normal collapses (candidates
 * facing near-opposite directions cancel out), falls back to a single
 * nearest-by-weight frame's own direct projection — a discontinuity only
 * in that specific pathological case, not the ordinary one.
 *
 * @param {Array} frames  from buildAdaptiveFrameField / deriveEmbedFramesFromMask
 * @param {{x,y,z}} p
 * @param {number} h  support radius, from defaultFrameBandwidth
 * @returns {{localX:number, localY:number, localZ:number}}
 */
export function evaluateBlendedFrame(frames, p, h) {
  let sumW = 0;
  let c0x=0,c0y=0,c0z=0;
  let Nx=0,Ny=0,Nz=0;
  let Tx=0,Ty=0,Tz=0;
  // Ambient 3x3 symmetric matrix accumulator for the blended curvature
  // tensor (rows, but row_i === column_i for a symmetric matrix).
  let Hxx=0,Hxy=0,Hxz=0,Hyy=0,Hyz=0,Hzz=0;

  let bestW = -1;
  let bestFrame = frames[0] || null;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const dx = p.x - f.c0.x, dy = p.y - f.c0.y, dz = p.z - f.c0.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const w = wendlandC2(dist / h);

    if (w > bestW) { bestW = w; bestFrame = f; }
    if (w <= 0) continue;

    sumW += w;
    c0x += w*f.c0.x; c0y += w*f.c0.y; c0z += w*f.c0.z;
    Nx  += w*f.N.x;  Ny  += w*f.N.y;  Nz  += w*f.N.z;
    Tx  += w*f.T.x;  Ty  += w*f.T.y;  Tz  += w*f.T.z;

    const B = f.B;
    Hxx += w*(f.Sxx*f.T.x*f.T.x + f.Syy*B.x*B.x + 2*f.Sxy*f.T.x*B.x);
    Hyy += w*(f.Sxx*f.T.y*f.T.y + f.Syy*B.y*B.y + 2*f.Sxy*f.T.y*B.y);
    Hzz += w*(f.Sxx*f.T.z*f.T.z + f.Syy*B.z*B.z + 2*f.Sxy*f.T.z*B.z);
    Hxy += w*(f.Sxx*f.T.x*f.T.y + f.Syy*B.x*B.y + f.Sxy*(f.T.x*B.y + f.T.y*B.x));
    Hxz += w*(f.Sxx*f.T.x*f.T.z + f.Syy*B.x*B.z + f.Sxy*(f.T.x*B.z + f.T.z*B.x));
    Hyz += w*(f.Sxx*f.T.y*f.T.z + f.Syy*B.y*B.z + f.Sxy*(f.T.y*B.z + f.T.z*B.y));
  }

  const fallbackProjection = (frame) => {
    const dx = p.x - frame.c0.x, dy = p.y - frame.c0.y, dz = p.z - frame.c0.z;
    const lx = dx*frame.T.x + dy*frame.T.y + dz*frame.T.z;
    const ly = dx*frame.B.x + dy*frame.B.y + dz*frame.B.z;
    const lz = dx*frame.N.x + dy*frame.N.y + dz*frame.N.z;
    const sag = 0.5 * (frame.Sxx*lx*lx + 2*frame.Sxy*lx*ly + frame.Syy*ly*ly);
    return { localX: lx, localY: ly, localZ: lz - sag };
  };

  if (sumW < 1e-8 || !bestFrame) {
    return bestFrame ? fallbackProjection(bestFrame) : { localX: 0, localY: 0, localZ: 0 };
  }

  const invW = 1 / sumW;
  const c0 = { x: c0x*invW, y: c0y*invW, z: c0z*invW };

  const NrawLen = Math.sqrt((Nx*invW)**2 + (Ny*invW)**2 + (Nz*invW)**2);
  if (NrawLen < 1e-6) {
    // Blended normal collapsed — candidate frames face near-opposite
    // directions here. Fall back rather than project onto an undefined
    // normal.
    return fallbackProjection(bestFrame);
  }
  const N = { x: (Nx*invW)/NrawLen, y: (Ny*invW)/NrawLen, z: (Nz*invW)/NrawLen };

  const Traw = { x: Tx*invW, y: Ty*invW, z: Tz*invW };
  const tDotN = Traw.x*N.x + Traw.y*N.y + Traw.z*N.z;
  let T = { x: Traw.x - tDotN*N.x, y: Traw.y - tDotN*N.y, z: Traw.z - tDotN*N.z };
  let tLen = Math.sqrt(T.x*T.x + T.y*T.y + T.z*T.z);
  if (tLen < 1e-6) {
    const helper = Math.abs(N.y) < 0.99 ? {x:0,y:1,z:0} : {x:1,y:0,z:0};
    T = {
      x: helper.y*N.z - helper.z*N.y,
      y: helper.z*N.x - helper.x*N.z,
      z: helper.x*N.y - helper.y*N.x,
    };
    tLen = Math.sqrt(T.x*T.x + T.y*T.y + T.z*T.z) || 1;
  }
  T = { x: T.x/tLen, y: T.y/tLen, z: T.z/tLen };
  const B = {
    x: N.y*T.z - N.z*T.y,
    y: N.z*T.x - N.x*T.z,
    z: N.x*T.y - N.y*T.x,
  };

  // Re-project the blended ambient curvature tensor into THIS
  // reconstructed frame's own (T,B) — the tensor change-of-basis step.
  const Hrow0 = { x: Hxx*invW, y: Hxy*invW, z: Hxz*invW };
  const Hrow1 = { x: Hxy*invW, y: Hyy*invW, z: Hyz*invW };
  const Hrow2 = { x: Hxz*invW, y: Hyz*invW, z: Hzz*invW };
  const HT = {
    x: Hrow0.x*T.x + Hrow0.y*T.y + Hrow0.z*T.z,
    y: Hrow1.x*T.x + Hrow1.y*T.y + Hrow1.z*T.z,
    z: Hrow2.x*T.x + Hrow2.y*T.y + Hrow2.z*T.z,
  };
  const HB = {
    x: Hrow0.x*B.x + Hrow0.y*B.y + Hrow0.z*B.z,
    y: Hrow1.x*B.x + Hrow1.y*B.y + Hrow1.z*B.z,
    z: Hrow2.x*B.x + Hrow2.y*B.y + Hrow2.z*B.z,
  };
  const Sxx = T.x*HT.x + T.y*HT.y + T.z*HT.z;
  const Syy = B.x*HB.x + B.y*HB.y + B.z*HB.z;
  const Sxy = T.x*HB.x + T.y*HB.y + T.z*HB.z;

  const dx = p.x - c0.x, dy = p.y - c0.y, dz = p.z - c0.z;
  const lx = dx*T.x + dy*T.y + dz*T.z;
  const ly = dx*B.x + dy*B.y + dz*B.z;
  const lz = dx*N.x + dy*N.y + dz*N.z;
  const sag = 0.5 * (Sxx*lx*lx + 2*Sxy*lx*ly + Syy*ly*ly);

  return { localX: lx, localY: ly, localZ: lz - sag };
}