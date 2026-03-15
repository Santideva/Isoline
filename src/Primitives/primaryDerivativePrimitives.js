// File: src/primitives/primaryDerivativePrimitives.js
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

/**
 * Base class for derived primitives that compose multiple ComplexShape2D instances
 */
export class DerivativePrimitive {
  constructor(params = {}) {
    this.id = params.id !== undefined ? params.id : nextId();
    this.type = 'derivative';
    this.shapes = [];
    this.color = params.color || { h: 210, s: 0.8, l: 0.6 };
    this.blendSmoothness = params.blendSmoothness || 8;
    this.compositeSDF = null;

    // Store reference to stateStore if provided
    this.stateStore = params.stateStore || null;

    logger.info(`Created DerivativePrimitive with id: ${this.id}`);
  }

  /**
   * Calculate SDF value at a given point
   * @param {Object} point - Point to evaluate (x, y)
   * @param {Array} callStack - For preventing infinite recursion
   * @param {number} time - Current time for animations
   * @param {number} depth - Recursion depth
   * @returns {number} The SDF value at the given point
   */
  computeSDF(point, callStack = [], time = 0, depth = 0) {
    if (this.shapes.length === 0) {
      return Infinity;
    }

    // If only one shape, use its SDF directly
    if (this.shapes.length === 1) {
      return this.shapes[0].computeSDF(point, callStack, time, depth);
    }

    // Otherwise blend all shapes' SDFs
    let result = this.shapes[0].computeSDF(point, callStack, time, depth);
    
    for (let i = 1; i < this.shapes.length; i++) {
      const shapeSdf = this.shapes[i].computeSDF(point, callStack, time, depth);
      result = weightedRUnion(result, shapeSdf, this.blendSmoothness);
    }

    return result;
  }

  /**
   * Create a THREE.js group representing this derivative primitive
   * @param {number} time - Current time for animations
   * @returns {THREE.Group} Group containing all shapes' THREE.js objects
   */
  createObject(time = 0) {
    const group = new THREE.Group();
    
    for (const shape of this.shapes) {
      const lineObject = shape.createLineObject(time);
      group.add(lineObject);
    }
    
    return group;
  }

  /**
   * Apply a transformation matrix to all shapes
   * @param {Object} matrix - Transformation matrix
   * @returns {DerivativePrimitive} This instance for chaining
   */
  transform(matrix) {
    for (const shape of this.shapes) {
      shape.transform(matrix);
    }
    return this;
  }

  /**
   * Set the blend smoothness for all shapes
   * @param {number} smoothness - Blend smoothness value
   * @returns {DerivativePrimitive} This instance for chaining
   */
  setBlendSmoothness(smoothness) {
    this.blendSmoothness = smoothness;
    for (const shape of this.shapes) {
      shape.setBlendParams({ smoothness });
    }
    return this;
  }

  /**
   * Set the color for all shapes
   * @param {Object} color - Color object with h, s, l properties
   * @returns {DerivativePrimitive} This instance for chaining
   */
  setColor(color) {
    this.color = color;
    for (const shape of this.shapes) {
      shape.color = color;
      
      // Update vertex colors if they exist
      if (shape.vertices) {
        for (const vertex of shape.vertices) {
          vertex.color = color;
        }
      }
    }
    return this;
  }

  /**
   * Register this primitive with the state store
   * @param {Object} stateStore - The state store to register with
   * @returns {DerivativePrimitive} This instance for chaining
   */
  registerWithStateStore(stateStore) {
    this.stateStore = stateStore;
    if (stateStore && typeof stateStore.registerPrimitive === 'function') {
      stateStore.registerPrimitive(this);
    }
    return this;
  }

