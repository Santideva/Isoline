// File: src/ui/PolygonEditor.js
//
// ── Data flow ────────────────────────────────────────────────────────────────
// INPUT:
//   - node:             NodeInstance from NodeGraph (reads node.params.vertices)
//   - nodeGraph:        NodeGraph — called when vertices change
//   - onVerticesChange: callback(vertices: [[x,y],...]) fired on every edit
//
// OUTPUT:
//   - this.el: a <div> containing the editor canvas + toolbar
//   - Calls onVerticesChange whenever vertices are added, moved, or deleted
//
// Internal flow:
//   Canvas click   → _onCanvasClick  → add vertex or select existing
//   Canvas dblclick→ _onDblClick     → delete selected vertex
//   Canvas mousedown on vertex → _beginDrag → mousemove → _dragVertex
//   Any edit → _redraw() → redraws polygon on canvas
//             → onVerticesChange(vertices) → NodeCard._handleParamChange
//             → nodeGraph.updateNodeParam → _onParamChange in NodeCanvas
//             → PolytopePrimitive.updateParameters → rerender
//
// Coordinate system:
//   Canvas pixel (px, py) ↔ world (wx, wy):
//     wx = px / SIZE * WORLD_RANGE + WORLD_MIN
//     wy = WORLD_MAX - py / SIZE * WORLD_RANGE
//   where SIZE=200, WORLD_MIN=-3, WORLD_MAX=3, WORLD_RANGE=6
// ─────────────────────────────────────────────────────────────────────────────

const SIZE        = 200;   // canvas pixel dimensions
const WORLD_MIN   = -3;
const WORLD_MAX   =  3;
const WORLD_RANGE =  6;
const VERTEX_RADIUS = 6;   // px — hit detection radius

// Convert canvas pixel → world coordinate
const toWorld = (px, py) => ({
  x:  (px / SIZE) * WORLD_RANGE + WORLD_MIN,
  y:  WORLD_MAX - (py / SIZE) * WORLD_RANGE,
});

// Convert world coordinate → canvas pixel
const toCanvas = (wx, wy) => ({
  px: ((wx - WORLD_MIN) / WORLD_RANGE) * SIZE,
  py: ((WORLD_MAX - wy) / WORLD_RANGE) * SIZE,
});

export class PolygonEditor {
  /**
   * @param {object}   node              NodeInstance (reads node.params.vertices)
   * @param {NodeGraph} nodeGraph
   * @param {Function} onVerticesChange  ([[x,y],...]) → void
   */
  constructor(node, nodeGraph, onVerticesChange) {
    this.node              = node;
    this.nodeGraph         = nodeGraph;
    this.onVerticesChange  = onVerticesChange;

    // Current vertex list — array of [x, y] world-space pairs
    this.vertices = this._loadVertices();

    // Interaction state
    this._selectedIdx = -1;
    this._isDragging  = false;
    this._dragOffsetX = 0;
    this._dragOffsetY = 0;

    this.el = this._build();
    this._redraw();
    this._attachEvents();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Sync vertices from updated node params (called when card is rebuilt).
   */
  syncFromNode() {
    this.vertices     = this._loadVertices();
    this._selectedIdx = -1;
    this._redraw();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _build() {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding: 0 10px 8px;';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:10px; color:rgba(255,255,255,0.5);';

    const hint = document.createElement('span');
    hint.textContent = 'Click: add  •  Drag: move  •  Dbl-click: delete';
    toolbar.appendChild(hint);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Reset';
    clearBtn.style.cssText = `
      margin-left: auto;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 3px;
      color: rgba(255,255,255,0.6);
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
    `;
    clearBtn.addEventListener('click', () => {
      this.vertices     = this._defaultVertices();
      this._selectedIdx = -1;
      this._redraw();
      this._emit();
    });
    toolbar.appendChild(clearBtn);
    wrapper.appendChild(toolbar);

    // Canvas
    this._canvas        = document.createElement('canvas');
    this._canvas.width  = SIZE;
    this._canvas.height = SIZE;
    this._canvas.style.cssText = `
      width: 100%;
      border-radius: 4px;
      display: block;
      cursor: crosshair;
      background: #111;
    `;
    wrapper.appendChild(this._canvas);

    // Vertex count display
    this._countLabel = document.createElement('span');
    this._countLabel.style.cssText = 'font-size:10px; color:rgba(255,255,255,0.35); text-align:right;';
    wrapper.appendChild(this._countLabel);

    return wrapper;
  }

  // ── Canvas drawing ────────────────────────────────────────────────────────

  _redraw() {
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Background
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= 6; i++) {
      const x = (i / 6) * SIZE;
      const y = (i / 6) * SIZE;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(SIZE, y); ctx.stroke();
    }

    // Axes
    const origin = toCanvas(0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(origin.px, 0); ctx.lineTo(origin.px, SIZE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, origin.py); ctx.lineTo(SIZE, origin.py); ctx.stroke();

    if (this.vertices.length === 0) {
      this._countLabel.textContent = '0 vertices';
      return;
    }

    const pts = this.vertices.map(([x, y]) => toCanvas(x, y));

    // Filled polygon (subtle)
    if (pts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
      ctx.closePath();
      ctx.fillStyle = 'rgba(55, 138, 221, 0.08)';
      ctx.fill();
    }

    // Polygon edges
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].px, pts[0].py);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
    if (pts.length >= 3) ctx.closePath();
    ctx.stroke();

    // Vertices
    pts.forEach(({ px, py }, i) => {
      const isSelected = i === this._selectedIdx;
      ctx.beginPath();
      ctx.arc(px, py, VERTEX_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle   = isSelected ? '#EF9F27' : 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : 'rgba(0,0,0,0.4)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Index label
      ctx.fillStyle = isSelected ? '#000' : 'rgba(0,0,0,0.7)';
      ctx.font      = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i, px, py);
    });

    this._countLabel.textContent = `${this.vertices.length} vertices`;
  }

