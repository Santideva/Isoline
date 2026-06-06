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
    import { UndoManager } from '../state/UndoManager.js';

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

    /**
 * Returns true if the vertex array describes a convex polygon.
 * Works for both CW and CCW winding.
 * Collinear vertices are skipped (they neither confirm nor deny convexity).
 * Returns true for degenerate inputs (< 3 vertices, all collinear) so that
 * no spurious warning fires — the SDF code handles those cases separately.
 *
 * @param  {Array<[number,number]>} vertices
 * @returns {boolean}
 */
function _isConvexPolygon(vertices) {
    if (!Array.isArray(vertices) || vertices.length < 3) return true;
    const n = vertices.length;
    let expectedSign = 0;
    for (let i = 0; i < n; i++) {
        const [ax, ay] = vertices[i];
        const [bx, by] = vertices[(i + 1) % n];
        const [cx, cy] = vertices[(i + 2) % n];
        // Z-component of cross product (B−A) × (C−B)
        const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
        if (Math.abs(cross) < 1e-9) continue;   // collinear — skip
        const sign = cross > 0 ? 1 : -1;
        if (expectedSign === 0) {
            expectedSign = sign;
        } else if (sign !== expectedSign) {
            return false;   // turn direction reversed — concave vertex
        }
    }
    return true;
}

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

        // ── Undo / Redo ───────────────────────────────────────────────────
        this._undo      = new UndoManager(stateStore.nodeGraph);
        this._undoBtnEl = null;   // assigned in _buildDOM
        this._redoBtnEl = null;
        this._undo.onChange(({ canUndo, canRedo }) => {
            if (this._undoBtnEl) this._undoBtnEl.disabled = !canUndo;
            if (this._redoBtnEl) this._redoBtnEl.disabled = !canRedo;
        });

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
        // ── Inject option styles for dropdown readability ─────────────────────
        // Native <select> popups on Windows use the OS white-background theme.
        // Without explicit option styling the white text becomes invisible.
        // This block runs once per page load; the id guard prevents duplication.
        if (!document.getElementById('nc-option-styles')) {
            const _os = document.createElement('style');
            _os.id = 'nc-option-styles';
            _os.textContent = `
                select option {
                    background-color: #1c1c22 !important;
                    color: rgba(220, 220, 230, 0.95) !important;
                    font-size: 12px;
                }
                select option:hover,
                select option:focus,
                select option:checked {
                    background-color: #2e2e44 !important;
                    color: #ffffff !important;
                }
            `;
            document.head.appendChild(_os);
        }

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
        height: 44px;
        background: rgba(12,12,14,0.92);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex;
        align-items: center;
        padding: 0 10px;
        gap: 5px;
        flex-shrink: 0;
        pointer-events: auto;
        backdrop-filter: blur(4px);
        `;

        // ── Shared toolbar utilities ───────────────────────────────────────────
        const _selectStyle = `
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          font-size: 12px;
          padding: 3px 5px;
          cursor: pointer;
        `;

        // Create an <option> with explicit background/color so the native
        // OS dropdown popup renders readable text on any system theme.
        const _opt = (val, lbl) => {
          const o = document.createElement('option');
          o.value = val; o.textContent = lbl;
          o.style.backgroundColor = '#1c1c22';
          o.style.color = 'rgba(220,220,230,0.95)';
          return o;
        };

        // Placeholder option: shown when nothing is selected; disabled so
        // it cannot itself be dispatched as an add action.
        const _ph = (label) => {
          const o = document.createElement('option');
          o.value = ''; o.textContent = label;
          o.disabled = true; o.selected = true;
          o.style.backgroundColor = '#14141a';
          o.style.color = 'rgba(150,150,165,0.7)';
          return o;
        };

        // Dispatch helper: called on every dropdown's change event.
        // Adds the selected node type and resets the dropdown to its placeholder.
        const _GEOM = new Set([
          'line','triangle','arc','circle','polygon','polytope',
          'sphere','box','cylinder','capsule','torus','cone','plane'
        ]);
        const _XFORM = new Set([
          'extrude','revolve','tiling','symmetryfold','symmetryorbit',
          'mobius','noisedisplace','twist','bend','repeat'
        ]);
        const _BLEND = new Set([
          'schurBlend','rUnion','rIntersection','rDifference'
        ]);

        const _dispatchAdd = (v, selectEl) => {
          if (!v) return;
          selectEl.value = '';          // reset to placeholder immediately
          if (_GEOM.has(v)) {
            this._undo.snapshot();
            this.sceneManager.addPrimitive(v);
            setTimeout(() => { this._runAutoLayout(); this._drawEdges(); }, 50);
          } else if (_XFORM.has(v)) {
            this._addTransformNode(v);  // snapshot taken inside _addTransformNode
          } else if (_BLEND.has(v)) {
            this._addBlendNode(v);      // snapshot taken inside _addBlendNode
          }
        };

        // ── 2D geometry dropdown ──────────────────────────────────────────────
        this._2dSelect = document.createElement('select');
        this._2dSelect.style.cssText = _selectStyle;
        this._2dSelect.title = 'Click a 2D primitive to add it to the graph';
        this._2dSelect.appendChild(_ph('2D ▾'));
        [
          ['line','Line'], ['triangle','Triangle'], ['arc','Arc'],
          ['circle','Circle'], ['polygon','Polygon'], ['polytope','Conv. Polygon'],
        ].forEach(([v, l]) => this._2dSelect.appendChild(_opt(v, l)));
        this._2dSelect.addEventListener('change', () =>
          _dispatchAdd(this._2dSelect.value, this._2dSelect));
        toolbar.appendChild(this._2dSelect);

        // ── 3D geometry dropdown ──────────────────────────────────────────────
        this._3dSelect = document.createElement('select');
        this._3dSelect.style.cssText = _selectStyle;
        this._3dSelect.title = 'Click a 3D primitive to add it to the graph';
        this._3dSelect.appendChild(_ph('3D ▾'));
        [
          ['sphere','Sphere'], ['box','Box'], ['cylinder','Cylinder'],
          ['capsule','Capsule'], ['torus','Torus'], ['cone','Cone'], ['plane','Plane'],
        ].forEach(([v, l]) => this._3dSelect.appendChild(_opt(v, l)));
        this._3dSelect.addEventListener('change', () =>
          _dispatchAdd(this._3dSelect.value, this._3dSelect));
        toolbar.appendChild(this._3dSelect);

        // ── Transform / operation dropdown ────────────────────────────────────
        this._xformSelect = document.createElement('select');
        this._xformSelect.style.cssText = _selectStyle;
        this._xformSelect.title = 'Click an operation to add it to the graph';
        this._xformSelect.appendChild(_ph('Op ▾'));
        [
          ['extrude','Extrude'], ['revolve','Revolve'], ['tiling','Tiling'],
          ['symmetryfold','Sym. Fold'], ['symmetryorbit','Sym. Orbit'],
          ['mobius','Möbius'], ['noisedisplace','Noise Disp.'],
          ['twist','Twist'], ['bend','Bend'], ['repeat','Repeat'],
        ].forEach(([v, l]) => this._xformSelect.appendChild(_opt(v, l)));
        this._xformSelect.addEventListener('change', () =>
          _dispatchAdd(this._xformSelect.value, this._xformSelect));
        toolbar.appendChild(this._xformSelect);

        // ── Blend dropdown ────────────────────────────────────────────────────
        this._blendSelect = document.createElement('select');
        this._blendSelect.style.cssText = _selectStyle;
        this._blendSelect.title = 'Click a blend mode to add it to the graph';
        this._blendSelect.appendChild(_ph('Blend ▾'));
        [
          ['schurBlend','Schur'], ['rUnion','R-Union'],
          ['rIntersection','R-Intersect'], ['rDifference','R-Difference'],
        ].forEach(([v, l]) => this._blendSelect.appendChild(_opt(v, l)));
        this._blendSelect.addEventListener('change', () =>
          _dispatchAdd(this._blendSelect.value, this._blendSelect));
        toolbar.appendChild(this._blendSelect);

        // ── Layout group ───────────────────────────────────────────────────────
        this._layoutSelect = document.createElement('select');
        this._layoutSelect.style.cssText = _selectStyle;
        this._layoutSelect.title = 'Choose auto-layout direction';
        LAYOUT_DIRECTIONS.forEach(dir => {
          const o = _opt(dir, dir);
          this._layoutSelect.appendChild(o);
        });
        this._layoutSelect.addEventListener('change', () => {
          this._layoutDir = this._layoutSelect.value;
          this._undo.snapshot();
          this._runAutoLayout();
        });
        toolbar.appendChild(this._layoutSelect);

        const _autoLayoutBtn = this._makeButton('Auto', () => {
          this._undo.snapshot();
          this._runAutoLayout();
        });
        _autoLayoutBtn.title = 'Auto-arrange all node cards';
        toolbar.appendChild(_autoLayoutBtn);

        // "Fit All" — computes the bounding box of every card currently in
        // the canvas (regardless of position or count) and adjusts zoom+pan
        // so all cards are visible simultaneously. Useful when cards have
        // drifted off-screen after heavy editing.
        const _fitBtn = this._makeButton('Fit All', () => this._fitToScreen());
        _fitBtn.title = 'Fit all node cards into the visible area';
        toolbar.appendChild(_fitBtn);

        // ── Node card canvas zoom ─────────────────────────────────────────────
        const _cardsZoomIn = this._makeButton('+', () => {
          const newScale = Math.min(3.0, this._transform.scale * 1.25);
          const cx = (this._bgCanvas.width  || 800) / 2;
          const cy = (this._bgCanvas.height || 600) / 2;
          this._transform.tx    = cx - (cx - this._transform.tx) * (newScale / this._transform.scale);
          this._transform.ty    = cy - (cy - this._transform.ty) * (newScale / this._transform.scale);
          this._transform.scale = newScale;
          this._applyTransform();
          this._drawEdges();
        });
        _cardsZoomIn.title = 'Zoom in on node cards';
        toolbar.appendChild(_cardsZoomIn);

        const _cardsZoomOut = this._makeButton('−', () => {
          const newScale = Math.max(0.2, this._transform.scale * 0.8);
          const cx = (this._bgCanvas.width  || 800) / 2;
          const cy = (this._bgCanvas.height || 600) / 2;
          this._transform.tx    = cx - (cx - this._transform.tx) * (newScale / this._transform.scale);
          this._transform.ty    = cy - (cy - this._transform.ty) * (newScale / this._transform.scale);
          this._transform.scale = newScale;
          this._applyTransform();
          this._drawEdges();
        });
        _cardsZoomOut.title = 'Zoom out on node cards';
        toolbar.appendChild(_cardsZoomOut);

        // ── 3D scene zoom ─────────────────────────────────────────────────────
        // Moves the Three.js camera along its view axis. The ray march
        // renderer syncs its camera from Three.js each frame so these
        // buttons affect all three render modes.
        const _sceneZoomIn = this._makeButton('↑', () => {
          const cam  = this.sceneManager.camera;
          const ctrl = this.sceneManager.controls;
          if (!cam || !ctrl) return;
          const dist = cam.position.distanceTo(ctrl.target);
          const dir  = cam.position.clone().sub(ctrl.target).normalize();
          cam.position.copy(ctrl.target.clone().add(dir.multiplyScalar(dist * 0.8)));
          ctrl.update();
        });
        _sceneZoomIn.title = 'Zoom in on 3D scene';
        toolbar.appendChild(_sceneZoomIn);

        const _sceneZoomOut = this._makeButton('↓', () => {
          const cam  = this.sceneManager.camera;
          const ctrl = this.sceneManager.controls;
          if (!cam || !ctrl) return;
          const dist = cam.position.distanceTo(ctrl.target);
          const dir  = cam.position.clone().sub(ctrl.target).normalize();
          cam.position.copy(ctrl.target.clone().add(dir.multiplyScalar(dist * 1.25)));
          ctrl.update();
        });
        _sceneZoomOut.title = 'Zoom out on 3D scene';
        toolbar.appendChild(_sceneZoomOut);

        
        // ── Section 3: HISTORY ────────────────────────────────────────────────
        this._undoBtnEl = this._makeButton('↩ Undo', () => this._performUndo());
        this._undoBtnEl.title    = 'Undo  (Ctrl+Z)';
        this._undoBtnEl.disabled = true;
        toolbar.appendChild(this._undoBtnEl);

        this._redoBtnEl = this._makeButton('↪ Redo', () => this._performRedo());
        this._redoBtnEl.title    = 'Redo  (Ctrl+Y)';
        this._redoBtnEl.disabled = true;
        toolbar.appendChild(this._redoBtnEl);

        // Clear Scene: snapshot first so the user can undo the clear.
        const _clearBtn = this._makeButton('🗑', () => {
          if (!confirm('Clear the entire scene and start over?')) return;
          this._undo.snapshot();
          this._clearAll();
        });
        _clearBtn.title = 'Clear scene and start over (undoable)';
        _clearBtn.style.cssText += 'border-color: rgba(255,80,80,0.35); color: rgba(255,150,150,0.9);';
        toolbar.appendChild(_clearBtn);

    
        // Operation defaults (used by legacy _compose() only)
        this._composeOperation = 'union';

        // ── Section 4: RENDER ─────────────────────────────────────────────────
        //
        // "Render (CPU)" — triggers the marching-squares CPU render pipeline.
        // GLSL and ray march modes render automatically every animation frame;
        // the CPU path must be triggered explicitly because it is blocking and
        // can be slow on complex scenes.
        const _composeBtn = this._makeButton('⬡ Render', () => this._compose());
        _composeBtn.title = 'Render the current scene via CPU marching squares';
        _composeBtn.style.cssText += 'background: rgba(83,58,183,0.4); border-color: rgba(150,130,255,0.4);';
        toolbar.appendChild(_composeBtn);

        // "Lines" slider — controls iso-contour step size in GLSL mode.
        // Smaller value → denser contour lines; larger → fewer, spaced further.
        // Greyed out when not in GLSL mode since it has no effect there.
        const _isoLabel = document.createElement('span');
        _isoLabel.textContent = 'Lines:';
        _isoLabel.style.cssText = 'font-size:13px; color:rgba(255,255,255,0.5);';
        toolbar.appendChild(_isoLabel);
        this._isoLabel = _isoLabel;  // stored so _toggleRenderMode can update opacity

        this._isoSlider = document.createElement('input');
        this._isoSlider.type  = 'range';
        this._isoSlider.min   = '0.1';
        this._isoSlider.max   = '2.0';
        this._isoSlider.step  = '0.05';
        this._isoSlider.value = '0.5';
        this._isoSlider.style.cssText = 'width:72px; cursor:pointer; opacity:0.4;';
        this._isoSlider.disabled = true;   // enabled only in GLSL mode
        this._isoSlider.title = 'Contour line density (GLSL mode only)';
        this._isoSlider.addEventListener('input', () => {
          const v = parseFloat(this._isoSlider.value);
          this.sceneManager.sdfRenderer.setIsoStep(v);
          if (this.sceneManager.renderMode === 'glsl') {
            this.sceneManager._renderGLSL();
          }
        });
        toolbar.appendChild(this._isoSlider);

        // Render mode toggle (cycles marchingSquares → glsl → rayMarch)
        this._renderModeBtn = this._makeButton('⬛ GLSL Mode', () => this._toggleRenderMode());
        this._renderModeBtn.style.cssText += 'border-color: rgba(80,200,120,0.4); color: rgba(160,255,180,0.9);';
        toolbar.appendChild(this._renderModeBtn);

            
        // ── Section 5: FILE ───────────────────────────────────────────────────
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

      // Snapshot current state so the load can be undone (Ctrl+Z)
      this._undo.snapshot();

      // Clear current state first
      this._clearAll();

      const loadedData = await loadScene(name, this.stateStore.nodeGraph);
      if (!loadedData) {
        alert(`Could not load scene "${name}"`);
        return;
      }

      // Keep UndoManager tracking the live graph after deserialization
      this._undo.syncGraph(this.stateStore.nodeGraph);

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

    const _exportBtn = this._makeButton('↗', () => this._toggleExportPanel(_exportBtn));
    _exportBtn.title = 'Export current scene (PNG · GLSL shader · JSON)';
    _exportBtn.style.cssText += 'border-color: rgba(255,200,80,0.4); color: rgba(255,230,150,0.9);';
    toolbar.appendChild(_exportBtn);

    
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

          this._undo.snapshot();
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
        font-size: 13px;
        padding: 4px 12px;
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
        // Fit the viewport to the new card positions so no card is ever
        // off-screen after layout runs. requestAnimationFrame defers the
        // measurement until the DOM has settled from _rebuildCards().
        requestAnimationFrame(() => this._fitToScreen());
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
            (nodeId, previewCanvas) => this._renderSDFPreview(nodeId, previewCanvas),
            this._undo
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

          this._undo.snapshot();
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
        this._undo.snapshot();
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
        // Guard: _pendingEdge can be nulled by a deferred timeout from a
        // previous drag that finished just before this mousemove fires.
        if (!this._pendingEdge) return;
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

      // Capture the current _pendingEdge reference so the deferred null only
      // applies to THIS drag operation. Without this, if a second drag starts
      // before the setTimeout fires, the timeout nulls the new drag's object.
      const capturedEdge = this._pendingEdge;

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        setTimeout(() => {
          this._edgeRenderer.setPendingEdge(null);
          // Only null _pendingEdge if it still belongs to this drag operation.
          // A rapid second drag may have already replaced it with a new object.
          if (this._pendingEdge === capturedEdge) {
            this._pendingEdge = null;
          }
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

        this._undo.snapshot();
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

        // ── Concave polygon guard ─────────────────────────────────────────────────
        // The Conv. Polygon (polytope) SDF is only valid for convex shapes.
        // Fire immediately when the user edits vertices so they are not left
        // wondering why the shape renders incorrectly.
        const changedNode = this.stateStore.nodeGraph.nodes.get(nodeId);
        if (changedNode?.type === 'polytope' && paramName === 'vertices') {
            let parsedVerts = null;
            try {
                parsedVerts = typeof value === 'string'
                    ? JSON.parse(value)
                    : value;
            } catch (_) {
                // Malformed JSON — the geometry code will surface this separately.
            }
            if (parsedVerts && Array.isArray(parsedVerts) && !_isConvexPolygon(parsedVerts)) {
                this._showToast(
                    '⚠  Concave polygon — geometry reserved for version2.',
                    6000
                );
            }
        }

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

    // Enable the Lines slider only in GLSL mode where it has a visible effect.
    const glslActive = next === 'glsl';
    if (this._isoSlider) {
      this._isoSlider.disabled = !glslActive;
      this._isoSlider.style.opacity = glslActive ? '1' : '0.4';
      this._isoSlider.style.cursor  = glslActive ? 'pointer' : 'default';
    }
    if (this._isoLabel) {
      this._isoLabel.style.opacity = glslActive ? '1' : '0.4';
    }

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
    this._undo.snapshot();
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
    // ── V1 dimensional constraint guard ───────────────────────────────────────
    // Extrude and Revolve are 2D→3D bridges: they take a flat SDF as input
    // and produce a volumetric SDF. Applying them to a 3D primitive is
    // geometrically meaningless in V1. (Expanded in V2.)
    //
    // Check the most likely source node (selected card, or the sole primitive
    // in the scene). If it is 3D, cancel the add and show an explanatory toast
    // rather than silently creating an invalid graph connection.
    const _IS_2D_ONLY_OP = new Set(['extrude', 'revolve']);
    if (_IS_2D_ONLY_OP.has(type)) {
      const _3D_TYPES = new Set([
        'sphere','box','cylinder','capsule','torus','cone','plane'
      ]);
      const _2D_TYPES = new Set([
        'circle','regularPolygon','triangle','arc','polytope','lineSegment'
      ]);
      const graph0 = this.stateStore.nodeGraph;

      // Priority 1 — user has a card selected; check its type directly.
      const selId   = [...this._selectedIds].pop();
      const selNode = selId ? graph0.nodes.get(selId) : null;
      if (selNode && _3D_TYPES.has(selNode.type)) {
        this._showToast(
          `${type[0].toUpperCase() + type.slice(1)} requires a 2D shape as input. ` +
          `"${selNode.type}" is a 3D primitive — select a 2D shape (circle, polygon, …) first.`
        );
        return;
      }

      // Priority 2 — no selection, but the only primitives in the scene are 3D.
      let scene2DCount = 0;
      graph0.nodes.forEach(n => { if (_2D_TYPES.has(n.type)) scene2DCount++; });
      let scene3DCount = 0;
      graph0.nodes.forEach(n => { if (_3D_TYPES.has(n.type)) scene3DCount++; });

      if (scene3DCount > 0 && scene2DCount === 0) {
        this._showToast(
          `${type[0].toUpperCase() + type.slice(1)} requires a 2D input. ` +
          `The scene contains only 3D geometry. ` +
          `Add a 2D shape first. (V1 limitation — dimensional bridging expands in V2.)`
        );
        return;
      }
    }

    this._undo.snapshot();
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

        // Undo / Redo
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            this._performUndo();
            return;
            }
            if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
            e.preventDefault();
            this._performRedo();
            return;
            }
        }

        // Tab key removed: the canvas is always open — no toggle needed.

        // Escape: deselect any selected node cards.
        // The overlay is permanently visible so Escape no longer closes it.
        if (e.key === 'Escape' && this._open) {
            this._setSelected(null);
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

    // ── Toast notifications ───────────────────────────────────────────────────

    /**
     * Show a non-modal notification at the bottom of the screen.
     * Fades in, stays for `durationMs` milliseconds, then fades out.
     * Used for feedback on blocked actions (e.g. dimensional constraint
     * violations) so the user understands what happened without a dialog.
     */
    _showToast(message, durationMs = 3500) {
        const existing = document.getElementById('nc-toast');
        if (existing) existing.remove();

        const t = document.createElement('div');
        t.id = 'nc-toast';
        t.textContent = message;
        t.style.cssText = `
            position: fixed;
            bottom: 28px;
            left: 50%;
            transform: translateX(-50%) translateY(8px);
            opacity: 0;
            background: rgba(20,20,28,0.97);
            border: 1px solid rgba(255,165,60,0.5);
            color: rgba(255,210,140,0.95);
            font-size: 13px;
            font-family: var(--font-sans, sans-serif);
            padding: 10px 22px;
            border-radius: 6px;
            z-index: 3000;
            pointer-events: none;
            box-shadow: 0 4px 20px rgba(0,0,0,0.45);
            max-width: 540px;
            text-align: center;
            line-height: 1.45;
            transition: opacity 0.18s ease, transform 0.18s ease;
        `;
        document.body.appendChild(t);

        // Trigger enter transition on next frame
        requestAnimationFrame(() => {
            t.style.opacity = '1';
            t.style.transform = 'translateX(-50%) translateY(0)';
        });

        setTimeout(() => {
            t.style.opacity = '0';
            t.style.transform = 'translateX(-50%) translateY(4px)';
            setTimeout(() => t.remove(), 220);
        }, durationMs);
    }

    // ── Export ────────────────────────────────────────────────────────────────

    /**
     * Toggle the export panel. If already open, close it; otherwise open it
     * anchored near the top-right of the screen (below the toolbar).
     */
    _toggleExportPanel(anchorEl) {
        const existing = document.getElementById('nc-export-panel');
        if (existing) { existing.remove(); return; }

        const mode      = this.sceneManager.renderMode;
        const modeLabel = {
            marchingSquares: 'Marching Squares (CPU 2D)',
            glsl:            'GLSL (GPU 2D)',
            rayMarch:        'Ray March (GPU 3D)',
        }[mode] || mode;

        const panel = document.createElement('div');
        panel.id = 'nc-export-panel';
        panel.style.cssText = `
            position: fixed;
            top: 52px;
            right: 14px;
            background: rgba(16,16,22,0.98);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 8px;
            padding: 18px 20px 14px;
            z-index: 2000;
            pointer-events: auto;
            min-width: 280px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.55);
            font-family: var(--font-sans, sans-serif);
        `;

        // Header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;';
        const ttl = document.createElement('span');
        ttl.textContent = 'Export';
        ttl.style.cssText = 'font-size:14px; font-weight:600; color:rgba(255,255,255,0.9);';
        const cls = document.createElement('button');
        cls.textContent = '✕';
        cls.style.cssText = `
            background:none; border:none; color:rgba(255,255,255,0.4);
            font-size:13px; cursor:pointer; padding:0;
        `;
        cls.addEventListener('click', () => panel.remove());
        hdr.appendChild(ttl); hdr.appendChild(cls);
        panel.appendChild(hdr);

        // Mode indicator
        const modeEl = document.createElement('div');
        modeEl.textContent = `Active mode: ${modeLabel}`;
        modeEl.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.38); margin-bottom:14px;';
        panel.appendChild(modeEl);

        // Helper: styled export button row
        const _row = (icon, label, sub, onClick, enabled = true) => {
            const wrap = document.createElement('div');
            wrap.style.marginBottom = '8px';

            const btn = document.createElement('button');
            btn.style.cssText = `
                width:100%; background:${enabled ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)'};
                border:1px solid ${enabled ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)'};
                border-radius:5px;
                color:${enabled ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)'};
                font-size:13px; padding:9px 14px; cursor:${enabled ? 'pointer' : 'default'};
                text-align:left; display:flex; align-items:center; gap:8px;
            `;
            btn.innerHTML = `<span style="font-size:15px">${icon}</span><span>${label}</span>`;
            if (enabled) {
                btn.addEventListener('click', () => { onClick(); panel.remove(); });
                btn.addEventListener('mouseenter', () =>
                    btn.style.background = 'rgba(255,255,255,0.12)');
                btn.addEventListener('mouseleave', () =>
                    btn.style.background = 'rgba(255,255,255,0.07)');
            }

            const desc = document.createElement('div');
            desc.textContent = sub;
            desc.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.32); margin-top:3px; padding:0 2px;';
            wrap.appendChild(btn); wrap.appendChild(desc);
            return wrap;
        };

        // ── PNG — always available ────────────────────────────────────────────
        panel.appendChild(_row(
            '🖼', 'Export PNG',
            'Download the current rendered frame as a PNG image.',
            () => this._exportPNG()
        ));

        // ── GLSL shader — only in GLSL or ray march mode ──────────────────────
        const glslAvail = mode === 'glsl' || mode === 'rayMarch';
        panel.appendChild(_row(
            '🔷', 'Export GLSL Shader',
            glslAvail
                ? 'Download the generated fragment shader — paste into ShaderToy, Three.js, Unity, or any WebGL project.'
                : 'Switch to GLSL or Ray March mode and render to unlock shader export.',
            () => this._exportGLSL(),
            glslAvail
        ));

        // ── Scene JSON — always available ─────────────────────────────────────
        panel.appendChild(_row(
            '📋', 'Export Scene JSON',
            'Download the full node graph as JSON. Use to back up, share, or import into another Isoline session.',
            () => this._exportJSON()
        ));

        // ── SVG — V2 note ─────────────────────────────────────────────────────
        panel.appendChild(_row(
            '✏️', 'Export SVG  (V2)',
            'Vector export of marching-squares contours — coming in V2.',
            () => {}, false
        ));

        // Close on outside click (deferred so this click doesn't immediately close)
        setTimeout(() => {
            const outside = (e) => {
                if (!panel.contains(e.target) && e.target !== anchorEl) {
                    panel.remove();
                    document.removeEventListener('mousedown', outside);
                }
            };
            document.addEventListener('mousedown', outside);
        }, 120);

        document.body.appendChild(panel);
    }

    /**
     * Export the current rendered frame as a PNG.
     * Detects the active render mode and grabs the correct canvas element.
     */
    _exportPNG() {
        let canvas = null;
        const mode = this.sceneManager.renderMode;

        if (mode === 'glsl') {
            canvas = this.sceneManager.sdfRenderer?._canvas;
        } else if (mode === 'rayMarch') {
            canvas = this.sceneManager.rayMarchRenderer?._canvas;
        }
        // Fallback: Three.js renderer canvas (marching squares and fallback)
        if (!canvas) canvas = this.sceneManager.renderer?.domElement;

        if (!canvas) {
            this._showToast('No rendered canvas found. Render the scene first.');
            return;
        }

        try {
            const url  = canvas.toDataURL('image/png');
            const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `isoline-${ts}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            this._showToast('PNG exported.');
        } catch (err) {
            // toDataURL throws if the canvas is tainted by cross-origin content
            this._showToast(`PNG export failed: ${err.message}`);
        }
    }

    /**
     * Export the generated GLSL fragment shader source.
     * In GLSL mode this is the 2D SDF + iso-contour shader.
     * In ray march mode this is the full volumetric ray marching shader.
     * Both are self-contained and can be pasted into ShaderToy with minimal
     * wrapping (add a `mainImage` entry point and `iResolution` uniform).
     */
    _exportGLSL() {
        const mode    = this.sceneManager.renderMode;
        const injected = mode === 'rayMarch'
            ? this.sceneManager._lastRayMarchSource
            : this.sceneManager._lastGLSLSource;

        if (!injected) {
            this._showToast(
                'No shader source available. ' +
                'Switch to GLSL or Ray March mode, wire your graph to Output, and render once first.'
            );
            return;
        }

        // Build the COMPLETE fragment shader by combining the injected SDF
        // functions with the renderer's fixed template (uniforms, void main,
        // ray march loop, lighting). Without this step the exported file
        // contains only bare SDF function definitions — not a runnable shader.
        const renderer = mode === 'rayMarch'
            ? this.sceneManager.rayMarchRenderer
            : this.sceneManager.sdfRenderer;
        const fullFragmentShader = renderer._buildFragmentShader(injected);

        const header = [
            '// Generated by Isoline — SDF Geometry Workbench',
            `// Mode: ${mode === 'rayMarch' ? 'Ray March (3D)' : 'GLSL 2D'}`,
            `// Exported: ${new Date().toISOString()}`,
            '//',
            '// ── To run on ShaderToy (shadertoy.com) ─────────────────────────',
            '//   1. Create a new shader and replace the default fragment code.',
            '//   2. Change  void main()  →  void mainImage(out vec4 fragColor, in vec2 fragCoord)',
            '//   3. Change  gl_FragColor  →  fragColor',
            '//   4. Change  gl_FragCoord  →  fragCoord',
            '//   iResolution and iTime are ShaderToy built-ins — no changes needed.',
            '//',
            '// ── To run in a WebGL project ─────────────────────────────────────',
            '//   Use this as your fragment shader source directly.',
            '//   Pair with a simple full-screen quad vertex shader.',
            '//   Provide uniforms: uResolution (vec2), uTime (float).',
            '',
        ].join('\n');

        const full = header + fullFragmentShader;
        const blob = new Blob([full], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `isoline-shader-${ts}.glsl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this._showToast('GLSL shader exported.');
    }

    /**
     * Export the node graph as a JSON file.
     * The JSON is the same format used by Save/Load but written to disk
     * rather than IndexedDB, making it portable across machines and
     * shareable with other users.
     */
    _exportJSON() {
        try {
            const data = {
                version:    1,
                exportedAt: new Date().toISOString(),
                renderMode: this.sceneManager.renderMode,
                graph:      this.stateStore.nodeGraph.serialize(),
            };
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `isoline-scene-${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this._showToast('Scene JSON exported.');
        } catch (err) {
            this._showToast(`JSON export failed: ${err.message}`);
        }
    }

    // ── Undo / Redo ───────────────────────────────────────────────────────────

    _performUndo() {
        if (!this._undo.undo()) return;
        this._afterGraphReplaced();
    }

    _performRedo() {
        if (!this._undo.redo()) return;
        this._afterGraphReplaced();
    }

    /**
     * Called after the node graph has been replaced wholesale by undo,
     * redo, or scene load. Brings every downstream consumer of the node
     * graph back into sync with the restored state in this exact order:
     *
     *   1.  THREE.js scene objects cleared
     *   2.  stateStore shape registry cleared (via clearShapes — graph untouched)
     *   3.  THREE.js objects rebuilt from restored graph nodes
     *   4.  CPU evaluator re-pointed and invalidated
     *   5.  GLSL evaluator re-pointed, shader caches flushed
     *   6.  UndoManager synced to live graph reference
     *   7.  NodeCard DOM fully rebuilt
     *   8.  Edge layer redrawn
     *
     * WHY THE ORDER MATTERS:
     *
     * Step 1 must precede step 2 so there is never a window where the
     * THREE.js scene references shape instances that have been removed
     * from the stateStore registry. Both are cleared before anything is
     * rebuilt, ensuring a clean slate.
     *
     * Step 2 uses clearShapes() and NOT stateStore.clear(). The latter
     * would wipe the nodeGraph that undo/redo just restored.
     * clearShapes() removes only the shape instance objects — the stale
     * ones from the previous graph state — leaving the restored nodeGraph
     * completely intact for step 3 to read from.
     *
     * Step 3 calls _rebuildPrimitiveFromNode() for each geometry node.
     * That method creates a fresh primitive instance, calls
     * stateStore.addShape(prim) to register it, and calls
     * prim.createObject() to build the THREE.js mesh. The result is a
     * { instance, type, object } entry that gets pushed into
     * sceneManager.activePrimitives and added to the THREE.js scene.
     *
     * V1 KNOWN LIMITATION:
     * _rebuildPrimitiveFromNode handles the following types:
     *   circle, regularPolygon, polytope, sphere, box, cylinder,
     *   capsule, torus, cone, plane.
     * It does NOT currently handle: arc, triangle, lineSegment.
     * For those types the method returns null and the loop below skips
     * them with a warning. SDF evaluation for all node types remains
     * correct regardless — only the THREE.js wireframe is absent for
     * the unhandled types. This is addressed in V1.1.
     */
    _afterGraphReplaced() {
        const graph = this.stateStore.nodeGraph;

        // ── Step 1: Remove all existing THREE.js objects from the scene ───────
        //
        // currentSchur is the rendered output object currently in the THREE.js
        // scene — line segments for contours, a fill mesh for 2D fill, or
        // a surface mesh for 3D. It must be removed before rebuilding so the
        // scene never contains both the old object and the new one at once.
        if (this.sceneManager.currentSchur) {
            this.sceneManager._removeFromScene(this.sceneManager.currentSchur);
            this.sceneManager.currentSchur = null;
        }

        // activePrimitives holds the THREE.js entry for each geometry primitive.
        // Each entry is removed from the scene individually then the array is
        // emptied. This must happen before clearShapes() so the THREE.js scene
        // and the stateStore registry are cleared in a consistent order.
        this.sceneManager.activePrimitives.forEach(entry => {
            this.sceneManager._removeFromScene(entry);
        });
        this.sceneManager.activePrimitives = [];

        // ── Step 2: Clear stateStore shape instances without touching nodeGraph ─
        //
        // stateStore.clearShapes() removes the shape objects registered by the
        // PREVIOUS graph state. Those instances carry the old geometry parameters
        // (old radius, old position, old blend configuration). If this step is
        // skipped, _rebuildPrimitiveFromNode in step 3 would attempt to register
        // new shapes against IDs that are already present in the Map, causing
        // collisions or stale evaluator lookups.
        //
        // clearShapes() does NOT call stateStore.clear(). That would wipe the
        // nodeGraph that undo/redo deserialized immediately before this method
        // was called. Only the shape instance Map is affected.
        this.stateStore.clearShapes();

        // ── Step 3: Rebuild THREE.js objects from the restored graph nodes ─────
        //
        // The geometry types that _rebuildPrimitiveFromNode currently supports.
        // Any node type listed here but not handled in _rebuildPrimitiveFromNode's
        // switch statement will cause it to return null, which the loop below
        // catches and logs as a warning.
        const GEOMETRY_TYPES = new Set([
            'circle',
            'regularPolygon',
            'polytope',
            'lineSegment',
            'sphere',
            'box',
            'cylinder',
            'capsule',
            'torus',
            'cone',
            'plane',
        ]);

        graph.nodes.forEach((node) => {
            // Transform nodes, blend nodes, output nodes, mapper nodes, and
            // time nodes do not have direct THREE.js representations.
            // Only geometry primitive nodes need a mesh rebuilt.
            if (!GEOMETRY_TYPES.has(node.type)) return;

            let entry = null;
            try {
                entry = this.sceneManager._rebuildPrimitiveFromNode(node);
            } catch (e) {
                // An exception here means _rebuildPrimitiveFromNode encountered
                // an internal error (constructor failure, missing dependency, etc.).
                // Log it with enough context to locate the node, then continue
                // rebuilding the remaining nodes rather than aborting entirely.
                console.warn(
                    `_afterGraphReplaced: exception while rebuilding ` +
                    `${node.type} node #${node.id}: ${e.message}`
                );
                return;
            }

            if (!entry) {
                // _rebuildPrimitiveFromNode returned null without throwing.
                // This happens when the node type is in GEOMETRY_TYPES above
                // but the switch statement inside the method does not handle it
                // (currently: arc, triangle, lineSegment return null).
                // SDF evaluation is unaffected — only the THREE.js wireframe
                // is absent for this node until V1.1 extends the method.
                console.warn(
                    `_afterGraphReplaced: _rebuildPrimitiveFromNode returned null ` +
                    `for ${node.type} node #${node.id}. ` +
                    `SDF evaluation is correct; THREE.js wireframe is not restored ` +
                    `for this node type in V1.`
                );
                return;
            }

            // Both stateStore registration (via _rebuildPrimitiveFromNode internally)
            // and THREE.js scene addition are completed here. The entry is also
            // tracked in activePrimitives so future calls to removeLast() or
            // _clearAll() can find and remove it correctly.
            this.sceneManager.activePrimitives.push(entry);
            this.sceneManager._addToScene(entry);
        });

        // ── Step 4: Re-point the CPU evaluator at the live graph ─────────────
        //
        // NodeEvaluator caches SDF closures keyed by node ID. After undo/redo
        // the node IDs are the same but the param values and graph topology may
        // have changed. Re-assigning the graph reference and calling invalidate()
        // clears all caches so the next call to getRootSDF() re-evaluates the
        // full graph from scratch against the restored node data.
        this.sceneManager.evaluator.graph = graph;
        this.sceneManager.evaluator.invalidate();

        // ── Step 5: Re-point the GLSL evaluator and flush shader caches ──────
        //
        // The GLSL evaluator generates shader source from the graph node
        // structure. Nullifying _lastGLSLSource and _lastRayMarchSource forces
        // a full recompile on the next render frame. This is necessary because
        // the restored graph may have different node types, different connections,
        // or different operation parameters that change the generated GLSL.
        // Without this flush the renderer would continue using a shader compiled
        // for the previous graph state.
        if (this.sceneManager.glslEvaluator) {
            this.sceneManager.glslEvaluator.graph = graph;
        }
        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;

        // ── Step 6: Sync UndoManager to the live graph reference ─────────────
        //
        // UndoManager holds a direct reference to the nodeGraph object.
        // If deserialization replaced the Map contents in-place (as confirmed
        // by MT6.1 — the Map object itself is never swapped, only its entries
        // are), the reference is technically still valid. syncGraph() is called
        // unconditionally anyway to guard against any implementation change
        // in NodeGraph.deserialize() that might swap the underlying object.
        this._undo.syncGraph(graph);

        // ── Step 7: Rebuild the NodeCard DOM ──────────────────────────────────
        this._rebuildCards();

        // ── Step 8: Redraw the edge layer ──────────────────────────────────────
        this._drawEdges();

        // ── Step 9: Synchronise GPU canvas visibility with graph renderability ──
        //
        // The animation loop stops calling _renderRayMarch() / _renderGLSL()
        // when _graphIsRenderable() returns false. But "stop calling" is not
        // the same as "clear the canvas". The last rendered frame sits frozen
        // in the WebGL canvas until something overwrites it — visible to the
        // user as a ghost image of the scene that was just undone.
        //
        // Two cases:
        //
        // CASE A — graph is no longer renderable after this undo/redo step:
        //   Call setRenderMode('marchingSquares'). That method hides the GPU
        //   canvases by setting opacity:0 on them, shows the Three.js canvas,
        //   and flushes the shader caches. The Three.js canvas renders the
        //   empty scene (solid black) on the next animation frame automatically.
        //   The mode button text is also updated so it truthfully describes
        //   what clicking it will do (enter GLSL mode).
        //
        // CASE B — graph is still renderable after this undo/redo step
        //   (e.g. a param change was reverted, but all nodes and edges remain):
        //   The GPU canvases are still showing the pre-undo render, which is
        //   now stale. Trigger an explicit re-render so the output immediately
        //   reflects the restored state rather than the image from before the
        //   undone action.
        //   For marchingSquares the Three.js scene was already rebuilt in
        //   steps 1–3; the user re-composes to update the contours.

        if (!this.sceneManager._graphIsRenderable()) {
            // ── Case A: graph empty or unwired ─────────────────────────────────
            // setRenderMode() handles all canvas show/hide logic:
            //   sdfRenderer.hide() + rayMarchRenderer.hide() — GPU canvases hidden
            //   threeCanvas opacity:1 — Three.js canvas shown
            //   _lastGLSLSource / _lastRayMarchSource nulled — shader caches flushed
            if (this.sceneManager.renderMode !== 'marchingSquares') {
                this.sceneManager.setRenderMode('marchingSquares');

                // Keep the button text in sync. _renderModeBtn is the DOM button
                // created in _buildDOM() and stored on the NodeCanvas instance.
                // Its text must always describe the mode the user will enter
                // on the NEXT click, not the current mode.
                this._renderModeBtn.textContent = '⬛ GLSL Mode';
            }
            // If already in marchingSquares: the Three.js scene was cleared and
            // rebuilt empty in steps 1–3. The animation loop renders it black
            // on the next frame. No further action needed.

        } else {
            // ── Case B: graph still renderable — re-render to show restored state
            if (this.sceneManager.renderMode === 'glsl') {
                // Immediate GLSL re-render. The evaluator was re-pointed in step 4
                // and the shader cache was flushed in step 5, so this will
                // recompile if the source changed and render the restored state.
                this.sceneManager._renderGLSL();

            } else if (this.sceneManager.renderMode === 'rayMarch') {
                // Immediate ray march re-render. Same conditions as above.
                this.sceneManager._renderRayMarch();
            }
            // marchingSquares: Three.js scene was rebuilt in steps 1–3 and the
            // animation loop renders it continuously. Composing is explicit in
            // this mode; no auto-compose is triggered here.
        }
    }
}