  /**
   * Static method for serializing a derived primitive.
   * This method extracts common properties and then adds type-specific properties.
   * @param {DerivativePrimitive} instance - The instance to serialize.
   * @returns {Object} An object representing the serializable properties.
   */
  static getSerializableParameters(instance) {
    // Common properties for all derived primitives
    const common = {
      id: instance.id,
      type: instance.type,
      color: instance.color,
      blendSmoothness: instance.blendSmoothness,
      // You might include additional common properties here if needed.
    };

    // Check instance type and extract type-specific properties.
    if (instance instanceof TrianglePrimitive) {
      return {
        ...common,
        size: instance.size,
        rotation: instance.rotation,
        position: instance.position,
        cornerRounding: instance.cornerRounding,
        edgeSmoothness: instance.edgeSmoothness
        // You can also include any additional triangle-specific parameters.
      };
    } else if (instance instanceof ArcPrimitive) {
      return {
        ...common,
        radius: instance.radius,
        startAngle: instance.startAngle,
        endAngle: instance.endAngle,
        segments: instance.segments,
        position: instance.position,
        thickness: instance.thickness
        // Additional arc-specific parameters can be added here.
      };
    } else {
      // Fallback: return common properties only.
      return common;
    }
  }
}

/**
 * Triangle primitive composed of three line segments
 * 
 * This implementation is driven by parameters: if vertices are provided, they are used directly.
 * Otherwise, an equilateral triangle is computed using a single 'size' parameter.
 * The GUI can modulate edge length (via size), rotation, and corner rounding.
 */
export class TrianglePrimitive extends DerivativePrimitive {
  constructor(params = {}) {
    super(params);
    this.type = 'triangle';
    
    // Triangle parameters with defaults
    this.size = params.size || 1; // Defines the edge length for an equilateral triangle
    this.rotation = params.rotation || 0;
    this.position = params.position || { x: 0, y: 0 };
    this.cornerRounding = params.cornerRounding || 0;
    // Optionally, user can provide custom vertices:
    this.verticesInput = params.vertices || null;
    // Edge-specific smoothness can be modulated via an array [s1, s2, s3]
    this.edgeSmoothness = params.edgeSmoothness || [0, 0, 0];
    
    // Initialize the triangle shapes
    this._initializeTriangle();
    
    logger.info(`Created TrianglePrimitive with id: ${this.id}`);
    // ── store original params for cloning ─────────────────────
    this._params = { ...params };    
  }

  /**
   * Initialize the triangle shapes based on provided parameters
   * @private
   */
  _initializeTriangle() {
    // Clear existing shapes
    this.shapes = [];
    
    // Calculate vertices
    let vertices;
    if (this.verticesInput && Array.isArray(this.verticesInput) && this.verticesInput.length === 3) {
      vertices = this.verticesInput;
    } else {
      // Compute an equilateral triangle's vertices based on the size parameter
      vertices = this._createEquilateralVertices();
    }
    
    // Apply position and rotation to vertices
    vertices = this._transformVertices(vertices);
    
    // Create the three edges of the triangle
    for (let i = 0; i < 3; i++) {
      const vertexA = new Vertex({ 
        position: vertices[i], 
        color: this.color 
      });
      
      const vertexB = new Vertex({ 
        position: vertices[(i + 1) % 3], 
        color: this.color 
      });
      
      // Create a distance mapper for the edge if smoothness is applied
      let distanceMapper = identityMapping;
      if (this.edgeSmoothness[i] > 0) {
        distanceMapper = createMapping('sinusoidal', {
          a: this.edgeSmoothness[i] * 0.1,
          b: 1,
          c: 0,
          e: 0
        });
      }
      
      // Create the edge shape using ComplexShape2D
      const edge = new ComplexShape2D({
        vertices: [vertexA, vertexB],
        color: this.color,
        distanceMapper: distanceMapper,
        smoothness: this.blendSmoothness
      });
      
      this.shapes.push(edge);
    }
    
    // Apply corner rounding if specified
    if (this.cornerRounding > 0) {
      this._applyCornerRounding();
    }
  }

  /**
   * Create vertices for an equilateral triangle centered at origin
   * @private
   * @returns {Array} Array of vertex positions
   */
  _createEquilateralVertices() {
    const height = this.size * Math.sqrt(3) / 2;
    return [
      { x: 0, y: height * (2/3) },
      { x: -this.size / 2, y: -height * (1/3) },
      { x: this.size / 2, y: -height * (1/3) }
    ];
  }

