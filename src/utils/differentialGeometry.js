// src/utils/differentialGeometry.js
//
// ── Abstraction boundary (read this first) ──────────────────────────────────
// Every function here operates purely on `sdfFn: (point) => number`. None of
// them know or care what coordinate space that function's `point` argument
// lives in — world space, an embedNode's local tangent frame, or (after any
// future HSEG-style nested evaluation) a guest shape's own local space. As
// long as sdfFn is a valid point-in/distance-out function, these utilities
// are correct. This is a deliberate design boundary: it's what lets the same
// gradient/curvature/frame math serve embedNode, the orbit camera, and any
// future embedding work without those callers needing awareness of each
// other. Keep it this way — do not have any function here reach into graph
// structure, node types, or transform state.
//
// ── Scope note ───────────────────────────────────────────────────────────────
// This module deliberately does NOT attempt to unify DistanceMapper,
// EmbeddingMapper, and these differential-geometry helpers into one
// abstraction. That's a real future direction (several features would need
// to depend on it before it's worth the conceptual overhead), not something
// to force now.

/** Central-difference gradient of a 3D SDF at a point. Raw (unnormalized). */
export function computeGradient3D(sdfFn, point, eps = 0.001) {
  // Defensive guard — a null/undefined point here previously produced an
  // opaque "Cannot read properties of null (reading 'x')" crash with no
  // indication of which caller passed it. Returning a zero gradient is a
  // safe, inert default; computeNormal3D correctly treats a zero gradient
  // as degenerate and returns null rather than an unstable direction.
  if (!point) return { x: 0, y: 0, z: 0 };
  const dx = (sdfFn({x:point.x+eps,y:point.y,z:point.z}) - sdfFn({x:point.x-eps,y:point.y,z:point.z})) / (2*eps);
  const dy = (sdfFn({x:point.x,y:point.y+eps,z:point.z}) - sdfFn({x:point.x,y:point.y-eps,z:point.z})) / (2*eps);
  const dz = (sdfFn({x:point.x,y:point.y,z:point.z+eps}) - sdfFn({x:point.x,y:point.y,z:point.z-eps})) / (2*eps);
  return { x: dx, y: dy, z: dz };
}

/**
 * Normalized surface normal at a point. Returns null (NOT a zero vector)
 * if the gradient magnitude is below gradEps — callers must handle this
 * explicitly rather than silently receiving an unstable/meaningless
 * direction. This matters most near smooth-union/blend seams, where the
 * true gradient can genuinely approach zero.
 */
export function computeNormal3D(sdfFn, point, eps = 0.001, gradEps = 1e-8) {
  const g = computeGradient3D(sdfFn, point, eps);
  const gradSq = g.x*g.x + g.y*g.y + g.z*g.z;
  if (gradSq < gradEps) return null;
  const len = Math.sqrt(gradSq);
  return { x: g.x/len, y: g.y/len, z: g.z/len };
}

/**
 * Build an orthonormal tangent frame (T, B) given an already-known normal
 * N, via Gram-Schmidt against an axis-aligned helper vector. Split out
 * from computeLocalFrame() so callers that already have a normal (e.g. a
 * cached one, or one computed via a different method) don't redundantly
 * recompute it.
 */
export function buildTangentFrameFromNormal(normal) {
  const helper = Math.abs(normal.y) < 0.99 ? {x:0,y:1,z:0} : {x:1,y:0,z:0};
  let tx = helper.y*normal.z - helper.z*normal.y;
  let ty = helper.z*normal.x - helper.x*normal.z;
  let tz = helper.x*normal.y - helper.y*normal.x;
  const tlen = Math.sqrt(tx*tx+ty*ty+tz*tz) || 1;
  tx/=tlen; ty/=tlen; tz/=tlen;
  const bx = normal.y*tz - normal.z*ty;
  const by = normal.z*tx - normal.x*tz;
  const bz = normal.x*ty - normal.y*tx;
  return { tangent: {x:tx,y:ty,z:tz}, bitangent: {x:bx,y:by,z:bz} };
}

