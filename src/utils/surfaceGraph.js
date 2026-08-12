// src/utils/surfaceGraph.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Bake-time (CPU-only, never per-frame, never GLSL) construction of a local
// discrete graph of points sampled ALONG an implicit surface, used to
// approximate two things a pure SDF has no closed form for:
//
//   1. Geodesic distance — shortest-path distance restricted to the
//      surface itself, via Dijkstra over the graph's edges (edge weight =
//      straight-line distance between two ADJACENT graph nodes, which for
//      sufficiently dense sampling converges to the true geodesic segment
//      length — the same principle discrete/mesh-based geodesic algorithms
//      rely on, just built here from SDF ray-marches instead of mesh edges).
//
//   2. Curvature-similarity flood — BFS outward from a seed point, admitting
//      a graph node only while its curvature stays close to the seed's.
//
// ── Why a graph, not a dense grid ────────────────────────────────────────────
// Growing outward from the actual seed/stroke — rather than pre-sampling a
// dense fixed grid over the whole object — means cost scales with the size
// of the SELECTED region, not the size of the whole shape. This is what
// keeps a paint stroke on a small torus rivet cheap even if the host scene
// also contains a large tiled wall elsewhere.
//
// ── Cost model ────────────────────────────────────────────────────────────────
// Bounded by maxNodes AND a soft timeBudgetMs (checked periodically, same
// granularity as frameField.js's buildAdaptiveFrameField — see that
// module's header for the identical pattern). Each new candidate node costs
// one snapToNearestSurface (a handful of SDF evals) + one computeLocalFrame
// (a gradient stencil) + one computeShapeOperator2x2 (curvature, needed by
// curvatureFlood; computed unconditionally since it is cheap relative to
// the snap/frame cost already paid). Typical bake: a few hundred SDF
// evaluations total — negligible next to a single ray-march frame's own
// per-pixel cost, and this only runs on stroke-release / flood-click, not
// per frame.
// ─────────────────────────────────────────────────────────────────────────────

import { computeLocalFrame, snapToNearestSurface, computeShapeOperator2x2 } from './differentialGeometry.js';
import { wendlandC2 } from './frameField.js';

const DEFAULT_RING_DIRECTIONS = 8; // candidate neighbours sampled per frontier node, evenly spaced in the tangent plane

/**
 * Grow a local surface-point graph outward from one or more seed points.
 *
 * @param {Function} sdfFn
 * @param {Array<{x,y,z}>} seedPoints  Raw (not yet snapped) seed points —
 *   typically the stroke's raw ray-hit samples, or a single flood-click hit.
 * @param {object} [options]
 * @param {number} [options.stepSize=0.15]     Distance between adjacent graph nodes, in world units. Smaller = more accurate geodesic, more nodes for the same radius.
 * @param {number} [options.radius=1.5]        Stop growing past this Euclidean distance from the first seed — a coarse prefilter, not the true (geodesic) extent.
 * @param {number} [options.maxNodes=200]      Hard cap — mirrors frameField.js's maxFrames-style caps.
 * @param {number} [options.timeBudgetMs=12]   Soft time budget, checked every frontier node.
 * @param {number} [options.eps=0.001]
 * @param {number} [options.ringDirections=8]
 * @returns {{ nodes: Array<{x,y,z,nx,ny,nz,curvature}>, adjacency: Array<Array<[number,number]>>, seedIndices: number[] }}
 *   adjacency[i] is a list of [neighbourIndex, edgeWeight] pairs.
 */
