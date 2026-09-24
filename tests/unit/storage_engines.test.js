/**
 * Unit tests for the snapshot engines (js/storage.js) as cache.js drives them
 * under the storage-engine flag (js/flags.js).
 *
 *   legacy — the kill switch: localStorage only, IndexedDB never opened.
 *   idb    — IndexedDB, localStorage as the fallback.
 *
 * Beyond the happy paths, these exercise the ways a real browser's IndexedDB
 * misbehaves: an open() that never answers (seen on iOS), a read that hangs
 * after a successful open, a quota error mid-migration, a database that exists
 * without our object store, the flag flipped back and forth across loads, and
 * localStorage blocked outright.
 *
 * jsdom has no IndexedDB; each test installs a fresh fake-indexeddb factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, get as rawGet, set as rawSet } from '../../js/vendor/idb-keyval.js';
import {
  CACHE_KEYS, CACHE_VERSION, LEGACY_PREFERENCE, IDB_PREFERENCE, enginePreference,
  loadFeedCache, saveFeedCache, clearFeedCache,
  loadSearchIndex, saveSearchIndex,
  loadTopCache, saveTopCache,
  loadChannelsCache, saveChannelsCache,
  __test__ as cacheTest,
} from '../../js/cache.js';
import { engines, pickEngine, isStalled, __test__ as storageTest } from '../../js/storage.js';
import { FLAG_KEYS, __test__ as flagsTest } from '../../js/flags.js';

// --- localStorage mock (Node's experimental global shadows jsdom's) ---------
let lsStore = {};
const lsImpl = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};
const localStorageMock = {
  getItem: vi.fn(lsImpl.getItem),
  setItem: vi.fn(lsImpl.setItem),
  removeItem: vi.fn(lsImpl.removeItem),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

const VIDEOS = [
  { video_id: 'abc12345678', title: 'A Video', channel_name: 'Teddy Baldassarre', comment_count: 2 },
  { video_id: 'def12345678', title: 'Another', channel_name: 'Bark and Jack', comment_count: 0 },
];
const CREATORS = [{ channel_name: 'Hodinkee', host: 'Ben' }];
const envelope = (payload, savedAt = Date.now()) => ({ ...payload, version: CACHE_VERSION, savedAt });
const feedEnvelope = (total, videos = VIDEOS) => envelope({ videos, total });

let factory;
let openSpy;

/** Sets the flag and starts a "new page load": fresh memo, probes, stalls. */
function newPageLoad(mode) {
  if (mode === undefined) delete lsStore[FLAG_KEYS.STORAGE_ENGINE];
  else lsStore[FLAG_KEYS.STORAGE_ENGINE] = mode;
  flagsTest.reset();
  storageTest.reset();
}

/** Reads/writes our IndexedDB store directly, behind the app's back. */
const direct = () => createStore('wd-store', 'kv');
const idbValue = (key) => rawGet(key, direct());
const seedIdb = (key, value) => rawSet(key, value, direct());

beforeEach(() => {
  lsStore = {};
  for (const [name, fn] of Object.entries(localStorageMock)) {
    fn.mockReset();
    fn.mockImplementation(lsImpl[name]);
  }
  factory = new IDBFactory();
  globalThis.indexedDB = factory;
  openSpy = vi.spyOn(factory, 'open');
  newPageLoad(undefined);
});

afterEach(async () => {
  await cacheTest.settled();
  vi.restoreAllMocks();
  delete globalThis.indexedDB;
});

describe('flag → engine preference', () => {
  it('defaults to legacy: localStorage only', () => {
    expect(enginePreference()).toBe(LEGACY_PREFERENCE);
    expect(LEGACY_PREFERENCE).toEqual(['local']);
  });

  it('idb mode prefers IndexedDB and falls back straight to localStorage', () => {
    newPageLoad('idb');
    expect(enginePreference()).toBe(IDB_PREFERENCE);
    expect(IDB_PREFERENCE).toEqual(['idb', 'local']);
  });

  it('no Cache Storage engine exists to fall into', () => {
    expect(Object.keys(engines).sort()).toEqual(['idb', 'local']);
  });
});

