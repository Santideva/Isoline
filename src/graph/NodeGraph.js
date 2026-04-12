// src/graph/NodeGraph.js
import { NODE_TYPES } from './NodeSpec.js';
import { nextId, advanceIdCounter } from '../utils/idGenerator.js';

/**
 * NodeGraph is the ground-truth data model for the entire scene.
 *
 * It stores:
 *  - nodes: Map<nodeId, NodeInstance>
 *  - edges: Map<edgeId, EdgeInstance>
 *
 * It does NOT evaluate SDFs. That is the NodeEvaluator's job.
 * It does NOT hold Three.js objects. That is SceneManager's job.
 *
 * A NodeInstance is:
 * {
 *   id:     number          — unique, from nextId()
 *   type:   string          — key into NODE_TYPES
 *   params: Object          — current parameter values {name: value}
 *   uiPos:  {x, y}          — canvas position for the node graph UI
 * }
 *
 * An EdgeInstance is:
 * {
 *   id:       number
 *   fromNode: number        — source node id
 *   fromPort: string        — source port name
 *   toNode:   number        — target node id
 *   toPort:   string        — target port name
 * }
 */
export class NodeGraph {
  constructor() {
    this.nodes = new Map();   // nodeId → NodeInstance
    this.edges = new Map();   // edgeId → EdgeInstance

    // Derived lookup: for each node+port, which edge connects to it?
    // Rebuilt on every mutation.
    this._incomingEdge  = new Map();  // `${nodeId}:${portName}` → edgeId
    this._outgoingEdges = new Map();  // `${nodeId}:${portName}` → edgeId[]

    // Callbacks — fired on any mutation
    this._listeners = [];
  }

  // ── Node operations ───────────────────────────────────────────────────────

