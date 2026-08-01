// File: src/Primitives/regionPrimitives.js
//
// ── Architecture note ────────────────────────────────────────────────────────
// ...
// Current members:
//   CirclePrimitive          — exact SDF: sqrt(x²+y²) - r
//   RegularPolygonPrimitive  — exact SDF via angular folding, any N sides
//
// Coming in Phase 4:
//   PolytopePrimitive        — exact SDF via half-plane intersection
//   EllipsePrimitive         — exact SDF (iterative approximation)
// ─────────────────────────────────────────────────────────────────────────────

import { nextId }          from '../utils/idGenerator.js';
import { identityMapping } from '../utils/DistanceMapping.js';
import { logger }          from '../utils/logger.js';
import * as THREE          from 'three';


// ─────────────────────────────────────────────────────────────────────────────
// RegionPrimitive — base class for all region primitives
// ─────────────────────────────────────────────────────────────────────────────

export class RegionPrimitive {
  constructor(params = {}) {
    this.id             = params.id !== undefined ? params.id : nextId();
    this.color          = params.color || { h: 200, s: 0.7, l: 0.6, a: 1 };
    this.distanceMapper = params.distanceMapper || identityMapping;
    this.active         = true;
    this.rendered       = false;
    this.createdAt      = Date.now();

    // Region primitives have genuine inside/outside semantics.
    // SchurComposition reads this to decide whether to apply isoOffset.
    this.family = 'region';
  }

  // Subclasses must implement this
  computeSDF(point, callStack = [], time = 0, depth = 0) {
    throw new Error(`${this.constructor.name}.computeSDF() not implemented`);
  }

  // Subclasses must implement this
  createObject(time = 0) {
    return new THREE.Group();
  }

