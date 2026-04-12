// File: src/state/stateStore.js

import {
  createBlendedPrimitive,
  weightedRUnion,
  weightedRIntersection,
  weightedRDifference
} from "../utils/SDFBlending.js";
import {
  distanceMappingRegistry,
  identityMapping,
  createMapping
} from "../utils/DistanceMapping.js";
import { logger } from "../utils/logger.js";
import { TrianglePrimitive, ArcPrimitive } from "../Primitives/primaryDerivativePrimitives.js";
import { ComplexShape2D } from "../Geometry/ComplexShape2d.js";
import { ComplexPrimitive2D } from "../Primitives/ComplexPrimitive2d.js";
import {
  SpherePrimitive,
  BoxPrimitive,
  CylinderPrimitive,
  CapsulePrimitive,
  TorusPrimitive,
  ConePrimitive,
  InfinitePlanePrimitive
} from "../Primitives/solidPrimitives.js";
import { NodeGraph } from "../graph/NodeGraph.js";


export class StateStore {
  constructor() {
    // Phase 1: sessionShapes is now a Map<id, instance> instead of a Set.
    // This gives O(1) lookup for getShape() and makes nodeGraph mirroring clean.
    this.sessionShapes = new Map();

    // Node graph — the ground-truth data model for scene structure.
    // sessionShapes is the instance cache; nodeGraph is the serialisable record.
    this.nodeGraph = new NodeGraph();

    // Visual update callbacks
    this.visualUpdateCallbacks = [];

    // Dependency map — kept for cycle detection during triggerVisualUpdate.
    // Will be removed in Phase 3 once the canvas UI replaces dat.GUI.
    this.dependencyMap = new Map();

    // Mapping configuration properties
    this.selectedMappingType = "polynomial";
    this.baseMapping = identityMapping;
    this.blendFactor = 0.5;
    this.timeFrequency = 1.0;
    this.recursionLimit = 3;
    this.amplitude = 1.0;
    this.mappingParams = {};
  }

  // ---------------------------------------------------------------------------
  // Dependency tracking (legacy — delegates to dependencyMap)
  // ---------------------------------------------------------------------------

  _updateDependencies(shapeId, childIds = []) {
    this.dependencyMap.set(shapeId, childIds);
  }

