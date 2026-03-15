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

// Card dimensions — must match CARD_WIDTH/CARD_HEIGHT in layouts.js
const CARD_W     = 220;
const PORT_R     = 6;    // port dot radius in px
const PORT_D     = PORT_R * 2;

export class NodeCard {
  /**
   * @param {object}   node            NodeInstance from NodeGraph
   * @param {NodeGraph} nodeGraph
   * @param {Function} onParamChange   (nodeId, paramName, value) → void
   * @param {Function} onPortMouseDown (nodeId, portName, dir, {x,y}) → void
   * @param {Function} onPortMouseUp   (nodeId, portName, dir) → void
   * @param {Function} onDragEnd       (nodeId, x, y) → void
   */
  constructor(node, nodeGraph, onParamChange, onPortMouseDown, onPortMouseUp, onDragEnd, onRequestPreview) {
    this.node             = node;
    this.nodeGraph        = nodeGraph;
    this.onParamChange    = onParamChange;
    this.onPortMouseDown  = onPortMouseDown;
    this.onPortMouseUp    = onPortMouseUp;
    this.onDragEnd        = onDragEnd;
    this.onRequestPreview = onRequestPreview || null;

    this._portEls       = new Map();
    this._previewCanvas = null;
    this._previewTimer  = null;

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
    card.appendChild(this._buildBody(spec));

    const preview = this._buildPreview(spec);
    if (preview) card.appendChild(preview);

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

    const label = document.createElement('span');
    label.textContent = spec?.label || this.node.type;
    header.appendChild(label);

    const idBadge = document.createElement('span');
    idBadge.textContent = `#${this.node.id}`;
    idBadge.style.cssText = 'opacity:0.6; font-size:10px;';
    header.appendChild(idBadge);

    return header;
  }

  _buildPreview(spec) {
    if (!spec) return null;

    const PREVIEW_W = 200;

    const SDF_TYPES = new Set([
      'lineSegment','triangle','arc','circle','regularPolygon',
      'rUnion','rIntersection','rDifference','schurBlend','ifsBlend',
    ]);
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

      // Only add rotation handle for types that have a rotation param
      const ROTATABLE = new Set(['triangle','arc','regularPolygon','circle']);
      if (ROTATABLE.has(this.node.type)) {
        wrapper.appendChild(this._buildRotationHandle());
      }

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

    const dot = document.createElement('div');
    dot.style.cssText = `
      width:  ${PORT_D}px;
      height: ${PORT_D}px;
      border-radius: 50%;
      background: ${PORT_COLORS[portSpec.type] || '#888'};
      border: 2px solid rgba(255,255,255,0.25);
      cursor: crosshair;
      flex-shrink: 0;
      ${direction === 'in'  ? 'margin-left:  -' + PORT_R + 'px;' : ''}
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
        case 'polynomialMapper':  fn = DM.createPolynomialMapping([p.c0??0, p.c1??1, p.c2??0, p.c3??0]); break;
        case 'sinusoidalMapper':  fn = DM.createSinusoidalMapping(p.a??1, p.b??1, p.c??0, p.e??0); break;
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

    // Show a crosshair cursor to indicate this is a drag surface
    canvas.style.cursor = 'crosshair';

    const toDelta = (px) => (px / canvas.offsetWidth) * WORLD_SIZE;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      isDragging  = true;
      startX      = e.clientX;
      startY      = e.clientY;
      startPosX   = this.node.params.posX || 0;
      startPosY   = this.node.params.posY || 0;
      canvas.style.cursor = 'grabbing';
    });

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx    =  toDelta(e.clientX - startX);
      const dy    = -toDelta(e.clientY - startY);  // invert Y: screen down = world down
      const newX  = startPosX + dx;
      const newY  = startPosY + dy;

      // Update node params so slider stays in sync
      this.nodeGraph.updateNodeParam(this.node.id, 'posX', newX);
      this.nodeGraph.updateNodeParam(this.node.id, 'posY', newY);

      // Update slider display values
      this.updateParam('posX', newX);
      this.updateParam('posY', newY);

      // Fire the param change callback (triggers shape.updateParameters + recompose)
      this.onParamChange(this.node.id, 'posX', newX);
      this.onParamChange(this.node.id, 'posY', newY);

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

    const label = document.createElement('label');
    label.textContent = paramSpec.name;
    label.style.cssText = 'font-size:11px; opacity:0.75; min-width:50px; flex-shrink:0;';

    row.appendChild(label);
    row.appendChild(this._buildParamControl(paramSpec));
    return row;
  }

  _buildParamControl(paramSpec) {
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

    // Number — slider + numeric display
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; align-items:center; gap:4px; flex:1; min-width:0;';

    const slider = document.createElement('input');
    slider.type       = 'range';
    slider.dataset.param = paramSpec.name;
    slider.min        = paramSpec.min  ?? 0;
    slider.max        = paramSpec.max  ?? 10;
    slider.step       = paramSpec.step ?? 0.01;
    slider.value      = currentValue;
    slider.style.cssText = 'flex:1; min-width:0; height:14px; accent-color: #378ADD;';

    const display = document.createElement('span');
    display.dataset.paramDisplay = paramSpec.name;
    display.textContent = typeof currentValue === 'number'
      ? currentValue.toFixed(2)
      : currentValue;
    display.style.cssText = 'font-size:10px; opacity:0.8; min-width:32px; text-align:right; font-variant-numeric:tabular-nums;';

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      display.textContent = v.toFixed(2);
      this._handleParamChange(paramSpec.name, v);
    });

    wrapper.appendChild(slider);
    wrapper.appendChild(display);
    return wrapper;
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