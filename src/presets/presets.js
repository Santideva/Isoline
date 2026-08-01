// File: src/presets/presets.js
//
// ── V1 example presets ────────────────────────────────────────────────────────
// Six hand-authored scenes targeting distinct audiences.
// Each preset is built with graph.addNode / graph.addEdge directly
// (not deserialize) so the format is independent of serialization schema.
//
// Node IDs are small integers unique within each preset only.
// ─────────────────────────────────────────────────────────────────────────────

    export const PRESET_STRUCTURAL_COMPONENT = {
    meta: {
        id:          'structural-component',
        label:       'Structural Component',
        description: 'Box + Box + Schur Union + Sym. Orbit.',
        audience:    'Game designers',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Long shaft box ────────────────────────────────────────────────
            // Narrow cross-section, deep along Z — the elongated bar that
            // reads as a shaft or beam when the orbit replicates it.
            {
                id:    1,
                type:  'box',
                params: {
                    width:          0.68,
                    height:         0.56,
                    depth:          7.00,
                    cornerRounding: 0,
                },
                uiPos: { x: 60, y: 60 },
            },

            // ── Wide head box ─────────────────────────────────────────────────
            // Wider and flatter — reads as the blade or head of each arm
            // when combined with the shaft. Corner rounding softens what
            // would otherwise be a hard geometric intersection.
            {
                id:    2,
                type:  'box',
                params: {
                    width:          3.90,
                    height:         1.00,
                    depth:          2.42,
                    cornerRounding: 0.07,
                },
                uiPos: { x: 60, y: 280 },
            },

            // ── Schur union — joins shaft and head into one arm unit ───────────
            // Very low smoothness so the two boxes join at a near-sharp
            // boundary rather than melting into each other — the mechanical
            // component aesthetic reads best with hard edges rather than
            // fully organic blending. schurBlend no longer carries its own
            // rotation/scale/position — those params were removed in the
            // transform overhaul (mathematically redundant with the node's
            // own transform block, which for this preset stays identity
            // since no placement of the joined arm unit itself is needed).
            {
                id:    3,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 0.40,
                    isoOffset:  0.00,
                },
                uiPos: { x: 340, y: 170 },
            },

            // ── 3-fold symmetry orbit ─────────────────────────────────────────
            // Replicates the single arm unit three times around the center
            // at 120° intervals. reflectX=yes adds mirror copies of each
            // arm, creating the characteristic propeller/screw silhouette
            // visible in the reference render. smoothMin combiner gives
            // the three arms a gentle connection at the center rather than
            // a hard mathematical minimum. orbitCenterX/Y (renamed from
            // centerX/Y) are the fold/orbit pivot, distinct from transform.
            {
                id:    4,
                type:  'symmetryOrbitNode',
                params: {
                    folds:         3,
                    orbitCenterX:  0,
                    orbitCenterY:  0,
                    rotation:      0,
                    reflectX:      'yes',
                    combiner:      'smoothMin',
                    smoothness:    0.40,
                },
                uiPos: { x: 600, y: 170 },
            },

            {
                id:    5,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -6,
                    boundsMax:     6,
                    posX:         0,
                    posY:         0,
                    posZ:         0,
                    rotateX:      0.4,
                    rotateY:      0.6,
                    rotateZ:      0,
                },
                uiPos: { x: 860, y: 170 },
            },
        ],
        edges: [
            // shaft box → schurBlend A
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 3, toPort: 'sdfA'   },
            // head box → schurBlend B
            { id: 'e2', fromNode: 2, fromPort: 'sdf',    toNode: 3, toPort: 'sdfB'   },
            // joined arm unit → 3-fold symmetry orbit
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 4, toPort: 'sdf'    },
            // orbited component → output
            { id: 'e4', fromNode: 4, fromPort: 'result', toNode: 5, toPort: 'sdf'    },
        ],
    },
};