/**
 * Full local frame at a surface point: normal, tangent, bitangent. The
 * shared building block embedNode, the orbit camera, and any future
 * embossing/HSEG work should all consume — a single, tested notion of
 * "a local coordinate frame anchored to a surface point," rather than
 * each feature growing its own inline copy of this math (which is
 * exactly how embedNode's frame-building code came to be duplicated
 * across NodeEvaluator.js and GLSLEvaluator.js in the first place).
 * Returns null if the normal is degenerate at this point (see
 * computeNormal3D) — callers must handle this case.
 */
export function computeLocalFrame(sdfFn, point, eps = 0.001) {
  const normal = computeNormal3D(sdfFn, point, eps);
  if (!normal) return null;
  const { tangent, bitangent } = buildTangentFrameFromNormal(normal);
  return { point: { ...point }, normal, tangent, bitangent };
}

/**
 * Tier 1 curvature: the shape operator S, projected into an ALREADY-KNOWN
 * tangent frame (T, B), expressed as its 2×2 symmetric components
 * {Sxx, Sxy, Syy} — no eigensolve. This is deliberately the minimal thing
 * embedNode's sag correction needs; it is NOT a cut-down version of
 * computePrincipalCurvatures3D, it is the strict subset that function is
 * built on top of (see computePrincipalCurvatures3D below).
 *
 * `frame` MUST be the caller's own computeLocalFrame(...) result — passed
 * in, never recomputed here. This is what lets embedNode reuse the exact
 * same (T, B) it already built for guest-sampling coordinates, guaranteeing
 * the sag correction and the sampling basis can never drift out of
 * alignment by construction, not by careful bookkeeping. It is also the
 * actual performance win: computing the frame here internally would cost
 * an extra 6 SDF evaluations (computeGradient3D's stencil) that the caller
 * already paid for.
 *
 * DERIVATION — why no 3×3 matrix multiply is needed:
 * The textbook formula is S = +(1/|∇F|)·P·H·P, where P = I − N·Nᵀ is the
 * tangent-plane projector. But T and B are already IN the tangent plane
 * (both ⊥ N by construction in computeLocalFrame), so P·T ≡ T and P·B ≡ B
 * exactly — applying the projector to a vector already in the plane is a
 * no-op. That collapses Tᵀ·P·H·P·T to plain Tᵀ·H·T, so no P is ever built:
 *   Sxx = (1/|∇F|)·(T·H·T),  Sxy = (1/|∇F|)·(T·H·B),  Syy = (1/|∇F|)·(B·H·B)
 *
 * SIGN CONVENTION (load-bearing, not a style choice): the coefficient is
 * POSITIVE (1/|∇F|), not the textbook shape-operator's usual −dN. This is
 * fixed by matching computeMeanCurvature3D's existing sign: that function
 * returns +1/R (not −1/R) for a sphere F=|p|−R with outward gradient, and
 * (Sxx+Syy)/2 must reduce to that exact value. Verified by hand for a
 * sphere at (R,0,0): H = diag(0, 1/R, 1/R) in world axes, T,B spanning the
 * tangent plane there gives Sxx=Syy=1/R with the positive sign (matches
 * computeMeanCurvature3D exactly) and Sxx=Syy=−1/R with the negative sign
 * (does not match — would silently flip convex/concave for any
 * anisotropic host, since the sign only becomes visible once Sxx≠Syy).
 *
 * Costs ZERO additional SDF evaluations beyond computeMeanCurvature3D's
 * existing 19-evaluation stencil (1 center + 6 axis + 12 corner) — the
 * only added cost versus that function is arithmetic (two Hessian·vector
 * products and three dot products, in place of one divergence formula).
 *
 * @param {Function} sdfFn
 * @param {{x,y,z}} point           — MUST equal the point `frame` was built at
 * @param {{tangent,bitangent}} frame — from computeLocalFrame(sdfFn, point)
 * @param {number} [eps]
 * @returns {{Sxx:number, Sxy:number, Syy:number}}
 */
