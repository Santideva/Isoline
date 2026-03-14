// File: src/primitives/ComplexShape2D.js
import { Vertex } from "./Vertex.js";
import { Edge } from "./Edge.js";
import { ComplexPrimitive2D } from "../Primitives/ComplexPrimitive2d.js";
import { 
  createCompositeSDF, 
  weightedRUnion, 
  weightedRIntersection, 
  weightedRDifference 
} from "../utils/SDFBlending.js";
import { logger } from "../utils/logger.js";
import * as THREE from "three";

let shapeCounter = 0;
export function nextId() { return ++shapeCounter; }

export class ComplexShape2D extends ComplexPrimitive2D {
  constructor(params = {}) {
    super(params);
    this.id = nextId();
    this.primitiveType = 'line';

    // Initialize vertices
    this.vertices = params.vertices || [
      new Vertex({ position: { x: 0, y: 0 }, color: this.color }),
      new Vertex({ position: { x: 1, y: 0 }, color: this.color })
    ];

    // Initialize edge
    this.edges = params.edges || [
      new Edge(this.vertices[0], this.vertices[1], this.distanceMapper)
    ];

    this.face = null;

    // Initialize blend parameters
    this.blendParams = {
      smoothness: params.smoothness || 8,
      operation: params.operation || 'union',
      primitives: (params.primitives || []).filter(p => p !== this),
      basePrimitive: params.basePrimitive || null
    };

    this.updateCompositeSDF();

    // Log creation
    logger.info(`Created ComplexShape2D with id: ${this.id} as a line-segment primitive`);
    this._logVertexPositions('Initial');
  }

  /**
   * Return a brand-new clone of this ComplexShape2D with identical parameters
   */
  clone() {
    return new ComplexShape2D(this._params);
  }
  
  // Helper method to log vertex positions
  _logVertexPositions(prefix) {
    logger.debug(`${prefix} Vertex Positions: Vertex A: (${this.vertices[0].position.x}, ${this.vertices[0].position.y}), Vertex B: (${this.vertices[1].position.x}, ${this.vertices[1].position.y})`);
  }

  calculateBaseSDF(point, time = 0, depth = 0) {
    return this.edges.length > 0 ? this.distanceToEdge(this.edges[0], point, time, depth) : Infinity;
  }

