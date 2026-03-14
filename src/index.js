// File: src/index.js
// Responsibilities: GUI setup, parameter binding, event wiring.
// All scene/render logic lives in SceneManager.

import { SceneManager } from "./rendering/SceneManager.js";
import { stateStore } from "./state/stateStore.js";
import { logger } from "./utils/logger.js";
import * as dat from "dat.gui";

import { initializeSaveFeature, loadScene, autoSaveAndGarbageCollect } from "./persistence.js";


// -----------------------------------------------------------------------------
// 1. SceneManager — owns scene, camera, renderer, primitives, animation loop
// -----------------------------------------------------------------------------
const sceneManager = new SceneManager(document.getElementById("viewport"));


// -----------------------------------------------------------------------------
// 2. Schur / render parameters (GUI-bound, read by sceneManager.compose())
// -----------------------------------------------------------------------------
const schurParams = {
  baseIds:    [],
  operations: ['union'],
  weight:     8,
  rotation:   0,
  scale:      1,
  posX:       0,
  posY:       0,
  isoOffset:  0.15
};

const renderParams = {
  method: "contours (2D)"
};


// -----------------------------------------------------------------------------
// 3. DOM: base-shape multi-select + Compose button
// -----------------------------------------------------------------------------
const baseSelect = document.getElementById('base-shapes');
const composeBtn = document.getElementById('compose-btn');

if (!baseSelect || !composeBtn) {
  console.error("Missing #base-shapes or #compose-btn in HTML");
}

function refreshBaseShapeOptions() {
  baseSelect.innerHTML = '';
  stateStore.getShapes().forEach(shape => {
    const opt = document.createElement('option');
    opt.value       = shape.id;
    opt.textContent = `#${shape.id} (${shape.constructor.name})`;
    baseSelect.appendChild(opt);
  });
}

// Initial population and keep in sync with state changes
refreshBaseShapeOptions();
stateStore.onVisualUpdate(refreshBaseShapeOptions);

baseSelect.addEventListener('change', () => {
  schurParams.baseIds = Array.from(baseSelect.selectedOptions)
                             .map(opt => Number(opt.value));
});

composeBtn.addEventListener('click', () => {
  // If fewer than 2 explicitly selected, use all active shapes
  if (schurParams.baseIds.length < 2) {
    schurParams.baseIds = stateStore.getShapes().map(s => s.id);
  }
  if (schurParams.baseIds.length < 2) {
    alert("Add at least two primitives first.");
    return;
  }
  sceneManager.compose(schurParams, renderParams);
  refreshBaseShapeOptions();
});


// -----------------------------------------------------------------------------
// 4. Visual update callback — refresh line geometry when stateStore changes
// -----------------------------------------------------------------------------
stateStore.onVisualUpdate((shapeId) => {
  const match = sceneManager.getActivePrimitives()
    .find(p => p.instance.id === shapeId);
  if (!match) return;
  if (match.type === "line") {
    sceneManager.updateLineGeometry();
  } else {
    sceneManager.refreshPrimitive(shapeId);
  }
});


// -----------------------------------------------------------------------------
// 5. Initialize mapping config
// -----------------------------------------------------------------------------
stateStore.updateMappingConfig({
  mappingType:    "polynomial",
  polyCoeffs:     [0, 1, 0.5],
  a: 1, b: 1, c: 0, e: 0,
  blendFactor:    0.5,
  frequency:      1.0,
  recursionLimit: 3
});


// -----------------------------------------------------------------------------
// 6. Seed the scene with a default line primitive
// -----------------------------------------------------------------------------
sceneManager.addPrimitive("line");
refreshBaseShapeOptions();


// -----------------------------------------------------------------------------
// 7. dat.GUI
// -----------------------------------------------------------------------------
const gui = new dat.GUI();
gui.domElement.style.position = "absolute";
gui.domElement.style.left     = "0px";
gui.domElement.style.top      = "10px";


// ── Primitive management ─────────────────────────────────────────────────────
const primitiveSelection = { primitive: "Line" };
gui.add(primitiveSelection, "primitive", ["Line", "Triangle", "Arc"])
  .name("Add Primitive")
  .onChange(value => {
    sceneManager.addPrimitive(value.toLowerCase());
    refreshBaseShapeOptions();
  });

gui.add({ removeLast: () => {
  sceneManager.removeLast();
  refreshBaseShapeOptions();
}}, 'removeLast').name('Remove Last Primitive');