/**
 * Mandala Relief
 * Target audience: Visual artists
 *
 * A 12-fold dihedral symmetry pattern extruded into a shallow disc.
 * The base shape is a regular polygon orbit around a circle, producing
 * petal-like lobes. The symmetry fold then creates 12-way reflection
 * symmetry. Extruding gives it depth and the result looks like a ceramic
 * relief tile, a mandala, or a decorative architectural rosette.
 *
 * This is the kind of form that generative artists, illustrators, and
 * designers working on decorative geometry immediately recognise as
 * something they want to make.
 *
 * Demonstrates: regularPolygon → symmetryFoldNode → schurBlend (with core
 * circle) → extrudeNode. Shows how a simple polygon becomes a complex
 * symmetric form through folding.
 */
export const PRESET_MANDALA_RELIEF = {
    meta: {
        id:          'mandala-relief',
        label:       'Mandala Relief',
        description: 'A 12-fold symmetric petal form extruded into a relief disc.' +
                     'Like a ceramic tile, decorative rosette, or mandala in 3D.',
        audience:    'Visual artists',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // Small pentagon offset from origin — one petal unit.
            // NOTE: this pentagon is centered at the origin now (posX/posY
            // removed with the primitive param cleanup); regularPolygon
            // also no longer has its own 'rotation' param — both were
            // identity-equivalent here (posX/Y:0 after regularPolygon's
            // own offset was folded into the symmetry fold's radius via
            // node 2 in the original design, rotation was already 0),
            // so no transform block is needed for this node.
            { id: 1, type: 'regularPolygon',
              params: { sides: 5, size: 0.28 },
              uiPos:  { x: 60, y: 60 } },
            // 12-fold dihedral symmetry fold — creates the full mandala pattern.
            // centerX/centerY renamed to foldCenterX/foldCenterY (transform
            // overhaul — distinct from the node's own placement transform).
            { id: 2, type: 'symmetryFoldNode',
              params: { folds: 12, foldCenterX: 0, foldCenterY: 0, rotation: 0,
                        reflectX: 'yes', reflectY: 'no' },
              uiPos:  { x: 320, y: 60 } },
            // Central disc — gives the mandala a solid core
            { id: 3, type: 'circle',
              params: { radius: 0.3 },
              uiPos:  { x: 60, y: 280 } },
            // Smooth union of folded petals and core disc. schurBlend no
            // longer carries rotation/scale/posX/posY — those were
            // structurally redundant with the node's own transform (which
            // stays identity here; nothing was actually being placed).
            { id: 4, type: 'schurBlend',
              params: { operation: 'union', smoothness: 8, isoOffset: 0.15 },
              uiPos:  { x: 580, y: 170 } },
            // Outer bounding circle — creates the disc boundary
            { id: 5, type: 'circle',
              params: { radius: 1.3 },
              uiPos:  { x: 60, y: 480 } },
            // Intersect with outer circle to clip the mandala to a clean disc
            { id: 6, type: 'rIntersection',
              params: { smoothness: 0 },
              uiPos:  { x: 820, y: 280 } },
            // Extrude into shallow 3D disc — gives the relief depth
            { id: 7, type: 'extrudeNode',
              params: { height: 0.25 },
              uiPos:  { x: 1060, y: 280 } },
            { id: 8, type: 'outputNode',
              params: { renderMethod: 'surface (3D)', resolution: 150, boundsMin: -3, boundsMax: 3 },
              uiPos:  { x: 1300, y: 280 } },
        ],
        edges: [
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 2, toPort: 'sdf'    },
            { id: 'e2', fromNode: 2, fromPort: 'result', toNode: 4, toPort: 'sdfA'   },
            { id: 'e3', fromNode: 3, fromPort: 'sdf',    toNode: 4, toPort: 'sdfB'   },
            { id: 'e4', fromNode: 5, fromPort: 'sdf',    toNode: 6, toPort: 'sdfB'   },
            { id: 'e5', fromNode: 4, fromPort: 'result', toNode: 6, toPort: 'sdfA'   },
            { id: 'e6', fromNode: 6, fromPort: 'result', toNode: 7, toPort: 'sdf'    },
            { id: 'e7', fromNode: 7, fromPort: 'result', toNode: 8, toPort: 'sdf'    },
        ],
    },
};