  _hasCycle(startId, visited = new Set(), stack = new Set()) {
    if (stack.has(startId)) return true;
    if (visited.has(startId)) return false;
    visited.add(startId);
    stack.add(startId);
    for (const childId of this.dependencyMap.get(startId) || []) {
      if (this._hasCycle(childId, visited, stack)) return true;
    }
    stack.delete(startId);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Distance mapping
  // ---------------------------------------------------------------------------

  get distanceMapping() {
    return createMapping(this.selectedMappingType, {
      baseMapper:  this.baseMapping,
      baseMappers: [this.baseMapping, identityMapping],
      blendFactor: this.blendFactor,
      frequency:   this.timeFrequency,
      amplitude:   this.amplitude,
      iterations:  this.recursionLimit,
      polyCoeffs:  [0, 1, 0],
      a: 1, b: 1, c: 0, e: 0
    });
  }

  updateMappingConfig(config = {}) {
    const {
      mappingType, baseMapper, secondaryMapper,
      blendFactor, frequency, recursionLimit, polyCoeffs,
      a, b, c, e, amplitude = 1.0
    } = config;

    if (mappingType)             this.selectedMappingType = mappingType;
    if (baseMapper)              this.baseMapping         = baseMapper;
    if (blendFactor !== undefined) this.blendFactor       = blendFactor;
    if (frequency   !== undefined) this.timeFrequency     = frequency;
    if (recursionLimit !== undefined) this.recursionLimit = recursionLimit;
    if (amplitude   !== undefined) this.amplitude         = amplitude;

    this.mappingParams = {
      ...this.mappingParams,
      polyCoeffs: polyCoeffs || [0, 1, 0],
      a: a !== undefined ? a : 1,
      b: b !== undefined ? b : 1,
      c: c !== undefined ? c : 0,
      e: e !== undefined ? e : 0,
      secondaryMapper: secondaryMapper || identityMapping
    };

    logger.debug(`Updated mapping configuration: ${this.selectedMappingType}`);
    return this.distanceMapping;
  }

  // ---------------------------------------------------------------------------
  // Shape management — all methods now use Map instead of Set
  // ---------------------------------------------------------------------------

  addShape(shape) {
    shape.active    = true;
    shape.createdAt = Date.now();
    shape.rendered  = true;

    // Instance cache
    this.sessionShapes.set(shape.id, shape);

    // Mirror to nodeGraph
    const nodeType = this._inferNodeType(shape);
    if (nodeType) {
      const params = this._extractNodeParams(shape);
      try {
        this.nodeGraph.addNode(nodeType, params, { x: 0, y: 0 }, shape.id);
      } catch (e) {
        // Node with this id already exists (e.g. during recompose) — update params
        this.nodeGraph.nodes.get(shape.id) && Object.assign(
          this.nodeGraph.nodes.get(shape.id).params, params
        );
      }
    }

    console.log(
      `Shape added - id: ${shape.id}, type: ${shape.type || shape.constructor.name}. ` +
      `Total shapes: ${this.sessionShapes.size}`
    );
    return shape.id;
  }

  getShape(shapeId) {
    return this.sessionShapes.get(shapeId);
  }

  getShapes() {
    return Array.from(this.sessionShapes.values());
  }

  removeShape(shapeId) {
    const shape = this.sessionShapes.get(shapeId);
    if (shape) {
      this.sessionShapes.delete(shapeId);
      // Mirror removal to nodeGraph
      if (this.nodeGraph.nodes.has(shapeId)) {
        this.nodeGraph.removeNode(shapeId);
      }
      console.log(`Shape ${shapeId} removed. Total shapes: ${this.sessionShapes.size}`);
      return shape;
    }
    return null;
  }

  clear() {
    this.sessionShapes.clear();
    this.nodeGraph = new NodeGraph();
    this.dependencyMap.clear();
    console.log("State store cleared.");
  }

  // ---------------------------------------------------------------------------
  // Visual update callbacks
  // ---------------------------------------------------------------------------

  onVisualUpdate(callback) {
    if (typeof callback === 'function') {
      this.visualUpdateCallbacks.push(callback);
      logger.debug(`Visual update callback registered. Total: ${this.visualUpdateCallbacks.length}`);
      return true;
    }
    logger.warn("Attempted to register invalid visual update callback");
    return false;
  }

  triggerVisualUpdate(shapeId) {
    if (this._hasCycle(shapeId)) {
      console.error(`Cycle detected in dependencies of shape ${shapeId}; update aborted.`);
      return;
    }
    this.visualUpdateCallbacks.forEach(callback => {
      try { callback(shapeId); }
      catch (error) { logger.error(`Error in visual update callback: ${error.message}`); }
    });
  }

  // ---------------------------------------------------------------------------
  // Shape mapper and blend operations
  // ---------------------------------------------------------------------------

  updateShapeMapper(shapeId, mapperName, mapperParams) {
    const shape = this.getShape(shapeId);
    if (!shape) return;
    if (!mapperName || typeof mapperName !== 'string') return;

    if (distanceMappingRegistry[mapperName]) {
      if (typeof distanceMappingRegistry[mapperName] === 'function' &&
          distanceMappingRegistry[mapperName].length > 0) {
        shape.distanceMapper = distanceMappingRegistry[mapperName](
          mapperParams.a, mapperParams.b, mapperParams.c, mapperParams.e
        );
      } else {
        shape.distanceMapper = distanceMappingRegistry[mapperName];
      }
    } else {
      console.warn(`Mapper "${mapperName}" not found. Using identity.`);
      shape.distanceMapper = identityMapping;
    }

    if (typeof shape.updateCompositeSDF === 'function') shape.updateCompositeSDF();
    this.triggerVisualUpdate(shape.id);
  }

  setShapeBlendParams(shapeId, blendParams) {
    const shape = this.getShape(shapeId);
    if (shape && typeof shape.setBlendParams === 'function') {
      shape.setBlendParams(blendParams);
      this.triggerVisualUpdate(shape.id);
      return true;
    }
    return false;
  }

  addBlendPrimitive(shapeId, primitiveId, operation = null) {
    const shape     = this.getShape(shapeId);
    const primitive = this.getShape(primitiveId);
    if (!shape || !primitive || typeof shape.addBlendPrimitive !== 'function') return false;
    if (shapeId === primitiveId) { console.warn("Cannot add shape to its own blend list"); return false; }

    shape.addBlendPrimitive(primitive, operation);
    this._updateDependencies(shapeId, shape.blendParams.primitives.map(p => p.id));
    this.triggerVisualUpdate(shape.id);
    return true;
  }

  removeBlendPrimitive(shapeId, primitiveId) {
    const shape = this.getShape(shapeId);
    if (shape && shape.blendParams && shape.blendParams.primitives) {
      const index = shape.blendParams.primitives.findIndex(p => p.id === primitiveId);
      if (index >= 0) {
        shape.blendParams.primitives.splice(index, 1);
        shape.updateCompositeSDF();
        this._updateDependencies(shapeId, shape.blendParams.primitives.map(p => p.id));
        this.triggerVisualUpdate(shape.id);
        return true;
      }
    }
    return false;
  }

  clearBlendPrimitives(shapeId) {
    const shape = this.getShape(shapeId);
    if (shape && typeof shape.clearBlendPrimitives === 'function') {
      shape.clearBlendPrimitives();
      this._updateDependencies(shapeId, []);
      this.triggerVisualUpdate(shape.id);
      return true;
    }
    return false;
  }

  createBlendedShape(primitiveIds, params = {}) {
    const primitives = primitiveIds.map(id => this.getShape(id)).filter(Boolean);
    if (primitives.length === 0) { console.warn("No valid primitives for blending"); return null; }

    const blended = createBlendedPrimitive(primitives, params);
    this.sessionShapes.set(blended.id, blended);
    this.triggerVisualUpdate(blended.id);
    return blended;
  }

  setBasePrimitive(shapeId, primitiveId) {
    const shape     = this.getShape(shapeId);
    const primitive = this.getShape(primitiveId);
    if (shape && primitive && typeof shape.setBasePrimitive === 'function') {
      shape.setBasePrimitive(primitive);
      const deps = [primitiveId, ...shape.blendParams.primitives.map(p => p.id)];
      this._updateDependencies(shapeId, deps);
      this.triggerVisualUpdate(shapeId);
      return true;
    }
    return false;
  }

  applyGlobalMappingToShape(shapeId) {
    const shape = this.getShape(shapeId);
    if (shape) {
      shape.distanceMapper = this.distanceMapping;
      if (typeof shape.updateCompositeSDF === 'function') shape.updateCompositeSDF();
      this.triggerVisualUpdate(shapeId);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Garbage collection
  // ---------------------------------------------------------------------------

  runGarbageCollection() {
    const now     = Date.now();
    const MIN_AGE = 5 * 60 * 1000;
    for (const [id, shape] of this.sessionShapes) {
      if ((now - shape.createdAt) > MIN_AGE && !shape.rendered) {
        this.sessionShapes.delete(id);
        if (this.nodeGraph.nodes.has(id)) this.nodeGraph.removeNode(id);
      }
    }
    console.log(`GC complete. Remaining shapes: ${this.sessionShapes.size}`);
  }

  // ---------------------------------------------------------------------------
  // Deserialisation (for persistence.loadScene)
  // ---------------------------------------------------------------------------

  createShapeFromSerialized(type, data) {
    let shape = null;
    logger.info(`Deserializing shape of type: "${type}"`);

    try {
      switch (type.toLowerCase()) {
        case "triangle":          shape = new TrianglePrimitive(data);        break;
        case "arc":               shape = new ArcPrimitive(data);             break;
        case "line":
        case "complexshape":
        case "composite":         shape = new ComplexShape2D(data);           break;
        case "complexprimitive":  shape = new ComplexPrimitive2D(data);       break;

        case "sphere":            shape = new SpherePrimitive(data);          break;
        case "box":               shape = new BoxPrimitive(data);             break;
        case "cylinder":          shape = new CylinderPrimitive(data);        break;
        case "capsule":           shape = new CapsulePrimitive(data);         break;
        case "torus":             shape = new TorusPrimitive(data);           break;
        case "cone":              shape = new ConePrimitive(data);            break;
        case "plane":             shape = new InfinitePlanePrimitive(data);   break;

        default:
          logger.warn(`Unknown shape type: "${type}"`);
      }

      if (shape) {
        if (data?.id) { shape.id = data.id; }

        if (data?.distanceMapperName) {
          const entry = distanceMappingRegistry[data.distanceMapperName];
          if (entry && typeof entry === 'function' && data.distanceMapperName !== 'createMapping') {
            shape.distanceMapper = entry;
          } else {
            shape.distanceMapper = identityMapping;
          }
        }
      }
    } catch (error) {
      logger.error(`Error deserializing shape of type "${type}": ${error.message}`);
      shape = null;
    }

    return shape;
  }

  // ---------------------------------------------------------------------------
  // NodeGraph mirroring helpers (private)
  // ---------------------------------------------------------------------------

  /**
   * Map a shape instance to its NodeSpec type string.
   * Returns null for types that don't have a node spec (inner edges etc.).
   */
  _inferNodeType(shape) {
    if (!shape) return null;
    if (shape.type === 'triangle')           return 'triangle';
    if (shape.type === 'arc')                return 'arc';
    if (shape.type === 'circle')             return 'circle';
    if (shape.type === 'regularPolygon')     return 'regularPolygon';
    if (shape.type === 'polytope')           return 'polytope';
    if (shape.type === 'sphere')             return 'sphere';
    if (shape.type === 'box')                return 'box';
    if (shape.type === 'cylinder')           return 'cylinder';
    if (shape.type === 'capsule')            return 'capsule';
    if (shape.type === 'torus')              return 'torus';
    if (shape.type === 'cone')               return 'cone';
    if (shape.type === 'plane')              return 'plane';
    if (shape.type === 'schur-composition')  return 'schurBlend';
    if (shape instanceof ComplexShape2D)     return 'lineSegment';
    return null;
  }

  /**
   * Extract serialisable params from a shape instance so the corresponding
   * node in nodeGraph stays in sync.
   */
  _extractNodeParams(shape) {
    if (!shape) return {};

    if (shape.type === 'triangle') {
      return {
        size:           shape.size           || 1,
        rotation:       shape.rotation       || 0,
        posX:           shape.position?.x    || 0,
        posY:           shape.position?.y    || 0,
        cornerRounding: shape.cornerRounding || 0
      };
    }

    if (shape.type === 'arc') {
      return {
        radius:     shape.radius              || 1.5,
        startAngle: shape.startAngle          || 0,
        endAngle:   shape.endAngle !== undefined ? shape.endAngle : Math.PI,
        segments:   shape.segments            || 8,
        posX:       shape.position?.x         || 0,
        posY:       shape.position?.y         || 0,
        thickness:  shape.thickness           || 0
      };
    }

    if (shape.type === 'circle') {
      return {
        radius: shape.radius !== undefined ? shape.radius : 1,
        posX:   shape.posX   !== undefined ? shape.posX   : 0,
        posY:   shape.posY   !== undefined ? shape.posY   : 0,
      };
    }

    if (shape.type === 'regularPolygon') {
      return {
        sides:    shape.sides    !== undefined ? shape.sides    : 6,
        size:     shape.size     !== undefined ? shape.size     : 1,
        rotation: shape.rotation !== undefined ? shape.rotation : 0,
        posX:     shape.posX     !== undefined ? shape.posX     : 0,
        posY:     shape.posY     !== undefined ? shape.posY     : 0,
      };
    }

    if (shape.type === 'polytope') {
      return {
        vertices: JSON.stringify(shape.vertices || [[-1,-1],[1,-1],[1,1],[-1,1]]),
        posX:     shape.posX     !== undefined ? shape.posX     : 0,
        posY:     shape.posY     !== undefined ? shape.posY     : 0,
        rotation: shape.rotation !== undefined ? shape.rotation : 0,
      };
    }

    if (shape.type === 'sphere') {
      return {
        radius: shape.radius ?? 1,
        posX:   shape.posX   ?? 0,
        posY:   shape.posY   ?? 0,
        posZ:   shape.posZ   ?? 0,
      };
    }
    if (shape.type === 'box') {
      return {
        width:  shape.width  ?? 2,
        height: shape.height ?? 2,
        depth:  shape.depth  ?? 2,
        posX:   shape.posX   ?? 0,
        posY:   shape.posY   ?? 0,
        posZ:   shape.posZ   ?? 0,
      };
    }
    if (shape.type === 'cylinder') {
      return {
        radius: shape.radius ?? 1,
        height: shape.height ?? 2,
        capped: shape.capped ? 'yes' : 'no',
        posX:   shape.posX   ?? 0,
        posY:   shape.posY   ?? 0,
        posZ:   shape.posZ   ?? 0,
      };
    }
    if (shape.type === 'capsule') {
      return {
        ax: shape.ax ?? 0, ay: shape.ay ?? -1, az: shape.az ?? 0,
        bx: shape.bx ?? 0, by: shape.by ??  1, bz: shape.bz ?? 0,
        radius: shape.radius ?? 0.5,
      };
    }
    if (shape.type === 'torus') {
      return {
        majorRadius: shape.majorRadius ?? 2,
        minorRadius: shape.minorRadius ?? 0.5,
        posX: shape.posX ?? 0,
        posY: shape.posY ?? 0,
        posZ: shape.posZ ?? 0,
      };
    }

    if (shape.type === 'cone') {
      return {
        radius: shape.radius ?? 1,
        height: shape.height ?? 2,
        posX:   shape.posX ?? 0,
        posY:   shape.posY ?? 0,
        posZ:   shape.posZ ?? 0,
      };
    }

    if (shape.type === 'plane') {
      return {
        nx:     shape.nx ?? 0,
        ny:     shape.ny ?? 1,
        nz:     shape.nz ?? 0,
        offset: shape.offset ?? 0,
      };
    }

    if (shape.type === 'schur-composition') {
      return {
        operation:  shape.operations?.[0]  || 'union',
        smoothness: shape.blendSmoothness  || 8,
        rotation:   shape.rotation         || 0,
        scale:      shape.scale            || 1,
        posX:       shape.position?.x      || 0,
        posY:       shape.position?.y      || 0,
        isoOffset:  shape.isoOffset        || 0.15
      };
    }

    if (shape instanceof ComplexShape2D) {
      return {
        x1: shape.vertices?.[0]?.position?.x ?? 0,
        y1: shape.vertices?.[0]?.position?.y ?? 0,
        x2: shape.vertices?.[1]?.position?.x ?? 1,
        y2: shape.vertices?.[1]?.position?.y ?? 0
      };
    }

    return {};
  }
}

// Singleton export — all existing import sites require no changes.
export const stateStore = new StateStore();