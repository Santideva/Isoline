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
      { name: 'x1', type: 'number', default: 0,   min: -10, max: 10, step: 0.01 },
      { name: 'y1', type: 'number', default: 0,   min: -10, max: 10, step: 0.01 },
      { name: 'x2', type: 'number', default: 1,   min: -10, max: 10, step: 0.01 },
      { name: 'y2', type: 'number', default: 0,   min: -10, max: 10, step: 0.01 },
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
      { name: 'size',           type: 'number',  default: 1,   min: 0.1, max: 10,  step: 0.01 },
      { name: 'rotation',       type: 'number',  default: 0,   min: 0,   max: 6.28, step: 0.01 },
      { name: 'posX',           type: 'number',  default: 0,   min: -10, max: 10,  step: 0.01 },
      { name: 'posY',           type: 'number',  default: 0,   min: -10, max: 10,  step: 0.01 },
      { name: 'cornerRounding', type: 'number',  default: 0,   min: 0,   max: 2,   step: 0.01,
        label: 'rounding',
        hint: 'Rounds the corners of the triangle. 0 = sharp corners.' },
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
        hint: 'Distance from the centre to the arc curve.' },
      { name: 'startAngle', type: 'number', default: 0,   min: 0,   max: 6.28, step: 0.01,
        hint: 'Start angle in radians. 0 = right, 1.57 = up, 3.14 = left.' },
      { name: 'endAngle',   type: 'number', default: 3.14, min: 0,  max: 6.28, step: 0.01,
        hint: 'End angle in radians. Must be greater than start angle.' },
      { name: 'segments',   type: 'number', default: 8,   min: 3,   max: 64,   step: 1,
        hint: 'Number of line segments used to approximate the arc curve.' },
      { name: 'posX',       type: 'number', default: 0,   min: -10, max: 10,   step: 0.01,
        hint: 'Horizontal position in world units.' },
      { name: 'posY',       type: 'number', default: 0,   min: -10, max: 10,   step: 0.01,
        hint: 'Vertical position in world units.' },
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
      { name: 'radius', type: 'number', default: 1,  min: 0.01, max: 10, step: 0.01 },
      { name: 'posX',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posY',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
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
      { name: 'vertices', type: 'string',  default: '[[-1,-1],[1,-1],[1,1],[-1,1]]' },
      { name: 'posX',     type: 'number',  default: 0, min: -10, max: 10, step: 0.01 },
      { name: 'posY',     type: 'number',  default: 0, min: -10, max: 10, step: 0.01 },
      { name: 'rotation', type: 'number',  default: 0, min: 0, max: 6.28, step: 0.01 },
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
      { name: 'sides',    type: 'number', default: 6,  min: 3,   max: 32,   step: 1,
        hint: 'Number of sides. 3 = triangle, 4 = square, 6 = hexagon.' },
      { name: 'size',     type: 'number', default: 1,  min: 0.1, max: 10,   step: 0.01,
        hint: 'Circumradius — distance from centre to each vertex.' },
      { name: 'rotation', type: 'number', default: 0,  min: 0,   max: 6.28, step: 0.01,
        hint: 'Rotation in radians. 6.28 = one full turn.' },
      { name: 'posX',     type: 'number', default: 0,  min: -10, max: 10,   step: 0.01,
        hint: 'Horizontal position in world units.' },
      { name: 'posY',     type: 'number', default: 0,  min: -10, max: 10,   step: 0.01,
        hint: 'Vertical position in world units.' },
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
      { name: 'radius', type: 'number', default: 1,  min: 0.01, max: 10, step: 0.01 },
      { name: 'posX',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posY',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posZ',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
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
      { name: 'width',          type: 'number', default: 2,  min: 0.01, max: 10, step: 0.01 },
      { name: 'height',         type: 'number', default: 2,  min: 0.01, max: 10, step: 0.01 },
      { name: 'depth',          type: 'number', default: 2,  min: 0.01, max: 10, step: 0.01 },
      { name: 'posX',           type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posY',           type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posZ',           type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'cornerRounding', type: 'number', default: 0,  min: 0,    max: 1,  step: 0.01,
        label: 'rounding',
        hint: 'Rounds the edges and corners of the box. 0 = sharp corners, 1 = fully rounded.' },
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
      { name: 'radius',         type: 'number', default: 1,    min: 0.01, max: 10,  step: 0.01 },
      { name: 'height',         type: 'number', default: 2,    min: 0.01, max: 20,  step: 0.01 },
      { name: 'capped',         type: 'select', default: 'yes', options: ['yes','no'] },
      { name: 'axis',           type: 'select', default: 'Y',  options: ['Y','X','Z'] },
      { name: 'posX',           type: 'number', default: 0,    min: -10,  max: 10,  step: 0.01 },
      { name: 'posY',           type: 'number', default: 0,    min: -10,  max: 10,  step: 0.01 },
      { name: 'posZ',           type: 'number', default: 0,    min: -10,  max: 10,  step: 0.01 },
      { name: 'cornerRounding', type: 'number', default: 0,    min: 0,    max: 1,   step: 0.01,
        label: 'rounding',
        hint: 'Rounds the top and bottom edges of the cylinder. 0 = sharp edges, 1 = fully rounded.' },
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
    { name: 'radius', type: 'number', default: 0.5, min: 0.01, max: 5, step: 0.01 },
    { name: 'height', type: 'number', default: 2,   min: 0.01, max: 20, step: 0.01 },
    { name: 'posX',   type: 'number', default: 0,   min: -10,  max: 10, step: 0.01 },
    { name: 'posY',   type: 'number', default: 0,   min: -10,  max: 10, step: 0.01 },
    { name: 'posZ',   type: 'number', default: 0,   min: -10,  max: 10, step: 0.01 },
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
        hint: 'Distance from the centre of the torus to the centre of the tube.' },
      { name: 'minorRadius', type: 'number', default: 0.5, min: 0.01, max: 5, step: 0.01,
        hint: 'Radius of the tube itself. Must be smaller than the major radius.' },
      { name: 'posX',        type: 'number', default: 0,   min: -10,  max: 10, step: 0.01 },
      { name: 'posY',        type: 'number', default: 0,   min: -10,  max: 10, step: 0.01 },
      { name: 'posZ',        type: 'number', default: 0,   min: -10,  max: 10, step: 0.01 },
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
        hint: 'Total depth of the extrusion in world units. The 2D shape is centred on the Z axis.' },
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
        hint: 'Distance from the revolution axis to the 2D profile. Increase to create a hollow tube rather than a solid.' },
      { name: 'axis', type: 'select', default: 'Y', options: ['Y', 'X', 'Z'],
        hint: 'The world axis the 2D profile is swept around. Y = vertical axis (default torus), X = horizontal axis, Z = depth axis.' },
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
      { name: 'radius', type: 'number', default: 1,  min: 0.01, max: 10, step: 0.01 },
      { name: 'height', type: 'number', default: 2,  min: 0.01, max: 20, step: 0.01 },
      { name: 'axis',   type: 'select', default: 'Y', options: ['Y','X','Z'] },
      { name: 'posX',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posY',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
      { name: 'posZ',   type: 'number', default: 0,  min: -10,  max: 10, step: 0.01 },
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
        hint: 'X component of the surface normal. The normal points away from the solid side.' },
      { name: 'ny',     type: 'number', default: 1,  min: -1,  max: 1,  step: 0.01,
        hint: 'Y component of the surface normal. Default (0,1,0) = horizontal floor.' },
      { name: 'nz',     type: 'number', default: 0,  min: -1,  max: 1,  step: 0.01,
        hint: 'Z component of the surface normal.' },
      { name: 'offset', type: 'number', default: 0,  min: -10, max: 10, step: 0.01,
        hint: 'Signed distance from the world origin to the plane along the normal. Positive moves the plane in the normal direction.' },
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
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1 },
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
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1 },
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
      { name: 'smoothness', type: 'number', default: 8, min: 0, max: 32, step: 0.1 },
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
        options: ['union', 'intersection', 'difference'] },
      { name: 'smoothness', type: 'number', default: 8,    min: 0,   max: 32,   step: 0.1,
        label: 'smoothness',
        hint: 'Controls the width of the blending zone between the two shapes. Higher = softer blend.' },
      { name: 'rotation',   type: 'number', default: 0,    min: 0,   max: 6.28, step: 0.01 },
      { name: 'scale',      type: 'number', default: 1,    min: 0.1, max: 10,   step: 0.01 },
      { name: 'posX',       type: 'number', default: 0,    min: -10, max: 10,   step: 0.01 },
      { name: 'posY',       type: 'number', default: 0,    min: -10, max: 10,   step: 0.01 },
      { name: 'isoOffset',  type: 'number', default: 0.15, min: 0,   max: 2,    step: 0.01,
        label: 'boundary',
        hint: 'Expands or contracts the visible boundary of the blended shape. Increase if the shape appears hollow or too thin.' },
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
      { name: 'iterations', type: 'number', default: 3,   min: 1, max: 8,    step: 1    },
      { name: 'rotation',   type: 'number', default: 0,   min: 0, max: 6.28, step: 0.01 },
      { name: 'scale',      type: 'number', default: 0.5, min: 0.01, max: 1, step: 0.01 },
      { name: 'posX',       type: 'number', default: 0,   min: -10, max: 10,  step: 0.01 },
      { name: 'posY',       type: 'number', default: 0,   min: -10, max: 10,  step: 0.01 },
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
      { name: 'c0', type: 'number', default: 0,   min: -5, max: 5, step: 0.01 },
      { name: 'c1', type: 'number', default: 1,   min: -5, max: 5, step: 0.01 },
      { name: 'c2', type: 'number', default: 0,   min: -5, max: 5, step: 0.01 },
      { name: 'c3', type: 'number', default: 0,   min: -5, max: 5, step: 0.01 },
    ],
  },

  sinusoidalMapper: {
    type: 'sinusoidalMapper',
    category: 'mapper',
    label: 'Sinusoidal',
    timeVarying: false,
    ports: [
      { name: 'mapper', type: PortType.MAPPER, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'a', type: 'number', default: 1, min: -5,   max: 5,    step: 0.01 },
      { name: 'b', type: 'number', default: 1, min: 0.01, max: 20,   step: 0.01 },
      { name: 'c', type: 'number', default: 0, min: -6.28, max: 6.28, step: 0.01 },
      { name: 'e', type: 'number', default: 0, min: -5,   max: 5,    step: 0.01 },
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
      { name: 'a', type: 'number', default: 1, min: -5, max: 5,  step: 0.01 },
      { name: 'b', type: 'number', default: 1, min: -5, max: 5,  step: 0.01 },
      { name: 'c', type: 'number', default: 0, min: -5, max: 5,  step: 0.01 },
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
      { name: 'a', type: 'number', default: 1, min: -5,  max: 5,  step: 0.01 },
      { name: 'b', type: 'number', default: 1, min: 0.01, max: 10, step: 0.01 },
      { name: 'c', type: 'number', default: 1, min: 0.01, max: 10, step: 0.01 },
      { name: 'e', type: 'number', default: 0, min: -5,  max: 5,  step: 0.01 },
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
      { name: 'a', type: 'number', default: 1, min: -5,  max: 5,  step: 0.01 },
      { name: 'b', type: 'number', default: 2, min: 0.01, max: 8,  step: 0.01 },
      { name: 'c', type: 'number', default: 0, min: -5,  max: 5,  step: 0.01 },
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
        hint: 'Number of rotational symmetry sectors. 6 produces hexagonal symmetry.' },
      { name: 'centerX',  type: 'number', default: 0,    min: -5, max: 5,    step: 0.01,
        hint: 'X coordinate of the symmetry centre.' },
      { name: 'centerY',  type: 'number', default: 0,    min: -5, max: 5,    step: 0.01,
        hint: 'Y coordinate of the symmetry centre.' },
      { name: 'rotation', type: 'number', default: 0,    min: 0,  max: 6.28, step: 0.01,
        hint: 'Rotates the symmetry pattern without moving the input shape.' },
      { name: 'reflectX', type: 'select', default: 'no', options: ['yes', 'no'],
        hint: 'Mirror the pattern across the local X axis within each sector.' },
      { name: 'reflectY', type: 'select', default: 'no', options: ['yes', 'no'],
        hint: 'Mirror the pattern across the local Y axis within each sector.' },
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
        hint: 'Number of copies placed around the centre point.' },
      { name: 'centerX',    type: 'number', default: 0,     min: -5, max: 5,    step: 0.01,
        hint: 'X coordinate of the orbit centre.' },
      { name: 'centerY',    type: 'number', default: 0,     min: -5, max: 5,    step: 0.01,
        hint: 'Y coordinate of the orbit centre.' },
      { name: 'rotation',   type: 'number', default: 0,     min: 0,  max: 6.28, step: 0.01,
        hint: 'Rotates the starting angle of the first copy.' },
      { name: 'reflectX',   type: 'select', default: 'no',  options: ['yes', 'no'],
        hint: 'When yes, adds a mirrored copy of each rotated instance (dihedral symmetry).' },
      { name: 'combiner',   type: 'select', default: 'min', options: ['min', 'max', 'smoothMin'],
        hint: 'How the copies are combined. min = union (default), max = intersection, smoothMin = smooth union.' },
      { name: 'smoothness', type: 'number', default: 8,     min: 0,  max: 32,   step: 0.1,
        hint: 'Blend width when combiner is set to smoothMin. Has no effect for min or max.' },
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
        hint: 'Real part of coefficient a in the Möbius transform (az+b)/(cz+d).' },
      { name: 'aIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Imaginary part of coefficient a.' },
      { name: 'bRe', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Real part of coefficient b (translation component).' },
      { name: 'bIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Imaginary part of coefficient b.' },
      { name: 'cRe', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Real part of coefficient c. Non-zero values produce inversion effects.' },
      { name: 'cIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Imaginary part of coefficient c.' },
      { name: 'dRe', type: 'number', default: 1,  min: -5, max: 5, step: 0.01,
        hint: 'Real part of coefficient d. ad-bc must not equal zero.' },
      { name: 'dIm', type: 'number', default: 0,  min: -5, max: 5, step: 0.01,
        hint: 'Imaginary part of coefficient d.' },
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
        hint: 'The repeating grid pattern. Square = regular grid, hexagonal = honeycomb, brick = offset rows.' },
      { name: 'periodX',  type: 'number', default: 3,   min: 0.1, max: 20, step: 0.1,
        hint: 'Horizontal spacing between tile copies in world units.' },
      { name: 'periodY',  type: 'number', default: 3,   min: 0.1, max: 20, step: 0.1,
        hint: 'Vertical spacing between tile copies in world units.' },
      { name: 'offsetX',  type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Shifts the entire tiling pattern horizontally.' },
      { name: 'offsetY',  type: 'number', default: 0,   min: -10, max: 10, step: 0.01,
        hint: 'Shifts the entire tiling pattern vertically.' },
      { name: 'isoOffset', type: 'number', default: 0.15, min: 0, max: 2, step: 0.01,
        label: 'boundary',
        hint: 'Expands or contracts the visible boundary of each tiled copy. Increase if the shape appears hollow.' },
    ],
  }, 

  // ── Transform ─────────────────────────────────────────────────────────────

  transform3DNode: {
    type: 'transform3DNode',
    category: 'transform',
    label: 'Position / Orient',
    hint: 'Moves and rotates the incoming geometry in 3D space without changing ' +
          'its internal structure. Use this to position sub-assemblies relative ' +
          'to each other before blending — e.g. placing "wing" geometry relative ' +
          'to a "body" before a smooth union. Works on both 2D and 3D inputs; ' +
          'posZ/rotateX/rotateY only affect 3D render modes.',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF, dir: PortDirection.IN,  required: true,  default: null },
      { name: 'result', type: PortType.SDF, dir: PortDirection.OUT, required: false, default: null },
    ],
    params: [
      { name: 'posX', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'Move this branch along the X axis (left / right).' },
      { name: 'posY', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'Move this branch along the Y axis (up / down).' },
      { name: 'posZ', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        hint: 'Move this branch along the Z axis (toward / away from camera). Only affects 3D render modes.' },
      { name: 'rotateX', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        hint: 'Rotate this branch around the X axis (pitch). Only affects 3D render modes.' },
      { name: 'rotateY', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        hint: 'Rotate this branch around the Y axis (yaw). Only affects 3D render modes.' },
      { name: 'rotateZ', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        hint: 'Rotate this branch around the Z axis (roll).' },
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
        hint: 'How far the surface is pushed in or out by the noise. Higher = more distortion.' },
      { name: 'frequency', type: 'number', default: 3.0,  min: 0.1,  max: 20,   step: 0.1,
        hint: 'Scale of the noise pattern. Higher = finer, more rapid variation.' },
      { name: 'animated',  type: 'select', default: 'no', options: ['yes','no'],
        hint: 'When set to yes, the noise pattern moves over time in all render modes. Most visible in GLSL and Ray March modes which render continuously.' },
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
        hint: 'How many radians of twist are applied per world unit along the Y axis. Negative values twist in the opposite direction.' },
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
        hint: 'How strongly the shape is bent along the X axis. Negative values bend in the opposite direction.' },
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
        hint: 'Number of copies along the X axis.' },
      { name: 'countY', type: 'number', default: 3,   min: 1, max: 20,  step: 1,
        hint: 'Number of copies along the Y axis.' },
      { name: 'countZ', type: 'number', default: 1,   min: 1, max: 20,  step: 1,
        hint: 'Number of copies along the Z axis. Set to 1 for 2D scenes.' },
      { name: 'spacingX', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'Distance between copies along X in world units.' },
      { name: 'spacingY', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'Distance between copies along Y in world units.' },
      { name: 'spacingZ', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1,
        hint: 'Distance between copies along Z in world units.' },
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
      // after every blend and transform in the graph. Always available in
      // the render drawer, no wiring required. This is the "where is my
      // model in the world" control, complementary to the camera-view
      // controls which control "where is my eye looking from".
      { name: 'posX', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        label: 'placeX',
        hint: 'Moves the final composed geometry along X. Affects all render modes and STL export.' },
      { name: 'posY', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        label: 'placeY',
        hint: 'Moves the final composed geometry along Y. Affects all render modes and STL export.' },
      { name: 'posZ', type: 'number', default: 0, min: -10, max: 10, step: 0.01,
        label: 'placeZ',
        hint: 'Moves the final composed geometry along Z. Only affects 3D render modes (Surface, Ray March) and STL export.' },
      { name: 'rotateX', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        label: 'rotateX',
        hint: 'Rotates the final geometry around X (pitch). Only affects 3D render modes and STL export.' },
      { name: 'rotateY', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        label: 'rotateY',
        hint: 'Rotates the final geometry around Y (yaw). Only affects 3D render modes and STL export.' },
      { name: 'rotateZ', type: 'number', default: 0, min: 0, max: 6.28, step: 0.01,
        label: 'rotateZ',
        hint: 'Rotates the final geometry around Z (roll). Affects all render modes and STL export.' },
    ],
  },
};