/**
 * Perforated Facade
 * Target audience: Architects
 *
 * A parametric perforated screen panel — one of the most common computational
 * design studies in contemporary architecture. A rectangular slab with a
 * hexagonal pattern of holes punched through it using boolean difference,
 * then tiled into a facade grid using the repeat node.
 *
 * Architects doing parametric facade studies, louvre design, or perforated
 * screen exploration will immediately recognise this as a usable design tool.
 * The panel uses a hexagonal polygon subtracted from a box, repeated into
 * a grid.
 *
 * Demonstrates: box → rDifference (with regularPolygon hole) → extrudeNode
 * → repeatNode (facade grid). Shows how boolean operations and repetition
 * produce architectural surface patterns.
 */
export const PRESET_PERFORATED_FACADE = {
    meta: {
        id:          'perforated-facade',
        label:       'Perforated Facade',
        description: 'A hexagonally perforated screen panel tiled into a facade grid. ' +
                     'Boolean difference + repeat. For parametric facade and screen studies.',
        audience:    'Architects',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // Panel circle profile — one circular perforation
            { id: 1, type: 'circle',
              params: { radius: 0.32 },
              uiPos:  { x: 60, y: 60 } },
            // Extrude the circle into a cylindrical hole
            { id: 2, type: 'extrudeNode',
              params: { height: 0.5 },
              uiPos:  { x: 300, y: 60 } },
            // Panel box — the solid slab the holes are punched through
            { id: 3, type: 'box',
              params: { width: 0.9, height: 0.9, depth: 0.4, cornerRounding: 0.02 },
              uiPos:  { x: 60, y: 280 } },
            // Punch the cylindrical hole through the panel slab
            { id: 4, type: 'rDifference',
              params: { smoothness: 0 },
              uiPos:  { x: 560, y: 170 } },
            // Tile into facade grid — 4×4 panels
            { id: 5, type: 'repeatNode',
              params: { countX: 4, countY: 4, countZ: 1,
                        spacingX: 1.0, spacingY: 1.0, spacingZ: 1.0 },
              uiPos:  { x: 800, y: 170 } },
            { id: 6, type: 'outputNode',
              params: { renderMethod: 'surface (3D)', resolution: 150, boundsMin: -3, boundsMax: 3 },
              uiPos:  { x: 1040, y: 170 } },
        ],
        edges: [
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 2, toPort: 'sdf'    },
            { id: 'e2', fromNode: 3, fromPort: 'sdf',    toNode: 4, toPort: 'sdfA'   },
            { id: 'e3', fromNode: 2, fromPort: 'result', toNode: 4, toPort: 'sdfB'   },
            { id: 'e4', fromNode: 4, fromPort: 'result', toNode: 5, toPort: 'sdf'    },
            { id: 'e5', fromNode: 5, fromPort: 'result', toNode: 6, toPort: 'sdf'    },
        ],
    },
};