gui.add({ clearAll: () => {
  sceneManager.clearAll();
  refreshBaseShapeOptions();
}}, 'clearAll').name('Clear All Primitives');


// ── Lighting ─────────────────────────────────────────────────────────────────
const lightingFolder = gui.addFolder("Lighting");
lightingFolder.add(sceneManager.lightingManager.ambientLight,     "intensity", 0, 2).name("Ambient");
lightingFolder.add(sceneManager.lightingManager.directionalLight, "intensity", 0, 2).name("Directional");


// ── Distance Mapping ─────────────────────────────────────────────────────────
const mapperFolder  = gui.addFolder("Distance Mapping");
const mappingParams = { a: 1, b: 1, c: 0, e: 0, polyCoeffs: "0,1,0.5" };

// Helper: apply mapping change to all active line primitives
function applyMappingToLines() {
  sceneManager.getActivePrimitives()
    .filter(p => p.type === "line")
    .forEach(p => stateStore.applyGlobalMappingToShape(p.instance.id));
}

mapperFolder.add(stateStore, "selectedMappingType", [
  "identity","polynomial","exponential","logarithmic",
  "sinusoidal","power","composite","periodic",
  "temporal","recursive","sequential","blended"
]).name("Mapping Type").onChange(() => {
  applyMappingToLines();
  logger.info(`Mapper type updated to: ${stateStore.selectedMappingType}`);
});

mapperFolder.add(stateStore, "blendFactor", 0, 1).step(0.01).name("Blend Factor")
  .onChange(() => { stateStore.updateMappingConfig({ blendFactor: stateStore.blendFactor }); applyMappingToLines(); });

mapperFolder.add(stateStore, "timeFrequency", 0.1, 5).step(0.1).name("Time Frequency")
  .onChange(() => { stateStore.updateMappingConfig({ frequency: stateStore.timeFrequency }); applyMappingToLines(); });

mapperFolder.add(stateStore, "amplitude", 0, 2).step(0.1).name("Amplitude")
  .onChange(() => { stateStore.updateMappingConfig({ amplitude: stateStore.amplitude }); applyMappingToLines(); });

mapperFolder.add(stateStore, "recursionLimit", 1, 5).step(1).name("Recursion Depth")
  .onChange(() => { stateStore.updateMappingConfig({ recursionLimit: stateStore.recursionLimit }); applyMappingToLines(); });

mapperFolder.add(mappingParams, "polyCoeffs").name("Poly Coeffs (comma-sep)")
  .onFinishChange(val => {
    const coeffs = val.split(",").map(Number);
    stateStore.updateMappingConfig({ polyCoeffs: coeffs });
    applyMappingToLines();
  });

mapperFolder.add(mappingParams, "a", 0.1, 5).step(0.1).name("Scale Factor (a)")
  .onChange(() => { stateStore.updateMappingConfig({ a: mappingParams.a }); applyMappingToLines(); });

mapperFolder.add(mappingParams, "b", 0.1, 5).step(0.1).name("Rate Factor (b)")
  .onChange(() => { stateStore.updateMappingConfig({ b: mappingParams.b }); applyMappingToLines(); });

mapperFolder.add(mappingParams, "c", -2, 2).step(0.1).name("Offset (c)")
  .onChange(() => { stateStore.updateMappingConfig({ c: mappingParams.c }); applyMappingToLines(); });

mapperFolder.add(mappingParams, "e", -2, 2).step(0.1).name("Additional Offset (e)")
  .onChange(() => { stateStore.updateMappingConfig({ e: mappingParams.e }); applyMappingToLines(); });

mapperFolder.open();


// ── Triangle Controls ─────────────────────────────────────────────────────────
const triangleFolder = gui.addFolder("Triangle Controls");
const triangleParams = { size: 1, rotation: 0, cornerRounding: 0, posX: -1, posY: 0 };

function lastTriangle() { return sceneManager.getLastOfType("triangle"); }

