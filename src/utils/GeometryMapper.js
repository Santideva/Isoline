// src/utils/GeometryMapper.js
//
// General mapper contract, unifying every kind of "reshape a query as it
// flows through the graph" operation under one interface — instead of each
// new capability (distance remapping, surface embedding, future curvature-
// aware mapping) inventing its own bespoke parameter list.
//
// context = {
//   point,      // {x,y,z} — the query point, in whatever space is current
//   distance,   // number  — the running SDF value at this point
//   normal,     // {x,y,z} | null — surface normal, if computed upstream
//   tangent,    // {T,B}   | null — local tangent frame, if computed upstream
//   curvature,  // number  | null — mean curvature, if computed upstream
//   host,       // sdfFn   | null — the "outer" SDF this mapper is embedded within
//   primitive,  // node/primitive reference, for mappers needing param access
//   uv,         // {u,v}   | null — reserved for future parameterization work
//   time, depth // carried through for mappers that are time-varying/recursive
// }
//
// GLSL NOTE: GLSL has no dynamic dispatch, so a mapper's shader code cannot
// literally call ctx = mapper.map(ctx) the way CPU code can. Each mapper
// subclass instead declares contract() — which fields it reads/writes — so
// the GLSL generator knows exactly which fields must be computed and passed
// for that mapper type. Simple mappers (DistanceMapper) only ever touch
// ctx.distance, so their GLSL form is just float fn(float d) — identical to
// what already exists. Richer mappers (EmbeddingMapper) need more of the
// context computed inline in the generated shader, since there is no
// runtime object to route through.

export class GeometryMapper {
  /** @param {object} ctx  @returns {object} ctx' */
  map(ctx) { return ctx; }

  static contract() {
    return { reads: ['distance'], writes: ['distance'] };
  }
}

/**
 * DistanceMapper — every mapper currently in DistanceMapping.js (identity,
 * polynomial, sinusoidal, exponential, logarithmic, power) fits here
 * unchanged. Reads and writes ONLY ctx.distance — a thin adapter around the
 * existing plain (d, t, depth) => d' functions. No primitive file and no
 * NodeEvaluator/GLSLEvaluator mapper case needs to change to use this
 * class — they already return/consume plain functions, and that contract
 * is preserved. This class exists so future code CAN treat a distance
 * mapper as one case of the general GeometryMapper family, without forcing
 * a rewrite of anything that already works.
 */
export class DistanceMapper extends GeometryMapper {
  constructor(fn) {
    super();
    this._fn = fn;
  }
  map(ctx) {
    return { ...ctx, distance: this._fn(ctx.distance, ctx.time ?? 0, ctx.depth ?? 0) };
  }
  static contract() {
    return { reads: ['distance'], writes: ['distance'] };
  }
}

export const asDistanceMapper = (fn) => new DistanceMapper(fn);

/**
 * EmbeddingMapper — the conceptual class embedNode implements. Reads a
 * host's surface point/normal and rewrites ctx.point into that surface's
 * local tangent frame before a guest SDF is evaluated against it.
 *
 * NOT literally instantiated at runtime: GLSLEvaluator._generateEmbedNode
 * and NodeEvaluator's 'embedNode' case both implement this exact contract
 * directly (gradient → project → tangent frame → rewrite point), because
 * GLSL cannot call a polymorphic .map() method — the shader code has to be
 * emitted as concrete, literal GLSL text. This class documents the
 * contract that implementation follows; it's the CPU-side reference shape
 * for what a future "many embedding-style mappers share one dispatcher"
 * architecture (Phase 8) would generalize.
 */
export class EmbeddingMapper extends GeometryMapper {
  map(ctx) {
    throw new Error(
      'EmbeddingMapper.map() is a documentation reference, not a runtime ' +
      'path — see embedNode\'s NodeEvaluator/GLSLEvaluator cases for the ' +
      'actual (necessarily inline, GLSL-compatible) implementation.'
    );
  }
  static contract() {
    return { reads: ['point', 'normal', 'host'], writes: ['point'] };
  }
}