// File: src/primitives/primaryDerivativePrimitives.js
//
// ── Architecture note ────────────────────────────────────────────────────────
// This file contains two primitive families:
//
// Family 1 — Curve primitives (1D manifolds in 2D space)
//   SDF is always >= 0. isoOffset is required for visible contours.
//   Members: DerivativePrimitive (base), TrianglePrimitive, ArcPrimitive
//
//   ArcPrimitive is now EXACT ANALYTIC — no inner ComplexShape2D segments.
//   computeSDF evaluates the distance to a circular arc in ~15 lines of math.
//   The 'segments' parameter is retained for backward compatibility but has
//   no effect on SDF accuracy — only on the wireframe preview object.
//
// Family 2 — Region primitives (2D manifolds, exact SDF with inside/outside)
//   These will be added in Phase 4 (Circle, RegularPolygon, Polytope).
//   They are kept in separate files.
// ─────────────────────────────────────────────────────────────────────────────

import { ComplexShape2D } from "../Geometry/ComplexShape2d.js";
import { nextId } from "../utils/idGenerator.js";
import { Vertex } from "../Geometry/Vertex.js";
import { Edge } from "../Geometry/Edge.js";
import {
  weightedRUnion,
  weightedRIntersection,
  weightedRDifference
} from "../utils/SDFBlending.js";
import {
  createTemporalMapping,
  createSinusoidalMapping,
  createMapping,
  identityMapping
} from "../utils/DistanceMapping.js";
import { logger } from "../utils/logger.js";
import * as THREE from "three";


// ─────────────────────────────────────────────────────────────────────────────
// DerivativePrimitive — base class for curve primitives
// ─────────────────────────────────────────────────────────────────────────────

