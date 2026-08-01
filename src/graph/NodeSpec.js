// src/graph/NodeSpec.js

/**
 * Port directions and value types.
 * These are the only types that can flow along graph edges.
 */
export const PortType = {
  SDF:       'sdf',       // A distance field: point → number
  MAPPER:    'mapper',    // A distance mapping function: number → number
  TRANSFORM: 'transform', // An affine matrix
  SCALAR:    'scalar',    // A plain number (can be time-varying)
  VEC2:      'vec2',      // {x, y} — for positions, translations
};

export const PortDirection = {
  IN:  'in',
  OUT: 'out',
};

/**
 * A PortSpec describes one port on a node type.
 * @typedef {Object} PortSpec
 * @property {string}   name      — identifier, unique within the node
 * @property {PortType} type      — what kind of value flows through this port
 * @property {PortDirection} dir  — in or out
 * @property {boolean}  required  — if true, node cannot evaluate without this connection
 * @property {*}        default   — value used when unconnected and not required
 */

/**
 * A ParamSpec describes one configurable parameter on a node type.
 * Parameters are scalars or small value types that appear as GUI controls.
 * They are NOT ports — they cannot be connected to other nodes directly,
 * but any parameter can be overridden by connecting a SCALAR port of the
 * same name (this is how temporal animation works).
 * @typedef {Object} ParamSpec
 * @property {string} name
 * @property {'number'|'vec2'|'select'|'string'} type
 * @property {*}      default
 * @property {*}      [min]
 * @property {*}      [max]
 * @property {*}      [step]
 * @property {Array}  [options]   — for 'select' type
 */

/**
 * A NodeTypeSpec is the complete static description of one node type.
 * @typedef {Object} NodeTypeSpec
 * @property {string}       type       — unique type identifier e.g. 'lineSegment'
 * @property {string}       category   — 'geometry'|'blend'|'mapper'|'transform'|'temporal'|'output'
 * @property {string}       label      — human-readable name
 * @property {PortSpec[]}   ports      — all ports
 * @property {ParamSpec[]}  params     — all parameters
 */

