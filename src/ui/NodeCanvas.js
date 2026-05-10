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
    import { saveScene, loadScene, listScenes } from '../persistence.js';

    // Types that are shown as cards in the canvas
    const TOP_LEVEL_TYPES = new Set([
    'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
    'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane',
    'extrudeNode', 'revolveNode',
    'noiseDisplaceNode', 'twistNode', 'bendNode', 'repeatNode','rUnion', 'rIntersection', 'rDifference', 'schurBlend', 'ifsBlend',
    'identityMapper', 'polynomialMapper', 'sinusoidalMapper',
    'exponentialMapper', 'logarithmicMapper', 'powerMapper',
    'periodicMapper', 'temporalMapper', 'recursiveMapper',
    'blendedMapper', 'compositeMapper',
    'affineTransform', 'tilingNode', 'mobiusNode',
    'symmetryFoldNode', 'symmetryOrbitNode',
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
        ['Line', 'Triangle', 'Arc', 'Circle', 'Polygon', 'Polytope',
         'Sphere', 'Box', 'Cylinder', 'Capsule', 'Torus',
         'Cone', 'Plane'].forEach(t => {
        const o = document.createElement('option');
        o.value = t.toLowerCase();
        o.textContent = t;
        this._primSelect.appendChild(o);
        });
        toolbar.appendChild(this._primSelect);

        const addBtn = this._makeButton('Add Primitive', () => {
          this.sceneManager.addPrimitive(this._primSelect.value);
          setTimeout(() => {
            this._runAutoLayout();
            this._drawEdges();
          }, 50);
        });
        toolbar.appendChild(addBtn);

        // Transform node dropdown
        const xformLabel = document.createElement('span');
        xformLabel.textContent = 'Transform:';
        xformLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(xformLabel);

        this._xformSelect = document.createElement('select');
        this._xformSelect.style.cssText = `
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          font-size: 11px;
          padding: 2px 6px;
        `;
        ['Extrude','Revolve','Tiling','SymmetryFold','SymmetryOrbit',
         'Möbius','NoiseDisplace','Twist','Bend','Repeat'].forEach(t => {
          const o = document.createElement('option');
          o.value = t.toLowerCase().replace('ö','o');
          o.textContent = t;
          this._xformSelect.appendChild(o);
        });
        toolbar.appendChild(this._xformSelect);

        const addXformBtn = this._makeButton('Add Transform', () => {
          this._addTransformNode(this._xformSelect.value);
        });
        toolbar.appendChild(addXformBtn);

        // ── Blend node dropdown + button ──────────────────────────────────────
        const blendLabel = document.createElement('span');
        blendLabel.textContent = 'Blend:';
        blendLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(blendLabel);

        this._blendSelect = document.createElement('select');
        this._blendSelect.style.cssText = `
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          font-size: 11px;
          padding: 2px 6px;
        `;
        [
          ['schurBlend',    'Schur Blend'],
          ['rUnion',        'R-Union'],
          ['rIntersection', 'R-Intersection'],
          ['rDifference',   'R-Difference'],
        ].forEach(([val, label]) => {
          const o = document.createElement('option');
          o.value = val;
          o.textContent = label;
          this._blendSelect.appendChild(o);
        });
        toolbar.appendChild(this._blendSelect);

        const addBlendBtn = this._makeButton('Add Blend', () => {
          this._addBlendNode(this._blendSelect.value);
        });
        addBlendBtn.style.cssText +=
          'border-color: rgba(180,100,255,0.5); color: rgba(210,160,255,0.9);';
        toolbar.appendChild(addBlendBtn);

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

        // Operation defaults (used by legacy _compose() only)
        this._composeOperation = 'union';

        // Compose button
        const composeBtn = this._makeButton('⬡ Compose', () => this._compose());
        composeBtn.style.cssText += 'background: rgba(83,58,183,0.4); border-color: rgba(150,130,255,0.4);';
        toolbar.appendChild(composeBtn);

        
        // Iso-step slider (visible only in GLSL mode)
        const isoLabel = document.createElement('span');
        isoLabel.textContent = 'Iso:';
        isoLabel.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(isoLabel);

        this._isoSlider = document.createElement('input');
        this._isoSlider.type  = 'range';
        this._isoSlider.min   = '0.1';
        this._isoSlider.max   = '2.0';
        this._isoSlider.step  = '0.05';
        this._isoSlider.value = '0.5';
        this._isoSlider.style.cssText = 'width:80px; cursor:pointer;';
        this._isoSlider.addEventListener('input', () => {
        const v = parseFloat(this._isoSlider.value);
        this.sceneManager.sdfRenderer.setIsoStep(v);
        if (this.sceneManager.renderMode === 'glsl') {
            this.sceneManager._renderGLSL();
        }
        });
        toolbar.appendChild(this._isoSlider);

        // Render mode toggle
        this._renderModeBtn = this._makeButton('⬛ GLSL Mode', () => this._toggleRenderMode());
        this._renderModeBtn.style.cssText += 'border-color: rgba(80,200,120,0.4); color: rgba(160,255,180,0.9);';
        toolbar.appendChild(this._renderModeBtn);

        // Fit to screen button
        const fitBtn = this._makeButton('Fit', () => this._fitToScreen());
        toolbar.appendChild(fitBtn);

        // Save button
    const saveBtn = this._makeButton('💾 Save', async () => {
      const name = prompt('Scene name:', 'autosave');
      if (!name) return;
      const ok = await saveScene(
        this.stateStore.nodeGraph,
        name,
        { renderMode: this.sceneManager.renderMode }
      );
      if (ok) {
        saveBtn.textContent = '✓ Saved';
        setTimeout(() => { saveBtn.textContent = '💾 Save'; }, 1500);
      }
    });
    saveBtn.style.cssText += 'border-color: rgba(80,180,80,0.4); color: rgba(160,255,160,0.9);';
    toolbar.appendChild(saveBtn);

    // Load button
    const loadBtn = this._makeButton('📂 Load', async () => {
      const names = await listScenes();
      if (names.length === 0) {
        alert('No saved scenes found.');
        return;
      }
      const name = prompt(`Available scenes:\n${names.join(', ')}\n\nLoad scene:`, names[0]);
      if (!name) return;

      // Clear current state first
      this._clearAll();

      const loadedData = await loadScene(name, this.stateStore.nodeGraph);
      if (!loadedData) {
        alert(`Could not load scene "${name}"`);
        return;
      }

      // ── Rebuild Three.js visual objects from the restored graph ───────────
      // deserialize() restores node graph structure but does not create
      // Three.js meshes or populate sceneManager.activePrimitives.
      // We iterate geometry nodes and call addPrimitive with the stored params
      // so rendered objects appear in the viewport.
      const graph = this.stateStore.nodeGraph;
      const GEOM_TYPES = new Set([
        'circle','regularPolygon','triangle','arc','polytope','lineSegment',
        'sphere','box','cylinder','capsule','torus','cone','plane'
      ]);

      graph.nodes.forEach((node, id) => {
        if (!GEOM_TYPES.has(node.type)) return;

        // addPrimitive creates the instance and mesh with a fresh ID,
        // but we need the instance to use the SAME ID as the graph node
        // so that graph edges remain valid.
        // Strategy: call the primitive constructor directly and register it
        // rather than going through addPrimitive (which allocates a new ID).
        try {
          const entry = this.sceneManager._rebuildPrimitiveFromNode(node);
          if (entry) {
            this.sceneManager.activePrimitives.push(entry);
            this.sceneManager._addToScene(entry);
          }
        } catch(e) {
          console.warn(`Could not rebuild primitive for node ${id} (${node.type}):`, e.message);
        }
      });

      // Point evaluators at the restored graph
      this.sceneManager.evaluator.graph       = graph;
      this.sceneManager.evaluator.invalidate();
      this.sceneManager.glslEvaluator.graph   = graph;
      this.sceneManager._lastGLSLSource       = null;
      this.sceneManager._lastRayMarchSource   = null;

      const savedMode = loadedData?.renderMode || 'marchingSquares';

      setTimeout(() => {
        this._rebuildCards();
        this._runAutoLayout();
        this._drawEdges();
        this._fitToScreen();

        // Restore the render mode that was active when the scene was saved
        if (savedMode === 'rayMarch') {
          this.sceneManager.setRenderMode('rayMarch');
          this.sceneManager.rayMarchRenderer?.show();
          this.sceneManager._renderRayMarch();
          this._renderModeBtn.textContent = '▣ Marching Squares';
        } else if (savedMode === 'glsl') {
          this.sceneManager.setRenderMode('glsl');
          this.sceneManager.sdfRenderer?.show();
          this.sceneManager._renderGLSL();
          this._renderModeBtn.textContent = '⬜ Ray March';
        } else {
          this.sceneManager.setRenderMode('marchingSquares');
          this._renderModeBtn.textContent = '⬛ GLSL Mode';
          // Trigger a marching squares render
          this.sceneManager.evaluator.graph = this.stateStore.nodeGraph;
          this.sceneManager.evaluator.invalidate();
          const sdf = this.sceneManager.evaluator.getRootSDF();
          if (sdf) this.sceneManager.renderSDF(sdf, 'contours (2D)');
        }
      }, 100);
    });
    loadBtn.style.cssText += 'border-color: rgba(80,140,255,0.4); color: rgba(160,200,255,0.9);';
    toolbar.appendChild(loadBtn);

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

        // ── Edge deletion via right-click on canvas background ────────────────
        // When the user right-clicks on the background canvas, we check whether
        // the click is close to any drawn edge. If so, we offer to delete it.
        //
        // All position arithmetic is done in the same coordinate space that
        // _getPortPosition returns — canvas-inner space (post-transform).
        // The click arrives in screen space and must be converted first.
        this._bgCanvas.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();

          // Convert screen coordinates → canvas-inner coordinates.
          // The inner div is translated and scaled by this._transform.
          // Screen point (cx, cy) maps to inner point:
          //   ix = (cx - rect.left - tx) / scale
          //   iy = (cy - rect.top  - ty) / scale
          const rect  = this._bgCanvas.getBoundingClientRect();
          const tx    = this._transform.tx;
          const ty    = this._transform.ty;
          const scale = this._transform.scale;
          const mx    = (e.clientX - rect.left - tx) / scale;
          const my    = (e.clientY - rect.top  - ty) / scale;

          // Hit-test radius in canvas-inner pixels.
          // 14 pixels feels comfortable at default zoom.
          const HIT_RADIUS = 14;

          const graph = this.stateStore.nodeGraph;
          let closestEdge = null;
          let closestDist = Infinity;

          // Iterate every edge in the graph and find the closest one
          // whose line segment passes within HIT_RADIUS of the click.
          graph.edges.forEach(edge => {
            // Get the screen-space port positions, then convert to inner space.
            // _getPortPosition returns positions in screen coordinates (via
            // getBoundingClientRect on the port element), so we apply the
            // same transform inversion used above.
            const rawFrom = this._getPortPosition(edge.fromNode, edge.fromPort, 'out');
            const rawTo   = this._getPortPosition(edge.toNode,   edge.toPort,   'in');

            if (!rawFrom || !rawTo) return;

            // The positions returned by _getPortPosition are already in
            // inner-canvas space (EdgeRenderer uses them directly without
            // further transform). Use them as-is.
            const ax = rawFrom.x;
            const ay = rawFrom.y;
            const bx = rawTo.x;
            const by = rawTo.y;

            // Distance from point (mx, my) to line segment (ax,ay)→(bx,by)
            const dx  = bx - ax;
            const dy  = by - ay;
            const len2 = dx * dx + dy * dy;

            let dist;
            if (len2 < 0.001) {
              // Degenerate edge (zero length) — use distance to the point
              dist = Math.sqrt((mx - ax) ** 2 + (my - ay) ** 2);
            } else {
              // Project click onto the line, clamp to segment
              const t  = Math.max(0, Math.min(1,
                ((mx - ax) * dx + (my - ay) * dy) / len2
              ));
              const px = ax + t * dx;
              const py = ay + t * dy;
              dist = Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
            }

            if (dist < HIT_RADIUS && dist < closestDist) {
              closestEdge = edge;
              closestDist = dist;
            }
          });

          if (!closestEdge) return; // no edge near the click — do nothing

          const fromNode = graph.nodes.get(closestEdge.fromNode);
          const toNode   = graph.nodes.get(closestEdge.toNode);
          const fromLabel = `${fromNode?.type ?? '?'} #${closestEdge.fromNode}`;
          const toLabel   = `${toNode?.type   ?? '?'} #${closestEdge.toNode}`;

          if (!confirm(`Delete connection:\n  ${fromLabel} → ${toLabel}?`)) return;

          try { graph.removeEdge(closestEdge.id); } catch(e) {
            console.warn('NodeCanvas: could not remove edge:', e.message);
            return;
          }

          // Invalidate caches so the next render reflects the deletion
          this.sceneManager._lastGLSLSource     = null;
          this.sceneManager._lastRayMarchSource = null;
          this.sceneManager.evaluator.invalidate();

          this._drawEdges();
        });
        
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

        // Hide dat.GUI if present (legacy fallback)
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
            (nodeId, x, y) => {
              // Persist the dragged position into node.uiPos so that the
              // next _rebuildCards() call restores it correctly.
              // NodeGraph.updateNodePosition does NOT fire onChange, so
              // this does not trigger a re-render loop.
              this.stateStore.nodeGraph.updateNodePosition(nodeId, x, y);
              this._drawEdges();
            },
            (nodeId, previewCanvas) => this._renderSDFPreview(nodeId, previewCanvas)
        );

        // Select on header click
        const header = card.el.querySelector('[data-drag-handle]');
        if (header) {
            header.addEventListener('mousedown', (e) => {
            this._setSelected(node.id, e.shiftKey);
            });
        }

        // ── Right-click on card → delete node and all its connections ───────
        card.el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();

          const nodeType = node.type;
          const nodeId   = node.id;

          if (!confirm(
            `Delete "${nodeType}" node #${nodeId} and all its connections?`
          )) return;

          const graph = this.stateStore.nodeGraph;

          // Collect all edge IDs touching this node before removing anything
          const edgeIdsToRemove = [];
          graph.edges.forEach(edge => {
            if (edge.fromNode === nodeId || edge.toNode === nodeId)
              edgeIdsToRemove.push(edge.id);
          });

          // Remove edges first (graph may validate on node removal)
          edgeIdsToRemove.forEach(eid => {
            try { graph.removeEdge(eid); } catch(_) {}
          });

          // Remove the node from the graph
          try { graph.removeNode(nodeId); } catch(e) {
            console.warn(`NodeCanvas: could not remove node ${nodeId}:`, e.message);
          }

          // If this was a geometry primitive, remove it from the 3D scene too
          const primIdx = this.sceneManager.activePrimitives.findIndex(
            p => p.instance.id === nodeId
          );
          if (primIdx !== -1) {
            const primEntry = this.sceneManager.activePrimitives[primIdx];
            this.sceneManager._removeFromScene(primEntry);
            this.sceneManager.activePrimitives.splice(primIdx, 1);
          }

          // If this was a SchurComposition, remove it too
          if (this.sceneManager.currentSchur?.instance?.id === nodeId) {
            this.sceneManager._removeFromScene(this.sceneManager.currentSchur);
            this.sceneManager.currentSchur = null;
          }

          // Invalidate shader caches so the next render reflects the deletion
          this.sceneManager._lastGLSLSource     = null;
          this.sceneManager._lastRayMarchSource = null;
          this.sceneManager.evaluator.invalidate();

          setTimeout(() => {
            this._rebuildCards();
            this._runAutoLayout();
            this._drawEdges();
          }, 50);
        });

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
        const getInnerRect = () => this._inner.getBoundingClientRect();
        const innerRect = getInnerRect();
        const x = (screenPos.x - innerRect.left) / this._transform.scale;
        const y = (screenPos.y - innerRect.top)  / this._transform.scale;

        this._pendingEdge = { nodeId, portName, dir, x1: x, y1: y, x2: x, y2: y };

        const onMouseMove = (e) => {
        const r  = getInnerRect();
        const dx = (e.clientX - r.left) / this._transform.scale;
        const dy = (e.clientY - r.top)  / this._transform.scale;
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
        // Defer cleanup by one microtask so the port dot's mouseup handler
        // fires first and can call _completePendingEdge while _pendingEdge
        // is still set. Without this setTimeout, _pendingEdge is nulled
        // before _completePendingEdge reads it, silently aborting every
        // manual drag-connect attempt.
        setTimeout(() => {
          this._edgeRenderer.setPendingEdge(null);
          this._pendingEdge = null;
          this._drawEdges();
        }, 0);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup',   onMouseUp);
    }

    _completePendingEdge(toNodeId, toPortName, toDir) {
        if (!this._pendingEdge) return;
        const { nodeId: fromNodeId, portName: fromPortName, dir: fromDir } = this._pendingEdge;

        // Prevent connecting to the same node
        if (fromNodeId === toNodeId) return;

        // Determine canonical OUT→IN direction from both port directions
        let outNodeId, outPort, inNodeId, inPort;

        if (fromDir === 'out' && toDir === 'in') {
          // Dragged from an output port to an input port — canonical direction
          outNodeId = fromNodeId;
          outPort   = fromPortName;
          inNodeId  = toNodeId;
          inPort    = toPortName;
        } else if (fromDir === 'in' && toDir === 'out') {
          // Dragged backwards (from input to output) — swap to canonical
          outNodeId = toNodeId;
          outPort   = toPortName;
          inNodeId  = fromNodeId;
          inPort    = fromPortName;
        } else {
          // Both same direction — incompatible, ignore silently
          // (e.g. OUT→OUT or IN→IN)
          return;
        }

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

        // Any param change may affect the generated GLSL (e.g. axis, operation,
        // smoothness). Always invalidate the shader cache so it recompiles next frame.
        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;

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

    _toggleRenderMode() {
    const modes  = ['marchingSquares', 'glsl', 'rayMarch'];
    const labels = ['⬛ GLSL Mode', '⬜ Ray March', '▣ Marching Squares'];
    const current = this.sceneManager.renderMode;
    const nextIdx = (modes.indexOf(current) + 1) % modes.length;
    const next    = modes[nextIdx];

    this.sceneManager.setRenderMode(next);
    this._renderModeBtn.textContent = labels[nextIdx];

    // Explicitly manage canvas visibility to prevent Three.js from
    // overlapping the ray march / GLSL canvases
    const threeCanvas = this.sceneManager.renderer?.domElement;
    if (threeCanvas) {
      if (next === 'marchingSquares') {
        threeCanvas.style.opacity      = '1';
        threeCanvas.style.pointerEvents = 'auto';
      } else {
        threeCanvas.style.opacity      = '0';
        threeCanvas.style.pointerEvents = 'none';
      }
    }

    if (next === 'glsl') {
      this.sceneManager.sdfRenderer?.show();
      this.sceneManager._renderGLSL();
    } else if (next === 'rayMarch') {
      this.sceneManager.rayMarchRenderer?.show();
      this.sceneManager._renderRayMarch();
    } else {
      // marchingSquares — hide GPU canvases
      this.sceneManager.sdfRenderer?._canvas &&
        (this.sceneManager.sdfRenderer._canvas.style.display = 'none');
      this.sceneManager.rayMarchRenderer?._canvas &&
        (this.sceneManager.rayMarchRenderer._canvas.style.display = 'none');
    }
  }

    _clearAll() {
        // 0. Switch back to marching squares before clearing so the animation
        //    loop does not spam "no source" while the graph is empty
        if (this.sceneManager.renderMode !== 'marchingSquares') {
          this.sceneManager.setRenderMode('marchingSquares');
          this._renderModeBtn.textContent = '⬛ GLSL Mode';
        }

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

        // 3. Wipe the entire stateStore in place so graph references survive
        this.stateStore.clear();

        // 4. Keep evaluators pointed at the live graph object
        this.sceneManager.evaluator.graph = this.stateStore.nodeGraph;
        this.sceneManager.evaluator.invalidate();

        this.sceneManager.glslEvaluator.graph = this.stateStore.nodeGraph;
        this.sceneManager._lastGLSLSource = null;
        this.sceneManager._lastRayMarchSource = null;

        // 5. Rebuild the canvas
        setTimeout(() => {
          this._rebuildCards();
          this._drawEdges();
        }, 50);
    }

    /**
   * Add a blend node to the graph WITHOUT auto-wiring.
   * Blend nodes always require explicit multi-input wiring by the user.
   * The user must drag-connect two source branches into sdfA and sdfB,
   * then drag-connect the result port to Output or the next node.
   */
  _addBlendNode(type) {
    const graph  = this.stateStore.nodeGraph;
    const params = {
      schurBlend:    { operation:'union', smoothness:8, rotation:0, scale:1, posX:0, posY:0, isoOffset:0 },
      rUnion:        { smoothness: 8 },
      rIntersection: { smoothness: 8 },
      rDifference:   { smoothness: 8 },
    }[type] || {};

    const newNode = graph.addNode(type, params);

    // Always ensure the output node exists so Compose and the GLSL button
    // can find it. The output node is the terminal of every valid graph.
    this.sceneManager._ensureOutputNode();

    console.info(
      `Blend node "${type}" added (id:${newNode.id}).\n` +
      `  → Drag the blue output dot of one shape to the orange sdfA port.\n` +
      `  → Drag the blue output dot of another shape to the orange sdfB port.\n` +
      `  → Drag the blue result port to the orange sdf port of Output.`
    );

    setTimeout(() => {
      this._runAutoLayout();
      this._drawEdges();
    }, 50);
  }

    _addTransformNode(type) {
    const graph    = this.stateStore.nodeGraph;
    const defaults = {
      extrude:       { type: 'extrudeNode',      params: { height: 2 } },
      revolve:       { type: 'revolveNode',       params: { offset: 0 } },
      tiling:        { type: 'tilingNode',        params: { lattice:'hexagonal', periodX:3, periodY:3, offsetX:0, offsetY:0, isoOffset:0 } },
      symmetryfold:  { type: 'symmetryFoldNode',  params: { folds:6, centerX:0, centerY:0, rotation:0, reflectX:'no', reflectY:'no' } },
      symmetryorbit: { type: 'symmetryOrbitNode', params: { folds:6, centerX:0, centerY:0, rotation:0, reflectX:'no', combiner:'min', smoothness:8 } },
      mobius:        { type: 'mobiusNode',        params: { aRe:1, aIm:0, bRe:0, bIm:0, cRe:0, cIm:0, dRe:1, dIm:0 } },
      noisedisplace: { type: 'noiseDisplaceNode', params: { amplitude:0.3, frequency:3, animated:'no' } },
      twist:         { type: 'twistNode',         params: { strength:1.0 } },
      bend:          { type: 'bendNode',          params: { strength:0.5 } },
      repeat:        { type: 'repeatNode',        params: { countX:3, countY:3, countZ:1, spacingX:3, spacingY:3, spacingZ:3 } },
    };

    const def = defaults[type];
    if (!def) return;

    const newNode = graph.addNode(def.type, def.params);

    // ── Node type classification sets ──────────────────────────────────────
    // Used to decide what can be a chain source and what is a merge boundary.

    const GEOM_TYPES = new Set([
      'circle','regularPolygon','triangle','arc','polytope','lineSegment',
      'sphere','box','cylinder','capsule','torus','cone','plane'
    ]);

    const LINEAR_XFORM = new Set([
      'extrudeNode','revolveNode','noiseDisplaceNode','twistNode','bendNode',
      'repeatNode','tilingNode','symmetryFoldNode','symmetryOrbitNode','mobiusNode'
    ]);

    // Merge nodes always require explicit wiring — they are never auto-chained
    // because they have two input ports (sdfA, sdfB) and the system cannot
    // guess which branch each source belongs to.
    const MERGE_TYPES = new Set([
      'schurBlend','rUnion','rIntersection','rDifference','ifsBlend'
    ]);

    // ── Chain tail walker ──────────────────────────────────────────────────
    // Given a starting node ID, follow outgoing edges forward through the
    // graph until we reach either:
    //   a) a node with no outgoing edges (the current tail of the chain), or
    //   b) a node whose next downstream node is a merge node or the output node.
    // We stop BEFORE entering merge nodes or the output node because those
    // are explicit wiring boundaries that the user must control manually.
    //
    // Example: sphere(4) → noise(7) → output(9)
    //   findChainTail(4) returns 7, not 4, because 7 is the tail.
    //   The new transform should be inserted after 7, not after 4.
    //
    // Example: sphere(4) → noise(7) → twist(11) → output(9)
    //   findChainTail(4) returns 11.
    //
    // Example: sphere(4) → schurBlend(8)
    //   findChainTail(4) returns 4, because the next node (schurBlend) is
    //   a merge node and we stop before entering it.

    const findChainTail = (startId) => {
      let current = startId;
      const visited = new Set();

      while (true) {
        // Cycle guard — should not happen in a valid DAG but prevents infinite loop
        if (visited.has(current)) break;
        visited.add(current);

        const currentNode = graph.nodes.get(current);
        if (!currentNode) break;

        // Collect all outgoing edges from this node.
        // Geometry nodes output on 'sdf'; transform nodes output on 'result'.
        // We check both to handle any node type correctly.
        const outEdgesFromSdf    = graph.getOutgoingEdges(current, 'sdf')    || [];
        const outEdgesFromResult = graph.getOutgoingEdges(current, 'result') || [];
        const allOutEdges        = [...outEdgesFromSdf, ...outEdgesFromResult];

        // No outgoing edges — this node IS the tail, stop here.
        if (allOutEdges.length === 0) break;

        // Follow the first outgoing edge to the next node.
        // (Nodes in a linear chain have exactly one outgoing edge.)
        const nextEdge = allOutEdges[0];
        const nextId   = nextEdge.toNode;
        const nextNode = graph.nodes.get(nextId);
        if (!nextNode) break;

        // Stop BEFORE entering merge nodes.
        // The tail is the current node (current), not the merge node (nextId).
        // The user must explicitly wire into merge nodes.
        if (MERGE_TYPES.has(nextNode.type)) break;

        // Stop BEFORE entering the output node.
        // The output node is always the terminal; we do not walk through it.
        if (nextNode.type === 'outputNode') break;

        // The next node is a valid continuation — advance to it.
        current = nextId;
      }

      return current;
    };

    // ── Helper: which output port does a node type use? ────────────────────
    // Geometry nodes output their SDF on the 'sdf' port.
    // Transform nodes output on the 'result' port.
    const outPortOf = (nodeType) =>
      GEOM_TYPES.has(nodeType) ? 'sdf' : 'result';

    // ── Find the chain root to extend ──────────────────────────────────────
    // We look for the best starting point for the new chain, then walk to
    // the tail of that chain so the new transform is appended at the end.
    //
    // Priority 1: A node card is explicitly selected (clicked by the user).
    //   Walk from the selected node to the tail of its chain and wire from there.
    //   This handles the case: user selects sphere, presses Add Transform —
    //   the transform extends the sphere's chain even if it already has nodes
    //   wired further down.
    //   Merge nodes selected by the user are ignored (they cannot be chain roots).
    //
    // Priority 2: Exactly one geometry primitive is in the graph AND it has
    //   no outgoing edges yet (completely unwired). In this case the intent
    //   is unambiguous so we auto-chain automatically.
    //   This is the "first primitive + first transform" convenience case.
    //   If multiple primitives exist, or the primitive is already wired, we
    //   do nothing and inform the user to select a card first.

    let chainRootId   = null;   // the node we start walking from
    let chainTailId   = null;   // the end of the chain (where we wire from)
    let chainTailPort = null;   // 'sdf' or 'result' depending on tail node type

    // ── Priority 1: selected node ──────────────────────────────────────────
    if (this._selectedIds.size > 0) {
      // Take the most recently selected node ID
      const selId   = [...this._selectedIds].pop();
      const selNode = graph.nodes.get(selId);

      if (selNode && selId !== newNode.id) {
        // Only geometry and linear transform nodes can be chain roots.
        // Merge nodes (schurBlend, rUnion etc) cannot be chain roots because
        // they do not have a simple single-output chain structure.
        if (GEOM_TYPES.has(selNode.type) || LINEAR_XFORM.has(selNode.type)) {
          // The user selected a valid chain node.
          // Walk forward to find the tail of the chain that starts here.
          // Example: user selects sphere(4) in chain sphere→noise→output.
          //   findChainTail(4) returns noise(7) — the actual tail.
          //   The new transform is inserted after noise, not after sphere.
          chainRootId   = selId;
          chainTailId   = findChainTail(selId);
          chainTailPort = outPortOf(graph.nodes.get(chainTailId)?.type);
        } else {
          // User selected a merge node or an unsupported type.
          // Do not auto-chain — require explicit wiring.
          console.info(
            `Selected node "${selNode.type}" is a merge/output node. ` +
            `Wire the new transform manually using drag-connect.`
          );
        }
      }
    }

    // ── Priority 2: single unwired primitive fallback ──────────────────────
    if (!chainRootId) {
      // Count all geometry primitives in the graph (excluding the new node itself)
      const prims = [];
      graph.nodes.forEach((n, id) => {
        if (id === newNode.id) return;
        if (GEOM_TYPES.has(n.type)) prims.push(id);
      });

      if (prims.length === 1) {
        const pid = prims[0];
        // Only auto-chain if the primitive has no outgoing SDF edges yet.
        // If it already has outgoing edges, it is already wired into something
        // and we cannot safely determine the intent.
        const existingOut = graph.getOutgoingEdges(pid, 'sdf') || [];
        if (existingOut.length === 0) {
          // Single primitive, completely unwired — safe to auto-chain.
          chainRootId   = pid;
          chainTailId   = pid;        // no chain yet, tail = root
          chainTailPort = 'sdf';      // geometry nodes output on 'sdf'
        } else {
          // Primitive is already wired somewhere — ambiguous, require selection.
          console.info(
            `Primitive (id:${pid}) is already wired. ` +
            `Click a node card to select it, then click Add Transform ` +
            `to extend that branch.`
          );
        }
      } else if (prims.length > 1) {
        // Multiple primitives — cannot determine intent without selection.
        console.info(
          `${prims.length} primitives present — click a node card to select one, ` +
          `then click Add Transform to extend that branch.`
        );
      }
      // If prims.length === 0, the graph has no geometry at all.
      // In that case chainRootId remains null and we skip all wiring below.
    }

    // ── Wire tail → new transform node ────────────────────────────────────
    // If we found a valid chain tail, wire it to the new transform's input.
    if (chainTailId) {
      try {
        graph.addEdge(chainTailId, chainTailPort, newNode.id, 'sdf');
        console.log(
          `Auto-wired chain tail: ${chainTailId}(${chainTailPort}) → ${newNode.id}(sdf)`
        );
      } catch(e) {
        console.warn('Auto-wire tail→transform failed:', e.message);
      }
    } else {
      console.info(
        'No chain root found — wire the new transform manually using drag-connect.'
      );
    }

    // ── Wire new transform → output ────────────────────────────────────────
    // Determine whether to connect the new transform to the output node.
    // We do this in three scenarios:
    //
    //   Scenario A: The old chain tail was already connected to output.
    //     In this case the user had a working chain ending at output.
    //     We remove the old tail→output edge and replace it with
    //     newNode→output so the chain continues to reach the output.
    //     Example: sphere→noise→output. User adds twist after noise.
    //     Result should be: sphere→noise→twist→output.
    //     Without this, the chain would be sphere→noise→twist (dangling)
    //     and sphere→noise→output (still present, wrong).
    //
    //   Scenario B: Nothing is connected to output yet.
    //     The new transform becomes the first thing wired to output.
    //     This happens when the user adds a transform to a fresh scene.
    //
    //   Scenario C: Output is already wired from a different branch.
    //     Do not touch output — the user has a deliberate multi-branch
    //     scene and must wire manually.

    const outNode   = this.sceneManager._ensureOutputNode();
    const outEdges  = graph.getAllIncomingEdges(outNode.id, 'sdf') || [];

    // Scenario A: was the chain tail previously wired to output?
    const tailWasToOutput = chainTailId
      ? outEdges.some(e => e.fromNode === chainTailId)
      : false;

    // Scenario B: is output completely unconnected?
    const outputIsEmpty = outEdges.length === 0;

    if (tailWasToOutput) {
      // Remove the old tail→output edge before adding newNode→output.
      const oldEdge = outEdges.find(e => e.fromNode === chainTailId);
      if (oldEdge) {
        graph.removeEdge(oldEdge.id);
        console.log(
          `Removed old edge: ${chainTailId}(${chainTailPort}) → output`
        );
      }
      try {
        graph.addEdge(newNode.id, 'result', outNode.id, 'sdf');
        console.log(
          `Auto-wired: ${newNode.id}(result) → output(sdf) [replaced tail]`
        );
      } catch(e) { /* edge exists, fine */ }
    } else if (outputIsEmpty) {
      // Nothing wired to output — connect new node as the first output source.
      try {
        graph.addEdge(newNode.id, 'result', outNode.id, 'sdf');
        console.log(
          `Auto-wired: ${newNode.id}(result) → output(sdf) [first connection]`
        );
      } catch(e) { /* fine */ }
    } else {
      // Scenario C: output already has connections from other branches.
      // Do not auto-wire — inform the user.
      console.info(
        `Output already wired from another branch. ` +
        `Connect ${newNode.id} to output manually if needed.`
      );
    }

    setTimeout(() => {
      this._runAutoLayout();
      this._drawEdges();
    }, 50);
  }

    _compose() {
    // Compose renders whatever the node graph currently describes.
    // It does not create any new nodes — the user has already built
    // the graph by adding primitives, transforms, and blend nodes
    // and wiring them together.
    //
    // This button is equivalent to clicking "render now" using the
    // CPU evaluator and marching squares — it is the fallback path
    // that works for all node types including mappers.

    const graph = this.stateStore.nodeGraph;

    // Find the output node
    let outputNode = null;
    graph.nodes.forEach(n => { if (n.type === 'outputNode') outputNode = n; });

    if (!outputNode) {
      console.warn('Compose: no output node found. Add primitives and wire them first.');
      return;
    }

    // Check the output has at least one incoming SDF edge
    const inEdges = graph.getAllIncomingEdges(outputNode.id, 'sdf');
    if (inEdges.length === 0) {
      console.warn('Compose: output node has no incoming connections. Wire a node to output first.');
      return;
    }

    // Evaluate the graph using the CPU evaluator
    this.sceneManager.evaluator.graph = graph;
    this.sceneManager.evaluator.invalidate();

    let sdf = null;
    try {
      sdf = this.sceneManager.evaluator.getRootSDF();
    } catch(e) {
      console.error('Compose: evaluator error:', e.message);
      return;
    }

    if (!sdf) {
      console.warn('Compose: getRootSDF returned null — check that all required ports are connected.');
      return;
    }

    // Switch to marching squares (CPU path supports all node types)
    this.sceneManager.setRenderMode('marchingSquares');
    this._renderModeBtn.textContent = '⬛ GLSL Mode';

    // Restore Three.js canvas visibility
    const threeCanvas = this.sceneManager.renderer?.domElement;
    if (threeCanvas) {
      threeCanvas.style.opacity = '1';
      threeCanvas.style.pointerEvents = 'auto';
    }

    // Hide GPU canvases
    this.sceneManager.sdfRenderer?._canvas &&
      (this.sceneManager.sdfRenderer._canvas.style.display = 'none');
    this.sceneManager.rayMarchRenderer?._canvas &&
      (this.sceneManager.rayMarchRenderer._canvas.style.display = 'none');

    // Render
    try {
      this.sceneManager.renderSDF(sdf, 'contours (2D)');
      console.log('Compose: rendered via CPU marching squares');
    } catch(e) {
      console.error('Compose: render error:', e.message);
    }
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