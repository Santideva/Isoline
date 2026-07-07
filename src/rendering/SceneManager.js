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
import { marchingCubes }    from "../utils/marchingCubes.js";
import { trianglesToSTL, downloadSTL } from "../utils/stlExport.js";
import { computeWorldBounds2D, computeWorldBounds3D } from "../utils/transform3D.js";


export class SceneManager {
  constructor(mountElement) {
    // ── Three.js core ──────────────────────────────────────────────────────
    this.scene       = new THREE.Scene();
    this._mountEl    = mountElement;   // saved so setRenderMode can use it

    this.cameraManager = new CameraManager();
    this.camera   = this.cameraManager.getCamera();

    this.renderer = new THREE.WebGLRenderer({
      antialias:            true,
      preserveDrawingBuffer: true,   // required for toDataURL() in PNG export
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    mountElement.appendChild(this.renderer.domElement);

    // Attach OrbitControls to the CONTAINER, not to renderer.domElement.
    // This is critical: in ray march mode the ray march canvas sits on top
    // of the Three.js canvas and intercepts all pointer events. By listening
    // on the container, OrbitControls receives events regardless of which
    // canvas is currently on top.
    this.controls = new OrbitControls(this.camera, mountElement);
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

        // ── Per-frame warning suppression flags ────────────────────────────────
        // These flags limit each warning to one
        // occurrence per "source disappears" event rather than per frame.
        // The flag resets to false as soon as valid source returns, so the
        // warning will fire again if the graph becomes empty a second time.
        this._warnedNoGLSLSource     = false;
        this._warnedNoRayMarchSource = false;

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
    addPrimitive(type, uiPos = null, extraParams = {}) {
    let entry = null;
    // Use provided uiPos for card placement, or fall back to origin.
    // NodeCanvas._nextCardPosition() passes the correct left-column
    // position so cards do not appear in the center of the viewport.
    const _uiPos = uiPos || { x: 0, y: 0 };

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
        this._registerPrimInGraph(triangle, 'triangle', {
          size:           triangle.size             ?? 1,
          rotation:       triangle.rotation         ?? 0,
          posX:           triangle.position?.x      ?? 0,
          posY:           triangle.position?.y      ?? 0,
          cornerRounding: triangle.cornerRounding   ?? 0,
        }, _uiPos);
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
        stateStore.addShape(arc);
        this._registerPrimInGraph(arc, 'arc', {
          radius:     arc.radius     ?? 1.5,
          startAngle: arc.startAngle ?? 0,
          endAngle:   arc.endAngle   ?? Math.PI,
          segments:   arc.segments   ?? 8,
          posX:       arc.position?.x ?? 0,
          posY:       arc.position?.y ?? 0,
        }, _uiPos);
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
        this._registerPrimInGraph(polytope, 'polytope', {
          vertices: polytope.vertices ?? '[[-1,-1],[1,-1],[1,1],[-1,1]]',
          posX:     polytope.posX     ?? 0,
          posY:     polytope.posY     ?? 0,
          rotation: polytope.rotation ?? 0,
        }, _uiPos);
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
        this._registerPrimInGraph(poly, 'regularPolygon', {
          sides:    poly.sides,
          size:     poly.size,
          rotation: poly.rotation ?? 0,
          posX:     poly.posX     ?? 0,
          posY:     poly.posY     ?? 0,
        }, _uiPos);
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
        this._registerPrimInGraph(circle, 'circle', {
          radius: circle.radius,
          posX:   circle.posX   ?? 0,
          posY:   circle.posY   ?? 0,
        }, _uiPos);
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
        this._registerPrimInGraph(prim, 'sphere', {
          radius: prim.radius,
          posX:   prim.posX ?? 0,
          posY:   prim.posY ?? 0,
          posZ:   prim.posZ ?? 0,
        }, _uiPos);
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
        this._registerPrimInGraph(prim, 'box', {
          width:  prim.width,
          height: prim.height,
          depth:  prim.depth,
          posX:   prim.posX ?? 0,
          posY:   prim.posY ?? 0,
          posZ:   prim.posZ ?? 0,
        }, _uiPos);
        entry = { instance: prim, type: 'box', object: prim.createObject() };
        logger.info('Box primitive instantiated.');
        break;
      }

      case "cylinder": {
        const count = this.activePrimitives.filter(p => p.type === 'cylinder').length;
        const prim  = new CylinderPrimitive({
          radius: 1, height: 2, capped: true,
          axis:   'Y',
          posX: (count % 3) * 2.5, posY: 0, posZ: 0,
          color: { h: 120, s: 0.7, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'cylinder', {
          radius: prim.radius,
          height: prim.height,
          capped: prim.capped ? 'yes' : 'no',
          axis:   'Y',
          posX:   prim.posX ?? 0,
          posY:   prim.posY ?? 0,
          posZ:   prim.posZ ?? 0,
        }, _uiPos);
        entry = { instance: prim, type: 'cylinder', object: prim.createObject() };
        logger.info('Cylinder primitive instantiated.');
        break;
      }

      case "capsule": {
    const count  = this.activePrimitives.filter(p => p.type === 'capsule').length;
    const height = 2;
    const posX   = (count % 3) * 2.5;
    const posY   = 0;
    const posZ   = 0;
    const radius = 0.5;

    const prim = new CapsulePrimitive({
      radius,
      height,
      posX,
      posY,
      posZ,
    });

    stateStore.addShape(prim);
    this._registerPrimInGraph(prim, 'capsule', { radius, height, posX, posY, posZ }, _uiPos);
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
        this._registerPrimInGraph(prim, 'torus', {
          majorRadius: prim.majorRadius,
          minorRadius: prim.minorRadius,
          posX: prim.posX ?? 0,
          posY: prim.posY ?? 0,
          posZ: prim.posZ ?? 0,
        }, _uiPos);
        entry = { instance: prim, type: 'torus', object: prim.createObject() };
        logger.info('Torus primitive instantiated.');
        break;
      }

      case "cone": {
        const count = this.activePrimitives.filter(p => p.type === 'cone').length;
        const prim  = new ConePrimitive({
          radius: 1,
          height: 2,
          axis:   'Y',
          posX: (count % 3) * 2.5,
          posY: 0,
          posZ: 0,
          color: { h: 20, s: 0.8, l: 0.5, a: 1 }
        });
        stateStore.addShape(prim);
        this._registerPrimInGraph(prim, 'cone', {
          radius: prim.radius,
          height: prim.height,
          axis:   'Y',
          posX:   prim.posX ?? 0,
          posY:   prim.posY ?? 0,
          posZ:   prim.posZ ?? 0,
        }, _uiPos);
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
        this._registerPrimInGraph(prim, 'plane', {
          nx:     prim.nx     ?? 0,
          ny:     prim.ny     ?? 1,
          nz:     prim.nz     ?? 0,
          offset: prim.offset ?? 0,
        }, _uiPos);
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
      // ── GLSL mode: only re-render when something actually changed ───────
      // Sources of change that require a new render:
      //   1. Camera moved (user dragging / auto-orbit active)
      //   2. Graph or params changed (flagged by _glslDirty, set externally
      //      by _renderGLSL() callers in NodeCanvas and SceneManager)
      //   3. Animated noise nodes (noiseDisplaceNode with animated='yes')
      //      require continuous re-render since uTime changes every frame.
      //
      // _glslDirty is set to true by any code path that changes the graph
      // (param change, node add/remove, edge add/remove). The animation loop
      // here clears it after consuming it.
      const pos = this.camera.position;
      const tgt = this.controls.target;
      const camKey = `${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)},${tgt.x.toFixed(3)},${tgt.y.toFixed(3)},${tgt.z.toFixed(3)}`;
      const camMoved = camKey !== this._lastGLSLCamKey;
      if (camMoved) this._lastGLSLCamKey = camKey;

      if (camMoved || this._glslDirty || this._sceneHasAnimatedNoise()) {
        this._glslDirty = false;
        this._renderGLSL();
      }

    } else if (this.renderMode === 'rayMarch') {
      // ── Ray March mode: same logic as GLSL ──────────────────────────────
      // Ray March is the most expensive mode — a full sphere-tracing pass
      // per pixel, 60 times per second on integrated graphics is extremely
      // wasteful when nothing changed. Skip the render entirely when the
      // camera is stationary, no params changed, and no animated nodes exist.
      this.rayMarchRenderer.syncCamera(this.camera, this.controls);

      const pos = this.camera.position;
      const tgt = this.controls.target;
      const camKey = `${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)},${tgt.x.toFixed(3)},${tgt.y.toFixed(3)},${tgt.z.toFixed(3)}`;
      const camMoved = camKey !== this._lastRMCamKey;
      if (camMoved) this._lastRMCamKey = camKey;

      if (camMoved || this._rayMarchDirty || this._sceneHasAnimatedNoise()) {
        this._rayMarchDirty = false;
        this._renderRayMarch();
      }

    } else {
      // marchingSquares — Three.js renders the wireframe scene continuously.
      // This is cheap (no shader compilation, no sphere tracing) so
      // unconditional rendering here is acceptable.
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Returns true if any noiseDisplaceNode in the current graph has
   * animated='yes'. When true, the animation loop must re-render every
   * frame even when the camera is stationary, because uTime changes
   * continuously and the noise pattern evolves with it.
   *
   * Cached for one frame (checked once per loop iteration, not per render
   * call) to avoid re-walking the graph on every animation frame.
   */
  _sceneHasAnimatedNoise() {
    // Cache the result for 30 frames to avoid graph-walking overhead
    // at 60fps. Graph structure only changes when nodes are added/removed,
    // which also sets _rayMarchDirty/_glslDirty anyway — so 30-frame
    // staleness is inconsequential.
    if (this._animatedNoiseFrame !== undefined &&
        this._animatedNoiseCounter < 30) {
      this._animatedNoiseCounter++;
      return this._animatedNoiseCached;
    }
    this._animatedNoiseCounter = 0;

    const graph = this.glslEvaluator?.graph ?? stateStore.nodeGraph;
    let found = false;
    graph.nodes.forEach(n => {
      if (n.type === 'noiseDisplaceNode' && n.params?.animated === 'yes') {
        found = true;
      }
    });
    this._animatedNoiseCached = found;
    this._animatedNoiseFrame  = true;
    return found;
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

  _buildSchurObject(schur, method, sdfOverride = null, bounds2D = null, bounds3D = null, resolution = 150) {
    // Use caller-supplied bounds (from adaptive logic in renderSDF) if provided,
    // otherwise fall back to effective bounds computed from the output node's
    // boundsMin/boundsMax AND the output placement transform (posX/Y/Z,
    // rotateX/Y/Z). This ensures contour rendering, surface rendering, and
    // STL export never clip geometry that has been repositioned via the
    // output node's placement controls.
    bounds2D = bounds2D ?? this._getEffectiveBounds('2d');
    bounds3D = bounds3D ?? this._getEffectiveBounds('3d');

    // Clamp resolution to a safe integer range so bad values from the slider
    // never crash the marching-squares scan.
    const safeResolution = Math.max(20, Math.min(400, Math.round(resolution)));

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
          sdfFn, bounds2D, safeResolution
        );
        const geometry = meshCreator.buildLineSegments(loops);
        return new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ color: 0x3366ff })
        );
      }
      case "fill (2D)": {
        const loops = meshCreator.marchingSquares(
          sdfFn, bounds2D, safeResolution
        );
        return meshCreator.createContourMesh(loops);
      }
      case "arcs": {
        const loops = meshCreator.marchingSquares(
          sdfFn, bounds2D, safeResolution
        );
        const arcs = meshCreator.fitArcs(loops.flat());
        return meshCreator.createArcObject(arcs, { segments: 64 });
      }
      case "surface (3D)": {
        // surface (3D) uses its own resolution scale — marching cubes is
        // much more expensive than marching squares so we cap it at 80
        // regardless of the slider value to keep interactive performance.
        const meshResolution = Math.min(Math.round(safeResolution / 4), 80);
        return meshCreator.createSDFMesh(
          { computeSDF: sdfFn }, bounds3D,
          { resolution: meshResolution, wireframe: false, isoLevel: 0 }
        );
      }
      default:
        logger.warn(`Unknown render method: ${method}`);
        return new THREE.Group();
    }
  }

  /**
   * Compute a 2D bounding box [minX, minY, maxX, maxY] that covers all
   * geometry primitive nodes in the graph, plus a padding margin.
   *
   * Used by renderSDF to auto-expand the marching-squares scan area when
   * a primitive has been placed outside the Output node's current bounds.
   *
   * Plane is excluded — it is infinite and has no meaningful position-based
   * bounds. If the graph contains only a plane, the default [-4,4] is used.
   *
   * @param {NodeGraph} graph
   * @returns {[number,number,number,number]} [minX, minY, maxX, maxY]
   */
  _computeAdaptiveBounds(graph) {
    // Geometry types whose position params are meaningful for bounds computation.
    // Plane is intentionally omitted — it is infinite and has no finite extent.
    const BOUNDED_GEOM = new Set([
      'circle', 'regularPolygon', 'polytope', 'triangle', 'arc',
      'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone',
    ]);

    const PADDING = 2.0;  // units of extra margin beyond the outermost primitive

    let minX = Infinity,  minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    let foundAny = false;

    graph.nodes.forEach(node => {
      if (!BOUNDED_GEOM.has(node.type)) return;

      const p  = node.params;
      const cx = p.posX ?? 0;
      const cy = p.posY ?? 0;

      // Estimate the rough half-extent of this primitive.
      // We take the most generous estimate from all known size parameters
      // so that we never accidentally clip a shape's boundary.
      let r = 1; // minimum 1 unit so even a zero-size node has some bounds
      if (p.radius !== undefined)      r = Math.max(r, p.radius);
      if (p.majorRadius !== undefined) r = Math.max(r, p.majorRadius + (p.minorRadius ?? 0.5));
      if (p.minorRadius !== undefined) r = Math.max(r, p.minorRadius);
      if (p.size !== undefined)        r = Math.max(r, p.size);
      if (p.width !== undefined)       r = Math.max(r, p.width  / 2);
      if (p.height !== undefined) {
      if (node.type === 'capsule') {
        r = Math.max(r, (p.height / 2) + (p.radius ?? 0));
      } else {
        r = Math.max(r, p.height / 2);
      }
    }
      if (p.depth !== undefined)       r = Math.max(r, p.depth  / 2);

      minX = Math.min(minX, cx - r);
      minY = Math.min(minY, cy - r);
      maxX = Math.max(maxX, cx + r);
      maxY = Math.max(maxY, cy + r);
      foundAny = true;
    });

    if (!foundAny) {
      // No bounded geometry in the graph — return the conservative default.
      return [-4, -4, 4, 4];
    }

    return [
      minX - PADDING,
      minY - PADDING,
      maxX + PADDING,
      maxY + PADDING,
    ];
  }

  /**
   * Run a coarse grid search over a large area to locate the SDF zero-crossing
   * when it is not present within the normal render bounds.
   *
   * This is called automatically by renderSDF when the pre-flight sign check
   * determines that all samples within the current bounds have the same sign —
   * meaning the surface exists somewhere but not here. Typical causes:
   *   - A twistNode or bendNode has relocated the geometry
   *   - A tilingNode creates copies at tiling-period offsets
   *   - A mobiusNode maps geometry to a distant region of the plane
   *
   * The search samples a (gridSize × gridSize) lattice over searchBounds,
   * then checks each 2×2 cell for a sign change (positive neighbour adjacent
   * to a negative neighbour). The bounding box of all sign-change cells is
   * returned, expanded by a small padding so the full-resolution marching
   * squares scan has room to trace the contour cleanly.
   *
   * Returns null if no sign change is found anywhere in the search area,
   * which means the geometry is genuinely invisible (e.g. rDifference of
   * two identical shapes produces an empty set with SDF > 0 everywhere).
   *
   * @param {Function} sdfFn           The SDF to search
   * @param {number[]} searchBounds    [minX,minY,maxX,maxY] — defaults to [-20,-20,20,20]
   * @param {number}   gridSize        Number of cells per axis — defaults to 30
   * @returns {number[]|null}          [minX,minY,maxX,maxY] of surface region, or null
   */
  _coarseSearchForSurface(
    sdfFn,
    searchBounds = [-20, -20, 20, 20],
    gridSize     = 30
  ) {
    // Pass 1: fine search within normal scene bounds.
    // Catches thin features (crescents, narrow intersections) that the coarser
    // large-area grid misses. Step ≈ 12/60 = 0.2 units.
    const fineResult = this._runCoarseGrid(sdfFn, [-6, -6, 6, 6], 60);
    if (fineResult) return fineResult;

    // Pass 2: coarser search over the full large area for displaced geometry.
    return this._runCoarseGrid(sdfFn, searchBounds, gridSize);
  }

  _runCoarseGrid(sdfFn, searchBounds, gridSize) {
    const [sMinX, sMinY, sMaxX, sMaxY] = searchBounds;
    const stepX = (sMaxX - sMinX) / gridSize;
    const stepY = (sMaxY - sMinY) / gridSize;

    // Sample every grid vertex once
    const vals = [];
    for (let i = 0; i <= gridSize; i++) {
      vals[i] = [];
      for (let j = 0; j <= gridSize; j++) {
        const x = sMinX + i * stepX;
        const y = sMinY + j * stepY;
        try {
          const v = sdfFn({ x, y, z: 0 });
          vals[i][j] = (isFinite(v) ? v : null);
        } catch (_) {
          vals[i][j] = null;
        }
      }
    }

    // Find every 2×2 cell that straddles the surface (sign change)
    let foundMinX =  Infinity,  foundMinY =  Infinity;
    let foundMaxX = -Infinity,  foundMaxY = -Infinity;
    let foundAny  = false;

    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const v00 = vals[i][j];
        const v10 = vals[i + 1][j];
        const v01 = vals[i][j + 1];
        const v11 = vals[i + 1][j + 1];

        // Skip cells where any corner evaluation failed
        if (v00 === null || v10 === null || v01 === null || v11 === null) continue;

        const hasPositive = v00 > 0 || v10 > 0 || v01 > 0 || v11 > 0;
        const hasNegative = v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0;

        if (hasPositive && hasNegative) {
          // This cell straddles the surface — record its extents
          const cellMinX = sMinX +  i      * stepX;
          const cellMinY = sMinY +  j      * stepY;
          const cellMaxX = sMinX + (i + 1) * stepX;
          const cellMaxY = sMinY + (j + 1) * stepY;

          foundMinX = Math.min(foundMinX, cellMinX);
          foundMinY = Math.min(foundMinY, cellMinY);
          foundMaxX = Math.max(foundMaxX, cellMaxX);
          foundMaxY = Math.max(foundMaxY, cellMaxY);
          foundAny  = true;
        }
      }
    }