triangleFolder.add(triangleParams, "size", 0.1, 5).onChange(v => {
  const t = lastTriangle(); if (t) { t.instance.updateParameters({ size: v }); stateStore.triggerVisualUpdate(t.instance.id); }
});
triangleFolder.add(triangleParams, "rotation", 0, Math.PI * 2).onChange(v => {
  const t = lastTriangle(); if (t) { t.instance.updateParameters({ rotation: v }); stateStore.triggerVisualUpdate(t.instance.id); }
});
triangleFolder.add(triangleParams, "cornerRounding", 0, 2).onChange(v => {
  const t = lastTriangle(); if (t) { t.instance.updateParameters({ cornerRounding: v }); stateStore.triggerVisualUpdate(t.instance.id); }
});
triangleFolder.add(triangleParams, "posX", -5, 5).onChange(v => {
  const t = lastTriangle(); if (t) { t.instance.updateParameters({ position: { x: v, y: triangleParams.posY } }); stateStore.triggerVisualUpdate(t.instance.id); }
});
triangleFolder.add(triangleParams, "posY", -5, 5).onChange(v => {
  const t = lastTriangle(); if (t) { t.instance.updateParameters({ position: { x: triangleParams.posX, y: v } }); stateStore.triggerVisualUpdate(t.instance.id); }
});
triangleFolder.open();


// ── Arc Controls ──────────────────────────────────────────────────────────────
const arcFolder = gui.addFolder("Arc Controls");
const arcParams = { radius: 1.5, startAngle: 0, endAngle: Math.PI, segments: 8, thickness: 0, posX: 1, posY: 0 };

function lastArc() { return sceneManager.getLastOfType("arc"); }

arcFolder.add(arcParams, "radius", 0.1, 5).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ radius: v }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.add(arcParams, "startAngle", 0, Math.PI * 2).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ startAngle: v }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.add(arcParams, "endAngle", 0, Math.PI * 2).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ endAngle: v }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.add(arcParams, "segments", 3, 20).step(1).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ segments: v }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.add(arcParams, "thickness", 0, 2).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ thickness: v }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.add(arcParams, "posX", -5, 5).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ position: { x: v, y: arcParams.posY } }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.add(arcParams, "posY", -5, 5).onChange(v => {
  const a = lastArc(); if (a) { a.instance.updateParameters({ position: { x: arcParams.posX, y: v } }); stateStore.triggerVisualUpdate(a.instance.id); }
});
arcFolder.open();


// ── Schur Composition ─────────────────────────────────────────────────────────
const schurFolder = gui.addFolder("Schur Composition");

schurFolder.add(schurParams, "operations", ["union", "intersection", "difference"])
  .name("Operation")
  .onChange(val => { schurParams.operations = [val]; });

function recomposeIfActive() {
  if (sceneManager.currentSchur) {
    sceneManager.compose(schurParams, renderParams);
    refreshBaseShapeOptions();
  }
}

schurFolder.add(schurParams, "weight",    0,         10        ).name("Smoothness").onChange(recomposeIfActive);
schurFolder.add(schurParams, "rotation",  0,         Math.PI*2 ).name("Rotation")  .onChange(recomposeIfActive);
schurFolder.add(schurParams, "scale",     0.1,       5         ).name("Scale")      .onChange(recomposeIfActive);
schurFolder.add(schurParams, "posX",     -5,         5         ).name("Translate X").onChange(recomposeIfActive);
schurFolder.add(schurParams, "posY",     -5,         5         ).name("Translate Y").onChange(recomposeIfActive);
schurFolder.add(schurParams, "isoOffset", 0.01,      1.0       ).step(0.01).name("Iso Offset").onChange(recomposeIfActive);

const renderMethods = ["contours (2D)", "fill (2D)", "arcs", "surface (3D)"];
schurFolder.add(renderParams, "method", renderMethods)
  .name("Render As")
  .onChange(() => {
    // Only re-render if a composition already exists
    if (sceneManager.currentSchur) {
      sceneManager.compose(schurParams, renderParams);
      refreshBaseShapeOptions();
    }
  });

schurFolder.open();


// -----------------------------------------------------------------------------
// 8. Persistence
// -----------------------------------------------------------------------------
initializeSaveFeature(gui);

gui.add({
  loadState: async () => {
    const success = await loadScene({
      clearVisuals:  () => sceneManager.clearVisuals(),
      createVisual:  (shape) => sceneManager.createVisual(shape),
      triggerRender: () => sceneManager.triggerRender()
    });
    alert(success ? "Scene loaded successfully!" : "Failed to load scene. See console for details.");
  }
}, 'loadState').name('Load Saved Scene');

window.addEventListener('beforeunload', async () => {
  await autoSaveAndGarbageCollect();
});


// -----------------------------------------------------------------------------
// 9. Garbage collection
// -----------------------------------------------------------------------------
setInterval(() => stateStore.runGarbageCollection(), 5 * 60 * 1000);


// -----------------------------------------------------------------------------
// 10. Start animation loop
// -----------------------------------------------------------------------------
sceneManager.start();