// persistence.js

import Dexie from 'dexie';
import { stateStore } from './state/stateStore.js';
import { logger } from './utils/logger.js';
import { ComplexShape2D } from './Geometry/ComplexShape2d.js';
import { ComplexPrimitive2D } from './Primitives/ComplexPrimitive2d.js';
import { TrianglePrimitive, ArcPrimitive } from './Primitives/primaryDerivativePrimitives.js';

// =============================================================================
// 1. SETUP: Initialize Dexie Database and Define Schema
// =============================================================================

// Create a new Dexie database instance.
const db = new Dexie('MathShapeDB');

// Define the database schema for version 1:
// - 'shapes' table: stores each shape record with primary key 'id',
//   and indexes on 'type' and 'createdAt' (to support ordering and querying).
// - 'metadata' table: stores scene-level metadata as key-value pairs.
db.version(1).stores({
  shapes: 'id, type, createdAt',
  metadata: 'key'
});

db.version(2).stores({
  shapes:   'id, type, createdAt',
  metadata: 'key',
  scenes:   'name'
});

// =============================================================================
// 2. TYPE DETECTION AND UTILITY FUNCTIONS
// =============================================================================

/**
 * determineShapeType
 * Robustly determines the type of shape, using multiple strategies.
 * The order is:
 * 1. Specific primitives: TrianglePrimitive and ArcPrimitive.
 * 2. ComplexShape2D: if it is a line segment then 'line', otherwise 'complexShape'.
 * 3. ComplexPrimitive2D.
 * 4. Composite shapes (if blendParams exists).
 * 5. Fallback to an explicit shape.type (if provided) or the constructor name.
 */