export const NODE_TYPES = {

  // ── Geometry ─────────────────────────────────────────────────────────────

  lineSegment: {
    type: 'lineSegment',
    category: 'geometry',
    label: 'Line Segment',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER,    dir: PortDirection.IN,  required: false, default: null },
      { name: 'sdf',    type: PortType.SDF,        dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'x1', type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Where the line starts (left/right).' },
      { name: 'y1', type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Where the line starts (up/down).' },
      { name: 'x2', type: 'number', default: 1,   min: -10, max: 10, step: 0.01,
        hint: 'Where the line ends (left/right).' },
      { name: 'y2', type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Where the line ends (up/down).' },
    ],
  },

  triangle: {
    type: 'triangle',
    category: 'geometry',
    label: 'Triangle',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER,    dir: PortDirection.IN,  required: false, default: null },
      { name: 'sdf',    type: PortType.SDF,        dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'size',           type: 'number',  default: 1,   min: 0.1, max: 10,  step: 0.01,
        hint: 'How big the triangle is.' },
      { name: 'cornerRounding', type: 'number',  default: 0,   min: 0,   max: 2,   step: 0.01,
        label: 'rounding',
        hint: 'Softens the corners. Higher = rounder.' },
    ],
  },

  arc: {
    type: 'arc',
    category: 'geometry',
    label: 'Arc',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER,    dir: PortDirection.IN,  required: false, default: null },
      { name: 'sdf',    type: PortType.SDF,        dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'radius',     type: 'number', default: 1.5, min: 0.1, max: 10,   step: 0.01,
        hint: 'How big the arc is.' },
      { name: 'startAngle', type: 'number', default: 0,   min: 0,   max: 6.28, step: 0.01,
        hint: 'Where the arc begins, going around the circle.' },
      { name: 'endAngle',   type: 'number', default: 3.14, min: 0,  max: 6.28, step: 0.01,
        hint: 'Where the arc ends. Drag to make it longer or shorter.' },
      { name: 'segments',   type: 'number', default: 8,   min: 3,   max: 64,   step: 1,
        hint: 'How smooth the curve looks. Higher = smoother.' },
    ],
  },

  circle: {
    type: 'circle',
    category: 'geometry',
    label: 'Circle',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER,    dir: PortDirection.IN,  required: false, default: null },
      { name: 'sdf',    type: PortType.SDF,        dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'radius', type: 'number', default: 1,  min: 0.01, max: 10, step: 0.01,
        hint: 'How big the circle is.' },
    ],
  },

  polytope: {
    type: 'polytope',
    category: 'geometry',
    label: 'Polytope',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.IN,  required: false, default: null },
      { name: 'sdf',    type: PortType.SDF,    dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'vertices', type: 'string',  default: '[[-1,-1],[1,-1],[1,1],[-1,1]]',
        hint: 'The corner points that outline your custom shape.' },
    ],
  },

  regularPolygon: {
    type: 'regularPolygon',
    category: 'geometry',
    label: 'Regular Polygon',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER,    dir: PortDirection.IN,  required: false, default: null },
      { name: 'sdf',    type: PortType.SDF,        dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'sides', type: 'number', default: 6,  min: 3,   max: 32,   step: 1,
        hint: 'How many sides the shape has — 3 for a triangle, 6 for a hexagon, and so on.' },
      { name: 'size',  type: 'number', default: 1,  min: 0.1, max: 10,   step: 0.01,
        hint: 'How big the shape is.' },
    ],
  },

  // ── Solid geometry ────────────────────────────────────────────────────────

  sphere: {
    type: 'sphere',
    category: 'geometry',
    label: 'Sphere',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'radius', type: 'number', default: 1,  min: 0.01, max: 10, step: 0.01,
        hint: 'How big the sphere is.' },
    ],
  },

  box: {
    type: 'box',
    category: 'geometry',
    label: 'Box',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'width',          type: 'number', default: 2,  min: 0.01, max: 10, step: 0.01,
        hint: 'How wide the box is.' },
      { name: 'height',         type: 'number', default: 2,  min: 0.01, max: 10, step: 0.01,
        hint: 'How tall the box is.' },
      { name: 'depth',          type: 'number', default: 2,  min: 0.01, max: 10, step: 0.01,
        hint: 'How deep the box is (front to back).' },
      { name: 'cornerRounding', type: 'number', default: 0,  min: 0,    max: 1,  step: 0.01,
        label: 'rounding',
        hint: 'Softens the edges and corners. 0 = sharp box, 1 = fully rounded.' },
    ],
  },

  cylinder: {
    type: 'cylinder',
    category: 'geometry',
    label: 'Cylinder',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'radius',         type: 'number', default: 1,    min: 0.01, max: 10,  step: 0.01,
        hint: 'How wide the cylinder is.' },
      { name: 'height',         type: 'number', default: 2,    min: 0.01, max: 20,  step: 0.01,
        hint: 'How tall the cylinder is.' },
      { name: 'capped',         type: 'select', default: 'yes', options: ['yes','no'],
        hint: 'Whether the ends are closed (yes) or open like a pipe (no).' },
      { name: 'cornerRounding', type: 'number', default: 0,    min: 0,    max: 1,   step: 0.01,
        label: 'rounding',
        hint: 'Softens the top and bottom edges. 0 = sharp, 1 = fully rounded.' },
    ],
  },

  capsule: {
  type: 'capsule',
  category: 'geometry',
  label: 'Capsule',
  timeVarying: false,
  ports: [
    { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
  ],
  params: [
    { name: 'radius', type: 'number', default: 0.5, min: 0.01, max: 5, step: 0.01,
      hint: 'How thick the capsule is.' },
    { name: 'height', type: 'number', default: 2,   min: 0.01, max: 20, step: 0.01,
      hint: 'How long the capsule is, tip to tip.' },
  ],
},

  torus: {
    type: 'torus',
    category: 'geometry',
    label: 'Torus',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'majorRadius', type: 'number', default: 2,   min: 0.1, max: 10, step: 0.01,
        hint: 'How big the ring is overall.' },
      { name: 'minorRadius', type: 'number', default: 0.5, min: 0.01, max: 5, step: 0.01,
        hint: 'How thick the ring\'s tube is.' },
    ],
  },

  extrudeNode: {
    type: 'extrudeNode',
    category: 'transform',
    label: 'Extrude',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'height', type: 'number', default: 1, min: 0.01, max: 20, step: 0.01,
        hint: 'How deep the shape is pushed through space.' },
    ],
  },

  revolveNode: {
    type: 'revolveNode',
    category: 'transform',
    label: 'Revolve',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'offset', type: 'number', default: 0, min: -5, max: 5, step: 0.01,
        hint: 'How far the shape sits from the spin axis. Push it out to make a ring instead of a solid.' },
      { name: 'axis', type: 'select', default: 'Y', options: ['Y', 'X', 'Z'],
        hint: 'Which direction the shape spins around.' },
    ],
  },

  cone: {
    type: 'cone',
    category: 'geometry',
    label: 'Cone',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'radius', type: 'number', default: 1,  min: 0.01, max: 10, step: 0.01,
        hint: 'How wide the base of the cone is.' },
      { name: 'height', type: 'number', default: 2,  min: 0.01, max: 20, step: 0.01,
        hint: 'How tall the cone is.' },
    ],
  },

  plane: {
    type: 'plane',
    category: 'geometry',
    label: 'Infinite Plane',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'nx',     type: 'number', default: 0,  min: -1,  max: 1,  step: 0.01,
        hint: 'Tilts the floor left/right.' },
      { name: 'ny',     type: 'number', default: 1,  min: -1,  max: 1,  step: 0.01,
        hint: 'Which way the plane faces up/down. Default makes a flat horizontal floor.' },
      { name: 'nz',     type: 'number', default: 0,  min: -1,  max: 1,  step: 0.01,
        hint: 'Tilts the floor forward/back.' },
      { name: 'offset', type: 'number', default: 0,  min: -10, max: 10, step: 0.01,
        hint: 'Moves the whole plane up or down.' },
    ],
  },

  // ── Blend ─────────────────────────────────────────────────────────────────

  rUnion: {
    type: 'rUnion',
    category: 'blend',
    label: 'R-Union',
    timeVarying: false,
    ports: [
      { name: 'sdfA',   type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'sdfB',   type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF,    dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1,
        hint: 'How smoothly the two shapes join. Higher = softer, rounder seam.' },
    ],
  },

  rIntersection: {
    type: 'rIntersection',
    category: 'blend',
    label: 'R-Intersection',
    timeVarying: false,
    ports: [
      { name: 'sdfA',   type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'sdfB',   type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF,    dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1,
        hint: 'How smoothly the overlap blends at its edges.' },
    ],
  },

  rDifference: {
    type: 'rDifference',
    category: 'blend',
    label: 'R-Difference',
    timeVarying: false,
    ports: [
      { name: 'sdfA',   type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'sdfB',   type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF,    dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1,
        hint: 'How smoothly the cut blends into the surface.' },
    ],
  },

  rBlend: {
    type: 'rBlend',
    category: 'blend',
    label: 'R-Blend',
    timeVarying: false,
    ports: [
      { name: 'sdfA',   type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'sdfB',   type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'operation',  type: 'select', default: 'union',
        options: ['union', 'intersection', 'difference'],
        hint: 'How the two shapes combine: merge, overlap only, or cut one from the other.' },
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1,
        hint: 'How smoothly the two shapes join. Higher = softer, rounder joins.' },
    ],
  },

  schurBlend: {
    type: 'schurBlend',
    category: 'blend',
    label: 'Schur Blend',
    timeVarying: false,
    ports: [
      { name: 'sdfA',      type: PortType.SDF,       dir: PortDirection.IN,  required: true,  default: null },
      { name: 'sdfB',      type: PortType.SDF,       dir: PortDirection.IN,  required: true,  default: null },
      { name: 'transform', type: PortType.TRANSFORM,  dir: PortDirection.IN,  required: false, default: null },
      { name: 'mapper',    type: PortType.MAPPER,     dir: PortDirection.IN,  required: false, default: null },
      { name: 'result',    type: PortType.SDF,        dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'operation',  type: 'select', default: 'union',
        options: ['union', 'intersection', 'difference'],
        hint: 'How the two shapes combine: merge, overlap only, or cut one from the other.' },
      { name: 'smoothness', type: 'number', default: 8,    min: 0,   max: 32,   step: 0.1,
        label: 'smoothness',
        hint: 'How smoothly the two shapes merge together. Higher = softer, rounder joins.' },
      { name: 'isoOffset',  type: 'number', default: 0.15, min: 0,   max: 2,    step: 0.01,
        label: 'boundary',
        hint: 'Fine-tunes the outer edge of the blend. Nudge this if the shape looks too thin or hollow.' },
    ],
  },

  morphBlend: {
    type: 'morphBlend',
    category: 'blend',
    label: 'Morph',
    timeVarying: true,
    ports: [
      { name: 'sdfA',   type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'sdfB',   type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 't', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01,
        hint: 'Dissolve from the first shape (0) to the second shape (1).' },
      { name: 'animated', type: 'select', default: 'no', options: ['yes','no'],
        hint: 'Makes the shape continuously morph back and forth over time, ignoring the slider above.' },
      { name: 'speed', type: 'number', default: 0.8, min: 0, max: 3, step: 0.05,
        hint: 'How fast the shape morphs back and forth, when animated.' },
    ],
  },

  embedNode: {
    type: 'embedNode',
    category: 'blend',
    label: 'Emboss / Engrave',
    hint: 'Decorates a small area of the first shape\'s surface with the second ' +
          'shape. Emboss = raises a bump/dome sticking OUT of the surface ' +
          '(like a rivet). Engrave = carves a dent/cavity INTO the surface ' +
          '(like a thumbprint). Use the "Pick Anchor on Surface" button — it ' +
          'now also shows RED/GREEN/BLUE axis lines at the anchor: red and ' +
          'green run ALONG the surface, blue runs INTO/OUT of it. The second ' +
          'shape\'s own Transform (position AND rotation) operates relative ' +
          'to THESE axes, not world space — that\'s why rotating it can look ' +
          'unpredictable from the camera\'s point of view. Start with the ' +
          'guest\'s position at (0,0,0) and use the axis colors as your guide ' +
          'when rotating it.',
    timeVarying: false,
    ports: [
      { name: 'hostSdf',  type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'guestSdf', type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result',   type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'operation', type: 'select', default: 'emboss', options: ['emboss','engrave'],
        hint: 'Emboss = a raised bump sticking out (like a rivet). Engrave = a carved-in dent (like a thumbprint). Want a dimple or hole in a face? Use Engrave, not Emboss.' },
      { name: 'anchorX', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'World position of the decoration (left/right). Use "Pick Anchor on Surface" instead of typing this directly — (0,0,0) is usually the host\'s CENTER, not its surface.' },
      { name: 'anchorY', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'World position of the decoration (up/down). See the note on anchorX.' },
      { name: 'anchorZ', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'World position of the decoration (front/back). See the note on anchorX.' },
      { name: 'regionSize', type: 'number', default: 1.0, min: 0.05, max: 10, step: 0.05,
        hint: 'How wide an area of the surface is affected, in every direction ALONG the surface from the anchor — the FOOTPRINT of the decoration. This does NOT control how deep/tall it reaches — see "depth" for that.' },
      { name: 'depth', type: 'number', default: 0.35, min: 0.02, max: 5, step: 0.01,
        hint: 'How far the effect reaches from the TRUE surface — the emboss height or engrave depth. Keep this modest. A large depth combined with a wide footprint risks the decoration spilling past the host\'s own edges into empty space, producing disconnected floating fragments.' },
    ],
  },

  ifsBlend: {
    type: 'ifsBlend',
    category: 'blend',
    label: 'IFS Blend',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF,    dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'iterations',  type: 'number', default: 3,   min: 1, max: 8,    step: 1,
        hint: 'How many nested copies to create — like zooming into a fractal.' },
      { name: 'iterRotation', type: 'number', default: 0,   min: 0, max: 6.28, step: 0.01,
        label: 'iter. rotation',
        hint: 'How much each copy rotates relative to the one before it.' },
      { name: 'iterScale',    type: 'number', default: 0.5, min: 0.01, max: 1, step: 0.01,
        label: 'iter. scale',
        hint: 'How much smaller each copy gets.' },
      { name: 'iterOffsetX',  type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        label: 'iter. offset X',
        hint: 'How far each copy shifts sideways from the one before it.' },
      { name: 'iterOffsetY',  type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        label: 'iter. offset Y',
        hint: 'How far each copy shifts up/down from the one before it.' },
    ],
  },

  // ── Mapper ────────────────────────────────────────────────────────────────

  identityMapper: {
    type: 'identityMapper',
    category: 'mapper',
    label: 'Identity',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [],
  },

  polynomialMapper: {
    type: 'polynomialMapper',
    category: 'mapper',
    label: 'Polynomial',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'c0', type: 'number', default: 0,   min: -5, max: 5, step: 0.01,
        hint: 'Shifts the edge in or out overall.' },
      { name: 'c1', type: 'number', default: 1,   min: -5, max: 5, step: 0.01,
        hint: 'Basic scale of the effect — 1 leaves the shape unchanged.' },
      { name: 'c2', type: 'number', default: 0,   min: -5, max: 5, step: 0.01,
        hint: 'Adds a curved bulge or pinch to the edge.' },
      { name: 'c3', type: 'number', default: 0,   min: -5, max: 5, step: 0.01,
        hint: 'Adds a more complex S-shaped warp to the edge.' },
      { name: 'band', type: 'number', default: 1.0, min: 0.05, max: 5, step: 0.05,
        label: 'reach',
        hint: 'How far from the true edge the effect extends. Keep this small (under ~2) for 3D shapes — pushing c2/c3 high with a large reach can flip inside/outside far from the surface, making the shape vanish or balloon unexpectedly.' },
    ],
  },

  sinusoidalMapper: {
    type: 'sinusoidalMapper',
    category: 'mapper',
    label: 'Sinusoidal',
    timeVarying: true,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'a', type: 'number', default: 1, min: -5,   max: 5,    step: 0.01,
        hint: 'How strongly the edge ripples.' },
      { name: 'b', type: 'number', default: 4, min: 0.01, max: 20,   step: 0.01,
        hint: 'How many ripples fit around the edge. Higher = more, finer ripples.' },
      { name: 'c', type: 'number', default: 0, min: -6.28, max: 6.28, step: 0.01,
        hint: 'Shifts where the ripples start.' },
      { name: 'e', type: 'number', default: 0, min: -5,   max: 5,    step: 0.01,
        hint: 'Nudges the edge in or out, right at the surface.' },
      { name: 'band', type: 'number', default: 1.0, min: 0.05, max: 5, step: 0.05,
        label: 'reach',
        hint: 'How far from the true edge the ripple extends. Keep this small (under ~2) for 3D shapes — a large reach combined with tight ripples (high "b") can produce a giant, unintended blob or make the shape vanish entirely.' },
      { name: 'animated', type: 'select', default: 'no', options: ['yes','no'],
        hint: 'Makes the ripple pulse in and out over time.' },
      { name: 'speed', type: 'number', default: 0.8, min: 0, max: 3, step: 0.05,
        hint: 'How fast the ripple pulses, when animated.' },
    ],
  },

  exponentialMapper: {
    type: 'exponentialMapper',
    category: 'mapper',
    label: 'Exponential',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'a', type: 'number', default: 1, min: -5, max: 5,  step: 0.01,
        hint: 'Overall strength of the effect.' },
      { name: 'b', type: 'number', default: 1, min: -5, max: 5,  step: 0.01,
        hint: 'How quickly the falloff accelerates.' },
      { name: 'c', type: 'number', default: 0, min: -5, max: 5,  step: 0.01,
        hint: 'Shifts the edge in or out overall.' },
    ],
  },

  logarithmicMapper: {
    type: 'logarithmicMapper',
    category: 'mapper',
    label: 'Logarithmic',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'a', type: 'number', default: 1, min: -5,  max: 5,  step: 0.01,
        hint: 'Overall strength of the effect.' },
      { name: 'b', type: 'number', default: 1, min: 0.01, max: 10, step: 0.01,
        hint: 'How quickly the falloff compresses.' },
      { name: 'c', type: 'number', default: 1, min: 0.01, max: 10, step: 0.01,
        hint: 'Prevents a mathematical error right at the edge — usually leave as is.' },
      { name: 'e', type: 'number', default: 0, min: -5,  max: 5,  step: 0.01,
        hint: 'Shifts the edge in or out overall.' },
    ],
  },

  powerMapper: {
    type: 'powerMapper',
    category: 'mapper',
    label: 'Power',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'a', type: 'number', default: 1, min: -5,  max: 5,  step: 0.01,
        hint: 'Overall strength of the effect.' },
      { name: 'b', type: 'number', default: 2, min: 0.01, max: 8,  step: 0.01,
        hint: 'How sharply the falloff curve bends.' },
      { name: 'c', type: 'number', default: 0, min: -5,  max: 5,  step: 0.01,
        hint: 'Shifts the edge in or out overall.' },
    ],
  },

  periodicMapper: {
    type: 'periodicMapper',
    category: 'mapper',
    label: 'Periodic',
    timeVarying: false,
    ports: [
      { name: 'base',   type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'period', type: 'number', default: 1, min: 0.01, max: 10, step: 0.01 },
    ],
  },

    temporalMapper: {
    type: 'temporalMapper',
    category: 'mapper',
    label: 'Temporal',
    timeVarying: true,
    ports: [
      { name: 'base',   type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'frequency', type: 'number', default: 1,   min: 0.01, max: 10, step: 0.01 },
      { name: 'amplitude', type: 'number', default: 0.5, min: 0,    max: 5,  step: 0.01 },
    ],
  },

  recursiveMapper: {
    type: 'recursiveMapper',
    category: 'mapper',
    label: 'Recursive',
    timeVarying: false,
    ports: [
      { name: 'base',   type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'iterations', type: 'number', default: 2,   min: 1, max: 8,  step: 1    },
      { name: 'strength',   type: 'number', default: 0.5, min: 0, max: 1,  step: 0.01 },
    ],
  },

  blendedMapper: {
    type: 'blendedMapper',
    category: 'mapper',
    label: 'Blended',
    timeVarying: false,
    ports: [
      { name: 'mapperA', type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapperB', type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapper',  type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'blendFactor', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
  },

  compositeMapper: {
    type: 'compositeMapper',
    category: 'mapper',
    label: 'Composite',
    timeVarying: false,
    ports: [
      { name: 'mapperA', type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapperB', type: PortType.MAPPER, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'mapper',  type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'combiner', type: 'select', default: 'add',
        options: ['add', 'subtract', 'multiply', 'divide', 'min', 'max'] },
    ],
  },

  symmetryFoldNode: {
    type: 'symmetryFoldNode',
    category: 'transform',
    label: 'Symmetry Fold',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'folds',    type: 'number', default: 6,    min: 1,  max: 32,   step: 1,
        hint: 'How many mirrored slices to fold the shape into.' },
      { name: 'foldCenterX',  type: 'number', default: 0,    min: -5, max: 5,    step: 0.01,
        hint: 'Where the mirroring happens around (left/right). Different from moving the shape itself.' },
      { name: 'foldCenterY',  type: 'number', default: 0,    min: -5, max: 5,    step: 0.01,
        hint: 'Where the mirroring happens around (up/down).' },
      { name: 'rotation', type: 'number', default: 0,    min: 0,  max: 6.28, step: 0.01,
        hint: 'Rotates the mirrored pattern in place.' },
      { name: 'reflectX', type: 'select', default: 'no', options: ['yes', 'no'],
        hint: 'Adds a mirror-image flip left/right.' },
      { name: 'reflectY', type: 'select', default: 'no', options: ['yes', 'no'],
        hint: 'Adds a mirror-image flip up/down.' },
    ],
  },

  symmetryOrbitNode: {
    type: 'symmetryOrbitNode',
    category: 'transform',
    label: 'Symmetry Orbit',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'folds',      type: 'number', default: 6,     min: 1,  max: 32,   step: 1,
        hint: 'How many copies to place around the center.' },
      { name: 'orbitCenterX',    type: 'number', default: 0,     min: -5, max: 5,    step: 0.01,
        hint: 'Where the copies orbit around (left/right). Different from moving the shape itself.' },
      { name: 'orbitCenterY',    type: 'number', default: 0,     min: -5, max: 5,    step: 0.01,
        hint: 'Where the copies orbit around (up/down).' },
      { name: 'rotation',   type: 'number', default: 0,     min: 0,  max: 6.28, step: 0.01,
        hint: 'Rotates where the first copy starts.' },
      { name: 'reflectX',   type: 'select', default: 'no',  options: ['yes', 'no'],
        hint: 'Adds a mirrored copy alongside each one, doubling the pattern.' },
      { name: 'combiner',   type: 'select', default: 'min', options: ['min', 'max', 'smoothMin'],
        hint: 'How the copies join: separate shapes, only where they all overlap, or a smooth blend.' },
      { name: 'smoothness', type: 'number', default: 8,     min: 0,  max: 32,   step: 0.1,
        hint: 'Softens where the copies meet, when "smooth blend" is selected above.' },
    ],
  },

  mobiusNode: {
    type: 'mobiusNode',
    category: 'transform',
    label: 'Möbius Transform',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'aRe', type: 'number', default: 1,  min: -5, max: 5, step: 0.01,
        hint: 'Warps the shape in a swirling way. Try small changes and watch the result.' },
      { name: 'aIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Adjusts the swirl further. Experimental — small nudges go a long way.' },
      { name: 'bRe', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Shifts the warp\'s center point.' },
      { name: 'bIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Shifts the warp\'s center point in the other direction.' },
      { name: 'cRe', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Introduces a mirror-like inversion effect. Small values only.' },
      { name: 'cIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Adjusts the inversion effect further.' },
      { name: 'dRe', type: 'number', default: 1,  min: -5, max: 5, step: 0.01,
        hint: 'Balances the warp. Keep near its default unless exploring.' },
      { name: 'dIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Balances the warp further.' },
    ],
  },

  tilingNode: {
    type: 'tilingNode',
    category: 'transform',
    label: 'Tiling',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'lattice',  type: 'select', default: 'square',
        options: ['square', 'hexagonal', 'triangular', 'brick'],
        hint: 'The pattern the copies are arranged in — a grid, a honeycomb, or offset rows like bricks.' },
      { name: 'periodX',  type: 'number', default: 3,   min: 0.1, max: 20, step: 0.1,
        hint: 'How far apart the copies are, left to right.' },
      { name: 'periodY',  type: 'number', default: 3,   min: 0.1, max: 20, step: 0.1,
        hint: 'How far apart the copies are, up and down.' },
      { name: 'offsetX',  type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Shifts the whole pattern sideways.' },
      { name: 'offsetY',  type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Shifts the whole pattern up or down.' },
      { name: 'isoOffset', type: 'number', default: 0.15, min: 0, max: 2, step: 0.01,
        label: 'boundary',
        hint: 'Fine-tunes the edge of each copy. Nudge this if the shapes look too thin or hollow.' },
      { name: 'extent', type: 'select', default: 'infinite', options: ['infinite', 'finite'],
        hint: 'Infinite: repeats forever in every direction. Finite: repeats a limited number of times, like the old Repeat node.' },
      { name: 'countX', type: 'number', default: 3, min: 1, max: 20, step: 1,
        hint: 'How many copies left to right. Only used when Extent = Finite.' },
      { name: 'countY', type: 'number', default: 3, min: 1, max: 20, step: 1,
        hint: 'How many copies up and down. Only used when Extent = Finite.' },
      { name: 'countZ', type: 'number', default: 1, min: 1, max: 20, step: 1,
        hint: 'How many copies front to back (3D scenes only). Only used when Extent = Finite.' },
      { name: 'periodZ', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'How far apart copies are, front to back (3D scenes only).' },
    ],
  },

  // ── Transform ─────────────────────────────────────────────────────────────

  transform3DNode: {
    type: 'transform3DNode',
    category: 'transform',
    label: 'Position / Orient',
    hint: 'Moves and rotates this piece before it\'s combined with the rest of ' +
          'the scene — handy for placing one part relative to another, like a ' +
          'wing next to a body, before blending them together.',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'posX', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'Moves this piece left or right.' },
      { name: 'posY', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'Moves this piece up or down.' },
      { name: 'posZ', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'Moves this piece toward or away from the camera. Only visible in 3D view.' },
      { name: 'rotateX', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        hint: 'Tilts this piece forward or back. Only visible in 3D view.' },
      { name: 'rotateY', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        hint: 'Turns this piece left or right. Only visible in 3D view.' },
      { name: 'rotateZ', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        hint: 'Spins this piece like a wheel.' },
    ],
  },

  affineTransform: {
    type: 'affineTransform',
    category: 'transform',
    label: 'Affine Transform',
    timeVarying: false,
    ports: [
      { name: 'transform', type: PortType.TRANSFORM, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'rotation', type: 'number', default: 0,   min: 0,   max: 6.28, step: 0.01 },
      { name: 'scale',    type: 'number', default: 1,   min: 0.01, max: 10,  step: 0.01 },
      { name: 'posX',     type: 'number', default: 0,   min: -10, max: 10,   step: 0.01 },
      { name: 'posY',     type: 'number', default: 0,   min: -10, max: 10,   step: 0.01 },
    ],
  },

  // ── Temporal (animation sources) ──────────────────────────────────────────

  timeNode: {
    type: 'timeNode',
    category: 'temporal',
    label: 'Time',
    timeVarying: true,
    ports: [
      { name: 'value', type: PortType.SCALAR, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [],
  },

  oscillatorNode: {
    type: 'oscillatorNode',
    category: 'temporal',
    label: 'Oscillator',
    timeVarying: true,
    ports: [
      { name: 'value', type: PortType.SCALAR, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'frequency', type: 'number', default: 1,   min: 0.01, max: 20, step: 0.01 },
      { name: 'amplitude', type: 'number', default: 1,   min: 0,    max: 10, step: 0.01 },
      { name: 'phase',     type: 'number', default: 0,   min: 0,    max: 6.28, step: 0.01 },
      { name: 'waveform',  type: 'select', default: 'sine',
        options: ['sine', 'square', 'sawtooth', 'triangle', 'noise'] },
    ],
  },

  // ── Output ────────────────────────────────────────────────────────────────

  noiseDisplaceNode: {
    type: 'noiseDisplaceNode',
    category: 'transform',
    label: 'Noise Displace',
    timeVarying: true,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'amplitude', type: 'number', default: 0.3,  min: 0,    max: 2,    step: 0.01,
        hint: 'How bumpy the surface looks. Higher = rougher.' },
      { name: 'frequency', type: 'number', default: 3.0,  min: 0.1,  max: 20,   step: 0.1,
        hint: 'How fine or coarse the bumps are. Higher = finer detail.' },
      { name: 'animated',  type: 'select', default: 'no', options: ['yes','no'],
        hint: 'Makes the bumps shift and move over time, like rippling water.' },
      { name: 'speed', type: 'number', default: 0.4, min: 0, max: 3, step: 0.05,
        hint: 'How fast the bumps move, when animated.' },
    ],
  },

  twistNode: {
    type: 'twistNode',
    category: 'transform',
    label: 'Twist',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'strength', type: 'number', default: 1.0, min: -10, max: 10, step: 0.1,
        hint: 'How much the shape twists. Negative values twist the other way.' },
    ],
  },

  bendNode: {
    type: 'bendNode',
    category: 'transform',
    label: 'Bend',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'strength', type: 'number', default: 0.5, min: -5, max: 5, step: 0.1,
        hint: 'How much the shape curves. Negative values bend the other way.' },
    ],
  },

  repeatNode: {
    type: 'repeatNode',
    category: 'transform',
    label: 'Repeat',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'countX', type: 'number', default: 3,   min: 1, max: 20,  step: 1,
        hint: 'How many copies left to right.' },
      { name: 'countY', type: 'number', default: 3,   min: 1, max: 20,  step: 1,
        hint: 'How many copies up and down.' },
      { name: 'countZ', type: 'number', default: 1,   min: 1, max: 20,  step: 1,
        hint: 'How many copies front to back. Leave at 1 for flat, 2D scenes.' },
      { name: 'spacingX', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'How far apart the copies are, left to right.' },
      { name: 'spacingY', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'How far apart the copies are, up and down.' },
      { name: 'spacingZ', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'How far apart the copies are, front to back.' },
    ],
  },

  outputNode: {
    type: 'outputNode',
    category: 'output',
    label: 'Output',
    timeVarying: false,
    ports: [
      { name: 'sdf', type: PortType.SDF, dir: PortDirection.IN, required: true, default: null, multi: true },
    ],
    params: [
      { name: 'renderMethod', type: 'select', default: 'contours (2D)',
        options: ['contours (2D)', 'fill (2D)', 'arcs', 'surface (3D)'] },
      { name: 'resolution',   type: 'number', default: 150, min: 20, max: 400, step: 10 },
      { name: 'boundsMin',    type: 'number', default: -4,  min: -20, max: 0,  step: 0.5 },
      { name: 'boundsMax',    type: 'number', default: 4,   min: 0,   max: 20, step: 0.5 },

      // ── Object placement ─────────────────────────────────────────────────
      // Repositions the ENTIRE final composed shape as a single rigid body,
      // after every blend and transform in the graph. Now that every node
      // carries its own full Transform (position/rotation/scale/pivot),
      // this control's role has narrowed to one specific niche: whole-scene
      // reorientation (e.g. STL print orientation) without touching
      // individual nodes. Gated Advanced — its non-zero-value side effect
      // (wireframe proxies do NOT reflect this transform, only the final
      // render does — a real, demonstrated source of confusion) makes it
      // unsuitable as an always-visible Basic-tier control.
      { name: 'posX', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        label: 'placeX',
        hint: 'Moves your ENTIRE finished scene left or right — as one rigid piece. NOTE: this will NOT be reflected in the node-card previews, only in the actual render/export. For arranging individual shapes, use that shape\'s own Transform section instead.' },
      { name: 'posY', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        label: 'placeY',
        hint: 'Moves your ENTIRE finished scene up or down — as one rigid piece. NOTE: this will NOT be reflected in the node-card previews, only in the actual render/export. For arranging individual shapes, use that shape\'s own Transform section instead.' },
      { name: 'posZ', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        label: 'placeZ',
        hint: 'Moves your ENTIRE finished scene toward or away from the camera — as one rigid piece. Only visible in 3D view. NOTE: this will NOT be reflected in the node-card previews, only in the actual render/export. For arranging individual shapes, use that shape\'s own Transform section instead.' },
      { name: 'rotateX', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        label: 'rotateX',
        hint: 'Tilts your ENTIRE finished scene forward or back — as one rigid piece. Only visible in 3D view. NOTE: this will NOT be reflected in the node-card previews, only in the actual render/export. For arranging individual shapes, use that shape\'s own Transform section instead.' },
      { name: 'rotateY', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        label: 'rotateY',
        hint: 'Turns your ENTIRE finished scene left or right — as one rigid piece. Only visible in 3D view. NOTE: this will NOT be reflected in the node-card previews, only in the actual render/export. For arranging individual shapes, use that shape\'s own Transform section instead.' },
      { name: 'rotateZ', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        label: 'rotateZ',
        hint: 'Spins your ENTIRE finished scene like a wheel — as one rigid piece. NOTE: this will NOT be reflected in the node-card previews, only in the actual render/export. For arranging individual shapes, use that shape\'s own Transform section instead.' },
    ],
  },
};

