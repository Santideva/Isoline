# Isoline

**A browser-based procedural shape studio for building 2D and 3D
forms from connected geometry, transforms, and blends.**

Isoline is a node-based tool for designing procedural shapes and
sculptural forms directly in the browser — no installation required.
Connect primitives, transforms, and blend operations on a visual
graph, and watch your geometry evolve in real time.

![Knotted Bloom preset rendered in Ray March mode](docs/images/knotted-bloom.png)

**Live demo:** [isoline-studio.netlify.app](https://isoline-studio.netlify.app)

▶ [Watch the demo video](https://youtube.com/PASTE_YOUR_LINK_HERE)

---

## What Isoline does

- Build shapes from **2D primitives** (circle, line, triangle,
  regular polygon, arc, convex polygon) and **3D primitives**
  (sphere, box, cylinder, capsule, torus, cone, infinite plane)
- Deform shapes with **transforms**: twist, bend, repeat, noise
  displacement, symmetry fold, symmetry orbit, tiling, Möbius
  transform
- Combine shapes with **boolean and smooth blend operations**:
  union, intersection, difference, and Schur (smooth) blending
- Bridge 2D shapes into 3D with **extrude** and **revolve**
- Reposition any sub-assembly with the **Position / Orient** node,
  or move the entire final scene with the output-level placement
  controls
- Render in three modes: **CPU contours** (marching squares),
  **GLSL** (GPU 2D), and **Ray March** (GPU 3D, sphere tracing
  with soft shadows, ambient occlusion, and multi-light shading)
- Orbit, pan, and snap to preset camera angles (Top, Front,
  3/4 Perspective, etc.)
- Load **example presets** built for game designers, visual
  artists, and architects
- **Save and load** scenes (stored locally), and **export**:
  - PNG snapshot of the current render
  - GLSL fragment shader source (drop into ShaderToy or any
    WebGL project)
  - Scene JSON (full graph, for backup or sharing)
  - **Binary STL** for 3D printing (marching-cubes mesh
    extraction)
- Full **undo/redo** history and multi-select node operations
- **Presentation mode** (press `F`) hides all UI chrome for
  clean screenshots or video capture

---

## How it works

Isoline is built around a **node graph**: every shape, transform,
and blend is a node with typed input/output ports. You connect
nodes by dragging from one port to another. The graph is evaluated
two ways simultaneously:

1. **CPU evaluator** (`NodeEvaluator.js`) — walks the graph and
   evaluates the signed distance function (SDF) directly in
   JavaScript. Used for marching-squares contour rendering and
   STL export (marching cubes).

2. **GLSL evaluator** (`GLSLEvaluator.js`) — compiles the same
   graph into GLSL shader source at runtime, used by the
   GPU-accelerated GLSL (2D) and Ray March (3D) render modes.

### Why SDFs?

Isoline represents geometry as **Signed Distance Functions**
rather than polygon meshes. An SDF is a mathematical function:
given any point in space, it returns the distance to the nearest
surface — positive outside, negative inside, zero at the surface.
Combining two shapes means composing their distance functions
mathematically rather than intersecting meshes — which means no
topology artifacts, smooth boolean blending with controllable
transition zones, and noise displacement that operates at the
mathematical surface level rather than on vertex positions.

The 3D models Isoline produces are fundamentally different from
polygonal models: they are implicitly defined everywhere in space,
evaluated at render time by the ray marcher, and extracted as
meshes only at STL export time. This means the underlying model
is always smooth regardless of the polygon count you choose to
export at.

### Basic workflow

1. Add a primitive from the **2D** or **3D** dropdown in the
   toolbar
2. Add a transform from the **Transform** dropdown — it
   auto-connects to the selected card
3. Add a blend from the **Blend** dropdown to combine two
   branches (blend nodes require manual drag-connect wiring
   for both inputs)
4. Click **Render** or switch to **GLSL Mode** / **Ray March**
   for GPU-accelerated rendering
5. Use the sidebar (hover the right edge) to adjust camera,
   layout, and output settings
6. Export via the **↗** button in the toolbar

---

## Quick start

### Prerequisites

- Node.js (v18+ recommended)
- npm

### Setup

```bash
git clone https://github.com/Santideva/Isoline.git
cd Isoline
npm install
```

### Run locally

```bash
npm start
```

Opens the app at [http://localhost:8080](http://localhost:8080).

### Build for production

```bash
npm run build
```

Produces an optimized bundle at `dist/bundle.js`. The deployed
version at [isoline-studio.netlify.app](https://isoline-studio.netlify.app)
builds and deploys automatically via Netlify on every push to `main`.

---

## Keyboard shortcuts

| Key                    | Action                                |
| ---------------------- | ------------------------------------- |
| `Ctrl+Z` / `Ctrl+Y`    | Undo / Redo                           |
| `Delete` / `Backspace` | Delete selected node card(s)          |
| `Shift+Click`          | Add to current selection              |
| `R`                    | Toggle camera auto-orbit              |
| `F`                    | Toggle presentation mode              |
| `Escape`               | Deselect all / exit presentation mode |

---

## Known V1 limitations

These are intentional scope decisions for the first release,
not bugs:

- **Mapper nodes** only affect the CPU render path — they have
  no effect in GLSL or Ray March mode
- **Mixed-dimension boolean operations** (combining a 2D shape
  directly with a 3D shape without a bridge) are blocked with
  an explanatory message
- **Material and lighting** are fixed in V1 — a three-point
  Ray March lighting rig with Fresnel rim shading is active
  by default, but not yet user-adjustable
- **No macro/subgraph reuse** — every scene is built node-by-node
  (planned for V4)
- **Animated scenes** can be slow on machines without a dedicated
  GPU — an adaptive render scale system mitigates this but does
  not eliminate it

---

## Roadmap

| Version          | Focus                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| **V1** (current) | Stable, trustworthy core                                                               |
| **V2**           | Export polish, practical workflow improvements, mapper nodes in GLSL path              |
| **V3**           | Visual richness — adjustable materials and lighting, surface patterning, radial tiling |
| **V4**           | Reusable node groups / macros, project organization                                    |
| **V5**           | Ecosystem and optional premium features                                                |

The guiding principle: ship a small reliable core first, then
expand only in directions that clearly add value once real usage
patterns emerge.

---

## Contributing

Isoline is an open source project actively seeking contributors
for V2 and beyond. If you are interested in WebGL/GLSL
development, SDF mathematics, node graph UI, or generative
art tooling, there is meaningful work to do here.

**Before submitting a pull request**, please open an issue
first to discuss your proposed change. This avoids duplicate
effort and ensures the approach fits the overall architecture.

### Open issues for V2

See the [Issues tab](https://github.com/Santideva/Isoline/issues)
for tagged contribution opportunities. Current open areas include:

- Mapper node GLSL implementation
- Radial/circular tiling node
- Animation system (per-parameter keyframes, oscillator nodes)
- Terrain SDF node
- Advanced dimensional bridges (loft, path sweep)
- Material and lighting system for Ray March
- Macro/subgraph reuse
- Performance improvements for integrated graphics
- Voronoi/cellular SDF node

### Architecture overview

The codebase has clear separation between three layers:

**Graph / Evaluator layer** — `src/graph/`
Node data model, type specs, CPU evaluator, GLSL compiler.
If you are interested in new node types or improving the
GLSL compilation path, start here.

**Rendering layer** — `src/rendering/`
Three.js scene management, ray march renderer, GLSL 2D
renderer, adaptive resolution, STL export. If you are
interested in rendering performance or visual quality,
start here.

**UI layer** — `src/ui/`
Node canvas, node cards, drag-connect interaction, export
panels, sidebar. If you are interested in UX and interaction
design, start here.

---

## Project structure

src/
├── graph/
│ ├── NodeGraph.js
│ ├── NodeSpec.js
│ ├── NodeEvaluator.js
│ └── GLSLEvaluator.js (moved here from rendering/)
├── Primitives/
│ ├── regionPrimitives.js
│ ├── solidPrimitives.js
│ ├── primaryDerivativePrimitives.js
│ └── SchurComposition.js
├── rendering/
│ ├── SceneManager.js
│ ├── RayMarchRenderer.js
│ ├── SDFRenderer.js
│ └── WebGLRenderer.js
├── ui/
│ ├── NodeCanvas.js
│ ├── NodeCard.js
│ ├── EdgeRenderer.js
│ ├── previewRenderer.js
│ └── PolygonEditor.js
├── state/
│ ├── stateStore.js
│ └── UndoManager.js
├── utils/
│ ├── marchingCubes.js
│ ├── stlExport.js
│ └── transform3D.js
├── presets/
│ └── presets.js
└── index.js

---

## License

MIT — see [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Three.js](https://threejs.org). SDF techniques
inspired by [Inigo Quilez's](https://iquilezles.org) published
work on signed distance functions and smooth boolean operations.
