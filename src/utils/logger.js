// File: src/utils/logger.js

const DEBUG_ENABLED = false; // set true only when actively debugging

export const logger = {
    info(message)  { console.info(`[INFO] ${message}`); },
    debug(message) { if (DEBUG_ENABLED) console.debug(`[DEBUG] ${message}`); },
    warn(message)  { console.warn(`[WARN] ${message}`); },
    error(message) { console.error(`[ERROR] ${message}`); }
};
  