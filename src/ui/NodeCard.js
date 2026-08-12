// File: src/ui/NodeCard.js
//
// ── Data flow ────────────────────────────────────────────────────────────────
// INPUT:
//   - node:        A NodeInstance from NodeGraph (id, type, params, uiPos)
//   - nodeGraph:   The NodeGraph — called when params change or card is dragged
//   - onParamChange(nodeId, paramName, value):
//       Callback fired when user changes a parameter control.
//       NodeCanvas wires this to trigger recompose + redraw.
//   - onPortMouseDown(nodeId, portName, direction, portPosition):
//       Callback fired when user starts dragging from a port dot.
//       NodeCanvas uses this to begin a pending-edge drag.
//   - onPortMouseUp(nodeId, portName, direction):
//       Callback fired when user releases on a port dot.
//       NodeCanvas uses this to complete a pending-edge connection.
//   - onDragEnd(nodeId, x, y):
//       Callback fired when the card drag is complete.
//       NodeCanvas uses this to trigger an EdgeRenderer redraw.
//
// OUTPUT:
//   - this.el:  The root <div> DOM element. Caller appends it to the canvas.
//   - getPortPosition(portName, direction): returns {x, y} in canvas coords.
//       Used by EdgeRenderer to know where to draw bezier endpoints.
//
// Internal flow:
//   constructor → _build() creates DOM structure
//   _build() → _buildHeader() + _buildPorts() + _buildParams()
//   User drags card → mousemove updates style.left/top → onDragEnd fires
//   User changes param → _handleParamChange → nodeGraph.updateNodeParam
//                      → onParamChange callback
//   User mousedowns port → onPortMouseDown callback with screen position
// ─────────────────────────────────────────────────────────────────────────────

import { NODE_TYPES }            from '../graph/NodeSpec.js';
import { PORT_COLORS,
         CATEGORY_COLORS,
         CATEGORY_TEXT_COLORS }  from './portColors.js';
import { drawMapperCurve }       from './previewRenderer.js';
import { PolygonEditor }         from './PolygonEditor.js';
import { maskHasContent }        from '../utils/surfaceMask.js';

// Card dimensions — must match CARD_WIDTH/CARD_HEIGHT in layouts.js
const CARD_W     = 220;
const PORT_R     = 6;    // port dot radius in px
const PORT_D     = PORT_R * 2;

// Grid/angle snap increments for the Transform section.
const SNAP_POS_INCREMENT   = 0.25;        // transform position, world units
const SNAP_ROT_INCREMENT   = Math.PI / 12; // transform rotation, 15 degrees
const SNAP_PARAM_INCREMENT = 0.1;         // shape params (radius, height, rounding…)
                                           // — deliberately much finer than
                                           // position snap: the goal here is
                                           // helping the user land on precise
                                           // sizes, not enforcing a coarse grid.

