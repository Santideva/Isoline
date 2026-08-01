// File: src/utils/transform3D.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Shared 3D translate/pivot/rotate/scale math used by EVERY node's transform
// block (NodeEvaluator._applyNodeTransform, GLSLEvaluator per-node wrappers,
// SceneManager preview-mesh placement) as well as the output-level placement
// and transform3DNode's own compositional use.
//
// Forward model (local → world), matching Maya/Blender/Houdini convention —
// scale and rotate around the pivot, THEN translate:
//
//   world = position + pivot + R · scale · (local − pivot)
//
// Inverting for world → local (what SDF sampling needs):
//
//   local = pivot + (1/scale) · R⁻¹ · (world − position − pivot)
//
// Backward compatible: pivot defaults to (0,0,0) and scale to 1, which
// collapses this exactly to the pre-existing position+rotation-only behavior
// used everywhere before this change.
//
// IMPORTANT: applyInverseTransform3D transforms POINTS only. When scale != 1,
// the caller MUST also multiply the resulting distance by `scale` to keep
// the SDF a true distance field — see NodeEvaluator._applyNodeTransform and
// the GLSLEvaluator per-node wrapper for the canonical pattern.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a fresh identity transform object. Used as the default value for
 * every node's `transform` field in NodeGraph.addNode().
 */
export function createIdentityTransform() {
  return {
    posX: 0, posY: 0, posZ: 0,
    pivotX: 0, pivotY: 0, pivotZ: 0,
    rotateX: 0, rotateY: 0, rotateZ: 0,
    scale: 1,
  };
}

/**
 * Returns true if the given transform object is the identity transform
 * (no position, no pivot, no rotation, scale = 1). Used to skip wrapping
 * a node's SDF when there is nothing to apply.
 */
export function isIdentityTransform(t) {
  if (!t) return true;
  return (t.posX ?? 0) === 0 && (t.posY ?? 0) === 0 && (t.posZ ?? 0) === 0 &&
         (t.pivotX ?? 0) === 0 && (t.pivotY ?? 0) === 0 && (t.pivotZ ?? 0) === 0 &&
         (t.rotateX ?? 0) === 0 && (t.rotateY ?? 0) === 0 && (t.rotateZ ?? 0) === 0 &&
         (t.scale ?? 1) === 1;
}

/**
 * Apply the inverse translate + pivot + rotate + uniform-scale to a 3D point.
 *
 * @param {{x:number, y:number, z?:number}} pt
 * @param {object} t  {posX,posY,posZ, pivotX,pivotY,pivotZ,
 *                      rotateX,rotateY,rotateZ, scale}
 * @returns {{x:number, y:number, z:number}}
 */
export function applyInverseTransform3D(pt, t) {
  const posX = t.posX ?? 0, posY = t.posY ?? 0, posZ = t.posZ ?? 0;
  const pvX  = t.pivotX ?? 0, pvY = t.pivotY ?? 0, pvZ = t.pivotZ ?? 0;
  const rx = t.rotateX ?? 0, ry = t.rotateY ?? 0, rz = t.rotateZ ?? 0;
  const scale = t.scale ?? 1;
  const safeScale = Math.abs(scale) > 1e-9 ? scale : 1e-9;

  // Step 1 — subtract position AND pivot together
  let x = pt.x - posX - pvX;
  let y = pt.y - posY - pvY;
  let z = (pt.z || 0) - posZ - pvZ;

  // Step 2 — undo rotation: inverse Z, then inverse Y, then inverse X
  // (exact reverse order of the forward R = Rz·Ry·Rx composition)
  if (rz !== 0) {
    const c = Math.cos(-rz), s = Math.sin(-rz);
    const nx = x * c - y * s, ny = x * s + y * c;
    x = nx; y = ny;
  }
  if (ry !== 0) {
    const c = Math.cos(-ry), s = Math.sin(-ry);
    const nx =  x * c + z * s, nz = -x * s + z * c;
    x = nx; z = nz;
  }
  if (rx !== 0) {
    const c = Math.cos(-rx), s = Math.sin(-rx);
    const ny = y * c - z * s, nz = y * s + z * c;
    y = ny; z = nz;
  }

  // Step 3 — undo uniform scale
  x /= safeScale; y /= safeScale; z /= safeScale;

  // Step 4 — add pivot back
  return { x: x + pvX, y: y + pvY, z: z + pvZ };
}

/**
 * Forward transform: map a LOCAL point to its WORLD position, given a
 * node's transform. This is the direct (non-inverted) counterpart to
 * applyInverseTransform3D — used for visualization (e.g. the pivot gizmo's
 * connector line to the shape's local origin), never for SDF sampling
 * (SDF sampling always goes world→local via the inverse function).
 *
 * world = position + pivot + R·scale·(local − pivot)
 * Rotation order matches the inverse function's undo order in reverse:
 * apply rotateX first, then rotateY, then rotateZ.
 *
 * @param {{x:number,y:number,z?:number}} localPt
 * @param {object} t
 * @returns {{x:number,y:number,z:number}}
 */
