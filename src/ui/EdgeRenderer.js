// File: src/ui/EdgeRenderer.js
//
// ── Data flow ────────────────────────────────────────────────────────────────
// INPUT:
//   - A <canvas> DOM element (passed in constructor)
//   - NodeGraph instance (read-only)
//   - A port position resolver function:
//       getPortPosition(nodeId, portName, direction) → {x, y} | null
//     This is provided by NodeCanvas because only NodeCanvas knows the
//     DOM positions of the port dots on each card.
//   - Optional: a "pending edge" state {fromX, fromY, toX, toY, color}
//     for the in-progress connection line during drag-connect.
//
// OUTPUT:
//   - Draws directly onto the <canvas> 2D context.
//   - No return values. Pure side effect on the canvas.
//
// When to redraw:
//   - Called by NodeCanvas whenever:
//       • The graph changes (edge added/removed)
//       • A node card is dragged (port positions move)
//       • A pending connection is being dragged
//       • The canvas is panned or zoomed
//   - NOT called every animation frame — only on change events.
//
// Coordinate system:
//   - All positions are in canvas "world" coordinates (before pan/zoom).
//   - NodeCanvas passes a transform {tx, ty, scale} so EdgeRenderer can
//     apply it before drawing. This keeps EdgeRenderer unaware of pan state.
// ─────────────────────────────────────────────────────────────────────────────

import { PORT_COLORS } from './portColors.js';
import { NODE_TYPES }  from '../graph/NodeSpec.js';

export class EdgeRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {NodeGraph} graph
   * @param {Function} getPortPosition  (nodeId, portName, dir) → {x,y}|null
   */
  constructor(canvas, graph, getPortPosition) {
    this.canvas          = canvas;
    this.ctx             = canvas.getContext('2d');
    this.graph           = graph;
    this.getPortPosition = getPortPosition;
    this.pendingEdge     = null;   // {x1,y1,x2,y2,color} during drag-connect
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Replace the graph reference (called when NodeCanvas rebuilds after clear).
   */
  setGraph(graph) {
    this.graph = graph;
  }

  /**
   * Set or clear the in-progress connection line shown during drag.
   * @param {{x1,y1,x2,y2,color}|null} pending
   */
  setPendingEdge(pending) {
    this.pendingEdge = pending;
  }

  /**
   * Full redraw. Call this whenever anything changes.
   * @param {{tx:number, ty:number, scale:number}} transform  pan+zoom state
   */
  draw(transform = { tx: 0, ty: 0, scale: 1 }) {
    const { canvas, ctx } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Apply pan/zoom transform
    ctx.save();
    ctx.translate(transform.tx, transform.ty);
    ctx.scale(transform.scale, transform.scale);

    this._drawGrid();
    this._drawEdges();
    if (this.pendingEdge) this._drawPendingEdge();

    ctx.restore();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Draw a subtle dot grid as background.
   */
  _drawGrid() {
    const { canvas, ctx } = this;
    const spacing = 24;
    const dotR    = 1;

    // Compute grid bounds in world space (before transform is applied,
    // we draw in world space so the grid stays fixed relative to content)
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = 'rgba(128,128,128,0.18)';

    for (let x = 0; x < w + spacing; x += spacing) {
      for (let y = 0; y < h + spacing; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Draw all committed edges in the graph as bezier curves.
   */
  _drawEdges() {
    this.graph.edges.forEach(edge => {
      const fromPos = this.getPortPosition(edge.fromNode, edge.fromPort, 'out');
      const toPos   = this.getPortPosition(edge.toNode,   edge.toPort,  'in');
      if (!fromPos || !toPos) return;

      // Determine colour from the port type
      const color = this._edgeColor(edge.fromNode, edge.fromPort);
      this._drawBezier(fromPos.x, fromPos.y, toPos.x, toPos.y, color, false);
    });
  }

  /**
   * Draw the temporary edge line during a drag-connect operation.
   */
  _drawPendingEdge() {
    const { x1, y1, x2, y2, color } = this.pendingEdge;
    this._drawBezier(x1, y1, x2, y2, color || '#888', true);
  }

  /**
   * Draw a single cubic bezier from (x1,y1) to (x2,y2).
   * The control points pull horizontally so the curve looks natural
   * for left-to-right connections.
   *
   * @param {boolean} dashed  Use dashed stroke (for pending edges)
   */
  _drawBezier(x1, y1, x2, y2, color, dashed) {
    const { ctx } = this;
    const dx = Math.abs(x2 - x1) * 0.5;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(
      x1 + dx, y1,   // control point 1 — pulls right from source
      x2 - dx, y2,   // control point 2 — pulls left from target
      x2, y2
    );

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.globalAlpha = dashed ? 0.6 : 0.85;

    if (dashed) {
      ctx.setLineDash([6, 4]);
    } else {
      ctx.setLineDash([]);
    }

    ctx.stroke();
    ctx.globalAlpha  = 1;
    ctx.setLineDash([]);
  }

  /**
   * Determine the colour for an edge by looking up the port type of its
   * source port, then mapping through PORT_COLORS.
   */
  _edgeColor(nodeId, portName) {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return '#888';

    const spec     = NODE_TYPES[node.type];
    if (!spec) return '#888';

    const portSpec = spec.ports.find(p => p.name === portName);
    if (!portSpec) return '#888';

    return PORT_COLORS[portSpec.type] || '#888';
  }
}