export const PRESET_KNOTTED_BLOOM = {
    meta: {
        id:          'knotted-bloom',
        label:       'Knotted Bloom',
        description: 'A radial sculptural bloom with animated surface texture. ' +
                     'Cylinder + Cone + Schur + Bend + Sym. Fold + Sym. Orbit + Noise.',
        audience:    'General',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Cylinder — petal body ─────────────────────────────────────────
            // Centred at origin. Narrow radius, moderate height — the
            // schurBlend with the cone will define the final petal shape.
            {
                id:    1,
                type:  'cylinder',
                params: { radius: 1.0, height: 0.7 },
                uiPos: { x: 60, y: 60 },
            },

            // ── Cone — petal tip ──────────────────────────────────────────────
            // Base offset +0.8 on Y so its base meets the cylinder's top
            // flush. Same radius as cylinder base so the schurBlend joins
            // them without a visible seam. This offset is genuine placement
            // (not zero) so it now lives in the node's transform block
            // rather than params.
            {
                id:    2,
                type:  'cone',
                params: { radius: 1.0, height: 1.0 },
                transform: { posY: 0.8 },
                uiPos: { x: 60, y: 260 },
            },

            // ── Schur union — tight join ──────────────────────────────────────
            // Low smoothness so cylinder and cone join cleanly at their
            // shared boundary rather than melting into each other.
            // rotation/scale/posX/posY removed — redundant with the node's
            // own transform, which stays identity here.
            {
                id:    3,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 4,
                    isoOffset:  0.05,
                },
                uiPos: { x: 340, y: 160 },
            },

            // ── Bend — curves the joined petal ────────────────────────────────
            // Applied to the schurBlend result so the entire petal unit
            // (cylinder body + cone tip) curves together as one piece.
            // This gives the characteristic curved-blade petal form that
            // reads as a bloom petal rather than a straight geometric slab.
            {
                id:    4,
                type:  'bendNode',
                params: { strength: 0.5 },
                uiPos: { x: 580, y: 160 },
            },

            // ── Symmetry fold ─────────────────────────────────────────────────
            // Reflective symmetry creates multiple petal copies from one.
            // folds=2 with reflectX and reflectY both yes = 4-way reflection.
            // centerX/centerY renamed to foldCenterX/foldCenterY.
            {
                id:    5,
                type:  'symmetryFoldNode',
                params: {
                    folds:    3,
                    foldCenterX:  0,
                    foldCenterY:  0,
                    rotation: 0,
                    reflectX: 'yes',
                    reflectY: 'yes',
                },
                uiPos: { x: 820, y: 160 },
            },

            // ── Symmetry orbit — radial replication ───────────────────────────
            // Replicates the folded result around the center with rotational
            // symmetry to create the full bloom arrangement. folds=6 gives
            // a 6-fold radial pattern. combiner='min' keeps individual
            // petal boundaries sharp and distinct. centerX/centerY renamed
            // to orbitCenterX/orbitCenterY.
            {
                id:    6,
                type:  'symmetryOrbitNode',
                params: {
                    folds:      4,
                    orbitCenterX:    0,
                    orbitCenterY:    0,
                    rotation:   0,
                    reflectX:   'yes',
                    combiner:   'min',
                    smoothness: 2,
                },
                uiPos: { x: 1060, y: 160 },
            },

            // ── Animated noise ────────────────────────────────────────────────
            // Very low amplitude, fine frequency, animated — gives the
            // bloom surface a subtle living quality without distorting
            // the petal forms.
            {
                id:    7,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.04, frequency: 0.10, animated: 'yes' },
                uiPos: { x: 1300, y: 160 },
            },

            {
                id:    8,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -4,
                    boundsMax:     4,
                    posX:         0,
                    posY:         0,
                    posZ:         0,
                    rotateX:      0.3,
                    rotateY:      0.5,
                    rotateZ:      0,
                },
                uiPos: { x: 1540, y: 160 },
            },
        ],
        edges: [
            // cylinder → schurBlend A
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 3, toPort: 'sdfA'   },
            // cone → schurBlend B
            { id: 'e2', fromNode: 2, fromPort: 'sdf',    toNode: 3, toPort: 'sdfB'   },
            // joined petal → bend (curves into blade/petal form)
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 4, toPort: 'sdf'    },
            // bent petal → symmetry fold
            { id: 'e4', fromNode: 4, fromPort: 'result', toNode: 5, toPort: 'sdf'    },
            // folded → symmetry orbit (radial bloom)
            { id: 'e5', fromNode: 5, fromPort: 'result', toNode: 6, toPort: 'sdf'    },
            // orbited bloom → animated noise
            { id: 'e6', fromNode: 6, fromPort: 'result', toNode: 7, toPort: 'sdf'    },
            // animated bloom → output
            { id: 'e7', fromNode: 7, fromPort: 'result', toNode: 8, toPort: 'sdf'    },
        ],
    },
};