  // Subclasses must implement this
  updateParameters(params = {}) {
    return this;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// CirclePrimitive — exact analytic circle SDF
//
// SDF(x, y) = sqrt((x - cx)² + (y - cy)²) - r
//
// Negative inside the circle, zero on the boundary, positive outside.
// No inner shapes, no segments, no approximation.
// The boundary IS the zero crossing — no isoOffset needed.
//
// Extends into 3D in Phase 5:
//   Sphere:    sqrt(x² + y² + z²) - r
//   Cylinder:  sqrt(x² + y²) - r  (ignoring z)
//   Torus:     sqrt((sqrt(x²+z²) - R)² + y²) - r
// ─────────────────────────────────────────────────────────────────────────────

export class CirclePrimitive extends RegionPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.radius   — circle radius (default 1)
   * @param {number} params.posX     — center X (default 0)
   * @param {number} params.posY     — center Y (default 0)
   * @param {Object} params.color    — { h, s, l, a }
   * @param {Function} params.distanceMapper — optional mapper applied after SDF
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'circle';
    this.radius = params.radius !== undefined ? params.radius : 1;
    this._params = { ...params };

    logger.info(`Created CirclePrimitive with id: ${this.id}, radius: ${this.radius}`);
  }

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    const dx = point.x, dy = point.y;
    const d  = Math.sqrt(dx * dx + dy * dy) - this.radius;
    if (this.distanceMapper && typeof this.distanceMapper === 'function') {
      return this.distanceMapper(d);
    }
    return d;
  }

  createObject(time = 0) {
    const segments = 64;
    const points   = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(
        this.radius * Math.cos(angle),
        this.radius * Math.sin(angle),
        0
      ));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(
        (this.color.h || 200) / 360,
        this.color.s || 0.7,
        this.color.l || 0.6
      )
    });
    return new THREE.Line(geometry, material);
  }

  updateParameters(params = {}) {
    if (params.radius !== undefined) this.radius = params.radius;
    if (params.color  !== undefined) this.color  = params.color;
    if (params.distanceMapper !== undefined) this.distanceMapper = params.distanceMapper;
    logger.info(`Updated CirclePrimitive ${this.id}`);
    return this;
  }

  getLocalSnapPoints() {
    const r = this.radius;
    return [
      { x:0, y:0, z:0 },
      { x:r, y:0, z:0 }, { x:-r, y:0, z:0 },
      { x:0, y:r, z:0 }, { x:0, y:-r, z:0 },
    ];
  }

  clone() {
    const copy  = new CirclePrimitive(this._params);
    copy.color  = { ...this.color };
    return copy;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// RegularPolygonPrimitive — exact analytic N-sided polygon SDF
//
// Uses angular folding to reduce the problem to a single sector:
//   1. Translate and rotate the query point into polygon-local space
//   2. Compute the point's angle and fold it into one fundamental sector
//      of width 2π/N
//   3. The signed distance is:
//        dist * cos(foldedAngle) - size * cos(π/N)
//      where dist = |p| and foldedAngle is the angle within the sector
//
// Negative inside the polygon, zero on the boundary, positive outside.
// Works for any N ≥ 3:
//   N=3  → equilateral triangle (replaces TrianglePrimitive eventually)
//   N=4  → square
//   N=5  → pentagon
//   N=6  → regular hexagon
//   N=8  → octagon
//   N=∞  → approaches Circle
//
// 'size' is the circumradius — distance from center to vertex.
// ─────────────────────────────────────────────────────────────────────────────

export class RegularPolygonPrimitive extends RegionPrimitive {
  constructor(params = {}) {
    super(params);
    this.type     = 'regularPolygon';
    this.sides    = params.sides !== undefined ? Math.max(3, Math.round(params.sides)) : 6;
    this.size     = params.size  !== undefined ? params.size  : 1;
    this._params  = { ...params };

    logger.info(`Created RegularPolygonPrimitive with id: ${this.id}, sides: ${this.sides}`);
  }

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    let px = point.x, py = point.y;

    // Fixed +π/2 orientation offset so the flat top faces up by default —
    // a visual convention, not user rotation (use transform.rotateZ for that).
    const cosR = Math.cos(Math.PI / 2);
    const sinR = Math.sin(Math.PI / 2);
    const rx   = px * cosR - py * sinR;
    const ry   = px * sinR + py * cosR;
    px = rx; py = ry;

    const sectorAngle = (Math.PI * 2) / this.sides;
    let angle = Math.atan2(py, px);
    angle = angle - sectorAngle * Math.round(angle / sectorAngle);

    const apothem = this.size * Math.cos(Math.PI / this.sides);
    const dist    = Math.sqrt(px * px + py * py);
    const d       = dist * Math.cos(angle) - apothem;

    if (this.distanceMapper && typeof this.distanceMapper === 'function') {
      return this.distanceMapper(d);
    }
    return d;
  }

  createObject(time = 0) {
    const points = [];
    const sector = (Math.PI * 2) / this.sides;
    for (let i = 0; i <= this.sides; i++) {
      // Derived directly from computeSDF's actual zero-crossing (not a
      // guessed offset): computeSDF rotates the query point by +π/2
      // before folding it into sectors, so the boundary in WORLD space is
      // the canonical polygon rotated by -π/2. The canonical polygon's
      // edge-midpoints sit at angle = k*sector (that's where the folded
      // angle is 0), so its VERTICES sit at the midpoint between
      // consecutive edges: (k+0.5)*sector. Subtracting π/2 maps that into
      // world space. Verified by hand for N=4: gives vertices at
      // -45°/45°/135°/225°, which puts an edge centered at 90° (flat top)
      // — matching computeSDF's own documented convention.
      const angle = (i + 0.5) * sector - Math.PI / 2;
      points.push(new THREE.Vector3(
        this.size * Math.cos(angle),
        this.size * Math.sin(angle),
        0
      ));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(
        (this.color.h || 120) / 360,
        this.color.s || 0.7,
        this.color.l || 0.6
      )
    });
    return new THREE.Line(geometry, material);
  }

  updateParameters(params = {}) {
    if (params.sides !== undefined) this.sides = Math.max(3, Math.round(params.sides));
    if (params.size  !== undefined) this.size  = params.size;
    if (params.color !== undefined) this.color = params.color;
    if (params.distanceMapper !== undefined) this.distanceMapper = params.distanceMapper;
    logger.info(`Updated RegularPolygonPrimitive ${this.id}`);
    return this;
  }

  /**
   * NOTE: uses the same +π/2 orientation offset as computeSDF (the
   * authoritative, actually-rendered orientation), NOT the offset-less
   * angle createObject()'s wireframe preview currently uses — those two
   * have been out of sync since the Phase 3 primitive rewrite (a
   * pre-existing, separate bug, flagged for a future fix, not addressed
   * here).
   */
  getLocalSnapPoints() {
    const pts = [{ x:0, y:0, z:0 }];
    const sector = (Math.PI * 2) / this.sides;
    for (let i = 0; i < this.sides; i++) {
      // Same corrected derivation as createObject() above.
      const angle = (i + 0.5) * sector - Math.PI / 2;
      pts.push({ x: this.size * Math.cos(angle), y: this.size * Math.sin(angle), z: 0 });
    }
    return pts;
  }

  clone() {
    const copy = new RegularPolygonPrimitive(this._params);
    copy.color = { ...this.color };
    return copy;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// PolytopePrimitive — exact analytic convex polygon SDF
// ─────────────────────────────────────────────────────────────────────────────

export class PolytopePrimitive extends RegionPrimitive {
  constructor(params = {}) {
    super(params);
    this.type     = 'polytope';
    this._params  = { ...params };
    this.vertices = this._parseVertices(params.vertices);
    logger.info(`Created PolytopePrimitive with id: ${this.id}, vertices: ${this.vertices.length}`);
  }

  _parseVertices(raw) {
    try {
      if (!raw) return [[-1,-1],[1,-1],[1,1],[-1,1]];
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed) && parsed.length >= 3) return parsed;
    } catch (e) { }
    return [[-1,-1],[1,-1],[1,1],[-1,1]];
  }

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    if (this.vertices.length < 3) return Infinity;

    const lx = point.x, ly = point.y;

    let maxDist = -Infinity;
    const N = this.vertices.length;

    for (let i = 0; i < N; i++) {
      const [ax, ay] = this.vertices[i];
      const [bx, by] = this.vertices[(i + 1) % N];
      const ex = bx - ax;
      const ey = by - ay;
      // Outward-pointing normal for CCW winding: rotate edge vector 90° clockwise
      const nx =  ey;
      const ny = -ex;
      const nLen = Math.sqrt(nx * nx + ny * ny);
      if (nLen < 1e-10) continue;
      const d = ((lx - ax) * nx + (ly - ay) * ny) / nLen;
      if (d > maxDist) maxDist = d;
    }

    if (this.distanceMapper && typeof this.distanceMapper === 'function') {
      return this.distanceMapper(maxDist);
    }
    return maxDist;
  }

  createObject(time = 0) {
    if (this.vertices.length < 2) return new THREE.Group();

    const points = this.vertices.map(([x, y]) => new THREE.Vector3(x, y, 0));
    points.push(points[0].clone());

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(
        (this.color.h || 280) / 360,
        this.color.s || 0.7,
        this.color.l || 0.6
      )
    });
    return new THREE.Line(geometry, material);
  }

  updateParameters(params = {}) {
    if (params.vertices !== undefined) this.vertices = this._parseVertices(params.vertices);
    if (params.color    !== undefined) this.color    = params.color;
    logger.info(`Updated PolytopePrimitive ${this.id}`);
    return this;
  }

  getLocalSnapPoints() {
    const pts = [{ x:0, y:0, z:0 }];
    this.vertices.forEach(([x, y]) => pts.push({ x, y, z: 0 }));
    return pts;
  }

  clone() {
    const copy = new PolytopePrimitive(this._params);
    copy.color = { ...this.color };
    return copy;
  }
}