    if (!foundAny) return null;

    // Add padding so the full-resolution scan has room on all sides.
    // Use at least 2× the coarse step size so the contour is never
    // right at the edge of the scan area.
    const pad = Math.max(stepX * 2, stepY * 2, 1.0);

    return [
      foundMinX - pad,
      foundMinY - pad,
      foundMaxX + pad,
      foundMaxY + pad,
    ];
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

    // ── Step 1: Resolve the live node graph and output node ───────────────
    // We need both to read current bounds and to persist any auto-expansions.
    const graph = this.evaluator?.graph ?? stateStore.nodeGraph;
    let outputNode = null;
    graph?.nodes?.forEach(n => { if (n.type === 'outputNode') outputNode = n; });

    // ── Step 2: Auto-expand bounds from primitive positions (Fix B) ───────
    // Read the Output node's current boundsMin/boundsMax. Compute the
    // bounding box of every connected geometry primitive. If any primitive
    // sits outside the current bounds, silently expand the bounds to include
    // it. We only ever EXPAND — never shrink — so user-set manual bounds
    // are always respected.
    //
    // This handles the common case: user places a shape at posX=6 but the
    // default boundsMax is 4. The scanner would never visit x=6 and the
    // shape would be invisible. This expansion fixes that transparently.
    let bounds2D;