  distanceToEdge(edge, point, time = 0, depth = 0) {
    const { x: x1, y: y1 } = edge.vertexA.position;
    const { x: x2, y: y2 } = edge.vertexB.position;
    const { x, y } = point;

    // Vector from edge start to point
    const dx = x - x1;
    const dy = y - y1;

    // Edge vector
    const edgeX = x2 - x1;
    const edgeY = y2 - y1;

    // Square of edge length
    const edgeLengthSquared = edgeX * edgeX + edgeY * edgeY;

    // If edge is effectively a point, return distance to that point
    if (edgeLengthSquared === 0) {
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Project point onto edge line, clamped to [0,1]
    const t = Math.max(0, Math.min(1, (dx * edgeX + dy * edgeY) / edgeLengthSquared));

    // Closest point on edge
    const closestX = x1 + t * edgeX;
    const closestY = y1 + t * edgeY;

    // Distance to closest point
    return Math.sqrt((x - closestX) ** 2 + (y - closestY) ** 2);
  }

  updateCompositeSDF() {
    const primitives = (this.blendParams.primitives || []).filter(p => p !== this);
    const { operation, smoothness, basePrimitive } = this.blendParams;

    logger.debug(`Updating composite SDF for shape ${this.id}. Blending operation: ${operation}, Smoothness: ${smoothness}`);
    
    if (primitives.length === 0) {
      this.compositeSDF = null;
      logger.debug(`No additional primitives. Composite SDF for shape ${this.id} is set to null.`);
      return;
    }

    const op = operation.toLowerCase();
    
    if (op === 'difference') {
      if (basePrimitive) {
        const orderedPrimitives = [
          basePrimitive,
          ...primitives.filter(p => p !== basePrimitive)
        ];
        this.compositeSDF = createCompositeSDF(orderedPrimitives, smoothness, 'difference');
      } else {
        this.compositeSDF = createCompositeSDF(primitives, smoothness, 'difference');
      }
    } else {
      if (op !== 'union' && op !== 'intersection') {
        console.warn(`Invalid blending operation: "${op}". Defaulting to "union".`);
      }
      this.compositeSDF = createCompositeSDF(
        primitives,
        smoothness,
        op === 'intersection' ? 'intersection' : 'union'
      );
    }
    
    logger.debug(`Composite SDF updated for shape ${this.id}.`);
  }

  computeSDF(point, callStack = [], time = 0, depth = 0) {
    // Prevent infinite recursion
    if (callStack.includes(this.id)) {
      console.warn(`Detected recursive SDF calculation for shape ${this.id}`);
      return this.calculateBaseSDF(point, time, depth);
    }

    const newCallStack = [...callStack, this.id];
    const baseSDF = this.calculateBaseSDF(point, time, depth);

    // If no blending primitives, return base SDF
    if (!this.blendParams.primitives?.length) {
      return baseSDF;
    }

    if (!this.compositeSDF) {
      console.warn("Composite SDF not initialized. Returning base SDF.");
      return baseSDF;
    }

    const compositeSdfValue = this.getCompositeSdfValue(point, newCallStack, time, depth);
    const op = this.blendParams.operation.toLowerCase();
    const smoothness = this.blendParams.smoothness;

    // Apply appropriate blending operation
    if (op === 'union') {
      return weightedRUnion(baseSDF, compositeSdfValue, smoothness);
    } else if (op === 'intersection') {
      return weightedRIntersection(baseSDF, compositeSdfValue, smoothness);
    } else if (op === 'difference') {
      return this.blendParams.basePrimitive ? 
        compositeSdfValue : 
        weightedRDifference(baseSDF, compositeSdfValue, smoothness);
    }
    
    return baseSDF;
  }

  getCompositeSdfValue(point, callStack = [], time = 0, depth = 0) {
    try {
      if (typeof this.compositeSDF !== 'function') return Infinity;
      
      const primitives = this.blendParams.primitives.filter(p => p !== this);
      
      if (primitives.length === 0) return Infinity;
      
      if (primitives.length === 1) {
        return primitives[0].computeSDF ? 
          primitives[0].computeSDF(point, callStack, time, depth) : 
          primitives[0].computeSDF(point, callStack);
      }
      
      // Need to adapt the compositeSDF call to include time and depth
      // This is a simplification since we don't have the full implementation of createCompositeSDF
      return this.compositeSDF(point, time, depth);
    } catch (error) {
      console.error(`Error computing composite SDF: ${error}`);
      return Infinity;
    }
  }

  createLineObject(time = 0) {
    logger.debug(`Creating line object for shape ${this.id} at time: ${time}`);
    
    // Create base points from vertices
    const basePoints = [
      new THREE.Vector3(this.vertices[0].position.x, this.vertices[0].position.y, 0),
      new THREE.Vector3(this.vertices[1].position.x, this.vertices[1].position.y, 0)
    ];
    
    const points = [];
    
    // Visualize distance mapping effect if applicable
    if (this.distanceMapper && typeof this.distanceMapper === 'function') {
      const numIntermediatePoints = 20;
      
      // Calculate edge direction and normal once
      const edgeX = this.vertices[1].position.x - this.vertices[0].position.x;
      const edgeY = this.vertices[1].position.y - this.vertices[0].position.y;
      
      const normal = {
        x: -edgeY,
        y: edgeX
      };
      
      // Normalize the normal
      const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y);
      if (length > 0) {
        normal.x /= length;
        normal.y /= length;
      }
      
      // Apply distance mapper visualization with time parameter
      const originalDistance = 0;
      const mappedDistance = this.distanceMapper(originalDistance, time, 0);
      const displacement = mappedDistance - originalDistance;
      const scaleFactor = 0.1;
      
      for (let i = 0; i <= numIntermediatePoints; i++) {
        const t = i / numIntermediatePoints;
        const x = this.vertices[0].position.x + t * edgeX;
        const y = this.vertices[0].position.y + t * edgeY;
        
        const visualX = x + normal.x * displacement * scaleFactor;
        const visualY = y + normal.y * displacement * scaleFactor;
        
        points.push(new THREE.Vector3(visualX, visualY, 0));
      }
    } else {
      // Use base points if no special visualization needed
      points.push(...basePoints);
    }
    
    // Create geometry and material
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    
    // Create color
    const color = new THREE.Color();
    if (this.color && typeof this.color.h !== 'undefined') {
      const h = this.color.h / 360;
      const s = typeof this.color.s === 'number' ? this.color.s : 0.8;
      const l = typeof this.color.l === 'number' ? this.color.l : 0.6;
      color.setHSL(h, s, l);
    } else {
      color.set(0x0000ff);
    }
    
    const lineMaterial = new THREE.LineBasicMaterial({ color });
    
    logger.debug(`Line object created for shape ${this.id} with ${points.length} points at time: ${time}`);
    return new THREE.Line(geometry, lineMaterial);
  }

