// File: src/utils/transform3D.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Shared 3D translate/rotate math used by:
//   - transform3DNode  (compositional "Position / Orient" node)
//   - the output-level placement transform (posX/Y/Z, rotateX/Y/Z on outputNode)
//
// To move/rotate a SHAPE by (tx,ty,tz) and (rx,ry,rz), we apply the INVERSE
// transform to the QUERY POINT before evaluating the shape's SDF — the
// standard SDF transform trick (move the sampling space, not the shape).
//
// Forward:  world = Rz(rz) · Ry(ry) · Rx(rx) · local + (tx,ty,tz)
// Inverse:  local = Rx(-rx) · Ry(-ry) · Rz(-rz) · (world - (tx,ty,tz))
//
// Applied in order: translate, then inverse-Z, inverse-Y, inverse-X.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the inverse translate+rotate to a 3D point.
 *
 * @param {{x:number, y:number, z?:number}} pt
 * @param {{posX?:number, posY?:number, posZ?:number,
 *           rotateX?:number, rotateY?:number, rotateZ?:number}} params
 * @returns {{x:number, y:number, z:number}}
 */
export function applyInverseTransform3D(pt, params) {
  const tx = params.posX    ?? 0, ty = params.posY    ?? 0, tz = params.posZ    ?? 0;
  const rx = params.rotateX ?? 0, ry = params.rotateY ?? 0, rz = params.rotateZ ?? 0;

  // Translate
  let x = pt.x - tx;
  let y = pt.y - ty;
  let z = (pt.z || 0) - tz;

  // Inverse Z rotation (undo roll)
  if (rz !== 0) {
    const c = Math.cos(-rz), s = Math.sin(-rz);
    const nx = x * c - y * s;
    const ny = x * s + y * c;
    x = nx; y = ny;
  }
  // Inverse Y rotation (undo yaw)
  if (ry !== 0) {
    const c = Math.cos(-ry), s = Math.sin(-ry);
    const nx =  x * c + z * s;
    const nz = -x * s + z * c;
    x = nx; z = nz;
  }
  // Inverse X rotation (undo pitch)
  if (rx !== 0) {
    const c = Math.cos(-rx), s = Math.sin(-rx);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny; z = nz;
  }

  return { x, y, z };
}

/**
 * Apply the inverse translate+rotate to a 2D point, using only
 * posX, posY, rotateZ. Used for 2D render modes (contours/fill/arcs),
 * where posZ/rotateX/rotateY have no meaning.
 *
 * @param {{x:number, y:number}} pt
 * @param {{posX?:number, posY?:number, rotateZ?:number}} params
 * @returns {{x:number, y:number}}
 */
export function applyInverseTransform2D(pt, params) {
  const tx = params.posX ?? 0, ty = params.posY ?? 0;
  const rz = params.rotateZ ?? 0;

  let x = pt.x - tx;
  let y = pt.y - ty;

  if (rz !== 0) {
    const c = Math.cos(-rz), s = Math.sin(-rz);
    const nx = x * c - y * s;
    const ny = x * s + y * c;
    x = nx; y = ny;
  }

  return { x, y };
}

/**
 * Compute world-space scan bounds for a symmetric cube [boundsMin, boundsMax]³
 * after applying the output placement transform.
 *
 * Pure translation: bounds shift exactly, no resolution loss.
 * Any rotation present: bounds expand to a bounding sphere
 * (half-extent × √3) to guarantee the rotated geometry stays within the
 * scanned region. This trades some effective resolution for correctness
 * when rotation is non-zero.
 *
 * @param {number} boundsMin
 * @param {number} boundsMax
 * @param {object} params  output node params (posX/Y/Z, rotateX/Y/Z)
 * @returns {{minX,maxX,minY,maxY,minZ,maxZ, expanded:boolean}}
 */
export function computeWorldBounds3D(boundsMin, boundsMax, params) {
  const tx = params.posX    ?? 0, ty = params.posY    ?? 0, tz = params.posZ    ?? 0;
  const rx = params.rotateX ?? 0, ry = params.rotateY ?? 0, rz = params.rotateZ ?? 0;
  const hasRotation = rx !== 0 || ry !== 0 || rz !== 0;

  const halfExtent = (boundsMax - boundsMin) / 2;
  const center     = (boundsMax + boundsMin) / 2;
  const radius     = hasRotation ? halfExtent * Math.sqrt(3) : halfExtent;

  return {
    minX: center - radius + tx, maxX: center + radius + tx,
    minY: center - radius + ty, maxY: center + radius + ty,
    minZ: center - radius + tz, maxZ: center + radius + tz,
    expanded: hasRotation,
  };
}

/**
 * 2D equivalent — only posX, posY, rotateZ affect bounds.
 * Expansion factor is √2 (the diagonal-to-side ratio of a square) since
 * 2D rotation only needs to cover the square's diagonal, not a full
 * 3D bounding sphere.
 *
 * @param {number} boundsMin
 * @param {number} boundsMax
 * @param {object} params  output node params (posX/posY/rotateZ)
 * @returns {{minX,maxX,minY,maxY, expanded:boolean}}
 */
export function computeWorldBounds2D(boundsMin, boundsMax, params) {
  const tx = params.posX ?? 0, ty = params.posY ?? 0;
  const rz = params.rotateZ ?? 0;
  const hasRotation = rz !== 0;

  const halfExtent = (boundsMax - boundsMin) / 2;
  const center     = (boundsMax + boundsMin) / 2;
  const radius     = hasRotation ? halfExtent * Math.SQRT2 : halfExtent;

  return {
    minX: center - radius + tx, maxX: center + radius + tx,
    minY: center - radius + ty, maxY: center + radius + ty,
    expanded: hasRotation,
  };
}