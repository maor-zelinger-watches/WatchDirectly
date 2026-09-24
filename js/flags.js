/**
 * flags.js — Per-browser feature flags.
 *
 * One flag today: which engine persists the large cache snapshots (feed,
 * search index, Top This Week, channels).
 *
 *   localStorage 'wd_storage_engine' = 'idb'     → IndexedDB (js/storage.js)
 *                                    = 'legacy'  → localStorage, as before
 *   absent / unreadable / anything else          → CONFIG.STORAGE_ENGINE_DEFAULT
 *
 * The flag is read ONCE per page load and memoized: an engine must never
 * change between a snapshot's write and its read in the same session, so a
 * flip (here, in devtools, or in another tab) takes effect on the next load.
 *
 * ?storage=idb | ?storage=legacy sets the flag, and ?storage=default removes
 * it — for browsers without devtools (iOS Safari). It's applied while this
 * module evaluates, which is before any cache read: cache.js imports this
 * module, and boot only starts once every module has evaluated. The param is
 * left in the URL; share.js may strip the query string later, and the flag is
 * already persisted by then.
 *
 * Never throws: blocked storage reads as "no flag" (the default applies) and a
 * blocked write is reported as false.
 */

import { CONFIG } from './config.js';

export const FLAG_KEYS = {
  STORAGE_ENGINE: 'wd_storage_engine',
};

export const STORAGE_ENGINES = ['idb', 'legacy'];

const STORAGE_URL_PARAM = 'storage';

function readFlag(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

/**
 * Persists the storage-engine flag: 'idb' | 'legacy', or null to remove it
 * (back to the default). Takes effect on the next page load.
 *
 * @returns {boolean} whether the flag was written
 */
export function setStorageEngineFlag(value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(FLAG_KEYS.STORAGE_ENGINE);
    } else if (STORAGE_ENGINES.includes(value)) {
      localStorage.setItem(FLAG_KEYS.STORAGE_ENGINE, value);
    } else {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/** Applies ?storage=… from the page URL. Unknown values are ignored. */
function applyUrlParam() {
  if (typeof location === 'undefined' || !location.search) return;
  let value;
  try {
    value = new URLSearchParams(location.search).get(STORAGE_URL_PARAM);
  } catch (e) {
    return;
  }
  if (value === 'default') setStorageEngineFlag(null);
  else if (STORAGE_ENGINES.includes(value)) setStorageEngineFlag(value);
}

let current = null;

/**
 * The storage engine for this page load: `{engine, source}` where engine is
 * 'idb' | 'legacy' and source is 'flag' (set explicitly) or 'default'.
 * Memoized — the same answer for the rest of the page load.
 */
export function storageEngine() {
  if (current) return current;
  const raw = readFlag(FLAG_KEYS.STORAGE_ENGINE);
  const fallback = STORAGE_ENGINES.includes(CONFIG.STORAGE_ENGINE_DEFAULT)
    ? CONFIG.STORAGE_ENGINE_DEFAULT
    : 'legacy';
  current = STORAGE_ENGINES.includes(raw)
    ? Object.freeze({ engine: raw, source: 'flag' })
    : Object.freeze({ engine: fallback, source: 'default' });
  return current;
}

// Settle the flag for this page load now, before anything can read a cache.
applyUrlParam();
storageEngine();

// Seams for unit tests: forget the memoized answer, and re-run the URL param.
export const __test__ = {
  reset() {
    current = null;
  },
  applyUrlParam,
};
