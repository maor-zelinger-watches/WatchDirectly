/**
 * Unit tests for the snapshot engines (js/storage.js) as cache.js drives them:
 * where each snapshot lands, the fallback chain, the one-time migration off
 * localStorage, per-key write ordering, and what gets persisted.
 *
 * jsdom has neither IndexedDB nor Cache Storage, so each test installs them:
 * fake-indexeddb for IndexedDB, and a small in-memory CacheStorage built on
 * Node's real Request/Response (only the four calls storage.js makes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  CACHE_KEYS, CACHE_VERSION, ENGINE_PREFERENCE,
  loadFeedCache, saveFeedCache,
  loadSearchIndex, saveSearchIndex,
  loadTopCache, saveTopCache,
  loadChannelsCache,
  __test__ as cacheTest,
} from '../../js/cache.js';
import { engines, pickEngine, __test__ as storageTest } from '../../js/storage.js';

// --- localStorage mock (Node's experimental global shadows jsdom's) ---------
let lsStore = {};
const localStorageMock = {
  getItem: vi.fn((k) => (k in lsStore ? lsStore[k] : null)),
  setItem: vi.fn((k, v) => { lsStore[k] = String(v); }),
  removeItem: vi.fn((k) => { delete lsStore[k]; }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// --- in-memory CacheStorage -----------------------------------------------
function makeCacheStorage() {
  const caches = new Map(); // cacheName -> Map(url -> body text)
  const api = {
    putGate: null, // optional: a promise the NEXT put awaits (write-ordering test)
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name);
      return {
        async match(url) {
          const body = entries.get(String(url));
          return body === undefined ? undefined : new Response(body);
        },
        async put(url, response) {
          const gate = api.putGate;
          api.putGate = null;
          const body = await response.text();
          if (gate) await gate;
          entries.set(String(url), body);
        },
        async delete(url) {
          return entries.delete(String(url));
        },
      };
    },
    // Test-side peek: every stored body across caches, keyed by URL.
    dump() {
      const out = {};
      for (const entries of caches.values()) {
        for (const [url, body] of entries) out[url] = JSON.parse(body);
      }
      return out;
    },
  };
  return api;
}

const VIDEOS = [
  { video_id: 'abc12345678', title: 'A Video', channel_name: 'Teddy Baldassarre', comment_count: 2 },
  { video_id: 'def12345678', title: 'Another', channel_name: 'Bark and Jack', comment_count: 0 },
];

const envelope = (payload, savedAt = Date.now()) => ({ ...payload, version: CACHE_VERSION, savedAt });

let cacheStorage;

function installBoth() {
  globalThis.indexedDB = new IDBFactory();
  cacheStorage = makeCacheStorage();
  globalThis.caches = cacheStorage;
}

beforeEach(() => {
  lsStore = {};
  localStorageMock.setItem.mockClear();
  storageTest.reset();
  installBoth();
});

afterEach(async () => {
  await cacheTest.settled();
  delete globalThis.caches;
  delete globalThis.indexedDB;
});

const cacheEntry = (key) => cacheStorage.dump()[new URL(`/__wd_store__/${key}`, location.origin).href];

describe('engine placement', () => {
  it('prefers IndexedDB for every snapshot, then Cache Storage, then localStorage', () => {
    for (const key of [CACHE_KEYS.FEED, CACHE_KEYS.TOP, CACHE_KEYS.CHANNELS, CACHE_KEYS.SEARCH_INDEX]) {
      expect(ENGINE_PREFERENCE[key]).toEqual(['idb', 'cache', 'local']);
    }
  });

  it('writes the feed to IndexedDB and never touches localStorage or Cache Storage', async () => {
    await saveFeedCache(VIDEOS, 42);
    expect(await engines.idb.get(CACHE_KEYS.FEED)).toMatchObject({ videos: VIDEOS, total: 42, version: CACHE_VERSION });
    expect(cacheEntry(CACHE_KEYS.FEED)).toBeUndefined();
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('writes the search index to IndexedDB and never touches localStorage', async () => {
    await saveSearchIndex(VIDEOS);
    expect(await engines.idb.get(CACHE_KEYS.SEARCH_INDEX)).toMatchObject({ videos: VIDEOS });
    expect(cacheEntry(CACHE_KEYS.SEARCH_INDEX)).toBeUndefined();
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });

  it('round-trips the Top snapshot through IndexedDB', async () => {
    await saveTopCache(VIDEOS, 30, 'cur|1');
    expect(await engines.idb.get(CACHE_KEYS.TOP)).toMatchObject({ total: 30, cursor: 'cur|1' });
    expect(await loadTopCache()).toEqual({ videos: VIDEOS, total: 30, cursor: 'cur|1' });
  });

  it('uses Cache Storage when IndexedDB is missing', async () => {
    delete globalThis.indexedDB;
    await saveTopCache(VIDEOS, 30, '');
    expect(cacheEntry(CACHE_KEYS.TOP)).toMatchObject({ total: 30 });
    expect(await loadTopCache()).toEqual({ videos: VIDEOS, total: 30, cursor: '' });
  });
});

describe('fallback chain', () => {
  it('falls back to Cache Storage when IndexedDB is missing', async () => {
    delete globalThis.indexedDB;
    expect((await pickEngine(ENGINE_PREFERENCE[CACHE_KEYS.FEED])).name).toBe('cache');
    await saveFeedCache(VIDEOS, 42);
    expect(cacheEntry(CACHE_KEYS.FEED)).toMatchObject({ total: 42 });
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('falls back to Cache Storage when IndexedDB exists but refuses to open', async () => {
    globalThis.indexedDB = { open: () => { throw new DOMException('denied', 'InvalidStateError'); } };
    expect((await pickEngine(ENGINE_PREFERENCE[CACHE_KEYS.FEED])).name).toBe('cache');
  });

  it('skips a Cache Storage that refuses to open (insecure context, private mode)', async () => {
    delete globalThis.indexedDB;
    globalThis.caches = { open: () => Promise.reject(new DOMException('denied', 'SecurityError')) };
    expect((await pickEngine(ENGINE_PREFERENCE[CACHE_KEYS.FEED])).name).toBe('local');
  });

  it('falls back to localStorage when neither is available', async () => {
    delete globalThis.caches;
    delete globalThis.indexedDB;
    await saveSearchIndex(VIDEOS);
    expect(JSON.parse(lsStore[CACHE_KEYS.SEARCH_INDEX]).videos).toEqual(VIDEOS);
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });

  it('probes each engine once per page load', async () => {
    const open = vi.fn(() => cacheStorage.open.call(cacheStorage, 'x'));
    globalThis.caches = { ...cacheStorage, open };
    await pickEngine(['cache']);
    await pickEngine(['cache']);
    await pickEngine(['cache']);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('one-time migration off localStorage', () => {
  it('adopts a valid legacy snapshot, moves it into the engine, and frees localStorage', async () => {
    lsStore[CACHE_KEYS.FEED] = JSON.stringify(envelope({ videos: VIDEOS, total: 42 }));

    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();                                // quota freed
    expect(await engines.idb.get(CACHE_KEYS.FEED)).toMatchObject({ total: 42 });     // written through
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });            // found there next time
  });

  it('migrates the search index into IndexedDB', async () => {
    lsStore[CACHE_KEYS.SEARCH_INDEX] = JSON.stringify(envelope({ videos: VIDEOS }));
    expect(await loadSearchIndex()).toEqual(VIDEOS);
    expect(lsStore[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
    expect(await engines.idb.get(CACHE_KEYS.SEARCH_INDEX)).toMatchObject({ videos: VIDEOS });
  });

  it('migrates the channel list (envelope-less legacy shape)', async () => {
    const creators = [{ channel_name: 'Hodinkee', host: 'Ben' }];
    lsStore[CACHE_KEYS.CHANNELS] = JSON.stringify({ creators });
    expect(await loadChannelsCache()).toEqual(creators);
    expect(lsStore[CACHE_KEYS.CHANNELS]).toBeUndefined();
  });

  it('drops a corrupt legacy copy without adopting it', async () => {
    lsStore[CACHE_KEYS.FEED] = '{broken json!!!';
    expect(await loadFeedCache()).toBeNull();
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();
    expect(await engines.idb.get(CACHE_KEYS.FEED)).toBeNull();
  });

  it('drops an expired legacy copy without adopting it', async () => {
    lsStore[CACHE_KEYS.FEED] = JSON.stringify(envelope({ videos: VIDEOS, total: 42 }, Date.now() - 25 * 3600e3));
    expect(await loadFeedCache()).toBeNull();
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();
    expect(await engines.idb.get(CACHE_KEYS.FEED)).toBeNull();
  });

  it('prefers the engine copy over a leftover legacy one, and still frees localStorage', async () => {
    await saveFeedCache(VIDEOS, 42);
    lsStore[CACHE_KEYS.FEED] = JSON.stringify(envelope({ videos: [VIDEOS[0]], total: 1 }));
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
    expect(lsStore[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('a save also clears a legacy copy the user never loaded', async () => {
    lsStore[CACHE_KEYS.TOP] = JSON.stringify({ videos: VIDEOS });
    await saveTopCache(VIDEOS, 2, '');
    expect(lsStore[CACHE_KEYS.TOP]).toBeUndefined();
  });
});

describe('per-key ordering', () => {
  it('lands fire-and-forget saves in call order even when the first write is slower', async () => {
    delete globalThis.indexedDB; // run on Cache Storage, whose fake can stall a put
    let release;
    cacheStorage.putGate = new Promise((r) => { release = r; }); // stalls the FIRST put

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

describe('what gets persisted', () => {
  it('strips the memoized _searchFields tokens without mutating the live rows', async () => {
    const live = VIDEOS.map((v) => ({ ...v, _searchFields: { titleTokens: ['a'], channelTokens: ['b'] } }));
    await saveSearchIndex(live);

    const stored = await engines.idb.get(CACHE_KEYS.SEARCH_INDEX);
    expect(stored.videos.every((v) => !('_searchFields' in v))).toBe(true);
    expect(live.every((v) => '_searchFields' in v)).toBe(true); // in-memory memo untouched
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });

  it('strips them from the feed snapshot too', async () => {
    await saveFeedCache([{ ...VIDEOS[0], _searchFields: { titleTokens: ['x'] } }], 1);
    expect('_searchFields' in (await engines.idb.get(CACHE_KEYS.FEED)).videos[0]).toBe(false);
  });
});

describe('failure tolerance', () => {
  it('a failing write resolves false instead of rejecting', async () => {
    delete globalThis.indexedDB; // exercise the Cache Storage engine's failure path
    cacheStorage.open = async () => ({
      match: async () => undefined,
      put: async () => { throw new DOMException('quota', 'QuotaExceededError'); },
      delete: async () => false,
    });
    storageTest.reset();
    expect(await saveFeedCache(VIDEOS, 42)).toBe(false);
    // …and the queue keeps working afterwards.
    expect(await loadFeedCache()).toBeNull();
  });

  it('an engine read that throws self-heals to absent', async () => {
    delete globalThis.indexedDB;
    await saveFeedCache(VIDEOS, 42);
    const open = cacheStorage.open.bind(cacheStorage);
    cacheStorage.open = async (name) => {
      const c = await open(name);
      return { ...c, match: async () => new Response('{not json') };
    };
    expect(await loadFeedCache()).toBeNull();
  });
});