export function computeShapeOperator2x2(sdfFn, point, frame, eps = 0.001) {
  const p = point;
  const f = sdfFn(p);

  const fxPlus  = sdfFn({x:p.x+eps, y:p.y,     z:p.z});
  const fxMinus = sdfFn({x:p.x-eps, y:p.y,     z:p.z});
  const fyPlus  = sdfFn({x:p.x,     y:p.y+eps, z:p.z});
  const fyMinus = sdfFn({x:p.x,     y:p.y-eps, z:p.z});
  const fzPlus  = sdfFn({x:p.x,     y:p.y,     z:p.z+eps});
  const fzMinus = sdfFn({x:p.x,     y:p.y,     z:p.z-eps});

  const fx = (fxPlus - fxMinus) / (2*eps);
  const fy = (fyPlus - fyMinus) / (2*eps);
  const fz = (fzPlus - fzMinus) / (2*eps);

  const fxx = (fxPlus - 2*f + fxMinus) / (eps*eps);
  const fyy = (fyPlus - 2*f + fyMinus) / (eps*eps);
  const fzz = (fzPlus - 2*f + fzMinus) / (eps*eps);

  const fxy = (sdfFn({x:p.x+eps,y:p.y+eps,z:p.z}) - sdfFn({x:p.x+eps,y:p.y-eps,z:p.z})
            - sdfFn({x:p.x-eps,y:p.y+eps,z:p.z}) + sdfFn({x:p.x-eps,y:p.y-eps,z:p.z})) / (4*eps*eps);
  const fyz = (sdfFn({x:p.x,y:p.y+eps,z:p.z+eps}) - sdfFn({x:p.x,y:p.y+eps,z:p.z-eps})
            - sdfFn({x:p.x,y:p.y-eps,z:p.z+eps}) + sdfFn({x:p.x,y:p.y-eps,z:p.z-eps})) / (4*eps*eps);
  const fxz = (sdfFn({x:p.x+eps,y:p.y,z:p.z+eps}) - sdfFn({x:p.x-eps,y:p.y,z:p.z+eps})
            - sdfFn({x:p.x+eps,y:p.y,z:p.z-eps}) + sdfFn({x:p.x-eps,y:p.y,z:p.z-eps})) / (4*eps*eps);

  const gradSq = fx*fx + fy*fy + fz*fz;
  if (gradSq < 1e-10) return { Sxx: 0, Sxy: 0, Syy: 0 };
  const invGrad = 1 / Math.sqrt(gradSq);

  const { tangent: T, bitangent: B } = frame;

  // H·T and H·B — matrix-vector products against the symmetric Hessian.
  // No P is built (see the derivation above): T,B are already tangent.
  const HTx = fxx*T.x + fxy*T.y + fxz*T.z;
  const HTy = fxy*T.x + fyy*T.y + fyz*T.z;
  const HTz = fxz*T.x + fyz*T.y + fzz*T.z;

  const HBx = fxx*B.x + fxy*B.y + fxz*B.z;
  const HBy = fxy*B.x + fyy*B.y + fyz*B.z;
  const HBz = fxz*B.x + fyz*B.y + fzz*B.z;

  const Sxx = invGrad * (T.x*HTx + T.y*HTy + T.z*HTz);
  const Sxy = invGrad * (T.x*HBx + T.y*HBy + T.z*HBz);
  const Syy = invGrad * (B.x*HBx + B.y*HBy + B.z*HBz);

  return { Sxx, Sxy, Syy };
}