  /**
   * Apply position and rotation transforms to vertices
   * @private
   * @param {Array} vertices - Original vertices
   * @returns {Array} Transformed vertices
   */
  _transformVertices(vertices) {
    // Create rotation matrix
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    
    return vertices.map(v => {
      // Apply rotation
      const x = v.x * cos - v.y * sin;
      const y = v.x * sin + v.y * cos;
      
      // Apply translation (position)
      return {
        x: x + this.position.x,
        y: y + this.position.y
      };
    });
  }

  /**
   * Apply corner rounding by modifying distance mappers of each edge
   * @private
   */
  _applyCornerRounding() {
    logger.debug(`Applying corner rounding with value ${this.cornerRounding}`);
    
    for (let i = 0; i < this.shapes.length; i++) {
      const shape = this.shapes[i];
      const currentMapper = shape.distanceMapper || identityMapping;
      
      // Create a temporal mapping that applies the rounding effect
      shape.distanceMapper = createMapping('temporal', {
        baseMapper: currentMapper,
        frequency: 0.5,
        amplitude: this.cornerRounding * 0.1
      });
    }
  }

  /**
   * Blend all edges together using weighted union
   * @private
   */
  _blendEdges() {
    if (this.shapes.length > 1) {
      for (let i = 0; i < this.shapes.length; i++) {
        const shape = this.shapes[i];
        // Set primitives directly — skip per-call updateCompositeSDF
        shape.blendParams.primitives = this.shapes.filter((_, j) => j !== i);
        shape.blendParams.operation  = 'union';
        shape.blendParams.smoothness = this.blendSmoothness;
        shape.updateCompositeSDF(); // one call per edge, not n-1
      }
    }
  }

  /**
   * Update triangle parameters and reinitialize
   * @param {Object} params - New parameters
   * @returns {TrianglePrimitive} This instance for chaining
   */
  updateParameters(params = {}) {
    if (params.size !== undefined) this.size = params.size;
    if (params.rotation !== undefined) this.rotation = params.rotation;
    if (params.position !== undefined) this.position = params.position;
    if (params.edgeSmoothness !== undefined) this.edgeSmoothness = params.edgeSmoothness;
    if (params.cornerRounding !== undefined) this.cornerRounding = params.cornerRounding;
    if (params.blendSmoothness !== undefined) this.blendSmoothness = params.blendSmoothness;
    if (params.color !== undefined) this.color = params.color;
    if (params.vertices !== undefined) this.verticesInput = params.vertices;
    
    // Reinitialize the triangle with updated parameters
    this._initializeTriangle();
    
    logger.info(`Updated TrianglePrimitive ${this.id} with new parameters`);
    return this;
  }
  // ←— INSERT AT END OF CLASS:
  clone() {
    const copy = new TrianglePrimitive(this._params);
    copy.blendSmoothness = this.blendSmoothness;
    copy.color           = { ...this.color };
    return copy;
  }  
}

/**
 * Arc primitive composed of multiple line segments along a circular path
 */
export class ArcPrimitive extends DerivativePrimitive {
  constructor(params = {}) {
    super(params);
    this.type = 'arc';
    
    // Arc parameters with defaults
    this.radius = params.radius || 1;
    this.startAngle = params.startAngle || 0;
    this.endAngle = params.endAngle !== undefined ? params.endAngle : Math.PI;
    this.segments = params.segments || 8;
    this.position = params.position || { x: 0, y: 0 };
    this.thickness = params.thickness || 0;
    
    // Initialize the arc shapes
    this._initializeArc();
    
    logger.info(`Created ArcPrimitive with id: ${this.id}, radius: ${this.radius}, segments: ${this.segments}`);
    // ── store original params for cloning ─────────────────────
    this._params = { ...params };    
  }

