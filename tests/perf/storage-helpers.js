/**
 * Browser-side helpers for the storage-engine flag tests (e2e + perf).
 *
 * All of these are init scripts: they run before the app's modules on every
 * navigation of the page they're installed on, so they shape what the app's
 * storage layer sees from its very first call.
 */

import { expect } from '@playwright/test';

export const FLAG_KEY = 'wd_storage_engine';

/**
 * A latency budget that means what it says: `locator` must be visible within
 * `ms`, checked every 25 ms.
 *
 * Why not `expect(locator).toBeVisible({ timeout: ms })`: locator assertions
 * re-check on a backoff (~0, 100, 350, 850, 1850 ms…), not continuously, so the
 * effective budget is the last check BEFORE the timeout. Measured: an element
 * appearing at 1000, 1200 or 1400 ms FAILS a 1500 ms toBeVisible (it passes at
 * 800). expect.poll with a fine interval is still a native, retrying assertion
 * whose timeout is the budget — just without the dead zone.
 */
export async function expectVisibleWithin(locator, ms) {
  await expect.poll(() => locator.isVisible(), {
    timeout: ms,
    intervals: [25],
    message: `visible within ${ms}ms`,
  }).toBe(true);
}

/**
 * Pins the storage mode for every load of this page: 'idb' | 'legacy', or
 * null for "no flag" (the default). Registered after installMocks, whose own
 * init script may clear localStorage first.
 */
export async function setStorageMode(page, mode) {
  await page.addInitScript(([key, value]) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }, [FLAG_KEY, mode]);
}

/** Counts IndexedDB opens into window.__storageOpens.idb. */
export async function countStorageOpens(page) {
  await page.addInitScript(() => {
    window.__storageOpens = { idb: 0 };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      window.__storageOpens.idb++;
      return open.apply(this, args);
    };
  });
}

export const storageOpens = (page) => page.evaluate(() => window.__storageOpens);

/**
 * Makes indexedDB.open() return a request that never fires an event — the
 * iOS failure where IndexedDB simply never answers.
 */
export async function hangIndexedDB(page) {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function () {
      return {}; // no success, no error, no upgradeneeded — ever
    };
  });
}

/**
 * Delays every IndexedDB open and read by `ms` — a slow disk / cold IndexedDB
 * on a phone. Each request's onsuccess/onerror handler is still called with the
 * real event, just `ms` later.
 */
export async function slowIndexedDB(page, ms) {
  await page.addInitScript((delay) => {
    const deferHandlers = (req) => {
      for (const type of ['success', 'error']) {
        let handler = null;
        Object.defineProperty(req, `on${type}`, {
          configurable: true,
          get: () => handler,
          set: (fn) => { handler = fn; },
        });
        req.addEventListener(type, (ev) => {
          setTimeout(() => { if (handler) handler.call(req, ev); }, delay);
        });
      }
      return req;
    };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { return deferHandlers(open.apply(this, args)); };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) { return deferHandlers(get.apply(this, args)); };
  }, ms);
}

/** Reads one key straight out of the app's IndexedDB store (undefined if absent). */
export function idbSnapshot(page, key) {
  return page.evaluate(async (key) => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    if (!dbs.some((d) => d.name === 'wd-store')) return undefined;
    return new Promise((resolve) => {
      const open = indexedDB.open('wd-store');
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(undefined); return; }
        const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); resolve(undefined); };
      };
    });
  }, key);
}

/** The localStorage copy of one key, parsed (null if absent). */
export function localSnapshot(page, key) {
  return page.evaluate((key) => {
    const text = localStorage.getItem(key);
    return text === null ? null : JSON.parse(text);
  }, key);
}

/** Collects uncaught page errors — a storage failure must never become one. */
export function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
