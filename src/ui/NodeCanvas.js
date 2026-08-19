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
    import { maskHasContent, computeMaskDomeRadius } from '../utils/surfaceMask.js';

    // Types that are shown as cards in the canvas
    const TOP_LEVEL_TYPES = new Set([
    'lineSegment', 'triangle', 'arc', 'circle', 'regularPolygon', 'polytope',
    'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane',
    'extrudeNode', 'revolveNode',
    'noiseDisplaceNode', 'twistNode', 'bendNode', 'repeatNode',
    'transform3DNode',
    'rUnion', 'rIntersection', 'rDifference', 'schurBlend', 'ifsBlend',
    'rBlend', 'morphBlend', 'embedNode',
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
        this._recomposeTimer          = null;
        this._viewportDragAttached    = false;
        this._viewportPickingAttached = false;
        // The single node (if any) currently showing a pivot gizmo.
        // Singleton by design — opening a DIFFERENT card's Transform
        // section replaces this rather than showing a second simultaneous
        // gizmo. Read by _attachViewportDrag/_applySnapCandidate/
        // _onTransformChange to decide whether to refresh the gizmo's
        // position during a drag; written by _onTransformSectionToggle
        // and _togglePivotGizmoShortcut below.
        this._activeGizmoNodeId = null;

        // embedNode anchor-picking mode. When set, the NEXT viewport click
        // is intercepted by _handleViewportClick (before normal selection
        // logic runs) and used to place that embedNode's anchor on the
        // clicked point of its host shape, instead of selecting whatever's
        // under the cursor.
        this._anchorPickMode = null; // { embedNodeId, hostNodeId } | null
        this._embedRegionVisibleFor = null; // nodeId currently showing its ring, or null

        // Universal surface-paint state (see NodeCard's "Surface Region"
        // section — present on every SDF-producing node card, not just
        // embedNode). Brush (drag) and Flood (single click) are mutually
        // exclusive, single-active-target modes — arming one disarms the
        // other and any active anchor-pick.
        this._paintBrushMode = null;    // nodeId | null — brush drag armed for this node
        this._paintFloodMode = null;    // nodeId | null — flood-click armed for this node
        this._paintStrokeBuffer = null; // raw {x,y,z,nx,ny,nz,w} samples accumulated during the active brush drag
        this._paintDragAttached = false;
        this._paintClickAttached = false;

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
        this._buildControlLegend();

        // "Compiling shader…" toast — fires only around a REAL recompile,
        // and only if that compile takes long enough to matter.
        let _compileToastTimer = null;
        this.sceneManager._onCompileStart = () => {
            clearTimeout(_compileToastTimer);
            _compileToastTimer = setTimeout(() => {
                this._showToast('⏳ Compiling shader…', 8000);
            }, 150);
        };
        this.sceneManager._onCompileEnd = () => {
            clearTimeout(_compileToastTimer);
            const existing = document.getElementById('nc-toast');
            if (existing && existing.textContent.includes('Compiling')) existing.remove();
        };
    }

    // ── Public ────────────────────────────────────────────────────────────────

    /** Programmatically open the canvas (e.g. from a menu button). */
    open() { this._doOpen(); }

    /** Programmatically close the canvas. */
    close() { this._doClose(); }

    _buildControlLegend() {
        const legend = document.createElement('div');
        legend.id = 'nc-control-legend';
        legend.style.cssText = `
            position: fixed;
            bottom: 14px;
            left: 14px;
            z-index: 900;
            font-family: var(--font-sans, sans-serif);
            pointer-events: auto;
        `;

        const toggle = document.createElement('button');
        toggle.textContent = '⌨';
        toggle.title = 'Controls reference';
        toggle.style.cssText = `
            width: 26px; height: 26px;
            border-radius: 50%;
            background: rgba(20,20,26,0.55);
            border: 1px solid rgba(255,255,255,0.15);
            color: rgba(255,255,255,0.6);
            font-size: 13px;
            cursor: pointer;
        `;

        const panel = document.createElement('div');
        panel.style.cssText = `
            display: none;
            position: absolute;
            bottom: 32px;
            left: 0;
            background: rgba(16,16,22,0.95);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 11px;
            line-height: 1.7;
            color: rgba(220,220,230,0.9);
            white-space: nowrap;
            box-shadow: 0 6px 20px rgba(0,0,0,0.5);
        `;
        panel.innerHTML = `
            <div style="opacity:0.55; text-transform:uppercase; font-size:9px; margin-bottom:4px;">Camera (mouse)</div>
            <div>Drag — orbit &nbsp; · &nbsp; Scroll — zoom &nbsp; · &nbsp; Middle-drag — pan</div>
            <div style="opacity:0.55; text-transform:uppercase; font-size:9px; margin:8px 0 4px;">Geometry (shape itself)</div>
            <div>Alt+Drag — move position</div>
            <div>Alt+Shift+Drag — move pivot</div>
            <div>Scale — use the card's Transform → Scale slider</div>
        `;

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('mousedown', (e) => {
            if (!legend.contains(e.target)) panel.style.display = 'none';
        });

        legend.appendChild(panel);
        legend.appendChild(toggle);
        document.body.appendChild(legend);
    }

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

        // ── Progressive disclosure (Phase 6a) ─────────────────────────────────
        // A single class on the overlay root controls visibility of every
        // element tagged .nc-advanced-only, via one CSS rule. This means
        // newly created NodeCards (built after the toggle state is already
        // set) are correctly hidden/shown automatically through the CSS
        // cascade — no per-card JS bookkeeping needed regardless of when a
        // card's DOM is constructed.
        if (!document.getElementById('nc-tier-styles')) {
            const _tierStyle = document.createElement('style');
            _tierStyle.id = 'nc-tier-styles';
            _tierStyle.textContent = `
                .nc-tier-basic .nc-advanced-only { display: none !important; }
            `;
            document.head.appendChild(_tierStyle);
        }

        // ── Custom hover tooltips (Phase 6b) ───────────────────────────────────
        // Delegated on document.body (not this._overlay) — several floating
        // panels (export panel, preset panel, view menu, dropdown panels)
        // attach directly to document.body rather than the overlay's
        // subtree, so a single body-level listener is the only way to
        // cover every current AND future titled element with zero
        // per-element wiring, including dynamically rebuilt NodeCards.
        if (!this._tooltipAttached) {
            this._tooltipAttached = true;
            this._tooltipEl = document.createElement('div');
            this._tooltipEl.style.cssText = `
                position: fixed;
                z-index: 99999;
                background: rgba(16,16,22,0.98);
                border: 1px solid rgba(255,255,255,0.14);
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 12px;
                line-height: 1.4;
                color: rgba(230,230,235,0.95);
                font-family: var(--font-sans, sans-serif);
                max-width: 240px;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.12s ease;
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            `;
            document.body.appendChild(this._tooltipEl);

            let hoverTimer = null;
            let activeEl   = null;

            const showTooltip = (el, x, y) => {
                const text = el.dataset.tooltipText;
                if (!text) return;
                this._tooltipEl.textContent = text;
                this._tooltipEl.style.opacity = '1';

                // Position near cursor, clamped so it never renders off-screen
                const PAD = 14;
                let left = x + PAD;
                let top  = y + PAD;
                const rect = this._tooltipEl.getBoundingClientRect();
                if (left + rect.width  > window.innerWidth)  left = x - rect.width - PAD;
                if (top  + rect.height > window.innerHeight) top  = y - rect.height - PAD;
                this._tooltipEl.style.left = `${Math.max(4, left)}px`;
                this._tooltipEl.style.top  = `${Math.max(4, top)}px`;
            };

            const hideTooltip = () => {
                this._tooltipEl.style.opacity = '0';
            };

            document.body.addEventListener('mouseover', (e) => {
                const el = e.target.closest('[title]');
                if (!el || el === activeEl) return;

                // Suppress the native browser tooltip, but remember the
                // original text so it can be restored later.
                if (el.title) {
                    el.dataset.tooltipText = el.title;
                    el.dataset.tooltipHadTitle = 'true';
                    el.title = '';
                }
                activeEl = el;

                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    if (activeEl === el) showTooltip(el, e.clientX, e.clientY);
                }, 400);
            });

            document.body.addEventListener('mousemove', (e) => {
                if (activeEl && this._tooltipEl.style.opacity === '1') {
                    showTooltip(activeEl, e.clientX, e.clientY);
                }
            });

            document.body.addEventListener('mouseout', (e) => {
                const el = e.target.closest('[title], [data-tooltip-had-title]');
                if (!el) return;
                if (el.dataset.tooltipHadTitle === 'true' && el.dataset.tooltipText) {
                    el.title = el.dataset.tooltipText;
                }
                if (el === activeEl) {
                    clearTimeout(hoverTimer);
                    activeEl = null;
                    hideTooltip();
                }
            });
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
            items.forEach(({ value, label, hint, advanced }) => {
                const item = document.createElement('div');
                item.textContent = label;
                item.dataset.value = value;
                if (hint) item.title = hint;
                // Advanced-tier gating (Phase 6a): this panel is appended to
                // document.body (see the `document.body.appendChild(panel);`
                // line further down in this same function), which is
                // exactly where the tier class lives — so the identical CSS
                // rule that hides the Pivot section also hides these rows
                // when Basic tier is active.
                if (advanced) item.classList.add('nc-advanced-only');
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
          'schurBlend','rBlend','morphBlend','embedNode'
        ]);
        const _MAPPER = new Set([
          'polynomialMapper','sinusoidalMapper','exponentialMapper',
          'logarithmicMapper','powerMapper'
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
          this.sceneManager.addPrimitive(v, this._nextCardPosition());
          setTimeout(() => {
            // Never auto-layout after node addition — cards should stay
            // wherever _nextCardPosition() placed them. Auto layout is
            // only triggered by the explicit Auto button in the sidebar.
            this._rebuildCards();
            this._drawEdges();
          }, 50);
          } else if (_XFORM.has(v)) {
            this._addTransformNode(v);  // snapshot taken inside _addTransformNode
          } else if (_BLEND.has(v)) {
            this._addBlendNode(v);      // snapshot taken inside _addBlendNode
          } else if (_MAPPER.has(v)) {
            this._addMapperNode(v);     // snapshot taken inside _addMapperNode
          }
        };

        // ── 2D geometry dropdown ──────────────────────────────────────────────
        const _2dDropdown = _makeCustomDropdown(
            '2D ▾',
            [
                { value: 'line',     label: 'Line',         hint: 'A straight line segment between two points.' },
                { value: 'triangle', label: 'Triangle',     hint: 'A simple three-sided shape.' },
                { value: 'arc',      label: 'Arc',          hint: 'A curved slice of a circle, like a rainbow or a crescent.' },
                { value: 'circle',   label: 'Circle',       hint: 'A perfect round shape.' },
                { value: 'polygon',  label: 'Polygon',      hint: 'A shape with equal sides, like a hexagon or octagon.' },
                { value: 'polytope', label: 'Conv. Polygon', hint: 'A custom shape you outline yourself, point by point.' },
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _2dDropdown.el.title = 'Click a 2D primitive to add it to the graph';
        // Tier gate: the ENTIRE 2D dropdown is advanced-only, not just some
        // of its items — a Basic-tier user should never need to open this
        // menu at all (2D workflows are themselves an advanced use case).
        // Reuses the existing .nc-advanced-only / .nc-tier-basic mechanism
        // (see the ⚙ Advanced toggle handler and the CSS rule injected in
        // _buildDOM) rather than gating each item individually.
        _2dDropdown.el.classList.add('nc-advanced-only');
        toolbar.appendChild(_2dDropdown.el);

        // ── 3D geometry dropdown ──────────────────────────────────────────────
        const _3dDropdown = _makeCustomDropdown(
            '3D ▾',
            [
                { value: 'sphere',   label: 'Sphere',   hint: 'A round ball.' },
                { value: 'box',      label: 'Box',      hint: 'A cube or rectangular block.' },
                { value: 'cylinder', label: 'Cylinder', hint: 'A tube or pillar shape.' },
                { value: 'capsule',  label: 'Capsule',  hint: 'A cylinder with rounded, pill-like ends.', advanced: true },
                { value: 'torus',    label: 'Torus',    hint: 'A ring or donut shape.', advanced: true },
                { value: 'cone',     label: 'Cone',     hint: 'A shape that tapers to a point, like an ice cream cone.' },
                { value: 'plane',    label: 'Plane',    hint: 'An endless flat surface, like a floor with no edges.', advanced: true },
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _3dDropdown.el.title = 'Click a 3D primitive to add it to the graph';
        toolbar.appendChild(_3dDropdown.el);

        // ── Transform / operation dropdown ────────────────────────────────────
        const _xformDropdown = _makeCustomDropdown(
            'Transform ▾',
            [
                // extrude/revolve: advanced:true here is a TIER gate
                // (hidden from Basic-tier users entirely). This is separate
                // from _updateDropdownAvailability's dimensional-validity
                // greying (✕ prefix + disabled cursor when the selected/
                // sole primitive is 3D) — that logic is untouched and still
                // applies on top of this whenever the item IS visible.
                { value: 'extrude',       label: 'Extrude',           hint: 'Pushes a flat shape through space to give it depth, turning 2D into 3D.', advanced: true },
                { value: 'revolve',       label: 'Revolve',           hint: 'Spins a flat shape around a line to make a solid, like a potter\'s wheel.', advanced: true },
                { value: 'tiling',        label: 'Tiling / Repeat',   hint: 'Repeats the shape in a pattern — infinitely, or a limited number of times with exact count and spacing control.' },
                { value: 'symmetryfold',  label: 'Sym. Fold',         hint: 'Mirrors the shape like a kaleidoscope.' },
                { value: 'symmetryorbit', label: 'Sym. Orbit',        hint: 'Places several copies of the shape in a circle around a center point.', advanced: true },
                { value: 'mobius',        label: 'Möbius',            hint: 'An experimental, swirling warp. Results can be surprising — just try values and see.', advanced: true },
                { value: 'noisedisplace', label: 'Noise Disp.',       hint: 'Adds a bumpy, organic texture to the surface.' },
                { value: 'twist',         label: 'Twist',             hint: 'Twists the shape like wringing a towel.' },
                { value: 'bend',          label: 'Bend',              hint: 'Curves the shape, like bending a straw.' },
                // 'position3d' (Position / Orient) intentionally removed —
                // redundant now that every node has its own Transform
                // section. NodeSpec/evaluators left intact for old scenes.
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
                { value: 'rBlend',     label: 'R-Blend', hint: 'Combines two shapes — merge them, keep only the overlap, or cut one from the other. Choose which on the card.' },
                { value: 'morphBlend', label: 'Morph',   hint: 'Smoothly dissolves from the first shape into the second shape.' },
                { value: 'embedNode',  label: 'Emboss / Engrave', hint: 'Decorates the surface of one shape with another, in a small area you choose.' },
                { value: 'schurBlend', label: 'Schur',    hint: 'Like R-Blend, but with extra fine control over the seam — useful when a blend looks too thin or hollow.', advanced: true },
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _blendDropdown.el.title = 'Click a blend mode to add it to the graph';
        toolbar.appendChild(_blendDropdown.el);
        // ── Mapper dropdown ───────────────────────────────────────────────────
        const _mapperDropdown = _makeCustomDropdown(
            'Mapper ▾',
            [
                // Gated advanced: doesn't animate anything (unlike
                // sinusoidal/noise-displace/morph), making it the odd one
                // out among the mapper family for a Basic-tier user.
                { value: 'polynomialMapper',  label: 'Polynomial',  hint: 'Warps the edge based on distance — can create a bulging or pinched boundary.', advanced: true },
                { value: 'sinusoidalMapper',  label: 'Sinusoidal',  hint: 'Adds rippling rings inside and outside the edge. Can pulse in and out over time.' },
                { value: 'exponentialMapper', label: 'Exponential', hint: 'Stretches the falloff unevenly — sharp near the edge, soft further out.', advanced: true },
                { value: 'logarithmicMapper', label: 'Logarithmic', hint: 'Compresses the falloff unevenly — soft near the edge, sharp further out.', advanced: true },
                { value: 'powerMapper',       label: 'Power',        hint: 'Reshapes the falloff curve — try different strengths for different effects.', advanced: true },
            ],
            (v) => _dispatchAdd(v, { value: v })
        );
        _mapperDropdown.el.title = 'Add a mapper, then drag-connect it into a shape\'s "mapper" input to reshape its edge.';
        toolbar.appendChild(_mapperDropdown.el);

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
    saveBtn.title = 'Save your current scene so you can come back to it later.';
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


      // Dismiss onboarding overlay when a saved scene is loaded
        if (this._onboardingOverlay) {
            this._onboardingOverlay.style.opacity = '0';
            setTimeout(() => {
                if (this._onboardingOverlay?.parentNode) {
                    this._onboardingOverlay.parentNode
                        .removeChild(this._onboardingOverlay);
                    this._onboardingOverlay = null;
                }
            }, 700);
        }
        
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
    loadBtn.title = 'Open a scene you saved earlier.';
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

    // ── Advanced-mode toggle (Phase 6a) ──────────────────────────────────────
    // Session-only state (not persisted across reloads — mirrors
    // _sidebarPinned). Off by default: hides the Pivot sub-section on every
    // NodeCard's Transform section, and the GLSL shader export row in the
    // Export panel — the two controls identified as genuinely advanced
    // (requiring the unfamiliar "pivot" concept, or only useful to someone
    // embedding output elsewhere). Everything else stays visible regardless
    // of this toggle, including keyboard shortcuts and drag gestures, since
    // those add no visible clutter to begin with.
    this._advancedMode = false;
    const _advancedBtn = this._makeButton('⚙ Advanced', () => {
        this._advancedMode = !this._advancedMode;
        document.body.classList.toggle('nc-tier-advanced', this._advancedMode);
        document.body.classList.toggle('nc-tier-basic', !this._advancedMode);
        _advancedBtn.style.background = this._advancedMode
            ? 'rgba(127,119,221,0.35)' : 'rgba(255,255,255,0.08)';
        _advancedBtn.style.borderColor = this._advancedMode
            ? 'rgba(127,119,221,0.7)' : 'rgba(255,255,255,0.15)';
    });
    _advancedBtn.title = 'Show advanced controls (pivot placement, shader export). ' +
        'Off by default to keep the interface simple for common tasks.';
    toolbar.appendChild(_advancedBtn);

    
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
        // Basic tier by default. Applied to document.body, NOT this._overlay —
        // several floating panels (export panel, preset panel, view menu,
        // dropdown panels) attach directly to document.body rather than the
        // overlay's subtree, so an overlay-scoped class would never reach
        // them. document.body is an ancestor of everything.
        document.body.classList.add('nc-tier-basic');
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
        this._buildOnboardingOverlay();

        // ── Initial dropdown availability ─────────────────────────────────────
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

        // ── Orbit generator dropdown ───────────────────────────────────────
        // Replaces OrbitControls.autoRotate (fixed-axis circular only) with
        // the pluggable generator registry in orbitGenerators.js. Circular
        // remains the default/cheapest option; the others are opt-in.
        const orbitGenRow = document.createElement('div');
        orbitGenRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px;';
        const orbitGenLabel = document.createElement('label');
        orbitGenLabel.textContent = 'Orbit path';
        orbitGenLabel.title = 'Which camera path auto-orbit (R key) follows.';
        orbitGenLabel.style.cssText = 'font-size:12px; opacity:0.75; min-width:72px; flex-shrink:0; cursor:help; color:rgba(220,220,230,0.9);';
        const orbitGenSelect = document.createElement('select');
        orbitGenSelect.style.cssText = `
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 4px; color: rgba(255,255,255,0.8); font-size: 11px;
            padding: 3px 4px; flex: 1; min-width: 0; cursor: pointer;
        `;
        [
            ['circular', 'Circular'],
            ['spiral', 'Spiral'],
            ['lissajous', 'Lissajous'],
            ['curvatureGuided', 'Curvature-Guided'],
        ].forEach(([val, label]) => {
            const o = document.createElement('option');
            o.value = val; o.textContent = label;
            o.style.backgroundColor = '#1c1c22'; o.style.color = 'rgba(220,220,230,0.95)';
            if (val === this._orbitGenerator) o.selected = true;
            orbitGenSelect.appendChild(o);
        });
        this._orbitGenerator = this._orbitGenerator || 'circular';
        orbitGenSelect.addEventListener('change', () => {
            this._orbitGenerator = orbitGenSelect.value;
            recomputeBtn.style.display = this._orbitGenerator === 'curvatureGuided' ? 'block' : 'none';
            if (this.sceneManager.isOrbitActive()) {
                this.sceneManager.startOrbit(this._orbitGenerator, { speed: this._autoOrbitSpeed });
            }
        });
        orbitGenRow.appendChild(orbitGenLabel);
        orbitGenRow.appendChild(orbitGenSelect);
        camSection.appendChild(orbitGenRow);

        // ── Orbit speed slider ──────────────────────────────────────────────
        const orbitSpeedRow = document.createElement('div');
        orbitSpeedRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:6px; margin-bottom:2px;';
        const orbitSpeedLabel = document.createElement('label');
        orbitSpeedLabel.textContent = 'Orbit speed';
        orbitSpeedLabel.title = 'Auto-orbit speed (R key). Slow (left) for cinematic shots, fast (right) for quick demo spins.';
        orbitSpeedLabel.style.cssText = 'font-size:12px; opacity:0.75; min-width:72px; flex-shrink:0; cursor:help; color:rgba(220,220,230,0.9);';
        const orbitSpeedSlider = document.createElement('input');
        orbitSpeedSlider.type = 'range';
        orbitSpeedSlider.min = '0.05'; orbitSpeedSlider.max = '2.0'; orbitSpeedSlider.step = '0.05';
        orbitSpeedSlider.value = String(this._autoOrbitSpeed);
        orbitSpeedSlider.title = orbitSpeedLabel.title;
        orbitSpeedSlider.style.cssText = 'flex:1; min-width:0; height:14px; accent-color:#378ADD; cursor:pointer;';
        const orbitSpeedDisplay = document.createElement('span');
        orbitSpeedDisplay.textContent = this._autoOrbitSpeed.toFixed(2);
        orbitSpeedDisplay.style.cssText = 'font-size:11px; opacity:0.8; min-width:32px; text-align:right; font-variant-numeric:tabular-nums; flex-shrink:0; color:rgba(220,220,230,0.85);';
        orbitSpeedSlider.addEventListener('input', () => {
            const val = parseFloat(orbitSpeedSlider.value);
            this._autoOrbitSpeed = val;
            orbitSpeedDisplay.textContent = val.toFixed(2);
            if (this.sceneManager.isOrbitActive()) {
                this.sceneManager.startOrbit(this._orbitGenerator, { speed: val });
            }
        });
        orbitSpeedRow.appendChild(orbitSpeedLabel);
        orbitSpeedRow.appendChild(orbitSpeedSlider);
        orbitSpeedRow.appendChild(orbitSpeedDisplay);
        camSection.appendChild(orbitSpeedRow);

        // ── Recompute Interest Map button (curvature-guided only) ───────────
        const recomputeBtn = this._makeButton('🔍 Recompute Interest Map', () => {
            this.sceneManager.computeCurvatureInterestMap();
            this._showToast('Curvature interest map recomputed.', 1500);
        });
        recomputeBtn.title = 'Re-scan the scene for high-curvature (visually interesting) regions after a major edit.';
        recomputeBtn.style.cssText += 'margin-top:6px; width:100%; font-size:11px;';
        recomputeBtn.style.display = this._orbitGenerator === 'curvatureGuided' ? 'block' : 'none';
        camSection.appendChild(recomputeBtn);

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
        const _stackBtn = this._makeButton('⊟ Stack', () => this._stackAllCards());
        _stackBtn.title = 'Pile all node cards in a corner so the geometry view is unobstructed';
        _stackBtn.style.cssText += 'flex:1; min-width:0; font-size:12px; border-color: rgba(255,200,80,0.3); color: rgba(255,225,160,0.85);';
        stackRow.appendChild(_stackBtn);

        const _revealBtn = this._makeButton('⊞ Reveal', () => this._revealAllCards());
        _revealBtn.title = 'Bring all cards back into the visible viewport (also: Home key)';
        _revealBtn.style.cssText += 'flex:1; min-width:0; font-size:12px; border-color: rgba(100,200,150,0.3); color: rgba(160,230,190,0.85);';
        stackRow.appendChild(_revealBtn);

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
     * Compute a uiPos for a newly added node that places it in a
     * left-aligned vertical column, keeping the center viewport clear.
     * Cards stack downward from Y=60, X=20 — well clear of the rendered
     * geometry which occupies the center-right of the screen.
     */
    _nextCardPosition() {
        const graph      = this.stateStore.nodeGraph;
        const COLUMN_X   = 20;
        const COLUMN_W   = 320; // card width + inter-column gap
        const START_Y    = 60;
        const CARD_GAP   = 12;
        const CARD_H_EST = 180;

        // Maximum Y before wrapping to the next column.
        // Uses actual viewport height minus toolbar and bottom margin
        // so the last card in each column stays fully visible.
        const TOOLBAR_H  = 46;
        const BOTTOM_PAD = 24;
        const MAX_Y = window.innerHeight - TOOLBAR_H - BOTTOM_PAD;

        // Map each column index to the lowest occupied Y in that column.
        // Column index = floor(node.uiPos.x / COLUMN_W).
        const colDepths = new Map();

        graph.nodes.forEach(node => {
            if (!node.uiPos || node.type === 'outputNode') return;
            const colIdx  = Math.max(0, Math.floor((node.uiPos.x || 0) / COLUMN_W));
            const card    = this._cards?.get(node.id);
            const actualH = card?.el ? (card.el.offsetHeight || CARD_H_EST) : CARD_H_EST;
            const bottom  = (node.uiPos.y || 0) + actualH + CARD_GAP;
            colDepths.set(colIdx, Math.max(colDepths.get(colIdx) ?? START_Y, bottom));
        });

        // Find the first column that still has room for another card.
        let col = 0;
        while (col <= 7) {
            const depth = colDepths.get(col) ?? START_Y;
            if (depth + CARD_H_EST <= MAX_Y) break;
            col++;
        }
        // col 8 fallback: wrap back to col 0 rather than going off-screen right
        if (col > 7) col = 0;

        return {
            x: COLUMN_X + col * COLUMN_W,
            y: colDepths.get(col) ?? START_Y,
        };
    }

    /**
     * Build the empty-state onboarding overlay. A single horizontal row
     * of icon+label steps connected by arrows. Very low opacity so it
     * reads as ambient guidance rather than instruction. Disappears
     * permanently the moment the first non-output node is added.
     */
    _buildOnboardingOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'nc-onboarding';
        overlay.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: flex;
            flex-direction: row;
            align-items: center;
            pointer-events: none;
            z-index: 100;
            opacity: 1;
            transition: opacity 0.6s ease;
            user-select: none;
        `;

        const steps = [
            { icon: '⬡', label: 'Primitive' },
            { icon: '↻', label: 'Transform'  },
            { icon: '⊕', label: 'Blend'      },
            { icon: '▶', label: 'Render'     },
        ];

        steps.forEach((step, i) => {
            const node = document.createElement('div');
            node.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 6px;
                padding: 0 10px;
            `;

            const icon = document.createElement('div');
            icon.textContent = step.icon;
            icon.style.cssText = `
                font-size: 28px;
                color: rgba(180,210,255,0.28);
                line-height: 1;
            `;

            const label = document.createElement('div');
            label.textContent = step.label;
            label.style.cssText = `
                font-size: 11px;
                color: rgba(180,210,255,0.20);
                letter-spacing: 0.1em;
                text-transform: uppercase;
                font-family: sans-serif;
                white-space: nowrap;
            `;

            node.appendChild(icon);
            node.appendChild(label);
            overlay.appendChild(node);

            if (i < steps.length - 1) {
                const arrow = document.createElement('div');
                arrow.textContent = '→';
                arrow.style.cssText = `
                    font-size: 16px;
                    color: rgba(180,210,255,0.14);
                    padding-bottom: 18px;
                    font-family: sans-serif;
                `;
                overlay.appendChild(arrow);
            }
        });

        // Subtle hint below the flow pointing to Examples button
        const hint = document.createElement('div');
        hint.innerHTML = 'or load a scene via <strong style="color:rgba(180,210,255,0.22)">Examples ↗</strong>';
        hint.style.cssText = `
            position: absolute;
            bottom: -30px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 11px;
            color: rgba(180,210,255,0.16);
            letter-spacing: 0.05em;
            font-family: sans-serif;
            white-space: nowrap;
        `;
        overlay.appendChild(hint);

        document.body.appendChild(overlay);
        this._onboardingOverlay = overlay;
    }

    
    /**
     * Remap all node card positions back into the visible viewport.
     * Resets canvas pan/zoom to identity then re-runs _remapToLeftColumn
     * to place all cards in the left-column layout within the viewport.
     * Triggered by the ⊞ Reveal button and by the Home key (normal mode only).
     */
    _revealAllCards() {
        this._transform = { tx: 0, ty: 0, scale: 1 };
        if (this._bgCanvas) {
            this._bgCanvas.style.transform = '';
        }
        this._remapToLeftColumn();
        this._rebuildCards();
        this._drawEdges();
        this._showToast('All cards brought back into view', 1800);
    }

    /**
     * Remap all node uiPos values into a visible left-column layout.
     * Used by _revealAllCards() and preset loading.
     * Primitives and transforms stack downward in the left column.
     * The output node goes to a fixed far-right position.
     */
    _remapToLeftColumn() {
        const graph      = this.stateStore.nodeGraph;
        const COLUMN_X   = 20;
        const START_Y    = 60;
        const CARD_GAP   = 12;
        const CARD_H_EST = 180;
        const OUTPUT_X   = 1300;
        const OUTPUT_Y   = 200;

        let orderedIds;
        try {
            orderedIds = graph.topologicalOrder();
        } catch (e) {
            orderedIds = [...graph.nodes.keys()];
        }

        let currentY = START_Y;
        orderedIds.forEach(nodeId => {
            const node = graph.nodes.get(nodeId);
            if (!node) return;
            if (node.type === 'outputNode') {
                graph.updateNodePosition(nodeId, OUTPUT_X, OUTPUT_Y);
            } else {
                graph.updateNodePosition(nodeId, COLUMN_X, currentY);
                currentY += CARD_H_EST + CARD_GAP;
            }
        });
    }

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

        // One-time rollout notice (Phase 6a) — existing users who relied on
        // Pivot being visible by default need a pointer to where it went.
        // Fires once per session, on first open only.
        if (!this._advancedRolloutShown) {
            this._advancedRolloutShown = true;
            setTimeout(() => {
                this._showToast(
                    'Interface simplified — click ⚙ Advanced (top right) to show pivot placement and shader export.',
                    5000
                );
            }, 600);
        }

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

        // Attach click-to-select picking once
        if (!this._viewportPickingAttached) {
        this._attachViewportPicking();
        this._viewportPickingAttached = true;
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
            this._undo,
            (nodeId, field, value) => this._onTransformChange(nodeId, field, value),
            (nodeId, isOpen) => this._onTransformSectionToggle(nodeId, isOpen),
            (nodeId) => {
                const hostEdge = this.stateStore.nodeGraph.getIncomingEdge(nodeId, 'hostSdf');
                this._armAnchorPicking(nodeId, hostEdge?.fromNode);
            },
            (nodeId) => this._autoFitMorph(nodeId),
            (nodeId) => this._autoFitEmbedGuest(nodeId),
            (nodeId) => this._armPaintBrush(nodeId),
            (nodeId) => this._armPaintFlood(nodeId),
            (nodeId) => this._clearPaintMask(nodeId),
            (nodeId, field, value) => this._onMaskParamChange(nodeId, field, value)
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

          this.sceneManager.hidePivotGizmo();
          this._activeGizmoNodeId = null;
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

        // Hide the gizmo unconditionally — simpler and safer than tracking
        // which specific node it was attached to and checking membership.
        this.sceneManager.hidePivotGizmo();
        this._activeGizmoNodeId = null;

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
            this.sceneManager.hidePivotGizmo();
            this._activeGizmoNodeId = null;
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
        // NOTE: the pivot gizmo is deliberately NOT shown here. Selecting a
        // card (e.g. to drag it around the graph canvas) is a different
        // intent from wanting to see/edit that node's placement — the
        // gizmo is triggered by _onTransformSectionToggle instead, which
        // fires only when the card's Transform section is actually opened.
        // Re-evaluate bridge availability for the newly selected node.
        this._updateDropdownAvailability();
    } 

    /**
     * Viewport spatial drag — moves a selected node's POSITION or PIVOT
     * directly in 3D, with optional snapping to landmark points on other
     * (or, for pivot, the same) shapes.
     *
     * Gesture scheme:
     *   Alt + Left-drag         → move position
     *   Alt + Shift + Left-drag → move pivot
     *   Ctrl (held during drag) → temporarily inverts the dragged node's
     *                             card Snap toggle for this drag only
     *                             (Blender convention: on→off or off→on)
     *
     * Snapping is scoped to SINGLE-node selections only — with multiple
     * nodes selected, which one's nearby point should govern the whole
     * group's snap has no single correct answer, so multi-select drags
     * always use plain pixel-delta movement, unchanged from before.
     */
    _attachViewportDrag() {
        const renderer = this.sceneManager.renderer.domElement;
        let isDragging = false;
        let dragMode   = null; // 'position' | 'pivot'
        let lastX, lastY;

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
        this.sceneManager.controls.enabled = false;
        this._undo.snapshot();
        isDragging = true;
        dragMode = e.shiftKey ? 'pivot' : 'position';
        lastX = e.clientX;
        lastY = e.clientY;
        renderer.style.cursor = dragMode === 'pivot' ? 'crosshair' : 'move';
        });

        document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const graph = this.stateStore.nodeGraph;
        const singleNodeId = this._selectedIds.size === 1
            ? [...this._selectedIds][0] : null;

        let snapped = false;

        if (singleNodeId !== null) {
            const card = this._cards.get(singleNodeId);
            const baseSnapOn = card ? card._snapEnabled : false;
            const effectiveSnap = e.ctrlKey ? !baseSnapOn : baseSnapOn;

            if (effectiveSnap) {
                const candidate = this.sceneManager.findNearestSnapPoint(
                    e.clientX, e.clientY, dragMode, singleNodeId, 24
                );
                if (candidate) {
                    this.sceneManager.showSnapHighlight(candidate.world);
                    this._applySnapCandidate(singleNodeId, dragMode, candidate);
                    snapped = true;
                } else {
                    this.sceneManager.hideSnapHighlight();
                }
            } else {
                this.sceneManager.hideSnapHighlight();
            }
        }

        if (!snapped) {
            const scale = pixelToWorld();
            const dx =  (e.clientX - lastX) * scale;
            const dy = -(e.clientY - lastY) * scale;

            this._selectedIds.forEach(nodeId => {
                const node = graph.nodes.get(nodeId);
                if (!node || !node.transform) return;
                const fieldX = dragMode === 'pivot' ? 'pivotX' : 'posX';
                const fieldY = dragMode === 'pivot' ? 'pivotY' : 'posY';
                const newX = (node.transform[fieldX] || 0) + dx;
                const newY = (node.transform[fieldY] || 0) + dy;

                graph.updateNodeTransform(nodeId, fieldX, newX);
                graph.updateNodeTransform(nodeId, fieldY, newY);

                const card = this._cards.get(nodeId);
                if (card) {
                    card.updateTransformParam(fieldX, newX);
                    card.updateTransformParam(fieldY, newY);
                }
                const primEntry = this.sceneManager.activePrimitives.find(
                    p => p.instance.id === nodeId
                );
                if (primEntry) {
                    this.sceneManager._applyNodeTransformToMesh(nodeId, primEntry.object);
                }
                if (this._activeGizmoNodeId === nodeId) {
                    this.sceneManager.showPivotGizmo(nodeId);
                }
            });
        }

        lastX = e.clientX;
        lastY = e.clientY;

        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager.evaluator.invalidate();

        // Re-render regardless of prior compose history — see the
        // _onTransformChange/_onParamChange fix for why the old
        // currentSchur-gated version silently went stale in Marching
        // Squares mode; same fix applied here.
        clearTimeout(this._recomposeTimer);
        this._recomposeTimer = setTimeout(() => {
            const sdf = this.sceneManager.evaluator.getRootSDF();
            if (sdf) {
                this.sceneManager.renderSDF(sdf, this._getOutputParam('renderMethod'));
            }
        }, 150);
        });

        document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            dragMode = null;
            this.sceneManager.controls.enabled = true;
            this.sceneManager.hideSnapHighlight();
            renderer.style.cursor = '';
        }
        });
    }

    /**
     * Write a chosen snap candidate into the dragged node's transform.
     * See the class-level design comment on _attachViewportDrag for the
     * position vs. pivot write-back derivations.
     */
    _applySnapCandidate(nodeId, mode, candidate) {
        const graph = this.stateStore.nodeGraph;
        const node = graph.nodes.get(nodeId);
        if (!node || !node.transform) return;

        let newX, newY, newZ;

        if (mode === 'position') {
            newX = candidate.world.x;
            newY = candidate.world.y;
            newZ = candidate.world.z;
            graph.updateNodeTransform(nodeId, 'posX', newX);
            graph.updateNodeTransform(nodeId, 'posY', newY);
            graph.updateNodeTransform(nodeId, 'posZ', newZ);
        } else {
            if (candidate.isSelf && candidate.local) {
                // Self point: local coordinate IS the pivot value directly.
                newX = candidate.local.x;
                newY = candidate.local.y;
                newZ = candidate.local.z;
            } else {
                // Cross-shape point: pivot = targetWorld - position, from
                // pivotWorld = position + pivot (exact, rotation-invariant).
                newX = candidate.world.x - (node.transform.posX ?? 0);
                newY = candidate.world.y - (node.transform.posY ?? 0);
                newZ = candidate.world.z - (node.transform.posZ ?? 0);
            }
            graph.updateNodeTransform(nodeId, 'pivotX', newX);
            graph.updateNodeTransform(nodeId, 'pivotY', newY);
            graph.updateNodeTransform(nodeId, 'pivotZ', newZ);
        }

        const card = this._cards.get(nodeId);
        if (card) {
            const fields = mode === 'position'
                ? ['posX', 'posY', 'posZ']
                : ['pivotX', 'pivotY', 'pivotZ'];
            card.updateTransformParam(fields[0], newX);
            card.updateTransformParam(fields[1], newY);
            card.updateTransformParam(fields[2], newZ);
        }
        const primEntry = this.sceneManager.activePrimitives.find(p => p.instance.id === nodeId);
        if (primEntry) this.sceneManager._applyNodeTransformToMesh(nodeId, primEntry.object);
        if (this._activeGizmoNodeId === nodeId) this.sceneManager.showPivotGizmo(nodeId);
    }

    /**
     * Attach click-to-select picking on the 3D viewport.
     *
     * Listens on the mount CONTAINER (not renderer.domElement) — same
     * reasoning as OrbitControls' own attachment (see SceneManager
     * constructor comment): in GLSL/Ray March modes the GPU canvas sits on
     * top and the Three.js canvas has pointer-events:none, so listening on
     * the container is the only way this works consistently across all
     * three render modes.
     *
     * Distinguishes a genuine click from the start of an orbit-drag by
     * movement distance and elapsed time between mousedown and mouseup —
     * OrbitControls itself has no "click" event, so we track this
     * ourselves rather than fighting over the same mousedown.
     */
    _attachViewportPicking() {
        const container = this.sceneManager._mountEl;
        if (!container) return;

        const CLICK_MOVE_THRESHOLD_PX = 5;
        const CLICK_TIME_THRESHOLD_MS = 350;
        let downX, downY, downTime;

        container.addEventListener('mousedown', (e) => {
            // Alt+mousedown is reserved for shape-dragging (_attachViewportDrag)
            // and middle-mouse/Alt+left is reserved for canvas panning
            // elsewhere in this file — picking only engages on a plain click.
            if (e.altKey || e.button !== 0) { downX = undefined; return; }
            downX = e.clientX;
            downY = e.clientY;
            downTime = performance.now();
        });

        container.addEventListener('mouseup', (e) => {
            if (downX === undefined) return;
            const dx = e.clientX - downX;
            const dy = e.clientY - downY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const dt = performance.now() - downTime;
            downX = undefined;

            // Moved too far or held too long — this was an orbit-drag, not
            // a click. Let OrbitControls' own interpretation stand.
            if (dist > CLICK_MOVE_THRESHOLD_PX || dt > CLICK_TIME_THRESHOLD_MS) return;

            this._handleViewportClick(e);
        });
    }

    _handleViewportClick(e) {
        // Flood-select AND brush-paint modes both take priority over
        // normal selection — a click/dab while either is armed paints or
        // floods, it never selects a node. Brush mode needs this guard
        // too: a single click with near-zero movement (a quick "dab"
        // rather than a drag) still passes _attachViewportPicking's
        // click/time thresholds, so without this it would ALSO select
        // whatever node sits under the cursor.
        if (this._paintFloodMode || this._paintBrushMode) return;

        // Anchor-picking mode takes priority over normal selection — a
        // click while armed places the anchor, it never selects a node.
        if (this._anchorPickMode) {
            const { embedNodeId, hostNodeId } = this._anchorPickMode;
            const hit = this.sceneManager.pickSurfacePointOnNode(hostNodeId, e.clientX, e.clientY);
            this._anchorPickMode = null;
            this.sceneManager.clearHighlight(hostNodeId);

            if (!hit) {
                this._showToast('No surface found there — click directly on the glowing shape.', 3000);
                return;
            }

            const graph = this.stateStore.nodeGraph;
            this._undo.snapshot();
            graph.updateNodeParam(embedNodeId, 'anchorX', hit.x);
            graph.updateNodeParam(embedNodeId, 'anchorY', hit.y);
            graph.updateNodeParam(embedNodeId, 'anchorZ', hit.z);
            const embedNodeRef = graph.nodes.get(embedNodeId);
            if (embedNodeRef) embedNodeRef._anchorPicked = true;
            this.sceneManager._lastGLSLSource     = null;
            this.sceneManager._lastRayMarchSource = null;
            this.sceneManager.evaluator.invalidate();
            this._rebuildCards(); // refresh the card's anchor sliders
            this._renderInPlace();
            this.sceneManager.showEmbedRegion(embedNodeId);
            this._embedRegionVisibleFor = embedNodeId;
            this._showToast('Anchor placed. Click the button again to hide the marker.', 2500);
            return;
        }

        const nodeId = this.sceneManager.pickNodeAtScreenPosition(e.clientX, e.clientY);
        if (nodeId === null) {
            // Clicked empty space — deselect everything, matching the
            // existing Escape-key deselect behavior.
            this._setSelected(null);
            return;
        }
        this._setSelected(nodeId, e.shiftKey);

        // Bring the selected node's card into view if it's currently
        // scrolled/panned off-screen, so picking in the viewport always
        // has a visible graph-side result to look at.
        const card = this._cards.get(nodeId);
        if (card) {
            const cardX = card.node.uiPos?.x ?? 0;
            const cardY = card.node.uiPos?.y ?? 0;
            const screenX = cardX * this._transform.scale + this._transform.tx;
            const screenY = cardY * this._transform.scale + this._transform.ty;
            const areaW = this._bgCanvas.width;
            const areaH = this._bgCanvas.height;
            const offScreen = screenX < 0 || screenY < 0 || screenX > areaW || screenY > areaH;
            if (offScreen) {
                this._transform.tx += (areaW / 2) - screenX;
                this._transform.ty += (areaH / 2) - screenY;
                this._applyTransform();
                this._drawEdges();
            }
        }
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

        // Deliberately NOT nulling _lastGLSLSource/_lastRayMarchSource here.
        // SceneManager's own generate()-then-diff-against-last-compiled check
        // (`source !== this._lastRayMarchSource`) already recompiles only
        // when the generated GLSL TEXT actually differs. Many params here
        // are uniform-backed (embedNode's depth/edgeSoftness/seamSmoothness/
        // regionSize) — their new value is re-uploaded every render call
        // regardless of recompilation. Nulling defeated that check (null
        // never equals a string) and forced a full GPU recompile on every
        // slider tick — that was the compile-storm during ordinary drags.

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

       // Re-render after param change — same fix as _onTransformChange:
        // _renderInPlace() is mode-aware and does not depend on a previous
        // compose having already happened, unlike the old currentSchur-
        // gated block this replaces.
        clearTimeout(this._recomposeTimer);
        this._recomposeTimer = setTimeout(() => {
            this._renderInPlace();
        }, 300);
    }

    /**
     * Handle a transform slider change (posX/Y/Z, pivotX/Y/Z, rotateX/Y/Z,
     * scale) from a NodeCard's Transform section. Structurally parallel to
     * _onParamChange, but writes through updateNodeTransform and, for
     * geometry primitives, also updates the live Three.js preview mesh
     * directly (primitives no longer know their own placement — see
     * SceneManager._applyNodeTransformToMesh).
     */
    _onTransformChange(nodeId, field, value) {
        // Any transform change can affect the generated GLSL (every node's
        // wrapper is regenerated from its transform block), so always
        // invalidate shader caches, same as _onParamChange does for params.
        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;

        // If this node has a live Three.js preview mesh (i.e. it's a
        // geometry primitive currently in activePrimitives), keep its mesh
        // in sync immediately so Marching Squares mode reflects the change
        // without waiting for a full rebuild.
        const primEntry = this.sceneManager.activePrimitives.find(
            p => p.instance.id === nodeId
        );
        if (primEntry) {
            this.sceneManager._applyNodeTransformToMesh(nodeId, primEntry.object);
        }
        // Keep the gizmo's position live while dragging, IF it's currently
        // showing for this node. Singleton gizmo: SceneManager tracks at
        // most one active node internally, so just re-call showPivotGizmo —
        // it's a no-op-shaped refresh when nodeId isn't the currently shown
        // one, since showPivotGizmo(nodeId) always (re)targets whichever
        // node is passed to it.
        if (this._activeGizmoNodeId === nodeId) {
            this.sceneManager.showPivotGizmo(nodeId);
        }

        this.sceneManager.evaluator.invalidate();

        // Re-render regardless of render mode, and regardless of whether a
        // previous CPU compose has already happened this session.
        //
        // BUG FIX: the old version gated this behind
        // `if (this.sceneManager.currentSchur)`. currentSchur is only set
        // after the user has explicitly clicked Render (or touched an
        // Output-panel slider) at least once — switching TO Marching
        // Squares mode via the toolbar does NOT itself compose anything.
        // A graph only ever viewed in Ray March mode therefore had
        // currentSchur === null, so this block silently did nothing —
        // the SDF data was always correct (Ray March re-renders every
        // frame unconditionally and proves it), only the Marching Squares
        // VIEW was stale. _renderInPlace() is mode-aware and has no such
        // dependency on prior render history.
        clearTimeout(this._recomposeTimer);
        this._recomposeTimer = setTimeout(() => {
            this._renderInPlace();
        }, 150);
    }

    /**
     * Called when a NodeCard's Transform section is expanded or collapsed.
     * This — not card selection — is the actual trigger for the pivot
     * gizmo, since opening Transform is a real statement of intent to look
     * at/edit placement, while selecting a card's header (e.g. to drag it
     * around the graph canvas) is unrelated graph-editing behavior.
     */
    _onTransformSectionToggle(nodeId, isOpen) {
        if (isOpen) {
            this._activeGizmoNodeId = nodeId;
            this.sceneManager.showPivotGizmo(nodeId);
        } else if (this._activeGizmoNodeId === nodeId) {
            this._activeGizmoNodeId = null;
            this.sceneManager.hidePivotGizmo();
        }

        // embedNode also gets its anchor+region ring shown/hidden in step
        // with its own Transform section, so opening it to check placement
        // shows both the pivot AND the decoration boundary together.
        const node = this.stateStore.nodeGraph.nodes.get(nodeId);
        if (node?.type === 'embedNode') {
            if (isOpen) {
                this.sceneManager.showEmbedRegion(nodeId);
                this._embedRegionVisibleFor = nodeId;
            } else if (this._embedRegionVisibleFor === nodeId) {
                // Only hide if THIS node's ring is the one currently
                // showing — same singleton-safety fix already applied to
                // the pivot gizmo elsewhere in this file.
                this.sceneManager.hideEmbedRegion();
                this._embedRegionVisibleFor = null;
            }
        }
    }

    /**
     * Arm anchor-picking mode for an embedNode. The host shape glows so
     * the user is never confused about which geometry a click will
     * anchor to. The next viewport click (handled in _handleViewportClick)
     * consumes this mode and places the anchor there.
     */
    /**
     * Three-state toggle for embedNode's anchor UI:
     *   idle → armed (click a point) → placed (ring stays visible, click
     *   the button again to hide) → idle.
     * This is the answer to "how do I turn the anchor ring off": click the
     * same "🎯 Pick Anchor on Surface" button again once it's placed.
     */
    _armAnchorPicking(embedNodeId, hostNodeId) {
        // Currently mid-pick for this exact node — treat as cancel.
        if (this._anchorPickMode?.embedNodeId === embedNodeId) {
            this.sceneManager.clearHighlight(this._anchorPickMode.hostNodeId);
            this.sceneManager.hideEmbedRegion();
            this._anchorPickMode = null;
            this._embedRegionVisibleFor = null;
            this._showToast('Anchor picking cancelled.', 1500);
            return;
        }
        // Ring already showing for this node (a previous placement) and
        // we're not picking — treat this click as "hide it".
        if (!this._anchorPickMode && this._embedRegionVisibleFor === embedNodeId) {
            this.sceneManager.hideEmbedRegion();
            this._embedRegionVisibleFor = null;
            return;
        }
        if (hostNodeId == null) {
            this._showToast('Connect a shape to this node\'s host input first.', 3000);
            return;
        }
        this._anchorPickMode = { embedNodeId, hostNodeId };
        this.sceneManager.highlightNode(hostNodeId, 1e9);
        this.sceneManager.showEmbedRegion(embedNodeId);
        this._embedRegionVisibleFor = embedNodeId;
        this._showToast('Click a point on the glowing shape to place the decoration. Click the button again to cancel.', 6000);
    }

    /**
     * Arm/disarm brush-paint mode for a node — drag directly on that
     * node's own rendered surface in the viewport to paint a region.
     * Geodesic refinement (surfaceGraph.js) runs once when the drag ends;
     * see _attachPaintDrag.
     */
    _armPaintBrush(nodeId) {
        if (this._paintBrushMode === nodeId) {
            this.sceneManager.clearHighlight(nodeId);
            this.sceneManager.hidePaintPreview();
            this._paintBrushMode = null;
            this._showToast('Paint mode off.', 1200);
            return;
        }
        // Paint/Flood only make sense in Ray March — switch there
        // automatically instead of blocking with a toast. Mirrors the
        // mode-switch button's own sequence (_toggleRenderMode).
        if (this.sceneManager.renderMode !== 'rayMarch') {
            this._ensureOutputWired();
            this.sceneManager.setRenderMode('rayMarch');
            this.sceneManager.rayMarchRenderer?.show();
            this._renderModeBtn.textContent = '▣ Marching Squares';
            this.sceneManager._renderRayMarch();
        }
        // Only one of {anchor-pick, brush, flood} may be armed at a time.
        this._anchorPickMode = null;
        this._paintFloodMode = null;
        this._paintBrushMode = nodeId;
        this.sceneManager.highlightNode(nodeId, 1e9);
        this.sceneManager.showPaintPreview(nodeId);
        if (!this._paintDragAttached) { this._attachPaintDrag(); this._paintDragAttached = true; }
        this._showToast('Drag on the glowing shape to paint a region. Click the button again to stop.', 4500);

        // Force the empty→painted shader recompile to happen NOW, in
        // response to this deliberate click, instead of invisibly on the
        // user's first live mousemove mid-stroke. See _prewarmPaintShader.
        // Double rAF so the toast above actually gets a chance to paint
        // before the (possibly multi-second) blocking compile begins.
        requestAnimationFrame(() => requestAnimationFrame(() => this._prewarmPaintShader(nodeId)));
    }

    /**
     * Arm/disarm flood-select mode for a node — a SINGLE CLICK on the
     * surface floods outward from that point while curvature stays
     * similar (see surfaceGraph.curvatureFlood). Deliberately a different
     * gesture from brush painting, not another falloff option on it.
     */
    _armPaintFlood(nodeId) {
        if (this._paintFloodMode === nodeId) {
            this.sceneManager.clearHighlight(nodeId);
            this.sceneManager.hidePaintPreview();
            this._paintFloodMode = null;
            this._showToast('Flood select off.', 1200);
            return;
        }
       // Same auto-switch as _armPaintBrush — see that method's comment.
        if (this.sceneManager.renderMode !== 'rayMarch') {
            this._ensureOutputWired();
            this.sceneManager.setRenderMode('rayMarch');
            this.sceneManager.rayMarchRenderer?.show();
            this._renderModeBtn.textContent = '▣ Marching Squares';
            this.sceneManager._renderRayMarch();
        }
        this._anchorPickMode = null;
        this._paintBrushMode = null;
        this._paintFloodMode = nodeId;
        this.sceneManager.highlightNode(nodeId, 1e9);
        this.sceneManager.showPaintPreview(nodeId);
        if (!this._paintClickAttached) { this._attachPaintFloodClick(); this._paintClickAttached = true; }
        this._showToast('Click a point on the glowing shape to flood-select similar curvature. Click the button again to cancel.', 5000);

        // See _armPaintBrush's identical call for the full rationale.
        // Passing 'curvatureFlood' here (not the default) warms the
        // FLOOD-shaped branch of _maskFieldGLSL, which is structurally
        // different GLSL from the path/stroke branch paint uses — without
        // this, the arm-time prewarm would warm the wrong branch and the
        // user's first flood click would still eat one recompile.
        requestAnimationFrame(() => requestAnimationFrame(() => this._prewarmPaintShader(nodeId, 'curvatureFlood')));
    }

    /**
     * Force the ray-march shader to compile the "painted mask present"
     * code path ONCE, right now, rather than letting that transition
     * happen invisibly on the user's first live paint sample mid-drag.
     * Any node downstream of nodeId whose GLSL depends on
     * maskHasContent(node.mask) — embedNode's no-guest relief path being
     * the expensive one — emits genuinely different source text the
     * moment mask.samples goes from empty to non-empty. That's a real,
     * unavoidable recompile; this just relocates it to a moment where:
     *   - the main thread isn't needed for anything else (no mousemoves
     *     to drop), so nothing gets corrupted by it
     *   - the existing _onCompileStart/_onCompileEnd toast hooks get a
     *     real chance to paint before the block begins (see the double
     *     rAF at the call site)
     * The seed sample is removed immediately after, so the user's actual
     * stroke starts from a genuinely empty, correctly-rendered mask.
     */
    _prewarmPaintShader(nodeId, mode = 'euclidean') {
        if (this.sceneManager.renderMode !== 'rayMarch') return;
        const graph = this.stateStore.nodeGraph;
        const node = graph.nodes.get(nodeId);
        if (!node || maskHasContent(node.mask)) return; // nothing to warm, or already painted

        const dummySample = {
            x: 0, y: 0, z: 0,
            nx: 0, ny: 1, nz: 0,
            tx: 1, ty: 0, tz: 0,
            bx: 0, by: 0, bz: 1,
            w: 1,
        };

        // mode matters here, not just samples/enabled: _maskFieldGLSL
        // emits STRUCTURALLY DIFFERENT GLSL for 'curvatureFlood' (point-
        // cloud blend) vs. any other mode (swept-tube path) — warming the
        // wrong branch would leave the first real bake to eat its own
        // recompile anyway. See the two call sites for which mode to pass.
        graph.updateNodeMask(nodeId, 'mode', mode);
        graph.updateNodeMask(nodeId, 'samples', [dummySample]);
        graph.updateNodeMask(nodeId, 'enabled', true);
        this.sceneManager.evaluator.invalidate();
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager._renderRayMarch(); // blocking compile: passthrough → painted relief

        graph.updateNodeMask(nodeId, 'samples', []);
        graph.updateNodeMask(nodeId, 'enabled', false);
        graph.updateNodeMask(nodeId, 'mode', 'euclidean'); // back to createEmptyMask()'s default
        this.sceneManager.evaluator.invalidate();
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager._renderRayMarch(); // blocking compile: back to correct empty-mask visual
    }

    _clearPaintMask(nodeId) {
        this._undo.snapshot();
        const graph = this.stateStore.nodeGraph;
        graph.updateNodeMask(nodeId, 'samples', []);
        graph.updateNodeMask(nodeId, 'strokeBreaks', []);
        graph.updateNodeMask(nodeId, 'enabled', false);
        this.sceneManager.evaluator.invalidate();
        this._rebuildCards();
        this._renderInPlace();
    }

    _onMaskParamChange(nodeId, field, value) {
        this.stateStore.nodeGraph.updateNodeMask(nodeId, field, value);
        // See _onParamChange's comment — falloffRadius/normalThreshold are
        // both uniform-backed (maskRadius/maskNThresh); curvatureThreshold
        // isn't read by the shader at all (bake-time only). None of these
        // need a forced recompile.
        this.sceneManager.evaluator.invalidate();
        clearTimeout(this._recomposeTimer);
        this._recomposeTimer = setTimeout(() => this._renderInPlace(), 150);
    }

    _attachPaintDrag() {
        const container = this.sceneManager._mountEl;
        if (!container) return;
        let isPainting = false;

        const liveSample = (clientX, clientY) => {
            if (!this._paintBrushMode) return;
            const nodeId = this._paintBrushMode;
            const sample = this.sceneManager.paintSampleAtScreenPosition(nodeId, clientX, clientY);
            if (!sample) return;
            this._paintStrokeBuffer.push(sample);

            // Live preview shows PRIOR committed strokes plus this
            // stroke's raw (not yet smoothed/baked) points, so the user
            // sees everything painted so far while still dragging — not
            // just the current stroke. A matching strokeBreaks entry is
            // included so the LIVE preview itself doesn't draw a stray
            // connecting line between the previous stroke and this one;
            // the actual bake at mouseup recomputes this correctly
            // regardless.
            const graph = this.stateStore.nodeGraph;
            const liveSamples = [...this._priorCommittedSamples, ...this._paintStrokeBuffer];
            const liveBreaks = this._priorCommittedSamples.length > 0
              ? [...this._priorStrokeBreaks, this._priorCommittedSamples.length]
              : [...this._priorStrokeBreaks];
            graph.updateNodeMask(nodeId, 'mode', 'euclidean');
            graph.updateNodeMask(nodeId, 'samples', liveSamples);
            graph.updateNodeMask(nodeId, 'strokeBreaks', liveBreaks);
            graph.updateNodeMask(nodeId, 'enabled', true);

            // Mask sample DATA is a GLSL uniform ARRAY, not baked into
            // shader source text — a new stroke sample does not need a
            // recompile on every mousemove.
            this.sceneManager.evaluator.invalidate();
            this.sceneManager.showPaintPreview(nodeId);

            clearTimeout(this._recomposeTimer);
            this._recomposeTimer = setTimeout(() => this._renderInPlace(), 90);
        };

        container.addEventListener('mousedown', (e) => {
            if (!this._paintBrushMode || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            this.sceneManager.controls.enabled = false;
            this._undo.snapshot();

            const node = this.stateStore.nodeGraph.nodes.get(this._paintBrushMode);
            const existingMode = node?.mask?.mode;
            // Snapshot whatever was already COMMITTED (finished, baked
            // strokes from earlier in this session) BEFORE the live
            // preview above starts overwriting mask.samples with THIS
            // stroke's raw points. This is the actual fix for strokes
            // wiping each other: once a stroke bakes, mode becomes
            // 'geodesic' — never 'euclidean' — so a check that only
            // continued appending while mode==='euclidean' always failed
            // starting with the SECOND stroke, silently discarding the
            // first.
            this._priorCommittedSamples = (existingMode === 'geodesic' && Array.isArray(node?.mask?.samples))
              ? [...node.mask.samples]
              : [];
            this._priorStrokeBreaks = (existingMode === 'geodesic' && Array.isArray(node?.mask?.strokeBreaks))
              ? [...node.mask.strokeBreaks]
              : [];
            this._paintStrokeBuffer = [];

            isPainting = true;
            liveSample(e.clientX, e.clientY);
        });

        document.addEventListener('mousemove', (e) => {
            if (!isPainting) return;
            liveSample(e.clientX, e.clientY);
        });

        document.addEventListener('mouseup', () => {
            if (!isPainting) return;
            isPainting = false;
            this.sceneManager.controls.enabled = true;

            const nodeId = this._paintBrushMode;
            clearTimeout(this._recomposeTimer);
            if (nodeId != null && this._paintStrokeBuffer?.length > 0) {
                const ok = this.sceneManager.bakeGeodesicMaskForNode(
                    nodeId,
                    this._paintStrokeBuffer,
                    this._priorCommittedSamples,
                    this._priorStrokeBreaks
                );
                if (!ok) {
                    this._showToast('Could not refine the painted region — keeping the quick preview instead.', 3000);
                }
                this.sceneManager.evaluator.invalidate();
                this._rebuildCards();
            }
            this._renderInPlace();
        });
    }

    /** Single-click flood-select capture. */
    _attachPaintFloodClick() {
        const container = this.sceneManager._mountEl;
        if (!container) return;

        container.addEventListener('mouseup', (e) => {
            if (!this._paintFloodMode || e.button !== 0) return;
            const nodeId = this._paintFloodMode;

            this._undo.snapshot();
            const ok = this.sceneManager.bakeCurvatureFloodMaskForNode(nodeId, e.clientX, e.clientY);
            if (!ok) {
                this._showToast('No surface found there — click directly on the glowing shape.', 3000);
                return;
            }

            // Silently shrink any downstream embed's guest ONLY if it's
            // genuinely oversized for the just-flooded region — see
            // _autoFitOversizedEmbedGuests's header for the exact
            // conditions. Folded into the same undo snapshot as the
            // flood itself, so one Ctrl+Z undoes both together.
            this._autoFitOversizedEmbedGuests(nodeId);

            // Deliberately NOT force-nulling _lastGLSLSource/
            // _lastRayMarchSource here — same reasoning as _onParamChange's
            // identical comment. Mask sample DATA is uniform-driven (see
            // GLSLEvaluator's _uniformFloat bounding-sphere fix), so
            // re-flooding an ALREADY-flooded node changes only uniform
            // values, not generated source text — generate()'s own diff
            // check correctly skips recompiling in that case. Forcing a
            // null here defeated that check and cost one full ANGLE
            // recompile per flood click for no reason.
            this.sceneManager.evaluator.invalidate();
            this._rebuildCards();
            this.sceneManager.showPaintPreview(nodeId);
            this._renderInPlace();
            this._showToast('Region flood-selected by curvature similarity. Click "Flood Select" again to select a different area.', 3000);
        });
    }

    /**
     * Auto-Fit: samples both of a morphBlend node's source shapes'
     * approximate radius, scales each (relative to its current scale, not
     * overwriting deliberate choices) so both read as roughly the same
     * size, and aligns their positions to a shared centroid — the two
     * most common causes of a broken-looking morph (one shape swallowing
     * the other, or a shape barely visible at t=0.5).
     */
    _autoFitMorph(morphNodeId) {
        const graph = this.stateStore.nodeGraph;
        const edgeA = graph.getIncomingEdge(morphNodeId, 'sdfA');
        const edgeB = graph.getIncomingEdge(morphNodeId, 'sdfB');
        if (!edgeA || !edgeB) {
            this._showToast('Connect two shapes to this node\'s sdfA and sdfB inputs first.', 3000);
            return;
        }
        const nodeAId = edgeA.fromNode, nodeBId = edgeB.fromNode;
        const nodeA = graph.nodes.get(nodeAId), nodeB = graph.nodes.get(nodeBId);
        if (!nodeA || !nodeB) return;

        const radiusA = this.sceneManager.estimateNodeRadius(nodeAId);
        const radiusB = this.sceneManager.estimateNodeRadius(nodeBId);
        if (!isFinite(radiusA) || !isFinite(radiusB) || radiusA <= 0 || radiusB <= 0) {
            this._showToast('Could not measure one of the shapes — try again after adjusting it.', 3000);
            return;
        }

        this._undo.snapshot();

        const target    = (radiusA + radiusB) / 2;
        const curScaleA = nodeA.transform?.scale ?? 1;
        const curScaleB = nodeB.transform?.scale ?? 1;
        graph.updateNodeTransform(nodeAId, 'scale', curScaleA * (target / radiusA));
        graph.updateNodeTransform(nodeBId, 'scale', curScaleB * (target / radiusB));

        const cx = ((nodeA.transform?.posX ?? 0) + (nodeB.transform?.posX ?? 0)) / 2;
        const cy = ((nodeA.transform?.posY ?? 0) + (nodeB.transform?.posY ?? 0)) / 2;
        const cz = ((nodeA.transform?.posZ ?? 0) + (nodeB.transform?.posZ ?? 0)) / 2;
        [nodeAId, nodeBId].forEach(id => {
            graph.updateNodeTransform(id, 'posX', cx);
            graph.updateNodeTransform(id, 'posY', cy);
            graph.updateNodeTransform(id, 'posZ', cz);
        });

        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager.evaluator.invalidate();
        this._rebuildCards();
        this._renderInPlace();
        this._showToast('Auto-fit applied — both shapes scaled and centered to match.', 2500);
    }

    /**
     * Automatically shrink an embedNode's guest ONLY when it's genuinely
     * too large for a freshly curvature-flooded region — e.g. a Torus
     * left at its default radius 2 dropped into a region sized 0.3. BOTH
     * of the following must hold for this to do anything at all:
     *   1. The host's mask mode is 'curvatureFlood' — paint-mode and
     *      unpainted hosts are never touched.
     *   2. The guest's current radius exceeds the region's target radius
     *      by more than 15% — a guest that's already roughly the right
     *      size (including one the user already resized by hand) is left
     *      completely alone.
     * Never GROWS a guest — that stays the user's own call via the
     * regionSize slider, which already scales the flooded footprint.
     */
    _autoFitOversizedEmbedGuests(hostNodeId) {
        const graph = this.stateStore.nodeGraph;
        const hostNode = graph.nodes.get(hostNodeId);
        if (!hostNode || hostNode.mask?.mode !== 'curvatureFlood') return;

        graph.nodes.forEach((embedNode, embedNodeId) => {
            if (embedNode.type !== 'embedNode') return;
            const hostEdge = graph.getIncomingEdge(embedNodeId, 'hostSdf');
            if (!hostEdge || hostEdge.fromNode !== hostNodeId) return;
            const guestEdge = graph.getIncomingEdge(embedNodeId, 'guestSdf');
            if (!guestEdge) return;
            const guestNodeId = guestEdge.fromNode;
            const guestNode = graph.nodes.get(guestNodeId);
            if (!guestNode) return;

            const mask = hostNode.mask;
            const samples = mask.samples;
            if (!samples || samples.length === 0) return;
            let mcx = 0, mcy = 0, mcz = 0;
            samples.forEach(s => { mcx += s.x; mcy += s.y; mcz += s.z; });
            const sN = samples.length;
            mcx /= sN; mcy /= sN; mcz /= sN;
            let maxDist = 0;
            samples.forEach(s => {
                const d = Math.hypot(s.x - mcx, s.y - mcy, s.z - mcz);
                if (d > maxDist) maxDist = d;
            });
            const domePad = computeMaskDomeRadius(samples, mask.falloffRadius);
            const hostScale = Math.abs(hostNode.transform?.scale ?? 1);
            const footprintRadius = (maxDist + domePad) * (hostScale > 1e-6 ? hostScale : 1);
            const userScale = Math.max(embedNode.params.regionSize ?? 1.0, 0.05);
            const regionSize = Math.max(footprintRadius * userScale, 1e-4);
            const depth = embedNode.params.depth ?? 0.35;
            const targetRadius = Math.min(depth, regionSize) * 0.9;

            const currentRadius = this.sceneManager.estimateNodeRadius(guestNodeId);
            if (!isFinite(currentRadius) || currentRadius <= 1e-6) return;

            const OVERSIZE_THRESHOLD = 1.15;
            if (currentRadius <= targetRadius * OVERSIZE_THRESHOLD) return;

            const curScale = guestNode.transform?.scale ?? 1;
            const newScale = curScale * (targetRadius / currentRadius);
            graph.updateNodeTransform(guestNodeId, 'scale', newScale);
            graph.updateNodeTransform(guestNodeId, 'posX', 0);
            graph.updateNodeTransform(guestNodeId, 'posY', 0);
            graph.updateNodeTransform(guestNodeId, 'posZ', 0);

            const isFiniteArray = guestNode.type === 'repeatNode' ||
                (guestNode.type === 'tilingNode' && guestNode.params.extent === 'finite');
            if (isFiniteArray) {
                const cx = guestNode.params.countX ?? 1;
                const cy = guestNode.params.countY ?? 1;
                const spanX = (cx - 1) * (guestNode.params.spacingX ?? 1);
                const spanY = (cy - 1) * (guestNode.params.spacingY ?? 1);
                const maxSpan = Math.max(spanX, spanY, 1e-6);
                const targetSpan = regionSize * 1.6;
                const spacingScale = Math.min(1, targetSpan / maxSpan);
                graph.updateNodeParam(guestNodeId, 'spacingX', (guestNode.params.spacingX ?? 1) * spacingScale);
                graph.updateNodeParam(guestNodeId, 'spacingY', (guestNode.params.spacingY ?? 1) * spacingScale);
            }

            const card = this._cards.get(guestNodeId);
            if (card) {
                card.updateTransformParam('scale', newScale);
                card.updateTransformParam('posX', 0);
                card.updateTransformParam('posY', 0);
                card.updateTransformParam('posZ', 0);
            }
        });
    }

    /**
     * Auto-Fit Guest to Region: removes the manual "wrestle the guest's
     * Transform into place" step for embedNode. Resets the guest's own
     * position to (0,0,0) (its coordinates are already relative to the
     * anchor's local frame, so a non-zero position there just means an
     * unwanted extra offset), scales it to comfortably fit within depth
     * (usually the tighter of the two constraints for a shallow relief),
     * and — if the guest is a Repeat node or a finite-extent Tiling node —
     * shrinks its SPACING (never its count, which is a deliberate user
     * choice) so the whole array's footprint fits within regionSize.
     *
     * Deliberately NOT solving "how many copies there should be" — that
     * would mean overriding a choice the user made intentionally. This
     * fits the choice they made into the space available.
     */
    _autoFitEmbedGuest(embedNodeId) {
        const graph = this.stateStore.nodeGraph;
        const guestEdge = graph.getIncomingEdge(embedNodeId, 'guestSdf');
        if (!guestEdge) {
            this._showToast('Connect a shape to this node\'s guest input first.', 3000);
            return;
        }
        const guestNodeId = guestEdge.fromNode;
        const guestNode   = graph.nodes.get(guestNodeId);
        const embedNode   = graph.nodes.get(embedNodeId);
        if (!guestNode || !embedNode) return;

        // When maskSource='paintedRegion', the disc's regionSize param is
        // largely vestigial (see NodeEvaluator's embedNode case) — the
        // painted region's own falloffRadius is the actual footprint the
        // guest needs to fit within, so Auto-Fit reads THAT instead when
        // painting is active.
        const hostEdge = graph.getIncomingEdge(embedNodeId, 'hostSdf');
        const hostNode = hostEdge ? graph.nodes.get(hostEdge.fromNode) : null;
        const usingPaintedRegion = maskHasContent(hostNode?.mask);
        let regionSize;
        if (usingPaintedRegion) {
          // Mirrors NodeEvaluator/GLSLEvaluator's own confinement-radius
          // math exactly — this was previously just the BRUSH radius
          // (falloffRadius), not the true painted FOOTPRINT the embed is
          // actually confined to, so Auto-Fit could size the guest
          // against a smaller number than what was really painted.
          const samples = hostNode.mask.samples;
          let mcx = 0, mcy = 0, mcz = 0;
          samples.forEach(s => { mcx += s.x; mcy += s.y; mcz += s.z; });
          const sN = samples.length || 1;
          mcx /= sN; mcy /= sN; mcz /= sN;
          let maxDist = 0;
          samples.forEach(s => {
            const d = Math.hypot(s.x - mcx, s.y - mcy, s.z - mcz);
            if (d > maxDist) maxDist = d;
          });
          const domePad = computeMaskDomeRadius(samples, hostNode.mask.falloffRadius);
          const hostScale = Math.abs(hostNode.transform?.scale ?? 1);
          const footprintRadius = (maxDist + domePad) * (hostScale > 1e-6 ? hostScale : 1);
          const userScale = hostNode.mask.mode === 'curvatureFlood'
            ? Math.max(embedNode.params.regionSize ?? 1.0, 0.05) : 1;
          regionSize = Math.max(footprintRadius * userScale, 1e-4);
        } else {
          regionSize = embedNode.params.regionSize ?? 1.0;
        }
        const depth = embedNode.params.depth ?? 0.35;

        this._undo.snapshot();

        // Guest coordinates are already relative to the anchor's local
        // frame — its own Transform position should stay at the origin,
        // otherwise it's offset from where you placed the anchor.
        graph.updateNodeTransform(guestNodeId, 'posX', 0);
        graph.updateNodeTransform(guestNodeId, 'posY', 0);
        graph.updateNodeTransform(guestNodeId, 'posZ', 0);

        // Repeat / finite Tiling: shrink SPACING (preserving the user's
        // chosen count) so the whole array's tangential footprint fits
        // comfortably inside regionSize.
        const isFiniteArray =
            guestNode.type === 'repeatNode' ||
            (guestNode.type === 'tilingNode' && guestNode.params.extent === 'finite');
        if (isFiniteArray) {
            const cx = guestNode.params.countX ?? 1;
            const cy = guestNode.params.countY ?? 1;
            const spanX = (cx - 1) * (guestNode.params.spacingX ?? 1);
            const spanY = (cy - 1) * (guestNode.params.spacingY ?? 1);
            const maxSpan = Math.max(spanX, spanY, 1e-6);
            const targetSpan = regionSize * 1.6; // comfortably within the tangential disc
            const spacingScale = Math.min(1, targetSpan / maxSpan);
            graph.updateNodeParam(guestNodeId, 'spacingX', (guestNode.params.spacingX ?? 1) * spacingScale);
            graph.updateNodeParam(guestNodeId, 'spacingY', (guestNode.params.spacingY ?? 1) * spacingScale);
        }

        // Scale the guest's own natural size to fit within the tighter of
        // depth/regionSize — depth is usually the binding constraint for
        // a shallow emboss/engrave relief.
        const naturalRadius = this.sceneManager.estimateNodeRadius(guestNodeId);
        if (isFinite(naturalRadius) && naturalRadius > 1e-6) {
            const curScale = guestNode.transform?.scale ?? 1;
            const targetRadius = Math.min(depth, regionSize) * 0.9;
            graph.updateNodeTransform(guestNodeId, 'scale', curScale * (targetRadius / naturalRadius));
        }

        this.sceneManager._lastGLSLSource     = null;
        this.sceneManager._lastRayMarchSource = null;
        this.sceneManager.evaluator.invalidate();
        this._rebuildCards();
        this._renderInPlace();
        this._showToast('Guest auto-fitted to the region. Check the result and fine-tune if needed.', 3000);
    }

    /**
     * 'P' keyboard shortcut — toggle the pivot gizmo for the currently
     * selected node, independent of the Transform section's open state.
     * Tracks its own on/off flag (_pivotGizmoManuallyShown) since the
     * gizmo's visibility is otherwise driven by _onTransformSectionToggle,
     * not a simple boolean — this shortcut needs to know whether IT was
     * the one that turned the gizmo on, so a second press turns it off
     * again rather than fighting with the Transform-section-driven state.
     */
    _togglePivotGizmoShortcut() {
        if (this._selectedIds.size === 0) {
            this._showToast('Select a node first to toggle its pivot gizmo (P)', 2000);
            return;
        }
        const nodeId = [...this._selectedIds].pop();

        if (this._activeGizmoNodeId === nodeId) {
            this._activeGizmoNodeId = null;
            this.sceneManager.hidePivotGizmo();
        } else {
            this._activeGizmoNodeId = nodeId;
            this.sceneManager.showPivotGizmo(nodeId);
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

        // 0b. Hide the pivot gizmo and forget which node had it open — that
        // node no longer exists after the clear.
        this.sceneManager.hidePivotGizmo();
        this._activeGizmoNodeId = null;

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
        schurBlend: { operation:'union', smoothness:8, rotation:0, scale:1, posX:0, posY:0, isoOffset:0 },
        rBlend:     { operation:'union', smoothness:8 },
        morphBlend: { t: 0.5, animated: 'no' },
        embedNode:  { operation: 'emboss', anchorX:0, anchorY:0, anchorZ:0, regionSize:1.5 },
      }[type] || {};

      const newNode = graph.addNode(type, params, this._nextCardPosition());
      // Session-only flag (deliberately NOT a NodeSpec param — it's a UI
      // nicety, not scene state, so it does not get serialized/persisted;
      // it simply resets to "unconfirmed" on reload, which is a safe
      // default). Tracks whether the anchor has ever been explicitly
      // placed via Pick Anchor, so the card can keep nudging the user
      // toward it rather than silently trusting the origin default.
      if (type === 'embedNode') {
        newNode._anchorPicked = false;
        this._showToast(
          'New Emboss/Engrave node — click "Pick Anchor on Surface" before adjusting other settings. ' +
          'The default anchor sits at the host\'s ORIGIN, which is often its exact center — unstable ' +
          'on symmetric shapes (sphere, cylinder, capsule).',
          6000
        );
      }

      setTimeout(() => {
        this._rebuildCards();
        this._drawEdges();
        this._updateGraphStatusLabel();
      }, 50);
    }

    /**
     * Add a mapper node WITHOUT auto-wiring. Mappers attach to a shape's
     * 'mapper' input port, not the 'sdf' chain — there's no equivalent
     * "chain tail" concept for this port, so (like blend nodes) the user
     * drag-connects it manually.
     */
    _addMapperNode(type) {
      this._undo.snapshot();
      const graph = this.stateStore.nodeGraph;
      const defaults = {
        polynomialMapper:  { c0:0, c1:1, c2:0, c3:0 },
        sinusoidalMapper:  { a:1, b:4, c:0, e:0, animated:'no' },
        exponentialMapper: { a:1, b:1, c:0 },
        logarithmicMapper: { a:1, b:1, c:1, e:0 },
        powerMapper:       { a:1, b:2, c:0 },
      };
      graph.addNode(type, defaults[type] || {}, this._nextCardPosition());
      setTimeout(() => {
        this._rebuildCards();
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
      tiling:        { type: 'tilingNode',        params: { lattice:'hexagonal', periodX:3, periodY:3, periodZ:3, offsetX:0, offsetY:0, isoOffset:0, extent:'infinite', countX:3, countY:3, countZ:1 } },
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

    const newNode = graph.addNode(def.type, def.params, this._nextCardPosition());

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
      'schurBlend','rBlend','morphBlend','embedNode',
      'rUnion','rIntersection','rDifference','ifsBlend'
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
      this._rebuildCards();
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
        placementSection.className = 'nc-advanced-only';
        placementSection.style.cssText = `
            width: 100%;
            margin-top: 12px;
        `;

        // Warning banner — shown only while any placement value is
        // non-identity, since that's exactly when the wireframe/render
        // mismatch described above becomes real.
        const _isNonIdentity = () => ['posX','posY','posZ','rotateX','rotateY','rotateZ']
            .some(k => Math.abs(this._getOutputParam(k) || 0) > 1e-6);
        const placementWarning = document.createElement('div');
        placementWarning.style.cssText = `
            font-size: 10px;
            color: rgba(255,190,120,0.9);
            background: rgba(255,150,60,0.1);
            border: 1px solid rgba(255,150,60,0.3);
            border-radius: 4px;
            padding: 5px 7px;
            margin-bottom: 8px;
            line-height: 1.4;
            display: ${_isNonIdentity() ? 'block' : 'none'};
        `;
        placementWarning.textContent = '⚠ Active — node previews will look different from the actual render/export until this is reset.';
        placementSection._syncWarning = () => {
            placementWarning.style.display = _isNonIdentity() ? 'block' : 'none';
        };
        placementSection.appendChild(placementWarning);

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
                if (placementSection._syncWarning) placementSection._syncWarning();
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
        // Debounce preview renders — each card schedules a delayed render
        // rather than firing immediately on every graph change event.
        if (!this._previewTimers) this._previewTimers = new Map();
        clearTimeout(this._previewTimers.get(nodeId));
        this._previewTimers.set(nodeId, setTimeout(() => {
            import('./previewRenderer.js').then(({ drawSDFPreview }) => {
            try {
                const evaluator = this.sceneManager.evaluator;
                evaluator.invalidate();
                const result = evaluator.evaluate(nodeId);
                const sdfFn  = result?.sdf || result?.result;
                if (typeof sdfFn !== 'function') return;
                // Center the preview window on this node's current
                // transform position, not a fixed world-space window.
                // evaluate()'s result now always reflects the node's own
                // transform (universal wrap — NodeEvaluator._applyNodeTransform),
                // so a fixed window would show a blank thumbnail as soon as
                // the shape moves away from world origin via drag or slider.
                const node = this.stateStore.nodeGraph.nodes.get(nodeId);
                const cx = node?.transform?.posX ?? 0;
                const cy = node?.transform?.posY ?? 0;
                const HALF = 2.5;
                drawSDFPreview(previewCanvas, sdfFn, [cx - HALF, cy - HALF, cx + HALF, cy + HALF]);
            } catch (e) {
                // Silently ignore
            }
            });
        }, 120));
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
        // High-frequency during a paint drag (fired on every mousemove via
        // updateNodeMask). The paint-drag code already manages its own
        // preview redraw and debounced re-render directly, so skip the
        // otherwise-needless edge-redraw/status-label/dropdown work below
        // for this event specifically.
        if (event === 'maskChanged') return;

        // Same reasoning, for a PRE-EXISTING and much higher-frequency
        // case: transformChanged fires on every mousemove of ANY position/
        // rotation/scale drag (slider or viewport Alt-drag). _drawEdges()
        // redraws bezier connections between PORT positions, which are
        // driven by node.uiPos (where the card sits on the 2D graph
        // canvas) — entirely unrelated to node.transform (where the shape
        // sits in 3D). A transform-only change can never move a card's
        // on-screen port position, so redrawing edges, refreshing the
        // status label, and re-walking the whole graph in
        // _updateDropdownAvailability() on every single mousemove of a
        // transform drag was pure waste even before painting existed.
        if (event === 'transformChanged') return;

        if (event === 'nodeAdded' || event === 'nodeRemoved' ||
            event === 'edgeAdded' || event === 'edgeRemoved') {
        this._rebuildCards();

        // Dismiss onboarding overlay permanently once any user node exists
        if (this._onboardingOverlay) {
            const graph = this.stateStore.nodeGraph;
            let hasUserNode = false;
            graph.nodes.forEach(n => {
                if (n.type !== 'outputNode') hasUserNode = true;
            });
            if (hasUserNode) {
                this._onboardingOverlay.style.opacity = '0';
                setTimeout(() => {
                    if (this._onboardingOverlay?.parentNode) {
                        this._onboardingOverlay.parentNode
                            .removeChild(this._onboardingOverlay);
                        this._onboardingOverlay = null;
                    }
                }, 700);
            }
        }
        }
        this._drawEdges();
        this._updateGraphStatusLabel();
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
        const outNode = this.sceneManager._ensureOutputNode();

        if (this._pendingOutputParams) {
            Object.entries(this._pendingOutputParams).forEach(([k, v]) => {
                graph.updateNodeParam(outNode.id, k, v);
            });
        }

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
            'schurBlend', 'rBlend', 'morphBlend', 'embedNode',
            'rUnion', 'rIntersection', 'rDifference',
        ]);
        const outPortOf = (type) => {
            if (GEOM_TYPES.has(type))      return 'sdf';
            if (TRANSFORM_TYPES.has(type)) return 'result';
            if (BLEND_TYPES.has(type))     return 'result';
            return null;
        };

        // ── BUGFIX: prune STALE auto-wired direct-to-output edges ────────
        // A node auto-wired straight to Output because it was once a
        // dangling tail (e.g. a bare sphere rendered before anything was
        // wired to it) can LATER gain a real downstream consumer — e.g.
        // wiring that same sphere into a blend node's sdfA. Left in place,
        // the stale edge silently unions the original primitive back into
        // the final scene alongside whatever now actually consumes it:
        // sphereA, sphereB, AND (sphereA−sphereB) unioned together render
        // identically to sphereA∪sphereB (the difference is a strict
        // subset of A) — i.e. "both input spheres still fully visible"
        // after wiring an R-Blend(difference) between them.
        //
        // Only edges THIS function created (tagged autoWired=true below)
        // are ever removed here — a deliberate edge the user drag-
        // connected directly to Output is never touched, even if its
        // source also fans out elsewhere. autoWired does NOT survive
        // serialize()/deserialize() (NodeGraph.serialize whitelists
        // fields) — an auto-wire edge that predates a save/reload is
        // treated as permanent afterward, which is the safe direction
        // to err in.
        const currentIncoming = graph.getAllIncomingEdges(outNode.id, 'sdf') || [];
        currentIncoming.forEach(edge => {
            if (!edge.autoWired) return;
            const srcNode = graph.nodes.get(edge.fromNode);
            if (!srcNode) return;
            const srcPort = outPortOf(srcNode.type);
            if (!srcPort) return;
            const srcOutgoing = graph.getOutgoingEdges(edge.fromNode, srcPort) || [];
            const hasNonOutputConsumer = srcOutgoing.some(e => e.toNode !== outNode.id);
            if (hasNonOutputConsumer) {
                try { graph.removeEdge(edge.id); } catch(_) {}
            }
        });

        graph.nodes.forEach((node, id) => {
            if (node.type === 'outputNode') return;
            const outPort = outPortOf(node.type);
            if (!outPort) return;

            const outgoing = graph.getOutgoingEdges(id, outPort) || [];
            if (outgoing.length > 0) return;

            const alreadyToOutput = (graph.getAllIncomingEdges(outNode.id, 'sdf') || [])
                .some(e => e.fromNode === id);
            if (alreadyToOutput) return;

            try {
                const newEdge = graph.addEdge(id, outPort, outNode.id, 'sdf');
                if (newEdge) newEdge.autoWired = true;
            } catch(_) {
                // Edge already exists or graph validation rejected it — safe to ignore
            }
        });

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
            if (this._anchorPickMode) {
                this.sceneManager.clearHighlight(this._anchorPickMode.hostNodeId);
                this.sceneManager.hideEmbedRegion();
                this._anchorPickMode = null;
                this._embedRegionVisibleFor = null;
                this._showToast('Anchor picking cancelled.', 1500);
            } else if (this._presentationMode) {
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

        // Home key — reveal all cards (bring off-screen cards back into view).
        // Only active when not in presentation mode so it does not conflict
        // with camera-reset behaviour that some users may expect from Home.
        if (e.key === 'Home' && !this._presentationMode) {
            e.preventDefault();
            this._revealAllCards();
        }

        // 'P' key: toggle the pivot gizmo for the currently selected node,
        // independent of whether that card's Transform section is open.
        // A quick "just let me see the pivot" shortcut. If multiple nodes
        // are selected, uses the most recently selected one (same
        // convention _addTransformNode already uses elsewhere in this file).
        if ((e.key === 'p' || e.key === 'P') && this._open) {
            e.preventDefault();
            this._togglePivotGizmoShortcut();
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
        if (this.sceneManager.isOrbitActive()) {
            this.sceneManager.stopOrbit();
            this._showToast('Auto-orbit OFF', 1500);
            return;
        }
        const generatorKey = this._orbitGenerator || 'circular';
        this.sceneManager.startOrbit(generatorKey, { speed: this._autoOrbitSpeed });
        this._showToast(
            `Auto-orbit ON — ${generatorKey} (speed ${this._autoOrbitSpeed.toFixed(2)}) — press R to stop`,
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
                        nodeDef.id,
                        nodeDef.transform ? { ...nodeDef.transform } : null
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

        // Ensure the output node exists and is wired BEFORE deciding what's
        // exportable. Without this, GLSL export stayed unavailable until
        // the user separately clicked Render or the mode-switch button at
        // least once — pure friction, since _ensureOutputWired() is cheap
        // and idempotent (safe to call repeatedly; it no-ops on an already-
        // wired graph). STL export never had this problem since
        // _sceneHas3D() checks node types directly rather than requiring
        // output-node wiring — this brings GLSL export to the same
        // immediately-available standard.
        if (this._sceneHasGeometry()) {
            this._ensureOutputWired();
        }

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

        // ── GLSL shader export ─────────────────────────────────────────────────
        // Core workflow, NOT gated behind Advanced — export was one of the
        // most well-received features from v1 and belongs in the always-
        // visible core workflow, same tier as PNG/JSON/STL export below.
        //
        // Deliberately INDEPENDENT of the current render mode (this part IS
        // kept from the earlier fix — it's a correctness improvement, not a
        // tiering decision). Generation is done fresh on demand via
        // glslEvaluator.generate(time, mode) — the same mode-agnostic entry
        // point the live renderers use — rather than reading a cached
        // string that only got populated as a side effect of having
        // previously rendered in that specific mode. The user can export
        // either shader variant regardless of what's currently on screen;
        // the only real requirement is that the graph is wired to
        // something at all.
        const graphRenderable = this.sceneManager._graphIsRenderable();
        panel.appendChild(_row(
            '🔷', 'Export 2D GLSL Shader',
            graphRenderable
                ? 'Download a 2D fragment shader (contour/fill rendering), adapted for ShaderToy. ' +
                  'Go to shadertoy.com → New Shader → paste the file → click ▶. No edits needed.'
                : 'Wire your graph to Output first to unlock shader export.',
            () => this._exportGLSL('2d'),
            graphRenderable
        ));

        panel.appendChild(_row(
            '🔶', 'Export 3D Ray March Shader',
            graphRenderable
                ? 'Download a 3D ray-marching fragment shader, adapted for ShaderToy. ' +
                  'Go to shadertoy.com → New Shader → paste the file → click ▶. No edits needed.'
                : 'Wire your graph to Output first to unlock shader export.',
            () => this._exportGLSL('3d'),
            graphRenderable
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
    /**
     * @param {'2d'|'3d'} targetMode  Which shader variant to export.
     *   Deliberately independent of this.sceneManager.renderMode — see the
     *   comment at this method's two call sites in _toggleExportPanel for
     *   why. Generates fresh via glslEvaluator.generate() rather than
     *   reading a cached string, so this works regardless of what render
     *   mode is currently active on screen.
     */
    _exportGLSL(targetMode) {
        const time = (performance.now() - this.sceneManager._startTime) / 1000;
        const { source: injected, rootFn } =
            this.sceneManager.glslEvaluator.generate(time, targetMode);

        if (!injected || !rootFn) {
            this._showToast(
                'No shader source available. ' +
                'Wire your graph to Output first.'
            );
            return;
        }

        const renderer = targetMode === '3d'
            ? this.sceneManager.rayMarchRenderer
            : this.sceneManager.sdfRenderer;
        const fullFragmentShader = renderer._buildFragmentShader(injected);

        // Adapt the shader for direct ShaderToy use before export.
        const shaderToyReady = this._adaptForShaderToy(fullFragmentShader);

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const header = [
            `// Isoline — ${targetMode === '3d' ? 'Ray March (3D)' : 'GLSL 2D'} shader`,
            `// Exported: ${new Date().toISOString()}`,
            `// Generated by Isoline (isoline-studio.netlify.app)`,
            '//',
            '// ── ShaderToy (shadertoy.com) ────────────────────────────────────',
            '//   Paste the entire file into a new ShaderToy shader and click ▶.',
            '//   No changes needed — mainImage(), iTime, and iResolution are',
            '//   already correctly wired for ShaderToy.',
            '//',
            '// ── Your own WebGL project ───────────────────────────────────────',
            '//   Replace mainImage(out vec4 fragColor, in vec2 fragCoord) with',
            '//   void main() and write to gl_FragColor instead of fragColor.',
            '//   Declare: uniform float iTime; uniform vec2 iResolution;',
            '//',
        ].join('\n') + '\n\n';

        const full = header + shaderToyReady;
        const blob = new Blob([full], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `isoline-shadertoy-${ts}.glsl`;
        a.click();
        URL.revokeObjectURL(url);
        this._showToast('GLSL shader exported — ready to paste into ShaderToy.');
    }

    /**
     * Adapt Isoline's generated GLSL fragment shader for direct use in
     * ShaderToy. Handles all incompatibilities between Isoline's WebGL
     * renderer interface and ShaderToy's fixed interface:
     *
     *   1. Replaces vScreenPos varying with fragCoord-based UV computation
     *   2. Bakes all application uniforms (camera, lighting, tuning) as
     *      GLSL constants using their current renderer values
     *   3. Replaces uTime → iTime, uResolution → iResolution.xy
     *   4. Replaces gl_FragColor → fragColor, gl_FragCoord → fragCoord
     *   5. Renames main() → _isolineMain() and adds ShaderToy mainImage()
     */
    /**
     * Adapt Isoline's generated GLSL fragment shader for direct use in
     * ShaderToy. Handles all incompatibilities:
     *
     *   1. Removes #extension GL_OES_standard_derivatives (ShaderToy provides it)
     *   2. Removes varying vScreenPos declaration
     *   3. Replaces vScreenPos UV computation with fragCoord-based UV
     *   4. Bakes all application uniforms as GLSL constants
     *   5. Converts uFOV from degrees to radians (tan() expects radians)
     *   6. Replaces uTime → iTime, uResolution → iResolution
     *   7. Replaces gl_FragColor → fragColor, gl_FragCoord → fragCoord
     *   8. Renames main() → _isolineMain(), adds ShaderToy mainImage()
     */
    _adaptForShaderToy(source) {
        const rm = this.sceneManager.rayMarchRenderer;

        // ── Bake camera values from current renderer state ────────────────────
        const cx = rm?._camera?.position?.x ?? 0;
        const cy = rm?._camera?.position?.y ?? 2;
        const cz = rm?._camera?.position?.z ?? 5;
        const tx = rm?._controls?.target?.x ?? 0;
        const ty = rm?._controls?.target?.y ?? 0;
        const tz = rm?._controls?.target?.z ?? 0;

        // uFOV in Isoline is stored in degrees. ShaderToy GLSL's tan()
        // expects radians. Convert here so the baked constant is correct.
        const fovDeg    = rm?._fov ?? 52.0;
        const fovRad    = (fovDeg * Math.PI / 180.0).toFixed(6);
        // Use conservative but sensible defaults for ShaderToy export rather
        // than the renderer's current adaptive values. The live renderer may
        // have reduced stepScale (to 0.25 or lower) for non-Lipschitz scenes,
        // which combined with ShaderToy's fixed 256-iteration budget makes
        // the scene invisible. Standard values work for all common scenes.
        // Users who need tighter epsilon (for rDifference scenes) can edit
        // the baked constants at the top of the exported file.
        const maxDist   = '30.0';
        const epsilon   = '0.001';
        const stepScale = '0.85';

        const camPosStr    = `vec3(${cx.toFixed(4)}, ${cy.toFixed(4)}, ${cz.toFixed(4)})`;
        const camTargetStr = `vec3(${tx.toFixed(4)}, ${ty.toFixed(4)}, ${tz.toFixed(4)})`;

        const bakedConstants = `
// ── Baked renderer constants (replace application-specific uniforms) ──────────
// Camera — baked from Isoline at export time. Edit these to change the view.
vec3  uCamPos    = ${camPosStr};
vec3  uCamTarget = ${camTargetStr};
// FOV converted from degrees to radians (GLSL tan() expects radians)
float uFOV       = ${fovRad};

// Directional key light
vec3  uLightDir   = normalize(vec3(0.6, 1.0, 0.5));
vec3  uLightColor = vec3(1.0, 0.98, 0.92);
vec3  uAmbient    = vec3(0.08, 0.10, 0.14);

// Material
vec3  uMatColor     = vec3(0.82, 0.84, 0.88);
float uRoughness    = 0.45;
float uSpecularInt  = 0.55;
float uFresnelPower = 3.5;
float uFresnelInt   = 0.35;

// Ray march tuning
float uMaxDist   = ${maxDist};
float uEpsilon   = ${epsilon};
float uStepScale = ${stepScale};

// Point lights — ShaderToy does not allow uniform arrays to be declared
// as non-const, so we use plain vec3 variables instead.
vec3  uPL0Pos = vec3(-4.0, 3.0, -2.0);  vec3  uPL0Col = vec3(0.25, 0.35, 0.55);  float uPL0R = 8.0;
vec3  uPL1Pos = vec3( 3.0,-1.0,  4.0);  vec3  uPL1Col = vec3(0.30, 0.18, 0.10);  float uPL1R = 6.0;
vec3  uPL2Pos = vec3( 0.0, 0.0,  0.0);  vec3  uPL2Col = vec3(0.0,  0.0,  0.0);   float uPL2R = 1.0;
vec3  uPL3Pos = vec3( 0.0, 0.0,  0.0);  vec3  uPL3Col = vec3(0.0,  0.0,  0.0);   float uPL3R = 1.0;
// ── End baked constants ───────────────────────────────────────────────────────
`;

        let s = source;

        // ── 1. Remove #extension line — ShaderToy provides derivatives ────────
        s = s.replace(/^\s*#extension\s+GL_OES_standard_derivatives\s*:.*$/mg, '');

        // ── 2. Remove uniform declarations that ShaderToy provides or we bake ─
        const uniformsToRemove = [
            'uCamPos', 'uCamTarget', 'uFOV',
            'uLightDir', 'uLightColor', 'uAmbient',
            'uMatColor', 'uRoughness', 'uSpecularInt', 'uFresnelPower', 'uFresnelInt',
            'uMaxDist', 'uEpsilon', 'uStepScale',
            // Array uniforms — match with optional [N] suffix
            'uPointLightPos', 'uPointLightColor', 'uPointLightRadius', 'uPointLightCount',
        ];
        uniformsToRemove.forEach(name => {
            s = s.replace(
                new RegExp(
                    `^\\s*uniform\\s+\\S+\\s+${name}(\\s*\\[\\d+\\])?\\s*;[^\\n]*$`,
                    'mg'
                ),
                `// [baked] ${name}`
            );
        });
        s = s.replace(/^\s*uniform\s+float\s+uTime\s*;[^\n]*/mg,
            '// iTime — ShaderToy built-in');
        s = s.replace(/^\s*uniform\s+(vec[23])\s+uResolution\s*;[^\n]*/mg,
            '// iResolution — ShaderToy built-in');

        // ── 3. Remove varying declaration ─────────────────────────────────────
        s = s.replace(/^\s*varying\s+vec2\s+vScreenPos\s*;[^\n]*/mg, '');

        // ── 4. Insert baked constants after precision declaration ─────────────
        s = s.replace(
            /(precision\s+highp\s+float\s*;)/,
            `$1\n${bakedConstants}`
        );

        // ── 5. Replace vScreenPos UV computation with fragCoord-based UV ──────
        // Pattern 1: the two-line form used in the ray march renderer
        s = s.replace(
            /vec2\s+uv\s*=\s*vScreenPos\s*\*\s*2\.0\s*-\s*1\.0\s*;\s*\n\s*uv\.x\s*\*=\s*[^;]+;/,
            `vec2 uv = (fragCoord / iResolution.xy) * 2.0 - 1.0;\n  uv.x *= iResolution.x / iResolution.y;`
        );
        // Pattern 2: single-line form if renderer generates it differently
        s = s.replace(
            /vec2\s+uv\s*=\s*vScreenPos\s*\*\s*2\.0\s*-\s*1\.0\s*;/,
            `vec2 uv = (fragCoord / iResolution.xy) * 2.0 - 1.0;\n  uv.x *= iResolution.x / iResolution.y;`
        );
        // Pattern 3: any remaining vScreenPos reference
        s = s.replace(/\bvScreenPos\b/g, '(fragCoord / iResolution.xy)');

        // ── 6. Replace point light array element accesses ─────────────────────
        // The original shader uses uPointLightPos[i], uPointLightColor[i],
        // uPointLightRadius[i] inside a for loop. The uniform declarations
        // were removed above, so any remaining array-indexed references would
        // cause a compile error. Replace each indexed access with the baked
        // variable names, then replace uPointLightCount with the literal 2.
        //
        // We replace by index (0, 1, 2, 3) to handle both loop-unrolled
        // and loop-body forms regardless of how the renderer emits them.
        s = s.replace(/uPointLightPos\s*\[\s*0\s*\]/g, 'uPL0Pos');
        s = s.replace(/uPointLightPos\s*\[\s*1\s*\]/g, 'uPL1Pos');
        s = s.replace(/uPointLightPos\s*\[\s*2\s*\]/g, 'uPL2Pos');
        s = s.replace(/uPointLightPos\s*\[\s*3\s*\]/g, 'uPL3Pos');
        s = s.replace(/uPointLightColor\s*\[\s*0\s*\]/g, 'uPL0Col');
        s = s.replace(/uPointLightColor\s*\[\s*1\s*\]/g, 'uPL1Col');
        s = s.replace(/uPointLightColor\s*\[\s*2\s*\]/g, 'uPL2Col');
        s = s.replace(/uPointLightColor\s*\[\s*3\s*\]/g, 'uPL3Col');
        s = s.replace(/uPointLightRadius\s*\[\s*0\s*\]/g, 'uPL0R');
        s = s.replace(/uPointLightRadius\s*\[\s*1\s*\]/g, 'uPL1R');
        s = s.replace(/uPointLightRadius\s*\[\s*2\s*\]/g, 'uPL2R');
        s = s.replace(/uPointLightRadius\s*\[\s*3\s*\]/g, 'uPL3R');

        // Variable-index array accesses (e.g. uPointLightPos[i]) cannot be
        // resolved statically. Replace the entire for loop over point lights
        // with break-guarded index checks using the baked variables.
        // This handles the case where the renderer emits a loop rather than
        // unrolled accesses.
        s = s.replace(
            /for\s*\(\s*int\s+i\s*=\s*0\s*;\s*i\s*<\s*(?:uPointLightCount|4)\s*;\s*i\+\+\s*\)\s*\{[\s\S]*?^\s*\}/m,
            `// Point lights unrolled (ShaderToy: no non-const array indexing)
  { // Light 0
    vec3 _toL=uPL0Pos-p; float _dL=length(_toL); if(_dL>0.001){
      vec3 _dirL=_toL/_dL;
      float _att=1.0/(1.0+_dL*_dL/(uPL0R*uPL0R));
      float _dif=max(dot(normal,_dirL),0.0);
      float _shd=softShadow(p+normal*0.002,_dirL,0.01,_dL,8.0);
      vec3 _hL=normalize(_dirL+viewDir);
      float _spc=pow(max(dot(normal,_hL),0.0),specExp)*uSpecularInt*0.6;
      col+=uMatColor*uPL0Col*_dif*_att*_shd+uPL0Col*_spc*_att*_shd;
    }
  }
  { // Light 1
    vec3 _toL=uPL1Pos-p; float _dL=length(_toL); if(_dL>0.001){
      vec3 _dirL=_toL/_dL;
      float _att=1.0/(1.0+_dL*_dL/(uPL1R*uPL1R));
      float _dif=max(dot(normal,_dirL),0.0);
      float _shd=softShadow(p+normal*0.002,_dirL,0.01,_dL,8.0);
      vec3 _hL=normalize(_dirL+viewDir);
      float _spc=pow(max(dot(normal,_hL),0.0),specExp)*uSpecularInt*0.6;
      col+=uMatColor*uPL1Col*_dif*_att*_shd+uPL1Col*_spc*_att*_shd;
    }
  }`
        );

        // Replace uPointLightCount wherever it survived loop replacement
        s = s.replace(/\buPointLightCount\b/g, '2');

        // Any remaining variable-index array accesses that survived both
        // passes (e.g. uPointLightPos[i] with i still as a variable) must
        // be caught here to prevent a compile error. Replace with vec3(0.0).
        s = s.replace(/uPointLightPos\s*\[\s*\w+\s*\]/g, 'vec3(0.0)');
        s = s.replace(/uPointLightColor\s*\[\s*\w+\s*\]/g, 'vec3(0.0)');
        s = s.replace(/uPointLightRadius\s*\[\s*\w+\s*\]/g, '1.0');

        // ── 8. Replace remaining uniform-based references ─────────────────────
        s = s.replace(/\buTime\b/g, 'iTime');
        s = s.replace(/\buResolution\b/g, 'iResolution.xy');
        s = s.replace(/\biResolution\.xy\.x\b/g, 'iResolution.x');
        s = s.replace(/\biResolution\.xy\.y\b/g, 'iResolution.y');
        s = s.replace(/\bgl_FragColor\b/g, 'fragColor');
        s = s.replace(/\bgl_FragCoord\b/g, 'fragCoord');

        // ── Remove 2D overloads of sceneSDF and sceneSDF_raw ──────────────────
        // The ray march shader only calls sceneSDF(vec3), never sceneSDF(vec2).
        // GLSL ES 1.0 (ShaderToy) does not support function overloading, so
        // the vec2 overloads cause a compile error. Remove them.
        s = s.replace(
            /float\s+sceneSDF_raw\s*\(\s*vec2\s+p\s*\)\s*\{[^}]*\}/g,
            '// sceneSDF_raw(vec2) removed — ray march uses vec3 only'
        );
        s = s.replace(
            /float\s+sceneSDF\s*\(\s*vec2\s+p\s*\)\s*\{[^}]*\}/g,
            '// sceneSDF(vec2) removed — ray march uses vec3 only'
        );

        // ── 9. Rename main() → _isolineMain() ────────────────────────────────
        s = s.replace(
            /\bvoid\s+main\s*\(\s*\)\s*\{/,
            'void _isolineMain(out vec4 fragColor, in vec2 fragCoord) {'
        );

        // ── 10. Remove any previous ShaderToy wrapper (idempotent) ────────────
        s = s.replace(/\/\/\s*──\s*ShaderToy entry point[\s\S]*$/m, '');

        // ── 11. Append ShaderToy entry point ──────────────────────────────────
        s += `
// ── ShaderToy entry point ────────────────────────────────────────────────────
// Paste this entire file into shadertoy.com → New Shader → click ▶
// Camera is baked from Isoline at export time — edit uCamPos / uCamTarget
// near the top of this file to change the viewing angle.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    _isolineMain(fragColor, fragCoord);
}
`;
        return s;
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