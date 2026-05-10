// File: src/index.js
// Responsibilities: scene initialisation, state wiring, animation loop.
// All composition and render logic lives in SceneManager and NodeCanvas.
// The dat.GUI and legacy HTML controls have been removed — the NodeCanvas
// overlay is the primary UI.

import { SceneManager } from "./rendering/SceneManager.js";
import { stateStore }   from "./state/stateStore.js";
import { logger }       from "./utils/logger.js";
import { saveScene }    from "./persistence.js";
import { NodeCanvas }   from "./ui/NodeCanvas.js";

window.stateStore = stateStore;

// ── 1. SceneManager ───────────────────────────────────────────────────────────
const sceneManager = new SceneManager(document.getElementById("viewport"));

// ── 2. Schur / render params (read by NodeCanvas._compose) ───────────────────
const schurParams = {
  baseIds:    [],
  operations: ['union'],
  weight:     8,
  rotation:   0,
  scale:      1,
  posX:       0,
  posY:       0,
  isoOffset:  0.15,
};

const renderParams = {
  method: 'contours (2D)',
};

// ── 3. Hide legacy HTML controls (kept in HTML for fallback, hidden via JS) ───
const legacyIds = ['base-shapes', 'compose-btn'];
legacyIds.forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    const parent = el.closest('div') || el;
    parent.style.display = 'none';
  }
});

// ── 4. Visual update callback ─────────────────────────────────────────────────
stateStore.onVisualUpdate((shapeId) => {
  const match = sceneManager.getActivePrimitives()
    .find(p => p.instance.id === shapeId);
  if (!match) return;
  if (match.type === 'line') {
    sceneManager.updateLineGeometry();
  } else {
    sceneManager.refreshPrimitive(shapeId);
  }
});

// ── 5. Mapping config defaults ────────────────────────────────────────────────
stateStore.updateMappingConfig({
  mappingType:    'polynomial',
  polyCoeffs:     [0, 1, 0.5],
  a: 1, b: 1, c: 0, e: 0,
  blendFactor:    0.5,
  frequency:      1.0,
  recursionLimit: 3,
});

// ── 6. Default primitive ──────────────────────────────────────────────────────
// sceneManager.addPrimitive('line');

// ── 7. Auto-save on exit ──────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  saveScene(stateStore.nodeGraph, 'autosave').catch(() => {});
});

// ── 8. Garbage collection ─────────────────────────────────────────────────────
setInterval(() => stateStore.runGarbageCollection(), 5 * 60 * 1000);

// ── 9. Start animation loop ───────────────────────────────────────────────────
sceneManager.start();

// ── 10. Debug exposure ────────────────────────────────────────────────────────
window._sceneManager = sceneManager;
window._stateStore   = stateStore;

// ── 11. Node canvas (Tab to open/close) ──────────────────────────────────────
const nodeCanvas = new NodeCanvas(
  stateStore, sceneManager, schurParams, renderParams
);
window._nodeCanvas = nodeCanvas;