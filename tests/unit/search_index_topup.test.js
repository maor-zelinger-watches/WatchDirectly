/**
 * Tests for topUpSearchIndex (js/views.js): a session that seeded from a
 * fresh COMPLETE cached index must not re-walk the whole catalog + archive
 * (~40 requests against a backend that serializes executions — minutes of
 * wall clock, every session). It walks feed pages newest-first and stops at
 * the first page that adds no unknown row, because a persisted index is only
 * ever saved after a complete build — everything below that page is already
 * in it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../../js/state.js';
import { api } from '../../js/api-client.js';
import { CACHE_KEYS, CACHE_VERSION } from '../../js/cache.js';

// views.js transitively imports cards.js -> lazy-iframe.js, which builds an
// IntersectionObserver at module load — stub it before the dynamic import.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

// Node's experimental localStorage global shadows jsdom's, so install a
// functional mock (same pattern as tests/unit/cache_versioning.test.js).
let store = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: key => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: key => { delete store[key]; },
  },
  writable: true,
});

const SERVED = 50; // server page size in these tests

let topUpSearchIndex;
let ensureSearchIndex;

/** N distinct index rows under a key prefix (distinct url => distinct index key). */
function rows(prefix, n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    video_id: `${prefix}-${offset + i}`,
    url: `https://example.test/${prefix}/${offset + i}`,
    published_at: '2026-01-01T00:00:00.000Z',
    vote_count: 0,
    comment_count: 0,
  }));
}

/** Feed mock over a fixed newest-first catalog, served SERVED rows per page. */
function feedOver(catalog, seen) {
  return async (page) => {
    seen.push(page);
    const start = (page - 1) * SERVED;
    return { videos: catalog.slice(start, start + SERVED), total: catalog.length };
  };
}

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
  if (!topUpSearchIndex) {
    const mod = await import('../../js/views.js');
    topUpSearchIndex = mod.__test__.topUpSearchIndex;
    ensureSearchIndex = mod.ensureSearchIndex;
  }
  state.searchIndex = null;
  state.searchIndexPromise = null;
  state.searchIndexComplete = false;
  state.searchIndexProgress = new Set();
  state.videos = [];
  store = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.searchIndex = null;
  state.searchIndexPromise = null;
  state.searchIndexComplete = false;
  state.searchIndexProgress = new Set();
  store = {};
});

describe('topUpSearchIndex — refreshes a complete cached index without a full walk', () => {
  it('stops after one page when nothing is new', async () => {
    const catalog = rows('v', 200);
    state.searchIndex = [...catalog]; // cache already holds the whole catalog
    const seen = [];
    vi.spyOn(api, 'fetchFeed').mockImplementation(feedOver(catalog, seen));

    const index = await topUpSearchIndex();

    expect(seen).toEqual([1]); // page 1 fully known → stop
    expect(index.length).toBe(200);
  });

  it('walks only until the first fully-known page when new items sit at the head', async () => {
    const old = rows('v', 200);
    const fresh = rows('new', 60); // > one page of new items
    const catalog = [...fresh, ...old];
    state.searchIndex = [...old];
    const seen = [];
    vi.spyOn(api, 'fetchFeed').mockImplementation(feedOver(catalog, seen));

    const index = await topUpSearchIndex();

    // Page 1: 50 new. Page 2: 10 new + 40 known (has unknowns → continue).
    // Page 3: fully known → stop. Never pages 4/5.
    expect(seen).toEqual([1, 2, 3]);
    expect(index.length).toBe(260);
  });

  it('walks the whole live catalog when everything is new, bounded by total', async () => {
    const catalog = rows('v', 120);
    state.searchIndex = rows('stale', 10); // cache with no overlap at all
    const seen = [];
    vi.spyOn(api, 'fetchFeed').mockImplementation(feedOver(catalog, seen));

    const index = await topUpSearchIndex();

    expect(seen).toEqual([1, 2, 3]); // ceil(120/50) pages, then total stops it
    expect(index.length).toBe(130);
  });
});

describe('ensureSearchIndex — a fresh cached index takes the top-up path', () => {
  it('never refetches the archive and completes off one feed page', async () => {
    const catalog = rows('v', 200);
    localStorage.setItem(CACHE_KEYS.SEARCH_INDEX, JSON.stringify({
      videos: catalog, version: CACHE_VERSION, savedAt: Date.now(),
    }));
    const seen = [];
    const feedSpy = vi.spyOn(api, 'fetchFeed').mockImplementation(feedOver(catalog, seen));
    const archiveSpy = vi.spyOn(api, 'fetchArchive').mockResolvedValue({ videos: [], total: 0 });

    const index = await ensureSearchIndex();

    expect(feedSpy).toHaveBeenCalledTimes(1);      // head check only
    expect(archiveSpy).not.toHaveBeenCalled();     // the cached archive rows stand
    expect(index.length).toBe(200);
    expect(state.searchIndexComplete).toBe(true);
    // The top-up must NOT re-stamp the persisted snapshot: savedAt drives the
    // daily full rebuild that lets server-side deletions age out.
    const raw = JSON.parse(localStorage.getItem(CACHE_KEYS.SEARCH_INDEX));
    expect(raw.videos.length).toBe(200);
  });

  it('a cold session (no cache) still runs the full build with the archive phase', async () => {
    const catalog = rows('v', 80);
    const seenFeed = [];
    vi.spyOn(api, 'fetchFeed').mockImplementation(feedOver(catalog, seenFeed));
    const archiveSpy = vi.spyOn(api, 'fetchArchive')
      .mockResolvedValue({ videos: rows('arch', 30), total: 30 });

    const index = await ensureSearchIndex();

    expect(seenFeed).toEqual([1, 2]);              // full live walk
    expect(archiveSpy).toHaveBeenCalled();         // archive phase runs
    expect(index.length).toBe(110);
    expect(state.searchIndexComplete).toBe(true);
  });
});