export class DerivativePrimitive {
  constructor(params = {}) {
    this.id             = params.id !== undefined ? params.id : nextId();
    this.type           = 'derivative';
    this.shapes         = [];
    this.color          = params.color || { h: 210, s: 0.8, l: 0.6 };
    this.blendSmoothness = params.blendSmoothness || 8;
    this.compositeSDF   = null;
    this.stateStore     = params.stateStore || null;
    // All curve primitives belong to the curve family
    this.family         = 'curve';

    logger.info(`Created DerivativePrimitive with id: ${this.id}`);
  }

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    if (this.shapes.length === 0) return Infinity;
    if (this.shapes.length === 1) {
      return this.shapes[0].computeSDF(point, callStack, time, depth);
    }
    let result = this.shapes[0].computeSDF(point, callStack, time, depth);
    for (let i = 1; i < this.shapes.length; i++) {
      result = weightedRUnion(
        result,
        this.shapes[i].computeSDF(point, callStack, time, depth),
        this.blendSmoothness
      );
    }
    return result;
  }

  createObject(time = 0) {
    const group = new THREE.Group();
    for (const shape of this.shapes) {
      group.add(shape.createLineObject(time));
    }
    return group;
  }

  transform(matrix) {
    for (const shape of this.shapes) shape.transform(matrix);
    return this;
  }

  setBlendSmoothness(smoothness) {
    this.blendSmoothness = smoothness;
    for (const shape of this.shapes) shape.setBlendParams({ smoothness });
    return this;
  }

  setColor(color) {
    this.color = color;
    for (const shape of this.shapes) {
      shape.color = color;
      if (shape.vertices) {
        for (const vertex of shape.vertices) vertex.color = color;
      }
    }
    return this;
  }

  registerWithStateStore(stateStore) {
    this.stateStore = stateStore;
    if (stateStore && typeof stateStore.registerPrimitive === 'function') {
      stateStore.registerPrimitive(this);
    }
    return this;
  }

  static getSerializableParameters(instance) {
    const common = {
      id:              instance.id,
      type:            instance.type,
      color:           instance.color,
      blendSmoothness: instance.blendSmoothness,
    };
    if (instance instanceof TrianglePrimitive) {
      return {
        ...common,
        size:           instance.size,
        rotation:       instance.rotation,
        position:       instance.position,
        cornerRounding: instance.cornerRounding,
        edgeSmoothness: instance.edgeSmoothness
      };
    } else if (instance instanceof ArcPrimitive) {
      return {
        ...common,
        radius:     instance.radius,
        startAngle: instance.startAngle,
        endAngle:   instance.endAngle,
        segments:   instance.segments,
        position:   instance.position,
        thickness:  instance.thickness
      };
    }
    return common;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// TrianglePrimitive — three line segments forming a triangle
// Curve family: SDF >= 0, isoOffset required for visible contours
// ─────────────────────────────────────────────────────────────────────────────

export class TrianglePrimitive extends DerivativePrimitive {
  constructor(params = {}) {
    super(params);
    this.type           = 'triangle';
    this.family         = 'curve';
    this.size           = params.size           || 1;
    this.cornerRounding = params.cornerRounding || 0;
    this.verticesInput  = params.vertices       || null;
    this.edgeSmoothness = params.edgeSmoothness || [0, 0, 0];
    this._params        = { ...params };

    this._initializeTriangle();
    logger.info(`Created TrianglePrimitive with id: ${this.id}`);
  }

  _initializeTriangle() {
    this.shapes = [];
    let vertices = (this.verticesInput && Array.isArray(this.verticesInput) && this.verticesInput.length === 3)
      ? this.verticesInput
      : this._createEquilateralVertices();
    // No _transformVertices() call — vertices stay in origin-centered local
    // space. Placement is handled by the node's own transform, applied
    // externally by SceneManager/NodeEvaluator, not baked in here.

    for (let i = 0; i < 3; i++) {
      const vertexA = new Vertex({ position: vertices[i],          color: this.color });
      const vertexB = new Vertex({ position: vertices[(i + 1) % 3], color: this.color });

      let distanceMapper = identityMapping;
      if (this.edgeSmoothness[i] > 0) {
        distanceMapper = createMapping('sinusoidal', {
          a: this.edgeSmoothness[i] * 0.1, b: 1, c: 0, e: 0
        });
      }

      const edge = new ComplexShape2D({
        vertices:      [vertexA, vertexB],
        color:         this.color,
        distanceMapper,
        smoothness:    this.blendSmoothness
      });
      this.shapes.push(edge);
    }

    if (this.cornerRounding > 0) this._applyCornerRounding();
  }

  _createEquilateralVertices() {
    const height = this.size * Math.sqrt(3) / 2;
    return [
      { x: 0,               y:  height * (2/3) },
      { x: -this.size / 2,  y: -height * (1/3) },
      { x:  this.size / 2,  y: -height * (1/3) }
    ];
  }

    _applyCornerRounding() {
    for (let i = 0; i < this.shapes.length; i++) {
      const shape         = this.shapes[i];
      const currentMapper = shape.distanceMapper || identityMapping;
      shape.distanceMapper = createMapping('temporal', {
        baseMapper: currentMapper,
        frequency:  0.5,
        amplitude:  this.cornerRounding * 0.1
      });
    }
  }

  updateParameters(params = {}) {
    if (params.size           !== undefined) this.size           = params.size;
    if (params.edgeSmoothness !== undefined) this.edgeSmoothness = params.edgeSmoothness;
    if (params.cornerRounding !== undefined) this.cornerRounding = params.cornerRounding;
    if (params.blendSmoothness !== undefined) this.blendSmoothness = params.blendSmoothness;
    if (params.color          !== undefined) this.color          = params.color;
    if (params.vertices       !== undefined) this.verticesInput  = params.vertices;
    this._initializeTriangle();
    return this;
  }

  getLocalSnapPoints() {
    const verts = this._createEquilateralVertices();
    return [{ x:0, y:0, z:0 }, ...verts.map(v => ({ x:v.x, y:v.y, z:0 }))];
  }

  clone() {
    const copy       = new TrianglePrimitive(this._params);
    copy.blendSmoothness = this.blendSmoothness;
    copy.color       = { ...this.color };
    return copy;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// ArcPrimitive — EXACT ANALYTIC circular arc SDF
//
// Previous implementation: N ComplexShape2D line segments blended together.
//   Problems: O(N) inner edge objects, ID counter explosion, approximation
//   error at low segment counts, _blendSegments cross-reference cascade.
//
// New implementation: single computeSDF method, ~15 lines of math.
//   - No inner shapes[], no ComplexShape2D instances, no stateStore pollution
//   - Exact distance to circular arc at any resolution
//   - 'segments' retained for backward compat but only used in createObject()
//     wireframe (visual preview) — has zero effect on SDF accuracy
//
// Curve family: SDF >= 0, isoOffset required for visible contours.
//
// SDF algorithm:
//   1. Translate query point by arc center (position)
//   2. Compute angle φ of the translated point
//   3. Normalise φ into the arc's angular range [startAngle, endAngle]
//   4. If φ is inside the range:
//        d = |sqrt(x² + y²) - radius|   ← distance to the circular band
//   5. If φ is outside the range:
//        d = min(dist to startPoint, dist to endPoint)
//   6. Apply distanceMapper if set (for thickness effects etc.)
// ─────────────────────────────────────────────────────────────────────────────

export class ArcPrimitive extends DerivativePrimitive {
  constructor(params = {}) {
    super(params);
    this.type           = 'arc';
    this.family         = 'curve';

    this.radius         = params.radius     !== undefined ? params.radius     : 1;
    this.startAngle     = params.startAngle !== undefined ? params.startAngle : 0;
    this.endAngle       = params.endAngle   !== undefined ? params.endAngle   : Math.PI;
    this.segments       = params.segments   !== undefined ? params.segments   : 8;
    this.thickness      = params.thickness  || 0;
    this.distanceMapper = params.distanceMapper || identityMapping;
    this._params        = { ...params };

    // ArcPrimitive no longer uses this.shapes[] for SDF evaluation.
    // this.shapes is empty — it exists only to satisfy DerivativePrimitive
    // interface without breaking anything that calls createObject().
    this.shapes = [];

    logger.info(`Created ArcPrimitive with id: ${this.id}, radius: ${this.radius}`);
  }

  // ── Exact analytic SDF ──────────────────────────────────────────────────

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    const px = point.x;
    const py = point.y;

    // Angle of the query point
    let phi = Math.atan2(py, px);

    // Normalise startAngle and endAngle to a canonical range
    // and determine if phi falls within the arc sweep
    const sweep = this.endAngle - this.startAngle;

    // Map phi into [startAngle, startAngle + 2π] for comparison
    let phiNorm = phi - this.startAngle;
    // Wrap into [0, 2π]
    phiNorm = ((phiNorm % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    let d;

    if (phiNorm <= sweep) {
      // Point's angle is within the arc sweep
      // Distance = |distance from origin - radius|
      const distFromOrigin = Math.sqrt(px * px + py * py);
      d = Math.abs(distFromOrigin - this.radius);
    } else {
      // Point's angle is outside the arc sweep
      // Distance = min(dist to startPoint, dist to endPoint)
      const sx = this.radius * Math.cos(this.startAngle);
      const sy = this.radius * Math.sin(this.startAngle);
      const ex = this.radius * Math.cos(this.endAngle);
      const ey = this.radius * Math.sin(this.endAngle);

      const dStart = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
      const dEnd   = Math.sqrt((px - ex) ** 2 + (py - ey) ** 2);
      d = Math.min(dStart, dEnd);
    }

    // Apply distance mapper (thickness, sinusoidal effects etc.)
    if (this.distanceMapper && typeof this.distanceMapper === 'function') {
      return this.distanceMapper(d);
    }
    return d;
  }

  // ── Three.js wireframe preview ───────────────────────────────────────────
  // Uses 'segments' to generate a piecewise linear approximation for display.
  // This does NOT affect SDF evaluation.

  createObject(time = 0) {
    const points    = [];
    const angleStep = (this.endAngle - this.startAngle) / this.segments;

    for (let i = 0; i <= this.segments; i++) {
      const angle = this.startAngle + i * angleStep;
      points.push(new THREE.Vector3(
        this.radius * Math.cos(angle),
        this.radius * Math.sin(angle),
        0
      ));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(
        (this.color.h || 30) / 360,
        this.color.s || 0.9,
        this.color.l || 0.5
      )
    });

    return new THREE.Line(geometry, material);
  }

  // ── Parameter update ─────────────────────────────────────────────────────

  updateParameters(params = {}) {
    if (params.radius     !== undefined) this.radius     = params.radius;
    if (params.startAngle !== undefined) this.startAngle = params.startAngle;
    if (params.endAngle   !== undefined) this.endAngle   = params.endAngle;
    if (params.segments   !== undefined) this.segments   = params.segments;
    if (params.thickness  !== undefined) {
      this.thickness = params.thickness;
      // Update the distance mapper to reflect new thickness
      if (params.thickness > 0) {
        this.distanceMapper = createMapping('sinusoidal', {
          a: params.thickness,
          b: 10,
          c: 0,
          e: params.thickness
        });
      } else {
        this.distanceMapper = identityMapping;
      }
    }
    if (params.blendSmoothness !== undefined) this.blendSmoothness = params.blendSmoothness;
    if (params.color           !== undefined) this.color           = params.color;

    logger.info(`Updated ArcPrimitive ${this.id}`);
    return this;
  }

  getLocalSnapPoints() {
    const sx = this.radius * Math.cos(this.startAngle);
    const sy = this.radius * Math.sin(this.startAngle);
    const ex = this.radius * Math.cos(this.endAngle);
    const ey = this.radius * Math.sin(this.endAngle);
    const mid = (this.startAngle + this.endAngle) / 2;
    const mx = this.radius * Math.cos(mid);
    const my = this.radius * Math.sin(mid);
    return [
      { x:0, y:0, z:0 },
      { x:sx, y:sy, z:0 }, { x:ex, y:ey, z:0 }, { x:mx, y:my, z:0 },
    ];
  }

  clone() {
    const copy       = new ArcPrimitive(this._params);
    copy.blendSmoothness = this.blendSmoothness;
    copy.color       = { ...this.color };
    return copy;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createDerivativePrimitive(type, params = {}) {
  switch (type.toLowerCase()) {
    case 'triangle': return new TrianglePrimitive(params);
    case 'arc':      return new ArcPrimitive(params);
    default:
      logger.warn(`Unknown derivative primitive type: ${type}. Defaulting to triangle.`);
      return new TrianglePrimitive(params);
  }
}

export default {
  DerivativePrimitive,
  TrianglePrimitive,
  ArcPrimitive,
  createDerivativePrimitive
};