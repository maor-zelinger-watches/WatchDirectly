/**
 * Regression tests for FE6 (feed/search-index cache versioning + TTL) and FE5
 * (coalesced, capped feed-cache writes on the vote/comment hot path).
 *
 * FE6 — the large stale-while-revalidate payloads (feed, search index) now
 * carry a {version, savedAt} envelope. A payload of the wrong schema version or
 * older than 24h is treated as absent and self-heals (cleared on read), so a
 * flaky build can't strand the session on a months-old catalog. The pre-existing
 * corrupt-JSON / bad-shape self-heal must still hold.
 *
 * FE5 — updateCachedVoteCount / updateCachedCommentCount used to JSON.stringify
 * the whole accumulated feed synchronously on every vote/comment. saveFeedCacheSoon
 * defers the write to idle time, coalesces a burst into a single write, and caps
 * the persisted snapshot to FEED_CACHE_SNAPSHOT_MAX items.
 *
 * The snapshot API is async and, under jsdom (no IndexedDB / Cache Storage),
 * runs on its localStorage fallback engine — so these assertions still read
 * the stored envelope straight out of the localStorage mock.
 *
 * Node's experimental localStorage global shadows jsdom's, so we install a
 * functional mock (same pattern as tests/unit/cache.test.js).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CACHE_KEYS, CACHE_VERSION, FEED_CACHE_SNAPSHOT_MAX,
  loadFeedCache, saveFeedCache, saveFeedCacheSoon, clearFeedCache,
  loadSearchIndex, saveSearchIndex,
  __test__ as cacheTest,
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

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  storageTest.reset();
  store = {};
  localStorageMock.getItem.mockImplementation(baseImpl.getItem);
  localStorageMock.setItem.mockImplementation(baseImpl.setItem);
  localStorageMock.removeItem.mockImplementation(baseImpl.removeItem);
  localStorageMock.setItem.mockClear();
});

describe('FE6 — feed cache version + TTL', () => {
  it('stamps saves with the current version and a timestamp', async () => {
    await saveFeedCache(VIDEOS, 42);
    const raw = JSON.parse(store[CACHE_KEYS.FEED]);
    expect(raw.version).toBe(CACHE_VERSION);
    expect(typeof raw.savedAt).toBe('number');
  });

  it('round-trips a freshly saved payload', async () => {
    await saveFeedCache(VIDEOS, 42);
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('rejects and clears a wrong-version payload', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({
      videos: VIDEOS, total: 42, version: CACHE_VERSION + 999, savedAt: Date.now(),
    });
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('rejects and clears a payload older than the 24h TTL', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({
      videos: VIDEOS, total: 42, version: CACHE_VERSION, savedAt: Date.now() - (DAY_MS + 60_000),
    });
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('accepts a payload saved just inside the TTL', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({
      videos: VIDEOS, total: 42, version: CACHE_VERSION, savedAt: Date.now() - (DAY_MS - 60_000),
    });
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 42 });
  });

  it('rejects a legacy envelope-less payload (self-heals to absent)', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({ videos: VIDEOS, total: 42 });
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });

  it('still self-heals a bad-shape payload even when fresh (no numeric total)', async () => {
    store[CACHE_KEYS.FEED] = JSON.stringify({
      videos: VIDEOS, version: CACHE_VERSION, savedAt: Date.now(),
    });
    expect(await loadFeedCache()).toBeNull();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });
});

describe('FE6 — search index version + TTL', () => {
  it('stamps saves and round-trips a fresh payload', async () => {
    await saveSearchIndex(VIDEOS);
    const raw = JSON.parse(store[CACHE_KEYS.SEARCH_INDEX]);
    expect(raw.version).toBe(CACHE_VERSION);
    expect(typeof raw.savedAt).toBe('number');
    expect(await loadSearchIndex()).toEqual(VIDEOS);
  });

  it('rejects and clears a wrong-version payload', async () => {
    store[CACHE_KEYS.SEARCH_INDEX] = JSON.stringify({
      videos: VIDEOS, version: CACHE_VERSION + 999, savedAt: Date.now(),
    });
    expect(await loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });

  it('rejects and clears a payload older than the 24h TTL', async () => {
    store[CACHE_KEYS.SEARCH_INDEX] = JSON.stringify({
      videos: VIDEOS, version: CACHE_VERSION, savedAt: Date.now() - (DAY_MS + 60_000),
    });
    expect(await loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });

  it('rejects a legacy bare-array payload (no envelope)', async () => {
    store[CACHE_KEYS.SEARCH_INDEX] = JSON.stringify(VIDEOS);
    expect(await loadSearchIndex()).toBeNull();
    expect(store[CACHE_KEYS.SEARCH_INDEX]).toBeUndefined();
  });
});

describe('FE5 — coalesced, capped feed-cache writes', () => {
  const feedWrites = () =>
    localStorageMock.setItem.mock.calls.filter(([key]) => key === CACHE_KEYS.FEED);
  // Fire the deferred flush, then wait out the async snapshot write it queues.
  const flushWrites = async () => {
    await vi.runAllTimersAsync();
    await cacheTest.settled();
  };

  beforeEach(() => {
    // Force the setTimeout fallback path so fake timers drive the flush
    // deterministically (jsdom may or may not expose requestIdleCallback).
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not write synchronously — the save is deferred', async () => {
    saveFeedCacheSoon(VIDEOS, 10);
    expect(feedWrites().length).toBe(0);
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();

    await flushWrites();
    expect(feedWrites().length).toBe(1);
  });

  it('coalesces a burst into a single write of the LATEST snapshot', async () => {
    saveFeedCacheSoon(VIDEOS, 1);
    saveFeedCacheSoon(VIDEOS, 2);
    saveFeedCacheSoon(VIDEOS, 3);
    expect(feedWrites().length).toBe(0); // nothing yet — all coalesced

    await flushWrites();
    expect(feedWrites().length).toBe(1); // one write for the whole burst
    expect(await loadFeedCache()).toEqual({ videos: VIDEOS, total: 3 }); // last wins
  });

  it('caps the persisted snapshot to FEED_CACHE_SNAPSHOT_MAX items', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      video_id: `v${i}`, title: `V${i}`, channel_name: 'C', comment_count: 0,
    }));
    saveFeedCacheSoon(many, 500);
    await flushWrites();

    const persisted = JSON.parse(store[CACHE_KEYS.FEED]);
    expect(persisted.videos.length).toBe(FEED_CACHE_SNAPSHOT_MAX);
    expect(persisted.videos.length).toBeLessThan(many.length);
    // The cap keeps the TOP of the feed (the pages a restore actually paints).
    expect(persisted.videos[0].video_id).toBe('v0');
    expect(persisted.total).toBe(500);
  });

  it('clearFeedCache drops a queued snapshot so it is not resurrected', async () => {
    saveFeedCacheSoon(VIDEOS, 10);
    await clearFeedCache();
    await flushWrites();
    expect(store[CACHE_KEYS.FEED]).toBeUndefined();
  });
});
