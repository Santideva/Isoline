// ─────────────────────────────────────────────────────────────────────────────
//  UndoManager
//  Snapshot-based undo/redo built on top of nodeGraph.serialize/deserialize.
//  Call snapshot() before every destructive operation.
//  Call syncGraph(newGraph) any time _stateStore.nodeGraph is replaced.
// ─────────────────────────────────────────────────────────────────────────────
export class UndoManager {
  constructor(nodeGraph, { maxDepth = 50 } = {}) {
    this._graph     = nodeGraph;
    this._maxDepth  = maxDepth;
    this._undoStack = [];   // [..., older, newer]  ← top = most recent
    this._redoStack = [];
    this._listeners = new Set();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Capture current graph state. Call BEFORE every destructive operation. */
  snapshot() {
    this._push(this._undoStack, this._serialise());
    this._redoStack = [];     // new action invalidates the redo branch
    this._notify();
  }

  /** Undo one step. Returns true if there was something to undo. */
  undo() {
    if (this._undoStack.length === 0) return false;
    this._push(this._redoStack, this._serialise());
    this._deserialise(this._undoStack.pop());
    this._notify();
    return true;
  }

  /** Redo one step. Returns true if there was something to redo. */
  redo() {
    if (this._redoStack.length === 0) return false;
    this._push(this._undoStack, this._serialise());
    this._deserialise(this._redoStack.pop());
    this._notify();
    return true;
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  /**
   * Call after stateStore.clear() + persistence.loadScene() so that
   * the manager tracks the new graph instance, not the old cleared one.
   */
  syncGraph(newGraph) {
    this._graph = newGraph;
  }

  /**
   * Subscribe to canUndo / canRedo changes.
   * Callback receives { canUndo: bool, canRedo: bool }.
   * Returns an unsubscribe function.
   */
  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _serialise() {
    return JSON.stringify(this._graph.serialize());
  }

  _deserialise(snapshot) {
    this._graph.deserialize(JSON.parse(snapshot));
  }

  _push(stack, state) {
    stack.push(state);
    if (stack.length > this._maxDepth) stack.shift(); // drop oldest
  }

  _notify() {
    const payload = { canUndo: this.canUndo, canRedo: this.canRedo };
    this._listeners.forEach(cb => cb(payload));
  }
}