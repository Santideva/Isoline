// File: src/Primitives/solidPrimitives.js
//
// ── Architecture note ────────────────────────────────────────────────────────
// Family 3 — Solid primitives (3D manifolds with exact analytic SDF)
//
// Solid primitives operate in 3D space. Their SDF receives {x, y, z} and
// returns a float where:
//   SDF < 0  →  inside the solid
//   SDF = 0  →  on the surface
//   SDF > 0  →  outside the solid
//
// All solid primitives carry family = 'solid' which tells SchurComposition,
// NodeEvaluator, and GLSLEvaluator that this node operates in 3D space and
// requires the ray march renderer (Phase 5c) for display.
//
// createObject() returns a THREE.Mesh with a proxy geometry for visual
// placement in the Three.js scene. This is not the final rendered output —
// the ray march renderer uses the SDF directly. The mesh just shows
// approximate position and size while the user edits parameters.
//
// ── Dimensional relationships ────────────────────────────────────────────────
//   CirclePrimitive(r)          →  SpherePrimitive(radius=r)    (2D→3D)
//   CirclePrimitive(r) + Extrude(h) → CylinderPrimitive        (extrude)
//   CirclePrimitive(r) + Revolve    → TorusPrimitive            (revolve)
//   LineSegment + thickness         → CapsulePrimitive          (offset)
//   RegularPolygon(N) + Extrude(h)  → Prism(N sides)            (extrude)
//
// ── Current members ──────────────────────────────────────────────────────────
//   SolidPrimitive   — abstract base class
//   SpherePrimitive  — exact SDF: length(p) - r
//   BoxPrimitive     — exact SDF: Quilez box formula
//   CylinderPrimitive — exact SDF: capped cylinder
//   CapsulePrimitive — exact SDF: segment + radius offset
//   TorusPrimitive   — exact SDF: revolve circle formula
// ─────────────────────────────────────────────────────────────────────────────

import { nextId }   from '../utils/idGenerator.js';
import { logger }   from '../utils/logger.js';
import * as THREE   from 'three';


// ─────────────────────────────────────────────────────────────────────────────
// SolidPrimitive — abstract base class for all solid primitives
// ─────────────────────────────────────────────────────────────────────────────

export class SolidPrimitive {
  constructor(params = {}) {
    this.id             = params.id !== undefined ? params.id : nextId();
    this.color          = params.color || { h: 200, s: 0.7, l: 0.6, a: 1 };
    this.active         = true;
    this.rendered       = false;
    this.createdAt      = Date.now();

    // Solid primitives operate in 3D space.
    // SchurComposition and NodeEvaluator read this flag.
    this.family = 'solid';
  }

  /**
   * Evaluate the SDF at a 3D point.
   * @param {{ x: number, y: number, z: number }} point
   * @returns {number} signed distance — negative inside, zero on surface, positive outside
   */
  computeSDF(point, callStack = [], time = 0, depth = 0) {
    throw new Error(`${this.constructor.name}.computeSDF() not implemented`);
  }

  /** Return a Three.js Mesh as a visual proxy for scene placement. */
  createObject(time = 0) {
    return new THREE.Group();
  }

  /** Update any subset of params and rebuild internal state. */
  updateParameters(params = {}) {
    return this;
  }

  /** Helper — build a standard wireframe material in this primitive's colour */
  _wireMaterial() {
    return new THREE.MeshStandardMaterial({
      color:     new THREE.Color().setHSL(
        (this.color.h || 200) / 360,
        this.color.s || 0.7,
        this.color.l || 0.6
      ),
      wireframe: true,
      opacity:   0.6,
      transparent: true,
    });
  }

