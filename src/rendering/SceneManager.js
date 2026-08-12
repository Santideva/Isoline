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
import { computeWorldBounds2D, computeWorldBounds3D, applyForwardTransform3D, applyInverseTransform3D } from "../utils/transform3D.js";
import { raymarchToSurface, fibonacciSphereSamples, epsilonForScale, computeLocalFrame, snapToNearestSurface, computeNormal3D, computePrincipalCurvatures3D, computeShapeOperator2x2 } from "../utils/differentialGeometry.js";
import { OrbitGenerators, sphericalToDir } from "./orbitGenerators.js";
import { buildSurfaceGraph, dijkstraGeodesic, curvatureFlood, bakeGeodesicSamples, bakeCurvatureFloodSamples } from "../utils/surfaceGraph.js";
import { decimateSamples, MAX_MASK_SAMPLES, createEmptyMask } from "../utils/surfaceMask.js";


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

    // ── Gizmo overlay (Phase 5d) ──────────────────────────────────────────
    // A plain 2D canvas drawn on top of whichever render canvas is active.
    // Replaces the old THREE.js-scene-based pivot gizmo, which only ever
    // rendered in Marching Squares mode (the Three.js scene is hidden via
    // opacity:0 in GLSL/Ray March mode, taking anything living inside it —
    // including the gizmo — invisible along with it). Since this overlay
    // is drawn fresh every frame by projecting world points through the
    // CURRENT camera, using plain 2D canvas draw calls rather than Three.js
    // scene objects, it works identically regardless of render mode.
    this._gizmoOverlay = document.createElement('canvas');
    this._gizmoOverlay.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 50;
    `;
    mountElement.appendChild(this._gizmoOverlay);
    this._gizmoNodeId       = null; // node currently showing a pivot gizmo, or null
    this._snapHighlightWorld = null; // {x,y,z} world point of an active snap highlight, or null
    this._embedRegionNodeId = null; // embedNode currently showing its anchor+region ring, or null
    this._paintPreviewNodeId = null; // node currently showing its painted-region dot overlay, or null
    this._resizeGizmoOverlay();

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

        // ── Ambi-Anamorph orbit camera (V1) ─────────────────────────────────
        this._orbitActive       = false;
        this._orbitGeneratorKey = 'circular';
        this._orbitParams       = { speed: 0.3 };
        this._orbitStartTime    = 0;
        this._curvatureInterestMap = null; // computed on demand, not per-frame
        this._boundingSphereCache = null;
        this._boundingSphereCacheCounter = 0;

        // Stop the orbit the moment the user manually drags — mirrors
        // OrbitControls.autoRotate's free "any drag interrupts" behavior,
        // which we lose by driving camera.position directly instead of
        // through autoRotate (autoRotate can only do fixed-axis circular
        // motion, so it can't express spiral/Lissajous/curvature-guided).
        this.controls.addEventListener('start', () => {
          if (this._orbitActive) this.stopOrbit();
        });

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

    this._applyNodeTransformToMesh(entry.instance.id, entry.object);
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
    this._applyNodeTransformToMesh(shapeId, entry.object);
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

    this._updateOrbit();
    this.controls.update();
    this._drawGizmoOverlay();

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

      if (camMoved || this._glslDirty || this._sceneHasAnimatedNodes()) {
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

      if (camMoved || this._rayMarchDirty || this._sceneHasAnimatedNodes()) {
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
  /**
   * Renamed from _sceneHasAnimatedNoise (see call sites below). Generalized
   * to check ANY node's 'animated' param rather than only noiseDisplaceNode
   * — this was the actual root cause of morph/sinusoidal animations
   * appearing to freeze: the render loop only kept re-rendering (absent
   * camera movement) when this check returned true, and it never looked
   * at morphBlend or sinusoidalMapper's own 'animated' flags. A generic
   * check is also future-proof against any node added later that gains
   * its own 'animated' param.
   */
  _sceneHasAnimatedNodes() {
    if (this._animatedNoiseFrame !== undefined &&
        this._animatedNoiseCounter < 30) {
      this._animatedNoiseCounter++;
      return this._animatedNoiseCached;
    }
    this._animatedNoiseCounter = 0;

    const graph = this.glslEvaluator?.graph ?? stateStore.nodeGraph;
    let found = false;
    graph.nodes.forEach(n => {
      if (n.params?.animated === 'yes') found = true;
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

  /**
   * Apply a node's transform (posX/Y/Z, pivotX/Y/Z, rotateX/Y/Z, scale) to
   * its Three.js preview mesh, so the wireframe proxy shown in the
   * viewport always matches where the SDF actually places the shape.
   *
   * Mirrors the exact same forward composition used by the SDF math
   * (NodeEvaluator._applyNodeTransform / GLSLEvaluator's per-node wrapper):
   *   world = T(pos) · T(pivot) · R·S · T(-pivot) · local
   *
   * Silently does nothing if there's no matching graph node (e.g. this is
   * called on a fully-composed render-result mesh from renderSDF(), which
   * is already fully resolved in world space by the SDF sampling and must
   * NOT be transformed again).
   *
   * @param {number} nodeId
   * @param {THREE.Object3D} object3D
   */
  _applyNodeTransformToMesh(nodeId, object3D) {
    if (!object3D) return;
    const node = stateStore.nodeGraph.nodes.get(nodeId);
    const t = node?.transform;
    if (!t) return;

    object3D.position.set(0, 0, 0);
    object3D.quaternion.identity();
    object3D.scale.set(1, 1, 1);
    object3D.updateMatrix();

    const pivot    = new THREE.Vector3(t.pivotX ?? 0, t.pivotY ?? 0, t.pivotZ ?? 0);
    const euler    = new THREE.Euler(t.rotateX ?? 0, t.rotateY ?? 0, t.rotateZ ?? 0, 'XYZ');
    const quat     = new THREE.Quaternion().setFromEuler(euler);
    const scaleVal = t.scale ?? 1;
    const pos      = new THREE.Vector3(t.posX ?? 0, t.posY ?? 0, t.posZ ?? 0);

    const negPivot = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const rs       = new THREE.Matrix4().compose(
      new THREE.Vector3(), quat, new THREE.Vector3(scaleVal, scaleVal, scaleVal)
    );
    const toPivot  = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    const toPos    = new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z);

    const full = new THREE.Matrix4()
      .multiply(toPos)
      .multiply(toPivot)
      .multiply(rs)
      .multiply(negPivot);

    object3D.applyMatrix4(full);
  }

  /**
   * Show a marker at a node's pivot WORLD position, plus a dashed
   * connector line to the shape's local-origin's CURRENT world position.
   * Together these make the effect of pivot comprehensible even though
   * pivot alone (no rotation/scale) produces no shape movement:
   *   - the marker shows WHERE the fixed point is
   *   - the connector line shows the lever-arm relationship, and visibly
   *     swings/stretches as rotation/scale sliders move, making the
   *     "rotate around this point" effect legible as you drag.
   *
   * Pivot marker world position: position + pivot (see transform3D.js
   * header derivation — this is the one local point the transform holds
   * fixed under rotation/scale).
   * Connector endpoint: applyForwardTransform3D({x:0,y:0,z:0}, t) — the
   * shape's own local origin mapped forward into world space, which DOES
   * move under rotation/scale, unlike the pivot point itself.
   */
  showPivotGizmo(nodeId) {
    this._gizmoNodeId = nodeId;
    this._drawGizmoOverlay();
  }

  hidePivotGizmo() {
    this._gizmoNodeId = null;
    this._drawGizmoOverlay();
  }

  /**
   * Draw the pivot gizmo (marker + dashed connector) and any active snap
   * highlight onto the 2D overlay canvas, by projecting their world-space
   * points through the CURRENT camera. Called every animation frame
   * (cheap — plain 2D canvas draws, no shader/scene involvement) so it
   * stays correct as the camera orbits, regardless of which render mode
   * (marchingSquares / glsl / rayMarch) is currently active.
   */
  _drawGizmoOverlay() {
    const canvas = this._gizmoOverlay;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Same staleness concern as pickNodeAtScreenPosition/findNearestSnapPoint —
    // ensure matrices are current before projecting.
    this.camera.updateMatrixWorld(true);

    const project = (worldPt) => {
      const v = new THREE.Vector3(worldPt.x, worldPt.y, worldPt.z).project(this.camera);
      if (v.z > 1 || v.z < -1) return null; // behind camera
      return { x: (v.x * 0.5 + 0.5) * canvas.width, y: (-v.y * 0.5 + 0.5) * canvas.height };
    };

    if (this._gizmoNodeId !== null) {
      const node = stateStore.nodeGraph.nodes.get(this._gizmoNodeId);
      const t = node?.transform;
      if (t) {
        const pivotWorld  = { x: (t.posX??0)+(t.pivotX??0), y: (t.posY??0)+(t.pivotY??0), z: (t.posZ??0)+(t.pivotZ??0) };
        const originWorld = applyForwardTransform3D({ x: 0, y: 0, z: 0 }, t);
        const pScreen = project(pivotWorld);
        const oScreen = project(originWorld);

        if (pScreen && oScreen) {
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = 'rgba(127,119,221,0.85)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(pScreen.x, pScreen.y);
          ctx.lineTo(oScreen.x, oScreen.y);
          ctx.stroke();
        }
        if (pScreen) {
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(127,119,221,0.95)';
          ctx.beginPath();
          ctx.arc(pScreen.x, pScreen.y, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (this._snapHighlightWorld) {
      const s = project(this._snapHighlightWorld);
      if (s) {
        ctx.fillStyle = 'rgba(255,204,51,0.95)';
        ctx.beginPath();
        ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this._embedRegionNodeId !== null) {
      this._drawEmbedRegionOverlay(ctx, project);
    }

    if (this._paintPreviewNodeId !== null) {
      this._drawPaintPreviewOverlay(ctx, project);
    }
  }

  /**
   * Live visual feedback for the universal Surface Region paint tool —
   * projects each of a node's baked mask.samples to screen space and
   * draws a small dot, so the user can see what's selected regardless of
   * whether anything currently consumes the mask (a masked mapper, or an
   * embedNode using paintedRegion). Deliberately simple — reuses the same
   * world→screen projection helper _drawGizmoOverlay already builds for
   * the pivot gizmo and embed-region ring, adding no new rendering path.
   */
  _drawPaintPreviewOverlay(ctx, project) {
    const node = stateStore.nodeGraph.nodes.get(this._paintPreviewNodeId);
    const samples = node?.mask?.samples;
    if (!Array.isArray(samples) || samples.length === 0) return;

    const t = node.transform;
    const worldPoints = samples.map(s => {
      const w = applyForwardTransform3D(s, t);
      return { world: w, screen: project(w), sample: s };
    });

    // Connecting lines between consecutive points ONLY in 'euclidean'
    // (live-drag) mode, where consecutive samples genuinely are a path —
    // see evaluateMaskAt's identical distinction in surfaceMask.js. Once
    // baked to geodesic/curvatureFlood, samples represent an AREA with no
    // meaningful point-to-point path, so lines there would look like
    // random noise rather than a stroke.
    if (node.mask.mode === 'euclidean' && worldPoints.length >= 2) {
      ctx.strokeStyle = 'rgba(80,220,220,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      worldPoints.forEach(({ screen }) => {
        if (!screen) return;
        if (!started) { ctx.moveTo(screen.x, screen.y); started = true; }
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(80,220,220,0.75)';
    worldPoints.forEach(({ screen, sample }) => {
      if (!screen) return;
      const r = 2.5 + 3 * (sample.w ?? 1);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Show/hide the paint-region dot overlay for a given node. */
  showPaintPreview(nodeId) {
    this._paintPreviewNodeId = nodeId;
    this._drawGizmoOverlay();
  }

  hidePaintPreview() {
    this._paintPreviewNodeId = null;
    this._drawGizmoOverlay();
  }

  showEmbedRegion(nodeId) {
    this._embedRegionNodeId = nodeId;
    this._drawGizmoOverlay();
  }

  hideEmbedRegion() {
    this._embedRegionNodeId = null;
    this._drawGizmoOverlay();
  }

  /**
   * Draw a translucent ring at an embedNode's (self-corrected) anchor,
   * sized to regionSize, oriented in the host's local tangent plane at
   * that point — the actual visual answer to "what area is selected".
   * Recomputed fresh every call (every animation frame while shown) so it
   * live-updates as anchor/regionSize sliders move or the host is edited.
   *
   * Deliberately reuses whatever's already cached in this.evaluator
   * rather than calling invalidate() — this is a UI aid, not a render
   * path, and forcing a full cache invalidation every frame here would
   * needlessly cost every OTHER render path that shares the same evaluator.
   */
  _drawEmbedRegionOverlay(ctx, project) {
    const node = stateStore.nodeGraph.nodes.get(this._embedRegionNodeId);
    if (!node || node.type !== 'embedNode') return;
    const hostEdge = stateStore.nodeGraph.getIncomingEdge(node.id, 'hostSdf');
    if (!hostEdge) return;

    this.evaluator.graph = stateStore.nodeGraph;
    let hostResult;
    try { hostResult = this.evaluator.evaluate(hostEdge.fromNode); } catch (e) { return; }
    const hostFn = hostResult?.sdf || hostResult?.result;
    if (typeof hostFn !== 'function') return;

    const p = node.params;

    // Same self-correction and frame-building the actual embedNode math
    // uses (NodeEvaluator.js / GLSLEvaluator.js) — reused directly from
    // differentialGeometry.js rather than an inline gradient closure and
    // hand-rolled Gram-Schmidt, so this overlay can never silently drift
    // from what the shape is actually sampled against.
    const rawAnchor = { x: p.anchorX ?? 0, y: p.anchorY ?? 0, z: p.anchorZ ?? 0 };
    const anchor = snapToNearestSurface(hostFn, rawAnchor, 4);

    const frame = computeLocalFrame(hostFn, anchor);
    if (!frame) return; // degenerate gradient at this anchor — nothing stable to draw

    const n = frame.normal;
    const tx = frame.tangent.x,   ty = frame.tangent.y,   tz = frame.tangent.z;
    const bx = frame.bitangent.x, by = frame.bitangent.y, bz = frame.bitangent.z;

    // Principal curvatures/directions — Tier 2, the one deliberate
    // consumer of the full eigensolve in this codebase: a human reading
    // this overlay wants an oriented "this direction is more/less curved"
    // line, not a raw quadratic form. embedNode's own sag math never
    // needs this — it stays on Tier 1 (computeShapeOperator2x2).
    const curv = computePrincipalCurvatures3D(hostFn, anchor);

    const radius = p.regionSize ?? 1.0;
    const RING_SEGMENTS = 24;
    const screenPts = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      const wx = anchor.x + radius * (Math.cos(a)*tx + Math.sin(a)*bx);
      const wy = anchor.y + radius * (Math.cos(a)*ty + Math.sin(a)*by);
      const wz = anchor.z + radius * (Math.cos(a)*tz + Math.sin(a)*bz);
      screenPts.push(project({ x: wx, y: wy, z: wz }));
    }

    if (screenPts.every(pt => pt === null)) return; // entirely off-camera

    ctx.beginPath();
    let started = false;
    screenPts.forEach(pt => {
      if (!pt) return;
      if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.strokeStyle = 'rgba(80,220,220,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(80,220,220,0.12)';
    ctx.fill();

    const anchorScreen = project(anchor);
    if (anchorScreen) {
      ctx.fillStyle = 'rgba(80,220,220,0.95)';
      ctx.beginPath();
      ctx.arc(anchorScreen.x, anchorScreen.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Local-axis gizmo — the direct answer to "why is my guest shape's
    // rotation unpredictable relative to the camera": the guest's own
    // Transform (position/rotation) applies to coordinates already
    // expressed in THIS local frame, not world space. Red/green = along
    // the surface (tangent/bitangent); blue = into/out of the surface
    // (normal) — a guest's default Rz=0 orientation puts its own "up"
    // axis along green, not blue, so most guests need SOME rotation to
    // point outward rather than lying flat.
    if (anchorScreen) {
      const axisLen = Math.max(radius * 0.6, 0.15);
      const drawAxis = (dx, dy, dz, color, label) => {
        const tip = project({
          x: anchor.x + dx * axisLen,
          y: anchor.y + dy * axisLen,
          z: anchor.z + dz * axisLen,
        });
        if (!tip) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(anchorScreen.x, anchorScreen.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '11px sans-serif';
        ctx.fillText(label, tip.x + 3, tip.y - 3);
      };
      drawAxis(tx, ty, tz,     'rgba(255,90,90,0.95)',   'X');
      drawAxis(bx, by, bz,     'rgba(90,255,120,0.95)',  'Y');
      drawAxis(n.x, n.y, n.z,  'rgba(90,150,255,0.95)',  'Z (normal)');

      // Principal-curvature indicator — DISTINCT from the T0/B0 sampling
      // axes above (dir1/dir2 generally are NOT aligned with tangent/
      // bitangent — they only coincide when T0/B0 happen to already be
      // principal-aligned). Two dashed lines, one per principal
      // direction, each scaled by |k1|/|k2| so a strongly-curved
      // direction (e.g. circumferentially around a cylinder) visibly
      // reads longer than a flat one (e.g. along the cylinder's axis,
      // where k2≈0 collapses that line away) — this is the actual
      // "show anisotropy" addition, kept visually separate from the
      // sampling-basis gizmo above so the two are never confused for
      // each other.
      if (curv) {
        const maxK = Math.max(Math.abs(curv.k1), Math.abs(curv.k2), 1e-6);
        const drawPrincipal = (dir, k, color, label) => {
          const len = axisLen * 0.9 * (Math.abs(k) / maxK);
          if (len < 1e-4) return; // umbilic/flat direction — nothing meaningful to draw
          const tip1 = project({ x: anchor.x + dir.x*len, y: anchor.y + dir.y*len, z: anchor.z + dir.z*len });
          const tip2 = project({ x: anchor.x - dir.x*len, y: anchor.y - dir.y*len, z: anchor.z - dir.z*len });
          if (!tip1 || !tip2) return;
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(tip1.x, tip1.y);
          ctx.lineTo(tip2.x, tip2.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.font = '10px sans-serif';
          ctx.fillText(`${label} ${k.toFixed(2)}`, tip1.x + 3, tip1.y + 10);
        };
        drawPrincipal(curv.dir1, curv.k1, 'rgba(255,200,60,0.9)', 'k1');
        drawPrincipal(curv.dir2, curv.k2, 'rgba(230,120,255,0.9)', 'k2');
      }

      // Depth indicator — small markers at ±depth along the normal,
      // giving a rough sense of the emboss height / engrave depth. Not a
      // precise boundary (the true gate follows the host's actual
      // surface, which can curve — see the embedNode fix comment), just
      // an at-a-glance scale reference.
      const depthVal = p.depth ?? 0.35;
      [1, -1].forEach(sign => {
        const tip = project({
          x: anchor.x + n.x * depthVal * sign,
          y: anchor.y + n.y * depthVal * sign,
          z: anchor.z + n.z * depthVal * sign,
        });
        if (!tip) return;
        ctx.strokeStyle = 'rgba(255,220,80,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
  }

  showSnapHighlight(worldPos) {
    this._snapHighlightWorld = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
    this._drawGizmoOverlay();
  }

  hideSnapHighlight() {
    this._snapHighlightWorld = null;
    this._drawGizmoOverlay();
  }

  /** Local-space landmark points for a node, with a safe fallback (origin
   *  only) for node types that don't define getLocalSnapPoints() —
   *  primarily blend/transform nodes, which have no explicit shape of
   *  their own but still have a meaningful transform anchor to snap to. */
  _getNodeLocalSnapPoints(nodeId) {
    const shape = stateStore.getShape(nodeId);
    if (shape && typeof shape.getLocalSnapPoints === 'function') {
      return shape.getLocalSnapPoints();
    }
    return [{ x: 0, y: 0, z: 0 }];
  }

  /**
   * Build the world-space snap candidate pool for a drag operation.
   * @param {'position'|'pivot'} mode
   * @param {number} draggedNodeId
   */
  _collectSnapCandidates(mode, draggedNodeId) {
    const graph = stateStore.nodeGraph;
    const candidates = [];

    graph.nodes.forEach((node, id) => {
      if (node.type === 'outputNode') return;
      const isSelf = id === draggedNodeId;
      // Position snap excludes the dragged node's own points — snapping a
      // shape's position to its own corner is meaningless, since the
      // shape moves together with its own position.
      if (mode === 'position' && isSelf) return;

      const localPts = this._getNodeLocalSnapPoints(id);
      localPts.forEach(lp => {
        const w = applyForwardTransform3D(lp, node.transform || {});
        candidates.push({
          world: new THREE.Vector3(w.x, w.y, w.z),
          local: isSelf ? lp : null,
          sourceNodeId: id,
          isSelf,
        });
      });
    });

    return candidates;
  }

  /**
   * Find the screen-nearest snap candidate to a cursor position, within a
   * pixel threshold. Returns null if nothing qualifies.
   */
  findNearestSnapPoint(clientX, clientY, mode, draggedNodeId, thresholdPx = 24) {
    // Same staleness issue as pickNodeAtScreenPosition — see its comment.
    this.camera.updateMatrixWorld(true);

    const candidates = this._collectSnapCandidates(mode, draggedNodeId);
    if (candidates.length === 0) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    let best = null;
    let bestDist = thresholdPx;

    candidates.forEach(c => {
      const ndc = c.world.clone().project(this.camera);
      if (ndc.z > 1 || ndc.z < -1) return; // behind camera / clipped
      const sx = (ndc.x * 0.5 + 0.5) * rect.width  + rect.left;
      const sy = (-ndc.y * 0.5 + 0.5) * rect.height + rect.top;
      const dist = Math.hypot(sx - clientX, sy - clientY);
      if (dist < bestDist) { bestDist = dist; best = c; }
    });

    return best;
  }

  /** Gold marker shown at a candidate snap point during a drag, distinct
   *  in color from the (purple) pivot gizmo so the two are never confused. */
  showSnapHighlight(worldPos) {
    if (!this._snapHighlight) {
      const geo = new THREE.SphereGeometry(0.1, 12, 8);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffcc33, depthTest: false, transparent: true, opacity: 0.95,
      });
      this._snapHighlight = new THREE.Mesh(geo, mat);
      this._snapHighlight.renderOrder = 1000;
      this.scene.add(this._snapHighlight);
    }
    this._snapHighlight.position.copy(worldPos);
    this._snapHighlight.visible = true;
  }

  hideSnapHighlight() {
    if (this._snapHighlight) this._snapHighlight.visible = false;
  }

  /**
   * Click-to-select picking: given a screen-space click position, find
   * which node's geometry is actually visible at that pixel.
   *
   * Approach (CPU-side, works identically across all three render modes
   * since it never touches the GPU):
   *   1. Build a world-space ray from the camera through the clicked pixel.
   *   2. Sphere-trace that ray against the fully combined scene SDF
   *      (evaluator.getRootSDF()) to find the world-space hit point —
   *      exactly what's visibly rendered at that pixel, regardless of
   *      which render mode is currently displaying it.
   *   3. Evaluate every top-level node's OWN (already transform-wrapped)
   *      SDF at that hit point, and pick whichever node reports the value
   *      closest to zero — i.e. whichever node's surface actually passes
   *      through that point.
   *
   * IMPORTANT — which node this selects: for a linear chain
   * (primitive → transform → transform → output), only the LAST node
   * before output has a value near zero at the point actually visible in
   * the viewport — every upstream node's own SDF describes an earlier,
   * different intermediate shape. So this method selects the TAIL node of
   * whatever chain produced the visible surface, not necessarily the
   * originating primitive — this mirrors how viewport picking already
   * works in Houdini (clicking selects what's on display, not an
   * arbitrary upstream generator) and is intentional, not a limitation.
   *
   * Works for both 2D and 3D geometry: 2D primitives' SDFs ignore the Z
   * coordinate entirely, so sphere-tracing still converges correctly on
   * (x,y) regardless of which Z the ray happens to be at when it converges.
   *
   * @param {number} clientX  Mouse event clientX
   * @param {number} clientY  Mouse event clientY
   * @returns {number|null}   The picked node's id, or null if nothing was hit
   */
   pickNodeAtScreenPosition(clientX, clientY) {
    // Camera.matrixWorld/matrixWorldInverse only get recomputed during
    // renderer.render(scene, camera)'s traversal, which only happens in
    // marchingSquares mode (see _loop()) — in GLSL/Ray March mode that
    // call is skipped, so these matrices go stale the moment OrbitControls
    // moves the camera. Raycasting/projecting with stale matrices produces
    // wrong results except by coincidence (e.g. dead-center clicks lining
    // up with whatever the camera's last-rendered orientation happened to
    // be). Force a refresh here so picking works correctly in all modes.
    this.camera.updateMatrixWorld(true);

    const dom  = this.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    const ndcX =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((clientY - rect.top)  / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const ro = raycaster.ray.origin;
    const rd = raycaster.ray.direction;

    this.evaluator.graph = stateStore.nodeGraph;
    this.evaluator.invalidate();
    const sdf = this.evaluator.getRootSDF();
    if (!sdf) return null;

    // ── Step 1: sphere-trace to find the world-space hit point ───────────
    const MAX_STEPS = 256;
    const MAX_DIST  = 100;
    const EPS       = 0.001;
    let t = 0.01;
    let hitPoint = null;

    for (let i = 0; i < MAX_STEPS; i++) {
      const p = { x: ro.x + rd.x * t, y: ro.y + rd.y * t, z: ro.z + rd.z * t };
      let d;
      try { d = sdf(p); } catch (e) { break; }
      if (!isFinite(d)) break;
      if (d < EPS) { hitPoint = p; break; }
      t += d;
      if (t > MAX_DIST) break;
    }

    if (!hitPoint) return null; // clicked empty space

    // ── Step 2: find which top-level node's own SDF is closest to zero ───
    const graph = stateStore.nodeGraph;
    let bestId  = null;
    let bestAbs = Infinity;

    graph.nodes.forEach((node, id) => {
      if (node.type === 'outputNode') return;
      let result;
      try {
        result = this.evaluator.evaluate(id);
      } catch (e) {
        return; // node evaluation failed (e.g. missing required input) — skip
      }
      const fn = result?.sdf || result?.result;
      if (typeof fn !== 'function') return; // mapper/time/oscillator nodes — not pickable

      let v;
      try { v = fn(hitPoint); } catch (e) { return; }
      const av = Math.abs(v);
      if (av < bestAbs) { bestAbs = av; bestId = id; }
    });

    return bestId;
  }

  /**
   * Estimate a node's own approximate "radius" (half-extent) by sphere-
   * tracing outward from its own transform position along ten directions,
   * using ONLY that node's own (already transform-wrapped) SDF — never
   * the combined scene. Used by Morph Auto-Fit to compare two shapes'
   * sizes before proposing a compensating scale.
   *
   * Coarse by design: good enough to roughly equalize two shapes'
   * apparent size, not a precise bounding-volume computation.
   */
  estimateNodeRadius(nodeId) {
    // Array-aware dispatch: a Repeat or finite-extent Tiling node's
    // nearest-surface sphere-trace only ever finds the EDGE OF ONE COPY,
    // not the array's true outer extent — the acknowledged limitation
    // from Auto-Fit's first version. For these two types, compute the
    // extent analytically from the array's own params instead.
    const arrayNode = stateStore.nodeGraph.nodes.get(nodeId);
    const isArrayNode = arrayNode && (
      arrayNode.type === 'repeatNode' ||
      (arrayNode.type === 'tilingNode' && arrayNode.params?.extent === 'finite')
    );
    if (isArrayNode) return this._estimateArrayRadius(nodeId, arrayNode);

    this.evaluator.graph = stateStore.nodeGraph;
    this.evaluator.invalidate();
    let result;
    try { result = this.evaluator.evaluate(nodeId); } catch (e) { return 1; }
    const fn = result?.sdf || result?.result;
    if (typeof fn !== 'function') return 1;

    const node = stateStore.nodeGraph.nodes.get(nodeId);
    const center = {
      x: node?.transform?.posX ?? 0,
      y: node?.transform?.posY ?? 0,
      z: node?.transform?.posZ ?? 0,
    };

    const DIRS = [
      [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
      [0.577,0.577,0.577],[-0.577,0.577,0.577],
      [0.577,-0.577,0.577],[0.577,0.577,-0.577],
    ];
    const MAX_DIST = 20, STEP = 0.05;
    const radii = [];

    DIRS.forEach(([dx, dy, dz]) => {
      let t = 0, lastSign = null;
      while (t < MAX_DIST) {
        const p = { x: center.x + dx*t, y: center.y + dy*t, z: center.z + dz*t };
        let d;
        try { d = fn(p); } catch (e) { break; }
        if (!isFinite(d)) break;
        const sign = d < 0 ? -1 : 1;
        if (lastSign !== null && sign !== lastSign) { radii.push(t); return; }
        lastSign = sign;
        t += STEP;
      }
    });

    if (radii.length === 0) return 1;
    return radii.reduce((a,b) => a+b, 0) / radii.length;
  }

  /**
   * Array-extent radius for Repeat / finite Tiling nodes — the analytic
   * counterpart to the generic sphere-trace above, which cannot see past
   * the nearest individual copy. Computes each axis's half-span from
   * (count-1)/2 * spacing, takes the largest axis, then adds the radius
   * of the underlying LEAF shape (recursing into whatever feeds this
   * array node's 'sdf' input via the same estimateNodeRadius — correctly
   * falling through to the generic sphere-trace for an ordinary
   * primitive, or recursing again if arrays are chained).
   *
   * This is a bounding-sphere APPROXIMATION (assumes the leaf's own
   * radius is roughly uniform in every direction and centered near its
   * own transform origin) — adequate for Auto-Fit's purpose (comfortably
   * fitting an array inside a region), not a tight/exact bound.
   */
  _estimateArrayRadius(nodeId, node) {
    const p = node.params;
    const cX = Math.max(1, Math.round(p.countX ?? 3));
    const cY = Math.max(1, Math.round(p.countY ?? 3));
    const cZ = Math.max(1, Math.round(p.countZ ?? 1));
    const sX = p.spacingX ?? p.periodX ?? 3;
    const sY = p.spacingY ?? p.periodY ?? 3;
    const sZ = p.spacingZ ?? p.periodZ ?? 3;

    const halfSpanX = ((cX - 1) / 2) * sX;
    const halfSpanY = ((cY - 1) / 2) * sY;
    const halfSpanZ = ((cZ - 1) / 2) * sZ;
    const maxHalfSpan = Math.max(halfSpanX, halfSpanY, halfSpanZ, 0);

    const edge = stateStore.nodeGraph.getIncomingEdge(nodeId, 'sdf');
    const leafRadius = edge ? this.estimateNodeRadius(edge.fromNode) : 1;

    return maxHalfSpan + leafRadius;
  }

/**
   * Compute a bounding sphere (center + radius) covering all evaluable
   * geometry nodes in the graph — the foundational math both `frameAll()`
   * and the orbit-camera system's framing distance depend on. Cached for
   * 30 frames (same pattern as _sceneHasAnimatedNodes) since it involves
   * an estimateNodeRadius() call per node.
   */
  computeSceneBoundingSphere() {
    if (this._boundingSphereCache && this._boundingSphereCacheCounter < 30) {
      this._boundingSphereCacheCounter++;
      return this._boundingSphereCache;
    }
    this._boundingSphereCacheCounter = 0;

    this.evaluator.graph = stateStore.nodeGraph;
    this.evaluator.invalidate();
    const graph = stateStore.nodeGraph;

    let minX=Infinity, minY=Infinity, minZ=Infinity;
    let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
    let found = false;

    graph.nodes.forEach((node, id) => {
      if (node.type === 'outputNode') return;
      let result;
      try { result = this.evaluator.evaluate(id); } catch (e) { return; }
      const fn = result?.sdf || result?.result;
      if (typeof fn !== 'function') return; // mapper/time/oscillator — no spatial extent

      const r  = this.estimateNodeRadius(id);
      const cx = node.transform?.posX ?? 0;
      const cy = node.transform?.posY ?? 0;
      const cz = node.transform?.posZ ?? 0;
      minX = Math.min(minX, cx-r); minY = Math.min(minY, cy-r); minZ = Math.min(minZ, cz-r);
      maxX = Math.max(maxX, cx+r); maxY = Math.max(maxY, cy+r); maxZ = Math.max(maxZ, cz+r);
      found = true;
    });

    const result = !found
      ? { center: { x:0, y:0, z:0 }, radius: 2 }
      : {
          center: { x:(minX+maxX)/2, y:(minY+maxY)/2, z:(minZ+maxZ)/2 },
          radius: Math.max(Math.sqrt((maxX-minX)**2 + (maxY-minY)**2 + (maxZ-minZ)**2) / 2, 0.5),
        };

    this._boundingSphereCache = result;
    return result;
  }

  /**
   * Distance from a bounding-sphere center at which the WHOLE sphere just
   * fits within the camera's vertical FOV, plus a small padding factor so
   * geometry doesn't touch the viewport edge exactly.
   */
  _framingDistance(radius) {
    const fovRad = (this.camera.fov * Math.PI) / 180;
    return (radius / Math.sin(fovRad / 2)) * 1.15;
  }

  /**
   * Reframe the camera to comfortably show all geometry, preserving the
   * CURRENT viewing angle (just pushes the camera back/forward and
   * recenters, rather than resetting to a canonical view). Animates over
   * ~350ms rather than snapping instantly.
   */
  frameAll(animate = true) {
    const { center, radius } = this.computeSceneBoundingSphere();
    const distance = this._framingDistance(radius);

    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.7, 1.0).normalize(); // degenerate fallback

    const newTarget = new THREE.Vector3(center.x, center.y, center.z);
    const newPos     = newTarget.clone().add(dir.multiplyScalar(distance));

    if (!animate) {
      this.camera.position.copy(newPos);
      this.controls.target.copy(newTarget);
      this.controls.update();
      return;
    }

    const startPos    = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startTime   = performance.now();
    const DURATION_MS = 350;

    const step = () => {
      const elapsed = performance.now() - startTime;
      const raw = Math.min(1, elapsed / DURATION_MS);
      const eased = raw * raw * (3 - 2 * raw); // smoothstep
      this.camera.position.lerpVectors(startPos, newPos, eased);
      this.controls.target.lerpVectors(startTarget, newTarget, eased);
      this.controls.update();
      if (raw < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Sample ~sampleCount evenly-distributed directions around the scene's
   * bounding sphere, ray-march inward to find each direction's actual
   * surface hit, and score that point's mean curvature — producing a
   * curvature "interest map" the curvatureGuided orbit generator biases
   * toward. NOT recomputed per-frame (19 SDF evals × sampleCount is real
   * cost) — only when curvature-guided mode is activated or explicitly
   * refreshed via the UI's "Recompute Interest Map" button.
   */
  /**
   * Build a min-combined SDF directly from every evaluable top-level node,
   * bypassing the Output-node/edge-wiring requirement getRootSDF() has.
   * Used as a fallback for curvature sampling so it works even before the
   * user has ever clicked Render (a real, previously-unhandled case: e.g.
   * pressing R for curvature-guided orbit immediately after adding
   * primitives). Less precise than getRootSDF() for non-union graphs
   * (it doesn't respect intersection/difference operations between
   * top-level nodes — each node's OWN surface is included independently),
   * but adequate for viewpoint SCORING rather than exact geometry.
   */
  _combinedEvaluableSDF() {
    const graph = stateStore.nodeGraph;
    const fns = [];
    graph.nodes.forEach((node, id) => {
      if (node.type === 'outputNode') return;
      let result;
      try { result = this.evaluator.evaluate(id); } catch (e) { return; }
      const fn = result?.sdf || result?.result;
      if (typeof fn === 'function') fns.push(fn);
    });
    if (fns.length === 0) return null;
    if (fns.length === 1) return fns[0];
    return (pt) => {
      let d = Infinity;
      for (const fn of fns) d = Math.min(d, fn(pt));
      return d;
    };
  }

  /**
   * Sample ~sampleCount evenly-distributed directions around the scene's
   * bounding sphere, ray-march inward to find each direction's actual
   * surface hit, and score that point's curvature — producing a
   * curvature "interest map" the curvatureGuided orbit generator biases
   * toward. NOT recomputed per-frame (19 SDF evals × sampleCount is real
   * cost) — only when curvature-guided mode is activated or explicitly
   * refreshed via the UI's "Recompute Interest Map" button.
   *
   * @param {number} sampleCount
   * @param {'magnitude'|'mean'|'anisotropy'} [metric='magnitude']
   *   All three are Tier 1 (computeShapeOperator2x2) — identical 19-eval
   *   cost regardless of choice, since Sxx/Sxy/Syy yield all three with
   *   no extra SDF evaluations:
   *     'mean'       — (k1+k2)/2. Legacy behavior. Cancels to ~0 at a
   *                    saddle — kept for reachability, not recommended.
   *     'magnitude'  — √(k1²+k2²). DEFAULT. Catches saddles the mean
   *                    hides while still ranking ordinary bumps correctly
   *                    by strength.
   *     'anisotropy' — |k1−k2|. How directionally uneven curvature is,
   *                    independent of overall strength — zero on any
   *                    umbilic point no matter how curved, peaks exactly
   *                    at saddles/blend seams. Not yet consumed by an
   *                    adaptive resampler (no such system exists yet) —
   *                    exposed here as the first concrete use of it.
   */
  computeCurvatureInterestMap(sampleCount = 32, metric = 'magnitude') {
    const { center, radius } = this.computeSceneBoundingSphere();
    this.evaluator.graph = stateStore.nodeGraph;
    this.evaluator.invalidate();
    let sdf = this.evaluator.getRootSDF();
    if (!sdf) sdf = this._combinedEvaluableSDF();
    if (!sdf) return [];

    const eps = epsilonForScale(radius);
    const directions = fibonacciSphereSamples(sampleCount);
    const map = [];

    directions.forEach(dir => {
      const origin = {
        x: center.x - dir.x * radius * 1.8,
        y: center.y - dir.y * radius * 1.8,
        z: center.z - dir.z * radius * 1.8,
      };
      const hit = raymarchToSurface(sdf, origin, dir, radius * 4, eps);
      if (!hit) return;

      const frame = computeLocalFrame(sdf, hit, eps);
      if (!frame) return; // degenerate gradient here — skip (equiv. to a 0 score previously)

      const { Sxx, Sxy, Syy } = computeShapeOperator2x2(sdf, hit, frame, eps);

      let score;
      if (metric === 'mean') {
        score = Math.abs((Sxx + Syy) / 2);
      } else if (metric === 'anisotropy') {
        score = Math.sqrt((Sxx - Syy) ** 2 + 4 * Sxy * Sxy);
      } else {
        score = Math.sqrt(Sxx*Sxx + Syy*Syy + 2*Sxy*Sxy);
      }

      map.push({ dir, score });
    });

    const maxScore = map.reduce((m, s) => Math.max(m, s.score), 0) || 1;
    map.forEach(s => { s.score = s.score / maxScore; });

    this._curvatureInterestMap = map;
    this._curvatureInterestMetric = metric;
    return map;
  }

  /**
   * Start the pluggable orbit driver. Replaces OrbitControls.autoRotate
   * (which only does fixed-axis circular motion) — drives camera.position/
   * controls.target directly each frame using the selected generator.
   * @param {string} generatorKey  One of OrbitGenerators' keys
   * @param {object} params        Passed through to the generator
   */
  startOrbit(generatorKey = 'circular', params = {}) {
    if (generatorKey === 'curvatureGuided' && !this._curvatureInterestMap) {
      this.computeCurvatureInterestMap();
    }
    this._orbitGeneratorKey = generatorKey;
    this._orbitParams       = params;
    this._orbitStartTime    = performance.now();
    this._orbitActive       = true;
  }

  stopOrbit() {
    this._orbitActive = false;
  }

  isOrbitActive() {
    return this._orbitActive;
  }

  /** Called once per animation frame from _loop() when orbit is active. */
  _updateOrbit() {
    if (!this._orbitActive) return;
    const generator = OrbitGenerators[this._orbitGeneratorKey] || OrbitGenerators.circular;
    const t = (performance.now() - this._orbitStartTime) / 1000;

    const { theta, phi } = generator.generate(t, this._orbitParams, this._curvatureInterestMap);
    const dir = sphericalToDir(theta, phi);

    const { center, radius } = this.computeSceneBoundingSphere();
    const distance = this._framingDistance(radius);

    this.camera.position.set(
      center.x + dir.x * distance,
      center.y + dir.y * distance,
      center.z + dir.z * distance
    );
    this.controls.target.set(center.x, center.y, center.z);
    // NOTE: controls.update() is still called once per frame by the
    // existing _loop() body right after this — not duplicated here.
  }

  /**
   * Sphere-trace against ONE SPECIFIC node's own SDF (not the whole
   * combined scene) — used by embedNode's anchor-picking mode so a click
   * always anchors to the intended host, even if other geometry overlaps
   * it in the current view.
   */
  pickSurfacePointOnNode(nodeId, clientX, clientY) {
    this.camera.updateMatrixWorld(true);
    const dom  = this.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    const ndcX =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((clientY - rect.top)  / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const ro = raycaster.ray.origin;
    const rd = raycaster.ray.direction;

    this.evaluator.graph = stateStore.nodeGraph;
    this.evaluator.invalidate();
    let result;
    try { result = this.evaluator.evaluate(nodeId); } catch (e) { return null; }
    const fn = result?.sdf || result?.result;
    if (typeof fn !== 'function') return null;

    const MAX_STEPS = 256, MAX_DIST = 100, EPS = 0.0005;
    let t = 0.01;
    for (let i = 0; i < MAX_STEPS; i++) {
      const p = { x: ro.x + rd.x * t, y: ro.y + rd.y * t, z: ro.z + rd.z * t };
      let d;
      try { d = fn(p); } catch (e) { break; }
      if (!isFinite(d)) break;
      if (d < EPS) return p;
      t += d;
      if (t > MAX_DIST) break;
    }
    return null;
  }

/**
   * Paint-stroke sampling — the drag-time counterpart to
   * pickSurfacePointOnNode. Sphere-traces ONE node's OWN composed SDF in
   * isolation (never the combined scene) and, on a hit, computes the full
   * local surface frame (normal + tangent + bitangent) there — tangent/
   * bitangent are what let a painted region later build its OWN
   * coordinate frame for embedNode's guest projection (see
   * surfaceMask.js:deriveEmbedFramesFromMask), instead of only gating an
   * anchor-centered one. Returns null on a miss (cursor dragged off the
   * shape) — callers must hold the previous sample rather than write NaN
   * into stroke data.
   */
  paintSampleAtScreenPosition(hostNodeId, clientX, clientY) {
    this.camera.updateMatrixWorld(true);
    const dom  = this.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    const ndcX =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY = -((clientY - rect.top)  / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const ro = raycaster.ray.origin;
    const rd = raycaster.ray.direction;

    const fn = this._isolatedSDF(hostNodeId);
    if (!fn) return null;

    const hit = raymarchToSurface(fn, ro, rd, 100, 0.0005);
    if (!hit) return null;

    const frame = computeLocalFrame(fn, hit, 0.001);
    if (!frame) return null;

    // Mask samples are stored in the node's OWN LOCAL space — matching
    // node.transform's local-to-world convention — so painting stays
    // attached to the shape if it's later moved, rotated, or scaled via
    // the Transform section, exactly like the shape's own geometry does.
    // This function ray-marches the fully-transformed (world-space) SDF,
    // since that's what the user is actually looking at and clicking on,
    // so the hit point/frame must be converted back to local space
    // before being recorded.
    const node = stateStore.nodeGraph.nodes.get(hostNodeId);
    const t = node?.transform;
    const localHit = t ? applyInverseTransform3D(hit, t) : hit;
    const localN   = t ? this._inverseRotateDirection(frame.normal,    t) : frame.normal;
    const localT   = t ? this._inverseRotateDirection(frame.tangent,   t) : frame.tangent;
    const localB   = t ? this._inverseRotateDirection(frame.bitangent, t) : frame.bitangent;

    return {
      x: localHit.x, y: localHit.y, z: localHit.z,
      nx: localN.x, ny: localN.y, nz: localN.z,
      tx: localT.x, ty: localT.y, tz: localT.z,
      bx: localB.x, by: localB.y, bz: localB.z,
      w: 1,
    };
  }

  /**
   * Rotate a direction vector (no translation, no pivot offset) by the
   * INVERSE of a node's transform rotation — the direction-vector
   * counterpart to applyInverseTransform3D, needed to convert a
   * world-space surface frame into the node's local space alongside the
   * point itself.
   */
  _inverseRotateDirection(dir, t) {
    const rx = t.rotateX ?? 0, ry = t.rotateY ?? 0, rz = t.rotateZ ?? 0;
    let x = dir.x, y = dir.y, z = dir.z;
    if (rz !== 0) {
      const c = Math.cos(-rz), s = Math.sin(-rz);
      const nx = x * c - y * s, ny = x * s + y * c;
      x = nx; y = ny;
    }
    if (ry !== 0) {
      const c = Math.cos(-ry), s = Math.sin(-ry);
      const nx =  x * c + z * s, nz = -x * s + z * c;
      x = nx; z = nz;
    }
    if (rx !== 0) {
      const c = Math.cos(-rx), s = Math.sin(-rx);
      const ny = y * c - z * s, nz = y * s + z * c;
      y = ny; z = nz;
    }
    return { x, y, z };
  }

  /**
   * Get the isolated (never combined-scene) SDF function for one node —
   * shared helper for paintSampleAtScreenPosition and the bake methods
   * below.
   */
  _isolatedSDF(nodeId) {
    this.evaluator.graph = stateStore.nodeGraph;
    let result;
    try { result = this.evaluator.evaluate(nodeId); } catch (e) { return null; }
    const fn = result?.sdf || result?.result;
    return typeof fn === 'function' ? fn : null;
  }

  /**
   * Refine a raw Euclidean brush stroke into geodesic-weighted baked
   * samples, by growing a local surface graph outward from the stroke and
   * running Dijkstra. Called ONCE per stroke (on mouseup), never per
   * mousemove — see surfaceGraph.js's header for the cost model this
   * relies on. Writes the result directly into node.mask.samples.
   *
   * @param {number} nodeId                    The node being painted on.
   * @param {Array}  rawStrokeSamplesLocal      Raw {x,y,z,nx,ny,nz,tx,ty,tz,bx,by,bz,w}
   *   samples accumulated during the drag (paintSampleAtScreenPosition
   *   results) — already in the node's LOCAL space.
   * @returns {boolean} true if the bake succeeded and mask was updated.
   */
  bakeGeodesicMaskForNode(nodeId, rawStrokeSamplesLocal) {
    const fn = this._isolatedSDF(nodeId); // world-space-in
    if (!fn || !rawStrokeSamplesLocal || rawStrokeSamplesLocal.length === 0) return false;

    const node = stateStore.nodeGraph.nodes.get(nodeId);
    if (!node) return false;
    const t = node.transform;
    const mask = node.mask || createEmptyMask();
    const radius = mask.falloffRadius ?? 0.4;
    const stepSize = Math.max(radius / 6, 0.03);

    const rawWorld = rawStrokeSamplesLocal.map(s => {
      const w = applyForwardTransform3D(s, t);
      return { x: w.x, y: w.y, z: w.z };
    });

    let pathLen = 0;
    for (let i = 1; i < rawWorld.length; i++) {
      const a = rawWorld[i - 1], b = rawWorld[i];
      pathLen += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
    const isEffectivelyAClick = pathLen < stepSize * 1.5;

    if (isEffectivelyAClick) {
      // A near-stationary click should bake exactly ONE sample and let
      // evaluateMaskAt's own falloffRadius kernel produce the round dab
      // — NOT run BFS graph growth at all. Growing even one ring from a
      // single seed unconditionally produces 1 + ringDirections
      // neighbor points before the radius gate ever engages, which is
      // why a click still read as a small CLUSTER rather than a single
      // dot even after the previous (growth-radius-shrinking) fix.
      const rawPt = rawWorld[0];
      const snapped = snapToNearestSurface(fn, rawPt, 4, 0.001);
      const frame = computeLocalFrame(fn, snapped, 0.001);
      if (!frame) return false;
      const shapeOp = computeShapeOperator2x2(fn, snapped, frame, 0.001);

      const localPos = applyInverseTransform3D(snapped, t);
      const localN = this._inverseRotateDirection(frame.normal, t);
      const localT = this._inverseRotateDirection(frame.tangent, t);
      const localB = this._inverseRotateDirection(frame.bitangent, t);

      const bakedLocal = [{
        x: localPos.x, y: localPos.y, z: localPos.z,
        nx: localN.x, ny: localN.y, nz: localN.z,
        tx: localT.x, ty: localT.y, tz: localT.z,
        bx: localB.x, by: localB.y, bz: localB.z,
        Sxx: shapeOp.Sxx, Sxy: shapeOp.Sxy, Syy: shapeOp.Syy,
        w: 1,
      }];

      stateStore.nodeGraph.updateNodeMask(nodeId, 'mode', 'geodesic');
      stateStore.nodeGraph.updateNodeMask(nodeId, 'samples', bakedLocal);
      stateStore.nodeGraph.updateNodeMask(nodeId, 'enabled', true);
      return true;
    }

    const graph = buildSurfaceGraph(fn, rawWorld, {
      stepSize,
      radius: radius * 1.4,
      maxNodes: 260,
      timeBudgetMs: 20,
    });
    if (graph.nodes.length === 0) return false;

    const geodesicDist = dijkstraGeodesic(graph, graph.seedIndices);
    const bakedWorld = bakeGeodesicSamples(graph, geodesicDist, radius);
    if (bakedWorld.length === 0) return false;

    const bakedLocal = bakedWorld.map(s => {
      const localPos = applyInverseTransform3D(s, t);
      const localN   = this._inverseRotateDirection({ x: s.nx, y: s.ny, z: s.nz }, t);
      const localT   = this._inverseRotateDirection({ x: s.tx, y: s.ty, z: s.tz }, t);
      const localB   = this._inverseRotateDirection({ x: s.bx, y: s.by, z: s.bz }, t);
      return {
        x: localPos.x, y: localPos.y, z: localPos.z,
        nx: localN.x, ny: localN.y, nz: localN.z,
        tx: localT.x, ty: localT.y, tz: localT.z,
        bx: localB.x, by: localB.y, bz: localB.z,
        Sxx: s.Sxx, Sxy: s.Sxy, Syy: s.Syy,
        w: s.w,
      };
    });

    stateStore.nodeGraph.updateNodeMask(nodeId, 'mode', 'geodesic');
    stateStore.nodeGraph.updateNodeMask(nodeId, 'samples', decimateSamples(bakedLocal, MAX_MASK_SAMPLES));
    stateStore.nodeGraph.updateNodeMask(nodeId, 'enabled', true);
    return true;
  }

  /**
   * Curvature-similarity flood select from a single clicked surface point.
   * A one-shot operation (not a drag) — a different GESTURE from the
   * brush tools, not merely a different falloff mode on the same one.
   *
   * @param {number} nodeId
   * @param {number} clientX
   * @param {number} clientY
   * @returns {boolean} true if the flood succeeded and mask was updated.
   */
  bakeCurvatureFloodMaskForNode(nodeId, clientX, clientY) {
    const fn = this._isolatedSDF(nodeId);
    if (!fn) return false;

    const sampleLocal = this.paintSampleAtScreenPosition(nodeId, clientX, clientY);
    if (!sampleLocal) return false;

    const node = stateStore.nodeGraph.nodes.get(nodeId);
    if (!node) return false;
    const t = node.transform;
    const mask = node.mask || createEmptyMask();
    const threshold = mask.curvatureThreshold ?? 0.15;
    const radius = mask.falloffRadius ?? 0.4;

    const sampleWorld = applyForwardTransform3D(sampleLocal, t);

    // The flood's own spatial reach isn't bounded by falloffRadius the way
    // the brush is — curvature similarity, not distance, decides extent —
    // so the graph is grown with a generous radius cap (guards against an
    // almost-uniform-curvature object flooding without bound) rather than
    // the mask's falloff radius.
    const FLOOD_SPATIAL_CAP = Math.max(radius * 6, 3.0);
    const graph = buildSurfaceGraph(fn, [sampleWorld], {
      stepSize: Math.max(radius / 5, 0.04),
      radius: FLOOD_SPATIAL_CAP,
      maxNodes: 400,
      timeBudgetMs: 30,
    });
    if (graph.nodes.length === 0) return false;

    const seedIdx = graph.seedIndices[0] ?? 0;
    const flood = curvatureFlood(graph, seedIdx, threshold);
    const bakedWorld = bakeCurvatureFloodSamples(graph, flood, threshold);
    if (bakedWorld.length === 0) return false;

    const bakedLocal = bakedWorld.map(s => {
      const localPos = applyInverseTransform3D(s, t);
      const localN   = this._inverseRotateDirection({ x: s.nx, y: s.ny, z: s.nz }, t);
      const localT   = this._inverseRotateDirection({ x: s.tx, y: s.ty, z: s.tz }, t);
      const localB   = this._inverseRotateDirection({ x: s.bx, y: s.by, z: s.bz }, t);
      return {
        x: localPos.x, y: localPos.y, z: localPos.z,
        nx: localN.x, ny: localN.y, nz: localN.z,
        tx: localT.x, ty: localT.y, tz: localT.z,
        bx: localB.x, by: localB.y, bz: localB.z,
        Sxx: s.Sxx, Sxy: s.Sxy, Syy: s.Syy,
        w: s.w,
      };
    });

    stateStore.nodeGraph.updateNodeMask(nodeId, 'mode', 'curvatureFlood');
    stateStore.nodeGraph.updateNodeMask(nodeId, 'samples', decimateSamples(bakedLocal, MAX_MASK_SAMPLES));
    stateStore.nodeGraph.updateNodeMask(nodeId, 'enabled', true);
    return true;
  }

  /**
   * Briefly glow a node's mesh so the user is never confused about which
   * shape is the "host" while anchor-picking mode is armed. Falls back
   * gracefully for line-based primitives (Circle, RegularPolygon etc.,
   * which use THREE.LineBasicMaterial with no emissive channel) by
   * flashing their color instead.
   * @param {number} nodeId
   * @param {number} durationMs  Pass a very large value to hold the glow
   *   indefinitely (e.g. while a pick mode is armed); call
   *   clearHighlight(nodeId) to end it early.
   */
  highlightNode(nodeId, durationMs = 1200) {
    const entry = this.activePrimitives.find(p => p.instance.id === nodeId);
    if (!entry?.object) return;
    this.clearHighlight(nodeId);

    const affected = [];
    const applyGlow = (mat) => {
      if (!mat) return;
      if (mat.emissive) {
        affected.push({ mat, kind: 'emissive', orig: mat.emissive.clone() });
        mat.emissive.setHex(0xffee66);
      } else if (mat.color) {
        affected.push({ mat, kind: 'color', orig: mat.color.clone() });
        mat.color.setHex(0xffee66);
      }
    };

    entry.object.traverse
      ? entry.object.traverse(child => applyGlow(child.material))
      : applyGlow(entry.object.material);

    this._highlightState = this._highlightState || new Map();
    this._highlightState.set(nodeId, affected);

    if (durationMs < 1e8) {
      clearTimeout(this._highlightTimers?.get(nodeId));
      this._highlightTimers = this._highlightTimers || new Map();
      this._highlightTimers.set(nodeId, setTimeout(() => this.clearHighlight(nodeId), durationMs));
    }
  }

  clearHighlight(nodeId) {
    const affected = this._highlightState?.get(nodeId);
    if (affected) {
      affected.forEach(({ mat, kind, orig }) => {
        if (kind === 'emissive') mat.emissive.copy(orig);
        else mat.color.copy(orig);
      });
      this._highlightState.delete(nodeId);
    }
    clearTimeout(this._highlightTimers?.get(nodeId));
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
      const t  = node.transform || {};
      const cx = t.posX ?? 0;
      const cy = t.posY ?? 0;

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
    this._resizeGizmoOverlay();
  }

  _resizeGizmoOverlay() {
    if (!this._gizmoOverlay) return;
    this._gizmoOverlay.width  = window.innerWidth;
    this._gizmoOverlay.height = window.innerHeight;
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
   * Scale factor for ambient-occlusion/soft-shadow sampling distances in
   * the ray march shader, derived from the SMALLEST embedNode depth
   * currently in the graph. The fixed AO/shadow sampling constants in
   * RayMarchRenderer's fragment shader were tuned around a "normal"
   * shape scale — a shallow engrave cavity is much smaller than that
   * scale, so those same fixed offsets over/under-sample relative to the
   * cavity's own size, which shows up as speckle/banding inside it.
   * Returns 1.0 (no change) when there is no embedNode in the graph, or
   * when its depth is at/above the constants' original tuning point
   * (0.35) — this is purely a downward adjustment for SHALLOW cavities,
   * never an upward one.
   */
  _computeEmbedDetailScale() {
    const graph = this.glslEvaluator?.graph ?? stateStore.nodeGraph;
    let minDepth = Infinity;
    graph.nodes.forEach(n => {
      if (n.type === 'embedNode') {
        const d = n.params?.depth ?? 0.35;
        if (d < minDepth) minDepth = d;
      }
    });
    if (!isFinite(minDepth)) return 1.0;
    return Math.min(1.0, Math.max(0.15, minDepth / 0.35));
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

    // Any non-identity DistanceMapper (sinusoidal/polynomial/exponential/
    // logarithmic/power) can turn a proper distance field into something
    // with no relationship to actual distance-to-surface — sinusoidal in
    // particular introduces periodic zero-crossings unrelated to true
    // proximity, which breaks sphere tracing's safe-step assumption and
    // can cause the ray marcher to skip straight through geometry,
    // producing total invisibility. identityMapper is deliberately
    // excluded — it's a pure no-op and never needs conservative stepping.
    // sinusoidalMapper and polynomialMapper are now RIGOROUSLY handled via
    // Lipschitz-bound normalization in GLSLEvaluator._wrapWithNodeTransform
    // — their output is already a safe, correct distance value, so they no
    // longer need this heuristic fallback. Only the three mappers with no
    // honest global bound (exponential/logarithmic/power — see
    // GLSLEvaluator._computeMapperLipschitz) still need forced small steps.
    const hasRiskyMapper = (
      source.includes('exponentialMapper') ||
      source.includes('logarithmicMapper') ||
      source.includes('powerMapper')
    );

    // embedNode's blend (host↔guest seam, plus the outer host/embedded
    // falloff) is not distance-preserving either — same class of problem
    // as rDifference, and at least as steep at the seam — so it needs the
    // conservative tier below, not the milder "warp" tier.
    const hasEmbed = source.includes('embedNode');

    const hasWarp = !hasDifference && !hasRiskyMapper && !hasEmbed && (
      source.includes('twistNode')        ||
      source.includes('bendNode')         ||
      source.includes('noiseDisplaceNode')||
      source.includes('mobiusNode')       ||
      source.includes('symmetryOrbit')
    );

    let targetMaxSteps, targetStepScale, targetEpsilon, targetMaxDist;
    if (hasDifference || hasRiskyMapper || hasEmbed) {
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

    const { source, uniforms, vecUniforms, intUniforms, rootFn } = this.glslEvaluator.generate(time, '2d');

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

    this.sdfRenderer.render(uniforms, time, null, null, vecUniforms, intUniforms);
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

    const { source, uniforms, vecUniforms, intUniforms, rootFn } = this.glslEvaluator.generate(time, '3d');

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

    this.rayMarchRenderer.setDetailScale(this._computeEmbedDetailScale());
    this.rayMarchRenderer.syncCamera(this.camera, this.controls);
    this.rayMarchRenderer.render(uniforms, time, vecUniforms, intUniforms);

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
    this._applyNodeTransformToMesh(id, object);

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