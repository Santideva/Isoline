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
      { name: 'cornerRounding', type: 'number',  default: 0,   min: 0,   max: 2,   step: 0.01 },
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
      { name: 'radius',     type: 'number', default: 1.5, min: 0.1, max: 10,   step: 0.01 },
      { name: 'startAngle', type: 'number', default: 0,   min: 0,   max: 6.28, step: 0.01 },
      { name: 'endAngle',   type: 'number', default: 3.14, min: 0,  max: 6.28, step: 0.01 },
      { name: 'segments',   type: 'number', default: 8,   min: 3,   max: 64,   step: 1    },
      { name: 'posX',       type: 'number', default: 0,   min: -10, max: 10,   step: 0.01 },
      { name: 'posY',       type: 'number', default: 0,   min: -10, max: 10,   step: 0.01 },
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
      { name: 'sides',    type: 'number', default: 6,  min: 3,   max: 32,   step: 1    },
      { name: 'size',     type: 'number', default: 1,  min: 0.1, max: 10,   step: 0.01 },
      { name: 'rotation', type: 'number', default: 0,  min: 0,   max: 6.28, step: 0.01 },
      { name: 'posX',     type: 'number', default: 0,  min: -10, max: 10,   step: 0.01 },
      { name: 'posY',     type: 'number', default: 0,  min: -10, max: 10,   step: 0.01 },
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
      { name: 'smoothness', type: 'number', default: 8,    min: 0,   max: 32,   step: 0.1  },
      { name: 'rotation',   type: 'number', default: 0,    min: 0,   max: 6.28, step: 0.01 },
      { name: 'scale',      type: 'number', default: 1,    min: 0.1, max: 10,   step: 0.01 },
      { name: 'posX',       type: 'number', default: 0,    min: -10, max: 10,   step: 0.01 },
      { name: 'posY',       type: 'number', default: 0,    min: -10, max: 10,   step: 0.01 },
      { name: 'isoOffset',  type: 'number', default: 0.15, min: 0,   max: 2,    step: 0.01 },
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

  // ── Transform ─────────────────────────────────────────────────────────────

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

  outputNode: {
    type: 'outputNode',
    category: 'output',
    label: 'Output',
    timeVarying: false,
    ports: [
      { name: 'sdf',    type: PortType.SDF,    dir: PortDirection.IN,  required: true,  default: null },
    ],
    params: [
      { name: 'renderMethod', type: 'select', default: 'contours (2D)',
        options: ['contours (2D)', 'fill (2D)', 'arcs', 'surface (3D)'] },
      { name: 'resolution',   type: 'number', default: 150, min: 20, max: 400, step: 10 },
      { name: 'boundsMin',    type: 'number', default: -4,  min: -20, max: 0,  step: 0.5 },
      { name: 'boundsMax',    type: 'number', default: 4,   min: 0,   max: 20, step: 0.5 },
    ],
  },
};