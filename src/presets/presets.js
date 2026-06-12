// File: src/presets/presets.js
//
// ── V1 example presets ────────────────────────────────────────────────────────
// Five hand-authored scenes targeting distinct audiences.
// Each preset is built with graph.addNode / graph.addEdge directly
// (not deserialize) so the format is independent of serialization schema.
//
// Node IDs are small integers unique within each preset only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gothic Portal
 * Target audience: Game designers
 *
 * A pointed arch doorway cross-section — the fundamental unit of gothic
 * level geometry. Two overlapping circles, unioned together to form the
 * classic pointed arch profile, then the interior hollowed with a smaller
 * union, extruded to give thickness, and noise displaced for stone texture.
 *
 * This is immediately recognisable as environment art: a gateway, a window
 * frame, a corridor arch. Game level designers and environment artists will
 * see a usable asset immediately.
 *
 * Demonstrates: circle → rUnion (pointed arch from two overlapping circles)
 * → rDifference (hollow the arch) → extrudeNode → noiseDisplaceNode
 */
export const PRESET_GOTHIC_PORTAL = {
    meta: {
        id:          'gothic-portal',
        label:       'Gothic Portal',
        description: 'A pointed arch doorway. Two circles unioned into a gothic ' +
                     'arch profile, hollowed, extruded, and stone-textured. ' +
                     'Ready for game environment art and level design.',
        audience:    'Game designers',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // Left circle — offset left so it overlaps right circle at the top
            { id: 1, type: 'circle',
              params: { radius: 1.0, posX: -0.5, posY: 0 },
              uiPos:  { x: 60, y: 60 } },
            // Right circle — mirror of left
            { id: 2, type: 'circle',
              params: { radius: 1.0, posX:  0.5, posY: 0 },
              uiPos:  { x: 60, y: 220 } },
            // Union the two circles — produces the pointed arch silhouette
            { id: 3, type: 'rUnion',
              params: { smoothness: 0 },
              uiPos:  { x: 320, y: 140 } },
            // Inner arch — slightly smaller, same shape, for hollowing
            { id: 4, type: 'circle',
              params: { radius: 0.75, posX: -0.38, posY: 0 },
              uiPos:  { x: 60, y: 400 } },
            { id: 5, type: 'circle',
              params: { radius: 0.75, posX:  0.38, posY: 0 },
              uiPos:  { x: 60, y: 540 } },
            { id: 6, type: 'rUnion',
              params: { smoothness: 0 },
              uiPos:  { x: 320, y: 470 } },
            // Subtract inner arch from outer — creates hollow arch profile
            { id: 7, type: 'rDifference',
              params: { smoothness: 0 },
              uiPos:  { x: 580, y: 300 } },
            // Extrude into 3D — gives the arch wall thickness
            { id: 8, type: 'extrudeNode',
              params: { height: 0.4 },
              uiPos:  { x: 820, y: 300 } },
            // Stone surface texture
            { id: 9, type: 'noiseDisplaceNode',
              params: { amplitude: 0.03, frequency: 12.0, animated: 'no' },
              uiPos:  { x: 1060, y: 300 } },
            { id: 10, type: 'outputNode',
              params: { renderMethod: 'surface (3D)', resolution: 150, boundsMin: -3, boundsMax: 3 },
              uiPos:  { x: 1300, y: 300 } },
        ],
        edges: [
            { id: 'e1',  fromNode: 1,  fromPort: 'sdf',    toNode: 3,  toPort: 'sdfA'   },
            { id: 'e2',  fromNode: 2,  fromPort: 'sdf',    toNode: 3,  toPort: 'sdfB'   },
            { id: 'e3',  fromNode: 4,  fromPort: 'sdf',    toNode: 6,  toPort: 'sdfA'   },
            { id: 'e4',  fromNode: 5,  fromPort: 'sdf',    toNode: 6,  toPort: 'sdfB'   },
            { id: 'e5',  fromNode: 3,  fromPort: 'result', toNode: 7,  toPort: 'sdfA'   },
            { id: 'e6',  fromNode: 6,  fromPort: 'result', toNode: 7,  toPort: 'sdfB'   },
            { id: 'e7',  fromNode: 7,  fromPort: 'result', toNode: 8,  toPort: 'sdf'    },
            { id: 'e8',  fromNode: 8,  fromPort: 'result', toNode: 9,  toPort: 'sdf'    },
            { id: 'e9',  fromNode: 9,  fromPort: 'result', toNode: 10, toPort: 'sdf'    },
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

/**
 * Knotted Ribbon
 * Target audience: General
 *
 * A torus subjected to a very strong twist, producing a form that resembles
 * a pretzel, a figure-eight knot, or a Möbius-adjacent ribbon that has
 * looped back on itself. The result is immediately striking — it does not
 * look like any conventional geometric primitive, and invites the viewer
 * to wonder how it was made.
 *
 * Noise displacement adds surface texture that makes it look carved or
 * cast rather than mathematically generated.
 *
 * Demonstrates: torus → twistNode → noiseDisplaceNode. Simple chain,
 * visually complex result. Perfect for showing that isoline produces
 * unexpected forms from simple operations.
 */
export const PRESET_KNOTTED_RIBBON = {
    meta: {
        id:          'knotted-ribbon',
        label:       'Knotted Ribbon',
        description: 'A torus deformed by a strong twist into a knotted ribbon form. ' +
                     'Simple chain, visually unexpected result.',
        audience:    'General',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // Wide torus with a thick tube for maximum visual impact when twisted
            { id: 1, type: 'torus',
              params: { majorRadius: 1.5, minorRadius: 0.42,
                        posX: 0, posY: 0, posZ: 0 },
              uiPos:  { x: 60, y: 120 } },
            // Strong twist — creates visible self-crossing loops
            { id: 2, type: 'twistNode',
              params: { strength: 3.2 },
              uiPos:  { x: 320, y: 120 } },
            // Light noise for organic surface
            { id: 3, type: 'noiseDisplaceNode',
              params: { amplitude: 0.04, frequency: 7.0, animated: 'no' },
              uiPos:  { x: 560, y: 120 } },
            { id: 4, type: 'outputNode',
              params: { renderMethod: 'surface (3D)', resolution: 150, boundsMin: -4, boundsMax: 4 },
              uiPos:  { x: 800, y: 120 } },
        ],
        edges: [
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 2, toPort: 'sdf'    },
            { id: 'e2', fromNode: 2, fromPort: 'result', toNode: 3, toPort: 'sdf'    },
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 4, toPort: 'sdf'    },
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
        description: 'A domed organic sculpture with four sweeping wing lobes ' +
                     'and a cellular-pocked surface texture. Torus + sphere ' +
                     'smooth blend + twist + surface noise.',
        audience:    'Visual artists',
        renderMode:  'rayMarch',
    },
    graph: {
        nodes: [
            // ── Central dome ──────────────────────────────────────────────────
            // The sphere forms the tall central dome — the raised mass that
            // dominates the form when viewed from any angle. Radius 1.0 makes
            // it visually larger than the torus equatorial bulge so the dome
            // clearly rises above the wing plane.
            {
                id:    1,
                type:  'sphere',
                params: { radius: 1.0, posX: 0, posY: 0, posZ: 0 },
                uiPos: { x: 60, y: 60 },
            },

            // ── Wing lobe ring ────────────────────────────────────────────────
            // The torus sits at the equator of the sphere. Its major radius
            // determines how far the wings extend outward; its minor radius
            // determines the thickness/volume of each lobe.
            // majorRadius 1.4 places the lobe centres well outside the sphere
            // surface so they read as distinct wings rather than a simple bulge.
            // minorRadius 0.55 gives them substantial volume.
            {
                id:    2,
                type:  'torus',
                params: {
                    majorRadius: 1.4,
                    minorRadius: 0.55,
                    posX: 0, posY: 0, posZ: 0,
                },
                uiPos: { x: 60, y: 260 },
            },

            // ── Merge dome and wing ring ──────────────────────────────────────
            // High smoothness (20) creates an extremely wide blending zone.
            // This is the key parameter: it makes the torus lobes appear to
            // grow organically out of the sphere rather than being attached
            // to it. The result is the characteristic fluid continuity between
            // dome and lobes visible in the reference image.
            // isoOffset 0.15 compensates for the schurBlend boundary shift.
            {
                id:    3,
                type:  'schurBlend',
                params: {
                    operation:  'union',
                    smoothness: 20,
                    rotation:   0,
                    scale:      1,
                    posX:       0,
                    posY:       0,
                    isoOffset:  0.15,
                },
                uiPos: { x: 320, y: 160 },
            },

            // ── 4-fold symmetry fold ──────────────────────────────────────────
            // The torus has continuous rotational symmetry — it looks the same
            // from every angle around Y. The symmetry fold breaks this into
            // 4 discrete sectors, pinching the torus into 4 distinct lobes at
            // 0°, 90°, 180°, 270°. This creates the 4-wing silhouette.
            // Applied AFTER the schurBlend so the sphere is also folded,
            // maintaining the smooth merge at the lobe roots.
            // rotation 0.785 (45°) rotates the fold axes so lobes point
            // diagonally rather than along the world axes — more dynamic.
            {
                id:    4,
                type:  'symmetryFoldNode',
                params: {
                    folds:    4,
                    centerX:  0,
                    centerY:  0,
                    rotation: 0.785,
                    reflectX: 'no',
                    reflectY: 'no',
                },
                uiPos: { x: 560, y: 160 },
            },

            // ── Organic asymmetry twist ───────────────────────────────────────
            // A very low twist strength introduces subtle rotational asymmetry.
            // Without this the form has perfect 4-fold mechanical symmetry.
            // The reference image shows the wings have a slight spiral quality —
            // they do not droop at identical angles. Strength 0.15 is barely
            // perceptible but changes the feeling from "constructed" to "grown".
            {
                id:    5,
                type:  'twistNode',
                params: { strength: 0.15 },
                uiPos: { x: 800, y: 160 },
            },

            // ── Cellular surface texture ──────────────────────────────────────
            // High frequency (13.0) produces small, dense noise cells that
            // approximate the scale of the pocking in the reference.
            // Amplitude 0.06 creates visible groove depth without destroying
            // the overall form silhouette.
            // The noise at this frequency reads as cellular/reptilian skin.
            // A true voronoi cell pattern with sharp grooves is planned for V2.
            {
                id:    6,
                type:  'noiseDisplaceNode',
                params: { amplitude: 0.06, frequency: 13.0, animated: 'no' },
                uiPos: { x: 1040, y: 160 },
            },

            {
                id:    7,
                type:  'outputNode',
                params: {
                    renderMethod: 'surface (3D)',
                    resolution:   150,
                    boundsMin:    -4,
                    boundsMax:     4,
                },
                uiPos: { x: 1280, y: 160 },
            },
        ],
        edges: [
            // sphere → schurBlend A (dome input)
            { id: 'e1', fromNode: 1, fromPort: 'sdf',    toNode: 3, toPort: 'sdfA'   },
            // torus → schurBlend B (wing ring input)
            { id: 'e2', fromNode: 2, fromPort: 'sdf',    toNode: 3, toPort: 'sdfB'   },
            // merged form → 4-fold fold (pinches torus into 4 distinct wings)
            { id: 'e3', fromNode: 3, fromPort: 'result', toNode: 4, toPort: 'sdf'    },
            // folded form → slight twist (organic asymmetry)
            { id: 'e4', fromNode: 4, fromPort: 'result', toNode: 5, toPort: 'sdf'    },
            // twisted form → cellular surface noise
            { id: 'e5', fromNode: 5, fromPort: 'result', toNode: 6, toPort: 'sdf'    },
            // textured form → output
            { id: 'e6', fromNode: 6, fromPort: 'result', toNode: 7, toPort: 'sdf'    },
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
    PRESET_PERFORATED_FACADE,
    PRESET_KNOTTED_RIBBON,
    PRESET_CORAL_FORMATION,
];