  /**
   * Initialize the arc shapes based on parameters
   * @private
   */
  _initializeArc() {
    // Clear existing shapes
    this.shapes = [];
    
    // Calculate angle step
    const angleRange = this.endAngle - this.startAngle;
    const angleStep = angleRange / this.segments;
    
    // Create line segments along the arc
    for (let i = 0; i < this.segments; i++) {
      const angle1 = this.startAngle + i * angleStep;
      const angle2 = this.startAngle + (i + 1) * angleStep;
      
      // Calculate vertex positions along a circular path
      const x1 = this.position.x + this.radius * Math.cos(angle1);
      const y1 = this.position.y + this.radius * Math.sin(angle1);
      const x2 = this.position.x + this.radius * Math.cos(angle2);
      const y2 = this.position.y + this.radius * Math.sin(angle2);
      
      // Create vertices
      const vertexA = new Vertex({ 
        position: { x: x1, y: y1 }, 
        color: this.color 
      });
      
      const vertexB = new Vertex({ 
        position: { x: x2, y: y2 }, 
        color: this.color 
      });
      
      // Create a distance mapper for a thickness effect if specified
      let distanceMapper = identityMapping;
      if (this.thickness > 0) {
        distanceMapper = createMapping('sinusoidal', {
          a: this.thickness,
          b: 10,  // Frequency
          c: 0,   // Phase
          e: this.thickness  // Vertical shift
        });
      }
      
      // Create the edge shape
      const segment = new ComplexShape2D({
        vertices: [vertexA, vertexB],
        color: this.color,
        distanceMapper: distanceMapper,
        smoothness: this.blendSmoothness
      });
      
      this.shapes.push(segment);
    }
  }

  /**
   * Blend all segments together using weighted union
   * @private
   */
  _blendSegments() {
    if (this.shapes.length > 1) {
      for (let i = 0; i < this.shapes.length; i++) {
        const shape = this.shapes[i];
        shape.blendParams.primitives = this.shapes.filter((_, j) => j !== i);
        shape.blendParams.operation  = 'union';
        shape.blendParams.smoothness = this.blendSmoothness;
        shape.updateCompositeSDF();
      }
    }
  }

  /**
   * Update arc parameters and reinitialize
   * @param {Object} params - New parameters
   * @returns {ArcPrimitive} This instance for chaining
   */
  updateParameters(params = {}) {
    if (params.radius !== undefined) this.radius = params.radius;
    if (params.startAngle !== undefined) this.startAngle = params.startAngle;
    if (params.endAngle !== undefined) this.endAngle = params.endAngle;
    if (params.segments !== undefined) this.segments = params.segments;
    if (params.position !== undefined) this.position = params.position;
    if (params.thickness !== undefined) this.thickness = params.thickness;
    if (params.blendSmoothness !== undefined) this.blendSmoothness = params.blendSmoothness;
    if (params.color !== undefined) this.color = params.color;
    
    // Reinitialize the arc with updated parameters
    this._initializeArc();
    
    logger.info(`Updated ArcPrimitive ${this.id} with new parameters`);
    return this;
  }
  clone() {
    const copy = new ArcPrimitive(this._params);
    copy.blendSmoothness = this.blendSmoothness;
    copy.color           = { ...this.color };
    return copy;
  }  
}

/**
 * Factory function to create derivative primitives
 * @param {string} type - Type of primitive to create ('triangle' or 'arc')
 * @param {Object} params - Parameters for the primitive
 * @returns {DerivativePrimitive} The created primitive
 */
export function createDerivativePrimitive(type, params = {}) {
  switch (type.toLowerCase()) {
    case 'triangle':
      return new TrianglePrimitive(params);
    case 'arc':
      return new ArcPrimitive(params);
    default:
      logger.warn(`Unknown derivative primitive type: ${type}. Defaulting to triangle.`);
      return new TrianglePrimitive(params);
  }
}

// Export all derivative primitive classes and factory function
export default {
  DerivativePrimitive,
  TrianglePrimitive,
  ArcPrimitive,
  createDerivativePrimitive
};
