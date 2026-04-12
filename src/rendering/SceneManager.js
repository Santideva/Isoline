// File: src/rendering/SceneManager.js

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CameraManager } from "./cameraManager.js";
import { LightingManager } from "./LightingManager.js";
import { ComplexShape2D } from "../Geometry/ComplexShape2d.js";
import { TrianglePrimitive, ArcPrimitive } from "../Primitives/primaryDerivativePrimitives.js";
import { CirclePrimitive, RegularPolygonPrimitive, PolytopePrimitive } from "../Primitives/regionPrimitives.js";
import { SpherePrimitive, BoxPrimitive, CylinderPrimitive, CapsulePrimitive, TorusPrimitive, ConePrimitive, InfinitePlanePrimitive } from "../Primitives/solidPrimitives.js";
import { SchurComposition } from "../Primitives/SchurComposition.js";
import { createPolynomialMapping } from "../utils/DistanceMapping.js";
import { stateStore } from "../state/stateStore.js";
import { logger } from "../utils/logger.js";
import * as meshCreator from "../utils/meshCreator.js";
import { NodeEvaluator }  from "../graph/NodeEvaluator.js";
import { GLSLEvaluator }  from "./GLSLEvaluator.js";
import { SDFRenderer }      from "./SDFRenderer.js";
import { RayMarchRenderer } from "./RayMarchRenderer.js";


export class SceneManager {
  constructor(mountElement) {
    // ── Three.js core ──────────────────────────────────────────────────────
    this.scene    = new THREE.Scene();

    this.cameraManager = new CameraManager();
    this.camera   = this.cameraManager.getCamera();

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    mountElement.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.camera.position.set(0, 0, 5);
    this.controls.update();

    this.lightingManager = new LightingManager(this.scene);

    // ── State ──────────────────────────────────────────────────────────────
    this.activePrimitives = [];
    this.currentSchur     = null;

    // ── Node graph evaluator ───────────────────────────────────────────────
    this.evaluator = new NodeEvaluator(stateStore.nodeGraph);

    // ── GLSL renderer (Phase 5a) ───────────────────────────────────────────
    this.glslEvaluator    = new GLSLEvaluator(stateStore.nodeGraph);
    this.sdfRenderer      = new SDFRenderer(mountElement);
    this.rayMarchRenderer = new RayMarchRenderer(mountElement);
    // 'marchingSquares' | 'glsl' | 'rayMarch'
    this.renderMode       = 'marchingSquares';

    // ── Animation ─────────────────────────────────────────────────────────
    this._startTime    = performance.now();
    this._animating    = false;
    this._rafHandle    = null;

    // ── Resize ────────────────────────────────────────────────────────────
    window.addEventListener("resize", () => this._onResize());
  }


  // ---------------------------------------------------------------------------
  // Public scene-mutation API
  // ---------------------------------------------------------------------------