    if (outputNode) {
      const currentMin = outputNode.params.boundsMin ?? -4;
      const currentMax = outputNode.params.boundsMax ??  4;

      const [aMinX, aMinY, aMaxX, aMaxY] = this._computeAdaptiveBounds(graph);

      // Take the most expansive of: user bounds, primitive-derived bounds
      const newMin = Math.min(currentMin, aMinX, aMinY);
      const newMax = Math.max(currentMax, aMaxX, aMaxY);

      if (newMin < currentMin || newMax > currentMax) {
        // Primitive positions fall outside current bounds — persist the expansion
        // so the Output node card sliders reflect what is actually being used.
        graph.updateNodeParam(outputNode.id, 'boundsMin', Math.floor(newMin - 0.5));
        graph.updateNodeParam(outputNode.id, 'boundsMax', Math.ceil(newMax  + 0.5));
        logger.info(
          `renderSDF: bounds auto-expanded from [${currentMin}, ${currentMax}] ` +
          `to [${graph.nodes.get(outputNode.id)?.params.boundsMin}, ` +
          `${graph.nodes.get(outputNode.id)?.params.boundsMax}] ` +
          `to include all primitives`
        );
      }

      // Read back the final (possibly just-expanded) values
      const finalMin = outputNode.params.boundsMin ?? -4;
      const finalMax = outputNode.params.boundsMax ??  4;
      bounds2D = [finalMin, finalMin, finalMax, finalMax];
    } else {
      // No output node — fall back to default scan area
      bounds2D = [-4, -4, 4, 4];
    }

