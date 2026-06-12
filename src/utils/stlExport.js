// File: src/utils/stlExport.js
//
// ── Purpose ──────────────────────────────────────────────────────────────────
// Converts a triangle array (from marchingCubes) to binary STL format and
// triggers a browser download.
//
// Binary STL format:
//   80 bytes  — header (arbitrary text, we use a generator stamp)
//   4 bytes   — uint32 triangle count
//   per triangle (50 bytes each):
//     12 bytes — normal vector (3 × float32)
//     12 bytes — vertex A     (3 × float32)
//     12 bytes — vertex B     (3 × float32)
//     12 bytes — vertex C     (3 × float32)
//     2 bytes  — attribute byte count (always 0)
//
// Total size = 84 + 50 × n bytes
//
// ── Why binary not ASCII ──────────────────────────────────────────────────────
// ASCII STL is human-readable but 5-10× larger. Most slicers (Cura,
// PrusaSlicer, Chitubox, Bambu Studio) prefer binary. For a mesh of
// 100k triangles, ASCII is ~15MB vs binary ~5MB.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a triangle array as binary STL and return an ArrayBuffer.
 *
 * @param {Array<{a: Vec3, b: Vec3, c: Vec3, normal: Vec3}>} triangles
 * @returns {ArrayBuffer}
 */
export function trianglesToSTL(triangles) {
    // Total buffer size: 80 (header) + 4 (count) + 50 * n (triangles)
    const buffer     = new ArrayBuffer(84 + 50 * triangles.length);
    const view       = new DataView(buffer);
    const headerText = 'Isoline STL export — isoline.app';

    // ── Write 80-byte header ──────────────────────────────────────────────
    for (let i = 0; i < 80; i++) {
        view.setUint8(i, i < headerText.length ? headerText.charCodeAt(i) : 0);
    }

    // ── Write triangle count (little-endian uint32) ───────────────────────
    view.setUint32(80, triangles.length, true);

    // ── Write each triangle ───────────────────────────────────────────────
    let offset = 84;
    for (const { a, b, c, normal } of triangles) {
        // Normal vector (3 × float32 LE)
        view.setFloat32(offset,      normal.x, true); offset += 4;
        view.setFloat32(offset,      normal.y, true); offset += 4;
        view.setFloat32(offset,      normal.z, true); offset += 4;
        // Vertex A
        view.setFloat32(offset,      a.x,      true); offset += 4;
        view.setFloat32(offset,      a.y,      true); offset += 4;
        view.setFloat32(offset,      a.z,      true); offset += 4;
        // Vertex B
        view.setFloat32(offset,      b.x,      true); offset += 4;
        view.setFloat32(offset,      b.y,      true); offset += 4;
        view.setFloat32(offset,      b.z,      true); offset += 4;
        // Vertex C
        view.setFloat32(offset,      c.x,      true); offset += 4;
        view.setFloat32(offset,      c.y,      true); offset += 4;
        view.setFloat32(offset,      c.z,      true); offset += 4;
        // Attribute byte count (always 0)
        view.setUint16(offset, 0, true); offset += 2;
    }

    return buffer;
}

/**
 * Trigger a browser download of the given ArrayBuffer as a .stl file.
 *
 * @param {ArrayBuffer} buffer
 * @param {string}      filename   e.g. 'isoline-export.stl'
 */
export function downloadSTL(buffer, filename) {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}