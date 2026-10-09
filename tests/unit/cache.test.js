/**
 * Unit tests for js/cache.js
 *
 * Tests cover:
 * - Feed cache round-trip, shape validation, and corruption self-healing
 * - Starred channels round-trip (Set/array) and corruption handling
 * - Storage failure tolerance (quota errors never throw)
 *
 * jsdom provides neither IndexedDB nor Cache Storage, so the async snapshot
 * API (feed / search index / top / channels) runs here on its localStorage
 * fallback engine — which is also the path a browser without either takes.
 * The IndexedDB and Cache Storage engines, the localStorage migration, and
 * write ordering are covered in storage_engines.test.js.
 *
 * Node's experimental localStorage global shadows jsdom's, so we install
 * a functional mock (same pattern as tests/integration/api.test.js).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CACHE_KEYS,
  loadFeedCache, saveFeedCache, clearFeedCache,
  loadSearchIndex, saveSearchIndex, clearSearchIndex,
  loadTopCache, saveTopCache, clearTopCache,
  loadChannelsCache, saveChannelsCache, clearChannelsCache,
  loadStarredChannels, saveStarredChannels, clearStarredChannels,
  loadFilterTypes, saveFilterTypes, clearFilterTypes,
} from '../../js/cache.js';
import { __test__ as storageTest } from '../../js/storage.js';

let store = {};
const baseImpl = {
  getItem: key => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: key => { delete store[key]; },
};
const localStorageMock = {
  getItem: vi.fn(baseImpl.getItem),
  setItem: vi.fn(baseImpl.setItem),
  removeItem: vi.fn(baseImpl.removeItem),
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

const VIDEOS = [
  { video_id: 'abc12345678', title: 'A Video', channel_name: 'Teddy Baldassarre', comment_count: 2 },
  { video_id: 'def12345678', title: 'Another', channel_name: 'Bark and Jack', comment_count: 0 },
];

beforeEach(() => {
  storageTest.reset(); // re-probe engines against this test's mocks
  store = {};
  localStorageMock.getItem.mockImplementation(baseImpl.getItem);
  localStorageMock.setItem.mockImplementation(baseImpl.setItem);
  localStorageMock.removeItem.mockImplementation(baseImpl.removeItem);
});

describe('feed cache', () => {
  it('round-trips videos and total', async () => {
    await saveFeedCache(VIDEOS, 42);
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('returns null when nothing is cached', async () => {
    expect(await loadFeedCache()).toBeNull();
  });

  it('clears and returns null on corrupt JSON', async () => {
    store[CACHE_KEYS.FEED] = '{not json!!';
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects a payload without a numeric total (pagination math needs it)', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: VIDEOS });
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects empty or zero-total payloads', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: [], total: 10 });
    expect(await loadFeedCache()).toBeNull();

    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: VIDEOS, total: 0 });
    expect(await loadFeedCache()).toBeNull();
  });

  it('rejects non-array videos (e.g. an injected object)', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: { evil: true }, total: 5 });
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects a JSON null payload', async () => {
    store[CACHE_KEYS.FEED] = 'null';
    expect(await loadFeedCache()).toBeNull();
  });

  it('clearFeedCache removes the entry', async () => {
    await saveFeedCache(VIDEOS, 42);
    await clearFeedCache();
    expect(await loadFeedCache()).toBeNull();
  });
});

describe('search index cache', () => {
  it('round-trips the full catalog', async () => {
    await saveSearchIndex(VIDEOS);
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });

  it('returns null when nothing is cached', async () => {
    expect(await loadSearchIndex()).toBeNull();
  });

  it('refuses to save an empty or non-array index', async () => {
    expect(await saveSearchIndex([])).toBe(false);
    expect(await saveSearchIndex(null)).toBe(false);
    expect(await loadSearchIndex()).toBeNull();
  });

  it('clears and returns null on corrupt JSON', async () => {
    store[CACHE_KEYS.SEARCH_INDEX] = '{not json!!';
    expect(await loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });

  it('clears and returns null on an empty payload', async () => {
    store[CACHE_KEYS.SEARCH_INDEX] = JSON.stringify({ videos: [] });
    expect(await loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });

  it('clearSearchIndex removes the entry', async () => {
    await saveSearchIndex(VIDEOS);
    await clearSearchIndex();
    expect(await loadSearchIndex()).toBeNull();
  });

  it('reports failure instead of throwing on quota errors', async () => {
    localStorageMock.setItem.mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(await saveSearchIndex(VIDEOS)).toBe(false);
  });
});

describe('top cache', () => {
  it('round-trips videos, total, and cursor', async () => {
    await saveTopCache(VIDEOS, 30, 'cur|1');
    expect(await loadTopCache()).toEqual({ videos: VIDEOS, total: 30, cursor: 'cur|1' });
  });

  it('accepts an empty-string cursor (end of the week)', async () => {
    await saveTopCache(VIDEOS, 30, '');
    expect(await loadTopCache()).toEqual({ videos: VIDEOS, total: 30, cursor: '' });
  });

  it('falls back total to length and cursor to undefined when absent', async () => {
    store[CACHE_KEYS.TOP] = JSON.stringify({ videos: VIDEOS });
    expect(await loadTopCache()).toEqual({ videos: VIDEOS, total: VIDEOS.length, cursor: undefined });
  });

  it('returns null when nothing is cached', async () => {
    expect(await loadTopCache()).toBeNull();
  });

  it('does not save an empty list', async () => {
    expect(await saveTopCache([], 0, '')).toBe(false);
    expect(store[CACHE_KEYS.TOP]).toBeUndefined();
  });

  it('clears and returns null on corrupt JSON', async () => {
    store[CACHE_KEYS.TOP] = '{bad';
    expect(await loadTopCache()).toBeNull();
    expect(store[CACHE_KEYS.TOP]).toBeUndefined();
  });

  it('clears and returns null on an empty cached payload', async () => {
    store[CACHE_KEYS.TOP] = JSON.stringify({ videos: [], total: 5 });
    expect(await loadTopCache()).toBeNull();
    expect(store[CACHE_KEYS.TOP]).toBeUndefined();
  });

  it('clearTopCache removes the key', async () => {
    await saveTopCache(VIDEOS, 30, '');
    await clearTopCache();
    expect(await loadTopCache()).toBeNull();
  });
});

describe('channels cache', () => {
  const CREATORS = [
    { channel_name: 'Teddy Baldassarre', host: 'Teddy', avatar: 'a.jpg' },
    { channel_name: 'Bark and Jack', host: 'Adrian', avatar: 'b.jpg' },
  ];

  it('round-trips the creator list', async () => {
    await saveChannelsCache(CREATORS);
    expect(await loadChannelsCache()).toEqual(CREATORS);
  });

  it('returns null when nothing is cached', async () => {
    expect(await loadChannelsCache()).toBeNull();
  });

  it('does not save an empty list', async () => {
    expect(await saveChannelsCache([])).toBe(false);
    expect(store[CACHE_KEYS.CHANNELS]).toBeUndefined();
  });

  it('clears and returns null on corrupt JSON', async () => {
    store[CACHE_KEYS.CHANNELS] = 'nope{';
    expect(await loadChannelsCache()).toBeNull();
    expect(store[CACHE_KEYS.CHANNELS]).toBeUndefined();
  });

  it('clears and returns null on an empty cached payload', async () => {
    store[CACHE_KEYS.CHANNELS] = JSON.stringify({ creators: [] });
    expect(await loadChannelsCache()).toBeNull();
    expect(store[CACHE_KEYS.CHANNELS]).toBeUndefined();
  });

  it('clearChannelsCache removes the key', async () => {
    await saveChannelsCache(CREATORS);
    await clearChannelsCache();
    expect(await loadChannelsCache()).toBeNull();
  });
});

describe('starred channels', () => {
  it('round-trips a Set', async () => {
    saveStarredChannels(new Set(['Teddy Baldassarre', 'Bark and Jack']));
    const loaded = loadStarredChannels();
    expect(loaded).toBeInstanceOf(Set);
    expect([...loaded].sort()).toEqual(['Bark and Jack', 'Teddy Baldassarre']);
  });

  it('accepts a plain array too', async () => {
    saveStarredChannels(['Hodinkee']);
    expect(loadStarredChannels().has('Hodinkee')).toBe(true);
  });

  it('returns an empty Set when nothing is stored', async () => {
    const loaded = loadStarredChannels();
    expect(loaded).toBeInstanceOf(Set);
    expect(loaded.size).toBe(0);
  });

  it('clears and returns an empty Set on corrupt JSON', async () => {
    store[CACHE_KEYS.STARS] = '[[[';
    expect(loadStarredChannels().size).toBe(0);
    expect(store[CACHE_KEYS.STARS]).toBeUndefined();
  });

  it('clears and returns an empty Set on a non-array payload', async () => {
    store[CACHE_KEYS.STARS] = JSON.stringify({ nope: 1 });
    expect(loadStarredChannels().size).toBe(0);
    expect(store[CACHE_KEYS.STARS]).toBeUndefined();
  });

  it('clearStarredChannels removes the entry', async () => {
    saveStarredChannels(['Hodinkee']);
    clearStarredChannels();
    expect(loadStarredChannels().size).toBe(0);
  });
});

describe('content-type filter selection', () => {
  it('round-trips a selection', async () => {
    saveFilterTypes(['video', 'article']);
    expect(loadFilterTypes()).toEqual(['video', 'article']);
  });

  it('returns null when nothing was ever saved (caller applies the default)', async () => {
    expect(loadFilterTypes()).toBeNull();
  });

  it('distinguishes a saved "All" ([]) from never-saved (null)', async () => {
    saveFilterTypes([]);
    expect(loadFilterTypes()).toEqual([]); // real value, not the default
  });

  it('normalizes to canonical order and drops duplicates', async () => {
    store[CACHE_KEYS.FILTER_TYPES] = JSON.stringify(['article', 'video', 'article']);
    expect(loadFilterTypes()).toEqual(['video', 'article']);
  });

  it('clears and returns null on corrupt JSON', async () => {
    store[CACHE_KEYS.FILTER_TYPES] = '[not json';
    expect(loadFilterTypes()).toBeNull();
    expect(store[CACHE_KEYS.FILTER_TYPES]).toBeUndefined();
  });

  it('clears a payload with an unknown type value', async () => {
    store[CACHE_KEYS.FILTER_TYPES] = JSON.stringify(['video', 'podcast']);
    expect(loadFilterTypes()).toBeNull();
    expect(store[CACHE_KEYS.FILTER_TYPES]).toBeUndefined();
  });

  it('clears a non-array payload', async () => {
    store[CACHE_KEYS.FILTER_TYPES] = JSON.stringify({ types: ['video'] });
    expect(loadFilterTypes()).toBeNull();
    expect(store[CACHE_KEYS.FILTER_TYPES]).toBeUndefined();
  });

  it('clearFilterTypes removes the key', async () => {
    saveFilterTypes(['short']);
    clearFilterTypes();
    expect(loadFilterTypes()).toBeNull();
  });
});

describe('storage failure tolerance', () => {
  const quotaError = () => {
    throw new DOMException('quota', 'QuotaExceededError');
  };

  it('saveFeedCache reports failure instead of throwing on quota errors', async () => {
    localStorageMock.setItem.mockImplementation(quotaError);

    expect(() => saveFeedCache(VIDEOS, 42)).not.toThrow();
    expect(await saveFeedCache(VIDEOS, 42)).toBe(false);
  });

  it('saveStarredChannels never throws on quota errors', async () => {
    localStorageMock.setItem.mockImplementation(quotaError);

    expect(() => saveStarredChannels(['X'])).not.toThrow();
  });

  it('loads report absent data when reads throw (private browsing)', async () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(await loadFeedCache()).toBeNull();
    expect(loadStarredChannels().size).toBe(0);
  });

  it('clear helpers tolerate removeItem failures', async () => {
    localStorageMock.removeItem.mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(() => clearFeedCache()).not.toThrow();
    await expect(clearFeedCache()).resolves.toBeUndefined();
    expect(() => clearStarredChannels()).not.toThrow();
  });
});
