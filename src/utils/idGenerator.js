// File: src/utils/idGenerator.js
// Single source of truth for all node and shape IDs across the system.
let _counter = 0;
/**
 * Advance the ID counter to at least minValue.
 * Used after deserializing a graph to prevent ID collisions.
 */
export function advanceIdCounter(minValue) {
  while (peekId() <= minValue) nextId();
}

export function peekId() {
  return _counter + 1;
}
export function nextId() { return ++_counter; }
export function resetIdCounter() { _counter = 0; } // for testing only