export function applyForwardTransform3D(localPt, t) {
  const posX = t.posX ?? 0, posY = t.posY ?? 0, posZ = t.posZ ?? 0;
  const pvX  = t.pivotX ?? 0, pvY = t.pivotY ?? 0, pvZ = t.pivotZ ?? 0;
  const rx = t.rotateX ?? 0, ry = t.rotateY ?? 0, rz = t.rotateZ ?? 0;
  const scale = t.scale ?? 1;

  let x = localPt.x - pvX;
  let y = localPt.y - pvY;
  let z = (localPt.z || 0) - pvZ;

  if (rx !== 0) {
    const c = Math.cos(rx), s = Math.sin(rx);
    const ny = y * c - z * s, nz = y * s + z * c;
    y = ny; z = nz;
  }
  if (ry !== 0) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const nx =  x * c + z * s, nz = -x * s + z * c;
    x = nx; z = nz;
  }
  if (rz !== 0) {
    const c = Math.cos(rz), s = Math.sin(rz);
    const nx = x * c - y * s, ny = x * s + y * c;
    x = nx; y = ny;
  }

  x *= scale; y *= scale; z *= scale;
  return { x: x + pvX + posX, y: y + pvY + posY, z: z + pvZ + posZ };
}

/**
 * 2D counterpart — posX, posY, pivotX, pivotY, rotateZ, scale only.
 * Used for 2D render modes (contours/fill/arcs) where posZ/rotateX/rotateY
 * have no meaning.
 *
 * @param {{x:number, y:number}} pt
 * @param {object} t
 * @returns {{x:number, y:number}}
 */
export function applyInverseTransform2D(pt, t) {
  const posX = t.posX ?? 0, posY = t.posY ?? 0;
  const pvX  = t.pivotX ?? 0, pvY = t.pivotY ?? 0;
  const rz = t.rotateZ ?? 0;
  const scale = t.scale ?? 1;
  const safeScale = Math.abs(scale) > 1e-9 ? scale : 1e-9;

  let x = pt.x - posX - pvX;
  let y = pt.y - posY - pvY;
  if (rz !== 0) {
    const c = Math.cos(-rz), s = Math.sin(-rz);
    const nx = x * c - y * s, ny = x * s + y * c;
    x = nx; y = ny;
  }
  x /= safeScale; y /= safeScale;
  return { x: x + pvX, y: y + pvY };
}

/**
 * Compute conservative world-space scan bounds for a symmetric cube
 * [boundsMin, boundsMax]³ after applying a node's transform.
 *
 * Derivation: the forward transform maps the local ball of radius L
 * (half-extent of the bounds cube) around 0 through (local − pivot),
 * scale, rotation, then (+pivot +position). When rotation is present or
 * the pivot is non-origin, the exact post-rotation center is unknown, so
 * we conservatively bound by:
 *   center = position + pivot
 *   radius = scale · (L + |pivot|)
 * When there is no rotation AND pivot is at the origin, the bound is exact
 * (radius = scale · L, center = position).
 *
 * @param {number} boundsMin
 * @param {number} boundsMax
 * @param {object} t  transform object (posX/Y/Z, pivotX/Y/Z, rotateX/Y/Z, scale)
 * @returns {{minX,maxX,minY,maxY,minZ,maxZ, expanded:boolean}}
 */
export function computeWorldBounds3D(boundsMin, boundsMax, t) {
  const posX = t.posX ?? 0, posY = t.posY ?? 0, posZ = t.posZ ?? 0;
  const pvX  = t.pivotX ?? 0, pvY = t.pivotY ?? 0, pvZ = t.pivotZ ?? 0;
  const rx = t.rotateX ?? 0, ry = t.rotateY ?? 0, rz = t.rotateZ ?? 0;
  const scale = t.scale ?? 1;
  const hasRotation = rx !== 0 || ry !== 0 || rz !== 0;
  const pivotMag = Math.sqrt(pvX*pvX + pvY*pvY + pvZ*pvZ);

  const halfExtent  = (boundsMax - boundsMin) / 2;
  const localRadius = hasRotation ? halfExtent * Math.sqrt(3) : halfExtent;

  const needsConservative = hasRotation || pivotMag > 1e-9;
  const centerX = posX + (needsConservative ? pvX : 0);
  const centerY = posY + (needsConservative ? pvY : 0);
  const centerZ = posZ + (needsConservative ? pvZ : 0);
  const radius  = needsConservative
    ? scale * (localRadius + pivotMag)
    : scale * localRadius;

  return {
    minX: centerX - radius, maxX: centerX + radius,
    minY: centerY - radius, maxY: centerY + radius,
    minZ: centerZ - radius, maxZ: centerZ + radius,
    expanded: needsConservative || scale !== 1,
  };
}

/**
 * 2D equivalent — √2 expansion factor (square diagonal, not 3D bounding sphere).
 * @param {number} boundsMin
 * @param {number} boundsMax
 * @param {object} t
 * @returns {{minX,maxX,minY,maxY, expanded:boolean}}
 */
export function computeWorldBounds2D(boundsMin, boundsMax, t) {
  const posX = t.posX ?? 0, posY = t.posY ?? 0;
  const pvX  = t.pivotX ?? 0, pvY = t.pivotY ?? 0;
  const rz = t.rotateZ ?? 0;
  const scale = t.scale ?? 1;
  const hasRotation = rz !== 0;
  const pivotMag = Math.sqrt(pvX*pvX + pvY*pvY);

  const halfExtent  = (boundsMax - boundsMin) / 2;
  const localRadius = hasRotation ? halfExtent * Math.SQRT2 : halfExtent;

  const needsConservative = hasRotation || pivotMag > 1e-9;
  const centerX = posX + (needsConservative ? pvX : 0);
  const centerY = posY + (needsConservative ? pvY : 0);
  const radius  = needsConservative
    ? scale * (localRadius + pivotMag)
    : scale * localRadius;

  return {
    minX: centerX - radius, maxX: centerX + radius,
    minY: centerY - radius, maxY: centerY + radius,
    expanded: needsConservative || scale !== 1,
  };
}