    // ── Step 3: Pre-flight sign check with coarse-search fallback (Fix A) ─
    // Sample seven points spread across the current bounds. If every point
    // has the same sign there is no zero-crossing in this region, meaning
    // the surface boundary is not here.
    //
    // When this happens we do NOT just warn and give up. We run a coarse
    // 30×30 search over a large area ([-20, 20]) to find where the surface
    // actually IS — for example when a bendNode or tilingNode has moved the
    // geometry to a location unrelated to the primitive's posX/posY. If the
    // coarse search finds the surface we auto-adjust the bounds and proceed
    // with a full-resolution scan in the correct region.
    //
    // Only if the coarse search also fails do we emit a readable warning
    // and give up — at that point the geometry is genuinely invisible
    // (e.g. rDifference of two identical shapes = empty set).
    try {
      const [bMinX, bMinY, bMaxX, bMaxY] = bounds2D;
      const midX = (bMinX + bMaxX) / 2;
      const midY = (bMinY + bMaxY) / 2;

      const preflightProbes = [
        { x: midX,         y: midY,         z: 0 },
        { x: bMaxX * 0.7,  y: midY,         z: 0 },
        { x: bMinX * 0.7,  y: midY,         z: 0 },
        { x: midX,         y: bMaxY * 0.7,  z: 0 },
        { x: midX,         y: bMinY * 0.7,  z: 0 },
        { x: bMaxX * 0.7,  y: bMaxY * 0.7,  z: 0 },
        { x: bMinX * 0.7,  y: bMinY * 0.7,  z: 0 },
      ];

      const preflightValues = preflightProbes
        .map(p => { try { return sdfFn(p); } catch(_) { return null; } })
        .filter(v => v !== null && isFinite(v));

      if (preflightValues.length > 0) {
        const allPositive = preflightValues.every(v => v > 0);
        const allNegative = preflightValues.every(v => v < 0);

        if (allPositive || allNegative) {
          // No zero-crossing in current bounds — run coarse search
          logger.info(
            `renderSDF: surface not found within bounds [${bMinX},${bMinY}]→` +
            `[${bMaxX},${bMaxY}]. Running coarse search over [-20, 20]…`
          );

          const foundBounds = this._coarseSearchForSurface(sdfFn);

          if (foundBounds) {
            // Surface located — adopt the found region as the scan bounds
            const [fMinX, fMinY, fMaxX, fMaxY] = foundBounds;
            bounds2D = foundBounds;

            // Persist the found bounds to the Output node so the card
            // sliders reflect the actual scan area being used
            if (outputNode) {
              const newMin = Math.min(fMinX, fMinY);
              const newMax = Math.max(fMaxX, fMaxY);
              graph.updateNodeParam(outputNode.id, 'boundsMin', Math.floor(newMin - 0.5));
              graph.updateNodeParam(outputNode.id, 'boundsMax', Math.ceil(newMax  + 0.5));
            }

            logger.info(
              `renderSDF: surface found at ` +
              `[${fMinX.toFixed(2)}, ${fMinY.toFixed(2)}]→` +
              `[${fMaxX.toFixed(2)}, ${fMaxY.toFixed(2)}]. ` +
              `Bounds adjusted — re-rendering in correct region.`
            );
          } else {
            // Coarse search also found nothing — geometry is genuinely
            // invisible. Emit a plain-language explanation and continue
            // (the render will produce zero vertices, which is correct).
            if (allPositive) {
              logger.warn(
                'renderSDF: no visible surface found anywhere in [-20, 20]. ' +
                'The result may be geometrically empty — for example, ' +
                'rDifference of two identical shapes is always empty. ' +
                'Check that the shapes actually overlap for intersection ' +
                'or difference operations, and that the blend is wired correctly.'
              );
            } else {
              logger.warn(
                'renderSDF: shape fills the entire search area with no visible ' +
                'boundary. The SDF may not have a zero crossing — the shape ' +
                'may be extremely large or the operation may produce an ' +
                'always-negative result.'
              );
            }
            // Fall through — attempt the render anyway. The user may have
            // deliberately unusual geometry or custom bounds set elsewhere.
          }
        }
        // Mixed signs: surface is within current bounds — proceed normally.
      }
    } catch (_) {
      // Pre-flight check must never crash the render, regardless of SDF errors.
    }

    // ── Step 4: Render ────────────────────────────────────────────────────
    // Remove the previous rendered object if any, then build and add the new one.
    if (this.currentSchur) {
      this._removeFromScene(this.currentSchur);
      this.currentSchur = null;
    }

    // Read the resolution from the output node so the slider value is honoured.
    // Falls back to 150 if the output node does not exist yet (first render
    // before _ensureOutputWired has run) or has no resolution param.
    let _renderResolution = 150;
    const _graph = this.evaluator?.graph;
    if (_graph) {
      _graph.nodes.forEach(n => {
        if (n.type === 'outputNode' && n.params?.resolution !== undefined) {
          _renderResolution = n.params.resolution;
        }
      });
    }

    const threeObj = this._buildSchurObject(null, method, sdfFn, bounds2D, null, _renderResolution);
    const entry    = {
      instance: { computeSDF: sdfFn, family: 'region' },
      type:     'schur',
      object:   threeObj,
    };
    this.currentSchur = entry;
    this._addToScene(entry);
  }

  /**
 * Automatic adaptive render scale for Ray March mode.
 *
 * Measures actual frame render time and adjusts the WebGL canvas
 * resolution to maintain a target frame rate. Works transparently
 * without user intervention — the system finds the right balance
 * between quality and performance for each scene automatically.
 *
 * Called once per frame from _renderRayMarch() after the render completes.
 */
