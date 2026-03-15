// File: src/ui/portColors.js
//
// ── Data flow ────────────────────────────────────────────────────────────────
// This is a pure constants module. It has no inputs and no outputs beyond
// the exported objects. Every other UI module imports from here to ensure
// consistent colour usage across node cards, port dots, and edge beziers.
//
// Nothing in this file changes at runtime.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps PortType strings (from NodeSpec.js) to hex colours.
 * Used for:
 *   - Port dot fill colour on node cards
 *   - Bezier edge stroke colour on the canvas
 *   - Port highlight colour during drag-connect
 */
export const PORT_COLORS = {
  sdf:       '#378ADD',   // blue   — distance field
  mapper:    '#EF9F27',   // amber  — mapping function
  transform: '#7F77DD',   // purple — affine matrix
  scalar:    '#1D9E75',   // teal   — plain number
  vec2:      '#D85A30',   // coral  — 2D vector
};

/**
 * Maps node category strings (from NodeSpec.js) to colours.
 * Used for:
 *   - Node card header bar background
 *   - Category legend in the canvas toolbar
 */
export const CATEGORY_COLORS = {
  geometry:  '#185FA5',   // deep blue
  blend:     '#533AB7',   // deep purple
  mapper:    '#BA7517',   // deep amber
  transform: '#3C3489',   // indigo
  temporal:  '#0F6E56',   // deep teal
  output:    '#5F5E5A',   // gray
};

/**
 * Text colours that remain readable on each category header bar.
 * Always a light value from the same ramp so dark mode works too.
 */
export const CATEGORY_TEXT_COLORS = {
  geometry:  '#B5D4F4',
  blend:     '#CECBF6',
  mapper:    '#FAC775',
  transform: '#AFA9EC',
  temporal:  '#9FE1CB',
  output:    '#D3D1C7',
};

/**
 * Layout layer assignment by category.
 * Lower numbers appear earlier (left in LR layout, top in TD layout).
 */
export const CATEGORY_LAYER = {
  geometry:  0,
  temporal:  1,
  transform: 1,
  mapper:    1,
  blend:     2,
  output:    3,
};