// ── Universal mapper port injection ─────────────────────────────────────────
// Every SDF-producing node (geometry, blend, transform categories) gains a
// 'mapper' input port automatically, resolved uniformly by the shared
// NodeEvaluator._applyNodeTransform / GLSLEvaluator._wrapWithNodeTransform
// wrapper every node already passes through — rather than requiring each
// node type to wire mapper support individually. Node types that already
// declared their own 'mapper' port (circle, regularPolygon, polytope,
// lineSegment, triangle, arc, schurBlend) are left untouched — they already
// have exactly one, which is what matters.
{
  const SDF_PRODUCING_CATEGORIES = new Set(['geometry', 'blend', 'transform']);
  // affineTransform outputs a TRANSFORM value, not an SDF — excluded.
  const MAPPER_PORT_EXCLUDE = new Set(['affineTransform']);

  Object.values(NODE_TYPES).forEach(spec => {
    if (!SDF_PRODUCING_CATEGORIES.has(spec.category)) return;
    if (MAPPER_PORT_EXCLUDE.has(spec.type)) return;
    const hasMapperPort = spec.ports.some(p => p.name === 'mapper' && p.dir === PortDirection.IN);
    if (hasMapperPort) return;
    spec.ports.push({
      name: 'mapper', type: PortType.MAPPER, dir: PortDirection.IN,
      required: false, default: null,
    });
  });
}