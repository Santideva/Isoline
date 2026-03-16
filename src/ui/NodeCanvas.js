    // File: src/ui/NodeCanvas.js
    //
    // ── Data flow ────────────────────────────────────────────────────────────────
    // INPUT:
    //   - stateStore:   Read nodeGraph from it; listen to nodeGraph.onChange
    //   - sceneManager: Call .compose() or .evaluateAndRender() when params change
    //   - schurParams:  Current Schur composition params (passed from index.js)
    //   - renderParams: Current render method (passed from index.js)
    //
    // OUTPUT:
    //   - Mounts a full-screen overlay <div> onto document.body
    //   - Toggled by pressing Tab (or clicking the ✕ button)
    //   - Calls sceneManager methods to re-render when graph changes via the canvas
    //
    // Internal data flow:
    //   Tab keydown
    //     → _open() / _close()
    //     → if first open and needsLayout(graph): autoLayout → apply positions
    //     → _rebuildCards() creates one NodeCard per top-level node
    //     → EdgeRenderer.draw() draws all edges
    //
    //   NodeCard param change
    //     → nodeGraph.updateNodeParam()
    //     → _onParamChange() → sceneManager.compose() if schur exists
    //
    //   NodeCard drag
    //     → nodeGraph.updateNodePosition()
    //     → EdgeRenderer.draw() redraws edges at new positions
    //
    //   NodeCard port mousedown
    //     → _beginPendingEdge() stores drag state
    //     → document mousemove → EdgeRenderer.draw() with pending edge
    //     → NodeCard port mouseup → _completePendingEdge()
    //       → nodeGraph.addEdge() → _rebuildCards() + EdgeRenderer.draw()
    //
    //   nodeGraph.onChange (fired by any graph mutation)
    //     → _onGraphChange() → _rebuildCards() + EdgeRenderer.draw()
    //
    //   Scroll wheel / middle-mouse drag
    //     → _transform.scale / tx / ty updated
    //     → _applyTransform() on inner container + EdgeRenderer.draw()
    // ─────────────────────────────────────────────────────────────────────────────

    import { NodeCard }      from './NodeCard.js';
    import { EdgeRenderer }  from './EdgeRenderer.js';
    import { autoLayout, needsLayout, LAYOUT_DIRECTIONS } from './layouts.js';
    import { SchurComposition } from '../Primitives/SchurComposition.js';

    // Types that are shown as cards in the canvas
    const TOP_LEVEL_TYPES = new Set([
    'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
    'rUnion', 'rIntersection', 'rDifference', 'schurBlend', 'ifsBlend',
    'identityMapper', 'polynomialMapper', 'sinusoidalMapper',
    'exponentialMapper', 'logarithmicMapper', 'powerMapper',
    'periodicMapper', 'temporalMapper', 'recursiveMapper',
    'blendedMapper', 'compositeMapper',
    'affineTransform', 'tilingNode',
    'timeNode', 'oscillatorNode',
    'outputNode',
    ]);

    export class NodeCanvas {
    /**
     * @param {StateStore}   stateStore
     * @param {SceneManager} sceneManager
     * @param {object}       schurParams   reference to the schurParams object in index.js
     * @param {object}       renderParams  reference to the renderParams object in index.js
     */
    constructor(stateStore, sceneManager, schurParams, renderParams) {
        this.stateStore   = stateStore;
        this.sceneManager = sceneManager;
        this.schurParams  = schurParams;
        this.renderParams = renderParams;

        this._open           = false;
        this._cards          = new Map();
        this._layoutDir      = 'left-right';
        this._pendingEdge    = null;
        this._transform      = { tx: 0, ty: 0, scale: 1 };
        this._graphUnlisten  = null;
        this._selectedIds          = new Set();
        this._altDragging          = false;
        this._recomposeTimer       = null;
        this._viewportDragAttached = false;

        this._buildDOM();
        this._attachGlobalEvents();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    /** Programmatically open the canvas (e.g. from a menu button). */
    open() { this._doOpen(); }

    /** Programmatically close the canvas. */
    close() { this._doClose(); }

    // ── DOM construction ──────────────────────────────────────────────────────

    _buildDOM() {
        // ── Overlay root ──────────────────────────────────────────────────────
        this._overlay = document.createElement('div');
        this._overlay.id = 'node-canvas-overlay';
        this._overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: transparent;
        display: none;
        flex-direction: column;
        font-family: var(--font-sans, sans-serif);
        pointer-events: none;
        `;

        // ── Toolbar ───────────────────────────────────────────────────────────
        const toolbar = document.createElement('div');
        toolbar.style.cssText = `
        height: 40px;
        background: rgba(12,12,14,0.92);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex;
        align-items: center;
        padding: 0 12px;
        gap: 8px;
        flex-shrink: 0;
        pointer-events: auto;
        backdrop-filter: blur(4px);
        `;

        const title = document.createElement('span');
        title.textContent = 'Node Graph';
        title.style.cssText = 'font-size:13px; font-weight:500; color:rgba(255,255,255,0.7); margin-right:auto;';
        toolbar.appendChild(title);

        // Layout direction selector
        const layoutLabel = document.createElement('span');
        layoutLabel.textContent = 'Layout:';
        layoutLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(layoutLabel);

        this._layoutSelect = document.createElement('select');
        this._layoutSelect.style.cssText = `
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: rgba(255,255,255,0.8);
        font-size: 11px;
        padding: 2px 6px;
        `;
        LAYOUT_DIRECTIONS.forEach(dir => {
        const o = document.createElement('option');
        o.value = dir;
        o.textContent = dir;
        this._layoutSelect.appendChild(o);
        });
        this._layoutSelect.addEventListener('change', () => {
        this._layoutDir = this._layoutSelect.value;
        this._runAutoLayout();
        });
        toolbar.appendChild(this._layoutSelect);

        // Add Primitive dropdown
        const primLabel = document.createElement('span');
        primLabel.textContent = 'Add:';
        primLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(primLabel);

        this._primSelect = document.createElement('select');
        this._primSelect.style.cssText = `
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: rgba(255,255,255,0.8);
        font-size: 11px;
        padding: 2px 6px;
        `;
        ['Line', 'Triangle', 'Arc', 'Circle', 'Polygon', 'Polytope'].forEach(t => {
        const o = document.createElement('option');
        o.value = t.toLowerCase();
        o.textContent = t;
        this._primSelect.appendChild(o);
        });
        toolbar.appendChild(this._primSelect);

        const addBtn = this._makeButton('Add Primitive', () => {
        this.sceneManager.addPrimitive(this._primSelect.value);
        // Rebuild cards after a tick so the new node is in the graph
        setTimeout(() => {
            this._runAutoLayout();
            this._drawEdges();
        }, 50);
        });
        toolbar.appendChild(addBtn);

        // Remove Last button
        const removeBtn = this._makeButton('Remove Last', () => {
        this.sceneManager.removeLast();
        setTimeout(() => {
            this._rebuildCards();
            this._drawEdges();
        }, 50);
        });
        toolbar.appendChild(removeBtn);

        // Clear All button
        const clearBtn = this._makeButton('Clear All', () => {
        if (!confirm('Clear all primitives and compositions?')) return;
        this._clearAll();
        });
        clearBtn.style.cssText += 'border-color: rgba(255,80,80,0.4); color: rgba(255,160,160,0.9);';
        toolbar.appendChild(clearBtn);

        // Auto-layout button
        const autoBtn = this._makeButton('Auto Layout', () => this._runAutoLayout());
        toolbar.appendChild(autoBtn);

        // Operation selector for compose
        this._composeOperation = 'union';
        const opLabel = document.createElement('span');
        opLabel.textContent = 'Op:';
        opLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(opLabel);

        const opSelect = document.createElement('select');
        opSelect.style.cssText = `
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: rgba(255,255,255,0.8);
        font-size: 11px;
        padding: 2px 6px;
        `;
        ['union','intersection','difference'].forEach(op => {
        const o = document.createElement('option');
        o.value = op;
        o.textContent = op;
        opSelect.appendChild(o);
        });
        opSelect.addEventListener('change', () => {
        this._composeOperation = opSelect.value;
        });
        toolbar.appendChild(opSelect);

        // Compose button
        const composeBtn = this._makeButton('⬡ Compose', () => this._compose());
        composeBtn.style.cssText += 'background: rgba(83,58,183,0.4); border-color: rgba(150,130,255,0.4);';
        toolbar.appendChild(composeBtn);

        // Fit to screen button
        const fitBtn = this._makeButton('Fit', () => this._fitToScreen());
        toolbar.appendChild(fitBtn);

        // Close button
        const closeBtn = this._makeButton('✕ Close  [Tab]', () => this._doClose());
        closeBtn.style.marginLeft = '4px';
        toolbar.appendChild(closeBtn);

        this._overlay.appendChild(toolbar);

        // ── Canvas area ───────────────────────────────────────────────────────
        const canvasArea = document.createElement('div');
        canvasArea.style.cssText = `
        flex: 1;
        position: relative;
        overflow: hidden;
        cursor: default;
        pointer-events: none;
        `;

        // Background canvas (grid + edges)
        this._bgCanvas = document.createElement('canvas');
        this._bgCanvas.style.cssText = `
        position: absolute;
        inset: 0;
        pointer-events: none;
        `;
        canvasArea.appendChild(this._bgCanvas);

        this._inner = document.createElement('div');
        this._inner.className  = 'nc-canvas-inner';
        this._inner.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        transform-origin: 0 0;
        pointer-events: none;
        `;
        canvasArea.appendChild(this._inner);

        this._overlay.appendChild(canvasArea);
        document.body.appendChild(this._overlay);

        // ── EdgeRenderer ──────────────────────────────────────────────────────
        this._edgeRenderer = new EdgeRenderer(
        this._bgCanvas,
        this.stateStore.nodeGraph,
        (nodeId, portName, dir) => this._getPortPosition(nodeId, portName, dir)
        );

        // ── Pan/zoom on canvas area ───────────────────────────────────────────
        this._attachPanZoom(canvasArea);
    }

    _makeButton(text, onClick) {
        const btn = document.createElement('button');
        btn.textContent  = text;
        btn.style.cssText = `
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: rgba(255,255,255,0.75);
        font-size: 11px;
        padding: 3px 10px;
        cursor: pointer;
        `;
        btn.addEventListener('click', onClick);
        return btn;
    }

    // ── Open / close ──────────────────────────────────────────────────────────

    _doOpen() {
        if (this._open) return;
        this._open = true;

        this._overlay.style.display = 'flex';
        this._resizeCanvas();

        // Viewport stays full screen — the overlay is transparent and
        // pointer-events on the background pass through to OrbitControls.

        // Hide dat.GUI while canvas is open
        const gui = document.querySelector('.dg.ac');
        if (gui) gui.style.display = 'none';

        // Hide the base-shapes panel and compose button
        const basePanel = document.getElementById('base-shapes');
        const composeBtn = document.getElementById('compose-btn');
        if (basePanel) basePanel.closest('div')?.style && (basePanel.closest('div').style.display = 'none');
        if (composeBtn) composeBtn.style.display = 'none';

        // Attach graph change listener
        this._graphUnlisten = this.stateStore.nodeGraph.onChange(
        (event) => this._onGraphChange(event)
        );
        this._edgeRenderer.setGraph(this.stateStore.nodeGraph);

        // Attach viewport drag once
        if (!this._viewportDragAttached) {
        this._attachViewportDrag();
        this._viewportDragAttached = true;
        }

        // Auto-layout on first open, or if new nodes have been added at origin
        this._rebuildCards();
        if (needsLayout(this.stateStore.nodeGraph)) {
        this._runAutoLayout();
        }
        this._drawEdges();
        // Always fit to screen on open so all cards are visible
        requestAnimationFrame(() => this._fitToScreen());
    }

    _doClose() {
        if (!this._open) return;
        this._open = false;

        this._overlay.style.display = 'none';

        // Nothing to restore — viewport was never resized.

        // Restore dat.GUI
        const gui = document.querySelector('.dg.ac');
        if (gui) gui.style.display = '';

        // Restore base-shapes panel
        const basePanel = document.getElementById('base-shapes');
        const composeBtn = document.getElementById('compose-btn');
        if (basePanel) basePanel.closest('div')?.style && (basePanel.closest('div').style.display = '');
        if (composeBtn) composeBtn.style.display = '';

        if (this._graphUnlisten) {
        this._graphUnlisten();
        this._graphUnlisten = null;
        }
    }

    // ── Layout ────────────────────────────────────────────────────────────────

    _runAutoLayout() {
        const positions = autoLayout(this.stateStore.nodeGraph, this._layoutDir);
        positions.forEach((pos, nodeId) => {
        this.stateStore.nodeGraph.updateNodePosition(nodeId, pos.x, pos.y);
        });
        this._rebuildCards();
        this._drawEdges();
    }

    // ── Card management ───────────────────────────────────────────────────────

    _rebuildCards() {
        // Remove existing cards
        this._cards.forEach(card => card.el.remove());
        this._cards.clear();

        // Create one card per top-level node
        this.stateStore.nodeGraph.nodes.forEach((node, id) => {
        if (!TOP_LEVEL_TYPES.has(node.type)) return;

        const card = new NodeCard(
            node,
            this.stateStore.nodeGraph,
            (nodeId, paramName, value) => this._onParamChange(nodeId, paramName, value),
            (nodeId, portName, dir, pos) => this._beginPendingEdge(nodeId, portName, dir, pos),
            (nodeId, portName, dir) => this._completePendingEdge(nodeId, portName, dir),
            (nodeId, x, y) => { this._drawEdges(); },
            (nodeId, previewCanvas) => this._renderSDFPreview(nodeId, previewCanvas)
        );

        // Select on header click
        const header = card.el.querySelector('[data-drag-handle]');
        if (header) {
            header.addEventListener('mousedown', (e) => {
            this._setSelected(node.id, e.shiftKey);
            });
        }

        this._cards.set(id, card);
        this._inner.appendChild(card.el);
        });

        // Restore selection outlines for any IDs still in _selectedIds
        this._selectedIds.forEach(selectedId => {
            const card = this._cards.get(selectedId);
            if (card) {
                card.el.style.outline = '2px solid rgba(100,180,255,0.8)';
                card.el.style.outlineOffset = '2px';
            } else {
                // Node no longer exists — remove stale ID
                this._selectedIds.delete(selectedId);
            }
        });
    }

    _setSelected(nodeId, addToSelection = false) {
        if (!addToSelection) {
        // Deselect all first
        this._selectedIds.forEach(id => {
            const card = this._cards.get(id);
            if (card) card.el.style.outline = '';
        });
        this._selectedIds.clear();
        }

        if (nodeId === null) return;

        this._selectedIds.add(nodeId);
        const card = this._cards.get(nodeId);
        if (card) {
        card.el.style.outline = '2px solid rgba(100,180,255,0.8)';
        card.el.style.outlineOffset = '2px';
        }
    }  

    _attachViewportDrag() {
        const renderer = this.sceneManager.renderer.domElement;
        let isDragging = false;
        let lastX, lastY;

        // World units per pixel — matches OrbitControls pan speed exactly
        // so alt+drag feels identical to plain drag but for one shape only
        const pixelToWorld = () => {
        const cam    = this.sceneManager.camera;
        const dist   = cam.position.distanceTo(
            this.sceneManager.controls.target
        );
        const fov    = cam.fov * (Math.PI / 180);
        return (2 * Math.tan(fov / 2) * dist) / renderer.clientHeight;
        };

        renderer.addEventListener('mousedown', (e) => {
        if (!e.altKey || this._selectedIds.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Disable OrbitControls so the camera does not move during shape drag
        this.sceneManager.controls.enabled = false;
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        renderer.style.cursor = 'move';
        });

        document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const scale = pixelToWorld();
        const dx =  (e.clientX - lastX) * scale;
        const dy = -(e.clientY - lastY) * scale;
        lastX = e.clientX;
        lastY = e.clientY;

        // Move all selected shapes
        this._selectedIds.forEach(nodeId => {
            const node  = this.stateStore.nodeGraph.nodes.get(nodeId);
            const shape = this.stateStore.getShape(nodeId);
            if (!node || !shape) return;

            const newX = (node.params.posX || 0) + dx;
            const newY = (node.params.posY || 0) + dy;

            // Update node graph record
            this.stateStore.nodeGraph.updateNodeParam(nodeId, 'posX', newX);
            this.stateStore.nodeGraph.updateNodeParam(nodeId, 'posY', newY);

            // Update card slider display
            const card = this._cards.get(nodeId);
            if (card) {
            card.updateParam('posX', newX);
            card.updateParam('posY', newY);
            }

            // Update the live shape instance
            if (typeof shape.updateParameters === 'function') {
            shape.updateParameters({ position: { x: newX, y: newY } });
            this.stateStore.triggerVisualUpdate(nodeId);
            }
        });

        // Re-render after movement settles
        clearTimeout(this._recomposeTimer);
        this._recomposeTimer = setTimeout(() => {
            if (this.sceneManager.currentSchur) {
            const current = this.sceneManager.currentSchur.instance;
            this.sceneManager.rerender(
                this.renderParams.method,
                pt => current.computeSDF(pt)
            );
            }
        }, 150);
        });

        document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            // Re-enable OrbitControls after shape drag completes
            this.sceneManager.controls.enabled = true;
            renderer.style.cursor = '';
        }
        });
    }  

    // ── Edge drawing ──────────────────────────────────────────────────────────

    _drawEdges() {
        // Small delay to let DOM layout settle so getBoundingClientRect is accurate
        requestAnimationFrame(() => {
        this._edgeRenderer.draw(this._transform);
        });
    }

    _getPortPosition(nodeId, portName, dir) {
        const card = this._cards.get(nodeId);
        if (!card) return null;
        return card.getPortPosition(portName, dir);
    }

    // ── Drag-connect (pending edge) ───────────────────────────────────────────

    _beginPendingEdge(nodeId, portName, dir, screenPos) {
        // Convert screen pos to canvas-inner coords
        const innerRect = this._inner.getBoundingClientRect();
        const x = (screenPos.x - innerRect.left) / this._transform.scale;
        const y = (screenPos.y - innerRect.top)  / this._transform.scale;

        this._pendingEdge = { nodeId, portName, dir, x1: x, y1: y, x2: x, y2: y };

        const onMouseMove = (e) => {
        const dx = (e.clientX - innerRect.left) / this._transform.scale;
        const dy = (e.clientY - innerRect.top)  / this._transform.scale;
        this._pendingEdge.x2 = dx;
        this._pendingEdge.y2 = dy;
        this._edgeRenderer.setPendingEdge({
            x1: this._pendingEdge.x1,
            y1: this._pendingEdge.y1,
            x2: dx,
            y2: dy,
            color: '#888'
        });
        this._drawEdges();
        };

        const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        this._edgeRenderer.setPendingEdge(null);
        this._pendingEdge = null;
        this._drawEdges();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup',   onMouseUp);
    }

    _completePendingEdge(toNodeId, toPortName, toDir) {
        if (!this._pendingEdge) return;
        const { nodeId: fromNodeId, portName: fromPortName, dir: fromDir } = this._pendingEdge;

        // Connection must go from OUT to IN
        const outNodeId  = fromDir === 'out' ? fromNodeId : toNodeId;
        const outPort    = fromDir === 'out' ? fromPortName : toPortName;
        const inNodeId   = fromDir === 'in'  ? fromNodeId : toNodeId;
        const inPort     = fromDir === 'in'  ? fromPortName : toPortName;

        try {
        this.stateStore.nodeGraph.addEdge(outNodeId, outPort, inNodeId, inPort);
        // _onGraphChange will rebuild cards and redraw
        } catch (e) {
        console.warn('NodeCanvas: Could not connect ports:', e.message);
        }
    }

    // ── Param change handler ──────────────────────────────────────────────────

    _onParamChange(nodeId, paramName, value) {
        const node  = this.stateStore.nodeGraph.nodes.get(nodeId);
        const shape = this.stateStore.getShape(nodeId);

        if (!node) return;

        // Update the live shape instance for ALL node types that have
        // updateParameters — this includes both geometry and schurBlend nodes.
        if (shape && typeof shape.updateParameters === 'function') {
        const params = this._buildShapeParams(node, paramName, value);
        shape.updateParameters(params);
        this.stateStore.triggerVisualUpdate(nodeId);
        }

        // Sync schurParams with the LAST schurBlend node's values so dat.GUI
        // stays consistent (legacy compatibility — removed in Task 3.6)
        if (node.type === 'schurBlend') {
        if (paramName === 'operation')  this.schurParams.operations = [value];
        if (paramName === 'smoothness') this.schurParams.weight      = value;
        if (paramName === 'rotation')   this.schurParams.rotation    = value;
        if (paramName === 'scale')      this.schurParams.scale       = value;
        if (paramName === 'posX')       this.schurParams.posX        = value;
        if (paramName === 'posY')       this.schurParams.posY        = value;
        if (paramName === 'isoOffset')  this.schurParams.isoOffset   = value;
        }

        // Re-render after param change
        if (this.sceneManager.currentSchur) {
        clearTimeout(this._recomposeTimer);
        this._recomposeTimer = setTimeout(() => {
            // For cascade compositions, re-render using the existing instance
            // directly — do NOT call compose() which would rebuild the cascade.
            const current = this.sceneManager.currentSchur.instance;
            this.sceneManager.rerender(
            this.renderParams.method,
            pt => current.computeSDF(pt)
            );
        }, 300);
        }
    }

    _buildShapeParams(node, paramName, value) {
        if (paramName === 'posX') {
        return { position: { x: value, y: node.params.posY || 0 } };
        }
        if (paramName === 'posY') {
        return { position: { x: node.params.posX || 0, y: value } };
        }
        // lineSegment nodes use x1,y1,x2,y2 directly
        if (['x1','y1','x2','y2'].includes(paramName)) {
        return { [paramName]: value };
        }
        return { [paramName]: value };
    }

    // ── Graph change handler ──────────────────────────────────────────────────

    _clearAll() {
        // 1. Remove currentSchur from scene
        if (this.sceneManager.currentSchur) {
        this.sceneManager._removeFromScene(this.sceneManager.currentSchur);
        this.sceneManager.currentSchur = null;
        }

        // 2. Remove all activePrimitives from scene
        this.sceneManager.activePrimitives.forEach(p => {
        this.sceneManager._removeFromScene(p);
        });
        this.sceneManager.activePrimitives = [];

        // 3. Wipe the entire stateStore — clears sessionShapes and resets nodeGraph
        this.stateStore.clear();

        // 4. Point the evaluator at the fresh nodeGraph
        this.sceneManager.evaluator.graph = this.stateStore.nodeGraph;
        this.sceneManager.evaluator.invalidate();

        // 5. Rebuild the canvas
        setTimeout(() => {
        this._rebuildCards();
        this._drawEdges();
        }, 50);
    }

    _compose() {
        const GEOM_TYPES = new Set([
      'triangle','arc','lineSegment','circle','regularPolygon','polytope'
    ]);

        // Collect base shape instances
        const bases = [];
        this.stateStore.nodeGraph.nodes.forEach((node, id) => {
        if (!GEOM_TYPES.has(node.type)) return;
        const shape = this.stateStore.getShape(id);
        if (shape) bases.push(shape);
        });

        if (bases.length < 2) {
        alert('Add at least two primitives first.');
        return;
        }

        // Clear existing composition
        if (this.sceneManager.currentSchur) {
        this.sceneManager._removeFromScene(this.sceneManager.currentSchur);
        this.stateStore.removeShape(this.sceneManager.currentSchur.instance.id);
        this.sceneManager.currentSchur = null;
        }

        const op         = this._composeOperation || 'union';
        const smoothness = this.schurParams.weight     || 8;
        const isoOffset  = this.schurParams.isoOffset  || 0.15;

        // Left-fold cascade: ((A op B) op C) op D ...
        let current = bases[0];
        for (let i = 1; i < bases.length; i++) {
        const next = new SchurComposition({
            shapes:          [current, bases[i]],
            operations:      [op],
            weights:         [smoothness],
            rotation:        this.schurParams.rotation || 0,
            scale:           this.schurParams.scale    || 1,
            position:        { x: this.schurParams.posX || 0,
                            y: this.schurParams.posY || 0 },
            blendSmoothness: smoothness,
            isoOffset,
            color:           { h: 0, s: 0, l: 0.8, a: 1 },
            onDependencyUpdate: (id, childIds) =>
            this.stateStore._updateDependencies(id, childIds)
        });
        this.stateStore.addShape(next);
        current = next;
        }

        // For cascade compositions, only wire the final result → outputNode.
        // The intermediate SchurComposition structure lives in memory only.
        // For 2-shape compositions, wire normally so the evaluator can use it.
        if (bases.length === 2) {
        this.sceneManager._wireCompositionGraph(current, bases);
        } else {
        // Just ensure outputNode exists and wire final result to it
        const outputNode = this.sceneManager._ensureOutputNode();
        try {
            this.stateStore.nodeGraph.addEdge(
            current.id, 'result', outputNode.id, 'sdf'
            );
        } catch (e) { /* edge may already exist */ }
        }
        this.sceneManager.evaluator.invalidate();

        // Bypass the evaluator — the cascade structure lives in the
        // SchurComposition instances, not in the flat node graph.
        const threeObj = this.sceneManager._buildSchurObject(
        current, this.renderParams.method,
        pt => current.computeSDF(pt)
        );
        const entry = { instance: current, type: 'schur', object: threeObj };
        this.sceneManager.currentSchur = entry;
        this.sceneManager._addToScene(entry);

        // Clear selection after compose so no stale IDs remain in _selectedIds
        this._setSelected(null);
        setTimeout(() => { this._runAutoLayout(); this._drawEdges(); }, 100);
    }

    _renderSDFPreview(nodeId, previewCanvas) {
        import('./previewRenderer.js').then(({ drawSDFPreview }) => {
        try {
            const evaluator = this.sceneManager.evaluator;
            evaluator.invalidate();
            const result = evaluator.evaluate(nodeId);
            const sdfFn  = result?.sdf || result?.result;
            if (typeof sdfFn !== 'function') return;
            drawSDFPreview(previewCanvas, sdfFn, [-2.5, -2.5, 2.5, 2.5]);
        } catch (e) {
            // Silently ignore — preview errors never affect the main render
        }
        });
    }

    _onGraphChange(event) {
        // Rebuild cards and redraw edges whenever the graph structure changes.
        // Parameter changes (paramChanged) don't need a full rebuild.
        if (event === 'nodeAdded' || event === 'nodeRemoved' ||
            event === 'edgeAdded' || event === 'edgeRemoved') {
        this._rebuildCards();
        }
        this._drawEdges();
    }

    // ── Pan and zoom ──────────────────────────────────────────────────────────

    _attachPanZoom(canvasArea) {
        let isPanning = false;
        let panStart  = { x: 0, y: 0 };
        let panOrigin = { tx: 0, ty: 0 };

        // Middle mouse or space+drag to pan
        canvasArea.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            e.preventDefault();
            isPanning = true;
            panStart  = { x: e.clientX, y: e.clientY };
            panOrigin = { tx: this._transform.tx, ty: this._transform.ty };
            canvasArea.style.cursor = 'grabbing';
        }
        });

        document.addEventListener('mousemove', (e) => {
        if (!isPanning || !this._open) return;
        this._transform.tx = panOrigin.tx + (e.clientX - panStart.x);
        this._transform.ty = panOrigin.ty + (e.clientY - panStart.y);
        this._applyTransform();
        this._drawEdges();
        });

        document.addEventListener('mouseup', () => {
        if (isPanning) {
            isPanning = false;
            canvasArea.style.cursor = 'default';
        }
        });

        // Scroll to zoom
        canvasArea.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta  = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.2, Math.min(3.0, this._transform.scale * delta));

        // Zoom toward mouse position
        const rect   = canvasArea.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        this._transform.tx = mouseX - (mouseX - this._transform.tx) * (newScale / this._transform.scale);
        this._transform.ty = mouseY - (mouseY - this._transform.ty) * (newScale / this._transform.scale);
        this._transform.scale = newScale;

        this._applyTransform();
        this._drawEdges();
        }, { passive: false });
    }

    _applyTransform() {
        const { tx, ty, scale } = this._transform;
        this._inner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    }

    _fitToScreen() {
        if (this._cards.size === 0) return;

        // Find bounding box of all cards
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this._cards.forEach((card) => {
        const x = parseFloat(card.el.style.left) || 0;
        const y = parseFloat(card.el.style.top)  || 0;
        const w = card.el.offsetWidth  || 220;
        const h = card.el.offsetHeight || 160;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
        });

        const contentW = maxX - minX + 80;
        const contentH = maxY - minY + 80;
        const areaW    = this._bgCanvas.width;
        const areaH    = this._bgCanvas.height;
        const scale    = Math.min(areaW / contentW, areaH / contentH, 1.5);

        this._transform = {
        tx:    (areaW - contentW * scale) / 2 - minX * scale + 40,
        ty:    (areaH - contentH * scale) / 2 - minY * scale + 40,
        scale,
        };

        this._applyTransform();
        this._drawEdges();
    }

    // ── Canvas resize ─────────────────────────────────────────────────────────

    _resizeCanvas() {
        const area = this._bgCanvas.parentElement;
        if (!area) return;
        const rect = area.getBoundingClientRect();
        this._bgCanvas.width  = rect.width;
        this._bgCanvas.height = rect.height;
    }

    // ── Global event listeners ────────────────────────────────────────────────

    _attachGlobalEvents() {
        document.addEventListener('keydown', (e) => {
        // Don't intercept keys inside input fields
        if (document.activeElement.tagName === 'INPUT'    ||
            document.activeElement.tagName === 'TEXTAREA' ||
            document.activeElement.tagName === 'SELECT') return;

        // Tab toggles the node canvas overlay
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            this._open ? this._doClose() : this._doOpen();
        }

        // Escape: deselect if anything selected, close if nothing selected
        if (e.key === 'Escape' && this._open) {
            if (this._selectedIds.size > 0) {
            this._setSelected(null);
            } else {
            this._doClose();
            }
        }
        });

        // Resize canvas when window resizes
        window.addEventListener('resize', () => {
        if (this._open) {
            this._resizeCanvas();
            this._drawEdges();
        }
        });
    }
    }