// File: src/utils/DistanceMapping.js

/**
 * Identity mapping: returns the raw distance unchanged.
 * @param {number} d - Raw distance.
 * @returns {number}
 */
export const identityMapping = d => d;

/**
 * Creates a polynomial mapping function based on provided coefficients.
 * For a polynomial f(d) = c0 + c1*d + c2*d^2 + ...
 * @param {number[]} polyCoeffs - Array of coefficients.
 * @returns {Function} A function that maps a raw distance.
 */
export function createPolynomialMapping(polyCoeffs, band = Infinity) {
  return function(d, t = 0, depth = 0) {
    // Windowed/additive — mirrors createSinusoidalMapping's fix (see that
    // function's comment for the full derivation). Confining the
    // polynomial's DEVIATION FROM IDENTITY (raw - d) to a compact band
    // around d=0 guarantees f(d) === d exactly outside that band,
    // regardless of how extreme c2/c3 are — eliminating both unbounded
    // growth AND the sign-flip risk described above.
    //
    // band = Infinity (default) reproduces the ORIGINAL unwindowed
    // behaviour exactly (the window is always 1 for any finite d) — this
    // preserves every existing non-node caller unchanged (e.g. the legacy
    // "line" shape's polyCoeffs effect, TrianglePrimitive's corner-
    // rounding path). Only polynomialMapper NODES pass an explicit finite
    // band (see NodeEvaluator.js / GLSLEvaluator.js), where the risk of
    // an unbounded/sign-flipping polynomial actually applies (3D solids
    // + ray march).
    const raw = polyCoeffs.reduce((acc, coeff, i) => acc + coeff * Math.pow(d, i), 0);
    if (!isFinite(band)) return raw;
    const perturbation = raw - d;
    const ad = Math.abs(d);
    const safeBand = Math.max(band, 1e-4);
    if (ad >= safeBand) return d;
    const x = ad / safeBand;
    const w = 1 - x * x * (3 - 2 * x);
    return d + w * perturbation;
  };
}

/**
 * Creates an exponential mapping function.
 * f(d) = a * exp(b * d) + c
 * @param {number} a - Scaling factor.
 * @param {number} b - Exponent factor.
 * @param {number} c - Offset.
 * @returns {Function} A function that maps a raw distance.
 */
export function createExponentialMapping(a = 1, b = 1, c = 0) {
  return function(d, t = 0, depth = 0) {
    return a * Math.exp(b * d) + c;
  };
}

/**
 * Creates a logarithmic mapping function.
 * f(d) = a * log(b * d + c) + e
 * Prevents log(0) by ensuring argument is positive.
 * @param {number} a - Scaling factor.
 * @param {number} b - Internal scaling.
 * @param {number} c - Prevents log(0) for d=0.
 * @param {number} e - Offset.
 * @returns {Function} A function that maps a raw distance.
 */
export function createLogarithmicMapping(a = 1, b = 1, c = 1, e = 0) {
  return function(d, t = 0, depth = 0) {
    const arg = b * d + c;
    return arg > 0 ? a * Math.log(arg) + e : e;
  };
}

/**
 * Creates a sinusoidal mapping function.
 * f(d) = a * sin(b * d + c) + e
 * @param {number} a - Amplitude.
 * @param {number} b - Frequency.
 * @param {number} c - Phase shift.
 * @param {number} e - Vertical shift.
 * @returns {Function} A function that maps a raw distance.
 */
export function createSinusoidalMapping(a = 1, b = 1, c = 0, e = 0, band = Infinity) {
  return function(d, t = 0, depth = 0) {
    // Windowed/additive, NOT a full replacement of d. A plain
    // a*sin(b*d+c)+e REPLACEMENT has infinitely many zero-crossings,
    // spaced 2*pi/b apart, at ALL distances — including far from the
    // true surface. Applied to a 3D solid, ray marching correctly finds
    // whichever crossing is nearest, which is very often NOT the true
    // surface but a spurious "shell" floating some distance away —
    // visually a giant, wrong blob, or (if that shell recedes past the
    // renderer's max distance as an animated phase shifts) nothing at
    // all. Confining the perturbation to a compact band around d=0
    // guarantees f(d) === d exactly outside that band, so no spurious
    // crossing can ever exist there.
    const ad = Math.abs(d);
    const safeBand = Math.max(band, 1e-4);
    if (ad >= safeBand) return d;
    const x = ad / safeBand;
    const smooth = x * x * (3 - 2 * x); // smoothstep(0,1,x)
    const w = 1 - smooth;
    const perturb = a * Math.sin(b * d + c) + e;
    return d + w * perturb;
  };
}

/**
 * Creates a power mapping function.
 * f(d) = a * d^b + c
 * @param {number} a - Scaling factor.
 * @param {number} b - Power.
 * @param {number} c - Offset.
 * @returns {Function} A function that maps a raw distance.
 */