describe('legacy mode — the kill switch', () => {
  it('round-trips all four snapshots through localStorage without ever opening IndexedDB', async () => {
    await saveFeedCache(VIDEOS, 42);
    await saveSearchIndex(VIDEOS);
    await saveTopCache(VIDEOS, 30, 'cur|1');
    await saveChannelsCache(CREATORS);

    expect(JSON.parse(lsStore[CACHE_KEYS.FEED])).toMatchObject({ total: 42 });
    expect(JSON.parse(lsStore[CACHE_KEYS.SEARCH_INDEX]).videos).toEqual(VIDEOS);
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
    expect(await loadSearchIndex()).toEqual(VIDEOS);
    expect(await loadTopCache()).toEqual({ videos: VIDEOS, total: 30, cursor: 'cur|1' });
    expect(await loadChannelsCache()).toEqual(CREATORS);
    await clearFeedCache();

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('ignores an IndexedDB copy left by an idb-mode session, and never opens it', async () => {
    await seedIdb(CACHE_KEYS.FEED, feedEnvelope(99));
    openSpy.mockClear();
    newPageLoad('legacy');

    expect(await loadFeedCache()).toBeNull(); // localStorage is empty: a cold load
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('legacy flag set explicitly behaves exactly like the default', async () => {
    newPageLoad('legacy');
    await saveFeedCache(VIDEOS, 42);
    expect(JSON.parse(lsStore[CACHE_KEYS.FEED])).toMatchObject({ total: 42 });
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('idb mode', () => {
  beforeEach(() => newPageLoad('idb'));

  it('writes all four snapshots to IndexedDB and leaves localStorage alone', async () => {
    await saveFeedCache(VIDEOS, 42);
    await saveSearchIndex(VIDEOS);
    await saveTopCache(VIDEOS, 30, '');
    await saveChannelsCache(CREATORS);

    expect(await idbValue(CACHE_KEYS.FEED)).toMatchObject({ total: 42, version: CACHE_VERSION });
    expect((await idbValue(CACHE_KEYS.SEARCH_INDEX)).videos).toEqual(VIDEOS);
    expect(await idbValue(CACHE_KEYS.TOP)).toMatchObject({ total: 30, cursor: '' });
    expect(await idbValue(CACHE_KEYS.CHANNELS)).toEqual({ creators: CREATORS });
    const snapshotWrites = localStorageMock.setItem.mock.calls.filter(([k]) => k !== FLAG_KEYS.STORAGE_ENGINE);
    expect(snapshotWrites).toEqual([]);
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('adopts a legacy copy on the first idb load, writes it through, then frees localStorage', async () => {
    lsStore[CACHE_KEYS.FEED] = JSON.stringify(feedEnvelope(42));
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();
    expect(await idbValue(CACHE_KEYS.FEED)).toMatchObject({ total: 42 });
  });

  it('a save clears a leftover localStorage copy', async () => {
    lsStore[CACHE_KEYS.TOP] = JSON.stringify({ videos: VIDEOS });
    await saveTopCache(VIDEOS, 2, '');
    expect(lsStore[CACHE_KEYS.TOP]).toBeUndefined();
  });

  it('lands fire-and-forget saves in call order even when the first write is slower', async () => {
    const realSet = engines.idb.set;
    let release;
    const gate = new Promise((r) => { release = r; });
    let first = true;
    vi.spyOn(engines.idb, 'set').mockImplementation(async (k, v) => {
      if (first) { first = false; await gate; }
      return realSet(k, v);
    });

    saveFeedCache([VIDEOS[0]], 1); // slow
    saveFeedCache(VIDEOS, 2);      // fast — must still land second
    release();
    await cacheTest.settled();
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 2 });
  });

  it('a load issued right after an unawaited save sees that save', async () => {
    saveSearchIndex(VIDEOS);
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });
});

describe('flipping the flag across loads', () => {
  it('idb → legacy → idb: the NEWER legacy copy wins over the older IndexedDB one', async () => {
    newPageLoad('idb');
    await saveFeedCache([VIDEOS[0]], 1);        // IndexedDB holds the OLD snapshot

    newPageLoad('legacy');
    expect(await loadFeedCache()).toBeNull();   // legacy can't see IndexedDB: cold
    await saveFeedCache(VIDEOS, 2);             // …and writes the NEWER one to localStorage

    newPageLoad('idb');
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 2 });
    expect(await idbValue(CACHE_KEYS.FEED)).toMatchObject({ total: 2 }); // written through
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();                   // and freed
  });

  it('a corrupt or expired legacy copy never beats a good IndexedDB one', async () => {
    newPageLoad('idb');
    await saveFeedCache(VIDEOS, 7);
    lsStore[CACHE_KEYS.FEED] = '{broken json';
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 7 });
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();

    lsStore[CACHE_KEYS.FEED] = JSON.stringify(feedEnvelope(3, VIDEOS.slice(0, 1)));
    lsStore[CACHE_KEYS.FEED] = JSON.stringify({ ...JSON.parse(lsStore[CACHE_KEYS.FEED]), savedAt: Date.now() - 25 * 3600e3 });
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 7 });
  });

  it('ten alternating loads never surface an older snapshot than the last one saved', async () => {
    for (let i = 1; i <= 10; i++) {
      newPageLoad(i % 2 ? 'idb' : 'legacy');
      const loaded = await loadFeedCache();
      if (loaded) expect(loaded.total).toBe(i - 1); // whatever it sees is the latest
      await saveFeedCache(VIDEOS, i);
    }
    newPageLoad('idb');
    expect((await loadFeedCache()).total).toBe(10);
  });
});

describe('IndexedDB that misbehaves (idb mode)', () => {
  beforeEach(() => {
    newPageLoad('idb');
    storageTest.setTimeouts({ probe: 40, get: 40, set: 40, del: 40 });
  });

  it('an open() that never answers: falls back to localStorage within the probe budget', async () => {
    openSpy.mockImplementation(() => ({})); // a request whose events never fire
    expect(await loadFeedCache()).toBeNull();
    expect(await saveFeedCache(VIDEOS, 42)).toBe(true);
    expect(JSON.parse(lsStore[CACHE_KEYS.FEED])).toMatchObject({ total: 42 });
    expect(isStalled('idb')).toBe(true);
  });

  it('the fallback copy is picked up once IndexedDB recovers on a later load', async () => {
    openSpy.mockImplementation(() => ({}));
    await saveFeedCache(VIDEOS, 42);             // lands in localStorage during the outage
    openSpy.mockRestore();
    newPageLoad('idb');                          // IndexedDB healthy again
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
    expect(await idbValue(CACHE_KEYS.FEED)).toMatchObject({ total: 42 });
  });

  it('a read that hangs after a good open: no data this load, NOTHING deleted, queue not wedged', async () => {
    await saveFeedCache(VIDEOS, 42);
    newPageLoad('idb');
    storageTest.setTimeouts({ probe: 40, get: 40, set: 40, del: 40 });
    await pickEngine(IDB_PREFERENCE);            // probe succeeds first
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => ({}));

    expect(await loadFeedCache()).toBeNull();    // timed out → treated as a miss
    expect(isStalled('idb')).toBe(true);
    // The same key's queue keeps moving: the next save goes to localStorage.
    expect(await saveFeedCache(VIDEOS, 43)).toBe(true);
    expect(JSON.parse(lsStore[CACHE_KEYS.FEED])).toMatchObject({ total: 43 });

    getSpy.mockRestore();
    expect(await idbValue(CACHE_KEYS.FEED)).toMatchObject({ total: 42 }); // not deleted
  });

  it('a failed migration keeps the localStorage copy for the next load', async () => {
    lsStore[CACHE_KEYS.FEED] = JSON.stringify(feedEnvelope(42));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 }); // still served
    expect(JSON.parse(lsStore[CACHE_KEYS.FEED])).toMatchObject({ total: 42 }); // not lost

    put.mockRestore();
    newPageLoad('idb');
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined(); // migrated this time
  });

  it('a quota error on save resolves false and leaves the previous snapshot readable', async () => {
    await saveFeedCache(VIDEOS, 1);
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(await saveFeedCache(VIDEOS, 2)).toBe(false);
    vi.restoreAllMocks();
    expect((await loadFeedCache()).total).toBe(1);
  });

  it('a database that exists without our object store: probe fails, localStorage takes over', async () => {
    openSpy.mockRestore();
    await new Promise((resolve, reject) => {
      const req = factory.open('wd-store', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('something-else');
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    newPageLoad('idb');
    expect((await pickEngine(IDB_PREFERENCE)).name).toBe('local');
    expect(await saveFeedCache(VIDEOS, 42)).toBe(true);
    expect(JSON.parse(lsStore[CACHE_KEYS.FEED])).toMatchObject({ total: 42 });
  });

  it('a corrupt value read from IndexedDB self-heals to absent', async () => {
    await seedIdb(CACHE_KEYS.FEED, { videos: 'not-an-array', total: 3, version: CACHE_VERSION, savedAt: Date.now() });
    expect(await loadFeedCache()).toBeNull();
    expect(await idbValue(CACHE_KEYS.FEED)).toBeUndefined(); // cleared
  });

  it('no IndexedDB at all (very old browser): localStorage', async () => {
    delete globalThis.indexedDB;
    newPageLoad('idb');
    expect(await saveSearchIndex(VIDEOS)).toBe(true);
    expect(JSON.parse(lsStore[CACHE_KEYS.SEARCH_INDEX]).videos).toEqual(VIDEOS);
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });
});

describe('localStorage blocked outright', () => {
  beforeEach(() => {
    const denied = () => { throw new DOMException('denied', 'SecurityError'); };
    for (const fn of Object.values(localStorageMock)) fn.mockImplementation(denied);
    newPageLoad(undefined);
  });

  it('reads the default, caches nothing, and never throws', async () => {
    expect(enginePreference()).toBe(LEGACY_PREFERENCE);
    expect(await pickEngine(LEGACY_PREFERENCE)).toBeNull();
    await expect(saveFeedCache(VIDEOS, 42)).resolves.toBe(false);
    await expect(loadFeedCache()).resolves.toBeNull();
    await expect(clearFeedCache()).resolves.toBeUndefined();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe.each(['legacy', 'idb'])('what gets persisted (%s)', (mode) => {
  beforeEach(() => newPageLoad(mode));

  it('strips the memoized _searchFields tokens without mutating the live rows', async () => {
    const live = VIDEOS.map((v) => ({ ...v, _searchFields: { titleTokens: ['a'] } }));
    await saveSearchIndex(live);
    const loaded = await loadSearchIndex();
    expect(loaded.every((v) => !('_searchFields' in v))).toBe(true);
    expect(live.every((v) => '_searchFields' in v)).toBe(true);
  });
});