/**
 * Tier 2 curvature: principal curvatures k1,k2 and their tangent-plane
 * directions dir1,dir2, built ON TOP of computeShapeOperator2x2 via a
 * closed-form 2×2 symmetric eigensolve (quadratic formula — no numerical
 * eigensolver, no matrix library). Public return shape unchanged from any
 * prior version: {k1, k2, dir1, dir2, meanCurvature, gaussianCurvature}.
 *
 * k1 ≥ k2 by convention. meanCurvature=(k1+k2)/2 and
 * gaussianCurvature=k1·k2 fall out of the same algebra and are included
 * as free byproducts.
 *
 * This is the ONE place in the codebase that should call this function —
 * it is Tier 2 specifically because a human reading an overlay wants an
 * oriented direction to look at; every other consumer (embedNode's sag
 * correction) only ever needs Tier 1's Sxx/Sxy/Syy directly.
 *
 * @returns {{k1,k2,dir1,dir2,meanCurvature,gaussianCurvature}|null}
 *   null if the gradient is degenerate at this point (see computeNormal3D).
 */
export function computePrincipalCurvatures3D(sdfFn, point, eps = 0.001) {
  const frame = computeLocalFrame(sdfFn, point, eps);
  if (!frame) return null;

  const { Sxx, Sxy, Syy } = computeShapeOperator2x2(sdfFn, point, frame, eps);

  const meanCurvature = (Sxx + Syy) / 2;
  const half = (Sxx - Syy) / 2;
  const disc = Math.sqrt(half*half + Sxy*Sxy);
  const k1 = meanCurvature + disc;
  const k2 = meanCurvature - disc;
  const gaussianCurvature = Sxx*Syy - Sxy*Sxy; // = k1*k2, standard identity

  // UMBILIC FALLBACK: at a point where k1≈k2 (isotropic curvature — every
  // sphere point, or any point with zero curvature), the principal
  // DIRECTIONS are mathematically undefined (any tangent direction is
  // equally valid). Rather than producing NaN/arbitrary noise, dir1/dir2
  // fall back to the plain T/B tangent frame — a safe, deterministic
  // choice that introduces no visible artifact, since k1≈k2 there means
  // curvature is the same regardless of which direction is chosen.
  const UMBILIC_EPS = 1e-8;
  let dir1, dir2;
  if (disc < UMBILIC_EPS) {
    dir1 = { ...frame.tangent };
    dir2 = { ...frame.bitangent };
  } else {
    // Eigenvector for k1 in the local 2D (T,B) basis, standard closed
    // form: (Sxy, k1−Sxx) or equivalently (k1−Syy, Sxy) — using the
    // latter, guarded against Sxy≈0 (already-diagonal case).
    let ex, ey;
    if (Math.abs(Sxy) > 1e-12) {
      ex = k1 - Syy;
      ey = Sxy;
    } else {
      ex = (Sxx >= Syy) ? 1 : 0;
      ey = (Sxx >= Syy) ? 0 : 1;
    }
    const elen = Math.sqrt(ex*ex + ey*ey) || 1;
    ex /= elen; ey /= elen;

    dir1 = {
      x: ex*frame.tangent.x + ey*frame.bitangent.x,
      y: ex*frame.tangent.y + ey*frame.bitangent.y,
      z: ex*frame.tangent.z + ey*frame.bitangent.z,
    };
    // dir2 ⊥ dir1 within the tangent plane — 90° rotation in the (T,B) basis.
    dir2 = {
      x: -ey*frame.tangent.x + ex*frame.bitangent.x,
      y: -ey*frame.tangent.y + ex*frame.bitangent.y,
      z: -ey*frame.tangent.z + ex*frame.bitangent.z,
    };
  }

  return { k1, k2, dir1, dir2, meanCurvature, gaussianCurvature };
}