  addNode(type, params = {}, uiPos = { x: 0, y: 0 }, forceId = null) {
    const spec = NODE_TYPES[type];
    if (!spec) throw new Error(`Unknown node type: ${type}`);

    const defaultParams = {};
    spec.params.forEach(p => { defaultParams[p.name] = p.default; });

    const node = {
      id:     forceId !== null ? forceId : nextId(),
      type,
      params: { ...defaultParams, ...params },
      uiPos:  { ...uiPos },
    };

    this.nodes.set(node.id, node);
    this._notify('nodeAdded', node);
    return node;
  }

  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) return false;

    // Remove all edges connected to this node
    const edgesToRemove = [];
    this.edges.forEach((edge, edgeId) => {
      if (edge.fromNode === nodeId || edge.toNode === nodeId) {
        edgesToRemove.push(edgeId);
      }
    });
    edgesToRemove.forEach(id => this._removeEdgeInternal(id));

    this.nodes.delete(nodeId);
    this._notify('nodeRemoved', { nodeId });
    return true;
  }

  updateNodeParam(nodeId, paramName, value) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.params[paramName] = value;
    this._notify('paramChanged', { nodeId, paramName, value });
    return true;
  }

  updateNodePosition(nodeId, x, y) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.uiPos = { x, y };
    return true;
  }

  // ── Edge operations ───────────────────────────────────────────────────────

  addEdge(fromNode, fromPort, toNode, toPort) {
    // Validate both nodes exist
    const from = this.nodes.get(fromNode);
    const to   = this.nodes.get(toNode);
    if (!from || !to) throw new Error(`Node not found`);

    // Validate port types match
    const fromSpec = NODE_TYPES[from.type];
    const toSpec   = NODE_TYPES[to.type];
    const fromPortSpec = fromSpec.ports.find(p => p.name === fromPort);
    const toPortSpec   = toSpec.ports.find(p => p.name === toPort);

    if (!fromPortSpec || !toPortSpec) {
      throw new Error(`Port not found: ${fromPort} or ${toPort}`);
    }
    if (fromPortSpec.type !== toPortSpec.type) {
      throw new Error(`Port type mismatch: ${fromPortSpec.type} → ${toPortSpec.type}`);
    }
    if (fromPortSpec.dir !== 'out' || toPortSpec.dir !== 'in') {
      throw new Error(`Edge must go from OUT port to IN port`);
    }

    // Each IN port accepts only one edge — remove existing if present
    const inKey = `${toNode}:${toPort}`;
    const existingEdgeId = this._incomingEdge.get(inKey);
    if (existingEdgeId !== undefined) {
      this._removeEdgeInternal(existingEdgeId);
    }

    // Cycle check before adding
    if (this._wouldCreateCycle(fromNode, toNode)) {
      throw new Error(`Adding this edge would create a cycle`);
    }

    const edge = {
      id:       nextId(),
      fromNode, fromPort,
      toNode,   toPort,
    };

    this.edges.set(edge.id, edge);
    this._rebuildLookups();
    this._notify('edgeAdded', edge);
    return edge;
  }

  removeEdge(edgeId) {
    if (!this.edges.has(edgeId)) return false;
    this._removeEdgeInternal(edgeId);
    this._notify('edgeRemoved', { edgeId });
    return true;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getIncomingEdge(nodeId, portName) {
    const edgeId = this._incomingEdge.get(`${nodeId}:${portName}`);
    return edgeId !== undefined ? this.edges.get(edgeId) : null;
  }

  getOutgoingEdges(nodeId, portName) {
    const edgeIds = this._outgoingEdges.get(`${nodeId}:${portName}`) || [];
    return edgeIds.map(id => this.edges.get(id)).filter(Boolean);
  }

  // Returns nodes in topological order (sources first).
  // Throws if a cycle is detected (should not happen if addEdge validates).
  topologicalOrder() {
    const visited  = new Set();
    const order    = [];
    const visiting = new Set();

    const visit = (nodeId) => {
      if (visiting.has(nodeId)) throw new Error(`Cycle detected at node ${nodeId}`);
      if (visited.has(nodeId))  return;
      visiting.add(nodeId);

      // Visit all nodes that this node depends on (incoming edges)
      this.edges.forEach(edge => {
        if (edge.toNode === nodeId) visit(edge.fromNode);
      });

      visiting.delete(nodeId);
      visited.add(nodeId);
      order.push(nodeId);
    };

    this.nodes.forEach((_, id) => visit(id));
    return order;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  serialise() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  static deserialise(data) {
    const graph = new NodeGraph();
    data.nodes.forEach(n => graph.nodes.set(n.id, n));
    data.edges.forEach(e => graph.edges.set(e.id, e));
    graph._rebuildLookups();
    return graph;
  }

  // ── Change listeners ──────────────────────────────────────────────────────

  onChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

    /**
   * Serialize the graph to a plain JSON-compatible object.
   * Captures all nodes (with params and uiPos) and all edges.
   */
  serialize() {
    const nodes = [];
    this.nodes.forEach((node, id) => {
      nodes.push({
        id,
        type:   node.type,
        params: { ...node.params },
        uiPos:  { ...node.uiPos }
      });
    });

    const edges = [];
    this.edges.forEach((edge, id) => {
      edges.push({
        id,
        fromNode: edge.fromNode,
        fromPort: edge.fromPort,
        toNode:   edge.toNode,
        toPort:   edge.toPort
      });
    });

    return { version: 1, nodes, edges };
  }

  /**
   * Restore graph state from a serialized object.
   * Clears existing state first.
   * @param {object} data  Output of serialize()
   */
  deserialize(data) {
    if (!data || data.version !== 1) {
      console.warn('NodeGraph.deserialize: unknown format');
      return false;
    }

    // Clear existing state
    this.nodes.clear();
    this.edges.clear();
    this._nextEdgeId = 1;

    // Restore nodes — preserve original IDs
    for (const n of data.nodes) {
      this.nodes.set(n.id, {
        id:     n.id,
        type:   n.type,
        params: { ...n.params },
        uiPos:  { ...n.uiPos }
      });
    }

    // Restore edges
    let maxId = 0;
    for (const e of data.edges) {
      this.edges.set(e.id, {
        id:       e.id,
        fromNode: e.fromNode,
        fromPort: e.fromPort,
        toNode:   e.toNode,
        toPort:   e.toPort
      });
      if (typeof e.id === 'number' && e.id > maxId) maxId = e.id;
    }

    // Advance nodes max ID check
    for (const n of data.nodes) {
      if (typeof n.id === 'number' && n.id > maxId) maxId = n.id;
    }

    // Advance the global ID counter past all restored IDs to prevent collisions
    advanceIdCounter(maxId);

    this._rebuildLookups();
    this._notify('deserialized');
    return true;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _removeEdgeInternal(edgeId) {
    this.edges.delete(edgeId);
    this._rebuildLookups();
  }

  _rebuildLookups() {
    this._incomingEdge.clear();
    this._outgoingEdges.clear();
    this.edges.forEach((edge, edgeId) => {
      this._incomingEdge.set(`${edge.toNode}:${edge.toPort}`, edgeId);
      const outKey = `${edge.fromNode}:${edge.fromPort}`;
      if (!this._outgoingEdges.has(outKey)) this._outgoingEdges.set(outKey, []);
      this._outgoingEdges.get(outKey).push(edgeId);
    });
  }

  _wouldCreateCycle(fromNode, toNode) {
    // DFS from toNode — if we can reach fromNode, adding this edge creates a cycle
    const visited = new Set();
    const stack   = [toNode];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === fromNode) return true;
      if (visited.has(current))  continue;
      visited.add(current);
      this.edges.forEach(edge => {
        if (edge.fromNode === current) stack.push(edge.toNode);
      });
    }
    return false;
  }

  _notify(event, data) {
    this._listeners.forEach(fn => fn(event, data));
  }
}