  // ── Event handling ────────────────────────────────────────────────────────

  _attachEvents() {
    const canvas = this._canvas;

    canvas.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const { px, py } = this._getCanvasPos(e);
      const hitIdx     = this._findVertex(px, py);

      if (hitIdx >= 0) {
        // Select and begin drag
        this._selectedIdx = hitIdx;
        this._isDragging  = true;
        const { px: vx, py: vy } = toCanvas(...this.vertices[hitIdx]);
        this._dragOffsetX = px - vx;
        this._dragOffsetY = py - vy;
        this._redraw();
      }
    });

    canvas.addEventListener('click', (e) => {
      if (this._isDragging) return;
      const { px, py } = this._getCanvasPos(e);
      const hitIdx     = this._findVertex(px, py);

      if (hitIdx >= 0) {
        this._selectedIdx = hitIdx;
        this._redraw();
        return;
      }

      // Add new vertex
      const world = toWorld(px, py);
      this.vertices.push([world.x, world.y]);
      this._selectedIdx = this.vertices.length - 1;
      this._redraw();
      this._emit();
    });

    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const { px, py } = this._getCanvasPos(e);
      const hitIdx     = this._findVertex(px, py);

      if (hitIdx >= 0 && this.vertices.length > 3) {
        this.vertices.splice(hitIdx, 1);
        this._selectedIdx = -1;
        this._redraw();
        this._emit();
      }
    });

    const onMouseMove = (e) => {
      if (!this._isDragging || this._selectedIdx < 0) return;
      const { px, py } = this._getCanvasPos(e);
      const adjX       = px - this._dragOffsetX;
      const adjY       = py - this._dragOffsetY;
      const world      = toWorld(
        Math.max(0, Math.min(SIZE, adjX)),
        Math.max(0, Math.min(SIZE, adjY))
      );
      this.vertices[this._selectedIdx] = [world.x, world.y];
      this._redraw();
      this._emit();
    };

    const onMouseUp = () => {
      this._isDragging = false;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    // Cleanup on removal
    const observer = new MutationObserver(() => {
      if (!document.contains(canvas)) {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _getCanvasPos(e) {
    const rect  = this._canvas.getBoundingClientRect();
    const scale = SIZE / rect.width;   // account for CSS scaling
    return {
      px: (e.clientX - rect.left) * scale,
      py: (e.clientY - rect.top)  * scale,
    };
  }

  _findVertex(px, py) {
    for (let i = 0; i < this.vertices.length; i++) {
      const { px: vx, py: vy } = toCanvas(...this.vertices[i]);
      const dist = Math.sqrt((px - vx) ** 2 + (py - vy) ** 2);
      if (dist <= VERTEX_RADIUS + 4) return i;
    }
    return -1;
  }

  _emit() {
    this.nodeGraph.updateNodeParam(
      this.node.id, 'vertices', JSON.stringify(this.vertices)
    );
    if (typeof this.onVerticesChange === 'function') {
      this.onVerticesChange(this.vertices);
    }
  }

  _loadVertices() {
    try {
      const raw = this.node.params.vertices;
      if (!raw) return this._defaultVertices();
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed) && parsed.length >= 3) return parsed;
    } catch (e) { /* fall through */ }
    return this._defaultVertices();
  }

  // Default: a square
  _defaultVertices() {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  }
}