export const PRESET_TILED_SURFACE = {
    meta: {
        id:          'tiled-surface',
        label:       'Tiled Surface',
        description: 'Cylinder + Box + Schur + Sym. Fold + Tiling.',
        audience:    'Architects',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Box — the flat panel or blade component ────────────────────────
            {
                id:    1,
                type:  'box',
                params: {
                    width:          1.77,
                    height:         0.60,
                    depth:          2.00,
                    cornerRounding: 0,
                },
                uiPos: { x: 60, y: 60 },
            },

            // ── Cylinder — the structural column ─────────────────────────────
            // Tall and slender — stands upright as the main vertical element.
            // Combined with the flat box it produces a column-with-fin
            // cross-section that tiles well and reads as an architectural
            // structural member. The old 'axis: Y' dropdown value is gone —
            // Y is now always the cylinder's local axis, and since Y was
            // already the default here, no transform rotation is needed.
            {
                id:    2,
                type:  'cylinder',
                params: {
                    radius: 0.48,
                    height: 10.24,
                    capped: 'yes',
                },
                uiPos: { x: 60, y: 280 },
            },

            // ── Schur union — tight join ───────────────────────────────────────
            // Zero smoothness: hard boolean union so the column and fin
            // panel meet at a sharp architectural edge rather than blending
            // organically. rotation/scale/posX/posY removed — redundant
            // with the node's own transform, which stays identity here.
            {
                id:    3,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 0.00,
                    isoOffset:  0.00,
                },
                uiPos: { x: 340, y: 170 },
            },

            // ── Symmetry fold — bilateral symmetry ─────────────────────────────
            // 2-fold fold with reflectX=yes creates a mirrored pair of the
            // column+fin unit. centerX/centerY renamed to
            // foldCenterX/foldCenterY.
            {
                id:    4,
                type:  'symmetryFoldNode',
                params: {
                    folds:    2,
                    foldCenterX:  0,
                    foldCenterY:  0,
                    rotation: 0,
                    reflectX: 'yes',
                    reflectY: 'no',
                },
                uiPos: { x: 600, y: 170 },
            },

            // ── Triangular tiling ─────────────────────────────────────────────
            // Tiles the symmetry-folded unit across a triangular lattice.
            {
                id:    5,
                type:  'tilingNode',
                params: {
                    lattice:  'triangular',
                    periodX:  3.00,
                    periodY:  3.00,
                    offsetX:  0,
                    offsetY:  0,
                    isoOffset: 0,
                },
                uiPos: { x: 860, y: 170 },
            },

            {
                id:    6,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -6,
                    boundsMax:     6,
                    posX:         0,
                    posY:         0,
                    posZ:         0,
                    rotateX:      0.35,
                    rotateY:      0.5,
                    rotateZ:      0,
                },
                uiPos: { x: 1100, y: 170 },
            },
        ],
        edges: [
            // box → schurBlend A
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 3, toPort: 'sdfA'   },
            // cylinder → schurBlend B
            { id: 'e2', fromNode: 2, fromPort: 'sdf',    toNode: 3, toPort: 'sdfB'   },
            // joined unit → symmetry fold (bilateral mirror)
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 4, toPort: 'sdf'    },
            // folded unit → triangular tiling
            { id: 'e4', fromNode: 4, fromPort: 'result', toNode: 5, toPort: 'sdf'    },
            // tiled surface → output
            { id: 'e5', fromNode: 5, fromPort: 'result', toNode: 6, toPort: 'sdf'    },
        ],
    },
};

/**
 * Coral Formation
 * Target audience: General
 *
 * An organic branching form built from a circle revolved around an offset
 * axis to create a torus ring, then symmetry-folded 6 ways to create
 * branching arm structures, smooth-unioned with a central sphere,
 * and noise displaced for natural texture. The result looks like coral,
 * a sea urchin, a cactus, or an alien organism.
 *
 * This preset is deliberately ambiguous in its reference — it could be
 * natural history, science fiction, or abstract sculpture. It shows that
 * isoline produces forms that do not have an obvious geometric origin.
 *
 * Demonstrates: circle → revolveNode → symmetryFoldNode → schurBlend
 * → noiseDisplaceNode. Shows how 2D→3D bridging combined with symmetry
 * and smooth blending produces organic complexity.
 */
