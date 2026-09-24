/**
 * storage.js — Async key/value engines behind cache.js.
 *
 * Three interchangeable engines share one interface: `get(key)` resolves the
 * stored value (null when absent), `set(key, value)` and `del(key)` resolve
 * once the write lands. Values are plain JSON-able objects; each engine owns
 * its own serialization, so callers never stringify.
 *
 *   idb   — IndexedDB through the vendored idb-keyval. Values are stored by
 *           structured clone, and the quota is a share of the disk.
 *   cache — Cache Storage used as a key/value store, with NO service worker:
 *           each key is a synthetic same-origin Request whose value is a JSON
 *           Response. Same quota pool as IndexedDB. Only a fallback: in WebKit
 *           under Playwright its writes didn't survive a reload even though
 *           caches.open() succeeded, so the probe can't vouch for it.
 *   local — localStorage. Synchronous, with a per-origin cap of 5-10 MiB that
 *           varies by browser: WebKit refused the full search index outright.
 *           Kept only as the last-resort fallback, so no browser ends up worse
 *           off than before the move.
 *
 * pickEngine(preference) probes each candidate once (memoized per page load)
 * and returns the first that actually works: Cache Storage exists only in a
 * secure context, and private-browsing modes have at times disabled one or the
 * other.
 */

import { createStore, get as idbGet, set as idbSet, del as idbDel } from './vendor/idb-keyval.js';

const IDB_NAME = 'wd-store';
const IDB_STORE = 'kv';
const CACHE_NAME = 'wd-store-v1';

// One connection for the page's lifetime; idb-keyval reopens it if the browser
// drops it (Safari does).
let idbStore = null;
function idb() {
  if (!idbStore) idbStore = createStore(IDB_NAME, IDB_STORE);
  return idbStore;
}

// A never-fetched URL that stands in for a key. It has to be absolute http(s)
// for Request to accept it; the path is namespaced so it can't collide with a
// real asset anything else on the origin might cache.
function cacheUrl(key) {
  return new URL(`/__wd_store__/${encodeURIComponent(key)}`, globalThis.location.origin).href;
}

export const engines = {
  idb: {
    name: 'idb',
    async probe() {
      if (typeof indexedDB === 'undefined') return false;
      await idbGet('__probe__', idb()); // opens (and on first use creates) the DB
      return true;
    },
    async get(key) {
      const value = await idbGet(key, idb());
      return value === undefined ? null : value;
    },
    async set(key, value) {
      await idbSet(key, value, idb());
    },
    async del(key) {
      await idbDel(key, idb());
    },
  },

  cache: {
    name: 'cache',
    async probe() {
      if (typeof caches === 'undefined') return false;
      await caches.open(CACHE_NAME); // throws where Cache Storage is disabled
      return true;
    },
    async get(key) {
      const cache = await caches.open(CACHE_NAME);
      const response = await cache.match(cacheUrl(key));
      return response ? response.json() : null;
    },
    async set(key, value) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheUrl(key), new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      }));
    },
    async del(key) {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(cacheUrl(key));
    },
  },

  local: {
    name: 'local',
    async probe() {
      localStorage.getItem('__wd_probe__'); // merely touching it throws where blocked
      return true;
    },
    async get(key) {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    },
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    async del(key) {
      localStorage.removeItem(key);
    },
  },
};

const probes = new Map();

/** Resolves whether `name` works in this browser; probed once, then memoized. */
function available(name) {
  if (!probes.has(name)) {
    probes.set(name, Promise.resolve()
      .then(() => engines[name].probe())
      .then(Boolean, () => false));
  }
  return probes.get(name);
}

/**
 * The first engine in `preference` that works here, or null when none does.
 * Later candidates are probed only if every earlier one failed.
 *
 * @param {Array<'idb'|'cache'|'local'>} preference
 */
export async function pickEngine(preference) {
  for (const name of preference) {
    if (await available(name)) return engines[name];
  }
  return null;
}

// Seams for unit tests: forget the memoized probes, and drop the cached IDB
// connection so a fresh fake database is picked up.
export const __test__ = {
  reset() {
    probes.clear();
    idbStore = null;
  },
};
