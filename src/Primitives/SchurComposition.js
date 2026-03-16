// File: src/Primitives/SchurComposition.js
import { logger } from "../utils/logger.js";
import {
    invertAffine,
    makeAffine,
    isInvertible
  } from "../utils/affine.js";
import {
    weightedRUnion,
    weightedRIntersection,
    weightedRDifference
  } from "../utils/SDFBlending.js";
import { DerivativePrimitive } from "./primaryDerivativePrimitives.js";
import * as THREE from 'three';

/**
 * SchurComposition
 *
 * Implements a similarity-transform SDF composition using the standard
 * "transform the query point" technique:
 *
 *   result(x) = blend( f₁(T·x), f₂(T·x), … ) / scaleFactor
 *
 * Where T is the affine transform (rotation + scale + translation) and
 * scaleFactor corrects distances back to world space.
 *
 * This approach requires no cloning, no vertex transformation, and no
 * inverse-transform pass — it is O(n) per query point where n is the
 * total number of primitive edges/segments across all base shapes.
 *
 * @extends DerivativePrimitive
 */
export class SchurComposition extends DerivativePrimitive {
  /**
   * @param {Object} params
   * @param {Array}   params.shapes      - Base primitives to compose
   * @param {number}  params.rotation    - Rotation in radians
   * @param {number}  params.scale       - Uniform scale
   * @param {{x,y}}   params.position    - Translation
   * @param {string[]} params.operations - 'union' | 'intersection' | 'difference'
   * @param {number[]} params.weights    - Smoothness per operation
   * @param {Function} params.onDependencyUpdate - Callback for dependency tracking
   */
  constructor(params = {}) {
    super(params);
    this.type = 'schur-composition';

    this.baseShapes  = params.shapes     || [];
    this.rotation    = params.rotation   || 0;
    this.scale       = params.scale      || 1;
    this.position    = params.position   || { x: 0, y: 0 };
    this.operations  = params.operations || ['union'];
    this.weights     = params.weights    || [this.blendSmoothness];
    this.compositeFn = params.compositeFn || 'sequential';

    this._onDependencyUpdate = typeof params.onDependencyUpdate === 'function'
      ? params.onDependencyUpdate
      : null;

    // Points closer than isoOffset to the geometry are "inside" (negative SDF).
    // Tune this to control the visible thickness of the contour.
    this.isoOffset = params.isoOffset !== undefined ? params.isoOffset : 0.15;

    this._T           = null;
    this._Tinv        = null;
    this._scaleFactor = 1;
    this._needsUpdate = true;

    this._initializeComposition();
  }

  // ---------------------------------------------------------------------------
  // Initialisation — only computes T and T⁻¹, nothing more
  // ---------------------------------------------------------------------------

  _initializeComposition() {
    if (!this._needsUpdate && this._T && this._Tinv) return;
    if (this.baseShapes.length === 0) {
      this._needsUpdate = false;
      return;
    }

    const safeScale = Math.max(Math.abs(this.scale), 0.0001);

    this._T = makeAffine({
      rotation:  this.rotation,
      scale:     safeScale,
      translate: this.position
    });

    if (!isInvertible(this._T)) {
      logger.warn(`[${this.id}] SchurComposition: Transform not invertible — using identity.`);
      this._T           = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      this._scaleFactor = 1;
    } else {
      this._scaleFactor = Math.sqrt(
        Math.abs(this._T.a * this._T.d - this._T.b * this._T.c)
      );
    }

    this._Tinv        = invertAffine(this._T);
    this._needsUpdate = false;

    // A composition is a region if ALL its base shapes are regions.
    // Mixed compositions (region + curve) behave as curve since the
    // overall field still needs isoOffset for the curve components.
    this.family = this.baseShapes.length > 0 &&
      this.baseShapes.every(s => s.family === 'region')
      ? 'region'
      : 'curve';

    logger.info(`[${this.id}] SchurComposition ready. Scale factor: ${this._scaleFactor.toFixed(4)}, family: ${this.family}`);
  }

  // ---------------------------------------------------------------------------
  // Parameter updates
  // ---------------------------------------------------------------------------