export function createPowerMapping(a = 1, b = 2, c = 0) {
  return function(d, t = 0, depth = 0) {
    // Signed power: preserves the sign of d, which for an SDF carries the
    // essential inside/outside meaning. The previous plain Math.pow(d, b)
    // silently destroyed that distinction for any even b (including the
    // default b=2) — Math.pow(-1, 2) === Math.pow(1, 2) === 1, mapping
    // "inside" and mirrored "outside" points to the identical value.
    const sign = d < 0 ? -1 : 1;
    return sign * a * Math.pow(Math.abs(d), b) + c;
  };
}

/**
 * Common easing functions for smooth transitions.
 */
export const easingFunctions = {
  // Quadratic easing
  easeInQuad: (d, t = 0, depth = 0) => d * d,
  easeOutQuad: (d, t = 0, depth = 0) => d * (2 - d),
  easeInOutQuad: (d, t = 0, depth = 0) => d < 0.5 ? 2 * d * d : -1 + (4 - 2 * d) * d,
  
  // Cubic easing
  easeInCubic: (d, t = 0, depth = 0) => d * d * d,
  easeOutCubic: (d, t = 0, depth = 0) => (--d) * d * d + 1,
  easeInOutCubic: (d, t = 0, depth = 0) => d < 0.5 ? 4 * d * d * d : (d - 1) * (2 * d - 2) * (2 * d - 2) + 1,
  
  // Elastic
  easeInElastic: (d, t = 0, depth = 0) => {
    const c4 = (2 * Math.PI) / 3;
    return d === 0 ? 0 : d === 1 ? 1 : -Math.pow(2, 10 * d - 10) * Math.sin((d * 10 - 10.75) * c4);
  },
  easeOutElastic: (d, t = 0, depth = 0) => {
    const c4 = (2 * Math.PI) / 3;
    return d === 0 ? 0 : d === 1 ? 1 : Math.pow(2, -10 * d) * Math.sin((d * 10 - 0.75) * c4) + 1;
  },
  
  // Bounce
  easeOutBounce: (d, t = 0, depth = 0) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    
    if (d < 1 / d1) {
      return n1 * d * d;
    } else if (d < 2 / d1) {
      return n1 * (d -= 1.5 / d1) * d + 0.75;
    } else if (d < 2.5 / d1) {
      return n1 * (d -= 2.25 / d1) * d + 0.9375;
    } else {
      return n1 * (d -= 2.625 / d1) * d + 0.984375;
    }
  }
};

/**
 * Creates a composite distance mapper by combining two mapping functions.
 * @param {Function} mapperA - First distance mapper.
 * @param {Function} mapperB - Second distance mapper.
 * @param {Function} combiner - Function that combines the two mapped distances.
 * @returns {Function} A composite mapping function.
 */
export function createCompositeMapping(mapperA, mapperB, combiner) {
  return function(d, t = 0, depth = 0) {
    const resultA = mapperA(d, t, depth);
    const resultB = mapperB(d, t, depth);
    return combiner(resultA, resultB, t);
  };
}

/**
 * Common combining functions for composite mappers.
 */
export const combiningFunctions = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => b !== 0 ? a / b : a,
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  average: (a, b) => (a + b) / 2,
  smoothMin: (a, b, k = 1) => {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * h * k * (1/6);
  },
  // New timed combiner that transitions between two values based on time
  lerp: (a, b, t) => (1 - t) * a + t * b
};

/**
 * Creates a periodic mapping function using mod operation.
 * @param {Function} baseMapper - Base distance mapper to apply periodically.
 * @param {number} period - The period length.
 * @returns {Function} A periodic mapping function.
 */
export function createPeriodicMapping(baseMapper, period = 1) {
  return function(d, t = 0, depth = 0) {
    return baseMapper(d % period, t, depth);
  };
}

/**
 * Creates a temporal mapping function that changes with time parameter.
 * @param {Function} baseMapper - Base distance mapper to apply.
 * @param {number} frequency - Frequency of temporal oscillation.
 * @param {number} amplitude - Amplitude of temporal effect.
 * @returns {Function} A time-varying mapping function.
 */
export function createTemporalMapping(baseMapper, frequency = 1, amplitude = 1) {
  return function(d, t = 0, depth = 0) {
    const timeFactor = Math.sin(t * frequency * 2 * Math.PI);
    const base = baseMapper(d, t, depth);
    const result = base * (1 + timeFactor * amplitude);

    // console.log(`[TemporalMapping] d=${d}, t=${t.toFixed(2)}, base=${base.toFixed(3)}, timeFactor=${timeFactor.toFixed(3)}, result=${result.toFixed(3)}`);

    return result;
  };
}


/**
 * Creates a recursive mapping function that applies the mapper to its own output.
 * @param {Function} baseMapper - Base distance mapper to apply recursively.
 * @param {number} iterations - Number of recursive iterations.
 * @param {number} strength - Strength factor to control recursive effect.
 * @returns {Function} A recursive mapping function.
 */
export function createRecursiveMapping(baseMapper, iterations = 2, strength = 0.5) {
  return function(d, t = 0, depth = 0) {
    let result = d;
    for (let i = 0; i < iterations; i++) {
      result = baseMapper(result, t, depth + 1) * strength + (1 - strength) * result;
    }
    return result;
  };
}

