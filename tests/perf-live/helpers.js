/**
 * Helpers for the live-backend perf suite (tests/perf-live).
 *
 * Everything here works against ANY build of the app — the localStorage one on
 * main and the IndexedDB / Cache Storage one — so the same specs can measure a
 * before and an after. Nothing reaches into a particular storage engine
 * except to report where a snapshot ended up.
 */

import { expect } from '@playwright/test';

export const SNAPSHOT_KEYS = {
  FEED: 'wd_feed_cache',
  SEARCH_INDEX: 'wd_search_index',
  TOP: 'wd_top_cache',
  CHANNELS: 'wd_channels',
};

// The backend's hosts: the /exec endpoint and the echo hop it redirects to.
const BACKEND = /^https:\/\/script\.(google|googleusercontent)\.com\//;

/** The first card a user can actually see (Shorts are hidden by the default chips). */
export const visibleCard = (page) => page.locator('#feed-container .media-card:visible').first();

/**
 * Where a snapshot is persisted and how big it is, looked up in every place a
 * build of this app might have put it: `{chars, rows}` per location (chars of
 * JSON; rows = length of its videos/creators list), or null where it's absent.
 *
 * @returns {Promise<{local: Object|null, cache: Object|null, idb: Object|null}>}
 */
export function snapshotInfo(page, key) {
  return page.evaluate(async (key) => {
    const out = { local: null, cache: null, idb: null };
    const describe = (value, chars) => {
      const list = value && (value.videos || value.creators || (Array.isArray(value) ? value : null));
      return { chars, rows: Array.isArray(list) ? list.length : null };
    };

    const raw = localStorage.getItem(key);
    if (raw !== null) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { /* report size only */ }
      out.local = describe(parsed, raw.length);
    }

    if (typeof caches !== 'undefined' && (await caches.has('wd-store-v1'))) {
      const cache = await caches.open('wd-store-v1');
      const url = new URL(`/__wd_store__/${encodeURIComponent(key)}`, location.origin).href;
      const res = await cache.match(url);
      if (res) {
        const text = await res.text();
        out.cache = describe(JSON.parse(text), text.length);
      }
    }

    // Only open the database if it already exists, so probing a build that
    // never used IndexedDB doesn't create one.
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    if (dbs.some((d) => d.name === 'wd-store')) {
      const value = await new Promise((resolve) => {
        const open = indexedDB.open('wd-store');
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(undefined); return; }
          const get = db.transaction('kv', 'readonly').objectStore('kv').get(key);
          get.onsuccess = () => { db.close(); resolve(get.result); };
          get.onerror = () => { db.close(); resolve(undefined); };
        };
      });
      if (value !== undefined) out.idb = describe(value, JSON.stringify(value).length);
    }
    return out;
  }, key);
}

/** True once `key` is persisted anywhere (see snapshotInfo). */
export async function isPersisted(page, key) {
  const info = await snapshotInfo(page, key);
  return info.local !== null || info.cache !== null || info.idb !== null;
}

/** Rows in the persisted copy of `key`, wherever it lives (0 when absent). */
export async function persistedRows(page, key) {
  const info = await snapshotInfo(page, key);
  const found = info.cache || info.idb || info.local;
  return found && found.rows !== null ? found.rows : 0;
}

/** Polls until `key` is persisted, failing after `timeout` ms. */
export async function expectPersisted(page, key, timeout, { soft = false } = {}) {
  const e = soft ? expect.configure({ soft: true }) : expect;
  await e.poll(() => isPersisted(page, key), {
    timeout,
    message: `${key} should be persisted`,
  }).toBe(true);
}

/**
 * Holds every backend request instead of letting it through, so what paints
 * next can only have come from storage. `release()` lets the held requests
 * proceed (to production) and stops holding new ones.
 */
export async function holdBackend(page) {
  const held = [];
  const handler = (route) => { held.push(route); };
  await page.route(BACKEND, handler);
  return {
    get count() { return held.length; },
    async release() {
      // Unroute first: a released request's redirect must not be caught again.
      await page.unroute(BACKEND, handler);
      await Promise.all(held.splice(0).map((r) => r.continue().catch(() => {})));
    },
  };
}

/** Records backend requests the search-index build makes (feed chunks + archive). */
export function recordIndexRequests(page) {
  const urls = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!/^https:\/\/script\.google\.com\//.test(url)) return;
    const params = new URL(url).searchParams;
    const action = params.get('action');
    if (action === 'archive' || (action === 'feed' && params.get('limit') === '100')) urls.push(url);
  });
  return urls;
}

/** Reads fields of the app's live state module (same instance the page runs). */
export function appState(page, fields) {
  return page.evaluate(async (fields) => {
    const { state } = await import('/js/state.js');
    return Object.fromEntries(fields.map((f) => [f, state[f]]));
  }, fields);
}

/** Attaches a JSON report to the test and echoes it to the list reporter. */
export async function report(testInfo, name, data) {
  await testInfo.attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
  console.log(`[${testInfo.project.name}] ${name}: ${JSON.stringify(data)}`);
}