export const PRESET_CORAL_FORMATION = {
    meta: {
        id:          'coral-formation',
        label:       'Coral Formation',
        description: 'An organic branching form — coral, sea urchin, or alien growth. ' +
                     'Revolve + symmetry fold + smooth blend + noise.',
        audience:    'General',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // Small circle offset from origin — profile for revolution.
            // posX:1.2 is genuine placement (not zero), so it now lives in
            // this node's transform block. This offset is what makes the
            // subsequent revolveNode produce a torus ring rather than a
            // solid ball of revolution — preserving it exactly is important.
            { id: 1, type: 'circle',
              params: { radius: 0.2 },
              transform: { posX: 1.2 },
              uiPos:  { x: 60, y: 60 } },
            // Revolve around Y axis to create a torus ring
            { id: 2, type: 'revolveNode',
              params: { offset: 1.2 },
              uiPos:  { x: 300, y: 60 } },
            // 6-fold symmetry fold to create branching arm structure.
            // centerX/centerY renamed to foldCenterX/foldCenterY.
            { id: 3, type: 'symmetryFoldNode',
              params: { folds: 6, foldCenterX: 0, foldCenterY: 0, rotation: 0,
                        reflectX: 'yes', reflectY: 'no' },
              uiPos:  { x: 540, y: 60 } },
            // Central sphere — the organism's body
            { id: 4, type: 'sphere',
              params: { radius: 0.65 },
              uiPos:  { x: 60, y: 300 } },
            // Smooth union — merges arms into the central body.
            // rotation/scale/posX/posY removed — redundant with the node's
            // own transform, which stays identity here.
            { id: 5, type: 'schurBlend',
              params: { operation: 'union', smoothness: 12, isoOffset: 0.15 },
              uiPos:  { x: 780, y: 180 } },
            // Organic noise displacement — makes it look grown, not made
            { id: 6, type: 'noiseDisplaceNode',
              params: { amplitude: 0.08, frequency: 4.0, animated: 'no' },
              uiPos:  { x: 1020, y: 180 } },
            { id: 7, type: 'outputNode',
              params: { renderMethod: 'surface (3D)', resolution: 150, boundsMin: -4, boundsMax: 4 },
              uiPos:  { x: 1260, y: 180 } },
        ],
        edges: [
            // circle profile → revolve
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 2, toPort: 'sdf'    },
            // revolve torus → symmetry fold
            { id: 'e2', fromNode: 2, fromPort: 'result', toNode: 3, toPort: 'sdf'    },
            // folded arms → schurBlend A
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 5, toPort: 'sdfA'   },
            // central sphere → schurBlend B
            { id: 'e4', fromNode: 4, fromPort: 'sdf',    toNode: 5, toPort: 'sdfB'   },
            // blend → noise
            { id: 'e5', fromNode: 5, fromPort: 'result', toNode: 6, toPort: 'sdf'    },
            // noise → output
            { id: 'e6', fromNode: 6, fromPort: 'result', toNode: 7, toPort: 'sdf'    },
        ],
    },
};

/**
 * Winged Form
 * Target audience: Visual artists (replaces Mandala Relief)
 *
 * A smooth organic form with four sweeping wing lobes and a domed central
 * mass, inspired by the sculptural aesthetic of flowing metallic forms.
 * The surface is covered with dense cellular pocking — a high-frequency
 * noise displacement that creates the appearance of reptile scales,
 * cracked leather, or a natural cellular skin texture.
 *
 * Construction:
 *   A small circle offset from the Y axis is revolved to create a torus
 *   ring positioned at the equator of the central sphere. A 4-fold symmetry
 *   fold on that ring creates four equatorial lobes. The lobes are smooth-
 *   unioned with the central sphere at high smoothness so they merge
 *   seamlessly into the dome. A very low-strength twist adds the slight
 *   organic asymmetry visible in the reference. High-frequency noise
 *   displacement then creates the cellular surface texture.
 *
 * Note: Isoline's noise node produces smooth cellular pocking. A true
 * voronoi cell pattern (perfect reptile scales with sharp grooves) requires
 * a dedicated voronoi SDF node planned for V2. The current result reads
 * as cellular texture and is visually faithful to the reference spirit.
 *
 * Demonstrates: circle → revolveNode → symmetryFoldNode → schurBlend
 * (with sphere) → twistNode → noiseDisplaceNode. Shows how a simple
 * revolved profile combined with symmetry folding produces complex organic
 * sculptural mass, and how noise displacement adds surface character.
 */