function determineShapeType(shape) {
  let resolvedType = '';

  // 1. Specific primitives
  if (shape instanceof TrianglePrimitive) {
    resolvedType = 'triangle';
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Detected as TrianglePrimitive.`);
  } else if (shape instanceof ArcPrimitive) {
    resolvedType = 'arc';
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Detected as ArcPrimitive.`);
  }
  // 2. ComplexShape2D handling
  else if (shape instanceof ComplexShape2D) {
    resolvedType = shape.isLineSegment ? 'line' : 'complexShape';
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Detected as ComplexShape2D (${resolvedType}).`);
  }
  // 3. ComplexPrimitive2D handling
  else if (shape instanceof ComplexPrimitive2D) {
    resolvedType = 'complexPrimitive';
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Detected as ComplexPrimitive2D.`);
  }
  // 4. Composite/tessellation shapes based on blendParams
  else if (shape.blendParams && shape.blendParams.primitives && Array.isArray(shape.blendParams.primitives)) {
    resolvedType = 'composite';
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Detected as composite (via blendParams).`);
  }
  // 5. Fallback: if an explicit type property exists, then use it
  else if (shape.type && typeof shape.type === 'string') {
    resolvedType = shape.type;
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Falling back to explicit shape.type: ${resolvedType}.`);
  }
  // 6. Check constructor name as a last resort
  else if (shape.constructor && shape.constructor.name) {
    resolvedType = shape.constructor.name.toLowerCase();
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Falling back to constructor name: ${resolvedType}.`);
  }
  // 7. Last resort generic type
  else {
    resolvedType = 'generic';
    logger.debug(`Shape ID ${shape.id || 'unknown'}: Unable to determine type. Defaulting to generic.`);
  }

  logger.debug(`Final determined type for shape ID ${shape.id || 'unknown'}: ${resolvedType}`);
  return resolvedType;
}

/**
 * extractBasicParameters
 * Extracts fundamental parameters from any shape for fallback serialization.
 */
function extractBasicParameters(shape) {
  const params = {};

  // Extract universal properties
  if (shape.position !== undefined) {
    params.position = {
      x: shape.position.x || 0,
      y: shape.position.y || 0
    };
  }

  if (shape.size !== undefined) params.size = shape.size;
  if (shape.rotation !== undefined) params.rotation = shape.rotation;

  if (shape.color !== undefined) {
    params.color = { ...shape.color };
  }

  // Add constructor name for better deserialization
  params._shapeClass = shape.constructor ? shape.constructor.name : null;

  // Extract common shape-specific properties
  if (shape.type === 'triangle' || shape instanceof TrianglePrimitive) {
    if (shape.cornerRounding !== undefined) params.cornerRounding = shape.cornerRounding;
    if (shape.edgeSmoothness !== undefined) params.edgeSmoothness = [...shape.edgeSmoothness];
  } else if (shape.type === 'arc' || shape instanceof ArcPrimitive) {
    if (shape.radius !== undefined) params.radius = shape.radius;
    if (shape.startAngle !== undefined) params.startAngle = shape.startAngle;
    if (shape.endAngle !== undefined) params.endAngle = shape.endAngle;
    if (shape.segments !== undefined) params.segments = shape.segments;
    if (shape.thickness !== undefined) params.thickness = shape.thickness;
  }

  return params;
}

// =============================================================================
// 3. CAPTURE & FILTER FUNCTIONS
// =============================================================================

/**
 * captureVisualState
 * Iterates over all shapes in stateStore.sessionShapes and marks those
 * that are currently rendered as persistent.
 */
export function captureVisualState() {
  let flaggedCount = 0;
  try {
    stateStore.sessionShapes.forEach(shape => {
      try {
    // Skip the default shape with ID of 1
    if (shape.rendered === true && shape.id !== 1) {
      shape.persistent = true;
      flaggedCount++;
    }
      } catch (error) {
        logger.error(`Error flagging shape ${shape.id}: ${error.message}`);
      }
    });
    logger.info(`Successfully flagged ${flaggedCount} shapes as persistent`);
    return flaggedCount > 0;
  } catch (error) {
    logger.error(`Failed to capture visual state: ${error.message}`);
    return false;
  }
}

/**
 * getOrderedPersistentShapes
 * Filters the shapes marked as persistent and returns an array ordered by creation time.
 */
export function getOrderedPersistentShapes() {
  try {
    const persistentShapes = Array.from(stateStore.sessionShapes)
      .filter(shape => shape.persistent === true);
    const orderedShapes = persistentShapes.sort((a, b) => a.createdAt - b.createdAt);
    logger.info(`Retrieved ${orderedShapes.length} persistent shapes, ordered by creation time`);
    return orderedShapes;
  } catch (error) {
    logger.error(`Failed to get ordered persistent shapes: ${error.message}`);
    return [];
  }
}

// =============================================================================
// 4. SERIALIZATION FUNCTION
// =============================================================================

/**
 * serializeShapesForStorage
 * Creates a serializable representation of the persistent shapes along with scene metadata.
 * It first checks if the shape's constructor has a static getSerializableParameters method.
 * Otherwise, it falls back in this order:
 * 1. If the shape is an instance of ComplexShape2D, extract its vertices, metric, and blend parameters.
 * 2. Else if the shape is an instance of ComplexPrimitive2D, extract its metric and color.
 * 3. Else, fall back to generic extraction (e.g., size, position, rotation, and color).
 */
export function serializeShapesForStorage() {
  try {
    const orderedShapes = getOrderedPersistentShapes();

    if (orderedShapes.length === 0) {
      logger.warn("No persistent shapes found to serialize");
      return null;
    }

    logger.info(`Starting serialization for ${orderedShapes.length} shapes`);

    const serializableShapes = orderedShapes.map(shape => {
      try {
        let parameters = {};
        const shapeId = shape.id || 'unknown-id';
        const shapeType = determineShapeType(shape);
        let dependencyRefs = null;
        
        // 1. Gather SchurComposition dependencies if applicable
        if (shapeType === 'schur-composition') {
          dependencyRefs = Array.from(stateStore.dependencyMap.get(shapeId) || []);
        }        

        if (!shapeType || shapeType === 'generic') {
          logger.warn(`Shape with ID ${shapeId} has no defined type. Using ${shapeType}`);
        }

        // 1. Use static getSerializableParameters if defined on the constructor
        if (shape.constructor && typeof shape.constructor.getSerializableParameters === 'function') {
          try {
            logger.debug(`Using static getSerializableParameters from ${shape.constructor.name} for shape ${shapeId} of type ${shapeType}`);
            parameters = shape.constructor.getSerializableParameters(shape);
          } catch (serializeError) {
            logger.warn(`Error in static serialization for ${shapeId}: ${serializeError.message}`);
            parameters = extractBasicParameters(shape);
          }
        }
        // 2. Fallback for ComplexShape2D if static method is not defined
        else if (shape instanceof ComplexShape2D && shape.vertices) {
          logger.info(`Serializing ComplexShape2D with ID ${shapeId}`);
          parameters.vertices = shape.vertices.map(v => ({
            position: { x: v.position.x, y: v.position.y },
            color: v.color
          }));
          if (shape.metric !== undefined) {
            parameters.metric = { ...shape.metric };
          }
          if (shape.blendParams !== undefined) {
            parameters.blendParams = { ...shape.blendParams };
            // Store references to blended primitives
            if (shape.blendParams.primitives && Array.isArray(shape.blendParams.primitives)) {
              parameters.blendParams.primitiveRefs = shape.blendParams.primitives.map(p => p.id);
            }
          }
        }
        // 3. Fallback for ComplexPrimitive2D
        else if (shape instanceof ComplexPrimitive2D) {
          logger.info(`Serializing ComplexPrimitive2D with ID ${shapeId}`);
          parameters.metric = { ...shape.metric };
          parameters.color = { ...shape.color };
          if (shape.distanceMapper && shape.distanceMapper.name) {
            parameters.distanceMapper = shape.distanceMapper.name;
          }
        }
        // 4. Generic fallback
        else {
          logger.warn(`Using generic fallback serialization for shape ${shapeId} of type ${shapeType}`);
          parameters = extractBasicParameters(shape);
        }

        // Always include the constructor name for better type restoration
        parameters._shapeClass = shape.constructor ? shape.constructor.name : null;

        logger.debug(`Shape ${shapeId} of type ${shapeType} serialized with parameters: ${JSON.stringify(parameters)}`);

        return {
          id: shapeId,
          type: shapeType,
          createdAt: shape.createdAt,
          data: parameters,
          distanceMapperName:
            shape.distanceMapperName ||
            (shape.distanceMapper && shape.distanceMapper.name) ||
            'identity',
          // existing blend refs
          primitiveRefs: parameters.blendParams?.primitiveRefs || [],
          // new Schur dependency refs
          dependencyRefs:  dependencyRefs                      
        };
      } catch (shapeError) {
        logger.error(`Error serializing shape ${shape.id}: ${shapeError.message}`, shapeError);
        return null;
      }
    }).filter(shape => shape !== null);

    const sceneMetadata = {
      version: '1.0',
      timestamp: Date.now(),
      mappingConfig: {
        selectedMappingType: stateStore.selectedMappingType,
        blendFactor: stateStore.blendFactor,
        timeFrequency: stateStore.timeFrequency,
        recursionLimit: stateStore.recursionLimit,
        amplitude: stateStore.amplitude,
        polyCoeffs: stateStore.mappingParams ? stateStore.mappingParams.polyCoeffs : [0, 1, 0],
        a: stateStore.mappingParams ? stateStore.mappingParams.a : 1,
        b: stateStore.mappingParams ? stateStore.mappingParams.b : 1,
        c: stateStore.mappingParams ? stateStore.mappingParams.c : 0,
        e: stateStore.mappingParams ? stateStore.mappingParams.e : 0
      }
    };

    logger.info(`Successfully serialized ${serializableShapes.length} shapes`);
    return { shapes: serializableShapes, metadata: sceneMetadata };
  } catch (error) {
    logger.error(`Failed to serialize shapes: ${error.message}`, error);
    return null;
  }
}

// =============================================================================
// 5. SAVE AND LOAD FUNCTIONS USING DEXIE
// =============================================================================

/**
 * _legacySaveScene
 * Original shape-based save — used internally by autoSaveAndGarbageCollect.
 */
async function _legacySaveScene(sceneName = 'default') {
  try {
    const captured = captureVisualState();
    if (!captured) {
      logger.warn("No shapes were flagged as persistent during capture");
      return false;
    }

    const serializedData = serializeShapesForStorage();
    if (!serializedData) {
      logger.error("Failed to serialize visual state");
      return false;
    }

    await db.shapes.clear();
    await db.metadata.clear();
    await db.shapes.bulkPut(serializedData.shapes);
    await db.metadata.put({ key: 'scene', value: { sceneName, ...serializedData.metadata } });

    resetPersistenceFlags();

    logger.info(`Visual state saved successfully as scene '${sceneName}'`);
    return true;
  } catch (error) {
    logger.error(`Failed to save visual state: ${error.message}`);
    return false;
  }
}

/**
 * _legacyLoadScene (internal)
 * Original shape-based load — called by the new loadScene when passed the old signature.
 */
async function _legacyLoadScene({ clearVisuals, createVisual, triggerRender }) {
  try {
    // 1️⃣ Clear in-memory shapes
    stateStore.clear();

    // 2️⃣ Clear all Three.js visuals
    clearVisuals();

    // 3️⃣ Fetch saved shapes and metadata
    const savedShapes = await db.shapes.toArray();
    const metaRecord  = await db.metadata.get('scene');

    if (!savedShapes || savedShapes.length === 0) {
      logger.warn("No scene data found in IndexedDB");
      return false;
    }

    // 4️⃣ First pass: deserialize into stateStore and create visuals
    const shapesMap = new Map();
    for (const record of savedShapes) {
      const shape = stateStore.createShapeFromSerialized(record.type, record.data);
      shape.id        = record.id;
      shape.createdAt = record.createdAt;
            
      if (!shape) {
        logger.warn(`Failed to deserialize shape record ${record.id}`);
        continue;
      }

      // restore identifiers and timestamp
      shape.id        = record.id;
      shape.createdAt = record.createdAt;

      // restore any custom mapper name (optional)
      if (record.distanceMapperName) {
        shape.distanceMapperName = record.distanceMapperName;
      }

      // add to session
      stateStore.addShape(shape);
      shapesMap.set(record.id, shape);

      // delegate actual mesh/line creation and scene.add
      createVisual(shape);

      logger.debug(`Loaded and visualized shape ${shape.id} of type ${record.type}`);
    }

    // 5️⃣ Second pass: reconnect composite primitives by ID
    for (const record of savedShapes) {
      const refIds = record.data?.blendParams?.primitiveRefs;
      if (!refIds || !Array.isArray(refIds)) continue;

      const composite = shapesMap.get(record.id);
      if (composite && typeof composite.addBlendPrimitive === 'function') {
        for (const pid of refIds) {
          const prim = shapesMap.get(pid);
          if (prim) {
            composite.addBlendPrimitive(prim);
            logger.debug(`Reconnected primitive ${pid} to composite ${record.id}`);
          } else {
            logger.warn(`Primitive ${pid} not found for composite ${record.id}`);
          }
        }
        // update SDF and visuals
        if (typeof composite.updateCompositeSDF === 'function') {
          composite.updateCompositeSDF();
          createVisual(composite);
        }
      }
  // 5.b: restore SchurComposition dependency graph
  if (record.type === 'schur-composition' && Array.isArray(record.dependencyRefs)) {
    // stateStore.dependencyMap is a Map<schurId, Set<childIds>>
    stateStore._updateDependencies(record.id, record.dependencyRefs);
    logger.debug(
      `Reconnected SchurComposition deps for ${record.id}: [${record.dependencyRefs.join(', ')}]`
    );
  }

    }

    // 6️⃣ Restore global mapping configuration
    if (metaRecord?.value?.mappingConfig) {
      stateStore.updateMappingConfig(metaRecord.value.mappingConfig);
      logger.debug("Restored mapping configuration from metadata");
    }

    // 7️⃣ Final render
    triggerRender();
    logger.info(`Scene '${metaRecord?.value?.sceneName || 'default'}' loaded successfully`);
    return true;

  } catch (error) {
    logger.error(`Failed to load scene: ${error.message}`, error);
    return false;
  }
}

// =============================================================================
// 6. END-OF-SESSION PERSISTENCE & GARBAGE COLLECTION
// =============================================================================

/**
 * autoSaveAndGarbageCollect
 * Designed for end-of-session persistence, this function automatically saves the current scene
 * and then performs garbage collection on stateStore to remove stale or unrendered shapes.
 * It returns true if both operations succeed.
 */
export async function autoSaveAndGarbageCollect() {
  try {
    // Auto-save the current scene.
    const saved = await _legacySaveScene('autosave');
    if (!saved) {
      logger.error("Auto-save failed.");
      return false;
    }
    logger.info("Auto-save completed successfully.");

    // Perform garbage collection using stateStore's method (assumed to exist).
    if (typeof stateStore.runGarbageCollection === 'function') {
      stateStore.runGarbageCollection();
      logger.info("Garbage collection executed successfully.");
    } else {
      logger.warn("stateStore.runGarbageCollection is not implemented.");
    }
    return true;
  } catch (error) {
    logger.error(`Failed in autoSaveAndGarbageCollect: ${error.message}`);
    return false;
  }
}

// =============================================================================
// 7. RESET PERSISTENCE FLAGS FUNCTION
// =============================================================================

/**
 * resetPersistenceFlags
 * Clears the 'persistent' flag on all shapes after saving.
 */
export function resetPersistenceFlags() {
  try {
    let count = 0;
    stateStore.sessionShapes.forEach(shape => {
      if (shape.persistent === true) {
        shape.persistent = false;
        count++;
      }
    });
    logger.info(`Reset persistence flags for ${count} shapes`);
    return true;
  } catch (error) {
    logger.error(`Failed to reset persistence flags: ${error.message}`);
    return false;
  }
}

// =============================================================================
// 8. UI INTEGRATION: DAT.GUI AND STANDALONE BUTTON
// =============================================================================

/**
 * addSaveButtonToGUI
 * Adds a 'Save Current State' button to the dat.GUI interface.
 */
export function addSaveButtonToGUI(gui) {
  const saveFolder = gui.addFolder('Save/Restore');
  const saveController = {
    saveState: async function() {
      const success = await _legacySaveScene('default');
      if (success) {
        alert("Visual state saved successfully!");
      } else {
        alert("Failed to save visual state. Check console for details.");
      }
    }
  };
  saveFolder.add(saveController, 'saveState').name('Save Current State');
  saveFolder.open();
}

/**
 * setupSaveButton
 * Sets up an event listener for a standalone HTML button (if it exists) with id 'saveButton'.
 */
export function setupSaveButton() {
  const saveButton = document.getElementById('saveButton');
  if (saveButton) {
    saveButton.addEventListener('click', async () => {
      const success = await _legacySaveScene('default');
      if (success) {
        alert("Visual state saved successfully!");
      } else {
        alert("Failed to save visual state. Check console for details.");
      }
    });
    logger.info("Save button event listener set up");
  }
}

/**
 * initializeSaveFeature
 * Initializes the save feature by wiring up both the dat.GUI button and the standalone HTML button.
 * This function should be called from index.js after the GUI is initialized.
 */
export function initializeSaveFeature(gui) {
  if (gui) {
    addSaveButtonToGUI(gui);
  }
  setupSaveButton();
  logger.info("Save feature initialized");
}

// =============================================================================
// 9. NODE GRAPH SCENE PERSISTENCE (Phase 7A)
// These replace the shape-based saveScene/loadScene for the node canvas UI.
// NodeCanvas.js calls: saveScene(nodeGraph, name), loadScene(name, nodeGraph)
// =============================================================================

/**
 * Save the current node graph to the 'scenes' IndexedDB table.
 * This is the function imported by NodeCanvas.js.
 * @param {NodeGraph} nodeGraph
 * @param {string}    name
 * @returns {Promise<boolean>}
 */
export async function saveScene(nodeGraph, name = 'autosave', meta = {}) {
  try {
    const data = {
      name,
      savedAt:    Date.now(),
      nodeGraph:  nodeGraph.serialize(),
      renderMode: meta.renderMode || 'marchingSquares',
    };
    await db.scenes.put(data);
    logger.info(`Scene saved: "${name}" (renderMode: ${data.renderMode})`);
    return true;
  } catch (e) {
    logger.error(`saveScene failed: ${e.message}`);
    return false;
  }
}

/**
 * Load a named scene from the 'scenes' table into the node graph.
 * This is the function imported by NodeCanvas.js.
 * @param {string}    name
 * @param {NodeGraph} nodeGraph
 * @returns {Promise<boolean>}
 */
export async function loadScene(name = 'autosave', nodeGraph) {
  // Handle both call signatures:
  //   Old:  loadScene({ clearVisuals, createVisual, triggerRender })
  //   New:  loadScene(name, nodeGraph)
  if (typeof name === 'object' && name !== null) {
    return _legacyLoadScene(name);
  }

  try {
    const data = await db.scenes.get(name);
    if (!data) {
      logger.warn(`loadScene: no scene named "${name}"`);
      return null;
    }
    const ok = nodeGraph.deserialize(data.nodeGraph);
    if (ok) {
      logger.info(`Scene loaded: "${name}" (saved ${new Date(data.savedAt).toLocaleString()}, renderMode: ${data.renderMode || 'marchingSquares'})`);
      // Return the full record so callers can read renderMode etc.
      return data;
    }
    return null;
  } catch (e) {
    logger.error(`loadScene failed: ${e.message}`);
    return null;
  }
}

/**
 * List all saved scene names from the 'scenes' table.
 * @returns {Promise<string[]>}
 */
export async function listScenes() {
  try {
    const all = await db.scenes.toArray();
    return all.map(s => s.name);
  } catch (e) {
    logger.error(`listScenes failed: ${e.message}`);
    return [];
  }
}

/**
 * Delete a named scene.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteScene(name) {
  try {
    await db.scenes.delete(name);
    logger.info(`Scene deleted: "${name}"`);
    return true;
  } catch (e) {
    logger.error(`deleteScene failed: ${e.message}`);
    return false;
  }
}


export function addLoadButtonToGUI(gui, { clearVisuals, createVisual, triggerRender }) {
  const folder = gui.addFolder('Load');
  folder.add({
    loadState: async () => {
      const ok = await _legacyLoadScene({ clearVisuals, createVisual, triggerRender });
      alert(ok ? "Loaded!" : "Load failed; see console.");
    }
  }, 'loadState').name('Load Saved Scene');
  folder.open();
}

// =============================================================================
// 10. DEV / TEST GLOBAL EXPOSURE
// =============================================================================

// Expose persistence API for browser-console integration tests.
// Safe in webpack dev builds; remove or guard for production if desired.
if (typeof window !== 'undefined') {
  window._persistence = {
    db,
    saveScene,
    loadScene,
    listScenes,
    deleteScene,

    // optional legacy access
    _legacyLoadScene,
    _legacySaveScene
  };
}