export class NodeCard {
  /**
   * @param {object}   node            NodeInstance from NodeGraph
   * @param {NodeGraph} nodeGraph
   * @param {Function} onParamChange   (nodeId, paramName, value) → void
   * @param {Function} onPortMouseDown (nodeId, portName, dir, {x,y}) → void
   * @param {Function} onPortMouseUp   (nodeId, portName, dir) → void
   * @param {Function} onDragEnd       (nodeId, x, y) → void
   */
  constructor(node, nodeGraph, onParamChange, onPortMouseDown, onPortMouseUp, onDragEnd, onRequestPreview, undoManager = null, onTransformChange = null, onTransformSectionToggle = null, onAnchorPick = null, onAutoFitMorph = null, onAutoFitEmbedGuest = null, onPaintBrushToggle = null, onPaintFloodToggle = null, onClearMask = null, onMaskParamChange = null) {
    this.node              = node;
    this.nodeGraph         = nodeGraph;
    this.onParamChange     = onParamChange;
    this.onPortMouseDown   = onPortMouseDown;
    this.onPortMouseUp     = onPortMouseUp;
    this.onDragEnd         = onDragEnd;
    this.onRequestPreview  = onRequestPreview || null;
    this._undo             = undoManager;
    this.onTransformChange = onTransformChange || null;
    // Arms the viewport for "click a surface point to place this embedNode's
    // anchor" mode. Called with (this.node.id) — NodeCanvas resolves the
    // host node from the graph edge itself.
    this.onAnchorPick      = onAnchorPick || null;
    // Triggers Morph Auto-Fit for a morphBlend node — scales/centers its
    // two source shapes to roughly match. Called with (this.node.id).
    this.onAutoFitMorph    = onAutoFitMorph || null;
    // Auto-Fit Guest to Region — see NodeCanvas._autoFitEmbedGuest.
    this.onAutoFitEmbedGuest = onAutoFitEmbedGuest || null;
    // ── Universal surface-paint callbacks — see the "Surface Region"
    // section below. Present on every SDF-producing node, not just
    // embedNode: painting is a property of the SHAPE, not of any one
    // consumer of that shape's region — mappers and embedNode alike read
    // node.mask directly (see surfaceMask.js), no wiring required.
    this.onPaintBrushToggle = onPaintBrushToggle || null;
    this.onPaintFloodToggle = onPaintFloodToggle || null;
    this.onClearMask        = onClearMask || null;
    this.onMaskParamChange  = onMaskParamChange || null;
    // Fired with (nodeId, isOpen) whenever the Transform section itself is
    // expanded/collapsed — distinct from card selection. This is the actual
    // "user wants to see/edit placement" signal; selecting a card to drag
    // it around the graph canvas should NOT trigger this.
    this.onTransformSectionToggle = onTransformSectionToggle || null;

    this._portEls       = new Map();
    this._previewCanvas = null;
    this._previewTimer  = null;
    this._maskOpen       = false; // Surface Region section collapse state

    // Collapse state — persists only for this card's lifetime (not saved
    // across reloads). Both default closed to keep cards compact; the
    // Transform section is available on every node type regardless of
    // whether the node's own params happen to include a position field.
    this._transformOpen = false;
    this._pivotOpen      = false;

    // Grid/angle snap — per-card toggle, ON by default (architects/game
    // designers benefit from predictable increments out of the box; users
    // doing freeform organic placement can turn it off per-card). Position
    // sliders round to SNAP_POS_INCREMENT and rotation sliders round to
    // SNAP_ROT_INCREMENT while dragging. Scale is intentionally NOT
    // snapped (no natural "grid" for a multiplicative value).
    this._snapEnabled = true;

    this.el = this._build();
    this._attachDrag();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Return the canvas-space position of a port dot.
   * Used by EdgeRenderer to place bezier endpoints.
   *
   * @param {string} portName
   * @param {'in'|'out'} direction
   * @returns {{x:number, y:number}|null}
   */
  getPortPosition(portName, direction) {
    const entry = this._portEls.get(`${direction}:${portName}`);
    if (!entry) return null;

    const dotRect  = entry.el.getBoundingClientRect();
    const rootRect = this.el.closest('.nc-canvas-inner')?.getBoundingClientRect()
                  || { left: 0, top: 0 };

    return {
      x: dotRect.left + PORT_R - rootRect.left,
      y: dotRect.top  + PORT_R - rootRect.top,
    };
  }

  /**
   * Sync card position from node.uiPos (called after auto-layout).
   */
  syncPosition() {
    this.el.style.left = this.node.uiPos.x + 'px';
    this.el.style.top  = this.node.uiPos.y + 'px';
  }

  /**
   * Update a single param control to reflect an external change.
   */
  updateParam(paramName, value) {
    const input = this.el.querySelector(`[data-param="${paramName}"]`);
    if (!input) return;
    if (input.type === 'range' || input.type === 'number') {
      input.value = value;
      const display = this.el.querySelector(`[data-param-display="${paramName}"]`);
      if (display) display.textContent = typeof value === 'number' ? value.toFixed(2) : value;
    } else if (input.tagName === 'SELECT') {
      input.value = value;
    }
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _build() {
    const spec     = NODE_TYPES[this.node.type];
    const category = spec?.category || 'output';

    const card = document.createElement('div');
    card.className    = 'nc-card';
    card.dataset.nodeId = this.node.id;
    card.style.cssText = `
      position: absolute;
      width: ${CARD_W}px;
      left: ${this.node.uiPos.x}px;
      top:  ${this.node.uiPos.y}px;
      background: rgba(20,20,26,0.94);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
      font-family: var(--font-sans, sans-serif);
      font-size: 12px;
      color: var(--color-text-primary, #e0e0e0);
      user-select: none;
      cursor: default;
      min-width: ${CARD_W}px;
      pointer-events: auto;
      backdrop-filter: blur(6px);
    `;

    card.appendChild(this._buildHeader(spec, category));

    const specialActions = this._buildSpecialActions();
    if (specialActions) card.appendChild(specialActions);

    card.appendChild(this._buildBody(spec));

    const preview = this._buildPreview(spec);
    if (preview) card.appendChild(preview);

    // Transform section — present on EVERY node type, regardless of
    // whether the node has any params of its own. This is deliberate:
    // placement is now a universal capability, not something only
    // certain node types support.
    card.appendChild(this._buildTransformSection());

    // Surface Region section — present on every node that actually
    // PRODUCES an sdf/result output (painting a mapper-only or
    // transform-matrix-only node's "surface" is meaningless, since those
    // node types have no spatial extent of their own).
    const maskSection = this._buildMaskSectionIfApplicable(spec);
    if (maskSection) card.appendChild(maskSection);

    return card;
  }

  _buildHeader(spec, category) {
    const header = document.createElement('div');
    header.className = 'nc-card-header';
    header.style.cssText = `
      background: ${CATEGORY_COLORS[category] || '#444'};
      color: ${CATEGORY_TEXT_COLORS[category] || '#eee'};
      padding: 6px 10px;
      border-radius: 7px 7px 0 0;
      font-weight: 500;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: grab;
    `;
    header.dataset.dragHandle = 'true';

    const NODE_DISPLAY_NAMES = {
      polytope:          'Conv. Polygon',
      regularPolygon:    'Polygon',
      lineSegment:       'Line Segment',
      noiseDisplaceNode: 'Noise Disp.',
      symmetryFoldNode:  'Sym. Fold',
      symmetryOrbitNode: 'Sym. Orbit',
      extrudeNode:       'Extrude',
      revolveNode:       'Revolve',
      tilingNode:        'Tiling',
      mobiusNode:        'Möbius',
      twistNode:         'Twist',
      bendNode:          'Bend',
      repeatNode:        'Repeat',
    };
    const displayTitle = NODE_DISPLAY_NAMES[this.node.type] ?? (spec?.label || this.node.type);

    const label = document.createElement('span');
    label.textContent = displayTitle;
    header.appendChild(label);

    const idBadge = document.createElement('span');
    idBadge.textContent = `#${this.node.id}`;
    idBadge.style.cssText = 'opacity:0.6; font-size:10px;';
    header.appendChild(idBadge);

    return header;
  }

  /**
   * Node-type-specific action buttons that don't fit the generic param/
   * port model — currently: embedNode's "pick anchor on surface" and
   * morphBlend's "auto-fit shapes". Returns null (nothing appended) for
   * every other node type.
   */
  _buildSpecialActions() {
    const _actionBtn = (text, title, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.title = title;
      btn.style.cssText = `
        width: 100%;
        background: rgba(127,119,221,0.18);
        border: 1px solid rgba(127,119,221,0.5);
        border-radius: 4px;
        color: rgba(220,215,255,0.95);
        font-size: 11px;
        padding: 5px 8px;
        cursor: pointer;
        margin-bottom: 4px;
      `;
      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(127,119,221,0.3)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(127,119,221,0.18)');
      btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return btn;
    };

    if (this.node.type === 'embedNode' && (this.onAnchorPick || this.onAutoFitEmbedGuest)) {
      const container = document.createElement('div');

      // Always visible, even in Basic tier — a brief, NON-silent notice
      // that the fallback (origin-anchored disc) placement is currently
      // in effect. Painting on the host overrides this automatically; the
      // Pick-Anchor/Auto-Fit tooling below (the detailed disc workflow)
      // is genuinely advanced and stays gated, but the fact that a
      // fallback placement is active must not be hidden along with it.
      const hostEdge = this.nodeGraph.getIncomingEdge(this.node.id, 'hostSdf');
      const hostNode = hostEdge ? this.nodeGraph.nodes.get(hostEdge.fromNode) : null;
      const hostHasPaint = maskHasContent(hostNode?.mask);
      if (!hostHasPaint && !this.node._anchorPicked) {
        const note = document.createElement('div');
        note.textContent = 'Placed at center by default — drag Transform to reposition.';
        note.style.cssText = `
          font-size: 10px;
          color: rgba(200,200,210,0.65);
          padding: 6px 10px 0;
          line-height: 1.4;
        `;
        container.appendChild(note);
      }

      const wrap = document.createElement('div');
      wrap.style.cssText = 'padding: 6px 10px 0;';
      // Disc-workflow tools. Paint/Flood on the host is now the primary
      // path and needs neither — advanced-tier, not part of default flow.
      wrap.classList.add('nc-advanced-only');

      // Persistent warning until the anchor has actually been placed at
      // least once via Pick Anchor — the default (0,0,0) sits at the
      // host's origin, which is a degenerate/unstable point on any
      // symmetric shape (sphere, cylinder, capsule).
      // Session-only (this._node._anchorPicked is not a serialized param),
      // so it correctly re-appears after a reload as a gentle reminder
      // rather than silently trusting a value nobody actually chose.
      if (!this.node._anchorPicked) {
        const warn = document.createElement('div');
        warn.textContent = '⚠ Using default anchor (host origin) — pick a real surface point below.';
        warn.style.cssText = `
          font-size: 10px;
          color: rgba(255,190,120,0.95);
          background: rgba(255,150,60,0.12);
          border: 1px solid rgba(255,150,60,0.35);
          border-radius: 4px;
          padding: 4px 6px;
          margin-bottom: 6px;
          line-height: 1.4;
        `;
        wrap.appendChild(warn);
      }

      if (this.onAnchorPick) {
        wrap.appendChild(_actionBtn(
          '🎯 Pick Anchor on Surface',
          'Click a point on the host shape in the viewport to place the decoration there.',
          () => this.onAnchorPick(this.node.id)
        ));
      }
      if (this.onAutoFitEmbedGuest) {
        wrap.appendChild(_actionBtn(
          '🧩 Auto-Fit Guest to Region',
          'Automatically position, scale, and (for Repeat/Tiling guests) space the second shape to fit the region\'s footprint and depth — removes the need to manually wrestle its Transform into place.',
          () => this.onAutoFitEmbedGuest(this.node.id)
        ));
      }
      container.appendChild(wrap);
      return container;
    }

    if (this.node.type === 'morphBlend' && this.onAutoFitMorph) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'padding: 6px 10px 0;';
      wrap.appendChild(_actionBtn(
        '⨯ Auto-Fit Shapes',
        'Automatically scale and center both source shapes so the morph looks balanced.',
        () => this.onAutoFitMorph(this.node.id)
      ));
      return wrap;
    }

    return null;
  }

  _buildPreview(spec) {
    if (!spec) return null;

    const PREVIEW_W = 200;

    const SDF_TYPES = new Set([
      'lineSegment','triangle','arc','circle','regularPolygon',
      'rUnion','rIntersection','rDifference','schurBlend','ifsBlend',
    ]);
    const EDITOR_TYPES = new Set(['polytope']);
    const MAPPER_TYPES = new Set([
      'identityMapper','polynomialMapper','sinusoidalMapper','exponentialMapper',
      'logarithmicMapper','powerMapper','periodicMapper','temporalMapper',
      'recursiveMapper','blendedMapper','compositeMapper',
    ]);

    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      padding: 0 10px 8px;
      border-top: 1px solid rgba(255,255,255,0.06);
      margin-top: 4px;
    `;

    if (SDF_TYPES.has(this.node.type)) {
      const canvas = document.createElement('canvas');
      canvas.width  = PREVIEW_W;
      canvas.height = Math.round(PREVIEW_W * 0.55);
      canvas.style.cssText = `
        width: 100%;
        border-radius: 4px;
        display: block;
        margin-top: 6px;
        background: #111;
      `;
      this._previewCanvas = canvas;
      wrapper.appendChild(canvas);
      if (this.onRequestPreview) {
        setTimeout(() => this.onRequestPreview(this.node.id, canvas), 50);
      }

      // Attach drag-to-translate on the preview canvas
      const TRANSLATABLE = new Set([
        'triangle','arc','regularPolygon','circle','lineSegment'
      ]);
      if (TRANSLATABLE.has(this.node.type)) {
        this._attachPreviewDrag(canvas);
      }

      // The per-card rotation dial that used to live here has been removed.
      // It read/wrote node.params.rotation, which no longer exists on any
      // primitive type (rotation is now universally handled by the
      // Transform section's Rz slider) — the dial had been silently
      // non-functional for triangle/arc/regularPolygon since that field
      // was removed, and circle never had a rotation param at all.

      return wrapper;
    }

    if (MAPPER_TYPES.has(this.node.type)) {
      const canvas = document.createElement('canvas');
      canvas.width  = PREVIEW_W;
      canvas.height = Math.round(PREVIEW_W * 0.45);
      canvas.style.cssText = `
        width: 100%;
        border-radius: 4px;
        display: block;
        margin-top: 6px;
      `;
      this._previewCanvas = canvas;
      wrapper.appendChild(canvas);
      setTimeout(() => this._renderMapperPreview(), 50);
      return wrapper;
    }

    if (EDITOR_TYPES.has(this.node.type)) {
      const editor = new PolygonEditor(
        this.node,
        this.nodeGraph,
        (vertices) => {
          this._handleParamChange('vertices', JSON.stringify(vertices));
        }
      );
      return editor.el;
    }

    return null;
  }

  _buildBody(spec) {
    const body = document.createElement('div');
    body.style.cssText = 'padding: 0; position: relative;';

    // Ports row — input ports on left, output ports on right
    const portsRow = document.createElement('div');
    portsRow.style.cssText = `
      display: flex;
      justify-content: space-between;
      padding: 6px 0 2px;
      position: relative;
    `;

    const inCol  = document.createElement('div');
    const outCol = document.createElement('div');
    inCol.style.cssText  = 'display:flex; flex-direction:column; gap:6px; margin-left:-${PORT_D}px;';
    outCol.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-right:-${PORT_D}px; align-items:flex-end;';

    if (spec) {
      spec.ports
        .filter(p => p.dir === 'in')
        .forEach(p => inCol.appendChild(this._buildPort(p, 'in')));

      spec.ports
        .filter(p => p.dir === 'out')
        .forEach(p => outCol.appendChild(this._buildPort(p, 'out')));
    }

    portsRow.appendChild(inCol);
    portsRow.appendChild(outCol);
    body.appendChild(portsRow);

    // Params section
    if (spec && spec.params.length > 0) {
      const params = document.createElement('div');
      params.style.cssText = 'padding: 4px 10px 8px;';
      spec.params.forEach(p => params.appendChild(this._buildParam(p)));
      body.appendChild(params);
    }

    return body;
  }

  _buildPort(portSpec, direction) {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 5px;
      ${direction === 'out' ? 'flex-direction: row-reverse;' : ''}
    `;

    // OUT ports are bright blue — these are sources you drag FROM
    // IN  ports are amber/orange — these are targets you drop ONTO
    const OUT_COLOR = PORT_COLORS[portSpec.type] || '#4A90D9';
    const IN_COLOR  = portSpec.type === 'sdf'    ? '#E8943A'
                    : portSpec.type === 'mapper'  ? '#C97FD4'
                    : portSpec.type === 'scalar'  ? '#7FD48A'
                    : '#888';
    const dotColor  = direction === 'out' ? OUT_COLOR : IN_COLOR;

    const dot = document.createElement('div');
    dot.style.cssText = `
      width:  ${PORT_D}px;
      height: ${PORT_D}px;
      border-radius: 50%;
      background: ${dotColor};
      border: 2px solid rgba(255,255,255,0.25);
      cursor: crosshair;
      flex-shrink: 0;
      ${direction === 'in'  ? 'margin-left:  -'  + PORT_R + 'px;' : ''}
      ${direction === 'out' ? 'margin-right: -' + PORT_R + 'px;' : ''}
    `;
    dot.title = `${portSpec.name} (${portSpec.type})`;

    // Store dot reference for getPortPosition
    this._portEls.set(`${direction}:${portSpec.name}`, { el: dot, dir: direction });

    // Mouse events for drag-connect
    dot.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const rect = dot.getBoundingClientRect();
      const pos  = { x: rect.left + PORT_R, y: rect.top + PORT_R };
      this.onPortMouseDown(this.node.id, portSpec.name, direction, pos);
    });