export function buildSurfaceGraph(sdfFn, seedPoints, options = {}) {
  const {
    stepSize = 0.15,
    radius = 1.5,
    maxNodes = 200,
    timeBudgetMs = 12,
    eps = 0.001,
    ringDirections = DEFAULT_RING_DIRECTIONS,
  } = options;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const startTime = now();
  const withinBudget = () => (now() - startTime) < timeBudgetMs;

  const nodes = [];
  const adjacency = [];
  const seedIndices = [];

  const MIN_SEPARATION = stepSize * 0.6;
  const tooClose = (p) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const dx = n.x - p.x, dy = n.y - p.y, dz = n.z - p.z;
      if (dx*dx + dy*dy + dz*dz < MIN_SEPARATION * MIN_SEPARATION) return i;
    }
    return -1;
  };

  const addNode = (p, frame, shapeOp) => {
    const idx = nodes.length;
    nodes.push({
      x: p.x, y: p.y, z: p.z,
      nx: frame.normal.x,    ny: frame.normal.y,    nz: frame.normal.z,
      tx: frame.tangent.x,   ty: frame.tangent.y,   tz: frame.tangent.z,
      bx: frame.bitangent.x, by: frame.bitangent.y, bz: frame.bitangent.z,
      curvature: (shapeOp.Sxx + shapeOp.Syy) / 2,
      Sxx: shapeOp.Sxx, Sxy: shapeOp.Sxy, Syy: shapeOp.Syy,
    });
    adjacency.push([]);
    return idx;
  };

  const addEdge = (i, j, w) => {
    adjacency[i].push([j, w]);
    adjacency[j].push([i, w]);
  };

  // ── Path-distance-from-nearest-seed tracking ─────────────────────────
  // Replaces a straight-line distance-from-first-click gate that only
  // let ring-growth expand within `radius` of where the drag STARTED —
  // fine for a short dab, but a long stroke would go bare/thin past
  // `radius` from its start even though every point along it is only
  // stepSize away from its own local frontier. This is a coarse,
  // BFS-accumulated approximation used ONLY to decide how far growth
  // should still expand from a frontier node — NOT the final geodesic
  // distance used for baking (that's dijkstraGeodesic's job, over the
  // complete graph's real edge weights, after this function returns).
  const distFromSeed = new Map();

  for (const raw of seedPoints) {
    if (nodes.length >= maxNodes || !withinBudget()) break;
    const p = snapToNearestSurface(sdfFn, raw, 4, eps);
    const dup = tooClose(p);
    if (dup !== -1) { seedIndices.push(dup); continue; }
    const frame = computeLocalFrame(sdfFn, p, eps);
    if (!frame) continue; // degenerate gradient — skip this seed
    const shapeOp = computeShapeOperator2x2(sdfFn, p, frame, eps);
    const idx = addNode(p, frame, shapeOp);
    seedIndices.push(idx);
  }
  if (seedIndices.length === 0) {
    return { nodes: [], adjacency: [], seedIndices: [] };
  }
  seedIndices.forEach(i => distFromSeed.set(i, 0));

  // Chain consecutive RAW seed points together directly — for a paint
  // stroke these are already geodesically adjacent by construction (the
  // cursor traced a continuous path across the surface), so this gives an
  // exact geodesic backbone along the stroke itself at zero extra cost.
  for (let i = 1; i < seedIndices.length; i++) {
    const a = seedIndices[i - 1], b = seedIndices[i];
    if (a === b) continue;
    const na = nodes[a], nb = nodes[b];
    const w = Math.hypot(na.x-nb.x, na.y-nb.y, na.z-nb.z);
    addEdge(a, b, w);
    const viaA = (distFromSeed.get(a) ?? 0) + w;
    if (viaA < (distFromSeed.get(b) ?? Infinity)) distFromSeed.set(b, viaA);
  }

  // ── BFS growth ────────────────────────────────────────────────────────
  let frontier = [...new Set(seedIndices)];
  let iterationGuard = 0;
  while (frontier.length > 0 && nodes.length < maxNodes && withinBudget() && iterationGuard < 5000) {
    iterationGuard++;
    const nextFrontier = [];

    for (const fi of frontier) {
      if (nodes.length >= maxNodes || !withinBudget()) break;
      const fNode = nodes[fi];
      // Gate on accumulated PATH distance from the nearest seed, not
      // straight-line distance from the first click — see distFromSeed
      // comment above.
      const dToSeed = distFromSeed.get(fi) ?? 0;
      if (dToSeed > radius) continue; // past the coarse growth radius — stop expanding from here

      const frame = computeLocalFrame(sdfFn, fNode, eps);
      if (!frame) continue;

      for (let k = 0; k < ringDirections; k++) {
        if (nodes.length >= maxNodes || !withinBudget()) break;
        const theta = (k / ringDirections) * Math.PI * 2;
        const guess = {
          x: fNode.x + stepSize * (Math.cos(theta)*frame.tangent.x + Math.sin(theta)*frame.bitangent.x),
          y: fNode.y + stepSize * (Math.cos(theta)*frame.tangent.y + Math.sin(theta)*frame.bitangent.y),
          z: fNode.z + stepSize * (Math.cos(theta)*frame.tangent.z + Math.sin(theta)*frame.bitangent.z),
        };
        const snapped = snapToNearestSurface(sdfFn, guess, 3, eps);

        const dup = tooClose(snapped);
        if (dup !== -1) {
          const w = Math.hypot(fNode.x-nodes[dup].x, fNode.y-nodes[dup].y, fNode.z-nodes[dup].z);
          if (!adjacency[fi].some(([j]) => j === dup)) addEdge(fi, dup, w);
          const altDist = dToSeed + w;
          if (altDist < (distFromSeed.get(dup) ?? Infinity)) distFromSeed.set(dup, altDist);
          continue;
        }

        const newFrame = computeLocalFrame(sdfFn, snapped, eps);
        if (!newFrame) continue;
        const shapeOp = computeShapeOperator2x2(sdfFn, snapped, newFrame, eps);
        const idx = addNode(snapped, newFrame, shapeOp);
        const w = Math.hypot(fNode.x-snapped.x, fNode.y-snapped.y, fNode.z-snapped.z);
        addEdge(fi, idx, w);
        distFromSeed.set(idx, dToSeed + w);
        nextFrontier.push(idx);
      }
    }

    frontier = nextFrontier;
  }

  return { nodes, adjacency, seedIndices: [...new Set(seedIndices)] };
}