  /** Helper — translate a geometry by the primitive's position */
  _positioned(mesh) {
    mesh.position.set(this.posX || 0, this.posY || 0, this.posZ || 0);
    return mesh;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SpherePrimitive — exact analytic sphere SDF
//
// SDF(p) = |p - center| - radius
//
// The simplest exact 3D SDF. Generalises CirclePrimitive to 3D —
// in the z=0 slice it produces the same field as CirclePrimitive.
//
// Phase 5+ extensions:
//   Ellipsoid: length(p / radii) - 1  (non-uniform scaling)
//   Hemisphere: sphere SDF with max(p.y, 0) clamping
// ─────────────────────────────────────────────────────────────────────────────

export class SpherePrimitive extends SolidPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.radius  sphere radius (default 1)
   * @param {number} params.posX    center X (default 0)
   * @param {number} params.posY    center Y (default 0)
   * @param {number} params.posZ    center Z (default 0)
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'sphere';
    this.radius = params.radius !== undefined ? params.radius : 1;
    this.posX   = params.posX   !== undefined ? params.posX   : 0;
    this.posY   = params.posY   !== undefined ? params.posY   : 0;
    this.posZ   = params.posZ   !== undefined ? params.posZ   : 0;
    this._params = { ...params };

    logger.info(`Created SpherePrimitive id:${this.id} radius:${this.radius}`);
  }

  computeSDF(point) {
    const dx = point.x - this.posX;
    const dy = point.y - this.posY;
    const dz = (point.z || 0) - this.posZ;
    return Math.sqrt(dx*dx + dy*dy + dz*dz) - this.radius;
  }

  createObject() {
    const geo  = new THREE.SphereGeometry(this.radius, 24, 16);
    const mesh = new THREE.Mesh(geo, this._wireMaterial());
    return this._positioned(mesh);
  }

