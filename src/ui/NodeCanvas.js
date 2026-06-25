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
    import { PRESETS } from '../presets/presets.js';
    import * as THREE from 'three';
    import { NODE_TYPES } from '../graph/NodeSpec.js';

    // Types that are shown as cards in the canvas
    const TOP_LEVEL_TYPES = new Set([
    'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
    'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane',
    'extrudeNode', 'revolveNode',
    'noiseDisplaceNode', 'twistNode', 'bendNode', 'repeatNode',
    'transform3DNode',
    'rUnion', 'rIntersection', 'rDifference', 'schurBlend', 'ifsBlend',
    'identityMapper', 'polynomialMapper', 'sinusoidalMapper',
    'exponentialMapper', 'logarithmicMapper', 'powerMapper',
    'periodicMapper', 'temporalMapper', 'recursiveMapper',
    'blendedMapper', 'compositeMapper',
    'affineTransform', 'tilingNode', 'mobiusNode',
    'symmetryFoldNode', 'symmetryOrbitNode',
    'timeNode', 'oscillatorNode',
    // outputNode is intentionally excluded — it is managed automatically
    // by the Render and mode-switch buttons and is never shown as a card.
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

        // Auto-orbit speed — degrees per second (internal OrbitControls units).
        // Range exposed to user: 0.5 (very slow, cinematic) to 10.0 (fast).
        // Default 4.0 is a confident turntable pace suited to demo footage.
        // Stored here so it persists across multiple R-key toggles within
        // a session and so the sidebar slider always reflects the live value.
        this._autoOrbitSpeed = 4.0;

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
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 1000;
        background: transparent;
        display: none;
        flex-direction: column;
        font-family: var(--font-sans, sans-serif);
        pointer-events: none;
        overflow: hidden;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        `;

        // ── Toolbar ───────────────────────────────────────────────────────────
        const toolbar = document.createElement('div');
        toolbar.style.cssText = `
        height: 46px;
        background: rgba(12,12,14,0.96);
        border-bottom: 1px solid rgba(255,255,255,0.10);
        display: flex;
        align-items: center;
        padding: 0 8px;
        gap: 4px;
        flex-shrink: 0;
        pointer-events: auto;
        backdrop-filter: blur(6px);
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
        min-width: 0;
        box-sizing: border-box;
        width: 100%;
        `;

        // ── Shared toolbar utilities ───────────────────────────────────────────
        // _selectStyle, _opt, _ph removed — toolbar dropdowns are now
        // custom div-based (see _makeCustomDropdown above) so native
        // <select> helpers are no longer needed.

        // ── Custom dropdown builder ───────────────────────────────────────────
        // Creates a fully browser-rendered dropdown (trigger + panel) that
        // OBS Display Capture can record, unlike native <select> elements
        // whose popup menus are rendered by the OS in a separate layer that
        // OBS cannot capture.
        //
        // Returns { el, setValue } where:
        //   el         — the root wrapper element to append to the toolbar
        //   setValue   — programmatically reset the displayed label (e.g.
        //                after a selection, to restore the placeholder text)
        //
        // @param {string}   placeholder   Label shown when nothing selected
        // @param {Array}    items         [{ value, label }] option list
        // @param {Function} onSelect      Called with (value) on selection
        const _makeCustomDropdown = (placeholder, items, onSelect) => {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = `
                position: relative;
                display: inline-block;
                flex-shrink: 0;
            `;

            // ── Trigger button ────────────────────────────────────────────────
            const trigger = document.createElement('button');
            trigger.style.cssText = `
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 4px;
                color: rgba(255,255,255,0.8);
                font-size: 12px;
                padding: 3px 8px;
                cursor: pointer;
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: 4px;
                font-family: var(--font-sans, sans-serif);
            `;
            trigger.textContent = placeholder;
            wrapper.appendChild(trigger);

            // ── Panel ─────────────────────────────────────────────────────────
            const panel = document.createElement('div');
            panel.style.cssText = `
                display: none;
                position: fixed;
                background: rgba(16,16,22,0.98);
                border: 1px solid rgba(255,255,255,0.14);
                border-radius: 6px;
                padding: 4px 0;
                z-index: 9999;
                min-width: 160px;
                box-shadow: 0 6px 24px rgba(0,0,0,0.55);
                font-family: var(--font-sans, sans-serif);
                pointer-events: auto;
            `;

            // Build one row per item
            items.forEach(({ value, label }) => {
                const item = document.createElement('div');
                item.textContent = label;
                item.dataset.value = value;
                item.style.cssText = `
                    padding: 7px 14px;
                    font-size: 12px;
                    color: rgba(220,220,230,0.9);
                    cursor: pointer;
                    white-space: nowrap;
                `;
                item.addEventListener('mouseenter', () => {
                    item.style.background = 'rgba(255,255,255,0.10)';
                });
                item.addEventListener('mouseleave', () => {
                    item.style.background = 'transparent';
                });
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // prevent outside-click handler firing first
                    onSelect(value);
                    trigger.textContent = placeholder; // reset to placeholder
                    panel.style.display = 'none';
                    document.removeEventListener('mousedown', outsideHandler);
                    _dropdownOpen = null;
                });
                panel.appendChild(item);
            });

            document.body.appendChild(panel);

            // ── Toggle open/close ─────────────────────────────────────────────
            let outsideHandler = null;

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();

                // Close any other open dropdown first
                if (_dropdownOpen && _dropdownOpen !== panel) {
                    _dropdownOpen.style.display = 'none';
                }

                const isOpen = panel.style.display === 'block';
                if (isOpen) {
                    panel.style.display = 'none';
                    _dropdownOpen = null;
                    if (outsideHandler) {
                        document.removeEventListener('mousedown', outsideHandler);
                        outsideHandler = null;
                    }
                    return;
                }

                // Position the panel directly below the trigger button
                const rect = trigger.getBoundingClientRect();
                panel.style.top  = `${rect.bottom + 4}px`;
                panel.style.left = `${rect.left}px`;
                panel.style.display = 'block';
                _dropdownOpen = panel;

                // Outside click closes the panel
                outsideHandler = (ev) => {
                    if (!panel.contains(ev.target) && ev.target !== trigger) {
                        panel.style.display = 'none';
                        _dropdownOpen = null;
                        document.removeEventListener('mousedown', outsideHandler);
                        outsideHandler = null;
                    }
                };
                // Small delay so the triggering click doesn't immediately close
                setTimeout(() => {
                    document.addEventListener('mousedown', outsideHandler);
                }, 80);
            });

            // setValue — allows external code to reset the label
            const setValue = (text) => { trigger.textContent = text; };

            return { el: wrapper, setValue, panel, trigger };
        };

        // Track which custom dropdown panel is currently open so we can
        // close it when another opens (only one open at a time).
        let _dropdownOpen = null;

        // Dispatch helper: called on every dropdown's change event.
        // Adds the selected node type and resets the dropdown to its placeholder.
        const _GEOM = new Set([
          'line','triangle','arc','circle','polygon','polytope',
          'sphere','box','cylinder','capsule','torus','cone','plane'
        ]);
        const _XFORM = new Set([
          'extrude','revolve','tiling','symmetryfold','symmetryorbit',
          'mobius','noisedisplace','twist','bend','repeat','position3d'
        ]);
        const _BLEND = new Set([
          'schurBlend','rUnion','rIntersection','rDifference'
        ]);

        const _dispatchAdd = (v, selectEl) => {
          if (!v) return;
          // Reset native select if one was passed; no-op for custom dropdown
          // plain objects since custom dropdowns reset their own label.
          if (selectEl && typeof selectEl.value === 'string') {
            selectEl.value = '';
          }

          // Belt-and-braces guard for bridge nodes: check the custom
          // dropdown panel's items for a disabled marker if it exists,
          // otherwise fall through to _addTransformNode's own guard.
          if (v === 'extrude' || v === 'revolve') {
            if (this._xformDropdownPanel) {
              const item = Array.from(this._xformDropdownPanel.querySelectorAll('[data-value]'))
                .find(el => el.dataset.value === v);
              if (item?.dataset.disabled === 'true') {
                this._showToast(
                  item.dataset.disabledReason || 'Extrude / Revolve not available here.',
                  3500
                );
                return;
              }
            }
          }

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
        const _2dDropdown = _makeCustomDropdown(
            '2D ▾',
            [
                { value: 'line',     label: 'Line'          },
                { value: 'triangle', label: 'Triangle'       },
                { value: 'arc',      label: 'Arc'            },
                { value: 'circle',   label: 'Circle'         },
                { value: 'polygon',  label: 'Polygon'        },
                { value: 'polytope', label: 'Conv. Polygon'  },
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _2dDropdown.el.title = 'Click a 2D primitive to add it to the graph';
        toolbar.appendChild(_2dDropdown.el);

        // ── 3D geometry dropdown ──────────────────────────────────────────────
        const _3dDropdown = _makeCustomDropdown(
            '3D ▾',
            [
                { value: 'sphere',   label: 'Sphere'    },
                { value: 'box',      label: 'Box'       },
                { value: 'cylinder', label: 'Cylinder'  },
                { value: 'capsule',  label: 'Capsule'   },
                { value: 'torus',    label: 'Torus'     },
                { value: 'cone',     label: 'Cone'      },
                { value: 'plane',    label: 'Plane'     },
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _3dDropdown.el.title = 'Click a 3D primitive to add it to the graph';
        toolbar.appendChild(_3dDropdown.el);

        // ── Transform / operation dropdown ────────────────────────────────────
        const _xformDropdown = _makeCustomDropdown(
            'Transform ▾',
            [
                { value: 'extrude',       label: 'Extrude'          },
                { value: 'revolve',       label: 'Revolve'          },
                { value: 'tiling',        label: 'Tiling'           },
                { value: 'symmetryfold',  label: 'Sym. Fold'        },
                { value: 'symmetryorbit', label: 'Sym. Orbit'       },
                { value: 'mobius',        label: 'Möbius'           },
                { value: 'noisedisplace', label: 'Noise Disp.'      },
                { value: 'twist',         label: 'Twist'            },
                { value: 'bend',          label: 'Bend'             },
                { value: 'repeat',        label: 'Repeat'           },
                { value: 'position3d',    label: 'Position / Orient'},
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _xformDropdown.el.title = 'Click an operation to add it to the graph';
        // Store reference so _updateDropdownAvailability can grey out
        // Extrude and Revolve items when bridges are invalid.
        this._xformDropdownPanel = _xformDropdown.panel;
        toolbar.appendChild(_xformDropdown.el);

        // ── Blend dropdown ────────────────────────────────────────────────────
        const _blendDropdown = _makeCustomDropdown(
            'Blend ▾',
            [
                { value: 'schurBlend',    label: 'Schur'       },
                { value: 'rUnion',        label: 'R-Union'     },
                { value: 'rIntersection', label: 'R-Intersect' },
                { value: 'rDifference',   label: 'R-Difference'},
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _blendDropdown.el.title = 'Click a blend mode to add it to the graph';
        toolbar.appendChild(_blendDropdown.el);

        // ── Section 3: HISTORY ────────────────────────────────────────────────
        // Camera zoom, view presets, card layout, and card zoom have all moved
        // to the right-hand sidebar (see _buildSidebar) to reduce top-bar
        // clutter. The sidebar builds its own instances of these controls;
        // this._viewBtn etc. are now created inside _buildSidebar() instead.
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

    
        // ── Graph status label ────────────────────────────────────────────────
        // Persistent warning indicator in the toolbar. Visible only when the
        // scene has no geometry primitives (the minimum condition for any render
        // to be meaningful). Hidden as soon as a primitive is added.
        // Controlled exclusively by _updateGraphStatusLabel().
        this._graphStatusLabel = document.createElement('span');
        this._graphStatusLabel.style.cssText = `
            font-size: 11px;
            padding: 3px 10px;
            border-radius: 4px;
            border: 1px solid rgba(255,180,60,0.45);
            background: rgba(255,160,30,0.12);
            color: rgba(255,210,120,0.95);
            white-space: nowrap;
            pointer-events: none;
            flex-shrink: 0;
        `;
        this._graphStatusLabel.textContent = '⚠ Add a primitive to render';
        toolbar.appendChild(this._graphStatusLabel);

        // Operation defaults (used by legacy _compose() only)
        this._composeOperation = 'union';

        // ── Section 4: RENDER ─────────────────────────────────────────────────
        //
        // "Render (CPU)" — triggers the marching-squares CPU render pipeline.
        // GLSL and ray march modes render automatically every animation frame;
        // the CPU path must be triggered explicitly because it is blocking and
        // can be slow on complex scenes.
        this._composeBtn = this._makeButton('⬡ Render', () => this._renderWithAutoOutput());
        this._composeBtn.title = 'Render the current scene via CPU marching squares';
        this._composeBtn.style.cssText += 'background: rgba(83,58,183,0.4); border-color: rgba(150,130,255,0.4);';
        toolbar.appendChild(this._composeBtn);

        // Gear button and Lines slider have moved to the sidebar's Output
        // section (see _buildSidebar). this._isoSlider / this._isoLabel are
        // now created there; _toggleRenderMode() still references them by
        // the same instance properties so no other code needs to change.

        // Render mode toggle (cycles marchingSquares → glsl → rayMarch)
        this._renderModeBtn = this._makeButton('⬛ GLSL Mode', () => {
          // Guard: if no geometry exists the button is greyed out and the
          // click is a no-op. _updateGraphStatusLabel() controls the visual
          // disabled state; this guard is belt-and-braces.
          if (!this._sceneHasGeometry()) return;
          // Ensure output node exists and all chain tails are wired before
          // switching mode — the GLSL and ray march renderers both read from
          // the output node to find the root SDF.
          this._ensureOutputWired();
          this._toggleRenderMode();
        });
        this._renderModeBtn.style.cssText += 'border-color: rgba(80,200,120,0.4); color: rgba(160,255,180,0.9);';
        toolbar.appendChild(this._renderModeBtn);

            

        // ── Presets button ────────────────────────────────────────────────────
        // Opens a small panel listing the three V1 example scenes.
        // Each preset loads a complete graph and switches to the correct render mode.
        const _presetsBtn = this._makeButton('⬡ Examples', () =>
            this._togglePresetPanel(_presetsBtn)
        );
        _presetsBtn.title = 'Load an example scene';
        _presetsBtn.style.cssText += 'border-color: rgba(100,200,255,0.35); color: rgba(180,230,255,0.9);';
        toolbar.appendChild(_presetsBtn);
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

        // Sync drawer and popover controls with the loaded output node params.
        // The output node was deserialized by loadScene() so its params now
        // reflect the saved values. Push those values to both UIs so the
        // controls display the correct state immediately after load.
        const ALL_OUTPUT_PARAMS = [
            'renderMethod', 'resolution', 'boundsMin', 'boundsMax',
            'posX', 'posY', 'posZ', 'rotateX', 'rotateY', 'rotateZ',
        ];
        ALL_OUTPUT_PARAMS.forEach(k => {
            this._syncOutputControls(k, this._getOutputParam(k));
        });
        // Also populate _pendingOutputParams so values are preserved if the
        // user edits settings before clicking Render after a load
        if (!this._pendingOutputParams) this._pendingOutputParams = {};
        ALL_OUTPUT_PARAMS.forEach(k => {
            this._pendingOutputParams[k] = this._getOutputParam(k);
        });
        this._updateGraphStatusLabel();

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

    // ── Feedback link ──────────────────────────────────────────────────────
    // Opens an external short-form questionnaire in a new tab. Deliberately
    // a plain labelled link, not an in-app modal/popup — does not interrupt
    // the user's session, costs nothing to build/maintain, and stays
    // findable (full text label, not just an icon) for anyone who wants to
    // report something or share thoughts.
    const _feedbackBtn = this._makeButton('💬 Feedback', () => {
        window.open('https://docs.google.com/forms/d/e/1FAIpQLSe5hZqAi1epB7XjBgN0SKYhaPPGff7FroaGm5hzi5f4jV1ysA/viewform', '_blank', 'noopener');
    });
    _feedbackBtn.title = 'Share feedback or report an issue (opens in a new tab)';
    _feedbackBtn.style.cssText += 'border-color: rgba(150,150,255,0.3); color: rgba(190,190,255,0.85);';
    toolbar.appendChild(_feedbackBtn);

    
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

        // ── Right-hand sidebar — replaces the former bottom drawer and absorbs
        // camera, layout, and output controls that previously crowded the
        // top toolbar. See _buildSidebar() for full contents.
        this._buildSidebar();

        // ── Initial dropdown availability ─────────────────────────────────────
        // Evaluate bridge (Extrude/Revolve) availability once after the DOM
        // is fully built, so the initial state is correct before any graph
        // changes or selection events have fired.
        requestAnimationFrame(() => this._updateDropdownAvailability());
    }

    /**
     * Build the right-hand sidebar. Replaces the former bottom drawer and
     * absorbs camera/layout/output controls previously crowding the top
     * toolbar. The sidebar auto-collapses to a thin edge tab and expands on
     * hover or when pinned open.
     *
     * Structure:
     *   Section 1 — Camera   (scene zoom, view presets, home)
     *   Section 2 — Layout   (card direction, auto, fit, card zoom, stack)
     *   Section 3 — Output   (render method, resolution, bounds, lines, placement)
     *
     * Collapsed width: 14px (just the edge tab, always visible as a grab handle).
     * Expanded width: 260px.
     */
    _buildSidebar() {
        const SIDEBAR_COLLAPSED_W = 14;
        const SIDEBAR_EXPANDED_W  = 260;

        const sidebar = document.createElement('div');
        sidebar.id = 'nc-sidebar';
        sidebar.style.cssText = `
            position: fixed;
            top: 46px;
            right: 0;
            bottom: 0;
            width: ${SIDEBAR_COLLAPSED_W}px;
            background: rgba(12,12,18,0.96);
            border-left: 1px solid rgba(255,255,255,0.10);
            backdrop-filter: blur(6px);
            z-index: 1500;
            pointer-events: auto;
            overflow-y: auto;
            overflow-x: hidden;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.15) transparent;
            transition: width 0.16s ease;
            box-sizing: border-box;
        `;

        // ── Discoverability glow ─────────────────────────────────────────────
        // A slow, subtle pulsing glow on the collapsed sidebar's left edge —
        // an ambient, non-interrupting hint that there's more content here,
        // without forcing the sidebar open or stealing focus from the
        // viewport. Stops permanently once the user has opened the sidebar
        // at least once (see the 'mouseenter' handler below), since at that
        // point they've discovered it and the hint is no longer needed.
        if (!document.getElementById('nc-sidebar-glow-style')) {
            const glowStyle = document.createElement('style');
            glowStyle.id = 'nc-sidebar-glow-style';
            // Stronger, wider glow than the original attempt — at a 14px
            // collapsed width the sidebar is a very thin strip, so a subtle
            // box-shadow can be easy to miss against a dark canvas
            // background. Also adds a border-color pulse alongside the
            // shadow so the effect reads clearly even on lower-contrast
            // displays or in a quick screen recording.
            glowStyle.textContent = `
                @keyframes nc-sidebar-glow-pulse {
                    0%, 100% {
                        box-shadow: -3px 0 14px rgba(100,180,255,0.35);
                        border-left-color: rgba(100,180,255,0.35);
                    }
                    50% {
                        box-shadow: -3px 0 26px rgba(100,180,255,0.75);
                        border-left-color: rgba(140,200,255,0.9);
                    }
                }
                #nc-sidebar.nc-sidebar-glow {
                    animation: nc-sidebar-glow-pulse 2.2s ease-in-out infinite;
                }
            `;
            document.head.appendChild(glowStyle);
        }
        sidebar.classList.add('nc-sidebar-glow');

        // ── Pin toggle ───────────────────────────────────────────────────────
        // When pinned, the sidebar stays expanded regardless of mouse position.
        // Persisted only for the session (not saved across reloads).
        this._sidebarPinned = false;

        const expand = () => {
            sidebar.style.width = `${SIDEBAR_EXPANDED_W}px`;
            content.style.opacity = '1';
            content.style.pointerEvents = 'auto';
            // Once the sidebar has been opened (by hover or programmatically)
            // at least once, the discoverability glow has served its purpose
            // — remove it permanently for the rest of the session so it
            // doesn't keep pulsing distractingly once the user already knows
            // it's there.
            sidebar.classList.remove('nc-sidebar-glow');
        };
        const collapse = () => {
            if (this._sidebarPinned) return;
            sidebar.style.width = `${SIDEBAR_COLLAPSED_W}px`;
            content.style.opacity = '0';
            content.style.pointerEvents = 'none';
        };

        sidebar.addEventListener('mouseenter', expand);
        sidebar.addEventListener('mouseleave', collapse);

        // ── Content wrapper (hidden when collapsed) ───────────────────────────
        const content = document.createElement('div');
        content.style.cssText = `
            width: ${SIDEBAR_EXPANDED_W}px;
            padding: 12px 10px 24px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.12s ease;
            box-sizing: border-box;
        `;

        // ── Pin button (top of sidebar, always part of content) ──────────────
        const pinRow = document.createElement('div');
        pinRow.style.cssText = 'display:flex; justify-content:flex-end; margin-bottom:8px;';
        const pinBtn = document.createElement('button');
        pinBtn.textContent = '📌';
        pinBtn.title = 'Pin sidebar open';
        pinBtn.style.cssText = `
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 4px;
            color: rgba(255,255,255,0.5);
            font-size: 12px;
            padding: 3px 8px;
            cursor: pointer;
        `;
        pinBtn.addEventListener('click', () => {
            this._sidebarPinned = !this._sidebarPinned;
            pinBtn.style.background = this._sidebarPinned
                ? 'rgba(100,180,255,0.25)' : 'rgba(255,255,255,0.06)';
            pinBtn.style.borderColor = this._sidebarPinned
                ? 'rgba(100,180,255,0.5)' : 'rgba(255,255,255,0.14)';
            if (this._sidebarPinned) expand();
        });
        pinRow.appendChild(pinBtn);
        content.appendChild(pinRow);

        // ── Section builder helper ────────────────────────────────────────────
        const _section = (title) => {
            const sec = document.createElement('div');
            sec.style.cssText = 'margin-bottom: 18px;';
            const hdr = document.createElement('div');
            hdr.textContent = title;
            hdr.style.cssText = `
                font-size: 11px;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                opacity: 0.5;
                margin-bottom: 8px;
                color: rgba(220,220,230,0.9);
            `;
            sec.appendChild(hdr);
            content.appendChild(sec);
            return sec;
        };

        // Row of buttons/controls within a section, wraps if needed
        const _btnRow = (parent) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; flex-wrap:wrap; gap:5px; margin-bottom:6px;';
            parent.appendChild(row);
            return row;
        };

        // ════════════════════════════════════════════════════════════════════
        // SECTION 1 — CAMERA
        // ════════════════════════════════════════════════════════════════════
        const camSection = _section('Camera');
        const camRow1 = _btnRow(camSection);

        const _sceneZoomIn = this._makeButton('↑ Zoom In', () => {
          const cam  = this.sceneManager.camera;
          const ctrl = this.sceneManager.controls;
          if (!cam || !ctrl) return;
          const dist = cam.position.distanceTo(ctrl.target);
          const dir  = cam.position.clone().sub(ctrl.target).normalize();
          cam.position.copy(ctrl.target.clone().add(dir.multiplyScalar(dist * 0.8)));
          ctrl.update();
        });
        _sceneZoomIn.title = 'Zoom in on 3D scene';
        _sceneZoomIn.style.cssText += 'flex:1; min-width:0; font-size:12px;';
        camRow1.appendChild(_sceneZoomIn);

        const _sceneZoomOut = this._makeButton('↓ Zoom Out', () => {
          const cam  = this.sceneManager.camera;
          const ctrl = this.sceneManager.controls;
          if (!cam || !ctrl) return;
          const dist = cam.position.distanceTo(ctrl.target);
          const dir  = cam.position.clone().sub(ctrl.target).normalize();
          cam.position.copy(ctrl.target.clone().add(dir.multiplyScalar(dist * 1.25)));
          ctrl.update();
        });
        _sceneZoomOut.title = 'Zoom out on 3D scene';
        _sceneZoomOut.style.cssText += 'flex:1; min-width:0; font-size:12px;';
        camRow1.appendChild(_sceneZoomOut);

        const camRow2 = _btnRow(camSection);
        this._viewBtn = this._makeButton('View ▾', () =>
            this._toggleViewMenu(this._viewBtn)
        );
        this._viewBtn.title = 'Snap camera to a preset viewing angle';
        this._viewBtn.style.cssText += 'flex:1; min-width:0; font-size:11px;';
        camRow2.appendChild(this._viewBtn);

        const _camResetBtn = this._makeButton('⌂ Home', () => {
            this._setCameraView('home');
        });
        _camResetBtn.title = 'Reset camera to default view (Home)';
        _camResetBtn.style.cssText += 'flex:1; min-width:0; font-size:11px;';
        camRow2.appendChild(_camResetBtn);

        // ── Auto-orbit speed slider ───────────────────────────────────────
        // Controls how fast the camera revolves when auto-orbit (R key) is
        // active. Graduated from very slow (0.5 — cinematic, good for long
        // establishing shots) to fast (10.0 — quick demo spins). Updates
        // live even while orbit is already running, so the user can dial
        // in the right speed while watching the result.
        const orbitSpeedRow = document.createElement('div');
        orbitSpeedRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 6px;
            margin-bottom: 2px;
        `;

        const orbitSpeedLabel = document.createElement('label');
        orbitSpeedLabel.textContent = 'Orbit speed';
        orbitSpeedLabel.title = 'Auto-orbit rotation speed (R key). ' +
            'Slow (left) for cinematic shots and GIFs. ' +
            'Fast (right) for quick demo spins. ' +
            'Updates live while orbit is running.';
        orbitSpeedLabel.style.cssText = `
            font-size: 12px;
            opacity: 0.75;
            min-width: 72px;
            flex-shrink: 0;
            cursor: help;
            white-space: nowrap;
            color: rgba(220,220,230,0.9);
        `;

        const orbitSpeedSlider = document.createElement('input');
        orbitSpeedSlider.type  = 'range';
        orbitSpeedSlider.min   = '0.5';
        orbitSpeedSlider.max   = '10.0';
        orbitSpeedSlider.step  = '0.5';
        orbitSpeedSlider.value = String(this._autoOrbitSpeed);
        orbitSpeedSlider.title = orbitSpeedLabel.title;
        orbitSpeedSlider.style.cssText = `
            flex: 1;
            min-width: 0;
            height: 14px;
            accent-color: #378ADD;
            cursor: pointer;
        `;

        const orbitSpeedDisplay = document.createElement('span');
        orbitSpeedDisplay.textContent = this._autoOrbitSpeed.toFixed(1);
        orbitSpeedDisplay.style.cssText = `
            font-size: 11px;
            opacity: 0.8;
            min-width: 28px;
            text-align: right;
            font-variant-numeric: tabular-nums;
            flex-shrink: 0;
            color: rgba(220,220,230,0.85);
        `;

        orbitSpeedSlider.addEventListener('input', () => {
            const val = parseFloat(orbitSpeedSlider.value);
            this._autoOrbitSpeed = val;
            orbitSpeedDisplay.textContent = val.toFixed(1);

            // Apply live if orbit is currently running — user sees the
            // speed change immediately without needing to stop and restart.
            const ctrl = this.sceneManager.controls;
            if (ctrl && ctrl.autoRotate) {
                ctrl.autoRotateSpeed = val;
            }
        });

        orbitSpeedRow.appendChild(orbitSpeedLabel);
        orbitSpeedRow.appendChild(orbitSpeedSlider);
        orbitSpeedRow.appendChild(orbitSpeedDisplay);
        camSection.appendChild(orbitSpeedRow);

        // ════════════════════════════════════════════════════════════════════
        // SECTION 2 — LAYOUT
        // ════════════════════════════════════════════════════════════════════
        const layoutSection = _section('Card Layout');

        this._layoutSelect = document.createElement('select');
        this._layoutSelect.style.cssText = `
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 4px;
            color: rgba(255,255,255,0.8);
            font-size: 12px;
            padding: 4px 6px;
            cursor: pointer;
            width: 100%;
            margin-bottom: 6px;
            box-sizing: border-box;
        `;
        this._layoutSelect.title = 'Choose auto-layout direction';
        LAYOUT_DIRECTIONS.forEach(dir => {
          const o = document.createElement('option');
          o.value = dir; o.textContent = dir;
          o.style.backgroundColor = '#1c1c22';
          o.style.color = 'rgba(220,220,230,0.95)';
          this._layoutSelect.appendChild(o);
        });
        this._layoutSelect.addEventListener('change', () => {
          this._layoutDir = this._layoutSelect.value;
          this._undo.snapshot();
          this._runAutoLayout();
        });
        layoutSection.appendChild(this._layoutSelect);

        const layoutRow1 = _btnRow(layoutSection);
        const _autoLayoutBtn = this._makeButton('Auto', () => {
          this._undo.snapshot();
          this._runAutoLayout();
        });
        _autoLayoutBtn.title = 'Auto-arrange all node cards';
        _autoLayoutBtn.style.cssText += 'flex:1; min-width:0; font-size:12px;';
        layoutRow1.appendChild(_autoLayoutBtn);

        const _fitBtn = this._makeButton('Fit All', () => this._fitToScreen());
        _fitBtn.title = 'Fit all node cards into the visible area';
        _fitBtn.style.cssText += 'flex:1; min-width:0; font-size:12px;';
        layoutRow1.appendChild(_fitBtn);

        const layoutRow2 = _btnRow(layoutSection);
        const _cardsZoomIn = this._makeButton('+ Zoom', () => {
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
        _cardsZoomIn.style.cssText += 'flex:1; min-width:0; font-size:12px;';
        layoutRow2.appendChild(_cardsZoomIn);

        const _cardsZoomOut = this._makeButton('− Zoom', () => {
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
        _cardsZoomOut.style.cssText += 'flex:1; min-width:0; font-size:12px;';
        layoutRow2.appendChild(_cardsZoomOut);

        // ── Stack Cards ────────────────────────────────────────────────────
        // Moves every node card to a collapsed, overlapping pile in the
        // top-left corner of the canvas, well outside the area where the
        // 3D viewport / geometry is visible. Lets the user see the rendered
        // shape with zero visual obstruction from the node graph.
        // Positions are saved into node.uiPos as normal, so Fit All / Auto
        // restore a readable layout afterward.
        const stackRow = _btnRow(layoutSection);
        const _stackBtn = this._makeButton('⊞ Stack Cards', () => this._stackAllCards());
        _stackBtn.title = 'Pile all node cards in a corner so the geometry view is unobstructed';
        _stackBtn.style.cssText += 'flex:1; min-width:0; font-size:12px; border-color: rgba(255,200,80,0.3); color: rgba(255,225,160,0.85);';
        stackRow.appendChild(_stackBtn);

        // ════════════════════════════════════════════════════════════════════
        // SECTION 3 — OUTPUT
        // ════════════════════════════════════════════════════════════════════
        const outputSection = _section('Output');

        const outputNote = document.createElement('div');
        outputNote.textContent = 'CPU path only · GLSL/Ray March use canvas resolution';
        outputNote.style.cssText = `
            font-size: 10px;
            opacity: 0.35;
            font-style: italic;
            margin-bottom: 10px;
            line-height: 1.4;
            color: rgba(220,220,230,0.8);
        `;
        outputSection.appendChild(outputNote);

        // Render method, resolution, bounds, placement — reuse the existing
        // shared builder so behaviour and sync logic are identical to before.
        const outputControlsWrap = document.createElement('div');
        outputControlsWrap.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
        outputControlsWrap.appendChild(this._buildOutputControls('sidebar'));
        outputSection.appendChild(outputControlsWrap);

        // "Lines" (GLSL contour density) slider — moved here from top bar
        const linesRow = document.createElement('div');
        linesRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:10px;';
        const _isoLabel = document.createElement('span');
        _isoLabel.textContent = 'Lines:';
        _isoLabel.style.cssText = 'font-size:12px; color:rgba(255,255,255,0.5); min-width:38px;';
        this._isoLabel = _isoLabel;
        linesRow.appendChild(_isoLabel);

        this._isoSlider = document.createElement('input');
        this._isoSlider.type  = 'range';
        this._isoSlider.min   = '0.1';
        this._isoSlider.max   = '2.0';
        this._isoSlider.step  = '0.05';
        this._isoSlider.value = '0.5';
        this._isoSlider.style.cssText = 'flex:1; min-width:0; cursor:pointer; opacity:0.4;';
        this._isoSlider.disabled = true;
        this._isoSlider.title = 'Contour line density (GLSL mode only)';
        this._isoSlider.addEventListener('input', () => {
          const v = parseFloat(this._isoSlider.value);
          this.sceneManager.sdfRenderer.setIsoStep(v);
          if (this.sceneManager.renderMode === 'glsl') {
            this.sceneManager._renderGLSL();
          }
        });
        linesRow.appendChild(this._isoSlider);
        outputSection.appendChild(linesRow);

        sidebar.appendChild(content);
        document.body.appendChild(sidebar);
        this._sidebar = sidebar;
    }

    /**
     * Move every visible node card into a tight overlapping stack near the
     * top-left of the canvas, well clear of the centre viewport. This gives
     * the user an unobstructed view of the rendered geometry while keeping
     * the graph structure intact and easy to restore.
     *
     * Cards are stacked with a small cascading offset (12px per card) so
     * the topmost few are still individually clickable/draggable; deeper
     * cards in the pile can be reached by dragging the ones above them
     * aside, or by clicking Fit All / Auto to restore full layout.
     */
    _stackAllCards() {
        this._undo.snapshot();
        // Anchor the stack hard against the left edge, near the top, so it
        // never overlaps the centred 3D/2D viewport regardless of window
        // width. Negative-leaning X keeps the pile mostly off-canvas to the
        // left; _fitToScreen()/_runAutoLayout() remain the way to bring
        // cards back into a readable on-screen layout.
        const STACK_X = -260;
        const STACK_Y = 10;
        const OFFSET  = 14;

        let i = 0;
        this.stateStore.nodeGraph.nodes.forEach((node) => {
            if (!this._cards.has(node.id)) return;
            const x = STACK_X + (i % 6) * OFFSET;
            const y = STACK_Y + (i % 6) * OFFSET;
            this.stateStore.nodeGraph.updateNodePosition(node.id, x, y);
            i++;
        });

        this._rebuildCards();
        this._drawEdges();
    }

    _makeButton(text, onClick) {
        const btn = document.createElement('button');
        btn.textContent  = text;
        btn.style.cssText = `
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 4px;
        color: rgba(255,255,255,0.75);
        font-size: 12px;
        padding: 3px 8px;
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
        this._updateGraphStatusLabel();
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
              //
              // Group-drag: if the dragged card is part of a multi-selection
              // (Shift+click to build a set, e.g. an entire visual chain of
              // cards selected one-by-one), every other selected card moves
              // by the same delta so the whole group can be repositioned
              // together — covers the "drag this chain off to the side"
              // need without requiring topology-aware auto-selection.
              if (this._selectedIds.has(nodeId) && this._selectedIds.size > 1) {
                  const draggedNode = this.stateStore.nodeGraph.nodes.get(nodeId);
                  const prevX = draggedNode?.uiPos?.x ?? x;
                  const prevY = draggedNode?.uiPos?.y ?? y;
                  const dx = x - prevX;
                  const dy = y - prevY;

                  this._selectedIds.forEach(selId => {
                      if (selId === nodeId) {
                          this.stateStore.nodeGraph.updateNodePosition(nodeId, x, y);
                          return;
                      }
                      const otherNode = this.stateStore.nodeGraph.nodes.get(selId);
                      const otherCard = this._cards.get(selId);
                      if (!otherNode || !otherCard) return;
                      const newX = (otherNode.uiPos?.x ?? 0) + dx;
                      const newY = (otherNode.uiPos?.y ?? 0) + dy;
                      this.stateStore.nodeGraph.updateNodePosition(selId, newX, newY);
                      // Keep the card's own DOM position in sync immediately
                      // (NodeCard normally does this for the card being
                      // actively dragged; for the other group members we
                      // need to push it manually here).
                      otherCard.el.style.left = `${newX}px`;
                      otherCard.el.style.top  = `${newY}px`;
                  });
              } else {
                  this.stateStore.nodeGraph.updateNodePosition(nodeId, x, y);
              }
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

    /**
     * Delete every currently selected node (and all edges touching it) from
     * the graph, scene, and evaluator caches. Triggered by the Delete /
     * Backspace key. Unlike the right-click single-node delete, this does
     * NOT show a confirm() dialog — keypress deletion is treated as a fast,
     * deliberate multi-select action and is fully undoable via Ctrl+Z.
     *
     * This is the primary mechanism for "swap one primitive in a complex
     * scene": select the node card to remove (e.g. a Cylinder feeding into
     * several downstream transforms/blends), press Delete, then add the
     * replacement (e.g. a Cone) and drag-connect it into the now-dangling
     * input port left behind.
     */
    _deleteSelectedNodes() {
        const idsToDelete = [...this._selectedIds];
        if (idsToDelete.length === 0) return;

        this._undo.snapshot();
        const graph = this.stateStore.nodeGraph;

        idsToDelete.forEach(nodeId => {
            const node = graph.nodes.get(nodeId);
            if (!node) return;

            // Collect and remove every edge touching this node first —
            // NodeGraph may validate edge integrity on node removal.
            const edgeIdsToRemove = [];
            graph.edges.forEach(edge => {
                if (edge.fromNode === nodeId || edge.toNode === nodeId) {
                    edgeIdsToRemove.push(edge.id);
                }
            });
            edgeIdsToRemove.forEach(eid => {
                try { graph.removeEdge(eid); } catch(_) {}
            });

            // Remove the node itself
            try {
                graph.removeNode(nodeId);
            } catch(e) {
                console.warn(`NodeCanvas: could not remove node ${nodeId}:`, e.message);
                return;
            }

            // If this was a geometry primitive, remove its Three.js mesh too
            const primIdx = this.sceneManager.activePrimitives.findIndex(
                p => p.instance.id === nodeId
            );
            if (primIdx !== -1) {
                const primEntry = this.sceneManager.activePrimitives[primIdx];
                this.sceneManager._removeFromScene(primEntry);
                this.sceneManager.activePrimitives.splice(primIdx, 1);
            }

            // If this was the current SchurComposition instance, clear it too
            if (this.sceneManager.currentSchur?.instance?.id === nodeId) {
                this.sceneManager._removeFromScene(this.sceneManager.currentSchur);
                this.sceneManager.currentSchur = null;
            }
        });

        // Clear selection — the deleted nodes no longer exist
        this._selectedIds.clear();

        // Invalidate shader caches so the next render reflects the deletion
        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager.evaluator.invalidate();

        setTimeout(() => {
            this._rebuildCards();
            this._drawEdges();
            this._updateGraphStatusLabel();
        }, 50);
    }

    /**
     * Toggle "presentation mode" — hides the toolbar and sidebar so only
     * the rendered geometry fills the screen, with no UI chrome in frame.
     * Intended for capturing clean screenshots, video, or GIFs (e.g. for
     * the README, demo videos, or social posts) without manually hiding
     * elements via DevTools each time.
     *
     * Toggled by the 'F' key (and exited via Escape or 'F' again).
     * Node cards, edges, and the canvas-area background grid are also
     * hidden — only the Three.js / GLSL / Ray March render canvas remains
     * visible, exactly as the user composed it.
     *
     * Does not pause rendering, change render mode, or affect camera state —
     * purely a DOM visibility toggle, fully reversible with no side effects
     * on the underlying scene or graph.
     */
    _togglePresentationMode() {
        this._presentationMode = !this._presentationMode;

        const toolbar = this._overlay.querySelector(':scope > div:first-child');
        const canvasArea = this._bgCanvas?.parentElement;

        if (this._presentationMode) {
            // Hide toolbar
            if (toolbar) toolbar.style.display = 'none';
            // Hide sidebar
            if (this._sidebar) this._sidebar.style.display = 'none';
            // Hide the node-graph background canvas (grid + edges) and the
            // card container — leaves only the render canvas(es) visible.
            if (this._bgCanvas) this._bgCanvas.style.display = 'none';
            if (this._inner)    this._inner.style.display    = 'none';
            // Hide any open popovers/panels that might be lingering
            ['nc-export-panel', 'nc-preset-panel', 'nc-view-menu', 'nc-toast']
                .forEach(id => document.getElementById(id)?.remove());

            // Small unobtrusive indicator so the user knows the hotkey is
            // active and how to exit — fades out on its own after a moment
            // so it does not itself end up in a screenshot taken quickly.
            this._showToast('Presentation mode — press F or Esc to restore UI', 2200);
        } else {
            if (toolbar) toolbar.style.display = '';
            if (this._sidebar) this._sidebar.style.display = '';
            if (this._bgCanvas) this._bgCanvas.style.display = '';
            if (this._inner)    this._inner.style.display    = '';
        }
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

        if (nodeId === null) {
            // Selection cleared — re-evaluate bridge availability now that
            // no specific node is selected (Priority 2 logic takes over).
            this._updateDropdownAvailability();
            return;
        }

        this._selectedIds.add(nodeId);
        const card = this._cards.get(nodeId);
        if (card) {
        card.el.style.outline = '2px solid rgba(100,180,255,0.8)';
        card.el.style.outlineOffset = '2px';
        }
        // Re-evaluate bridge availability for the newly selected node.
        this._updateDropdownAvailability();
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
          outNodeId = fromNodeId;
          outPort   = fromPortName;
          inNodeId  = toNodeId;
          inPort    = toPortName;
        } else if (fromDir === 'in' && toDir === 'out') {
          outNodeId = toNodeId;
          outPort   = toPortName;
          inNodeId  = fromNodeId;
          inPort    = fromPortName;
        } else {
          return;
        }

        // ── V1 dimensional bridge wiring guard ────────────────────────────────
        // Prevent invalid connections that the dropdown greying cannot catch
        // (because the user drag-connected manually rather than using the
        // dropdown). Specifically blocks:
        //   1. A 3D primitive output wired into an Extrude or Revolve input
        //   2. A bridge node (Extrude/Revolve) output wired into another
        //      bridge node's input (bridge chaining is invalid in V1)
        const graph = this.stateStore.nodeGraph;
        const TYPES_3D = new Set([
            'sphere','box','cylinder','capsule','torus','cone','plane'
        ]);
        const BRIDGE_TYPES = new Set(['extrudeNode','revolveNode']);

        const fromNode = graph.nodes.get(outNodeId);
        const toNode   = graph.nodes.get(inNodeId);

        if (fromNode && toNode) {
            const fromIs3D     = TYPES_3D.has(fromNode.type);
            const fromIsBridge = BRIDGE_TYPES.has(fromNode.type);
            const toIsBridge   = BRIDGE_TYPES.has(toNode.type);

            if (toIsBridge && fromIs3D) {
                this._showToast(
                    `Cannot connect "${fromNode.type}" → "${toNode.type}": ` +
                    `Extrude / Revolve require a 2D primitive as input. ` +
                    `Connect a 2D shape (circle, arc, polygon…) instead.`,
                    4000
                );
                return;
            }

            if (toIsBridge && fromIsBridge) {
                this._showToast(
                    `Cannot chain two dimensional bridges: ` +
                    `"${fromNode.type}" → "${toNode.type}" is not supported in V1. ` +
                    `A bridge node already produces a 3D solid — ` +
                    `connect it to a blend or transform node instead.`,
                    4000
                );
                return;
            }
        }

        this._undo.snapshot();
        try {
          this.stateStore.nodeGraph.addEdge(outNodeId, outPort, inNodeId, inPort);
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
          this._updateGraphStatusLabel();
        }, 50);
    }

    /**
   * Add a blend node to the graph WITHOUT auto-wiring.
   * Blend nodes always require explicit multi-input wiring by the user.
   * The user must drag-connect two source branches into sdfA and sdfB,
   * then drag-connect the result port to Output or the next node.
   */
    _addBlendNode(type) {
      // Blend nodes require explicit wiring by the user — they have two input
      // ports (sdfA, sdfB) and one result port. The output node is NOT created
      // or wired here; that happens automatically when the user clicks Render
      // or a mode-switch button.
      this._undo.snapshot();
      const graph  = this.stateStore.nodeGraph;
      const params = {
        schurBlend:    { operation:'union', smoothness:8, rotation:0, scale:1, posX:0, posY:0, isoOffset:0 },
        rUnion:        { smoothness: 8 },
        rIntersection: { smoothness: 8 },
        rDifference:   { smoothness: 8 },
      }[type] || {};

      const newNode = graph.addNode(type, params);

      setTimeout(() => {
        this._runAutoLayout();
        this._drawEdges();
        this._updateGraphStatusLabel();
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
      revolve:       { type: 'revolveNode',       params: { offset: 0, axis: 'Y' } },
      tiling:        { type: 'tilingNode',        params: { lattice:'hexagonal', periodX:3, periodY:3, offsetX:0, offsetY:0, isoOffset:0 } },
      symmetryfold:  { type: 'symmetryFoldNode',  params: { folds:6, centerX:0, centerY:0, rotation:0, reflectX:'no', reflectY:'no' } },
      symmetryorbit: { type: 'symmetryOrbitNode', params: { folds:6, centerX:0, centerY:0, rotation:0, reflectX:'no', combiner:'min', smoothness:8 } },
      mobius:        { type: 'mobiusNode',        params: { aRe:1, aIm:0, bRe:0, bIm:0, cRe:0, cIm:0, dRe:1, dIm:0 } },
      noisedisplace: { type: 'noiseDisplaceNode', params: { amplitude:0.3, frequency:3, animated:'no' } },
      twist:         { type: 'twistNode',         params: { strength:1.0 } },
      bend:          { type: 'bendNode',          params: { strength:0.5 } },
      repeat:        { type: 'repeatNode',        params: { countX:3, countY:3, countZ:1, spacingX:3, spacingY:3, spacingZ:3 } },
      // Position / Orient — compositional 3D transform.
      // Lets the user move and rotate a sub-assembly before blending it
      // with other shapes. Distinct from the output-level placement sliders
      // which reposition the entire final scene as a single rigid body.
      position3d:    { type: 'transform3DNode',   params: { posX:0, posY:0, posZ:0, rotateX:0, rotateY:0, rotateZ:0 } },
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

    // LINEAR_XFORM: nodes that participate in auto-chain walking.
    const LINEAR_XFORM = new Set([
      'noiseDisplaceNode','twistNode','bendNode',
      'repeatNode','tilingNode','symmetryFoldNode','symmetryOrbitNode','mobiusNode',
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

    // ── Output node is NOT touched here ────────────────────────────────────
    // The output node is created and wired automatically when the user
    // clicks Render or a mode-switch button. _addTransformNode only wires
    // primitives and transforms together into chains; it never reaches the
    // output node. This keeps the output node lifecycle entirely owned by
    // the render path.
    //
    // Exception: if an output node already exists from a previous render
    // (e.g. after undo/redo or scene load) and the chain tail was previously
    // wired to it, we repair that edge here so an existing working graph
    // stays valid after a transform is inserted mid-chain.
    const existingOutNode = (() => {
      let found = null;
      graph.nodes.forEach(n => { if (n.type === 'outputNode') found = n; });
      return found;
    })();

    if (existingOutNode && chainTailId) {
      const outEdges = graph.getAllIncomingEdges(existingOutNode.id, 'sdf') || [];
      const tailWasToOutput = outEdges.some(e => e.fromNode === chainTailId);
      if (tailWasToOutput) {
        // The chain tail was wired to output before we inserted this transform.
        // Remove the stale tail→output edge and re-wire newNode→output so the
        // chain continues to reach the output without user intervention.
        const oldEdge = outEdges.find(e => e.fromNode === chainTailId);
        if (oldEdge) {
          graph.removeEdge(oldEdge.id);
        }
        try {
          graph.addEdge(newNode.id, 'result', existingOutNode.id, 'sdf');
        } catch(e) { /* edge already exists */ }
      }
    }

    setTimeout(() => {
      this._runAutoLayout();
      this._drawEdges();
      this._updateGraphStatusLabel();
    }, 50);
  }

    /**
     * Build the four output parameter controls and return a DocumentFragment.
     * Called by both _buildOutputDrawer() (Option 2) and _toggleOutputPopover()
     * (Option 1) so the controls are always structurally identical and share
     * the same data-output-param attribute contract used by _syncOutputControls().
     *
     * Each interactive element carries:
     *   data-output-param="<paramName>"         — read/written by _syncOutputControls
     *   data-output-param-display="<paramName>" — value readout span
     *
     * @param {'drawer'|'popover'} context
     *   Controls layout density: drawer uses tighter margins for the horizontal
     *   strip; popover uses more generous vertical spacing.
     * @returns {DocumentFragment}
     */
    _buildOutputControls(context) {
        const frag = document.createDocumentFragment();
        // Both 'popover' and 'sidebar' contexts use the same vertical
        // labelled-row layout. (The former 'drawer' context and its compact
        // horizontal strip were removed along with the bottom drawer.)

        // ── Row builder ───────────────────────────────────────────────────────
        // Creates one labelled control row and appends it to the fragment.
        const _row = (labelText, controlEl, displayEl, hint) => {
            const row = document.createElement('div');
            row.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 10px;
            `;

            const lbl = document.createElement('label');
            lbl.textContent = labelText;
            lbl.title = hint;
            lbl.style.cssText = `
                font-size: 12px;
                opacity: 0.75;
                min-width: 92px;
                flex-shrink: 0;
                cursor: help;
                white-space: nowrap;
                color: rgba(220,220,230,0.9);
            `;

            row.appendChild(lbl);
            row.appendChild(controlEl);
            if (displayEl) row.appendChild(displayEl);
            frag.appendChild(row);
        };

        // ── Value readout builder ─────────────────────────────────────────────
        const _display = (paramName, formatter) => {
            const sp = document.createElement('span');
            sp.dataset.outputParamDisplay = paramName;
            const raw = this._getOutputParam(paramName);
            sp.textContent = formatter ? formatter(raw) : raw;
            sp.style.cssText = `
                font-size: 10px;
                opacity: 0.8;
                min-width: 34px;
                text-align: right;
                font-variant-numeric: tabular-nums;
                flex-shrink: 0;
                color: rgba(220,220,230,0.85);
            `;
            return sp;
        };

        // ── 1. Render method ──────────────────────────────────────────────────
        // Controls which CPU marching-squares pipeline runs when the user
        // clicks ⬡ Render. Has no effect on GLSL or Ray March modes.
        const methodSel = document.createElement('select');
        methodSel.dataset.outputParam = 'renderMethod';
        methodSel.style.cssText = `
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 4px;
            color: rgba(220,220,230,0.9);
            font-size: 11px;
            padding: 2px 4px;
            flex: 1;
            min-width: 0;
            cursor: pointer;
        `;
        [
            ['contours (2D)', 'Contours — iso-lines (2D)'],
            ['fill (2D)',     'Fill — solid regions (2D)'],
            ['arcs',          'Arcs — fitted arc segments (2D)'],
            ['surface (3D)',  'Surface mesh (3D, slow)'],
        ].forEach(([val, label]) => {
            const o = document.createElement('option');
            o.value       = val;
            o.textContent = label;
            o.style.backgroundColor = '#1c1c22';
            o.style.color           = 'rgba(220,220,230,0.95)';
            if (val === this._getOutputParam('renderMethod')) o.selected = true;
            methodSel.appendChild(o);
        });
        methodSel.addEventListener('change', () =>
            this._setOutputParam('renderMethod', methodSel.value)
        );
        _row(
            'Render as',
            methodSel,
            null,
            'CPU render style — controls how the marching-squares output is drawn.\n' +
            'Contours: iso-lines (fastest).\n' +
            'Fill: solid filled regions.\n' +
            'Arcs: arc-fitted contours.\n' +
            'Surface (3D): marching-cubes mesh (slowest).\n' +
            'This setting has NO effect in GLSL or Ray March mode.'
        );

        // ── 2. Resolution ─────────────────────────────────────────────────────
        // The marching-squares grid density. Higher values produce more detail
        // at the cost of render time. Only affects the CPU render path.
        const resSlider = document.createElement('input');
        resSlider.type                = 'range';
        resSlider.dataset.outputParam = 'resolution';
        resSlider.min   = '20';
        resSlider.max   = '400';
        resSlider.step  = '10';
        resSlider.value = this._getOutputParam('resolution');
        resSlider.style.cssText = `
            flex: 1;
            min-width: 0;
            height: 14px;
            accent-color: #378ADD;
            cursor: pointer;
        `;
        const resDisplay = _display('resolution', v => Math.round(v));
        resSlider.addEventListener('mousedown', () => {
            if (this._undo) this._undo.snapshot();
        });
        resSlider.addEventListener('input', () => {
            const v = parseInt(resSlider.value, 10);
            resDisplay.textContent = v;
            this._setOutputParam('resolution', v);
            this._renderInPlace();
        });
        _row(
            'CPU resolution',
            resSlider,
            resDisplay,
            'Marching-squares grid density (20 – 400).\n' +
            'Higher = more detail, slower CPU render.\n' +
            'Has no effect in GLSL or Ray March mode.\n' +
            'Default: 150.'
        );

        // ── 3. Scan bounds min ────────────────────────────────────────────────
        // The left/bottom edge of the world-space window the CPU evaluator
        // scans. Shapes outside [boundsMin, boundsMax] are invisible in CPU
        // renders. The render path auto-expands this when primitives are placed
        // outside the current window, but the user can set it manually too.
        const bMinSlider = document.createElement('input');
        bMinSlider.type                = 'range';
        bMinSlider.dataset.outputParam = 'boundsMin';
        bMinSlider.min   = '-20';
        bMinSlider.max   = '0';
        bMinSlider.step  = '0.5';
        bMinSlider.value = this._getOutputParam('boundsMin');
        bMinSlider.style.cssText = `
            flex: 1;
            min-width: 0;
            height: 14px;
            accent-color: #378ADD;
            cursor: pointer;
        `;
        const bMinDisplay = _display('boundsMin', v => parseFloat(v).toFixed(1));
        bMinSlider.addEventListener('mousedown', () => {
            if (this._undo) this._undo.snapshot();
        });
        bMinSlider.addEventListener('input', () => {
            const v        = parseFloat(bMinSlider.value);
            const maxVal   = this._getOutputParam('boundsMax');
            // Prevent min from meeting or exceeding max
            const clamped  = Math.min(v, maxVal - 0.5);
            bMinSlider.value          = clamped;
            bMinDisplay.textContent   = clamped.toFixed(1);
            this._setOutputParam('boundsMin', clamped);
            this._renderInPlace();
        });
        _row(
            'Scan min',
            bMinSlider,
            bMinDisplay,
            'Left / bottom edge of the CPU scan window (world units).\n' +
            'Primitives placed below or left of this value will not appear\n' +
            'in CPU renders. The render path auto-expands this value when\n' +
            'primitives are outside the current bounds.\n' +
            'Range: -20 … 0. Default: -4.'
        );

        // ── 4. Scan bounds max ────────────────────────────────────────────────
        const bMaxSlider = document.createElement('input');
        bMaxSlider.type                = 'range';
        bMaxSlider.dataset.outputParam = 'boundsMax';
        bMaxSlider.min   = '0';
        bMaxSlider.max   = '20';
        bMaxSlider.step  = '0.5';
        bMaxSlider.value = this._getOutputParam('boundsMax');
        bMaxSlider.style.cssText = `
            flex: 1;
            min-width: 0;
            height: 14px;
            accent-color: #378ADD;
            cursor: pointer;
        `;
        const bMaxDisplay = _display('boundsMax', v => parseFloat(v).toFixed(1));
        bMaxSlider.addEventListener('mousedown', () => {
            if (this._undo) this._undo.snapshot();
        });
        bMaxSlider.addEventListener('input', () => {
            const v        = parseFloat(bMaxSlider.value);
            const minVal   = this._getOutputParam('boundsMin');
            // Prevent max from meeting or falling below min
            const clamped  = Math.max(v, minVal + 0.5);
            bMaxSlider.value          = clamped;
            bMaxDisplay.textContent   = clamped.toFixed(1);
            this._setOutputParam('boundsMax', clamped);
            this._renderInPlace();
        });
        _row(
            'Scan max',
            bMaxSlider,
            bMaxDisplay,
            'Right / top edge of the CPU scan window (world units).\n' +
            'Primitives placed above or right of this value will not appear\n' +
            'in CPU renders. The render path auto-expands this value when\n' +
            'primitives are outside the current bounds.\n' +
            'Range: 0 … 20. Default: 4.'
        );

        // ── Object placement ────────────────────────────────────────────────────
        // Repositions the entire final composed geometry as a single rigid body.
        // Always available, no wiring required. posZ/rotateX/rotateY only affect
        // 3D render modes (Surface, Ray March) and STL export; posX/posY/rotateZ
        // affect all render modes including 2D contours and fill.
        //
        // These six sliders write through _setOutputParam → output node params,
        // which NodeEvaluator.getRootSDF() reads to apply the inverse transform
        // to the entire combined SDF before returning it to the renderer.
        // SceneManager._getEffectiveBounds() also reads them to expand the scan
        // window when the geometry has been rotated or translated.
        const placementSection = document.createElement('div');
        placementSection.style.cssText = `
            width: 100%;
            margin-top: 12px;
        `;

        const placementLabel = document.createElement('span');
        placementLabel.textContent = 'Object placement:';
        placementLabel.title = 'Move and rotate the final composed geometry. ' +
            'posZ / rotateX / rotateY only affect 3D modes and STL export. ' +
            'posX / posY / rotateZ affect all modes.';
        placementLabel.style.cssText = `
            font-size: 12px;
            opacity: 0.6;
            white-space: nowrap;
            flex-shrink: 0;
            color: rgba(220,220,230,0.9);
            margin-bottom: 8px;
            display: block;
        `;
        placementSection.appendChild(placementLabel);

        // Placement param definitions — label, paramName, min, max, step, hint
        const PLACEMENT_DEFS = [
            { label: 'X',       param: 'posX',    min: -10, max: 10, step: 0.01,
              hint: 'Move the final geometry along X (left/right). Affects all render modes.' },
            { label: 'Y',       param: 'posY',    min: -10, max: 10, step: 0.01,
              hint: 'Move the final geometry along Y (up/down). Affects all render modes.' },
            { label: 'Z',       param: 'posZ',    min: -10, max: 10, step: 0.01,
              hint: 'Move the final geometry along Z (toward/away from camera). Only affects 3D modes and STL export.' },
            { label: 'Rx',      param: 'rotateX', min: 0, max: 6.28, step: 0.01,
              hint: 'Rotate the final geometry around X (pitch). Only affects 3D modes and STL export.' },
            { label: 'Ry',      param: 'rotateY', min: 0, max: 6.28, step: 0.01,
              hint: 'Rotate the final geometry around Y (yaw). Only affects 3D modes and STL export.' },
            { label: 'Rz',      param: 'rotateZ', min: 0, max: 6.28, step: 0.01,
              hint: 'Rotate the final geometry around Z (roll). Affects all render modes.' },
        ];

        // ── Vertical labelled rows, one per param (popover and sidebar contexts) ──
        const placementFrag = document.createDocumentFragment();
        PLACEMENT_DEFS.forEach(({ label, param, min, max, step, hint }) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px;';

            const lbl = document.createElement('label');
            lbl.textContent = label;
            lbl.title = hint;
            lbl.style.cssText = `
                font-size: 12px;
                opacity: 0.75;
                min-width: 92px;
                flex-shrink: 0;
                cursor: help;
                white-space: nowrap;
                color: rgba(220,220,230,0.9);
            `;

            const slider = document.createElement('input');
            slider.type  = 'range';
            slider.min   = min;
            slider.max   = max;
            slider.step  = step;
            slider.value = this._getOutputParam(param);
            slider.title = hint;
            slider.dataset.outputParam        = param;
            slider.dataset.outputParamDisplay = param;
            slider.style.cssText = 'flex:1; min-width:0; height:14px; accent-color:#378ADD; cursor:pointer;';

            const display = document.createElement('span');
            display.dataset.outputParamDisplay = param;
            display.textContent = parseFloat(this._getOutputParam(param)).toFixed(2);
            display.style.cssText = `
                font-size: 11px;
                opacity: 0.8;
                min-width: 38px;
                text-align: right;
                font-variant-numeric: tabular-nums;
                flex-shrink: 0;
                color: rgba(220,220,230,0.85);
            `;

            slider.addEventListener('mousedown', () => {
                if (this._undo) this._undo.snapshot();
            });
            slider.addEventListener('input', () => {
                const val = parseFloat(slider.value);
                display.textContent = val.toFixed(2);
                this._setOutputParam(param, val);
                this._syncOutputControls(param, val);
                this._renderInPlace();
            });

            row.appendChild(lbl);
            row.appendChild(slider);
            row.appendChild(display);
            placementFrag.appendChild(row);
        });
        placementSection.appendChild(placementFrag);

        frag.appendChild(placementSection);

        return frag;
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

// Render — use the method selected in the output drawer / gear popover.
    // _getOutputParam reads from _pendingOutputParams first, then the live
    // output node, then falls back to the NodeSpec default 'contours (2D)'.
    try {
      const method = this._getOutputParam('renderMethod');
      this.sceneManager.renderSDF(sdf, method);
      console.log(`Compose: rendered via CPU — method: ${method}`);
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

    // ── Output parameter management ───────────────────────────────────────────
    //
    // These three methods are the single point of truth for reading and writing
    // output node parameters. Both the bottom drawer (Option 2) and the gear
    // popover (Option 1) call _setOutputParam() exclusively — they never write
    // to the graph directly. This guarantees the two UIs stay in sync and that
    // pending values set before the output node exists are applied correctly
    // when it is first created by _ensureOutputWired().

    /**
     * Write a single output node parameter and invalidate evaluator caches.
     *
     * If no output node exists yet (scene not yet rendered for the first time)
     * the value is stored in _pendingOutputParams and applied the moment
     * _ensureOutputWired() creates the node. This means the user can configure
     * output settings before ever clicking Render and those settings will be
     * honoured on the first render.
     *
     * @param {string} paramName  One of: renderMethod, resolution, boundsMin, boundsMax
     * @param {*}      value
     */
    _setOutputParam(paramName, value) {
        // Always keep a local mirror so we can apply it when the node is created
        if (!this._pendingOutputParams) this._pendingOutputParams = {};
        this._pendingOutputParams[paramName] = value;

        // Write to the live node if it already exists
        const graph = this.stateStore.nodeGraph;
        let outputNode = null;
        graph.nodes.forEach(n => { if (n.type === 'outputNode') outputNode = n; });

        if (outputNode) {
            graph.updateNodeParam(outputNode.id, paramName, value);
            // Invalidate so the next render picks up the change
            this.sceneManager._lastGLSLSource     = null;
            this.sceneManager._lastRayMarchSource = null;
            this.sceneManager.evaluator.invalidate();
        }

        // Keep both drawer and popover in sync if both happen to be open
        this._syncOutputControls(paramName, value);
    }

    /**
     * Read the current value of an output node parameter.
     * Priority order:
     *   1. _pendingOutputParams (values set by the user before first render)
     *   2. The live output node in the graph (set by a previous render or load)
     *   3. NodeSpec hard-coded defaults
     *
     * Safe to call at any time, including before the output node exists.
     *
     * @param {string} paramName
     * @returns {*}
     */
    _getOutputParam(paramName) {
        const DEFAULTS = {
            renderMethod: 'contours (2D)',
            resolution:   150,
            boundsMin:    -4,
            boundsMax:     4,
            // Output-level placement defaults — identity transform (no movement)
            posX:     0,
            posY:     0,
            posZ:     0,
            rotateX:  0,
            rotateY:  0,
            rotateZ:  0,
        };

        // Pending local overrides take highest priority
        if (this._pendingOutputParams?.[paramName] !== undefined) {
            return this._pendingOutputParams[paramName];
        }

        // Then the live node if it exists
        const graph = this.stateStore.nodeGraph;
        let outputNode = null;
        graph.nodes.forEach(n => { if (n.type === 'outputNode') outputNode = n; });
        if (outputNode?.params[paramName] !== undefined) {
            return outputNode.params[paramName];
        }

        return DEFAULTS[paramName];
    }

    /**
     * Push a single param value to all live output control elements without
     * triggering a recursive _setOutputParam call.
     *
     * Targets elements carrying:
     *   data-output-param="<paramName>"         — the input/select element
     *   data-output-param-display="<paramName>" — the value readout span
     *
     * Both the drawer (#nc-output-drawer) and the popover (#nc-output-popover)
     * are updated if they are present in the DOM.
     *
     * @param {string} paramName
     * @param {*}      value
     */
    _syncOutputControls(paramName, value) {
        const PLACEMENT_PARAMS = new Set([
            'posX','posY','posZ','rotateX','rotateY','rotateZ'
        ]);

        ['nc-output-drawer', 'nc-output-popover'].forEach(containerId => {
            const container = document.getElementById(containerId);
            if (!container) return;

            // Sync the slider / select input element
            const inputEl = container.querySelector(
                `[data-output-param="${paramName}"]`
            );
            if (inputEl) inputEl.value = value;

            // Sync the readout display span (popover has these; drawer does not
            // for placement params since the drawer is too narrow for readouts)
            const displayEl = container.querySelector(
                `[data-output-param-display="${paramName}"]`
            );
            if (displayEl) {
                if (paramName === 'resolution') {
                    displayEl.textContent = Math.round(value);
                } else if (paramName === 'boundsMin' || paramName === 'boundsMax') {
                    displayEl.textContent = parseFloat(value).toFixed(1);
                } else if (PLACEMENT_PARAMS.has(paramName)) {
                    // Placement params show two decimal places so the user can
                    // see small increments without the display being cluttered
                    displayEl.textContent = parseFloat(value).toFixed(2);
                } else {
                    displayEl.textContent = value;
                }
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
        this._updateGraphStatusLabel();
        // Re-evaluate bridge (Extrude/Revolve) availability whenever the
        // graph structure changes — a new bridge node being added, or an
        // existing one being removed, changes what the dropdown should show.
        this._updateDropdownAvailability();
    }

    // ── Scene geometry check ──────────────────────────────────────────────────

    /**
     * Returns true if the graph contains at least one geometry primitive node.
     *
     * This is the minimum condition for the Render and mode-switch buttons to
     * be active. A graph containing only transform or blend nodes cannot
     * produce a valid SDF without a geometry input, so those cases also return
     * false.
     *
     * Called by _updateGraphStatusLabel() on every graph change and by the
     * Render and mode-switch button handlers as a belt-and-braces guard.
     *
     * @returns {boolean}
     */
/**
     * Re-evaluate which Transform/Operation dropdown entries should be
     * enabled or disabled based on the current graph state and selection.
     *
     * Rules enforced here (V1 scope):
     *
     * 1. Dimensional bridges (Extrude, Revolve) require a 2D primitive as
     *    their direct or indirect input. They are disabled when:
     *    a) A 3D primitive is selected (3D → bridge is geometrically invalid)
     *    b) The selected node (or the sole unwired primitive) is already
     *       downstream of a bridge (bridge → bridge is invalid)
     *    c) The only primitives in the scene are 3D and no 2D primitives
     *       exist (Priority 2 auto-chain would connect to a 3D primitive)
     *
     * 2. When bridges are disabled, a tooltip on the greyed option explains
     *    why rather than silently ignoring the click.
     *
     * Called from: _setSelected(), _onGraphChange(), _updateGraphStatusLabel()
     */
    _updateDropdownAvailability() {
        if (!this._xformSelect) return;

        const graph = this.stateStore.nodeGraph;

        const TYPES_3D = new Set([
            'sphere','box','cylinder','capsule','torus','cone','plane'
        ]);
        const TYPES_2D = new Set([
            'circle','regularPolygon','triangle','arc','polytope','lineSegment'
        ]);
        const BRIDGE_TYPES = new Set(['extrudeNode','revolveNode']);

        // Walk backward from a node through its input chain — returns true
        // if any node in the upstream chain is a dimensional bridge.
        const chainHasBridge = (nodeId, visited = new Set()) => {
            if (visited.has(nodeId)) return false;
            visited.add(nodeId);
            const node = graph.nodes.get(nodeId);
            if (!node) return false;
            if (BRIDGE_TYPES.has(node.type)) return true;
            // Walk all incoming edges for this node
            let found = false;
            graph.edges.forEach(edge => {
                if (edge.toNode === nodeId) {
                    if (chainHasBridge(edge.fromNode, visited)) found = true;
                }
            });
            return found;
        };

        let bridgesAllowed = true;
        let reason = '';

        // Check selected node first (Priority 1)
        const selId = [...this._selectedIds].pop();
        const selNode = selId ? graph.nodes.get(selId) : null;

        if (selNode) {
            if (TYPES_3D.has(selNode.type)) {
                bridgesAllowed = false;
                reason = 'Extrude / Revolve require a 2D shape as input — ' +
                         `"${selNode.type}" is a 3D primitive. ` +
                         'Select a 2D primitive (circle, arc, polygon…) first.';
            } else if (chainHasBridge(selNode.id)) {
                bridgesAllowed = false;
                reason = 'This branch already contains a dimensional bridge ' +
                         '(Extrude or Revolve). Adding a second bridge in the ' +
                         'same chain is not supported in V1.';
            }
        } else {
            // No selection — check Priority 2 (sole unwired primitive)
            const prims = [];
            graph.nodes.forEach((n, id) => {
                if (TYPES_2D.has(n.type) || TYPES_3D.has(n.type)) prims.push(n);
            });
            if (prims.length === 1) {
                const p = prims[0];
                if (TYPES_3D.has(p.type)) {
                    bridgesAllowed = false;
                    reason = 'The only primitive in the scene is a 3D shape. ' +
                             'Extrude / Revolve require a 2D input. ' +
                             'Add a 2D primitive (circle, arc, polygon…) first.';
                } else if (chainHasBridge(p.id)) {
                    bridgesAllowed = false;
                    reason = 'The existing chain already contains a dimensional ' +
                             'bridge. Adding a second bridge is not supported in V1.';
                }
            } else if (prims.length > 1) {
                // Multiple primitives, no selection — bridges remain available
                // (the user must select a valid 2D source card first;
                // _addTransformNode's existing guard handles the case where
                // they click without a valid selection)
                bridgesAllowed = true;
            }
        }

        // Apply enabled/disabled state to Extrude and Revolve items
        // in the custom Transform/Operation dropdown panel.
        if (this._xformDropdownPanel) {
            Array.from(this._xformDropdownPanel.querySelectorAll('[data-value]'))
                .forEach(item => {
                    const v = item.dataset.value;
                    if (v !== 'extrude' && v !== 'revolve') return;

                    if (!bridgesAllowed) {
                        item.dataset.disabled       = 'true';
                        item.dataset.disabledReason = reason;
                        item.style.color            = 'rgba(120,120,130,0.45)';
                        item.style.cursor           = 'not-allowed';
                        item.title                  = reason;
                        // Prepend ✕ marker if not already present
                        if (!item.textContent.startsWith('✕')) {
                            item.dataset.originalText = item.textContent;
                            item.textContent = `✕ ${item.textContent}`;
                        }
                    } else {
                        delete item.dataset.disabled;
                        delete item.dataset.disabledReason;
                        item.style.color  = 'rgba(220,220,230,0.9)';
                        item.style.cursor = 'pointer';
                        item.title        = '';
                        if (item.dataset.originalText) {
                            item.textContent = item.dataset.originalText;
                            delete item.dataset.originalText;
                        }
                    }
                });
        }
    }

    _sceneHasGeometry() {
        const GEOM_TYPES = new Set([
            'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
            'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane',
        ]);
        let found = false;
        this.stateStore.nodeGraph.nodes.forEach(n => {
            if (GEOM_TYPES.has(n.type)) found = true;
        });
        return found;
    }

    // ── Output node lifecycle — owned exclusively by the render path ──────────

    /**
     * Ensure an output node exists and that every dangling chain tail in the
     * graph is wired to it. Called by both _renderWithAutoOutput() and the
     * mode-switch button handler immediately before any render is triggered.
     *
     * A "dangling chain tail" is a node whose output port (sdf or result) has
     * no outgoing edges AND which is not itself the output node. These are
     * the terminal nodes of chains the user has built but not yet connected
     * to anything downstream.
     *
     * Algorithm:
     *   1. Ensure the output node exists (create if absent via _ensureOutputNode).
     *   2. Apply any pending output param values set by the user before the
     *      node existed (values stored in _pendingOutputParams).
     *   3. Walk every non-output node in the graph.
     *   4. For each node whose output port has no outgoing edges AND which is
     *      not already directly wired to the output node, wire it to
     *      output(sdf). This handles:
     *        - A bare primitive (primitive → output)
     *        - A primitive+transform chain wired at the tail (tail → output)
     *        - A blend node whose result port is dangling (blend → output)
     *        - Multiple independent chains (each tail → output, union at output)
     *   5. Invalidate evaluator and shader caches.
     *
     * This method is idempotent: calling it repeatedly on an already-wired
     * graph produces no duplicate edges (addEdge throws on duplicates, which
     * are caught and silently ignored).
     */
    _ensureOutputWired() {
        const graph = this.stateStore.nodeGraph;

        // Step 1: ensure the output node exists
        const outNode = this.sceneManager._ensureOutputNode();

        // Step 2: apply any pending output params the user configured before
        // the output node was created
        if (this._pendingOutputParams) {
            Object.entries(this._pendingOutputParams).forEach(([k, v]) => {
                graph.updateNodeParam(outNode.id, k, v);
            });
        }

        // Step 3 & 4: find dangling tails and wire them to the output node
        const GEOM_TYPES = new Set([
            'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
            'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane',
        ]);
        const TRANSFORM_TYPES = new Set([
            'extrudeNode', 'revolveNode', 'noiseDisplaceNode', 'twistNode', 'bendNode',
            'repeatNode', 'tilingNode', 'mobiusNode', 'symmetryFoldNode',
            'symmetryOrbitNode', 'ifsBlend', 'transform3DNode',
        ]);
        const BLEND_TYPES = new Set([
            'schurBlend', 'rUnion', 'rIntersection', 'rDifference',
        ]);

        graph.nodes.forEach((node, id) => {
            if (node.type === 'outputNode') return;

            // Determine the output port name for this node type
            let outPort = null;
            if (GEOM_TYPES.has(node.type))      outPort = 'sdf';
            if (TRANSFORM_TYPES.has(node.type)) outPort = 'result';
            if (BLEND_TYPES.has(node.type))     outPort = 'result';
            if (!outPort) return;

            // If this output port already has outgoing edges, this node is
            // mid-chain — it feeds into something else and is not a tail
            const outgoing = graph.getOutgoingEdges(id, outPort) || [];
            if (outgoing.length > 0) return;

            // If this node is already directly wired to the output node,
            // skip it to avoid duplicate edge errors
            const alreadyToOutput = (graph.getAllIncomingEdges(outNode.id, 'sdf') || [])
                .some(e => e.fromNode === id);
            if (alreadyToOutput) return;

            // Wire this dangling tail to the output node
            try {
                graph.addEdge(id, outPort, outNode.id, 'sdf');
            } catch(_) {
                // Edge already exists or graph validation rejected it — safe to ignore
            }
        });

        // Step 5: invalidate all caches so the next render reads the new wiring
        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager.evaluator.invalidate();
    }

    /**
     * Called by the Render button. Ensures output is wired then runs the
     * CPU marching-squares compose pipeline. Note this method ALWAYS forces
     * the active mode to marchingSquares — that is correct for the explicit
     * Render button (which is documented as "CPU marching squares") but
     * wrong for any live-tweak control (sliders) that should respect
     * whatever mode the user is currently in. Live controls call
     * _renderInPlace() instead — see below.
     *
     * The geometry guard is also checked here as belt-and-braces even though
     * the button is visually disabled when no geometry exists.
     */
    _renderWithAutoOutput() {
        if (!this._sceneHasGeometry()) return;
        this._ensureOutputWired();
        this._compose();
    }

    /**
     * Re-render the scene in whatever render mode is CURRENTLY active,
     * without switching modes. Used by all live-tweak sidebar controls
     * (output method, resolution, bounds, object placement) so that
     * adjusting a slider while in GLSL or Ray March mode stays in that
     * mode rather than silently reverting to Marching Squares.
     *
     * Marching Squares still requires an explicit _compose() call since
     * that path is documented as manually triggered; GLSL and Ray March
     * re-render every frame already driven by their own render calls, so
     * we just need to invalidate caches and trigger one render pass here
     * for immediate visual feedback rather than waiting for the next
     * scheduled frame.
     */
    _renderInPlace() {
        if (!this._sceneHasGeometry()) return;
        this._ensureOutputWired();

        const mode = this.sceneManager.renderMode;
        if (mode === 'glsl') {
            this.sceneManager._renderGLSL();
        } else if (mode === 'rayMarch') {
            this.sceneManager._renderRayMarch();
        } else {
            // marchingSquares — same CPU compose path as the Render button,
            // but we don't need _compose()'s mode-forcing logic since we're
            // already confirmed to be in this mode.
            const sdf = this.sceneManager.evaluator.getRootSDF();
            if (sdf) {
                this.sceneManager.renderSDF(sdf, this._getOutputParam('renderMethod'));
            }
        }
    }

    // ── Status label and button grey-out ──────────────────────────────────────

    /**
     * Update the persistent status label and the enabled/disabled visual state
     * of the Render button, gear button, and mode-switch button based on
     * whether the scene currently contains any geometry primitives.
     *
     * Grey-out condition: no geometry primitive node exists in the graph.
     * This is the only condition that disables the buttons — the output node
     * is created on demand by the render path so its absence is never an error
     * state the user needs to resolve manually.
     *
     * Called from:
     *   - _onGraphChange()       — on every structural graph mutation
     *   - _doOpen()              — when the canvas is first opened
     *   - _clearAll() timeout    — after the scene is cleared
     *   - _afterGraphReplaced()  — after undo/redo restores a graph state
     *   - _addBlendNode()        — after a blend node is added
     *   - _addTransformNode()    — after a transform node is added
     *   - scene load handler     — after a saved scene is loaded
     */
    _updateGraphStatusLabel() {
        if (!this._graphStatusLabel) return;

        const hasGeom = this._sceneHasGeometry();

        // ── One-time sidebar introduction ───────────────────────────────────
        // The very first time the scene transitions from "no geometry" to
        // "has geometry" in this session, briefly auto-open the sidebar so
        // new users discover it exists at the most relevant possible moment
        // — right when there's finally something worth tuning render/output
        // settings for. Fires only once per session (guarded by
        // _sidebarIntroShown); after that the persistent glow (see
        // _buildSidebar) is the sole ongoing discoverability hint, since
        // repeatedly auto-opening on every subsequent render would be an
        // unwelcome interruption rather than a helpful introduction.
        // ── One-time sidebar introduction — deferred ────────────────────────
        // Wait briefly before auto-opening, rather than firing the instant
        // geometry first appears. This gives the user a moment to actually
        // SEE the collapsed sidebar's pulsing glow before it auto-expands
        // and strips the glow class — otherwise, if geometry exists
        // immediately on page load (e.g. an autosaved scene), the intro
        // could fire and remove the glow before the user ever registers it,
        // making the affordance invisible in practice.
        if (hasGeom && !this._sidebarIntroShown && this._sidebar) {
            this._sidebarIntroShown = true;
            setTimeout(() => {
                if (!this._sidebar) return;
                this._sidebar.dispatchEvent(new Event('mouseenter'));
                setTimeout(() => {
                    if (!this._sidebar.matches(':hover') && !this._sidebarPinned) {
                        this._sidebar.dispatchEvent(new Event('mouseleave'));
                    }
                }, 3200);
            }, 1600);
        }

        // ── Render button ─────────────────────────────────────────────────────
        if (this._composeBtn) {
            this._composeBtn.disabled          = !hasGeom;
            this._composeBtn.style.opacity     = hasGeom ? '1' : '0.38';
            this._composeBtn.style.cursor      = hasGeom ? 'pointer' : 'not-allowed';
            this._composeBtn.title             = hasGeom
                ? 'Render the current scene via CPU marching squares'
                : 'Add at least one primitive before rendering';
        }

        // ── Gear button ───────────────────────────────────────────────────────
        if (this._gearBtn) {
            this._gearBtn.disabled          = !hasGeom;
            this._gearBtn.style.opacity     = hasGeom ? '1' : '0.38';
            this._gearBtn.style.cursor      = hasGeom ? 'pointer' : 'not-allowed';
        }

        // ── Mode-switch button ────────────────────────────────────────────────
        if (this._renderModeBtn) {
            this._renderModeBtn.disabled          = !hasGeom;
            this._renderModeBtn.style.opacity     = hasGeom ? '1' : '0.38';
            this._renderModeBtn.style.cursor      = hasGeom ? 'pointer' : 'not-allowed';
            this._renderModeBtn.title             = hasGeom
                ? 'Switch render mode (Marching Squares → GLSL → Ray March)'
                : 'Add at least one primitive before switching render mode';
        }

        // ── Status label ──────────────────────────────────────────────────────
        // The sidebar's Output section remains visible at all times (it is
        // not hidden when geometry is absent) since it occupies a separate
        // screen region from the canvas and showing/hiding it would cause
        // layout jumps in the sidebar itself. Render values are simply inert
        // until geometry exists.
        if (!hasGeom) {
            this._graphStatusLabel.textContent = '⚠ Add a primitive to render';
            this._graphStatusLabel.style.display = '';
            return;
        }

        this._graphStatusLabel.style.display = 'none';
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

        // Escape: exit presentation mode if active, otherwise deselect any
        // selected node cards. The overlay is permanently visible so Escape
        // no longer closes it.
        if (e.key === 'Escape' && this._open) {
            if (this._presentationMode) {
                this._togglePresentationMode();
            } else {
                this._setSelected(null);
            }
        }

        // Delete / Backspace: remove all currently selected node cards
        // (and their connected edges), without a confirmation dialog —
        // deletion via keypress is treated as a fast, deliberate action
        // (mirrors standard node-editor conventions in Houdini, Blender,
        // etc.) and is undoable via Ctrl+Z like every other graph edit.
        if ((e.key === 'Delete' || e.key === 'Backspace') &&
            this._open && this._selectedIds.size > 0) {
            e.preventDefault();
            this._deleteSelectedNodes();
        }

        // 'F' key: toggle "presentation mode" — hides the toolbar and
        // sidebar so only the rendered geometry is visible, full-bleed.
        // Intended for capturing clean screenshots/video/GIFs without any
        // UI chrome in frame. Press F again (or Escape) to restore the UI.
        // Does not affect the underlying render in any way — purely a
        // visibility toggle on the toolbar/sidebar DOM elements.
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            this._togglePresentationMode();
        }

        // 'R' key: toggle auto-orbit — the camera continuously revolves
        // around the current orbit target at a fixed angular speed, useful
        // for hands-free turntable-style demo shots when recording video
        // or capturing a GIF. Press R again, or manually drag the camera,
        // to stop. Does not require presentation mode to be active, but
        // the two combine well together for clean capture.
        if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            this._toggleAutoOrbit();
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
     * Toggle the camera view menu — a small dropdown of preset camera angles.
     * Clicking any angle snaps the camera to that view immediately.
     * The menu closes on outside click or on selection.
     */
    _toggleViewMenu(anchorEl) {
        const existing = document.getElementById('nc-view-menu');
        if (existing) { existing.remove(); return; }

        const anchorRect = anchorEl.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.id = 'nc-view-menu';
        menu.style.cssText = `
            position: fixed;
            top: ${anchorRect.bottom + 4}px;
            left: ${anchorRect.left}px;
            background: rgba(16,16,22,0.98);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 6px;
            padding: 6px 0;
            z-index: 2000;
            pointer-events: auto;
            min-width: 160px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.5);
            font-family: var(--font-sans, sans-serif);
        `;

        const views = [
            { key: 'home',         label: '⌂  Home (3/4 view)',      hint: 'Default perspective — good for most scenes' },
            { key: 'front',        label: '↑  Front',                 hint: 'Looking along -Z toward the scene' },
            { key: 'back',         label: '↓  Back',                  hint: 'Looking along +Z toward the scene' },
            { key: 'left',         label: '←  Left',                  hint: 'Looking along +X toward the scene' },
            { key: 'right',        label: '→  Right',                 hint: 'Looking along -X toward the scene' },
            { key: 'top',          label: '⊙  Top',                   hint: 'Looking straight down along -Y' },
            { key: 'bottom',       label: '⊗  Bottom',                hint: 'Looking straight up along +Y' },
            { key: 'perspective45',label: '◈  3/4 Perspective',       hint: 'Elevated 45° perspective — good for sculptural forms' },
        ];

        views.forEach(({ key, label, hint }) => {
            const item = document.createElement('div');
            item.textContent = label;
            item.title = hint;
            item.style.cssText = `
                padding: 7px 14px;
                font-size: 12px;
                color: rgba(220,220,230,0.85);
                cursor: pointer;
                white-space: nowrap;
            `;
            item.addEventListener('mouseenter', () =>
                item.style.background = 'rgba(255,255,255,0.08)'
            );
            item.addEventListener('mouseleave', () =>
                item.style.background = 'transparent'
            );
            item.addEventListener('click', () => {
                menu.remove();
                this._setCameraView(key);
            });
            menu.appendChild(item);
        });

        // Thin divider before top/bottom views
        const div = menu.children[5];
        if (div) div.style.borderTop = '1px solid rgba(255,255,255,0.08)';

        // Track whether the listener has already been removed, so both the
        // "click a view item" path and the "click outside" path can safely
        // remove it without double-removal errors.
        let _outsideListenerActive = true;

        const outside = (e) => {
            if (!_outsideListenerActive) return;
            if (!menu.contains(e.target) && e.target !== anchorEl) {
                menu.remove();
                document.removeEventListener('mousedown', outside);
                _outsideListenerActive = false;
            }
        };

        setTimeout(() => {
            document.addEventListener('mousedown', outside);
        }, 100);

        // Ensure the listener is removed when a view item is clicked too —
        // not just on outside clicks. Without this, clicking a view item
        // leaves the listener attached, where it can interfere with the
        // next mousedown event used by OrbitControls to start a drag.
        menu.addEventListener('click', () => {
            if (_outsideListenerActive) {
                document.removeEventListener('mousedown', outside);
                _outsideListenerActive = false;
            }
        });

        document.body.appendChild(menu);
    }

    /**
     * Snap the camera to a named preset view.
     *
     * All views orbit around the current controls.target (default 0,0,0).
     * The camera distance is preserved so zoom level is not reset.
     * After repositioning, controls.update() is called so OrbitControls
     * stays in sync and subsequent dragging works correctly from the new angle.
     *
     * The ray march renderer syncs its camera from Three.js each frame so
     * no additional work is needed — the next frame will show the new view.
     *
     * @param {string} viewKey  One of the keys defined in _toggleViewMenu
     */
    /**
     * Toggle hands-free camera auto-orbit. While active, the camera
     * continuously revolves around the current OrbitControls target at a
     * fixed angular speed (independent of render mode — works identically
     * in marchingSquares, GLSL, and Ray March). Intended for turntable-style
     * demo capture (video/GIF) without needing to manually drag the mouse
     * for the entire shot duration.
     *
     * Implementation: OrbitControls has a built-in autoRotate feature
     * (autoRotate + autoRotateSpeed) that handles the per-frame rotation
     * internally as long as controls.update() is called every frame — which
     * the existing animation loop in SceneManager already does. So this
     * method just toggles those two properties; no separate animation loop
     * or manual angle-stepping code is needed.
     *
     * Stops automatically the moment the user manually drags/zooms — this
     * is OrbitControls' own default behaviour (any user interaction
     * interrupts autoRotate), so no extra "stop on drag" wiring is required
     * here either. The toolbar/toast just needs to reflect the off state
     * if the user manually interrupts it, which _attachViewportDrag /
     * the controls' own 'start' event could optionally sync later — for
     * V1 a simple press-R-again toggle is sufficient.
     */
    _toggleAutoOrbit() {
        const ctrl = this.sceneManager.controls;
        if (!ctrl) return;

        const next = !ctrl.autoRotate;
        ctrl.autoRotate = next;
        // Read from the stored speed value so the sidebar slider and the
        // R-key hotkey are always in sync — changing the slider then
        // pressing R uses the slider's current value, not a hardcoded one.
        ctrl.autoRotateSpeed = this._autoOrbitSpeed;

        this._showToast(
            next
                ? `Auto-orbit ON  (speed ${this._autoOrbitSpeed.toFixed(1)}) — press R to stop`
                : 'Auto-orbit OFF',
            2200
        );
    }

    _setCameraView(viewKey) {
        const cam    = this.sceneManager.camera;
        const ctrl   = this.sceneManager.controls;
        if (!cam || !ctrl) return;

        // Preserve current distance from the orbit target so zoom level
        // is not reset when the user snaps to a new view angle.
        const dist   = cam.position.distanceTo(ctrl.target);
        const target = ctrl.target.clone();

        // Direction vectors: each is a unit vector pointing FROM the orbit
        // target TOWARD the camera position. The camera is placed at
        // target + dir * dist so it looks toward the target from that direction.
        //
        // Top/bottom views have a special case: OrbitControls has a gimbal
        // lock at the poles (when camera is exactly on the Y axis) because
        // it cannot determine the "up" direction. We offset slightly from
        // the exact pole to avoid this, giving the user a clear top/bottom
        // view that still allows full mouse dragging afterward.
        const dirs = {
            home:          new THREE.Vector3( 0.6,  0.7,  1.0).normalize(),
            front:         new THREE.Vector3( 0,    0.05, 1.0).normalize(),
            back:          new THREE.Vector3( 0,    0.05,-1.0).normalize(),
            left:          new THREE.Vector3(-1.0,  0.05, 0  ).normalize(),
            right:         new THREE.Vector3( 1.0,  0.05, 0  ).normalize(),
            // ── Pole offset increased from 0.001 to 0.15 ──────────────────────
            // At 0.001, the camera sits so close to the Y axis (the up vector /
            // polar axis) that horizontal dragging — which rotates azimuthally
            // around this axis — produces almost zero visible movement. This is
            // not a bug; it's the nature of spherical coordinates near a pole.
            //
            // 0.15 tilts the camera ~8.6° off the true top/bottom axis. The
            // view still reads as "top-down" / "bottom-up" but now sits far
            // enough from the pole that azimuthal dragging produces clearly
            // visible rotation, letting the user tilt into angled perspectives
            // from there.
            top:           new THREE.Vector3( 0.15, 1.0,  0   ).normalize(),
            bottom:        new THREE.Vector3( 0.15,-1.0,  0   ).normalize(),
            perspective45: new THREE.Vector3( 0.7,  0.7,  0.7 ).normalize(),
        };

        const dir = dirs[viewKey] || dirs.home;

        cam.position.copy(target.clone().add(dir.clone().multiplyScalar(dist)));

        // Do NOT call cam.lookAt() here — let OrbitControls handle it via update()

        // ── Ensure controls are not constrained or disabled ───────────────────
        // If any prior interaction left these constrained or disabled, dragging
        // after a view snap would silently do nothing. Explicitly reset to the
        // permissive defaults every time a view is set.
        ctrl.enabled         = true;
        ctrl.minPolarAngle   = 0;
        ctrl.maxPolarAngle   = Math.PI;
        ctrl.minAzimuthAngle = -Infinity;
        ctrl.maxAzimuthAngle =  Infinity;

        ctrl.update();
        ctrl.saveState();

        // Force an immediate re-render so the view change is instantaneous
        if (this.sceneManager.renderMode === 'glsl') {
            this.sceneManager._renderGLSL();
        } else if (this.sceneManager.renderMode === 'rayMarch') {
            this.sceneManager.rayMarchRenderer.syncCamera(cam, ctrl);
            this.sceneManager._renderRayMarch();
        } else {
            // marchingSquares — Three.js renders on the animation loop
            // but force one frame immediately for responsiveness
            this.sceneManager.renderer.render(
                this.sceneManager.scene,
                cam
            );
        }
    }
    
    /**
     * Toggle the preset panel. Shows the three V1 example scenes with
     * a description and audience label for each. Clicking a preset loads
     * it immediately after confirming the current scene can be discarded.
     */
    _togglePresetPanel(anchorEl) {
        const existing = document.getElementById('nc-preset-panel');
        if (existing) { existing.remove(); return; }

        const anchorRect = anchorEl.getBoundingClientRect();

        const panel = document.createElement('div');
        panel.id = 'nc-preset-panel';
        panel.style.cssText = `
            position: fixed;
            top: ${anchorRect.bottom + 6}px;
            left: ${anchorRect.left}px;
            background: rgba(16,16,22,0.98);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 8px;
            padding: 16px 18px 14px;
            z-index: 2000;
            pointer-events: auto;
            min-width: 340px;
            max-width: 400px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.55);
            font-family: var(--font-sans, sans-serif);
        `;

        // Header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;';

        const ttl = document.createElement('span');
        ttl.textContent = 'Example scenes';
        ttl.style.cssText = 'font-size:13px; font-weight:600; color:rgba(255,255,255,0.9);';

        const cls = document.createElement('button');
        cls.textContent = '✕';
        cls.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.4); font-size:13px; cursor:pointer; padding:0;';
        cls.addEventListener('click', () => panel.remove());

        hdr.appendChild(ttl);
        hdr.appendChild(cls);
        panel.appendChild(hdr);

        // One card per preset
        PRESETS.forEach(preset => {
            const card = document.createElement('div');
            card.style.cssText = `
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 6px;
                padding: 12px 14px;
                margin-bottom: 8px;
                cursor: pointer;
                transition: background 0.15s ease;
            `;
            card.addEventListener('mouseenter', () =>
                card.style.background = 'rgba(255,255,255,0.10)'
            );
            card.addEventListener('mouseleave', () =>
                card.style.background = 'rgba(255,255,255,0.05)'
            );

            const titleRow = document.createElement('div');
            titleRow.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px;';

            const titleEl = document.createElement('span');
            titleEl.textContent = preset.meta.label;
            titleEl.style.cssText = 'font-size:13px; font-weight:600; color:rgba(255,255,255,0.9);';

            const audienceEl = document.createElement('span');
            audienceEl.textContent = preset.meta.audience;
            audienceEl.style.cssText = 'font-size:10px; opacity:0.5; color:rgba(180,230,255,0.9);';

            titleRow.appendChild(titleEl);
            titleRow.appendChild(audienceEl);

            const descEl = document.createElement('div');
            descEl.textContent = preset.meta.description;
            descEl.style.cssText = 'font-size:12px; opacity:0.6; line-height:1.45; color:rgba(220,220,230,0.85);';

            card.appendChild(titleRow);
            card.appendChild(descEl);

            card.addEventListener('click', () => {
                panel.remove();
                this._loadPreset(preset);
            });

            panel.appendChild(card);
        });

        // Close on outside click
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
     * Load a preset scene directly into the graph.
     *
     * Process:
     *   1. Snapshot current state for undo.
     *   2. Clear the scene (same as the clear button).
     *   3. Deserialize the preset's graph JSON into the node graph.
     *   4. Rebuild Three.js primitives for any geometry nodes.
     *   5. Switch to the preset's recommended render mode.
     *   6. Re-layout and fit to screen.
     *
     * @param {object} preset  One entry from the PRESETS array
     */
    _loadPreset(preset) {
        // Snapshot so the user can undo back to their previous scene
        this._undo.snapshot();

        // Clear current state
        this._clearAll();

        // Small delay to let _clearAll's internal setTimeout settle
        setTimeout(() => {
            const graph = this.stateStore.nodeGraph;

            // Build the graph directly from the preset data using addNode/addEdge.
            // This bypasses deserialize() entirely so the preset format is
            // independent of the serialization schema — no format mismatch possible.
            try {
                // Add nodes first, using forceId so edge references stay valid
                for (const nodeDef of preset.graph.nodes) {
                    graph.addNode(
                        nodeDef.type,
                        { ...nodeDef.params },
                        nodeDef.uiPos || { x: 0, y: 0 },
                        nodeDef.id
                    );
                }
                // Add edges after all nodes exist
                for (const edgeDef of preset.graph.edges) {
                    try {
                        graph.addEdge(
                            edgeDef.fromNode,
                            edgeDef.fromPort,
                            edgeDef.toNode,
                            edgeDef.toPort
                        );
                    } catch(edgeErr) {
                        // Log but continue — a single bad edge should not abort the preset
                        console.warn(
                            `Preset edge ${edgeDef.id} ` +
                            `(${edgeDef.fromNode}:${edgeDef.fromPort} → ` +
                            `${edgeDef.toNode}:${edgeDef.toPort}) skipped: ` +
                            edgeErr.message
                        );
                    }
                }
            } catch(e) {
                console.error('Preset load failed:', e.message);
                this._showToast(
                    `Failed to load preset "${preset.meta.label}": ${e.message}`,
                    5000
                );
                return;
            }

            // Keep UndoManager in sync
            this._undo.syncGraph(graph);

            // Rebuild Three.js objects for geometry nodes
            const GEOM_TYPES = new Set([
                'circle','regularPolygon','triangle','arc','polytope','lineSegment',
                'sphere','box','cylinder','capsule','torus','cone','plane'
            ]);

            graph.nodes.forEach((node) => {
                if (!GEOM_TYPES.has(node.type)) return;
                try {
                    const entry = this.sceneManager._rebuildPrimitiveFromNode(node);
                    if (entry) {
                        this.sceneManager.activePrimitives.push(entry);
                        this.sceneManager._addToScene(entry);
                    }
                } catch(e) {
                    console.warn(
                        `Preset: could not rebuild primitive for node ` +
                        `${node.id} (${node.type}): ${e.message}`
                    );
                }
            });

            // Re-point evaluators at the restored graph
            this.sceneManager.evaluator.graph     = graph;
            this.sceneManager.evaluator.invalidate();
            this.sceneManager.glslEvaluator.graph = graph;
            this.sceneManager._lastGLSLSource     = null;
            this.sceneManager._lastRayMarchSource = null;

            // Sync output params from the preset's output node, including
            // the placement params (which default to 0 for all presets,
            // resetting any previous placement the user had configured)
            if (!this._pendingOutputParams) this._pendingOutputParams = {};
            const ALL_OUTPUT_PARAMS = [
                'renderMethod', 'resolution', 'boundsMin', 'boundsMax',
                'posX', 'posY', 'posZ', 'rotateX', 'rotateY', 'rotateZ',
            ];
            ALL_OUTPUT_PARAMS.forEach(k => {
                this._pendingOutputParams[k] = this._getOutputParam(k);
                this._syncOutputControls(k, this._getOutputParam(k));
            });

            // Rebuild cards, layout, edges
            this._rebuildCards();
            this._runAutoLayout();
            this._drawEdges();
            this._fitToScreen();
            this._updateGraphStatusLabel();

            // Switch to the preset's recommended render mode and trigger render
            const savedMode = preset.meta.renderMode || 'marchingSquares';

            if (savedMode === 'rayMarch') {
                this.sceneManager.setRenderMode('rayMarch');
                this.sceneManager.rayMarchRenderer?.show();
                // Ensure output is wired then render
                this._ensureOutputWired();
                this.sceneManager._renderRayMarch();
                this._renderModeBtn.textContent = '▣ Marching Squares';
            } else if (savedMode === 'glsl') {
                this.sceneManager.setRenderMode('glsl');
                this.sceneManager.sdfRenderer?.show();
                this._ensureOutputWired();
                this.sceneManager._renderGLSL();
                this._renderModeBtn.textContent = '⬜ Ray March';
            } else {
                this.sceneManager.setRenderMode('marchingSquares');
                this._renderModeBtn.textContent = '⬛ GLSL Mode';
                this._ensureOutputWired();
                const sdf = this.sceneManager.evaluator.getRootSDF();
                if (sdf) {
                    this.sceneManager.renderSDF(sdf, this._getOutputParam('renderMethod'));
                }
            }

            this._showToast(
                `✓ Loaded "${preset.meta.label}" — ${preset.meta.description}`,
                4000
            );

        }, 80);
    }

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
        modeEl.style.cssText = 'font-size:12px; color:rgba(255,255,255,0.38); margin-bottom:14px;';
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
            desc.style.cssText = 'font-size:12px; color:rgba(255,255,255,0.32); margin-top:3px; padding:0 2px;';
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

        // ── STL — 3D printing export ──────────────────────────────────────────
        // Available when the scene contains 3D geometry (solid primitives or
        // bridge nodes). The STL is generated by running marching cubes on the
        // CPU evaluator at the selected resolution.
        const stlAvail = this.sceneManager._sceneHas3D();
        panel.appendChild(_row(
            '🖨', 'Export STL  (3D Print)',
            stlAvail
                ? 'Download a binary STL mesh for 3D printing. Compatible with Cura, PrusaSlicer, Bambu Studio, and Chitubox.'
                : 'Add a 3D primitive (sphere, box, cylinder…) or use Extrude/Revolve to enable STL export.',
            () => this._exportSTLWithUI(),
            stlAvail
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
     * STL export entry point called from the export panel.
     * Shows a resolution picker dialog, shows a progress toast, runs the
     * export, then shows a completion or error toast.
     *
     * Resolution options presented to the user:
     *   Fast (64)   — ~262k cells, suitable for previewing printability
     *   Medium (96) — ~884k cells, good balance for most scenes
     *   High (128)  — ~2M cells, maximum detail, may take several seconds
     *
     * The user is also reminded that 3D printing requires a manifold (watertight)
     * mesh. SDF zero-crossings produce manifold meshes for well-formed SDFs.
     */
    _exportSTLWithUI() {
        // Ask the user to pick a resolution
        // A native prompt is used here because it is universally understood
        // and requires no additional DOM construction.
        const choice = prompt(
            'STL Export — 3D Print Quality\n\n' +
            'Choose resolution (cells per axis):\n' +
            '  1 = Fast   (64)  — quick preview, coarser detail\n' +
            '  2 = Medium (96)  — good for most prints\n' +
            '  3 = High   (128) — maximum detail, may take a few seconds\n\n' +
            'Note: For best print results, use Ray March mode to verify\n' +
            'the geometry looks correct before exporting.\n\n' +
            'Enter 1, 2, or 3:',
            '2'
        );

        if (!choice) return;  // User cancelled

        const resolutions = { '1': 64, '2': 96, '3': 128 };
        const resolution  = resolutions[choice.trim()] ?? 96;

        // Show a working toast immediately so the user knows something is happening.
        // The marching cubes step is synchronous and can take 1-5 seconds.
        this._showToast(
            `⏳ Generating STL mesh at resolution ${resolution}… this may take a moment.`,
            8000
        );

        // Defer the export by one frame so the toast renders before the
        // blocking marching cubes computation begins.
        setTimeout(async () => {
            const result = await this.sceneManager._exportSTL(resolution);

            if (result.ok) {
                this._showToast(
                    `✓ STL exported — ${result.triangles.toLocaleString()} triangles, ` +
                    `${result.sizeKB.toLocaleString()} KB. ` +
                    `Open in your slicer (Cura, PrusaSlicer, Bambu Studio) to prepare for printing.`,
                    6000
                );
            } else {
                this._showToast(
                    `✗ STL export failed: ${result.error}`,
                    6000
                );
            }
        }, 50);
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

        // ── Step 8b: Sync button states and drawer with restored graph ─────────
        this._updateGraphStatusLabel();

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