/**
 * Mean curvature div(∇d/|∇d|) at a point — generalizes SDFBlending.js's
 * 2D computeCurvature to 3D. Each of the 6 axis-neighbor points is
 * evaluated EXACTLY ONCE and reused for both the first derivative
 * (fx/fy/fz) and second derivative (fxx/fyy/fzz) — a previous version of
 * this function re-evaluated the same 6 points a second time for the
 * second derivatives, silently doubling the axis-evaluation cost for no
 * reason. Total cost is 1 (center) + 6 (axis) + 12 (corners, no reuse
 * possible — they sample genuinely different diagonal points) = 19 SDF
 * evaluations — the honest floor for a full 3D curvature estimate via
 * finite differences, not an accident of redundant calls.
 *
 * Cheap enough for periodic/on-demand sampling (a few dozen calls when
 * building an interest map), NOT intended for per-pixel/per-frame use.
 */
export function computeMeanCurvature3D(sdfFn, point, eps = 0.001) {
  const p = point;
  const f = sdfFn(p);

  const fxPlus  = sdfFn({x:p.x+eps, y:p.y,     z:p.z});
  const fxMinus = sdfFn({x:p.x-eps, y:p.y,     z:p.z});
  const fyPlus  = sdfFn({x:p.x,     y:p.y+eps, z:p.z});
  const fyMinus = sdfFn({x:p.x,     y:p.y-eps, z:p.z});
  const fzPlus  = sdfFn({x:p.x,     y:p.y,     z:p.z+eps});
  const fzMinus = sdfFn({x:p.x,     y:p.y,     z:p.z-eps});

  const fx = (fxPlus - fxMinus) / (2*eps);
  const fy = (fyPlus - fyMinus) / (2*eps);
  const fz = (fzPlus - fzMinus) / (2*eps);

  const fxx = (fxPlus - 2*f + fxMinus) / (eps*eps);
  const fyy = (fyPlus - 2*f + fyMinus) / (eps*eps);
  const fzz = (fzPlus - 2*f + fzMinus) / (eps*eps);

  const fxy = (sdfFn({x:p.x+eps,y:p.y+eps,z:p.z}) - sdfFn({x:p.x+eps,y:p.y-eps,z:p.z})
             - sdfFn({x:p.x-eps,y:p.y+eps,z:p.z}) + sdfFn({x:p.x-eps,y:p.y-eps,z:p.z})) / (4*eps*eps);
  const fyz = (sdfFn({x:p.x,y:p.y+eps,z:p.z+eps}) - sdfFn({x:p.x,y:p.y+eps,z:p.z-eps})
             - sdfFn({x:p.x,y:p.y-eps,z:p.z+eps}) + sdfFn({x:p.x,y:p.y-eps,z:p.z-eps})) / (4*eps*eps);
  const fxz = (sdfFn({x:p.x+eps,y:p.y,z:p.z+eps}) - sdfFn({x:p.x-eps,y:p.y,z:p.z+eps})
             - sdfFn({x:p.x+eps,y:p.y,z:p.z-eps}) + sdfFn({x:p.x-eps,y:p.y,z:p.z-eps})) / (4*eps*eps);

  const gradSq = fx*fx + fy*fy + fz*fz;
  if (gradSq < 1e-10) return 0;
  const gradMag = Math.sqrt(gradSq);

  const numer = fxx*(fy*fy+fz*fz) + fyy*(fx*fx+fz*fz) + fzz*(fx*fx+fy*fy)
              - 2*fxy*fx*fy - 2*fyz*fy*fz - 2*fxz*fx*fz;
  return numer / (2 * gradSq * gradMag);
}

/**
 * Newton-iteration snap to the nearest surface point. Explicitly guards
 * against the degenerate-gradient case (e.g. a point sitting inside a
 * smooth-union blend region, where |∇d| can genuinely approach zero) by
 * checking the SQUARED gradient magnitude BEFORE normalizing/dividing —
 * a previous version called computeNormal3D unconditionally, which would
 * silently produce an unstable or meaningless direction rather than
 * stopping. Breaks out of the iteration early (returning the best point
 * found so far) rather than proceeding on bad data.
 */
