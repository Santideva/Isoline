// File: src/utils/idGenerator.js
// Single source of truth for all node and shape IDs across the system.
let _counter = 0;
export function nextId() { return ++_counter; }
export function resetIdCounter() { _counter = 0; } // for testing only