  updateParameters(params = {}) {
    let changed = false;

    if (params.rotation  !== undefined && params.rotation  !== this.rotation)  { this.rotation  = params.rotation;  changed = true; }
    if (params.scale     !== undefined && params.scale     !== this.scale)     { this.scale     = params.scale;     changed = true; }
    if (params.operations !== undefined)                                        { this.operations = params.operations; changed = true; }
    // Accept singular 'operation' string as well as 'operations' array
    if (params.operation !== undefined)                                         { this.operations = [params.operation]; changed = true; }
    if (params.weights   !== undefined)                                        { this.weights   = params.weights;   changed = true; }
    if (params.smoothness !== undefined)                                       { this.weights   = [params.smoothness]; this.blendSmoothness = params.smoothness; changed = true; }
    if (params.isoOffset !== undefined && params.isoOffset !== this.isoOffset) { this.isoOffset = params.isoOffset; changed = true; }
    if (params.compositeFn !== undefined && params.compositeFn !== this.compositeFn) { this.compositeFn = params.compositeFn; changed = true; }
    if (params.shapes    !== undefined)                                        { this.baseShapes = params.shapes;   changed = true; }
    if (params.posX      !== undefined || params.posY !== undefined) {
      this.position = {
        x: params.posX !== undefined ? params.posX : this.position.x,
        y: params.posY !== undefined ? params.posY : this.position.y
      };
      changed = true;
    }
    if (params.position  !== undefined) {
      if (params.position.x !== this.position.x || params.position.y !== this.position.y) {
        this.position = params.position;
        changed = true;
      }
    }

    if (changed) {
      const childIds = this.baseShapes.map(s => s.id);
      if (this._onDependencyUpdate) this._onDependencyUpdate(this.id, childIds);
      this._needsUpdate = true;
      this._initializeComposition();
    }

    return changed;
  }

  // ---------------------------------------------------------------------------
  // SDF evaluation — core of the new approach
  //
  // Transform the query point x into blend-space (T·x), evaluate each base
  // shape there, blend the results, then divide by scaleFactor to convert
  // blend-space distances back to world-space distances.
  // ---------------------------------------------------------------------------

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    if (this._needsUpdate) this._initializeComposition();
    if (this.baseShapes.length === 0) return Infinity;

    // Cycle guard
    if (callStack.includes(this.id)) {
      logger.warn(`[${this.id}] SchurComposition: cycle detected — returning Infinity.`);
      return Infinity;
    }

    callStack.push(this.id);
    try {
      // Transform the query point into blend-space
      const T = this._T;
      const tp = {
        x: T.a * point.x + T.b * point.y + T.tx,
        y: T.c * point.x + T.d * point.y + T.ty,
      };

      // Evaluate each base shape at the transformed point.
      // isoOffset is only applied to curve primitives (family === 'curve')
      // which have no natural zero crossing. Region primitives (circle,
      // regularPolygon etc.) have genuine inside/outside semantics —
      // their zero crossing IS the boundary, no offset needed.
      const sdfValues = this.baseShapes.map(shape => {
        const d = shape.computeSDF(tp, [...callStack], time, depth);
        return shape.family === 'region' ? d : d - this.isoOffset;
      });

      // Blend according to the configured strategy and operations
      let result = sdfValues[0];
      for (let i = 1; i < sdfValues.length; i++) {
        const op = this.operations[(i - 1) % this.operations.length];
        const w  = this.weights[(i - 1) % this.weights.length];
        if (op === 'intersection') {
          result = weightedRIntersection(result, sdfValues[i], w);
        } else if (op === 'difference') {
          result = weightedRDifference(result, sdfValues[i], w);
        } else {
          result = weightedRUnion(result, sdfValues[i], w);
        }
      }

    // Convert blend-space distance → world-space distance
      return result / this._scaleFactor;

    } finally {
      const idx = callStack.indexOf(this.id);
      if (idx >= 0) callStack.splice(idx, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering fallback (SceneManager uses marchingSquares directly, but
  // persistence.loadScene may call createObject via createVisual)
  // ---------------------------------------------------------------------------

  createObject(time = 0) {
    return new THREE.Group(); // visual is built externally by SceneManager
  }

  // ---------------------------------------------------------------------------
  // Clone
  // ---------------------------------------------------------------------------

  clone() {
    const clone = new SchurComposition({
      shapes:      this.baseShapes,   // share references — cloning geometry is unnecessary
      rotation:    this.rotation,
      scale:       this.scale,
      position:    { x: this.position.x, y: this.position.y },
      operations:  [...this.operations],
      weights:     [...this.weights],
      compositeFn: this.compositeFn,
      color:       { ...this.color },
      blendSmoothness: this.blendSmoothness
    });
    return clone;
  }
}

export default SchurComposition;