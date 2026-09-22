/**
 * Regression tests for the search-index page-size clamp bug: the backend caps
 * any client-supplied limit at MAX_PAGE_LIMIT (100, BE11) and computes page
 * offsets from the CLAMPED value, but buildSearchIndex/appendArchiveToIndex
 * did their page math with the REQUESTED chunk size. With a requested chunk of
 * 500 against a served page of 100, pages 2..N landed on offsets 100, 200,
 * 300… — the same first few hundred rows — and the loop bound `(p-1)*chunk <
 * total` cut the page list ~5× short. Net effect: the index silently held
 * only the newest few hundred items of a multi-thousand-item catalog, so
 * search/Starred/Bookmarks never saw the rest.
 *
 * The fix derives the effective page size from what page 1 actually returned
 * and drives all page math off that, so any server-side clamp is self-healing.
 * These tests simulate a server that serves fewer rows than requested.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../../js/state.js';
import { api } from '../../js/api-client.js';

// views.js transitively imports cards.js -> lazy-iframe.js, which builds an
// IntersectionObserver at module load — stub it before the dynamic import.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

// The server's page size in these tests — deliberately smaller than any
// requested chunk so the math must adapt to survive.
const SERVED = 50;

let buildSearchIndex;
let appendArchiveToIndex;

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

/** A paged mock endpoint: `total` rows served SERVED at a time, whatever
 *  limit the caller asked for — exactly how the backend's clamp behaves. */
function clampedEndpoint(prefix, total, seen) {
  return async (page) => {
    seen.push(page);
    const start = (page - 1) * SERVED;
    const count = Math.max(0, Math.min(SERVED, total - start));
    return { videos: rows(prefix, count, start), total };
  };
}

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
  if (!buildSearchIndex) {
    const t = (await import('../../js/views.js')).__test__;
    buildSearchIndex = t.buildSearchIndex;
    appendArchiveToIndex = t.appendArchiveToIndex;
  }
  state.searchIndex = null;
  state.searchIndexProgress = new Set();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.searchIndex = null;
  state.searchIndexProgress = new Set();
});

describe('search index — page math follows the served page size, not the requested chunk', () => {
  it('buildSearchIndex covers the whole live catalog when the server clamps the limit', async () => {
    const seen = [];
    // 170 rows at 50/page => pages 1..4 (page 4 short). The OLD math with a
    // 100+ requested chunk stopped at page 2 and indexed 100 of 170.
    vi.spyOn(api, 'fetchFeed').mockImplementation(clampedEndpoint('live', 170, seen));
    // No archive in this scenario — the live phase is what's under test.
    vi.spyOn(api, 'fetchArchive').mockRejectedValue(new Error('no archive'));

    const index = await buildSearchIndex();

    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(index.length).toBe(170);
  });

  it('appendArchiveToIndex covers the whole archive when the server clamps the limit', async () => {
    state.searchIndex = rows('live', 30);
    const seen = [];
    // 120 archived rows at 50/page => pages 1..3, plenty of cap headroom.
    vi.spyOn(api, 'fetchArchive').mockImplementation(clampedEndpoint('arch', 120, seen));

    await appendArchiveToIndex();

    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(state.searchIndex.length).toBe(30 + 120);
  });

  it('a single-page catalog fetches no follow-up pages', async () => {
    const seen = [];
    vi.spyOn(api, 'fetchFeed').mockImplementation(clampedEndpoint('live', 40, seen));
    vi.spyOn(api, 'fetchArchive').mockRejectedValue(new Error('no archive'));

    const index = await buildSearchIndex();

    expect(seen).toEqual([1]); // 40 < served page size: page 1 is everything
    expect(index.length).toBe(40);
  });
});