export const PRESET_WINGED_FORM = {
    meta: {
        id:          'winged-form',
        label:       'Winged Form',
        description: 'A domed organic sculpture with four blade-like wings swept ' +
                     'Arc + revolve + symmetry fold + smooth blend.',
        audience:    'Visual artists',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Wing profile ──────────────────────────────────────────────────
            // An ARC, not a full circle — this is the key change from the
            // previous torus-based construction. A full circle revolved
            // always produces a closed tube (donut-like), regardless of
            // parameters. An open arc swept through revolution produces a
            // genuine blade/fin silhouette with a distinct leading and
            // trailing edge — the actual geometric signature of a wing.
            //
            // startAngle/endAngle sweep ~145° (well under a full 360°/6.28
            // radians) so the revolved result stays open and blade-like
            // rather than closing into a ring.
            // radius controls how far the wing extends outward.
            {
                id:    1,
                type:  'arc',
                params: {
                    radius:     1.15,
                    startAngle: 0.35,
                    endAngle:   2.85,
                    segments:   24,
                },
                uiPos: { x: 60, y: 60 },
            },

            // ── Revolve the arc into a 3D swept wing blade ─────────────────────
            // offset matches the arc's general radial position so the
            // revolution sweeps the blade around at a sensible distance
            // from the central axis. revolveNode's 'axis' param is its own
            // shape-defining choice (which world axis to revolve around) —
            // unlike cylinder/cone's old axis dropdown, this was never
            // touched by the transform overhaul and stays as-is.
            {
                id:    2,
                type:  'revolveNode',
                params: { offset: 0.55, axis: 'Y' },
                uiPos: { x: 300, y: 60 },
            },

            // ── 4-fold symmetry fold ──────────────────────────────────────────
            // Turns the single swept wing blade into four wings arranged
            // radially around the body. rotation offsets the fold axes so
            // wings point diagonally rather than along world axes.
            // centerX/centerY renamed to foldCenterX/foldCenterY.
            {
                id:    3,
                type:  'symmetryFoldNode',
                params: {
                    folds:    4,
                    foldCenterX:  0,
                    foldCenterY:  0,
                    rotation: 0.4,
                    reflectX: 'no',
                    reflectY: 'no',
                },
                uiPos: { x: 540, y: 60 },
            },

            // ── Central dome — untouched by the fold, stays perfectly round ────
            {
                id:    4,
                type:  'sphere',
                params: { radius: 0.85 },
                uiPos: { x: 60, y: 280 },
            },

            // ── Merge wings with body ───────────────────────────────────────────
            // rotation/scale/posX/posY removed — redundant with the node's
            // own transform, which stays identity here.
            {
                id:    5,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 14,
                    isoOffset:  0.15,
                },
                uiPos: { x: 780, y: 170 },
            },

            // ── Slight organic twist ────────────────────────────────────────────
            {
                id:    6,
                type:  'twistNode',
                params: { strength: 0.14 },
                uiPos: { x: 1020, y: 170 },
            },

            // ── Fine surface texture ────────────────────────────────────────────
            {
                id:    7,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.022, frequency: 15.0, animated: 'no' },
                uiPos: { x: 1260, y: 170 },
            },

            {
                id:    8,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -4,
                    boundsMax:     4,
                },
                uiPos: { x: 1500, y: 170 },
            },
        ],
        edges: [
            // arc wing profile → revolve (sweeps into a 3D blade)
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 2, toPort: 'sdf'    },
            // revolved blade → 4-fold symmetry fold (creates 4 wings)
            { id: 'e2', fromNode: 2, fromPort: 'result', toNode: 3, toPort: 'sdf'    },
            // folded wings → schurBlend A
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 5, toPort: 'sdfA'   },
            // round sphere body → schurBlend B (stays round, bypasses fold)
            { id: 'e4', fromNode: 4, fromPort: 'sdf',    toNode: 5, toPort: 'sdfB'   },
            // merged form → slight twist
            { id: 'e5', fromNode: 5, fromPort: 'result', toNode: 6, toPort: 'sdf'    },
            // twisted form → fine surface noise
            { id: 'e6', fromNode: 6, fromPort: 'result', toNode: 7, toPort: 'sdf'    },
            // textured form → output
            { id: 'e7', fromNode: 7, fromPort: 'result', toNode: 8, toPort: 'sdf'    },
        ],
    },
};

/**
 * All presets in display order.
 * The preset panel shows them in this order.
 */
export const PRESETS = [
    PRESET_STRUCTURAL_COMPONENT,
    PRESET_WINGED_FORM,
    PRESET_KNOTTED_BLOOM,
    PRESET_PERFORATED_FACADE,
    PRESET_TILED_SURFACE,
    PRESET_CORAL_FORMATION,
];