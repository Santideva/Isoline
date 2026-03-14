// File: src/utils/SDFBlending.js

/**
 * Module for smooth blending of Signed Distance Functions (SDFs).
 * Provides methods for R-function based blending and velocity field evolution.
 */

/**
 * Computes a smooth union of two SDF values using a weighted R-function.
 * @param {number} sdf1 - First SDF value.
 * @param {number} sdf2 - Second SDF value.
 * @param {number} p - Smoothness parameter (higher = smoother blend).
 * @returns {number} - The smoothly blended SDF value.
 */
export function weightedRUnion(sdf1, sdf2, p = 8) {
    if (p <= 0) return Math.min(sdf1, sdf2); // Fallback to regular min
    return sdf1 + sdf2 - Math.pow(Math.pow(Math.abs(sdf1), p) + Math.pow(Math.abs(sdf2), p), 1/p);
  }
  
  /**
   * Computes a smooth intersection of two SDF values using a weighted R-function.
   * @param {number} sdf1 - First SDF value.
   * @param {number} sdf2 - Second SDF value.
   * @param {number} p - Smoothness parameter (higher = smoother blend).
   * @returns {number} - The smoothly blended SDF value.
   */
  export function weightedRIntersection(sdf1, sdf2, p = 8) {
    if (p <= 0) return Math.max(sdf1, sdf2); // Fallback to regular max
    return sdf1 + sdf2 + Math.pow(Math.pow(Math.abs(sdf1), p) + Math.pow(Math.abs(sdf2), p), 1/p);
  }
  
  /**
   * Computes a smooth subtraction of two SDF values.
   * @param {number} sdf1 - Base SDF value.
   * @param {number} sdf2 - SDF value to subtract.
   * @param {number} p - Smoothness parameter.
   * @returns {number} - The smoothly subtracted SDF value.
   */
  export function weightedRDifference(sdf1, sdf2, p = 8) {
    return weightedRIntersection(sdf1, -sdf2, p);
  }
  
  /**
   * Computes the gradient of an SDF at a point using central differences.
   * @param {Function} sdfFunc - Function that computes the SDF value at a point.
   * @param {Object} point - The point {x, y} where to compute the gradient.
   * @param {number} epsilon - Step size for numerical differentiation.
   * @returns {Object} - The gradient vector {x, y}.
   */
  export function computeGradient(sdfFunc, point, epsilon = 0.001) {
    const center = sdfFunc(point);
    const dx = (sdfFunc({x: point.x + epsilon, y: point.y}) - 
               sdfFunc({x: point.x - epsilon, y: point.y})) / (2 * epsilon);
    const dy = (sdfFunc({x: point.x, y: point.y + epsilon}) - 
               sdfFunc({x: point.x, y: point.y - epsilon})) / (2 * epsilon);
    
    return { x: dx, y: dy };
  }
  
  /**
   * Computes the mean curvature of an SDF at a point.
   * @param {Function} sdfFunc - Function that computes the SDF value at a point.
   * @param {Object} point - The point {x, y} to compute the curvature at.
   * @param {number} epsilon - Step size for numerical differentiation.
   * @returns {number} - The mean curvature.
   */
  export function computeCurvature(sdfFunc, point, epsilon = 0.001) {
    // Compute second derivatives
    const f = sdfFunc(point);
    
    // First derivatives
    const fx = (sdfFunc({x: point.x + epsilon, y: point.y}) - 
               sdfFunc({x: point.x - epsilon, y: point.y})) / (2 * epsilon);
    const fy = (sdfFunc({x: point.x, y: point.y + epsilon}) - 
               sdfFunc({x: point.x, y: point.y - epsilon})) / (2 * epsilon);
    
    // Second derivatives
    const fxx = (sdfFunc({x: point.x + epsilon, y: point.y}) - 
                2 * f + 
                sdfFunc({x: point.x - epsilon, y: point.y})) / (epsilon * epsilon);
    
    const fyy = (sdfFunc({x: point.x, y: point.y + epsilon}) - 
                2 * f + 
                sdfFunc({x: point.x, y: point.y - epsilon})) / (epsilon * epsilon);
    
    const fxy = (sdfFunc({x: point.x + epsilon, y: point.y + epsilon}) - 
                sdfFunc({x: point.x + epsilon, y: point.y - epsilon}) - 
                sdfFunc({x: point.x - epsilon, y: point.y + epsilon}) + 
                sdfFunc({x: point.x - epsilon, y: point.y - epsilon})) / (4 * epsilon * epsilon);
    
    // Compute mean curvature (div(∇f/|∇f|))
    const gradMagnitudeSq = fx * fx + fy * fy;
    if (gradMagnitudeSq < 1e-10) return 0;
    
    const gradMagnitude = Math.sqrt(gradMagnitudeSq);
    const term1 = (fxx * (fy * fy) - 2 * fxy * fx * fy + fyy * (fx * fx)) / (gradMagnitudeSq * gradMagnitude);
    
    return term1;
  }
  
  /**
   * Computes the velocity field for SDF evolution based on the target blended SDF.
   * @param {number} currentSDF - Current SDF value at a point.
   * @param {number} targetSDF - Target (blended) SDF value.
   * @param {Object} gradient - Gradient vector {x, y} of the current SDF.
   * @param {number} alpha - Speed factor for the evolution.
   * @param {number} curvature - Optional curvature value for curvature-aware evolution.
   * @returns {Object} - The velocity vector {x, y}.
   */
  export function computeVelocity(currentSDF, targetSDF, gradient, alpha = 0.5, curvature = null) {
    // Direction of evolution: if current > target, we need to decrease, and vice versa
    const diff = currentSDF - targetSDF;
    
    // Normalize the gradient
    const gradMagnitude = Math.sqrt(gradient.x * gradient.x + gradient.y * gradient.y);
    if (gradMagnitude < 1e-10) return { x: 0, y: 0 };
    
    const normGrad = {
      x: gradient.x / gradMagnitude,
      y: gradient.y / gradMagnitude
    };
    
    // Apply curvature-aware modulation if provided
    let speed = alpha * diff;
    if (curvature !== null) {
      // Scale with curvature - areas with high curvature evolve slower
      const curvatureWeight = 1 / (1 + Math.abs(curvature));
      speed *= curvatureWeight;
    }
    
    // Return velocity vector (scaled normal)
    return {
      x: -speed * normGrad.x,
      y: -speed * normGrad.y
    };
  }
  
  /**
   * Updates an SDF grid using velocity field evolution.
   * @param {Array<Array<number>>} sdfGrid - 2D grid of current SDF values.
   * @param {Array<Array<number>>} targetGrid - 2D grid of target (blended) SDF values.
   * @param {number} deltaTime - Time step for the evolution.
   * @param {number} alpha - Speed factor.
   * @param {boolean} useCurvature - Whether to use curvature-aware evolution.
   * @returns {Array<Array<number>>} - The updated SDF grid.
   */
  export function updateSDF(sdfGrid, targetGrid, deltaTime = 0.1, alpha = 0.5, useCurvature = false) {
    const rows = sdfGrid.length;
    const cols = sdfGrid[0].length;
    const newGrid = Array(rows).fill().map(() => Array(cols).fill(0));
    
    // Helper function to get SDF value at grid position
    const getSDF = (grid, i, j) => {
      if (i < 0) i = 0;
      if (j < 0) j = 0;
      if (i >= rows) i = rows - 1;
      if (j >= cols) j = cols - 1;
      return grid[i][j];
    };
    
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const currentSDF = sdfGrid[i][j];
        const targetSDF = targetGrid[i][j];
        
        // Compute gradient using central differences
        const gradient = {
          x: (getSDF(sdfGrid, i, j+1) - getSDF(sdfGrid, i, j-1)) / 2,
          y: (getSDF(sdfGrid, i+1, j) - getSDF(sdfGrid, i-1, j)) / 2
        };
        
        // Compute curvature if needed
        let curvature = null;
        if (useCurvature) {
          const fxx = getSDF(sdfGrid, i, j+1) - 2*currentSDF + getSDF(sdfGrid, i, j-1);
          const fyy = getSDF(sdfGrid, i+1, j) - 2*currentSDF + getSDF(sdfGrid, i-1, j);
          const fxy = (getSDF(sdfGrid, i+1, j+1) - getSDF(sdfGrid, i+1, j-1) - 
                      getSDF(sdfGrid, i-1, j+1) + getSDF(sdfGrid, i-1, j-1)) / 4;
          
          const gradMagnitudeSq = gradient.x * gradient.x + gradient.y * gradient.y;
          if (gradMagnitudeSq > 1e-10) {
            const gradMagnitude = Math.sqrt(gradMagnitudeSq);
            curvature = (fxx * (gradient.y * gradient.y) - 2 * fxy * gradient.x * gradient.y + 
                        fyy * (gradient.x * gradient.x)) / (gradMagnitudeSq * gradMagnitude);
          }
        }
        
        // Compute velocity
        const velocity = computeVelocity(currentSDF, targetSDF, gradient, alpha, curvature);
        
        // Update SDF using Euler integration
        const gradMagnitude = Math.sqrt(gradient.x * gradient.x + gradient.y * gradient.y);
        newGrid[i][j] = currentSDF - deltaTime * (velocity.x * gradient.x + velocity.y * gradient.y);
      }
    }
    
    return newGrid;
  }
  
  /**
   * Creates a blended SDF function from multiple primitive SDFs.
   * @param {Array<Function>} sdfFuncs - Array of SDF functions to blend.
   * @param {number} p - Smoothness parameter for R-function.
   * @returns {Function} - The blended SDF function.
   */
  export function blendMultipleSDFs(sdfFuncs, p = 8) {
    return function(point) {
      if (sdfFuncs.length === 0) return Infinity;
      if (sdfFuncs.length === 1) return sdfFuncs[0](point);
      
      let result = sdfFuncs[0](point);
      for (let i = 1; i < sdfFuncs.length; i++) {
        result = weightedRUnion(result, sdfFuncs[i](point), p);
      }
      return result;
    };
  }
  
  /**
   * Creates a composite SDF from a list of ComplexPrimitive2D instances.
   * @param {Array<ComplexPrimitive2D>} primitives - Array of primitive objects.
   * @param {number} p - Smoothness parameter.
   * @param {string} operation - Type of operation: 'union', 'intersection', or 'difference'.
   * @returns {Function} - A function that computes the composite SDF at any point.
   */
  export function createCompositeSDF(primitives, p = 8, operation = 'union') {
    // Select the appropriate R-function based on the operation
    let combineFunc;
    switch (operation.toLowerCase()) {
      case 'intersection':
        combineFunc = weightedRIntersection;
        break;
      case 'difference':
        combineFunc = weightedRDifference;
        break;
      case 'union':
      default:
        combineFunc = weightedRUnion;
        break;
    }
    
    // Return a function that computes the composite SDF
    return function(point) {
      if (primitives.length === 0) return Infinity;
      if (primitives.length === 1) return primitives[0].computeSDF(point);
      
      let result = primitives[0].computeSDF(point);
      for (let i = 1; i < primitives.length; i++) {
        // For difference operation, only the first primitive is the base
        if (operation.toLowerCase() === 'difference' && i > 1) {
          const nextSDF = primitives[i].computeSDF(point);
          result = combineFunc(result, nextSDF, p);
        } else if (operation.toLowerCase() !== 'difference') {
          const nextSDF = primitives[i].computeSDF(point);
          result = combineFunc(result, nextSDF, p);
        }
      }
      return result;
    };
  }
  
  /**
   * A factory function to create a ComplexPrimitive2D that represents a composite of multiple primitives.
   * This integrates with the existing system without modifying its structure.
   * @param {Array<ComplexPrimitive2D>} primitives - Array of primitive objects.
   * @param {Object} params - Additional parameters including blend settings.
   * @returns {Object} - A ComplexPrimitive2D-compatible object that represents the composite.
   */
  export function createBlendedPrimitive(primitives, params = {}) {
    const blendParams = {
      smoothness: params.smoothness || 8,
      operation: params.operation || 'union',
      evolutionSteps: params.evolutionSteps || 0,
      deltaTime: params.deltaTime || 0.1,
      alpha: params.alpha || 0.5,
      useCurvature: params.useCurvature || false
    };
    
    // Create the composite SDF function
    const compositeSDF = createCompositeSDF(primitives, blendParams.smoothness, blendParams.operation);
    
    // Get color properties from the first primitive or use provided color
    const color = params.color || (primitives.length > 0 ? primitives[0].color : { h: 0, s: 1, l: 0.5, a: 1 });
    
    // Create a primitive-like object that conforms to ComplexPrimitive2D interface
    return {
      metric: {
        center: params.center || { x: 0, y: 0 },
        scale: params.scale || 1
      },
      color: color,
      distanceMapper: params.distanceMapper || primitives[0]?.distanceMapper || ((d) => d),
      
      // Implement the ComplexPrimitive2D interface methods
      getRawDistance: function(point) {
        // For composite primitives, raw distance is less meaningful,
        // but we'll approximate it as the distance to the "average" center
        let avgX = 0, avgY = 0;
        primitives.forEach(p => {
          avgX += p.metric.center.x;
          avgY += p.metric.center.y;
        });
        avgX /= primitives.length;
        avgY /= primitives.length;
        
        const dx = point.x - avgX;
        const dy = point.y - avgY;
        return Math.sqrt(dx * dx + dy * dy);
      },
      
      getMetricDistance: function(point) {
        return this.distanceMapper(this.getRawDistance(point));
      },
      
      computeSDF: function(point) {
        return compositeSDF(point);
      },
      
      getColor: function(sdfValue) {
        const intensity = Math.exp(-Math.abs(sdfValue));
        return {
          h: this.color.h,
          s: this.color.s,
          l: this.color.l * intensity,
          a: this.color.a * intensity,
        };
      },
      
      transform: function(matrix) {
        // Transform each primitive individually
        primitives.forEach(p => p.transform(matrix));
        
        // Update the center of this composite primitive
        if (this.metric.center) {
          const { x, y } = this.metric.center;
          const newX = matrix.a * x + matrix.b * y + (matrix.tx || 0);
          const newY = matrix.c * x + matrix.d * y + (matrix.ty || 0);
          this.metric.center = { x: newX, y: newY };
        }
        
        // Adjust the scale if the matrix includes uniform scaling
        this.metric.scale *= Math.sqrt((matrix.a ** 2 + matrix.d ** 2) / 2);
      }
    };
  }