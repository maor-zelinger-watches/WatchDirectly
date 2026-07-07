/**
 * Unit tests for js/cache.js
 *
 * Tests cover:
 * - Feed cache round-trip, shape validation, and corruption self-healing
 * - Starred channels round-trip (Set/array) and corruption handling
 * - Storage failure tolerance (quota errors never throw)
 *
 * Node's experimental localStorage global shadows jsdom's, so we install
 * a functional mock (same pattern as tests/integration/api.test.js).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CACHE_KEYS,
  loadFeedCache, saveFeedCache, clearFeedCache,
  loadSearchIndex, saveSearchIndex, clearSearchIndex,
  loadStarredChannels, saveStarredChannels, clearStarredChannels,
} from '../../js/cache.js';

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
  store = {};
  localStorageMock.getItem.mockImplementation(baseImpl.getItem);
  localStorageMock.setItem.mockImplementation(baseImpl.setItem);
  localStorageMock.removeItem.mockImplementation(baseImpl.removeItem);
});

describe('feed cache', () => {
  it('round-trips videos and total', () => {
    saveFeedCache(VIDEOS, 42);
    expect(loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('returns null when nothing is cached', () => {
    expect(loadFeedCache()).toBeNull();
  });

  it('clears and returns null on corrupt JSON', () => {
    store[CACHE_KEYS.FEED] = '{not json!!';
    expect(loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects a payload without a numeric total (pagination math needs it)', () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: VIDEOS });
    expect(loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects empty or zero-total payloads', () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: [], total: 10 });
    expect(loadFeedCache()).toBeNull();

    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: VIDEOS, total: 0 });
    expect(loadFeedCache()).toBeNull();
  });

  it('rejects non-array videos (e.g. an injected object)', () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: { evil: true }, total: 5 });
    expect(loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects a JSON null payload', () => {
    store[CACHE_KEYS.FEED] = 'null';
    expect(loadFeedCache()).toBeNull();
  });

  it('clearFeedCache removes the entry', () => {
    saveFeedCache(VIDEOS, 42);
    clearFeedCache();
    expect(loadFeedCache()).toBeNull();
  });
});

describe('search index cache', () => {
  it('round-trips the full catalog', () => {
    saveSearchIndex(VIDEOS);
    expect(loadSearchIndex()).toEqual(VIDEOS);
  });

  it('returns null when nothing is cached', () => {
    expect(loadSearchIndex()).toBeNull();
  });

  it('refuses to save an empty or non-array index', () => {
    expect(saveSearchIndex([])).toBe(false);
    expect(saveSearchIndex(null)).toBe(false);
    expect(loadSearchIndex()).toBeNull();
  });

  it('clears and returns null on corrupt JSON', () => {
    store[CACHE_KEYS.SEARCH_INDEX] = '{not json!!';
    expect(loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });

  it('clears and returns null on an empty payload', () => {
    store[CACHE_KEYS.SEARCH_INDEX] = JSON.stringify({ videos: [] });
    expect(loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });

  it('clearSearchIndex removes the entry', () => {
    saveSearchIndex(VIDEOS);
    clearSearchIndex();
    expect(loadSearchIndex()).toBeNull();
  });

  it('reports failure instead of throwing on quota errors', () => {
    localStorageMock.setItem.mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(saveSearchIndex(VIDEOS)).toBe(false);
  });
});

describe('starred channels', () => {
  it('round-trips a Set', () => {
    saveStarredChannels(new Set(['Teddy Baldassarre', 'Bark and Jack']));
    const loaded = loadStarredChannels();
    expect(loaded).toBeInstanceOf(Set);
    expect([...loaded].sort()).toEqual(['Bark and Jack', 'Teddy Baldassarre']);
  });

  it('accepts a plain array too', () => {
    saveStarredChannels(['Hodinkee']);
    expect(loadStarredChannels().has('Hodinkee')).toBe(true);
  });

  it('returns an empty Set when nothing is stored', () => {
    const loaded = loadStarredChannels();
    expect(loaded).toBeInstanceOf(Set);
    expect(loaded.size).toBe(0);
  });

  it('clears and returns an empty Set on corrupt JSON', () => {
    store[CACHE_KEYS.STARS] = '[[[';
    expect(loadStarredChannels().size).toBe(0);
    expect(store[CACHE_KEYS.STARS]).toBeUndefined();
  });

  it('clears and returns an empty Set on a non-array payload', () => {
    store[CACHE_KEYS.STARS] = JSON.stringify({ nope: 1 });
    expect(loadStarredChannels().size).toBe(0);
    expect(store[CACHE_KEYS.STARS]).toBeUndefined();
  });

  it('clearStarredChannels removes the entry', () => {
    saveStarredChannels(['Hodinkee']);
    clearStarredChannels();
    expect(loadStarredChannels().size).toBe(0);
  });
});

describe('storage failure tolerance', () => {
  const quotaError = () => {
    throw new DOMException('quota', 'QuotaExceededError');
  };

  it('saveFeedCache reports failure instead of throwing on quota errors', () => {
    localStorageMock.setItem.mockImplementation(quotaError);

    expect(() => saveFeedCache(VIDEOS, 42)).not.toThrow();
    expect(saveFeedCache(VIDEOS, 42)).toBe(false);
  });

  it('saveStarredChannels never throws on quota errors', () => {
    localStorageMock.setItem.mockImplementation(quotaError);

    expect(() => saveStarredChannels(['X'])).not.toThrow();
  });

  it('loads report absent data when reads throw (private browsing)', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(loadFeedCache()).toBeNull();
    expect(loadStarredChannels().size).toBe(0);
  });

  it('clear helpers tolerate removeItem failures', () => {
    localStorageMock.removeItem.mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(() => clearFeedCache()).not.toThrow();
    expect(() => clearStarredChannels()).not.toThrow();
  });
});