    dot.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      this.onPortMouseUp(this.node.id, portSpec.name, direction);
    });

    const label = document.createElement('span');
    label.textContent = portSpec.name;
    label.style.cssText = 'font-size:10px; opacity:0.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80px;';

    row.appendChild(dot);
    row.appendChild(label);
    return row;
  }

  _renderMapperPreview() {
    if (!this._previewCanvas) return;
    import('../utils/DistanceMapping.js').then(DM => {
      const p = this.node.params;
      let fn;
      switch (this.node.type) {
        case 'identityMapper':    fn = DM.identityMapping; break;
        case 'polynomialMapper':  fn = DM.createPolynomialMapping([p.c0??0, p.c1??1, p.c2??0, p.c3??0], p.band??1.0); break;
        case 'sinusoidalMapper':  fn = DM.createSinusoidalMapping(p.a??1, p.b??1, p.c??0, p.e??0, p.band??1.0); break;
        case 'exponentialMapper': fn = DM.createExponentialMapping(p.a??1, p.b??1, p.c??0); break;
        case 'logarithmicMapper': fn = DM.createLogarithmicMapping(p.a??1, p.b??1, p.c??1, p.e??0); break;
        case 'powerMapper':       fn = DM.createPowerMapping(p.a??1, p.b??2, p.c??0); break;
        case 'periodicMapper':    fn = DM.createPeriodicMapping(DM.identityMapping, p.period??1); break;
        case 'temporalMapper':    fn = DM.createTemporalMapping(DM.identityMapping, p.frequency??1, p.amplitude??0.5); break;
        case 'recursiveMapper':   fn = DM.createRecursiveMapping(DM.identityMapping, p.iterations??2, p.strength??0.5); break;
        default:                  fn = DM.identityMapping;
      }
      drawMapperCurve(this._previewCanvas, fn);
    });
  }

  /**
   * Attach drag-to-translate behaviour to the SDF preview canvas.
   * Dragging maps pixel delta → world-space delta using the preview bounds
   * [-2.5, 2.5] in both axes, so the shape follows the mouse naturally.
   */
  _attachPreviewDrag(canvas) {
    const WORLD_SIZE = 5.0;  // total world units across the preview (2 × 2.5)
    let isDragging = false;
    let startX, startY, startPosX, startPosY;

    // Use a neutral drag cursor so port-dot diagnostics do not confuse this canvas
    canvas.style.cursor = 'move';

    const toDelta = (px) => (px / canvas.offsetWidth) * WORLD_SIZE;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      if (this._undo) this._undo.snapshot();
      isDragging  = true;
      startX      = e.clientX;
      startY      = e.clientY;
      // Position now lives on transform, not params (see the transform
      // overhaul) — this drag was previously writing to a params.posX/posY
      // field that no longer exists on any primitive type, so it was
      // silently a no-op. Fixed to go through transform instead.
      startPosX   = this.node.transform?.posX ?? 0;
      startPosY   = this.node.transform?.posY ?? 0;
      canvas.style.cursor = 'grabbing';
    });

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx    =  toDelta(e.clientX - startX);
      const dy    = -toDelta(e.clientY - startY);  // invert Y: screen down = world down
      const newX  = startPosX + dx;
      const newY  = startPosY + dy;

      this.nodeGraph.updateNodeTransform(this.node.id, 'posX', newX);
      this.nodeGraph.updateNodeTransform(this.node.id, 'posY', newY);

      this.updateTransformParam('posX', newX);
      this.updateTransformParam('posY', newY);

      if (this.onTransformChange) {
        this.onTransformChange(this.node.id, 'posX', newX);
        this.onTransformChange(this.node.id, 'posY', newY);
      }

      // Refresh SDF preview
      if (this.onRequestPreview) {
        clearTimeout(this._previewTimer);
        this._previewTimer = setTimeout(
          () => this.onRequestPreview(this.node.id, canvas), 80
        );
      }
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging          = false;
        canvas.style.cursor = 'crosshair';
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    // Clean up on card removal
    const observer = new MutationObserver(() => {
      if (!document.contains(canvas)) {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  _buildRotationHandle() {
    const SIZE    = 48;   // dial diameter in px
    const CX      = SIZE / 2;
    const CY      = SIZE / 2;
    const RADIUS  = SIZE / 2 - 4;

    const container = document.createElement('div');
    container.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    `;

    // The circular dial canvas
    const dial = document.createElement('canvas');
    dial.width  = SIZE;
    dial.height = SIZE;
    dial.style.cssText = `
      width: ${SIZE}px;
      height: ${SIZE}px;
      cursor: grab;
      flex-shrink: 0;
    `;

    // Angle readout label
    const readout = document.createElement('span');
    readout.style.cssText = `
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      opacity: 0.75;
      min-width: 48px;
    `;

    const drawDial = (angle) => {
      const ctx = dial.getContext('2d');
      ctx.clearRect(0, 0, SIZE, SIZE);

      // Background circle
      ctx.beginPath();
      ctx.arc(CX, CY, RADIUS, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(255,255,255,0.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // Tick marks at 0, 90, 180, 270
      for (let i = 0; i < 4; i++) {
        const a  = (i / 4) * Math.PI * 2;
        const x1 = CX + (RADIUS - 3) * Math.cos(a);
        const y1 = CY + (RADIUS - 3) * Math.sin(a);
        const x2 = CX + RADIUS * Math.cos(a);
        const y2 = CY + RADIUS * Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      // Direction indicator line
      const nx = CX + (RADIUS - 2) * Math.cos(angle - Math.PI / 2);
      const ny = CY + (RADIUS - 2) * Math.sin(angle - Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(nx, ny);
      ctx.strokeStyle = '#378ADD';
      ctx.lineWidth   = 2;
      ctx.stroke();

      // Centre dot
      ctx.beginPath();
      ctx.arc(CX, CY, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#378ADD';
      ctx.fill();

      // Update readout
      readout.textContent = `${((angle * 180) / Math.PI).toFixed(1)}°`;
    };

    // Initial draw
    const currentAngle = this.node.params.rotation || 0;
    drawDial(currentAngle);

    // Drag to rotate
    let isDragging  = false;
    let lastAngle   = currentAngle;

    const getAngleFromEvent = (e) => {
      const rect = dial.getBoundingClientRect();
      const dx   = e.clientX - (rect.left + CX);
      const dy   = e.clientY - (rect.top  + CY);
      // +π/2 offset so 0 points up (matching Three.js convention)
      return Math.atan2(dy, dx) + Math.PI / 2;
    };

    dial.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      if (this._undo) this._undo.snapshot();
      isDragging = true;
      lastAngle  = getAngleFromEvent(e);
      dial.style.cursor = 'grabbing';
    });

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const newAngle = getAngleFromEvent(e);
      // Normalise to [0, 2π]
      const normalised = ((newAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      drawDial(normalised);
      this._handleParamChange('rotation', normalised);
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging        = false;
        dial.style.cursor = 'grab';
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    // Clean up listeners when card is removed from DOM
    // (MutationObserver watches for removal)
    const observer = new MutationObserver(() => {
      if (!document.contains(dial)) {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Store reference so syncPosition can redraw if needed
    this._rotationDial    = dial;
    this._drawRotationDial = drawDial;

    const labelRow = document.createElement('div');
    labelRow.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
    const label = document.createElement('span');
    label.textContent = 'Rotate Z';
    label.style.cssText = 'font-size:10px; opacity:0.5;';
    labelRow.appendChild(label);
    labelRow.appendChild(readout);

    container.appendChild(dial);
    container.appendChild(labelRow);
    return container;
  }

  _buildParam(paramSpec) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; gap:6px;';
    if (paramSpec.advanced) row.classList.add('nc-advanced-only');

    const label = document.createElement('label');
    // Use the optional human-readable label from NodeSpec if provided,
    // otherwise fall back to the raw param name.
    label.textContent = paramSpec.label || paramSpec.name;
    label.style.cssText = 'font-size:12px; opacity:0.75; min-width:50px; flex-shrink:0; cursor:default;';

    // If a hint string is defined in NodeSpec, attach it as a tooltip.
    // The cursor:help style signals to the user that hovering gives info.
    if (paramSpec.hint) {
      label.title = paramSpec.hint;
      label.style.cssText = 'font-size:12px; opacity:0.75; min-width:50px; flex-shrink:0; cursor:help;';
    }

    row.appendChild(label);
    row.appendChild(this._buildParamControl(paramSpec));
    return row;
  }

  _buildParamControl(paramSpec) {
    // embedNode's regionSize is INERT once the host has a PAINTED
    // (not flooded) region — the confinement footprint comes from the
    // paint itself. Flood mode keeps regionSize live (it now scales
    // the flooded footprint) so this only shows the lock for paint modes.
    if (this.node.type === 'embedNode' && paramSpec.name === 'regionSize') {
      const hostEdge = this.nodeGraph.getIncomingEdge(this.node.id, 'hostSdf');
      const hostNode = hostEdge ? this.nodeGraph.nodes.get(hostEdge.fromNode) : null;
      const hostHasMask = maskHasContent(hostNode?.mask);
      if (hostHasMask && hostNode.mask.mode !== 'curvatureFlood') {
        const note = document.createElement('div');
        note.textContent = 'Confined by painted region';
        note.title = 'The host has a painted stroke — the decoration\'s shape comes entirely from the paint, not this slider. Clear the region (on the host\'s card) to use regionSize again.';
        note.style.cssText = `
          flex: 1;
          font-size: 10px;
          opacity: 0.55;
          font-style: italic;
          padding: 3px 2px;
          cursor: help;
        `;
        return note;
      }
    }

    // Universal shape-param lockout: once THIS node has a painted
    // Surface Region, changing any of its OWN geometry-defining params
    // (radius, width, sides, height, ...) moves the true SDF surface
    // out from under the frozen paint samples — the paint can silently
    // stop matching the surface, or the embed can vanish entirely (see
    // the depth-based bail-out in NodeEvaluator/GLSLEvaluator's
    // embedNode case). This locks ONLY the params-section controls
    // built by this method — NOT the Transform section (position/
    // rotation/scale are correctly re-applied to painted samples via
    // coordinate conversion, so those stay safe to edit) and NOT the
    // Surface Region controls themselves (falloffRadius etc. and the
    // Paint/Flood/Clear buttons must stay usable to fix or clear paint).
    if (maskHasContent(this.node.mask)) {
      const lockedValue = this.node.params[paramSpec.name] ?? paramSpec.default;
      const locked = document.createElement('div');
      locked.title = 'Locked — this shape has a painted Surface Region. Changing its own size/shape here would leave the paint attached to the wrong surface. Use "Clear Region" below to unlock, then repaint afterward.';
      locked.style.cssText = `
        flex: 1;
        font-size: 10px;
        opacity: 0.45;
        font-style: italic;
        padding: 3px 2px;
        cursor: not-allowed;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      `;
      locked.textContent = `🔒 ${typeof lockedValue === 'number' ? lockedValue.toFixed(2) : lockedValue}`;
      return locked;
    }

    const currentValue = this.node.params[paramSpec.name] ?? paramSpec.default;

    if (paramSpec.type === 'select') {
      const sel = document.createElement('select');
      sel.dataset.param = paramSpec.name;
      sel.style.cssText = `
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: inherit;
        font-size: 11px;
        padding: 2px 4px;
        flex: 1;
        min-width: 0;
      `;
      if (paramSpec.hint) sel.title = paramSpec.hint;
      (paramSpec.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === currentValue) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () =>
        this._handleParamChange(paramSpec.name, sel.value)
      );
      return sel;
    }

    // JSON / array params (e.g. polytope vertices) — show truncated read-only
    // display. The full value is accessible on hover. Actual editing is done
    // via the PolygonEditor preview widget, not this control.
    if (paramSpec.type === 'json' || paramSpec.type === 'vertices' ||
        paramSpec.name === 'vertices') {
      const display = document.createElement('div');
      display.style.cssText = `
        flex: 1;
        font-size: 10px;
        opacity: 0.65;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: monospace;
        background: rgba(255,255,255,0.04);
        border-radius: 3px;
        padding: 2px 5px;
        cursor: default;
      `;
      try {
        const val = currentValue;
        const arr = typeof val === 'string' ? JSON.parse(val) : val;
        if (Array.isArray(arr)) {
          display.textContent = `[${arr.length} pts]`;
        } else {
          const raw = JSON.stringify(val);
          display.textContent = raw.length > 30 ? raw.slice(0, 28) + '…' : raw;
        }
      } catch(_) {
        const raw = String(currentValue);
        display.textContent = raw.length > 30 ? raw.slice(0, 28) + '…' : raw;
      }
      display.title = typeof currentValue === 'string'
        ? currentValue
        : JSON.stringify(currentValue);
      return display;
    }

    // Number — slider + numeric display
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; align-items:center; gap:4px; flex:1; min-width:0;';

    const slider = document.createElement('input');
    slider.type       = 'range';
    slider.dataset.param = paramSpec.name;
    slider.min        = paramSpec.min  ?? 0;
    slider.max        = paramSpec.max  ?? 10;
    slider.step       = 'any';
    slider.value      = currentValue;
    slider.style.cssText = 'flex:1; min-width:0; height:14px; accent-color: #378ADD;';
    if (paramSpec.hint) slider.title = paramSpec.hint;

    const display = document.createElement('span');
    display.dataset.paramDisplay = paramSpec.name;
    display.textContent = typeof currentValue === 'number'
      ? currentValue.toFixed(2)
      : currentValue;
    display.style.cssText = 'font-size:10px; opacity:0.8; min-width:32px; text-align:right; font-variant-numeric:tabular-nums;';

    slider.addEventListener('mousedown', () => {
      if (this._undo) this._undo.snapshot();
    });

    slider.addEventListener('input', () => {
      let v = parseFloat(slider.value);
      if (this._snapEnabled) {
        const ownStep = paramSpec.step;
        const useOwnStep = typeof ownStep === 'number' && ownStep >= 1 && Number.isInteger(ownStep);
        const increment = useOwnStep ? ownStep : SNAP_PARAM_INCREMENT;
        v = Math.round(v / increment) * increment;
        v = parseFloat(v.toFixed(4));
        slider.value = v;
      }
      display.textContent = v.toFixed(2);
      this._handleParamChange(paramSpec.name, v);
    });

    wrapper.appendChild(slider);
    wrapper.appendChild(display);
    return wrapper;
  }

  // ── Transform section ─────────────────────────────────────────────────────
  //
  // Every node — primitive, blend, or transform op — carries a `transform`
  // block (posX/Y/Z, pivotX/Y/Z, rotateX/Y/Z, scale) applied universally by
  // NodeEvaluator/GLSLEvaluator regardless of node type. This section is the
  // one place in the UI that edits it, replacing the old scattered/
  // inconsistent per-primitive position sliders.

  _buildTransformSection() {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      border-top: 1px solid rgba(255,255,255,0.08);
      margin-top: 4px;
    `;

    // ── Header (click to expand/collapse) ─────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      font-weight: 500;
      color: rgba(220,220,230,0.85);
    `;
    const arrow = document.createElement('span');
    arrow.textContent = this._transformOpen ? '▾' : '▸';
    arrow.style.cssText = 'font-size:10px; opacity:0.6; width:10px; display:inline-block;';
    const title = document.createElement('span');
    title.textContent = 'Transform';

    // ── Snap toggle ─────────────────────────────────────────────────────────
    // When on, position sliders round to SNAP_POS_INCREMENT and rotation
    // sliders round to SNAP_ROT_INCREMENT as the user drags. Purely a
    // per-card UI convenience — does not alter node.transform's precision
    // beyond what the user actually drags to.
    const snapBtn = document.createElement('button');
    snapBtn.textContent = '⊞ Snap';
    snapBtn.title = 'Snap position to 0.25 units and rotation to 15° increments while dragging.';
    const _snapStyle = (on) => `
      background: ${on ? 'rgba(127,119,221,0.35)' : 'rgba(255,255,255,0.06)'};
      border: 1px solid ${on ? 'rgba(127,119,221,0.7)' : 'rgba(255,255,255,0.14)'};
      border-radius: 3px;
      color: ${on ? 'rgba(220,215,255,0.95)' : 'rgba(255,255,255,0.5)'};
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
      margin-left: auto;
    `;
    snapBtn.style.cssText = _snapStyle(this._snapEnabled);
    snapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._snapEnabled = !this._snapEnabled;
      snapBtn.style.cssText = _snapStyle(this._snapEnabled);
    });

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Reset position, rotation, scale, and pivot to defaults';
    resetBtn.style.cssText = `
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 3px;
      color: rgba(255,255,255,0.5);
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
    `;
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._undo) this._undo.snapshot();
      const IDENTITY = {
        posX:0, posY:0, posZ:0, pivotX:0, pivotY:0, pivotZ:0,
        rotateX:0, rotateY:0, rotateZ:0, scale:1,
      };
      Object.entries(IDENTITY).forEach(([field, value]) => {
        this._handleTransformChange(field, value);
      });
      // Rebuild the section in place so all sliders reflect the reset values
      const fresh = this._buildTransformSection();
      wrapper.replaceWith(fresh);
    });

    header.appendChild(arrow);
    header.appendChild(title);
    header.appendChild(snapBtn);
    header.appendChild(resetBtn);
    wrapper.appendChild(header);

    // ── Content (rows), only built/shown when open ─────────────────────────
    const content = document.createElement('div');
    content.style.cssText = `
      padding: 0 10px 8px;
      display: ${this._transformOpen ? 'block' : 'none'};
    `;

    const t = this.node.transform || {
      posX:0, posY:0, posZ:0, pivotX:0, pivotY:0, pivotZ:0,
      rotateX:0, rotateY:0, rotateZ:0, scale:1,
    };

    // Position — snap kind 'position'
    content.appendChild(this._buildTransformRow('X', 'posX', t.posX, -10, 10, 0.01,
      'Move this shape along X.', 'position'));
    content.appendChild(this._buildTransformRow('Y', 'posY', t.posY, -10, 10, 0.01,
      'Move this shape along Y.', 'position'));
    content.appendChild(this._buildTransformRow('Z', 'posZ', t.posZ, -10, 10, 0.01,
      'Move this shape along Z. Only visible effect in 3D render modes.', 'position'));

    // Rotation — snap kind 'rotation'
    content.appendChild(this._buildTransformRow('Rx', 'rotateX', t.rotateX, 0, 6.28, 0.01,
      'Rotate around X (pitch). Only visible effect in 3D render modes.', 'rotation'));
    content.appendChild(this._buildTransformRow('Ry', 'rotateY', t.rotateY, 0, 6.28, 0.01,
      'Rotate around Y (yaw). Only visible effect in 3D render modes.', 'rotation'));
    content.appendChild(this._buildTransformRow('Rz', 'rotateZ', t.rotateZ, 0, 6.28, 0.01,
      'Rotate around Z (roll).', 'rotation'));

    // Scale — snap kind 'none' (no natural grid for a multiplicative value)
    content.appendChild(this._buildTransformRow('Scale', 'scale', t.scale, 0.01, 10, 0.01,
      'Uniform scale. Non-uniform (stretch) scale is not supported — it would break the distance-field math.', 'none'));

    // ── Pivot — nested "Advanced" collapse ──────────────────────────────────
    // Tucked away because the default pivot (0,0,0) already gives the
    // expected "rotate the shape around its own center" behavior for the
    // vast majority of use cases, since every primitive is origin-centered.
    // Pivot only matters when you deliberately want to rotate/scale around
    // a point OTHER than the shape's own center (e.g. an orbit or hinge
    // effect on a single node) — an advanced, less common technique.
    const advToggle = document.createElement('div');
    advToggle.className = 'nc-advanced-only';
    advToggle.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 0 2px;
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      border-top: 1px solid rgba(255,255,255,0.06);
      margin-top: 4px;
    `;
    const advArrow = document.createElement('span');
    advArrow.textContent = this._pivotOpen ? '▾' : '▸';
    advArrow.style.cssText = 'font-size:9px; width:9px; display:inline-block;';
    const advLabel = document.createElement('span');
    advLabel.textContent = 'Advanced: Pivot';
    advLabel.title = 'Rotate/scale around a point other than this shape\'s own center. Leave at (0,0,0) for normal "rotate in place" behavior.';
    advToggle.appendChild(advArrow);
    advToggle.appendChild(advLabel);
    content.appendChild(advToggle);

    const advContent = document.createElement('div');
    advContent.className = 'nc-advanced-only';
    advContent.style.cssText = `display: ${this._pivotOpen ? 'block' : 'none'}; margin-top: 4px;`;
    advContent.appendChild(this._buildTransformRow('Pivot X', 'pivotX', t.pivotX, -10, 10, 0.01,
      'Pivot point X, relative to this shape\'s own center.', 'position'));
    advContent.appendChild(this._buildTransformRow('Pivot Y', 'pivotY', t.pivotY, -10, 10, 0.01,
      'Pivot point Y.', 'position'));
    advContent.appendChild(this._buildTransformRow('Pivot Z', 'pivotZ', t.pivotZ, -10, 10, 0.01,
      'Pivot point Z.', 'position'));
    content.appendChild(advContent);

    advToggle.addEventListener('click', () => {
      this._pivotOpen = !this._pivotOpen;
      advArrow.textContent = this._pivotOpen ? '▾' : '▸';
      advContent.style.display = this._pivotOpen ? 'block' : 'none';
    });

    wrapper.appendChild(content);

    header.addEventListener('click', () => {
      this._transformOpen = !this._transformOpen;
      arrow.textContent = this._transformOpen ? '▾' : '▸';
      content.style.display = this._transformOpen ? 'block' : 'none';
      if (this.onTransformSectionToggle) {
        this.onTransformSectionToggle(this.node.id, this._transformOpen);
      }
    });

    return wrapper;
  }

  // ── Surface Region (paint mask) section ───────────────────────────────────
  //
  // Universal, like the Transform section — every node that produces an
  // sdf/result output gets one. Painting directly on this node's own
  // rendered surface selects a region (see surfaceMask.js / surfaceGraph.js
  // for the underlying Euclidean / geodesic / curvature-flood algorithms);
  // that region is then automatically read by ANY consumer that looks at
  // node.mask — this node's own mapper port (if connected), or a
  // downstream embedNode using this node as its host with
  // maskSource='paintedRegion'. No wiring step is needed for either case.

  /**
   * Returns true if this node type produces an sdf/result output — the
   * only node types painting is meaningful for. Excludes pure mapper
   * nodes, temporal/scalar sources, and affineTransform (outputs a
   * TRANSFORM value, not an SDF).
   */
  _nodeHasSpatialOutput(spec) {
    if (!spec) return false;
    const SPATIAL_CATEGORIES = new Set(['geometry', 'blend', 'transform']);
    if (!SPATIAL_CATEGORIES.has(spec.category)) return false;
    if (spec.type === 'affineTransform') return false;
    return spec.ports.some(p => p.dir === 'out' && (p.name === 'sdf' || p.name === 'result'));
  }

  _buildMaskSectionIfApplicable(spec) {
    if (!this._nodeHasSpatialOutput(spec)) return null;
    if (!this.onPaintBrushToggle && !this.onPaintFloodToggle) return null;
    return this._buildMaskSection();
  }

  _buildMaskSection() {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      border-top: 1px solid rgba(255,255,255,0.08);
      margin-top: 4px;
    `;

    const mask = this.node.mask || { enabled: false, samples: [], falloffRadius: 0.4, normalThreshold: 0.3, curvatureThreshold: 0.15, mode: 'euclidean' };
    const sampleCount = Array.isArray(mask.samples) ? mask.samples.length : 0;

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      font-weight: 500;
      color: rgba(220,220,230,0.85);
    `;
    const arrow = document.createElement('span');
    arrow.textContent = this._maskOpen ? '▾' : '▸';
    arrow.style.cssText = 'font-size:10px; opacity:0.6; width:10px; display:inline-block;';
    const title = document.createElement('span');
    title.textContent = 'Surface Region';
    const statusBadge = document.createElement('span');
    statusBadge.textContent = sampleCount > 0 ? `${sampleCount} pts` : 'unpainted';
    statusBadge.style.cssText = `
      margin-left: auto;
      font-size: 10px;
      opacity: 0.55;
      font-variant-numeric: tabular-nums;
    `;
    header.appendChild(arrow);
    header.appendChild(title);
    header.appendChild(statusBadge);
    wrapper.appendChild(header);

    // ── Content ───────────────────────────────────────────────────────────
    const content = document.createElement('div');
    content.style.cssText = `
      padding: 0 10px 8px;
      display: ${this._maskOpen ? 'block' : 'none'};
    `;

    const hint = document.createElement('div');
    hint.textContent = 'Paint directly on this shape\'s rendered surface (Ray March mode) to select a region. Connect a Mapper to this node to confine its effect to the painted area — no extra wiring needed for the region itself.';
    hint.style.cssText = `
      font-size: 10px;
      opacity: 0.55;
      line-height: 1.4;
      margin-bottom: 8px;
    `;
    content.appendChild(hint);

    const _toolBtn = (text, hintText, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.title = hintText;
      btn.style.cssText = `
        flex: 1;
        min-width: 0;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: rgba(255,255,255,0.75);
        font-size: 11px;
        padding: 5px 6px;
        cursor: pointer;
      `;
      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(80,220,220,0.20)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(255,255,255,0.08)');
      btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return btn;
    };

    const toolRow = document.createElement('div');
    toolRow.style.cssText = 'display:flex; gap:6px; margin-bottom:8px;';
    if (this.onPaintBrushToggle) {
      toolRow.appendChild(_toolBtn(
        '🖌 Paint',
        'Drag on this shape\'s surface in the viewport to paint a region (geodesic-refined on release).',
        () => this.onPaintBrushToggle(this.node.id)
      ));
    }
    if (this.onPaintFloodToggle) {
      toolRow.appendChild(_toolBtn(
        '💧 Flood',
        'Click once on the surface to select all connected areas with similar curvature.',
        () => this.onPaintFloodToggle(this.node.id)
      ));
    }
    content.appendChild(toolRow);

    if (this.onClearMask && sampleCount > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.textContent = '🧹 Clear Region';
      clearBtn.style.cssText = `
        width: 100%;
        background: rgba(255,120,80,0.12);
        border: 1px solid rgba(255,120,80,0.35);
        border-radius: 4px;
        color: rgba(255,180,150,0.9);
        font-size: 11px;
        padding: 5px 6px;
        cursor: pointer;
        margin-bottom: 8px;
      `;
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onClearMask(this.node.id);
      });
      content.appendChild(clearBtn);
    }

    // ── Falloff / threshold sliders ──────────────────────────────────────
    const _maskRow = (label, field, value, min, max, step, hintText) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; gap:6px;';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.title = hintText;
      lbl.style.cssText = 'font-size:11px; opacity:0.75; min-width:78px; flex-shrink:0; cursor:help;';
      const wrapperEl = document.createElement('div');
      wrapperEl.style.cssText = 'display:flex; align-items:center; gap:4px; flex:1; min-width:0;';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = min; slider.max = max; slider.step = step;
      slider.value = value;
      slider.title = hintText;
      slider.style.cssText = 'flex:1; min-width:0; height:14px; accent-color:#50DCDC;';
      const display = document.createElement('span');
      display.textContent = Number(value).toFixed(2);
      display.style.cssText = 'font-size:10px; opacity:0.8; min-width:32px; text-align:right; font-variant-numeric:tabular-nums;';
      slider.addEventListener('mousedown', () => { if (this._undo) this._undo.snapshot(); });
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        display.textContent = v.toFixed(2);
        if (this.onMaskParamChange) this.onMaskParamChange(this.node.id, field, v);
      });
      wrapperEl.appendChild(slider);
      wrapperEl.appendChild(display);
      row.appendChild(lbl);
      row.appendChild(wrapperEl);
      return row;
    };

    content.appendChild(_maskRow('Falloff radius', 'falloffRadius', mask.falloffRadius ?? 0.4, 0.02, 3, 0.01,
      'How far the selection reaches from where you paint. Larger = softer, wider region.'));
    content.appendChild(_maskRow('Normal similarity', 'normalThreshold', mask.normalThreshold ?? -1, -1, 1, 0.01,
      'Rejects points whose facing direction is too different from where you painted — prevents the selection leaking across a fold or through a thin wall. Off by default (fully open); raise this only if you see paint leaking across a genuinely sharp edge.'));
    content.appendChild(_maskRow('Curvature threshold', 'curvatureThreshold', mask.curvatureThreshold ?? 0.15, 0.005, 1, 0.005,
      'Only used by Flood Select — how similar curvature must be to keep growing the selection. Smaller = stricter, more localized flood.'));

    wrapper.appendChild(content);

    header.addEventListener('click', () => {
      this._maskOpen = !this._maskOpen;
      arrow.textContent = this._maskOpen ? '▾' : '▸';
      content.style.display = this._maskOpen ? 'block' : 'none';
    });

    return wrapper;
  }

  /**
   * Build one labelled slider+numeric-readout row for a transform field.
   * Structurally identical to the param slider builder, but writes via
   * updateNodeTransform instead of updateNodeParam.
   *
   * @param {string} snapKind  'position' | 'rotation' | 'none' — which snap
   *   increment (if snap is enabled on this card) applies to this field.
   *   Scale uses 'none' since there's no natural grid for a multiplicative
   *   value.
   */
  _buildTransformRow(label, field, currentValue, min, max, step, hint, snapKind = 'none') {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; gap:6px;';

    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.title = hint;
    lbl.style.cssText = 'font-size:12px; opacity:0.75; min-width:50px; flex-shrink:0; cursor:help;';
    row.appendChild(lbl);

    const wrapperEl = document.createElement('div');
    wrapperEl.style.cssText = 'display:flex; align-items:center; gap:4px; flex:1; min-width:0;';

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.dataset.transformField = field;
    slider.min   = min;
    slider.max   = max;
    slider.step  = step;
    slider.value = currentValue ?? (field === 'scale' ? 1 : 0);
    slider.title = hint;
    slider.style.cssText = 'flex:1; min-width:0; height:14px; accent-color: #7F77DD;'; // purple — matches TRANSFORM port colour

    const display = document.createElement('span');
    display.dataset.transformDisplay = field;
    display.textContent = Number(slider.value).toFixed(2);
    display.style.cssText = 'font-size:10px; opacity:0.8; min-width:36px; text-align:right; font-variant-numeric:tabular-nums;';

    slider.addEventListener('mousedown', () => {
      if (this._undo) this._undo.snapshot();
    });
    slider.addEventListener('input', () => {
      let v = parseFloat(slider.value);
      if (this._snapEnabled && snapKind !== 'none') {
        const increment = snapKind === 'rotation' ? SNAP_ROT_INCREMENT : SNAP_POS_INCREMENT;
        v = Math.round(v / increment) * increment;
        // Reflect the snapped value back onto the slider itself, not just
        // the display — otherwise the handle position and the printed
        // number would visibly disagree while dragging.
        slider.value = v;
      }
      display.textContent = v.toFixed(2);
      this._handleTransformChange(field, v);
    });

    wrapperEl.appendChild(slider);
    wrapperEl.appendChild(display);
    row.appendChild(wrapperEl);
    return row;
  }

  /**
   * Update a single transform slider/readout from an external change
   * (e.g. viewport drag), mirroring updateParam()'s role for params.
   */
  updateTransformParam(field, value) {
    const input = this.el.querySelector(`[data-transform-field="${field}"]`);
    if (input) input.value = value;
    const display = this.el.querySelector(`[data-transform-display="${field}"]`);
    if (display) display.textContent = Number(value).toFixed(2);
  }

  _handleTransformChange(field, value) {
    this.nodeGraph.updateNodeTransform(this.node.id, field, value);
    if (this.onTransformChange) this.onTransformChange(this.node.id, field, value);
  }

  _handleParamChange(paramName, value) {
    this.nodeGraph.updateNodeParam(this.node.id, paramName, value);
    this.onParamChange(this.node.id, paramName, value);

    // Keep the rotation dial in sync with slider changes
    if (paramName === 'rotation' && this._drawRotationDial) {
      this._drawRotationDial(value);
    }

    const MAPPER_TYPES = new Set([
      'identityMapper','polynomialMapper','sinusoidalMapper','exponentialMapper',
      'logarithmicMapper','powerMapper','periodicMapper','temporalMapper',
      'recursiveMapper','blendedMapper','compositeMapper',
    ]);
    if (MAPPER_TYPES.has(this.node.type)) {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this._renderMapperPreview(), 150);
    } else if (this._previewCanvas && this.onRequestPreview) {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(
        () => this.onRequestPreview(this.node.id, this._previewCanvas), 150
      );
    }
  }

  // ── Drag to reposition ────────────────────────────────────────────────────

  _attachDrag() {
    const header = this.el.querySelector('[data-drag-handle]');
    if (!header) return;

    let startX, startY, startLeft, startTop;

    const onMouseMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = startLeft + dx;
      const newTop  = startTop  + dy;
      this.el.style.left = newLeft + 'px';
      this.el.style.top  = newTop  + 'px';
      // Fire drag event so EdgeRenderer can redraw edges live
      this.onDragEnd(this.node.id, newLeft, newTop);
    };

    const onMouseUp = (e) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
      header.style.cursor = 'grab';
      const finalLeft = parseFloat(this.el.style.left);
      const finalTop  = parseFloat(this.el.style.top);
      this.nodeGraph.updateNodePosition(this.node.id, finalLeft, finalTop);
      this.onDragEnd(this.node.id, finalLeft, finalTop);
    };

    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startX    = e.clientX;
      startY    = e.clientY;
      startLeft = parseFloat(this.el.style.left) || 0;
      startTop  = parseFloat(this.el.style.top)  || 0;
      header.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup',   onMouseUp);
    });
  }
}