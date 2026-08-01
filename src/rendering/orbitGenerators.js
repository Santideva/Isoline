// src/rendering/orbitGenerators.js
//
// Pluggable camera-orbit path generators. Each generate(t, params, ...)
// returns { theta, phi } — spherical angles (theta = azimuth around Y,
// phi = polar angle from the +Y axis, phi=0 is straight up) describing a
// direction on the unit sphere. The driver (SceneManager) converts this
// to a world-space camera position via the scene's bounding-sphere
// framing distance — see SceneManager.frameAll()/_updateOrbit().
//
// t is a continuously-increasing time value in seconds (NOT looped to
// [0,1]) so generators can freely use it for both fast rotation and slow
// drift without needing to know a "loop duration".

export function sphericalToDir(theta, phi) {
  return {
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta),
  };
}

export function dirToSpherical(dir) {
  const len = Math.sqrt(dir.x*dir.x + dir.y*dir.y + dir.z*dir.z) || 1;
  const y = dir.y / len;
  const phi = Math.acos(Math.max(-1, Math.min(1, y)));
  const theta = Math.atan2(dir.z, dir.x);
  return { theta, phi };
}

export const OrbitGenerators = {
  circular: {
    label: 'Circular',
    generate(t, params) {
      const speed = params.speed ?? 1;
      const tilt  = params.tilt ?? 1.0; // radians from top; ~1.0 ≈ a comfortable 3/4 elevation
      return { theta: t * speed, phi: tilt };
    },
  },

  spiral: {
    label: 'Spiral',
    generate(t, params) {
      const speed = params.speed ?? 1;
      // phi oscillates slowly between near-top and near-bottom while
      // theta keeps advancing — traces a spiral band around the sphere
      // rather than a single fixed-latitude ring.
      const phi   = Math.PI * (0.5 - 0.42 * Math.sin(t * speed * 0.5));
      const theta = t * speed * 1.3;
      return { theta, phi };
    },
  },

  lissajous: {
    label: 'Lissajous',
    generate(t, params) {
      const speed = params.speed ?? 1;
      const freqA = params.freqA ?? 1.0;
      const freqB = params.freqB ?? 1.5;
      const theta = t * speed * freqA;
      const phi   = Math.PI * 0.5 + (Math.PI * 0.35) * Math.sin(t * speed * freqB);
      return { theta, phi };
    },
  },

  /**
   * V1 ("Option A" from planning): a base spiral orbit continuously
   * biased toward nearby high-curvature (interesting) directions found
   * in the pre-sampled interestMap — a smooth "drift toward detail"
   * rather than a deliberate visit-each-hotspot path. V2 (spline-fit
   * through local curvature maxima) is explicitly deferred.
   */
  curvatureGuided: {
    label: 'Curvature-Guided',
    generate(t, params, interestMap) {
      const base = OrbitGenerators.spiral.generate(t, params);
      if (!interestMap || interestMap.length === 0) return base;

      const baseDir = sphericalToDir(base.theta, base.phi);
      let pull = { x: 0, y: 0, z: 0 };
      let totalWeight = 0;

      interestMap.forEach(sample => {
        const dot = baseDir.x*sample.dir.x + baseDir.y*sample.dir.y + baseDir.z*sample.dir.z;
        const closeness = Math.max(0, dot); // only pulled toward directions roughly ahead
        const weight = sample.score * closeness;
        pull.x += sample.dir.x * weight;
        pull.y += sample.dir.y * weight;
        pull.z += sample.dir.z * weight;
        totalWeight += weight;
      });

      if (totalWeight < 1e-6) return base;
      pull.x /= totalWeight; pull.y /= totalWeight; pull.z /= totalWeight;

      const strength = params.curvatureStrength ?? 0.35;
      const blended = {
        x: baseDir.x * (1 - strength) + pull.x * strength,
        y: baseDir.y * (1 - strength) + pull.y * strength,
        z: baseDir.z * (1 - strength) + pull.z * strength,
      };
      return dirToSpherical(blended);
    },
  },
};