/**
 * Creates a sequential mapping function that cycles through an array of mappers.
 * @param {Function[]} mappers - Array of mapping functions to cycle through.
 * @param {number} frequency - Frequency of cycling (cycles per time unit).
 * @returns {Function} A sequential mapping function.
 */
export function createSequentialMapping(mappers, frequency = 1) {
  return function(d, t = 0, depth = 0) {
    const index = Math.floor((t * frequency) % mappers.length);
    return mappers[index](d, t, depth);
  };
}

/**
 * Creates a blended mapping function that interpolates between two mappers.
 * @param {Function} mapperA - First distance mapper.
 * @param {Function} mapperB - Second distance mapper.
 * @param {number|Function} blendFactor - Static blend factor or time-based function.
 * @returns {Function} A blended mapping function.
 */
export function createBlendedMapping(mapperA, mapperB, blendFactor = 0.5) {
  return function(d, t = 0, depth = 0) {
    const blend = typeof blendFactor === 'function' ? blendFactor(t) : blendFactor;
    const resultA = mapperA(d, t, depth);
    const resultB = mapperB(d, t, depth);
    return (1 - blend) * resultA + blend * resultB;
  };
}

/**
 * Dynamic mapping factory function that creates mappings based on type and options.
 * @param {string} mappingType - Type of mapping to create.
 * @param {Object} options - Configuration options for the mapping.
 * @returns {Function} A distance mapping function.
 */
export function createMapping(mappingType, options = {}) {
  const { 
    baseMapper, 
    baseMappers = [], 
    blendFactor = 0.5, 
    frequency = 1, 
    amplitude = 0.5,
    iterations = 2,
    strength = 0.5,
    polyCoeffs = [0, 1, 0],  // Default to linear
    a = 1, 
    b = 1, 
    c = 0, 
    e = 0,
    period = 1,
    combiner = combiningFunctions.add
  } = options;

  switch (mappingType.toLowerCase()) {
    case "identity":
      return identityMapping;
      
    case "polynomial":
      return createPolynomialMapping(polyCoeffs);
      
    case "exponential":
      return createExponentialMapping(a, b, c);
      
    case "logarithmic":
      return createLogarithmicMapping(a, b, c, e);
      
    case "sinusoidal":
      return createSinusoidalMapping(a, b, c, e);
      
    case "power":
      return createPowerMapping(a, b, c);
      
    case "composite":
      if (!baseMappers[0] || !baseMappers[1]) {
        console.warn("Missing mappers for composite mapping. Using identity.");
        return identityMapping;
      }
      return createCompositeMapping(baseMappers[0], baseMappers[1], combiner);
      
    case "periodic":
      if (!baseMapper) {
        console.warn("Missing base mapper for periodic mapping. Using identity.");
        return identityMapping;
      }
      return createPeriodicMapping(baseMapper, period);
      
    case "temporal":
      if (!baseMapper) {
        console.warn("Missing base mapper for temporal mapping. Using identity.");
        return identityMapping;
      }
      return createTemporalMapping(baseMapper, frequency, amplitude);
      
    case "recursive":
      if (!baseMapper) {
        console.warn("Missing base mapper for recursive mapping. Using identity.");
        return identityMapping;
      }
      return createRecursiveMapping(baseMapper, iterations, strength);
      
    case "sequential":
      if (baseMappers.length === 0) {
        console.warn("No mappers provided for sequential mapping. Using identity.");
        return identityMapping;
      }
      return createSequentialMapping(baseMappers, frequency);
      
    case "blended":
      if (!baseMappers[0] || !baseMappers[1]) {
        console.warn("Missing mappers for blended mapping. Using identity.");
        return identityMapping;
      }
      return createBlendedMapping(baseMappers[0], baseMappers[1], blendFactor);
      
    default:
      console.warn(`Unknown mapping type: ${mappingType}. Using identity mapping.`);
      return identityMapping;
  }
}

/**
 * Registry of available distance mapping functions.
 */
export const distanceMappingRegistry = {
  identity: identityMapping,
  polynomial: createPolynomialMapping([0, 1, 0]),  // Linear by default
  exponential: createExponentialMapping(),
  logarithmic: createLogarithmicMapping(),
  sinusoidal: createSinusoidalMapping(),
  power: createPowerMapping(),
  easeInQuad: easingFunctions.easeInQuad,
  easeOutQuad: easingFunctions.easeOutQuad,
  easeInOutQuad: easingFunctions.easeInOutQuad,
  easeInCubic: easingFunctions.easeInCubic,
  easeOutCubic: easingFunctions.easeOutCubic,
  easeInOutCubic: easingFunctions.easeInOutCubic,
  easeInElastic: easingFunctions.easeInElastic,
  easeOutElastic: easingFunctions.easeOutElastic,
  easeOutBounce: easingFunctions.easeOutBounce,
  
  // Add the dynamic mapping creator to the registry
  createMapping: createMapping
};