  addBlendPrimitive(primitive, operation = null) {
    if (!this.blendParams.primitives) {
      this.blendParams.primitives = [];
    }
    
    if (primitive !== this) {
      this.blendParams.primitives.push(primitive);
    } else {
      console.warn("Attempted to add self-reference to blend primitives. Ignoring.");
    }
    
    if (operation) {
      this.blendParams.operation = operation;
    }
    
    this.updateCompositeSDF();
    return this;
  }

  setBlendParams(params = {}) {
    const replacer = (key, value) => {
      if (key === "primitives") return undefined;
      return value;
    };

    const oldParams = JSON.stringify(this.blendParams, replacer);
    
    this.blendParams = {
      ...this.blendParams,
      ...params
    };
    
    if (this.blendParams.primitives) {
      this.blendParams.primitives = this.blendParams.primitives.filter(p => p !== this);
    }
    
    if (oldParams !== JSON.stringify(this.blendParams, replacer)) {
      this.updateCompositeSDF();
    }
    
    return this;
  }

  setBasePrimitive(primitive) {
    if (primitive === this) {
      console.warn("Cannot set self as base primitive. Ignoring.");
      return this;
    }
    
    this.blendParams.basePrimitive = primitive;
    
    if (this.blendParams.operation.toLowerCase() === 'difference') {
      this.updateCompositeSDF();
    }
    
    return this;
  }

  clearBlendPrimitives() {
    this.blendParams.primitives = [];
    this.updateCompositeSDF();
    return this;
  }

  transform(matrix) {
    // Log pre-transformation vertex positions
    this._logVertexPositions('Before Transform');
    
    super.transform(matrix);
    
    // Transform vertices
    for (const vertex of this.vertices) {
      if (vertex.transform) {
        vertex.transform(matrix);
      }
    }
    
    // Log post-transformation vertex positions
    this._logVertexPositions('After Transform');
    
    this.updateCompositeSDF();
    return this;
  }

  /**
   * Static method for serializing a ComplexShape2D instance.
   * Extracts properties necessary to reconstruct the shape.
   * @param {ComplexShape2D} instance - The ComplexShape2D instance to serialize.
   * @returns {Object} An object containing serializable properties.
   */
  static getSerializableParameters(instance) {
    const params = {};
    
    // Extract vertices: for each vertex, store its position and color.
    if (instance.vertices && Array.isArray(instance.vertices)) {
      params.vertices = instance.vertices.map(v => ({
        position: { x: v.position.x, y: v.position.y },
        color: v.color
      }));
    }
    
    // Include metric if it exists
    if (instance.metric !== undefined) {
      params.metric = { ...instance.metric };
    }
    
    // Include blend parameters and store references to blended primitives
    if (instance.blendParams !== undefined) {
      params.blendParams = { ...instance.blendParams };
      if (instance.blendParams.primitives && Array.isArray(instance.blendParams.primitives)) {
        params.blendParams.primitiveRefs = instance.blendParams.primitives.map(p => p.id);
      }
    }
    
    // Include primitive type (e.g., 'line')
    params.primitiveType = instance.primitiveType;
    
    // Include the constructor name for debugging
    params._shapeClass = instance.constructor ? instance.constructor.name : null;
    
    return params;
  }
}
