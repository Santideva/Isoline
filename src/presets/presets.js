// File: src/presets/presets.js
//
// ── V1 example presets ────────────────────────────────────────────────────────
// Six hand-authored scenes targeting distinct audiences.
// Each preset is built with graph.addNode / graph.addEdge directly
// (not deserialize) so the format is independent of serialization schema.
//
// Node IDs are small integers unique within each preset only.
// ─────────────────────────────────────────────────────────────────────────────

export const PRESET_GOTHIC_PORTAL = {
    meta: {
        id:          'gothic-portal',
        label:       'Gothic Portal',
        description: 'A massive standing portal ring' + 'on an ancient stone ground plane. Portal cavity faces the ' +
                     'viewer — an opening you could walk through. Animated portal noise.',
        audience:    'Game designers',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Portal torus ring ─────────────────────────────────────────────
            {
                id:    1,
                type:  'torus',
                params: { majorRadius: 2.0, minorRadius: 0.32, posX: 0, posY: 1.8, posZ: 0 },
                uiPos: { x: 60, y: 60 },
            },

            // ── Rotate torus 90° so hole faces viewer ─────────────────────────
            // Default torus hole is along Y (lies flat). rotateX = π/2
            // stands it upright so the cavity faces along Z toward the camera.
            {
                id:    2,
                type:  'transform3DNode',
                params: {
                    posX: 0, posY: 0, posZ: 0,
                    rotateX: 1.5708, rotateY: 0, rotateZ: 0,
                },
                uiPos: { x: 300, y: 60 },
            },

            // ── Animated noise on torus only ──────────────────────────────────
            {
                id:    3,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.022, frequency: 8.0, animated: 'yes' },
                uiPos: { x: 540, y: 60 },
            },

            // ── Ground plane ──────────────────────────────────────────────────
            {
                id:    4,
                type:  'plane',
                params: { normalX: 0, normalY: 1, normalZ: 0, offset: -1.0 },
                uiPos: { x: 60, y: 280 },
            },

            // ── Ground noise — coarse, static ─────────────────────────────────
            {
                id:    5,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.08, frequency: 2.5, animated: 'no' },
                uiPos: { x: 300, y: 280 },
            },

            // ── Pillar cylinder — structural roundness ────────────────────────
            {
                id:    6,
                type:  'cylinder',
                params: { radius: 0.22, height: 2.0, posX: 0, posY: 0, posZ: 0 },
                uiPos: { x: 60, y: 500 },
            },

            // ── Pillar profile line — vertical, for fluted detail ─────────────
            {
                id:    7,
                type:  'lineSegment',
                params: { x1: 0, y1: -1.0, x2: 0, y2: 1.0 },
                uiPos: { x: 60, y: 660 },
            },

            // ── Extrude the line into a slab ──────────────────────────────────
            {
                id:    8,
                type:  'extrudeNode',
                params: { height: 0.24 },
                uiPos: { x: 300, y: 660 },
            },

            // ── Blend cylinder + extruded slab → column cross-section ─────────
            {
                id:    9,
                type:  'rUnion',
                params: { smoothness: 1 },
                uiPos: { x: 540, y: 580 },
            },

            // ── Twist the blended column ──────────────────────────────────────
            {
                id:    10,
                type:  'twistNode',
                params: { strength: 0.45 },
                uiPos: { x: 780, y: 580 },
            },

            // ── Offset pillar assembly to the LEFT side of the portal ─────────
            // Moves the single twisted column to X = -3.2 (to the left of
            // the portal ring whose majorRadius is 2.0, so it clears the ring)
            // and slightly behind the ring (posZ = 0.8) so it reads as
            // a background architectural element rather than blocking the portal.
            // Y = -0.1 lowers it slightly so it sits on the ground plane.
            {
                id:    11,
                type:  'transform3DNode',
                params: {
                    posX: -3.2, posY: -0.1, posZ: 0.8,
                    rotateX: 0, rotateY: 0, rotateZ: 0,
                },
                uiPos: { x: 1020, y: 580 },
            },

            // ── Mirror to create a RIGHT side pillar using symmetry fold ───────
            // A 2-fold symmetry fold with reflectX mirrors the left pillar
            // to the right side of the portal, giving bilateral symmetry
            // without requiring a second separate pillar branch in the graph.
            {
                id:    12,
                type:  'symmetryFoldNode',
                params: {
                    folds:    2,
                    centerX:  0,
                    centerY:  0,
                    rotation: 0,
                    reflectX: 'yes',
                    reflectY: 'no',
                },
                uiPos: { x: 1260, y: 580 },
            },

            // ── Pillar noise — medium amplitude, static ───────────────────────
            {
                id:    13,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.042, frequency: 4.5, animated: 'no' },
                uiPos: { x: 1500, y: 580 },
            },

            // ── Merge portal ring (animated) + ground (static) ────────────────
            {
                id:    14,
                type:  'rUnion',
                params: { smoothness: 2 },
                uiPos: { x: 800, y: 170 },
            },

            // ── Merge scene + pillars ─────────────────────────────────────────
            {
                id:    15,
                type:  'rUnion',
                params: { smoothness: 2 },
                uiPos: { x: 1100, y: 375 },
            },

            {
                id:    16,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -6,
                    boundsMax:     6,
                    posX:         0,
                    posY:         0.4,
                    posZ:         0,
                    rotateX:      0.1,
                    rotateY:      0,
                    rotateZ:      0,
                },
                uiPos: { x: 1340, y: 375 },
            },
        ],
        edges: [
            // torus → rotate (stand upright, hole facing viewer)
            { id: 'e1',  fromNode: 1,  fromPort: 'sdf',    toNode: 2,  toPort: 'sdf'    },
            // rotated torus → animated noise
            { id: 'e2',  fromNode: 2,  fromPort: 'result', toNode: 3,  toPort: 'sdf'    },
            // ground plane → ground noise
            { id: 'e3',  fromNode: 4,  fromPort: 'sdf',    toNode: 5,  toPort: 'sdf'    },
            // cylinder → rUnion A
            { id: 'e4',  fromNode: 6,  fromPort: 'sdf',    toNode: 9,  toPort: 'sdfA'   },
            // line segment → extrude
            { id: 'e5',  fromNode: 7,  fromPort: 'sdf',    toNode: 8,  toPort: 'sdf'    },
            // extruded slab → rUnion B
            { id: 'e6',  fromNode: 8,  fromPort: 'result', toNode: 9,  toPort: 'sdfB'   },
            // blended column → twist
            { id: 'e7',  fromNode: 9,  fromPort: 'result', toNode: 10, toPort: 'sdf'    },
            // twisted column → position offset (move left, slightly behind portal)
            { id: 'e8',  fromNode: 10, fromPort: 'result', toNode: 11, toPort: 'sdf'    },
            // positioned column → symmetry fold (mirror to right side)
            { id: 'e9',  fromNode: 11, fromPort: 'result', toNode: 12, toPort: 'sdf'    },
            // mirrored pillars → pillar noise
            { id: 'e10', fromNode: 12, fromPort: 'result', toNode: 13, toPort: 'sdf'    },
            // animated portal + noisy ground → rUnion
            { id: 'e11', fromNode: 3,  fromPort: 'result', toNode: 14, toPort: 'sdfA'   },
            { id: 'e12', fromNode: 5,  fromPort: 'result', toNode: 14, toPort: 'sdfB'   },
            // portal+ground + noisy pillars → rUnion
            { id: 'e13', fromNode: 14, fromPort: 'result', toNode: 15, toPort: 'sdfA'   },
            { id: 'e14', fromNode: 13, fromPort: 'result', toNode: 15, toPort: 'sdfB'   },
            // full scene → output
            { id: 'e15', fromNode: 15, fromPort: 'result', toNode: 16, toPort: 'sdf'    },
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
        description: 'A 12-fold symmetric petal form extruded into a relief disc. ' +
                     'Like a ceramic tile, decorative rosette, or mandala in 3D.',
        audience:    'Visual artists',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // Small pentagon offset from origin — one petal unit
            { id: 1, type: 'regularPolygon',
              params: { sides: 5, size: 0.28, rotation: 0, posX: 0.85, posY: 0 },
              uiPos:  { x: 60, y: 60 } },
            // 12-fold dihedral symmetry fold — creates the full mandala pattern
            { id: 2, type: 'symmetryFoldNode',
              params: { folds: 12, centerX: 0, centerY: 0, rotation: 0,
                        reflectX: 'yes', reflectY: 'no' },
              uiPos:  { x: 320, y: 60 } },
            // Central disc — gives the mandala a solid core
            { id: 3, type: 'circle',
              params: { radius: 0.3, posX: 0, posY: 0 },
              uiPos:  { x: 60, y: 280 } },
            // Smooth union of folded petals and core disc
            { id: 4, type: 'schurBlend',
              params: { operation: 'union', smoothness: 8,
                        rotation: 0, scale: 1, posX: 0, posY: 0, isoOffset: 0.15 },
              uiPos:  { x: 580, y: 170 } },
            // Outer bounding circle — creates the disc boundary
            { id: 5, type: 'circle',
              params: { radius: 1.3, posX: 0, posY: 0 },
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
              params: { radius: 0.32, posX: 0, posY: 0 },
              uiPos:  { x: 60, y: 60 } },
            // Extrude the circle into a cylindrical hole
            { id: 2, type: 'extrudeNode',
              params: { height: 0.5 },
              uiPos:  { x: 300, y: 60 } },
            // Panel box — the solid slab the holes are punched through
            { id: 3, type: 'box',
              params: { width: 0.9, height: 0.9, depth: 0.4,
                        posX: 0, posY: 0, posZ: 0, cornerRounding: 0.02 },
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
        description: 'A radial sculptural bloom: cylinder and cone smooth-joined ' +
                     'into a petal unit, bent into a curved blade, folded and ' +
                     'orbited into a radial arrangement with animated surface texture. ' +
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
                params: { radius: 1.0, height: 0.7, posX: 0.0, posY: 0.0, posZ: 0.0 },
                uiPos: { x: 60, y: 60 },
            },

            // ── Cone — petal tip ──────────────────────────────────────────────
            // Positioned at posY = half cylinder height so its base meets
            // the cylinder's top flush. Same radius as cylinder base so
            // the schurBlend joins them without a visible seam.
            {
                id:    2,
                type:  'cone',
                params: { radius: 1.0, height: 1.0, posX: 0.0, posY: 0.8, posZ: 0.0 },
                uiPos: { x: 60, y: 260 },
            },

            // ── Schur union — tight join ──────────────────────────────────────
            // Low smoothness so cylinder and cone join cleanly at their
            // shared boundary rather than melting into each other.
            {
                id:    3,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 4,
                    rotation:   0,
                    scale:      1,
                    posX:       0,
                    posY:       0,
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
            {
                id:    5,
                type:  'symmetryFoldNode',
                params: {
                    folds:    3,
                    centerX:  0,
                    centerY:  0,
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
            // petal boundaries sharp and distinct.
            {
                id:    6,
                type:  'symmetryOrbitNode',
                params: {
                    folds:      4,
                    centerX:    0,
                    centerY:    0,
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

/**
 * Knotted Ribbon
 * Target audience: General
 *
 * A flowing, knotted ribbon form built from an arc revolved around an
 * offset axis, then twisted and repeated into a three-dimensional loop.
 * The arc profile gives the ribbon its open, curved cross-section rather
 * than a closed tube. The twist node introduces the characteristic knotted,
 * writhing quality. Noise displacement adds fine surface texture making
 * the ribbon read as a physical material — silk, metal foil, or paper —
 * rather than a geometric abstraction.
 *
 * Demonstrates: arc → revolveNode → twistNode → repeatNode →
 * noiseDisplaceNode. Shows how a 2D curve profile swept into 3D and then
 * deformed produces complex, organic-feeling sculptural forms that do not
 * have an obvious geometric origin.
 */
export const PRESET_KNOTTED_RIBBON = {
    meta: {
        id:          'knotted-ribbon',
        label:       'Knotted Ribbon',
        description: 'A flowing knotted ribbon: arc profile revolved into a curved ' +
                     'tube, twisted, repeated into a looping form, and surface-textured ' +
                     'with noise. Arc + Revolve + Twist + Repeat + Noise.',
        audience:    'General',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Arc profile ───────────────────────────────────────────────────
            // An open arc (not a full circle) so that when revolved it
            // produces an open curved ribbon rather than a closed tube.
            // The sweep angle (~200°) is wide enough to read as a ribbon
            // cross-section but open enough to give the revolved result
            // a distinct edge — essential for the knotted ribbon silhouette.
            {
                id:    1,
                type:  'arc',
                params: {
                    radius:     0.55,
                    startAngle: 0.55,
                    endAngle:   3.90,
                    segments:   24,
                    posX:       0,
                    posY:       0,
                },
                uiPos: { x: 60, y: 60 },
            },

            // ── Revolve the arc into a 3D curved ribbon tube ──────────────────
            // offset controls how far the ribbon sits from the revolution axis.
            // A moderate offset combined with the open arc profile gives a
            // ribbon-like swept form rather than a torus — the open arc means
            // the revolved cross-section has visible edges (inner and outer)
            // rather than being fully closed.
            {
                id:    2,
                type:  'revolveNode',
                params: { offset: 0.85, axis: 'Y' },
                uiPos: { x: 300, y: 60 },
            },

            // ── Twist — the key deformation that creates the knotted quality ──
            // The twist node rotates the geometry around the Y axis as a
            // function of height, introducing the characteristic writhing,
            // knotted appearance. Moderate strength keeps the form readable
            // without collapsing the SDF into rendering artefacts.
            {
                id:    3,
                type:  'twistNode',
                params: { strength: 0.85 },
                uiPos: { x: 540, y: 60 },
            },

            // ── Repeat — creates the looping, multi-strand structure ───────────
            // A small countX repeat with moderate spacing creates the
            // impression of multiple interleaved ribbon strands without
            // requiring multiple separate branches in the graph.
            // countZ=2 adds depth repetition so the form reads as
            // volumetric rather than flat from the default camera angle.
            {
                id:    4,
                type:  'repeatNode',
                params: {
                    countX:   2,
                    countY:   1,
                    countZ:   2,
                    spacingX: 2.6,
                    spacingY: 4.0,
                    spacingZ: 2.6,
                },
                uiPos: { x: 780, y: 60 },
            },

            // ── Noise displacement — surface texture ──────────────────────────
            // Low amplitude, medium-high frequency noise gives the ribbon
            // surface the fine texture of a physical material — the slight
            // irregularity makes it read as silk, metal foil, or paper
            // rather than a perfectly smooth mathematical surface.
            // Static (not animated) so the form reads as a frozen sculpture.
            {
                id:    5,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.018, frequency: 10.0, animated: 'no' },
                uiPos: { x: 1020, y: 60 },
            },

            {
                id:    6,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -4,
                    boundsMax:     4,
                    posX:         0,
                    posY:         0,
                    posZ:         0,
                    rotateX:      0.25,
                    rotateY:      0.4,
                    rotateZ:      0,
                },
                uiPos: { x: 1260, y: 60 },
            },
        ],
        edges: [
            // arc profile → revolve (open arc swept into 3D ribbon tube)
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 2, toPort: 'sdf'    },
            // revolved ribbon → twist (introduces knotted, writhing quality)
            { id: 'e2', fromNode: 2, fromPort: 'result', toNode: 3, toPort: 'sdf'    },
            // twisted ribbon → repeat (multi-strand looping structure)
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 4, toPort: 'sdf'    },
            // repeated strands → noise displacement (physical material texture)
            { id: 'e4', fromNode: 4, fromPort: 'result', toNode: 5, toPort: 'sdf'    },
            // textured ribbon → output
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
            // Small circle offset from origin — profile for revolution
            { id: 1, type: 'circle',
              params: { radius: 0.2, posX: 1.2, posY: 0 },
              uiPos:  { x: 60, y: 60 } },
            // Revolve around Y axis to create a torus ring
            { id: 2, type: 'revolveNode',
              params: { offset: 1.2 },
              uiPos:  { x: 300, y: 60 } },
            // 6-fold symmetry fold to create branching arm structure
            { id: 3, type: 'symmetryFoldNode',
              params: { folds: 6, centerX: 0, centerY: 0, rotation: 0,
                        reflectX: 'yes', reflectY: 'no' },
              uiPos:  { x: 540, y: 60 } },
            // Central sphere — the organism's body
            { id: 4, type: 'sphere',
              params: { radius: 0.65, posX: 0, posY: 0, posZ: 0 },
              uiPos:  { x: 60, y: 300 } },
            // Smooth union — merges arms into the central body
            { id: 5, type: 'schurBlend',
              params: { operation: 'union', smoothness: 12,
                        rotation: 0, scale: 1, posX: 0, posY: 0, isoOffset: 0.15 },
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
                     'from a curved arc profile, and a cellular-pocked surface texture. ' +
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
                    posX:       0,
                    posY:       0,
                },
                uiPos: { x: 60, y: 60 },
            },

            // ── Revolve the arc into a 3D swept wing blade ─────────────────────
            // offset matches the arc's general radial position so the
            // revolution sweeps the blade around at a sensible distance
            // from the central axis — too small and the wing roots
            // overlap awkwardly; too large and they detach from the body.
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
            {
                id:    3,
                type:  'symmetryFoldNode',
                params: {
                    folds:    4,
                    centerX:  0,
                    centerY:  0,
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
                params: { radius: 0.85, posX: 0, posY: 0, posZ: 0 },
                uiPos: { x: 60, y: 280 },
            },

            // ── Merge wings with body ───────────────────────────────────────────
            {
                id:    5,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 14,
                    rotation:   0,
                    scale:      1,
                    posX:       0,
                    posY:       0,
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
    PRESET_GOTHIC_PORTAL,
    PRESET_WINGED_FORM,
    PRESET_KNOTTED_BLOOM,
    PRESET_PERFORATED_FACADE,
    PRESET_KNOTTED_RIBBON,
    PRESET_CORAL_FORMATION,
];