/**
 * Multi-source Dijkstra shortest-path distance over a surface graph.
 * @param {{nodes:Array, adjacency:Array}} graph  from buildSurfaceGraph
 * @param {number[]} sourceIndices
 * @returns {Float64Array}  geodesic distance per node index (Infinity if unreached)
 */
export function dijkstraGeodesic(graph, sourceIndices) {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const visited = new Uint8Array(n);

  // Binary heap would be the textbook choice; at n <= maxNodes (a few
  // hundred) a plain O(n^2) scan is simpler and fast enough for a
  // bake-time, non-per-frame operation.
  sourceIndices.forEach(i => { if (i >= 0 && i < n) dist[i] = 0; });

  for (let iter = 0; iter < n; iter++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
    }
    if (u === -1) break; // remaining nodes are unreachable
    visited[u] = 1;

    for (const [v, w] of graph.adjacency[u]) {
      const alt = dist[u] + w;
      if (alt < dist[v]) dist[v] = alt;
    }
  }

  return dist;
}

/**
 * Curvature-similarity flood fill from a single seed node, BFS-connected
 * only through nodes whose mean curvature stays within `threshold` of the
 * seed's own curvature. Returns the set of admitted node indices plus each
 * admitted node's curvature deviation (used to feather the flood boundary).
 *
 * @param {{nodes:Array, adjacency:Array}} graph
 * @param {number} seedIndex
 * @param {number} threshold
 * @returns {{ admitted: Set<number>, deviation: Map<number, number> }}
 */
export function curvatureFlood(graph, seedIndex, threshold) {
  const admitted = new Set();
  const deviation = new Map();
  if (seedIndex < 0 || seedIndex >= graph.nodes.length) return { admitted, deviation };

  const seedCurv = graph.nodes[seedIndex].curvature;
  const queue = [seedIndex];
  admitted.add(seedIndex);
  deviation.set(seedIndex, 0);

  let head = 0;
  const MAX_VISITS = graph.nodes.length * 4; // guards against pathological adjacency
  let visits = 0;
  while (head < queue.length && visits < MAX_VISITS) {
    const u = queue[head++];
    for (const [v] of graph.adjacency[u]) {
      visits++;
      if (admitted.has(v)) continue;
      const dev = Math.abs(graph.nodes[v].curvature - seedCurv);
      if (dev >= threshold) continue;
      admitted.add(v);
      deviation.set(v, dev);
      queue.push(v);
    }
  }

  return { admitted, deviation };
}

/**
 * Convert a Dijkstra geodesic-distance result into baked mask samples
 * ({x,y,z,nx,ny,nz,w}), consumable identically to a plain Euclidean brush
 * stroke by evaluateMaskAt() / GLSLEvaluator._maskFieldGLSL(). Samples
 * whose geodesic distance exceeds falloffRadius are dropped entirely (their
 * Wendland weight would be exactly 0 anyway — dropping them keeps the
 * baked array small).
 */
export function bakeGeodesicSamples(graph, geodesicDist, falloffRadius) {
  const out = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = geodesicDist[i];
    if (!isFinite(d) || d >= falloffRadius) continue;
    const n = graph.nodes[i];
    const w = wendlandC2(d / falloffRadius);
    if (w <= 1e-4) continue;
    out.push({
      x: n.x, y: n.y, z: n.z,
      nx: n.nx, ny: n.ny, nz: n.nz,
      // Carried through so this baked region can also build its OWN
      // local coordinate frame for embedNode's guest projection — see
      // surfaceMask.js's deriveEmbedFramesFromMask — instead of only
      // gating an anchor-centered one.
      tx: n.tx, ty: n.ty, tz: n.tz,
      bx: n.bx, by: n.by, bz: n.bz,
      Sxx: n.Sxx, Sxy: n.Sxy, Syy: n.Syy,
      w,
    });
  }
  return out;
}

/**
 * Convert a curvature-flood result into baked mask samples. Weight
 * feathers from 1.0 at the seed's exact curvature down toward 0 as
 * deviation approaches `threshold`, so the flood boundary is soft rather
 * than a hard cutoff.
 */
export function bakeCurvatureFloodSamples(graph, floodResult, threshold) {
  const out = [];
  floodResult.admitted.forEach(i => {
    const n = graph.nodes[i];
    const dev = floodResult.deviation.get(i) ?? 0;
    const w = Math.max(0, 1 - dev / Math.max(threshold, 1e-6));
    if (w <= 1e-4) return;
    out.push({
      x: n.x, y: n.y, z: n.z,
      nx: n.nx, ny: n.ny, nz: n.nz,
      tx: n.tx, ty: n.ty, tz: n.tz,
      bx: n.bx, by: n.by, bz: n.bz,
      Sxx: n.Sxx, Sxy: n.Sxy, Syy: n.Syy,
      w,
    });
  });
  return out;
}