  /**
   * Add a primitive of the given type to the scene.
   * @param {"line"|"triangle"|"arc"} type
   * @returns {Object} the new primitive entry { instance, type, object }
   */
  addPrimitive(type) {
    let entry = null;

    switch (type.toLowerCase()) {
      case "line": {
        const lineCount = this.activePrimitives.filter(p => p.type === 'line').length;
        const initialPolyCoeffs = [0, 1, 0.5];
        const polyMapping = createPolynomialMapping(initialPolyCoeffs);
        const shape = new ComplexShape2D({
          metric: { center: { x: 0.5, y: 0.5 }, scale: 1, polyCoeffs: initialPolyCoeffs },
          color: { h: 200, s: 0.8, l: 0.6, a: 1 },
          distanceMapper: polyMapping
        });
        stateStore.addShape(shape);
        entry = { instance: shape, type: "line" };
        entry.object = shape.createLineObject();
        logger.info("Line segment shape instantiated.");
        break;
      }

      case "triangle": {
        const triangleCount = this.activePrimitives.filter(p => p.type === 'triangle').length;
        const triangle = new TrianglePrimitive({
          size: 1,
          rotation: triangleCount * 0.4,
          position: {
            x: -1 + (triangleCount % 3) * 1.2,
            y: Math.floor(triangleCount / 3) * 1.5
          },
          cornerRounding: 0,
          edgeSmoothness: [0, 0, 0],
          color: { h: 210, s: 0.8, l: 0.6, a: 1 },
          blendSmoothness: 8
        });
        triangle.registerWithStateStore(stateStore);
        stateStore.addShape(triangle);
        this._registerPrimInGraph(triangle, 'triangle', { size: triangle.size, rotation: triangle.rotation, posX: triangle.position?.x ?? 0, posY: triangle.position?.y ?? 0, cornerRounding: triangle.cornerRounding ?? 0 });
        entry = { instance: triangle, type: "triangle" };
        entry.object = triangle.createObject();
        logger.info("Triangle primitive instantiated.");
        break;
      }

      case "arc": {
        const arcCount = this.activePrimitives.filter(p => p.type === 'arc').length;
        const arc = new ArcPrimitive({
          radius: 1.5,
          startAngle: 0,
          endAngle: Math.PI,
          segments: 8,
          position: {
            x: 1 + (arcCount % 3) * 1.8,
            y: Math.floor(arcCount / 3) * 1.5
          },
          thickness: 0,
          color: { h: 30, s: 0.9, l: 0.5, a: 1 },
          blendSmoothness: 8
        });
        arc.registerWithStateStore(stateStore);
        stateStore.addShape(arc);
        this._registerPrimInGraph(arc, 'arc', { radius: arc.radius, startAngle: arc.startAngle, endAngle: arc.endAngle, segments: arc.segments, posX: arc.position?.x ?? 0, posY: arc.position?.y ?? 0 });
        entry = { instance: arc, type: "arc" };
        entry.object = arc.createObject();
        logger.info("Arc primitive instantiated.");
        break;
      }

      case "polytope": {
        const polytopeCount = this.activePrimitives.filter(p => p.type === 'polytope').length;
        const polytope = new PolytopePrimitive({
          vertices: '[[-1,-1],[1,-1],[1,1],[-1,1]]',
          posX: (polytopeCount % 3) * 3,
          posY: Math.floor(polytopeCount / 3) * 3,
          color: { h: 280, s: 0.7, l: 0.55, a: 1 },
        });
        stateStore.addShape(polytope);
        this._registerPrimInGraph(polytope, 'polytope', { vertices: polytope.vertices || '[[-1,-1],[1,-1],[1,1],[-1,1]]', posX: polytope.posX ?? 0, posY: polytope.posY ?? 0, rotation: polytope.rotation ?? 0 });
        entry = { instance: polytope, type: 'polytope' };
        entry.object = polytope.createObject();
        logger.info("Polytope primitive instantiated.");
        break;
      }

      case "regularpolygon":
      case "polygon": {
        const polyCount = this.activePrimitives.filter(p => p.type === 'regularPolygon').length;
        const poly = new RegularPolygonPrimitive({
          sides:    6,
          size:     1,
          rotation: 0,
          posX: (polyCount % 3) * 2.5,
          posY: Math.floor(polyCount / 3) * 2.5,
          color: { h: 120, s: 0.7, l: 0.55, a: 1 },
        });
        stateStore.addShape(poly);
        this._registerPrimInGraph(poly, 'regularPolygon', { sides: poly.sides, size: poly.size, rotation: poly.rotation, posX: poly.posX, posY: poly.posY });
        entry = { instance: poly, type: 'regularPolygon' };
        entry.object = poly.createObject();
        logger.info(`RegularPolygon primitive instantiated (${poly.sides} sides).`);
        break;
      }

      case "circle": {
        const circleCount = this.activePrimitives.filter(p => p.type === 'circle').length;
        const circle = new CirclePrimitive({
          radius: 1,
          posX: (circleCount % 3) * 2.5,
          posY: Math.floor(circleCount / 3) * 2.5,
          color: { h: 160, s: 0.8, l: 0.5, a: 1 },
        });
        stateStore.addShape(circle);
        this._registerPrimInGraph(circle, 'circle', { radius: circle.radius, posX: circle.posX, posY: circle.posY });
        entry = { instance: circle, type: 'circle' };
        entry.object = circle.createObject();
        logger.info("Circle primitive instantiated.");
        break;
      }

      case "sphere": {
        const count = this.activePrimitives.filter(p => p.type === 'sphere').length;
        const prim  = new SpherePrimitive({
          radius: 1,
          posX: (count % 3) * 2.5, posY: 0, posZ: 0,
          color: { h: 200, s: 0.8, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'sphere', { radius: prim.radius, posX: prim.posX, posY: prim.posY, posZ: prim.posZ });
        entry = { instance: prim, type: 'sphere', object: prim.createObject() };
        logger.info('Sphere primitive instantiated.');
        break;
      }

      case "box": {
        const count = this.activePrimitives.filter(p => p.type === 'box').length;
        const prim  = new BoxPrimitive({
          width: 2, height: 2, depth: 2,
          posX: (count % 3) * 3, posY: 0, posZ: 0,
          color: { h: 30, s: 0.8, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'box', { width: prim.width, height: prim.height, depth: prim.depth, posX: prim.posX, posY: prim.posY, posZ: prim.posZ });
        entry = { instance: prim, type: 'box', object: prim.createObject() };
        logger.info('Box primitive instantiated.');
        break;
      }

      case "cylinder": {
        const count = this.activePrimitives.filter(p => p.type === 'cylinder').length;
        const prim  = new CylinderPrimitive({
          radius: 1, height: 2, capped: true,
          posX: (count % 3) * 2.5, posY: 0, posZ: 0,
          color: { h: 120, s: 0.7, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'cylinder', { radius: prim.radius, height: prim.height, capped: prim.capped ? 'yes' : 'no', posX: prim.posX, posY: prim.posY, posZ: prim.posZ });
        entry = { instance: prim, type: 'cylinder', object: prim.createObject() };
        logger.info('Cylinder primitive instantiated.');
        break;
      }

      case "capsule": {
        const count = this.activePrimitives.filter(p => p.type === 'capsule').length;
        const prim  = new CapsulePrimitive({
          ax: 0, ay: -1, az: 0,
          bx: 0, by:  1, bz: 0,
          radius: 0.5,
          color: { h: 280, s: 0.7, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'capsule', { ax: prim.ax, ay: prim.ay, az: prim.az, bx: prim.bx, by: prim.by, bz: prim.bz, radius: prim.radius });
        entry = { instance: prim, type: 'capsule', object: prim.createObject() };
        logger.info('Capsule primitive instantiated.');
        break;
      }

      case "torus": {
        const count = this.activePrimitives.filter(p => p.type === 'torus').length;
        const prim  = new TorusPrimitive({
          majorRadius: 2, minorRadius: 0.5,
          posX: (count % 3) * 5, posY: 0, posZ: 0,
          color: { h: 340, s: 0.8, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'torus', { majorRadius: prim.majorRadius, minorRadius: prim.minorRadius, posX: prim.posX, posY: prim.posY, posZ: prim.posZ });
        entry = { instance: prim, type: 'torus', object: prim.createObject() };
        logger.info('Torus primitive instantiated.');
        break;
      }

      case "cone": {
        const count = this.activePrimitives.filter(p => p.type === 'cone').length;
        const prim  = new ConePrimitive({
          radius: 1,
          height: 2,
          posX: (count % 3) * 2.5,
          posY: 0,
          posZ: 0,
          color: { h: 20, s: 0.8, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'cone', { radius: prim.radius, height: prim.height, posX: prim.posX, posY: prim.posY, posZ: prim.posZ });
        entry = { instance: prim, type: 'cone', object: prim.createObject() };
        logger.info('Cone primitive instantiated.');
        break;
      }

      case "plane": {
        const count = this.activePrimitives.filter(p => p.type === 'plane').length;
        const prim  = new InfinitePlanePrimitive({
          nx: 0,
          ny: 1,
          nz: 0,
          offset: 0,
          color: { h: 210, s: 0.2, l: 0.7, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'plane', { nx: prim.nx, ny: prim.ny, nz: prim.nz, offset: prim.offset });
        entry = { instance: prim, type: 'plane', object: prim.createObject() };
        logger.info('InfinitePlane primitive instantiated.');
        break;
      }

      default:
        logger.warn(`Unknown primitive type "${type}". Defaulting to line.`);
        return this.addPrimitive("line");
    }

    this.activePrimitives.push(entry);
    this._addToScene(entry);
    return entry;
  }

  /**
   * Remove the most recently added primitive from the scene and state store.
   */
  removeLast() {
    if (this.activePrimitives.length === 0) return;
    const entry = this.activePrimitives.pop();
    this._removeFromScene(entry);
    stateStore.removeShape(entry.instance.id);
    logger.info(`Removed last primitive (id: ${entry.instance.id}, type: ${entry.type})`);
  }

  /**
   * Remove all active primitives from the scene and state store.
   */
  clearAll() {
    this.activePrimitives.forEach(p => {
      this._removeFromScene(p);
      stateStore.removeShape(p.instance.id);
    });
    this.activePrimitives = [];
    logger.info("Cleared all primitives.");
  }

  /**
   * Build a SchurComposition from the given params and render it.
   * @param {Object} schurParams  - { baseIds, operations, weight, rotation, scale, posX, posY }
   * @param {Object} renderParams - { method: "contours (2D)"|"fill (2D)"|"arcs"|"surface (3D)" }
   */
  compose(schurParams, renderParams) {
    // Remove previous composition if any
    if (this.currentSchur) {
      this._removeFromScene(this.currentSchur);
      stateStore.removeShape(this.currentSchur.instance.id);
      this.currentSchur = null;
    }

    // Resolve base shapes
    const bases = schurParams.baseIds
      .map(id => stateStore.getShape(id))
      .filter(s => !!s);

    if (bases.length < 2) {
      logger.warn("compose() requires at least 2 selected shapes.");
      return null;
    }

    // Build the composition
    const schur = new SchurComposition({
      shapes:    bases,
      operations: schurParams.operations,
      weights:   [schurParams.weight],
      rotation:  schurParams.rotation,
      scale:     schurParams.scale,
      position:  { x: schurParams.posX, y: schurParams.posY },
      blendSmoothness: schurParams.weight,
      isoOffset: schurParams.isoOffset !== undefined ? schurParams.isoOffset : 0.15,
      color:     { h: 0, s: 0, l: 0.8, a: 1 },
      onDependencyUpdate: (id, childIds) => stateStore._updateDependencies(id, childIds)
    });

    stateStore.addShape(schur);
    stateStore._updateDependencies(schur.id, schurParams.baseIds);

    // Wire the graph BEFORE rendering so getRootSDF() finds the correct edges.
    this._wireCompositionGraph(schur, bases);
    this.evaluator.invalidate();

    // Render
    const threeObj = this._buildSchurObject(schur, renderParams.method);
    const entry = { instance: schur, type: "schur", object: threeObj };
    this.currentSchur = entry;
    this._addToScene(entry);

    logger.info(`SchurComposition created (id: ${schur.id}), rendered as "${renderParams.method}".`);
    return entry;
  }

  /**
   * Return the activePrimitives array (read-only reference).
   * GUI controllers use this to find the primitive they should edit.
   */
  getActivePrimitives() {
    return this.activePrimitives;
  }

  /**
   * Return the most recently added primitive of a given type, or null.
   * Convenience for GUI slider callbacks.
   */
  getLastOfType(type) {
    const matches = this.activePrimitives.filter(p => p.type === type);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  /**
   * Rebuild the Three.js object for a primitive whose parameters changed.
   * Called from the stateStore.onVisualUpdate callback for triangle and arc types.
   */
  refreshPrimitive(shapeId) {
    const entry = this.activePrimitives.find(p => p.instance.id === shapeId);
    if (!entry) return;
    this._removeFromScene(entry);
    if (typeof entry.instance.createObject === 'function') {
      entry.object = entry.instance.createObject();
    } else if (typeof entry.instance.createLineObject === 'function') {
      entry.object = entry.instance.createLineObject(0);
    }
    this._addToScene(entry);
  }

  /**
   * Refresh all line primitives' geometry (called from the animation loop
   * and from visual-update callbacks).
   * @param {number} time - seconds since start
   */
  updateLineGeometry(time = 0) {
    this.activePrimitives
      .filter(p => p.type === "line")
      .forEach(p => {
        this._removeFromScene(p);
        p.object = p.instance.createLineObject(time);
        this._addToScene(p);
      });
  }

  // ---------------------------------------------------------------------------
  // Visual-pipeline helpers (passed as callbacks to persistence.loadScene)
  // ---------------------------------------------------------------------------

  /** Remove every visual from the Three.js scene and reset active list. */
  clearVisuals() {
    this.scene.children.slice().forEach(obj => this.scene.remove(obj));
    this.activePrimitives.forEach(p => stateStore.removeShape(p.instance.id));
    this.activePrimitives = [];
    if (this.currentSchur) {
      stateStore.removeShape(this.currentSchur.instance.id);
      this.currentSchur = null;
    }
  }

  /** Build and add the visual for a deserialized shape. */
  createVisual(shape) {
    let mesh;
    if (typeof shape.createObject === 'function') {
      mesh = shape.createObject();
    } else if (typeof shape.createLineObject === 'function') {
      mesh = shape.createLineObject(0);
    }
    if (!mesh) {
      logger.warn(`Shape ${shape.id} could not create a visual.`);
      return;
    }
    shape.object = mesh;
    this._addToScene({ object: mesh, instance: shape });
  }

  /** Fire a single render pass (used after scene load). */
  triggerRender() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Expose renderer.domElement for callers that need it. */
  getDOMElement() {
    return this.renderer.domElement;
  }

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------

  start() {
    if (this._animating) return;
    this._animating = true;
    this._loop();
  }

  stop() {
    this._animating = false;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
  }

  _loop() {
    if (!this._animating) return;
    this._rafHandle = requestAnimationFrame(() => this._loop());

    const currentTime = (performance.now() - this._startTime) / 1000.0;

    // Drive the evaluator's time — only temporal nodes lose their cache.
    this.evaluator.setTime(currentTime);
    this.evaluator.invalidateTemporalNodes();

    // Update time-driven line geometry (existing instance-based path)
    if (
      this.activePrimitives.some(p => p.type === "line") &&
      ["temporal", "sequential", "blended"].includes(stateStore.selectedMappingType)
    ) {
      this.updateLineGeometry(currentTime);
    }

    this.controls.update();

    if (this.renderMode === 'glsl') {
      this._renderGLSL();
    } else if (this.renderMode === 'rayMarch') {
      this.rayMarchRenderer.syncCamera(this.camera, this.controls);
      this._renderRayMarch();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _addToScene(entry) {
    if (!entry.object) {
      logger.warn(`Entry has no object to add to scene.`);
      return;
    }
    this.scene.add(entry.object);
    if (entry.instance) entry.instance.rendered = true;
  }

  _removeFromScene(entry) {
    if (!entry.object) return;
    this.scene.remove(entry.object);
    if (entry.instance) entry.instance.rendered = false;
  }

  _buildSchurObject(schur, method, sdfOverride = null) {
    const bounds2D = [-4, -4, 4, 4];
    const bounds3D = [-4, -4, -4, 4, 4, 4];

    let sdfFn;
    if (sdfOverride) {
      sdfFn = sdfOverride;
    } else {
      this.evaluator.invalidate();
      const rootSDF = this.evaluator.getRootSDF();
      sdfFn = rootSDF || (schur ? (pt => schur.computeSDF(pt)) : () => Infinity);
    }

    switch (method) {
      case "contours (2D)": {
        const loops = meshCreator.marchingSquares(
          sdfFn, bounds2D, 150
        );
        const geometry = meshCreator.buildLineSegments(loops);
        return new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ color: 0x3366ff })
        );
      }
      case "fill (2D)": {
        const loops = meshCreator.marchingSquares(
          sdfFn, bounds2D, 150
        );
        return meshCreator.createContourMesh(loops);
      }
      case "arcs": {
        const loops = meshCreator.marchingSquares(
          sdfFn, bounds2D, 150
        );
        const arcs = meshCreator.fitArcs(loops.flat());
        return meshCreator.createArcObject(arcs, { segments: 64 });
      }
      case "surface (3D)": {
        return meshCreator.createSDFMesh(
          { computeSDF: sdfFn }, bounds3D,
          { resolution: 50, wireframe: false, isoLevel: 0 }
        );
      }
      default:
        logger.warn(`Unknown render method: ${method}`);
        return new THREE.Group();
    }
  }

  _onResize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.cameraManager.updateAspect(window.innerWidth, window.innerHeight);
    this.sdfRenderer.resize(window.innerWidth, window.innerHeight);
    this.rayMarchRenderer.resize(window.innerWidth, window.innerHeight);
  }

  /**
   * Re-render the current SchurComposition without rebuilding it.
   * Used when params change on an existing composition so the cascade
   * structure is preserved.
   * @param {string} method  render method string
   * @param {Function} sdfOverride  optional direct SDF function
   */

  /**
   * Render any SDF function directly to the scene without requiring
   * a currentSchur composition. Used for tiling, transform nodes etc.
   * Stores the result in this.currentSchur so rerender() works afterwards.
   */
  renderSDF(sdfFn, method = 'contours (2D)') {
    if (this.renderMode === 'glsl') {
      this._renderGLSL();
      return;
    }
    // Remove previous render if any
    if (this.currentSchur) {
      this._removeFromScene(this.currentSchur);
      this.currentSchur = null;
    }

    const threeObj = this._buildSchurObject(null, method, sdfFn);
    const entry    = { instance: { computeSDF: sdfFn, family: 'region' }, type: 'schur', object: threeObj };
    this.currentSchur = entry;
    this._addToScene(entry);
  }

  /**
   * Set ray march quality parameters.
   * @param {number} maxSteps  Maximum sphere-tracing iterations (default 128)
   * @param {number} epsilon   Hit threshold (default 0.001)
   * @param {number} maxDist   Maximum ray travel distance (default 30)
   */
  setRayMarchQuality(maxSteps = 128, epsilon = 0.001, maxDist = 30) {
    this.rayMarchRenderer._maxSteps = maxSteps;
    this.rayMarchRenderer._epsilon  = epsilon;
    this.rayMarchRenderer._maxDist  = maxDist;
    // Recompile with new step count baked into shader
    this._lastRayMarchSource = null;
  }
  
  /**
   * Switch between 'marchingSquares' and 'glsl' render modes.
   * Toggles visibility of the Three.js canvas and the SDFRenderer canvas.
   * @param {'marchingSquares'|'glsl'} mode
   */
  setRenderMode(mode) {
    this.renderMode = mode;
    const threeCanvas = this.renderer.domElement;

    // Hide all non-Three.js renderers first
    this.sdfRenderer.hide();
    this.rayMarchRenderer.hide();

    if (mode === 'glsl') {
      threeCanvas.style.opacity = '0';
      threeCanvas.style.pointerEvents = 'none';
      this.sdfRenderer.show();
    } else if (mode === 'rayMarch') {
      threeCanvas.style.opacity = '0';
      threeCanvas.style.pointerEvents = 'auto';
      this.rayMarchRenderer.show(); } else {
      threeCanvas.style.opacity = '1';
      threeCanvas.style.pointerEvents = '';
    }
  }

  /**
   * Compile and render the current node graph using the GLSL pipeline.
   * Called by NodeCanvas when the user switches to GLSL mode or
   * after a compose/rerender in GLSL mode.
   */
  _renderGLSL() {
    const time = (performance.now() - this._startTime) / 1000;
    const { source, uniforms, rootFn } = this.glslEvaluator.generate(time, '2d');

    if (!source || !rootFn) {
      console.warn('SDFRenderer: GLSLEvaluator produced no source — nothing to render.');
      return;
    }

    // Only recompile if the source changed
    if (source !== this._lastGLSLSource) {
      const result = this.sdfRenderer.compile(source);
      if (!result.ok) {
        console.error('SDFRenderer compile error:\n', result.error);
        return;
      }
      this._lastGLSLSource = source;
      logger.info('SDFRenderer: shader compiled successfully.');
    }

    this.sdfRenderer.render(uniforms, time);
  }

  /**
   * Compile and render using the ray march renderer.
   * Requires 3D GLSL templates in GLSLEvaluator (Phase 5d).
   * For now syncs camera from Three.js and renders with existing shader.
   */
  _renderRayMarch() {
    const time = (performance.now() - this._startTime) / 1000;
    const { source, uniforms, rootFn } = this.glslEvaluator.generate(time, '3d');

    if (!source || !rootFn) {
      console.warn('RayMarchRenderer: no source from GLSLEvaluator.');
      return;
    }

    if (source !== this._lastRayMarchSource) {
      const result = this.rayMarchRenderer.compile(source);
      if (!result.ok) {
        console.error('RayMarchRenderer compile error:\n', result.error);
        return;
      }
      this._lastRayMarchSource = source;
      logger.info('RayMarchRenderer: shader compiled.');
    }

    // Sync camera from Three.js OrbitControls
    this.rayMarchRenderer.syncCamera(this.camera, this.controls);
    this.rayMarchRenderer.render(uniforms, time);
  }

  rerender(method, sdfOverride = null) {
    if (this.renderMode === 'glsl') {
      this._renderGLSL();
      return;
    }

    if (!this.currentSchur) return;

    this._removeFromScene(this.currentSchur);

    const threeObj = this._buildSchurObject(
      this.currentSchur.instance,
      method,
      sdfOverride
    );
    this.currentSchur.object = threeObj;
    this._addToScene(this.currentSchur);
  }

  /**
   * Register a newly created primitive as a node in the node graph.
   * Uses forceId so the node graph ID matches the primitive instance ID,
   * allowing graph.addEdge(prim.id, ...) to work directly.
   * @param {SolidPrimitive|RegionPrimitive} prim
   * @param {string} nodeType  The NODE_TYPES key e.g. 'circle', 'sphere'
   * @param {object} params    The node params (mirrors prim properties)
   */
  _registerPrimInGraph(prim, nodeType, params) {
    const graph = stateStore.nodeGraph;
    // Only register if not already present (idempotent)
    if (!graph.nodes.has(prim.id)) {
      graph.addNode(nodeType, params, { x: 0, y: 0 }, prim.id);
    }
  }

  _ensureOutputNode() {
    let outputNode = null;
    stateStore.nodeGraph.nodes.forEach(node => {
      if (node.type === 'outputNode') outputNode = node;
    });
    if (!outputNode) {
      outputNode = stateStore.nodeGraph.addNode('outputNode', {
        renderMethod: 'contours (2D)',
        resolution:   150,
        boundsMin:    -4,
        boundsMax:     4
      });
    }
    return outputNode;
  }

  _wireCompositionGraph(schur, bases) {
    try {
      const outputNode = this._ensureOutputNode();

      const getOutPort = (shape) =>
        shape.type === 'schur-composition' ? 'result' : 'sdf';

      if (bases[0]) {
        stateStore.nodeGraph.addEdge(
          bases[0].id, getOutPort(bases[0]),
          schur.id, 'sdfA'
        );
      }
      if (bases[1]) {
        stateStore.nodeGraph.addEdge(
          bases[1].id, getOutPort(bases[1]),
          schur.id, 'sdfB'
        );
      }
      stateStore.nodeGraph.addEdge(schur.id, 'result', outputNode.id, 'sdf');

      logger.info(`NodeGraph wired: ${bases.map(b => b.id).join(',')} → ${schur.id} → output`);
    } catch (e) {
      logger.warn(`NodeGraph wiring skipped: ${e.message}`);
    }
  }
}