// File: src/ui/layouts.js
//
// ── Data flow ────────────────────────────────────────────────────────────────
// INPUT:  A NodeGraph instance (read-only — this module never mutates it)
//         A direction string: 'left-right' | 'top-down'
//
// OUTPUT: A Map<nodeId, {x, y}> of computed positions.
//         The caller (NodeCanvas) applies these via nodeGraph.updateNodePosition().
//
// Internal flow:
//   1. Collect all nodes that should appear in the canvas (top-level only).
//   2. Sort them into layers using CATEGORY_LAYER from portColors.js.
//   3. Within each layer, sort nodes by their topological depth so that
//      nodes with more upstream dependencies appear further right/down.
//   4. Assign (x, y) based on layer index and position within layer,
//      using the selected direction and spacing constants.
//
// This module has no DOM access and no side effects. It can be called at any
// time without affecting the running program.
// ─────────────────────────────────────────────────────────────────────────────

import { CATEGORY_LAYER } from './portColors.js';
import { NODE_TYPES }     from '../graph/NodeSpec.js';

export const LAYOUT_DIRECTIONS = ['left-right', 'top-down'];

// Spacing constants (pixels in canvas coordinate space)
const CARD_WIDTH    = 220;
const CARD_HEIGHT   = 160;  // approximate — actual height varies with param count
const COL_GAP       = 80;   // horizontal gap between columns
const ROW_GAP       = 40;   // vertical gap between nodes in the same column
const ORIGIN_X      = 60;   // canvas x of the leftmost column
const ORIGIN_Y      = 60;   // canvas y of the topmost row

/**
 * Top-level node types — the only ones shown in the canvas UI.
 * Inner edges (ComplexShape2D instances created by evaluator kernels)
 * are NOT shown.
 */
const TOP_LEVEL_TYPES = new Set([
  'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
  'tilingNode', 'rUnion', 'rIntersection', 'rDifference', 'schurBlend', 'ifsBlend',
  'identityMapper', 'polynomialMapper', 'sinusoidalMapper',
  'exponentialMapper', 'logarithmicMapper', 'powerMapper',
  'periodicMapper', 'temporalMapper', 'recursiveMapper',
  'blendedMapper', 'compositeMapper',
  'affineTransform',
  'timeNode', 'oscillatorNode',
  'outputNode',
]);

/**
 * Returns true if all top-level nodes are at the origin {x:0, y:0}.
 * Used by NodeCanvas to decide whether to auto-layout on first open.
 *
 * @param {NodeGraph} graph
 * @returns {boolean}
 */
export function needsLayout(graph) {
  // Returns true if any top-level node is still at the origin,
  // meaning it hasn't been positioned yet.
  for (const [, node] of graph.nodes) {
    if (!TOP_LEVEL_TYPES.has(node.type)) continue;
    if (node.uiPos.x === 0 && node.uiPos.y === 0) return true;
  }
  return false;
}

/**
 * Compute positions for all top-level nodes in the graph.
 *
 * @param {NodeGraph} graph
 * @param {'left-right'|'top-down'} direction
 * @returns {Map<number, {x:number, y:number}>}  nodeId → position
 */
export function autoLayout(graph, direction = 'left-right') {
  const topLevel = _getTopLevelNodes(graph);
  const layers   = _assignLayers(topLevel);
  return direction === 'top-down'
    ? _computeTopDown(layers)
    : _computeLeftRight(layers);
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Filter to only top-level node entries.
 * @returns {Array<[nodeId, node]>}
 */
function _getTopLevelNodes(graph) {
  const result = [];
  graph.nodes.forEach((node, id) => {
    if (TOP_LEVEL_TYPES.has(node.type)) result.push([id, node]);
  });
  return result;
}

/**
 * Group nodes into layers (columns for LR, rows for TD).
 * Within each layer, nodes are sorted by their topological depth
 * (nodes with more upstream parents appear later within the layer).
 *
 * @param {Array<[id, node]>} topLevel
 * @returns {Map<number, Array<[id, node]>>}  layer → nodes
 */
function _assignLayers(topLevel) {
  const layers = new Map();

  topLevel.forEach(([id, node]) => {
    const spec  = NODE_TYPES[node.type];
    const layer = spec ? (CATEGORY_LAYER[spec.category] ?? 2) : 2;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push([id, node]);
  });

  // Sort layer keys ascending so iteration is predictable
  const sorted = new Map([...layers.entries()].sort((a, b) => a[0] - b[0]));
  return sorted;
}

/**
 * Left-to-right layout.
 * Each layer is a vertical column. Nodes within a column are stacked top-down.
 *
 * @param {Map<number, Array>} layers
 * @returns {Map<number, {x,y}>}
 */
function _computeLeftRight(layers) {
  const positions = new Map();
  let colIndex = 0;

  layers.forEach((nodes) => {
    const x = ORIGIN_X + colIndex * (CARD_WIDTH + COL_GAP);
    nodes.forEach(([id], rowIndex) => {
      const y = ORIGIN_Y + rowIndex * (CARD_HEIGHT + ROW_GAP);
      positions.set(id, { x, y });
    });
    colIndex++;
  });

  return positions;
}

/**
 * Top-down layout.
 * Each layer is a horizontal row. Nodes within a row are spread left-right.
 *
 * @param {Map<number, Array>} layers
 * @returns {Map<number, {x,y}>}
 */
function _computeTopDown(layers) {
  const positions = new Map();
  let rowIndex = 0;

  layers.forEach((nodes) => {
    const y = ORIGIN_Y + rowIndex * (CARD_HEIGHT + COL_GAP);
    nodes.forEach(([id], colIndex) => {
      const x = ORIGIN_X + colIndex * (CARD_WIDTH + ROW_GAP);
      positions.set(id, { x, y });
    });
    rowIndex++;
  });

  return positions;
}