_adaptRenderScale() {
    const now = performance.now();

    // ── Warmup phase ───────────────────────────────────────────────────────
    // For the first WARMUP_FRAMES frames after entering Ray March mode,
    // do nothing — no measurement, no adaptation, no canvas resize.
    //
    // This covers:
    //   - The first-frame shader compilation stall (200-600ms on integrated
    //     Intel) which would otherwise register as an extreme slow frame and
    //     immediately trigger a scale drop + canvas resize + black flash.
    //   - Browser/driver warmup — WebGL contexts often run slower for the
    //     first few frames as GPU caches warm up, giving misleadingly high
    //     frame times that would cause premature scale reduction.
    //
    // During warmup the renderer runs at _currentScale (initialized to
    // WARMUP_SCALE in setRenderMode) — slightly below native to soften
    // the impact of the compilation frame without causing a visible flash.
    const WARMUP_FRAMES = 45; // ~1.5 seconds at 30fps — covers most compile times
    this._warmupCounter = (this._warmupCounter ?? 0) + 1;
    if (this._warmupCounter <= WARMUP_FRAMES) {
      this._lastFrameTime = now; // keep timestamp fresh so first real measurement is accurate
      return;
    }

    // ── Rolling average frame time ─────────────────────────────────────────
    // React to a rolling average of the last N frames rather than individual
    // frame times. This prevents single anomalous frames (garbage collection,
    // tab switching, OS interrupts) from triggering incorrect scale decisions.
    if (this._lastFrameTime === undefined) {
      this._lastFrameTime = now;
      return;
    }

    const frameMs = now - this._lastFrameTime;
    this._lastFrameTime = now;

    // Maintain a circular buffer of recent frame times
    if (!this._frameTimes) this._frameTimes = [];
    this._frameTimes.push(frameMs);
    const WINDOW = 8; // average over 8 frames (~quarter second at 30fps)
    if (this._frameTimes.length > WINDOW) this._frameTimes.shift();
    // Need a full window before making any decisions
    if (this._frameTimes.length < WINDOW) return;
    const avgMs = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;

    // ── Thresholds ─────────────────────────────────────────────────────────
    const SLOW_MS    = 48;  // wider dead-band — animated noise varies ±8ms naturally
    const RECOVER_MS = 22;  // only recover when clearly and consistently fast
    const SCALE_STEP_DOWN = 0.015; // smaller steps → less frequent canvas resize
    const SCALE_STEP_UP   = 0.008; // proportionally slower recovery
    const SCALE_MIN = 0.80;
    const SCALE_MAX = 1.0;
    // Number of consecutive WINDOW-averages that must be fast before recovering.
    // 20 windows × 8 frames = 160 frames ≈ ~5 seconds at 30fps.
    // Slow recovery prevents the oscillation cycle: drop → fast → recover →
    // slow → drop → flash that would otherwise repeat indefinitely.
    const STABLE_WINDOWS_TO_RECOVER = 20;

    const currentScale = this._currentScale ?? 1.0;

    if (avgMs > SLOW_MS && currentScale > SCALE_MIN) {
      // Average frame time is too slow — drop scale immediately.
      // No slow-frame counter needed here since we're already averaging
      // over 8 frames, which filters single-frame spikes naturally.
      const newScale = Math.max(SCALE_MIN, currentScale - SCALE_STEP_DOWN);
      if (Math.abs(newScale - currentScale) > 0.001) {
        this._currentScale = newScale;
        this._stableWindowCount = 0;
        if (this.rayMarchRenderer.setRenderScale) {
          this.rayMarchRenderer.setRenderScale(newScale);
        }
      }

    } else if (avgMs < RECOVER_MS && currentScale < SCALE_MAX) {
      // Average frame time is comfortably fast — count stable windows
      // before recovering scale upward.
      this._stableWindowCount = (this._stableWindowCount ?? 0) + 1;
      if (this._stableWindowCount >= STABLE_WINDOWS_TO_RECOVER) {
        const newScale = Math.min(SCALE_MAX, currentScale + SCALE_STEP_UP);
        if (Math.abs(newScale - currentScale) > 0.001) {
          this._currentScale = newScale;
          if (this.rayMarchRenderer.setRenderScale) {
            this.rayMarchRenderer.setRenderScale(newScale);
          }
        }
        this._stableWindowCount = 0;
      }
    } else {
      // Frame time is acceptable — reset stable counter but keep scale
      this._stableWindowCount = 0;
    }
  }

  /**
   * Estimate scene rendering complexity from the graph node structure.
   * Returns an appropriate starting render scale in [0.80, 0.92].
   * Heavy scenes start lower so the adaptive system finds equilibrium
   * faster with less visible jerkiness during the transition period.
   * Called once when entering Ray March mode.
   */
  _estimateSceneComplexity() {
    const graph = this.glslEvaluator?.graph ?? stateStore.nodeGraph;
    let weight = 0;

    graph.nodes.forEach(n => {
      switch (n.type) {
        case 'symmetryOrbitNode':
          weight += (n.params?.folds ?? 6) * 2;
          break;
        case 'symmetryFoldNode':
          weight += (n.params?.folds ?? 6);
          break;
        case 'noiseDisplaceNode':
          weight += n.params?.animated === 'yes' ? 4 : 2;
          break;
        case 'schurBlend':
          weight += 2;
          break;
        case 'rDifference':
          weight += 3;
          break;
        case 'repeatNode':
          weight += (n.params?.countX ?? 3) * (n.params?.countY ?? 3);
          break;
        case 'torus': case 'capsule':
          weight += 1;
          break;
        default:
          break;
      }
    });

    if (weight > 40) return 0.80;
    if (weight > 25) return 0.84;
    if (weight > 12) return 0.88;
    return 0.92;
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
   * Analyse the given GLSL source string once and apply the correct
   * sphere-tracing quality settings. Called only when the source changes
   * (graph edit, node add/remove, param change that affects the shader),
   * never on every animation frame.
   *
   * Previously this analysis ran inside _renderRayMarch() on every frame,
   * which caused mid-orbit recompilation whenever targetMaxSteps changed —
   * the single biggest source of "freeze then lurch" choppiness during
   * auto-orbit on integrated graphics.
   *
   * @param {string} source  The GLSL source string from GLSLEvaluator
   */
  _applyRayMarchQualityForSource(source) {
    const hasDifference = source.includes('rDifference(') ||
      (source.includes('schurBlend') && source.includes('"difference"'));

    const hasWarp = !hasDifference && (
      source.includes('twistNode')        ||
      source.includes('bendNode')         ||
      source.includes('noiseDisplaceNode')||
      source.includes('mobiusNode')       ||
      source.includes('symmetryOrbit')
    );

    let targetMaxSteps, targetStepScale, targetEpsilon, targetMaxDist;
    if (hasDifference) {
      targetMaxSteps  = 256;
      targetStepScale = 0.25;
      targetEpsilon   = 0.0001;
      targetMaxDist   = 80.0;
    } else if (hasWarp) {
      targetMaxSteps  = 192;
      targetStepScale = 0.55;
      targetEpsilon   = 0.0005;
      targetMaxDist   = 40.0;
    } else {
      targetMaxSteps  = 128;
      targetStepScale = 0.85;
      targetEpsilon   = 0.001;
      targetMaxDist   = 30.0;
    }

    // Only force recompile if maxSteps actually changed — this is the
    // only quality parameter baked into the GLSL loop bound. All other
    // parameters are uniforms uploaded each frame with no recompile needed.
    if (this.rayMarchRenderer._maxSteps !== targetMaxSteps) {
      this.rayMarchRenderer._maxSteps = targetMaxSteps;
      this._lastRayMarchSource = null;  // force recompile with new loop bound
    }
    this.rayMarchRenderer._stepScale = targetStepScale;
    this.rayMarchRenderer._epsilon   = targetEpsilon;
    this.rayMarchRenderer._maxDist   = targetMaxDist;
  }
  
  /**
   * Switch between 'marchingSquares' and 'glsl' render modes.
   * Toggles visibility of the Three.js canvas and the SDFRenderer canvas.
   * @param {'marchingSquares'|'glsl'} mode
   */
  setRenderMode(mode) {
    this.renderMode = mode;

    // Force shader recompile on every mode switch
    this._lastGLSLSource     = null;
    this._lastRayMarchSource = null;

    // Mark both render paths dirty so the loop renders at least one frame
    // in the new mode immediately after switching.
    this._glslDirty      = true;
    this._rayMarchDirty  = true;

    // Reset camera key caches so the first frame after a mode switch
    // always renders regardless of camera position.
    this._lastGLSLCamKey = null;
    this._lastRMCamKey   = null;

    // Reset adaptive render scale state when entering Ray March mode.
    if (mode === 'rayMarch') {
      // Start at WARMUP_SCALE rather than 1.0. This serves two purposes:
      //   1. The first frame (shader compilation) won't look like a full
      //      resolution frame that then abruptly drops — it starts slightly
      //      reduced and only the user who's looking carefully would notice.
      //   2. Integrated Intel graphics will immediately get some relief from
      //      the very first rendered frame, rather than starting at full
      //      resolution and thrashing down to a working scale over the first
      //      few seconds.
      // The warmup counter suppresses adaptation for the first ~1.5 seconds,
      // so this initial scale persists quietly until the GPU has settled.
      // If the GPU is fast enough, recovery begins after ~5 more seconds
      // and the scale climbs gradually back toward 1.0.
      const WARMUP_SCALE = this._estimateSceneComplexity();
      this._currentScale      = WARMUP_SCALE;
      this._lastFrameTime     = undefined;
      this._stableWindowCount = 0;
      this._warmupCounter     = 0;
      this._frameTimes        = [];
      if (this.rayMarchRenderer.setRenderScale) {
        this.rayMarchRenderer.setRenderScale(WARMUP_SCALE);
      }
    } else {
      // Restore native resolution when leaving Ray March mode so GLSL
      // and Marching Squares modes are not affected by a reduced scale.
      this._currentScale  = 1.0;
      this._warmupCounter = 0;
      this._frameTimes    = [];
      if (this.rayMarchRenderer.setRenderScale) {
        this.rayMarchRenderer.setRenderScale(1.0);
      }
    }

    const threeCanvas = this.renderer?.domElement;

    // Hide all GPU canvases first, then show the correct one
    this.sdfRenderer.hide();
    this.rayMarchRenderer.hide();

    if (mode === 'glsl') {
      // 2D GLSL mode: Three.js canvas hidden, GLSL canvas shown
      if (threeCanvas) {
        threeCanvas.style.opacity       = '0';
        threeCanvas.style.pointerEvents = 'none';
      }
      this.sdfRenderer.show();

    } else if (mode === 'rayMarch') {
      // 3D ray march mode: Three.js canvas hidden, ray march canvas shown.
      // OrbitControls is attached to the mount element (not the canvas)
      // so camera orbit works regardless of canvas visibility.
      if (threeCanvas) {
        threeCanvas.style.opacity       = '0';
        threeCanvas.style.pointerEvents = 'none';
      }
      this.rayMarchRenderer.show();

    } else {
      // marchingSquares: Three.js canvas fully visible
      if (threeCanvas) {
        threeCanvas.style.opacity       = '1';
        threeCanvas.style.pointerEvents = 'auto';
      }
    }
  }

  /**
   * Compile and render the current node graph using the GLSL pipeline.
   * Called by the animation loop on every frame when renderMode === 'glsl',
   * and explicitly after a compose or param change in GLSL mode.
   *
   * _graphIsRenderable() is checked first so that frames where the graph
   * is empty or incompletely wired exit immediately with no computation
   * and no console output. The warning below only fires when the graph
   * is fully wired but generation still returned nothing — which is a
   * genuine unexpected condition worth reporting.
   */
  _renderGLSL() {
    // Mark dirty so the animation loop knows to render on its next tick
    // if this was called externally (param change, preset load, etc.).
    // When called from within _loop() itself, the loop clears the flag
    // immediately after — so setting it here is a no-op in that path.
    this._glslDirty = true;

    const time = (performance.now() - this._startTime) / 1000;

    // Exit silently if the graph is in any state where generation cannot
    // produce meaningful output (no nodes, no output node, output unwired).
    // This prevents the animation loop from calling generate() and emitting
    // a warning on every frame when the graph is empty — a situation that
    // occurs normally after stateStore.clear() or mid-construction.
    if (!this._graphIsRenderable()) return;

    const { source, uniforms, rootFn } = this.glslEvaluator.generate(time, '2d');

    if (!source || !rootFn) {
      // _graphIsRenderable() confirmed the graph is wired, so a null result
      // from generate() is unexpected. This indicates an unsupported node
      // type, a broken evaluator path, or a graph structure that the GLSL
      // evaluator cannot currently handle.
      console.warn(
        'SDFRenderer: graph is wired but GLSLEvaluator produced no source. ' +
        'Check that all nodes between the geometry and the output node are ' +
        'of supported types and that their ports are correctly connected.'
      );
      return;
    }

    // Only recompile if the source has changed since the last frame.
    // Recompilation is expensive; skipping it when the source is identical
    // keeps the frame rate stable when the graph is not being edited.
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
   * Called by the animation loop on every frame when renderMode === 'rayMarch'.
   *
   * _graphIsRenderable() is checked before any call to generate() so that
   * frames where the graph is empty or incompletely wired produce no output
   * and no console noise. The warning block below this check only fires
   * when the graph is fully wired but 3D generation still returned nothing,
   * which is a genuine unexpected condition worth surfacing.
   *
   * Step quality is adapted automatically based on which SDF operations
   * appear in the generated source string. Non-Lipschitz operations (rDifference,
   * space-warping transforms) require smaller step sizes and more iterations
   * than clean union/intersection scenes. The required maxSteps value is baked
   * into the GLSL loop bound, so changes to it force a full shader recompile.
   */
    _renderRayMarch() {
    // Mark dirty so the animation loop knows to render on its next tick
    // if this was called externally (param change, preset load, etc.).
    this._rayMarchDirty = true;

    const time = (performance.now() - this._startTime) / 1000;

    // Exit silently if the graph has no nodes, no output node, or the
    // output node has no incoming connections. All three are expected states
    // that occur during normal operation and should not produce console output.
    // Without this guard the animation loop calls generate() and emits a
    // warning on every frame (~60 fps) whenever the graph is empty —
    // for example after stateStore.clear() or while the user has not yet
    // wired any geometry to the output node.
    if (!this._graphIsRenderable()) return;

    const { source, uniforms, rootFn } = this.glslEvaluator.generate(time, '3d');

    if (!source || !rootFn) {
      // _graphIsRenderable() confirmed the graph is wired, so a null result
      // from generate() is unexpected. Likely causes: a node type in the
      // graph is not supported in 3D mode, or the 3D GLSL template for a
      // transform or blend type has not yet been implemented.
      console.warn(
        'RayMarchRenderer: graph is wired but GLSLEvaluator produced no 3D source. ' +
        'Check that all nodes in the graph are supported in 3D ray march mode ' +
        'and that their ports are correctly connected to the output node.'
      );
      return;
    }

    // ── Apply quality settings and compile if source changed ─────────────
    // Quality analysis (_applyRayMarchQualityForSource) only runs when the
    // source string actually changed — never on every frame. This prevents
    // mid-orbit recompilation which was the primary cause of choppiness
    // during auto-orbit with animated noise nodes.
    if (source !== this._lastRayMarchSource) {
      this._applyRayMarchQualityForSource(source);
      // _applyRayMarchQualityForSource may have nulled _lastRayMarchSource
      // if maxSteps changed — check again after calling it.
      if (source !== this._lastRayMarchSource) {
        const result = this.rayMarchRenderer.compile(source);
        if (!result.ok) {
          console.error('RayMarchRenderer compile error:\n', result.error);
          return;
        }
        this._lastRayMarchSource = source;
        logger.info('RayMarchRenderer: shader compiled.');
      }
    }

    this.rayMarchRenderer.syncCamera(this.camera, this.controls);
    this.rayMarchRenderer.render(uniforms, time);

    // Automatically adapt render resolution to maintain ~30fps.
    // Runs every frame in Ray March mode — drops scale when slow,
    // gradually recovers when fast. Transparent to the user.
    this._adaptRenderScale();
  }

  rerender(method, sdfOverride = null) {
    if (this.renderMode === 'glsl') {
      this._renderGLSL();
      return;
    }

    if (!this.currentSchur) return;

    this._removeFromScene(this.currentSchur);

    // Read resolution from the output node so the slider is honoured on
    // re-renders triggered by param changes (e.g. moving a shape).
    let _rerenderResolution = 150;
    const _graph = this.evaluator?.graph;
    if (_graph) {
      _graph.nodes.forEach(n => {
        if (n.type === 'outputNode' && n.params?.resolution !== undefined) {
          _rerenderResolution = n.params.resolution;
        }
      });
    }

    const threeObj = this._buildSchurObject(
      this.currentSchur.instance,
      method,
      sdfOverride,
      null,
      null,
      _rerenderResolution
    );
    this.currentSchur.object = threeObj;
    this._addToScene(this.currentSchur);
  }

  /**
   * Reconstruct a primitive instance and Three.js mesh from a serialized
   * node graph entry. Used by the load handler to restore visual objects
   * after graph.deserialize() has restored the node structure.
   *
   * Unlike addPrimitive(), this uses the node's existing ID (forceId) so
   * that edges in the restored graph continue to point at valid nodes.
   *
   * @param {object} node  A NodeInstance from the restored NodeGraph
   * @returns {{ instance, type, object }|null}
   */
  _rebuildPrimitiveFromNode(node) {
    const p  = node.params;
    const id = node.id;
    let prim, type, object;

    switch (node.type) {
      case 'circle': {
        prim = new CirclePrimitive({ id, radius: p.radius ?? 1, posX: p.posX ?? 0, posY: p.posY ?? 0 });
        type = 'circle';
        break;
      }
      case 'regularPolygon': {
        prim = new RegularPolygonPrimitive({ id, sides: p.sides ?? 6, size: p.size ?? 1, rotation: p.rotation ?? 0, posX: p.posX ?? 0, posY: p.posY ?? 0 });
        type = 'regularPolygon';
        break;
      }
      case 'polytope': {
        prim = new PolytopePrimitive({ id, vertices: p.vertices, posX: p.posX ?? 0, posY: p.posY ?? 0, rotation: p.rotation ?? 0 });
        type = 'polytope';
        break;
      }
      case 'sphere': {
        prim = new SpherePrimitive({ id, radius: p.radius ?? 1, posX: p.posX ?? 0, posY: p.posY ?? 0, posZ: p.posZ ?? 0 });
        type = 'sphere';
        break;
      }
      case 'box': {
        prim = new BoxPrimitive({ id, width: p.width ?? 2, height: p.height ?? 2, depth: p.depth ?? 2, posX: p.posX ?? 0, posY: p.posY ?? 0, posZ: p.posZ ?? 0 });
        type = 'box';
        break;
      }
      case 'cylinder': {
        prim = new CylinderPrimitive({
          id,
          radius: p.radius ?? 1,
          height: p.height ?? 2,
          capped: p.capped !== 'no',
          axis:   p.axis   ?? 'Y',
          posX:   p.posX   ?? 0,
          posY:   p.posY   ?? 0,
          posZ:   p.posZ   ?? 0,
        });
        type = 'cylinder';
        break;
      }
      case 'capsule': {
      prim = new CapsulePrimitive({
        id,
        radius: p.radius ?? 0.5,
        height: p.height ?? 2,
        posX:   p.posX   ?? 0,
        posY:   p.posY   ?? 0,
        posZ:   p.posZ   ?? 0,
      });
      type = 'capsule';
      break;
    }
      case 'torus': {
        prim = new TorusPrimitive({ id, majorRadius: p.majorRadius ?? 2, minorRadius: p.minorRadius ?? 0.5, posX: p.posX ?? 0, posY: p.posY ?? 0, posZ: p.posZ ?? 0 });
        type = 'torus';
        break;
      }
      case 'cone': {
        prim = new ConePrimitive({
          id,
          radius: p.radius ?? 1,
          height: p.height ?? 2,
          axis:   p.axis   ?? 'Y',
          posX:   p.posX   ?? 0,
          posY:   p.posY   ?? 0,
          posZ:   p.posZ   ?? 0,
        });
        type = 'cone';
        break;
      }
      case 'plane': {
        prim = new InfinitePlanePrimitive({ id, nx: p.nx ?? 0, ny: p.ny ?? 1, nz: p.nz ?? 0, offset: p.offset ?? 0 });
        type = 'plane';
        break;
      }
      default:
        return null;
    }

    // Register in stateStore (so the evaluator can find it by ID)
    stateStore.addShape(prim);

    // Create Three.js mesh proxy
    object = prim.createObject();

    return { instance: prim, type, object };
  }

  /**
   * Register a newly created primitive as a node in the node graph.
   * Uses forceId so the node graph ID matches the primitive instance ID,
   * allowing graph.addEdge(prim.id, ...) to work directly.
   * @param {SolidPrimitive|RegionPrimitive} prim
   * @param {string} nodeType  The NODE_TYPES key e.g. 'circle', 'sphere'
   * @param {object} params    The node params (mirrors prim properties)
   */
  _registerPrimInGraph(prim, nodeType, params, uiPos = { x: 0, y: 0 }) {
    const graph = stateStore.nodeGraph;
    // Only register if not already present (idempotent)
    if (!graph.nodes.has(prim.id)) {
      graph.addNode(nodeType, { ...params, ...extraParams }, uiPos, prim.id);
    }
  }


  
  /**
   * Returns true only when the graph is in a state where GLSL generation
   * is worth attempting — meaning an output node exists AND has at least
   * one incoming connection on its 'sdf' port.
   *
   * This method is called at the top of _renderGLSL() and _renderRayMarch()
   * before any call to glslEvaluator.generate(). Both of those methods are
   * called by the animation loop on every frame (~60 fps). Without this
   * guard, every frame where the graph is empty or incompletely wired would
   * call generate(), get nothing back, and emit a console warning — producing
   * hundreds of warnings per second during normal states such as canvas
   * cleared, mid-construction, or right after stateStore.clear().
   *
   * The check intentionally costs very little: two Map iterations and a
   * single array-length check. It returns early as soon as any condition
   * fails, so the common empty-graph case exits after the first check.
   *
   * Four distinct graph states and their expected behaviour:
   *
   *   State 1 — graph has no nodes at all.
   *     The canvas was just cleared or the app just started.
   *     Expected: silent return, no warning. This is normal.
   *
   *   State 2 — graph has nodes but no output node.
   *     The user has added primitives or blends but has not yet added
   *     (or the load path has not yet created) an output node.
   *     Expected: silent return, no warning. Still normal mid-construction.
   *
   *   State 3 — output node exists but its 'sdf' port has no incoming edges.
   *     The user has added a primitive and an output node but has not yet
   *     connected them.
   *     Expected: silent return, no warning. Still normal mid-construction.
   *
   *   State 4 — output node exists AND has at least one incoming sdf edge.
   *     The graph is fully wired. Generation should succeed.
   *     If generate() still returns null, something is wrong with the
   *     evaluator or with the node types in the graph. In this state only
   *     does the caller emit a warning.
   *     Expected: attempt generation; warn if it returns nothing.
   *
   * @returns {boolean}
   */
  _graphIsRenderable() {
    // Always read from the evaluator's current graph reference so this check
    // sees the same graph that generate() will read from.
    const graph = this.glslEvaluator?.graph ?? stateStore.nodeGraph;

    // State 1: no graph object at all, or graph has zero nodes.
    if (!graph || graph.nodes.size === 0) return false;

    // State 2: locate the output node.
    let outputNode = null;
    graph.nodes.forEach(node => {
      if (node.type === 'outputNode') outputNode = node;
    });
    if (!outputNode) return false;

    // State 3: output node exists but has no incoming sdf connections.
    // getAllIncomingEdges returns every edge whose toPort matches 'sdf'
    // and whose toNode matches the output node id. An empty result means
    // no geometry has been wired to the output yet.
    const incoming = graph.getAllIncomingEdges?.(outputNode.id, 'sdf') ?? [];
    if (incoming.length === 0) return false;

    // State 4: output node is present and wired — generation is warranted.
    return true;
  }

  /**
   * Returns true if the node graph contains at least one 3D geometry node
   * or a bridge node (extrude/revolve) that produces 3D output.
   * Used by the export panel to decide whether to enable the STL button.
   */
  _sceneHas3D() {
    const TYPES_3D = new Set([
      'sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane',
      'extrudeNode', 'revolveNode',
    ]);
    let found = false;
    stateStore.nodeGraph.nodes.forEach(n => {
      if (TYPES_3D.has(n.type)) found = true;
    });
    return found;
  }

  /**
   * Read the output node's boundsMin/boundsMax AND placement params
   * (posX/Y/Z, rotateX/Y/Z), and return effective world-space scan bounds
   * for marching squares (2D) or marching cubes / ray march (3D).
   *
   * Bounds are shifted by the placement translation exactly, and expanded
   * to a bounding sphere if any rotation is present — this guarantees that
   * geometry repositioned via the output drawer's placement sliders is
   * never clipped during rendering or STL export.
   *
   * @param {'2d'|'3d'} dims
   * @returns {number[]}
   *   2D: [minX, minY, maxX, maxY]
   *   3D: [minX, minY, minZ, maxX, maxY, maxZ]
   */
  _getEffectiveBounds(dims) {
    let outputNode = null;
    this.evaluator?.graph?.nodes?.forEach(n => {
      if (n.type === 'outputNode') outputNode = n;
    });
    const p    = outputNode?.params ?? {};
    const bMin = p.boundsMin ?? -4;
    const bMax = p.boundsMax ??  4;

    if (dims === '3d') {
      const b = computeWorldBounds3D(bMin, bMax, p);
      if (b.expanded) {
        logger.info(
          'Render bounds expanded to cover rotation from the output ' +
          'placement transform — effective resolution will appear coarser.'
        );
      }
      return [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];
    } else {
      const b = computeWorldBounds2D(bMin, bMax, p);
      if (b.expanded) {
        logger.info(
          'Render bounds expanded to cover rotation from the output ' +
          'placement transform — effective resolution will appear coarser.'
        );
      }
      return [b.minX, b.minY, b.maxX, b.maxY];
    }
  }

  /**
   * Export the current scene as a binary STL file for 3D printing.
   *
   * Process:
   *   1. Get the root SDF from the CPU evaluator (same path as marching squares).
   *   2. Determine 3D scan bounds from the output node or fall back to [-4,4]³.
   *   3. Run marching cubes at the requested resolution to extract a triangle mesh.
   *   4. Encode the mesh as binary STL.
   *   5. Trigger a browser download.
   *
   * Why CPU evaluator not GLSL:
   *   The CPU evaluator supports every node type including mapper nodes.
   *   GLSL source is generated but not easily sampled from JavaScript.
   *   The CPU path is the correct choice for mesh extraction.
   *
   * Resolution guide (passed as parameter from the UI):
   *   64  — fast, suitable for previewing printability (~262k cells)
   *   96  — good balance for most scenes
   *   128 — high detail, may take 2-5 seconds on complex scenes (~2M cells)
   *
   * @param {number} resolution   Cells per axis (default 64)
   * @param {Function} onProgress Optional callback(fraction 0-1) for progress
   */
  async _exportSTL(resolution = 64, onProgress = null) {
    // ── Step 1: get root SDF ──────────────────────────────────────────────
    this.evaluator.invalidate();
    let sdfFn = null;
    try {
      sdfFn = this.evaluator.getRootSDF();
    } catch(e) {
      console.error('STL export: evaluator error:', e.message);
      return { ok: false, error: e.message };
    }

    if (!sdfFn) {
      return { ok: false, error: 'No renderable SDF found. Wire geometry to the output node first.' };
    }

    // ── Step 2: determine 3D scan bounds ─────────────────────────────────
    // Effective bounds already account for the output placement transform
    // (translation shift, rotation expansion) via _getEffectiveBounds.
    // Add a small margin on top so surface features at the exact boundary
    // are captured.
    const [ex0, ey0, ez0, ex1, ey1, ez1] = this._getEffectiveBounds('3d');
    const margin = (ex1 - ex0) * 0.05;
    const bounds = [
      ex0 - margin, ey0 - margin, ez0 - margin,
      ex1 + margin, ey1 + margin, ez1 + margin,
    ];

    // ── Step 3: run marching cubes ────────────────────────────────────────
    // This is synchronous and can take 1-5 seconds for high resolutions.
    // We use a setTimeout(0) to let the UI update (show the toast) before
    // the blocking computation starts.
    let triangles;
    try {
      triangles = marchingCubes(sdfFn, bounds, resolution);
    } catch(e) {
      console.error('STL export: marching cubes error:', e.message);
      return { ok: false, error: e.message };
    }

    if (triangles.length === 0) {
      return { ok: false, error: 'No surface found within the scan bounds. Try widening the scan bounds in Render Settings.' };
    }

    // ── Step 4: encode as binary STL ─────────────────────────────────────
    let buffer;
    try {
      buffer = trianglesToSTL(triangles);
    } catch(e) {
      console.error('STL export: serialisation error:', e.message);
      return { ok: false, error: e.message };
    }

    // ── Step 5: download ──────────────────────────────────────────────────
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `isoline-${ts}.stl`;
    downloadSTL(buffer, filename);

    const sizeKB   = Math.round(buffer.byteLength / 1024);
    const triCount = triangles.length;
    console.info(
      `STL export complete: ${triCount.toLocaleString()} triangles, ` +
      `${sizeKB.toLocaleString()} KB → ${filename}`
    );

    return { ok: true, triangles: triCount, sizeKB, filename };
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
      }, { x: 1400, y: 200 });
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