  updateParameters(params = {}) {
    if (params.radius !== undefined) this.radius = params.radius;
    if (params.posX   !== undefined) this.posX   = params.posX;
    if (params.posY   !== undefined) this.posY   = params.posY;
    if (params.posZ   !== undefined) this.posZ   = params.posZ;
    if (params.color  !== undefined) this.color  = params.color;
    if (params.position !== undefined) {
      if (params.position.x !== undefined) this.posX = params.position.x;
      if (params.position.y !== undefined) this.posY = params.position.y;
      if (params.position.z !== undefined) this.posZ = params.position.z;
    }
    logger.info(`Updated SpherePrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new SpherePrimitive({ ...this._params });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// BoxPrimitive — exact analytic box SDF (Inigo Quilez formula)
//
// q  = |p - center| - halfExtents       (componentwise)
// SDF = length(max(q, 0)) + min(max(qx, max(qy, qz)), 0)
//
// The first term handles exterior corners (length of overshot vector).
// The second term handles the interior (most-positive face distance).
// Together they give an exact signed distance to a rectangular box.
//
// SquarePrism (box with equal width/depth) and Cube are special cases.
// ─────────────────────────────────────────────────────────────────────────────

export class BoxPrimitive extends SolidPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.width   full width  (X extent, default 2)
   * @param {number} params.height  full height (Y extent, default 2)
   * @param {number} params.depth   full depth  (Z extent, default 2)
   * @param {number} params.posX    center X (default 0)
   * @param {number} params.posY    center Y (default 0)
   * @param {number} params.posZ    center Z (default 0)
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'box';
    this.width  = params.width  !== undefined ? params.width  : 2;
    this.height = params.height !== undefined ? params.height : 2;
    this.depth  = params.depth  !== undefined ? params.depth  : 2;
    this.posX   = params.posX   !== undefined ? params.posX   : 0;
    this.posY   = params.posY   !== undefined ? params.posY   : 0;
    this.posZ   = params.posZ   !== undefined ? params.posZ   : 0;
    this._params = { ...params };

    logger.info(`Created BoxPrimitive id:${this.id} ${this.width}×${this.height}×${this.depth}`);
  }

  computeSDF(point) {
    // Half-extents
    const bx = this.width  / 2;
    const by = this.height / 2;
    const bz = this.depth  / 2;

    // Translate to box-local space
    const px = Math.abs(point.x - this.posX) - bx;
    const py = Math.abs(point.y - this.posY) - by;
    const pz = Math.abs((point.z || 0) - this.posZ) - bz;

    // Exterior: length of the overshot vector (zero inside)
    const ex = Math.max(px, 0);
    const ey = Math.max(py, 0);
    const ez = Math.max(pz, 0);
    const exterior = Math.sqrt(ex*ex + ey*ey + ez*ez);

    // Interior: most-positive face distance (negative when inside)
    const interior = Math.min(Math.max(px, Math.max(py, pz)), 0);

    return exterior + interior;
  }

  createObject() {
    const geo  = new THREE.BoxGeometry(this.width, this.height, this.depth);
    const mesh = new THREE.Mesh(geo, this._wireMaterial());
    return this._positioned(mesh);
  }

  updateParameters(params = {}) {
    if (params.width  !== undefined) this.width  = params.width;
    if (params.height !== undefined) this.height = params.height;
    if (params.depth  !== undefined) this.depth  = params.depth;
    if (params.posX   !== undefined) this.posX   = params.posX;
    if (params.posY   !== undefined) this.posY   = params.posY;
    if (params.posZ   !== undefined) this.posZ   = params.posZ;
    if (params.color  !== undefined) this.color  = params.color;
    if (params.position !== undefined) {
      if (params.position.x !== undefined) this.posX = params.position.x;
      if (params.position.y !== undefined) this.posY = params.position.y;
      if (params.position.z !== undefined) this.posZ = params.position.z;
    }
    logger.info(`Updated BoxPrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new BoxPrimitive({ ...this._params });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// CylinderPrimitive — exact analytic capped cylinder SDF
//
// For a cylinder along Y, radius r, half-height h:
//   d.x = sqrt(p.x² + p.z²) - r     (radial distance from axis, minus radius)
//   d.y = |p.y| - h                  (axial distance from caps, minus height)
//   SDF = min(max(dx, dy), 0) + length(max(d, 0))
//
// The same two-term pattern as BoxPrimitive — exterior corners + interior.
// Setting capped=false gives an infinite cylinder (ignore the dy term).
//
// Relationship to Circle:
//   CirclePrimitive(r) extruded along Y to height 2h = CylinderPrimitive(r,h)
// ─────────────────────────────────────────────────────────────────────────────

export class CylinderPrimitive extends SolidPrimitive {
  /**
   * @param {Object}  params
   * @param {number}  params.radius   cylinder radius (default 1)
   * @param {number}  params.height   full height (default 2)
   * @param {boolean} params.capped   true = finite cylinder with flat caps (default true)
   * @param {number}  params.posX     center X (default 0)
   * @param {number}  params.posY     center Y (default 0)
   * @param {number}  params.posZ     center Z (default 0)
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'cylinder';
    this.radius = params.radius !== undefined ? params.radius : 1;
    this.height = params.height !== undefined ? params.height : 2;
    this.capped = params.capped !== undefined ? params.capped : true;
    this.posX   = params.posX   !== undefined ? params.posX   : 0;
    this.posY   = params.posY   !== undefined ? params.posY   : 0;
    this.posZ   = params.posZ   !== undefined ? params.posZ   : 0;
    this._params = { ...params };

    logger.info(`Created CylinderPrimitive id:${this.id} r:${this.radius} h:${this.height}`);
  }

  computeSDF(point) {
    const px = point.x - this.posX;
    const py = point.y - this.posY;
    const pz = (point.z || 0) - this.posZ;

    // Radial distance from the Y axis, minus radius
    const radial = Math.sqrt(px*px + pz*pz) - this.radius;

    if (!this.capped) {
      // Infinite cylinder — only radial distance matters
      return radial;
    }

    // Axial distance from the flat caps, minus half-height
    const axial = Math.abs(py) - this.height / 2;

    const dx = Math.max(radial, 0);
    const dy = Math.max(axial,  0);
    return Math.min(Math.max(radial, axial), 0) +
           Math.sqrt(dx*dx + dy*dy);
  }

  createObject() {
    const geo  = new THREE.CylinderGeometry(
      this.radius, this.radius, this.height, 24
    );
    const mesh = new THREE.Mesh(geo, this._wireMaterial());
    return this._positioned(mesh);
  }

  updateParameters(params = {}) {
    if (params.radius !== undefined) this.radius = params.radius;
    if (params.height !== undefined) this.height = params.height;
    if (params.capped !== undefined) this.capped = params.capped;
    if (params.posX   !== undefined) this.posX   = params.posX;
    if (params.posY   !== undefined) this.posY   = params.posY;
    if (params.posZ   !== undefined) this.posZ   = params.posZ;
    if (params.color  !== undefined) this.color  = params.color;
    if (params.position !== undefined) {
      if (params.position.x !== undefined) this.posX = params.position.x;
      if (params.position.y !== undefined) this.posY = params.position.y;
      if (params.position.z !== undefined) this.posZ = params.position.z;
    }
    logger.info(`Updated CylinderPrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new CylinderPrimitive({ ...this._params });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// CapsulePrimitive — exact analytic capsule SDF
//
// A capsule is the Minkowski sum of a line segment and a sphere — equivalently,
// all points within radius r of the segment from A to B.
//
// pa = p - a
// ba = b - a
// t  = clamp(dot(pa, ba) / dot(ba, ba), 0, 1)   ← nearest point on segment
// SDF = length(pa - ba * t) - r
//
// Relationship to LineSegment:
//   CapsulePrimitive is LineSegment with thickness r, extended to 3D.
// ─────────────────────────────────────────────────────────────────────────────

export class CapsulePrimitive extends SolidPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.ax     start point X (default 0)
   * @param {number} params.ay     start point Y (default -1)
   * @param {number} params.az     start point Z (default 0)
   * @param {number} params.bx     end point X (default 0)
   * @param {number} params.by     end point Y (default 1)
   * @param {number} params.bz     end point Z (default 0)
   * @param {number} params.radius capsule radius (default 0.5)
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'capsule';
    this.ax     = params.ax     !== undefined ? params.ax     : 0;
    this.ay     = params.ay     !== undefined ? params.ay     : -1;
    this.az     = params.az     !== undefined ? params.az     : 0;
    this.bx     = params.bx     !== undefined ? params.bx     : 0;
    this.by     = params.by     !== undefined ? params.by     : 1;
    this.bz     = params.bz     !== undefined ? params.bz     : 0;
    this.radius = params.radius !== undefined ? params.radius : 0.5;
    this._params = { ...params };

    logger.info(`Created CapsulePrimitive id:${this.id} r:${this.radius}`);
  }

  computeSDF(point) {
    const px = point.x;
    const py = point.y;
    const pz = point.z || 0;

    // Vector from A to point
    const pax = px - this.ax;
    const pay = py - this.ay;
    const paz = pz - this.az;

    // Vector from A to B
    const bax = this.bx - this.ax;
    const bay = this.by - this.ay;
    const baz = this.bz - this.az;

    // Parameter of nearest point on segment [0,1]
    const dot_ba_ba = bax*bax + bay*bay + baz*baz;
    const t = dot_ba_ba < 1e-10 ? 0 :
      Math.max(0, Math.min(1, (pax*bax + pay*bay + paz*baz) / dot_ba_ba));

    // Distance from point to nearest point on segment, minus radius
    const qx = pax - bax * t;
    const qy = pay - bay * t;
    const qz = paz - baz * t;
    return Math.sqrt(qx*qx + qy*qy + qz*qz) - this.radius;
  }

  createObject() {
    // Approximate proxy: a cylinder between A and B with hemispherical ends
    const dx  = this.bx - this.ax;
    const dy  = this.by - this.ay;
    const dz  = this.bz - this.az;
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);

    const geo  = typeof THREE.CapsuleGeometry !== 'undefined'
      ? new THREE.CapsuleGeometry(this.radius, len, 8, 16)
      : new THREE.CylinderGeometry(this.radius, this.radius, len, 16);

    const mesh  = new THREE.Mesh(geo, this._wireMaterial());

    // Position at midpoint of A→B, orient along the segment
    mesh.position.set(
      (this.ax + this.bx) / 2,
      (this.ay + this.by) / 2,
      (this.az + this.bz) / 2
    );
    if (len > 1e-6) {
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx / len, dy / len, dz / len)
      );
    }
    return mesh;
  }

  updateParameters(params = {}) {
    if (params.ax     !== undefined) this.ax     = params.ax;
    if (params.ay     !== undefined) this.ay     = params.ay;
    if (params.az     !== undefined) this.az     = params.az;
    if (params.bx     !== undefined) this.bx     = params.bx;
    if (params.by     !== undefined) this.by     = params.by;
    if (params.bz     !== undefined) this.bz     = params.bz;
    if (params.radius !== undefined) this.radius = params.radius;
    if (params.color  !== undefined) this.color  = params.color;
    logger.info(`Updated CapsulePrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new CapsulePrimitive({ ...this._params });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// TorusPrimitive — exact analytic torus SDF
//
// Torus centred at origin, tube in XZ plane, symmetric around Y axis.
// R = major radius (center to tube center)
// r = minor radius (tube radius)
//
// q  = vec2(sqrt(p.x² + p.z²) - R,  p.y)
// SDF = length(q) - r
//
// Interpretation: first compute distance from the ring circle in the XZ plane
// (reducing 3D to 2D), then subtract the tube radius.
//
// Relationship to Circle:
//   Revolving CirclePrimitive(r, posX=R) around the Y axis gives TorusPrimitive(R, r).
// ─────────────────────────────────────────────────────────────────────────────

export class TorusPrimitive extends SolidPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.majorRadius  distance from torus center to tube center (default 2)
   * @param {number} params.minorRadius  tube radius (default 0.5)
   * @param {number} params.posX         center X (default 0)
   * @param {number} params.posY         center Y (default 0)
   * @param {number} params.posZ         center Z (default 0)
   */
  constructor(params = {}) {
    super(params);
    this.type        = 'torus';
    this.majorRadius = params.majorRadius !== undefined ? params.majorRadius : 2;
    this.minorRadius = params.minorRadius !== undefined ? params.minorRadius : 0.5;
    this.posX        = params.posX        !== undefined ? params.posX        : 0;
    this.posY        = params.posY        !== undefined ? params.posY        : 0;
    this.posZ        = params.posZ        !== undefined ? params.posZ        : 0;
    this._params     = { ...params };

    logger.info(`Created TorusPrimitive id:${this.id} R:${this.majorRadius} r:${this.minorRadius}`);
  }

  computeSDF(point) {
    const px = point.x - this.posX;
    const py = point.y - this.posY;
    const pz = (point.z || 0) - this.posZ;

    // Distance from the ring circle in the XZ plane
    const qx = Math.sqrt(px*px + pz*pz) - this.majorRadius;
    const qy = py;

    return Math.sqrt(qx*qx + qy*qy) - this.minorRadius;
  }

  createObject() {
    const geo  = new THREE.TorusGeometry(
      this.majorRadius, this.minorRadius, 16, 48
    );
    const mesh = new THREE.Mesh(geo, this._wireMaterial());
    return this._positioned(mesh);
  }

  updateParameters(params = {}) {
    if (params.majorRadius !== undefined) this.majorRadius = params.majorRadius;
    if (params.minorRadius !== undefined) this.minorRadius = params.minorRadius;
    if (params.posX        !== undefined) this.posX        = params.posX;
    if (params.posY        !== undefined) this.posY        = params.posY;
    if (params.posZ        !== undefined) this.posZ        = params.posZ;
    if (params.color       !== undefined) this.color       = params.color;
    if (params.position !== undefined) {
      if (params.position.x !== undefined) this.posX = params.position.x;
      if (params.position.y !== undefined) this.posY = params.position.y;
      if (params.position.z !== undefined) this.posZ = params.position.z;
    }
    logger.info(`Updated TorusPrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new TorusPrimitive({ ...this._params });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// ConePrimitive — exact analytic capped cone SDF
//
// Cone with apex at top (0, height, 0) and base circle of radius r
// centred at the origin in the XZ plane.
//
// The Quilez formula for a capped cone uses two points A (apex) and B (base
// center) and the base radius. The apex radius is 0.
//
// SDF derivation:
//   rba = rb - ra    (radius difference, ra=0 for standard cone)
//   baba = dot(ba,ba)
//   papa = dot(pa,pa)
//   paba = dot(pa,ba)/baba
//   x    = sqrt(papa - paba*paba*baba)   (radial distance from axis)
//   cax  = max(0, x - (ra + rba*paba))
//   cay  = abs(paba - 0.5) - 0.5
//   k    = rba*rba + baba
//   f    = clamp((rba*(x-ra) + paba*baba)/k, 0,1)
//   cbx  = x - ra - f*rba
//   cby  = paba - f
//   s    = cbx<0 && cay<0 ? -1 : 1
//   SDF  = s * sqrt(min(cax*cax + cay*cay*baba,
//                       cbx*cbx + cby*cby*baba))
// ─────────────────────────────────────────────────────────────────────────────

export class ConePrimitive extends SolidPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.radius  base radius (default 1)
   * @param {number} params.height  cone height (default 2)
   * @param {number} params.posX    base center X (default 0)
   * @param {number} params.posY    base center Y (default 0)
   * @param {number} params.posZ    base center Z (default 0)
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'cone';
    this.radius = params.radius !== undefined ? params.radius : 1;
    this.height = params.height !== undefined ? params.height : 2;
    this.posX   = params.posX   !== undefined ? params.posX   : 0;
    this.posY   = params.posY   !== undefined ? params.posY   : 0;
    this.posZ   = params.posZ   !== undefined ? params.posZ   : 0;
    this._params = { ...params };

    logger.info(`Created ConePrimitive id:${this.id} r:${this.radius} h:${this.height}`);
  }

  computeSDF(point) {
    // Translate to cone-local space — base at origin, apex at (0, height, 0)
    const px = point.x - this.posX;
    const py = point.y - this.posY;
    const pz = (point.z || 0) - this.posZ;

    // A = base center (0,0,0), B = apex (0, height, 0)
    // ra = base radius, rb = apex radius = 0
    const ra   = this.radius;
    const ba_y = this.height;   // ba = B - A = (0, height, 0)
    const baba = ba_y * ba_y;

    // pa = p - A = (px, py, pz)
    const papa = px*px + py*py + pz*pz;
    const paba = py / ba_y;   // dot(pa, ba) / baba  (ba is purely Y)

    // Radial distance from Y axis
    const x = Math.sqrt(Math.max(0, px*px + pz*pz));

    // Clamp parameter along axis
    const pabaClamped = Math.max(0, Math.min(1, paba));

    // Radial profile at this height: linearly interpolate from ra to 0
    const cax = Math.max(0, x - ra * (1 - pabaClamped));
    const cay = Math.abs(paba - 0.5) - 0.5;

    const rba = -ra;  // rb - ra = 0 - ra
    const k   = rba*rba + baba;
    const f   = Math.max(0, Math.min(1, (rba*(x - ra) + paba*baba) / k));

    const cbx = x - ra - f*rba;
    const cby = paba - f;

    const s = (cbx < 0 && cay < 0) ? -1 : 1;
    return s * Math.sqrt(Math.min(
      cax*cax + cay*cay*baba,
      cbx*cbx + cby*cby*baba
    ));
  }

  createObject() {
    const geo  = new THREE.ConeGeometry(this.radius, this.height, 24);
    const mesh = new THREE.Mesh(geo, this._wireMaterial());
    mesh.position.set(this.posX, this.posY + this.height / 2, this.posZ);
    return mesh;
    // Note: position set manually here, not via _positioned() to account
    // for the height/2 center offset of THREE.ConeGeometry
  }

  updateParameters(params = {}) {
    if (params.radius !== undefined) this.radius = params.radius;
    if (params.height !== undefined) this.height = params.height;
    if (params.posX   !== undefined) this.posX   = params.posX;
    if (params.posY   !== undefined) this.posY   = params.posY;
    if (params.posZ   !== undefined) this.posZ   = params.posZ;
    if (params.color  !== undefined) this.color  = params.color;
    logger.info(`Updated ConePrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new ConePrimitive({ ...this._params });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// InfinitePlanePrimitive — exact analytic infinite plane SDF
//
// The simplest possible 3D SDF:
//   SDF(p) = dot(p, normal) - offset
//
// normal must be a unit vector pointing away from the solid side.
// offset is the signed distance from the origin to the plane along the normal.
//
// Special cases:
//   normal=(0,1,0), offset=0  →  the XZ plane (floor)
//   normal=(0,0,1), offset=0  →  the XY plane (back wall)
//   normal=(1,0,0), offset=-3 →  a vertical wall at x = -3
// ─────────────────────────────────────────────────────────────────────────────

export class InfinitePlanePrimitive extends SolidPrimitive {
  /**
   * @param {Object} params
   * @param {number} params.nx      normal X component (default 0)
   * @param {number} params.ny      normal Y component (default 1)  ← points up
   * @param {number} params.nz      normal Z component (default 0)
   * @param {number} params.offset  signed distance offset (default 0)
   */
  constructor(params = {}) {
    super(params);
    this.type   = 'plane';
    this.nx     = params.nx     !== undefined ? params.nx     : 0;
    this.ny     = params.ny     !== undefined ? params.ny     : 1;
    this.nz     = params.nz     !== undefined ? params.nz     : 0;
    this.offset = params.offset !== undefined ? params.offset : 0;
    this._params = { ...params };

    // Normalise the normal vector
    const len = Math.sqrt(this.nx*this.nx + this.ny*this.ny + this.nz*this.nz);
    if (len > 1e-6) { this.nx /= len; this.ny /= len; this.nz /= len; }

    logger.info(`Created InfinitePlanePrimitive id:${this.id}`);
  }

  computeSDF(point) {
    return (point.x || 0) * this.nx
         + (point.y || 0) * this.ny
         + (point.z || 0) * this.nz
         - this.offset;
  }

  createObject() {
    const geo    = new THREE.PlaneGeometry(20, 20, 4, 4);
    const mesh   = new THREE.Mesh(geo, this._wireMaterial());
    const normal = new THREE.Vector3(this.nx, this.ny, this.nz).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone());
    mesh.position.copy(normal.multiplyScalar(this.offset));
    return mesh;
  }

  updateParameters(params = {}) {
    if (params.nx     !== undefined) this.nx     = params.nx;
    if (params.ny     !== undefined) this.ny     = params.ny;
    if (params.nz     !== undefined) this.nz     = params.nz;
    if (params.offset !== undefined) this.offset = params.offset;
    if (params.color  !== undefined) this.color  = params.color;
    // Re-normalise
    const len = Math.sqrt(this.nx*this.nx + this.ny*this.ny + this.nz*this.nz);
    if (len > 1e-6) { this.nx /= len; this.ny /= len; this.nz /= len; }
    logger.info(`Updated InfinitePlanePrimitive ${this.id}`);
    return this;
  }

  clone() {
    return new InfinitePlanePrimitive({ ...this._params });
  }
}