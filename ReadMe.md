# Isoline

**A browser-based procedural shape studio for building 2D and 3D forms from connected geometry, transforms, and blends.**

Isoline is a node-based tool for designing procedural shapes and sculptural forms directly in the browser — no installation required. Connect primitives, transforms, and blend operations on a visual graph, and watch your geometry evolve in real time.

**Live demo:** [isoline-studio.netlify.app](https://isoline-studio.netlify.app)

---

## What Isoline does

- Build shapes from **2D primitives** (circle, line, triangle, regular polygon, arc, convex polygon) and **3D primitives** (sphere, box, cylinder, capsule, torus, cone, infinite plane)
- Deform shapes with **transforms**: twist, bend, repeat, noise displacement, symmetry fold, symmetry orbit, tiling, Möbius transform
- Combine shapes with **boolean and smooth blend operations**: union, intersection, difference, and Schur (smooth) blending
- Bridge 2D shapes into 3D with **extrude** and **revolve**
- Reposition any sub-assembly with the **Position / Orient** node, or move the entire final scene with the **output-level placement controls**
- Render in three modes: **CPU contours** (marching squares), **GLSL** (GPU 2D), and **Ray March** (GPU 3D, sphere tracing with soft shadows, ambient occlusion, and multi-light shading)
- Orbit, pan, and snap to preset camera angles (Top, Front, 3/4 Perspective, etc.) to view your work from any side
- Load **example presets** built for game designers, visual artists, and architects, or general-audience showcase scenes
- **Save and load** scenes (stored locally), and **export**:
  - PNG snapshot of the current render
  - GLSL fragment shader source (drop into ShaderToy or any WebGL project)
  - Scene JSON (full graph, for backup or sharing between Isoline sessions)
  - **Binary STL** for 3D printing (marching-cubes mesh extraction, watertight for well-formed SDFs)
- Full **undo/redo** history, and **multi-select** node cards (Shift+click) for group operations
- A collapsible **sidebar** (camera, card layout, and output/render settings) keeps the toolbar uncluttered
- **Presentation mode** (press `F`) hides all UI chrome for clean screenshots, video, or GIFs

---

## Quick start

### Prerequisites

- Node.js (v18+ recommended)
- npm

### Setup

```sh
git clone https://github.com/your-username/ComplexPrimitives.git
cd ComplexPrimitives
npm install
```

### Run locally

```sh
npm start
```

This starts `webpack-dev-server` and opens the app at [http://localhost:8080](http://localhost:8080).

### Build for production

```sh
npm run build
```

This produces an optimized, minified bundle at `dist/bundle.js`. The deployed version of Isoline ([isoline-studio.netlify.app](https://isoline-studio.netlify.app)) is built and hosted via Netlify, which runs this same command automatically on every push to `main`.

---

## How it works

Isoline is built around a **node graph**: every shape, transform, and blend is a node with typed input/output ports. You connect nodes by dragging from one port to another. The graph is evaluated two ways simultaneously:

1. **CPU evaluator** (`NodeEvaluator.js`) — walks the graph and evaluates the signed distance function (SDF) directly in JavaScript. Used for marching-squares contour rendering and STL export (marching cubes).
2. **GLSL evaluator** (`GLSLEvaluator.js`) — compiles the same graph into GLSL shader source, used by the GPU-accelerated GLSL (2D) and Ray March (3D) render modes.

Both evaluators are kept in sync so a graph behaves identically regardless of which render mode you're viewing it in.

### Basic workflow

1. Add a primitive from the **2D Primitive** or **3D Primitive** dropdown in the toolbar.
2. Add a transform from the **Transform / Operation** dropdown — it auto-connects to the selected card (or the sole primitive in an empty graph).
3. Add a blend from the **Blend Mode** dropdown if you want to combine two branches — blend nodes always require manual drag-connect wiring for both inputs.
4. Click **Render** (CPU contours) or switch to **GLSL Mode** / **Ray March** for GPU-accelerated rendering.
5. Use the sidebar (hover the right edge) to adjust camera angle, auto-layout the node cards, or tune render/output settings — including resolution, scan bounds, and final scene placement (position + rotation).
6. Export your result via the **↗** button in the toolbar.

---

## Keyboard shortcuts

| Key                    | Action                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `Ctrl+Z` / `Ctrl+Y`    | Undo / Redo                                                         |
| `Delete` / `Backspace` | Delete selected node card(s)                                        |
| `Shift+Click`          | Add a node card to the current selection                            |
| `Escape`               | Deselect all / exit presentation mode                               |
| `F`                    | Toggle presentation mode (hides all UI for clean screenshots/video) |

---

## Known V1 limitations

These are intentional scope decisions for the first release, not bugs:

- Mixed-dimension boolean operations (combining a 2D shape directly with a 3D shape without an explicit bridge) are blocked with an explanatory message
- Mapper nodes (polynomial, sinusoidal, etc.) only affect the CPU render path — they have no effect in GLSL or Ray March mode
- Concave polygons in the Convex Polygon node are flagged with a warning; full concave support is planned for a future version
- No macro/subgraph reuse system yet — every scene is built node-by-node (planned for a later version, after V1 usage patterns inform the design)
- Material and lighting are fixed in V1 (a capable three-point Ray March lighting rig with Fresnel rim shading is active by default, but not yet user-adjustable)

---

## Roadmap

Isoline's public roadmap moves through five stages: **v1** (this release — a stable, trustworthy core), **v2** (export and practical workflow polish), **v3** (visual richness — adjustable materials and lighting, surface patterning), **v4** (reusable node groups / macros, project organization), and **v5** (ecosystem and optional premium features). The guiding principle throughout: ship a small, reliable core first, then expand only in directions that clearly add value once real usage patterns emerge.

---

## Project structure

src/

├── graph/ # Node graph data model, node type specs, CPU + GLSL evaluators

│ ├── NodeGraph.js

│ ├── NodeSpec.js

│ ├── NodeEvaluator.js

│

├── Primitives/ # SDF primitive implementations

│ ├── regionPrimitives.js # Circle, regular polygon, convex polygon (2D, exact SDF)

│ ├── solidPrimitives.js # Sphere, box, cylinder, capsule, torus, cone, plane (3D)

│ ├── primaryDerivativePrimitives.js # Triangle, arc (2D curve primitives)

│ ├── SchurComposition.js

│

├── rendering/

│ ├── SceneManager.js # Three.js scene, render mode switching, STL export

│ ├── GLSLEvaluator.js # Compiles the node graph to GLSL shader source

│ ├── RayMarchRenderer.js # Sphere-tracing 3D renderer (lighting, shadows, AO)

│ ├── SDFRenderer.js # GLSL 2D renderer

│ ├── WebGLRenderer.js # Shared GPU renderer base class

│

├── ui/

│ ├── NodeCanvas.js # Main UI: toolbar, sidebar, node cards, drag-connect, export panels

│ ├── NodeCard.js # Per-node parameter controls

│ ├── EdgeRenderer.js # Draws connections between node ports

│ ├── PolygonEditor.js # Interactive vertex editor for the Convex Polygon node

│ ├── previewRenderer.js # Small per-node SDF preview thumbnails

│

├── state/

│ ├── stateStore.js # Centralized shape/session registry

│ ├── UndoManager.js

│

├── utils/

│ ├── marchingCubes.js # 3D mesh extraction for STL export

│ ├── stlExport.js # Binary STL serialization

│ ├── transform3D.js # Shared 3D translate/rotate math (Position node + output placement)

│ ├── SDFBlending.js # Smooth union/intersection/difference math

│ ├── DistanceMapping.js

│ ├── affine.js

│

├── presets/

│ ├── presets.js # Example scenes (Gothic Portal, Winged Form, Perforated Facade, etc.)

│

└── index.js # Application entry point, scene initialization

---

## Contributing

This is currently a solo project in active development toward its first public release. Issues and pull requests are welcome once V1 ships — please open an issue first to discuss any significant change before submitting a PR.

---

## License

MIT License — see the [LICENSE](./LICENSE) file for details.

---

## Acknowledgments

Built with [Three.js](https://threejs.org). SDF blending techniques inspired by Inigo Quilez's published work on signed distance functions and smooth boolean operations.