export function snapToNearestSurface(sdfFn, point, iterations = 4, eps = 0.001, gradEps = 1e-8) {
  let p = point ? { ...point } : { x: 0, y: 0, z: 0 };
  for (let i = 0; i < iterations; i++) {
    const d = sdfFn(p);
    if (!isFinite(d)) break;
    const g = computeGradient3D(sdfFn, p, eps);
    const gradSq = g.x*g.x + g.y*g.y + g.z*g.z;
    if (gradSq < gradEps) break; // unstable/degenerate gradient — stop here rather than divide by ~0
    const len = Math.sqrt(gradSq);
    const n = { x: g.x/len, y: g.y/len, z: g.z/len };
    p = { x: p.x - n.x*d, y: p.y - n.y*d, z: p.z - n.z*d };
  }
  return p;
}

/**
 * Sphere-trace along a ray until a surface is hit, or null if none found
 * within maxDist.
 *
 * PRECONDITION: origin should lie OUTSIDE the surface (d(origin) > 0) —
 * this is the standard sphere-tracing assumption, since the algorithm's
 * safety guarantee (stepping by d never skips the surface) only holds
 * when approaching from outside. Two specific correctness fixes vs. an
 * earlier version:
 *
 *   1. Hit test is `Math.abs(d) < eps`, not `d < eps`. The latter would
 *      treat ANY point already deep inside a shape (e.g. d = -0.5) as an
 *      immediate "hit" at the ray origin — clearly wrong, since that
 *      point is nowhere near the actual zero-crossing.
 *
 *   2. If a negative d is ever encountered (meaning the precondition was
 *      violated — we're inside when we shouldn't be), this does NOT
 *      advance t by a negative amount (which would step BACKWARD along
 *      the ray and risk oscillation with no forward-progress guarantee).
 *      Instead it treats the current point as a (possibly imprecise) hit
 *      and returns immediately — defined, non-oscillating behavior
 *      rather than an unbounded loop.
 */
export function raymarchToSurface(sdfFn, origin, direction, maxDist = 100, eps = 0.001) {
  let t = 0.01;
  const MAX_STEPS = 256;
  for (let i = 0; i < MAX_STEPS; i++) {
    const p = { x: origin.x + direction.x*t, y: origin.y + direction.y*t, z: origin.z + direction.z*t };
    let d;
    try { d = sdfFn(p); } catch (e) { return null; }
    if (!isFinite(d)) return null;
    if (Math.abs(d) < eps) return p;
    if (d < 0) return p; // precondition violated — see doc comment above
    t += d;
    if (t > maxDist) return null;
  }
  return null;
}

/**
 * Evenly-distributed points on a unit sphere via the golden-angle
 * (Fibonacci sphere) method — no clustering at the poles, unlike a plain
 * lat/long grid. count=1 is special-cased (the general formula divides
 * by count-1, which is undefined at count=1).
 */
export function fibonacciSphereSamples(count) {
  if (count <= 1) return [{ x: 0, y: 1, z: 0 }];
  const points = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y*y));
    const theta = goldenAngle * i;
    points.push({ x: Math.cos(theta) * radiusAtY, y, z: Math.sin(theta) * radiusAtY });
  }
  return points;
}

/**
 * Scale-appropriate epsilon for finite-difference sampling, derived from
 * a characteristic scene size (e.g. the bounding-sphere radius) rather
 * than an absolute constant. A fixed eps=0.001 behaves very differently
 * for a radius-1 model than a radius-10000 one — this is a lightweight,
 * opt-in helper for callers that know their scene's scale (currently:
 * the orbit-camera curvature sampling in SceneManager.js), NOT a forced
 * change to every existing call site. embedNode's existing hardcoded
 * EPS=0.001 (NodeEvaluator.js, GLSLEvaluator.js) is UNCHANGED by this —
 * that's working, tested code outside this pass's scope; migrating it to
 * scale-relative epsilon is a reasonable, explicitly flagged follow-up,
 * not done here.
 */
export function epsilonForScale(sceneRadius, relativeScale = 1e-4) {
  return Math.max(sceneRadius * relativeScale, 1e-5);
}