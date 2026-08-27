/**
 * Regression tests for FE7 — appendArchiveToIndex (js/views.js) fanned every
 * archive page against the full SEARCH_INDEX_LIMIT, and its cap guard sat INSIDE
 * the .then after Promise.all had already dispatched every request. With the live
 * catalog near the ceiling, that downloaded pages the index had no room for and
 * discarded them in the merge guard.
 *
 * The fix computes `remaining = cap - state.searchIndex.length`, sizes the page
 * list to that headroom (ceil to whole chunks), and fans out through a bounded
 * pool (runBounded) instead of one Promise.all burst.
 *
 * These drive the internal seams exposed via views.js __test__.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../../js/config.js';
import { state } from '../../js/state.js';
import { api } from '../../js/api-client.js';

// views.js transitively imports cards.js -> lazy-iframe.js, which builds an
// IntersectionObserver at module load — stub it before the dynamic import.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

const CHUNK = CONFIG.SEARCH_CHUNK_SIZE;   // 500
const CAP = CONFIG.SEARCH_INDEX_LIMIT;    // 5000

let appendArchiveToIndex;
let runBounded;

/** N distinct index rows under a key prefix (distinct url => distinct index key). */
function rows(prefix, n) {
  return Array.from({ length: n }, (_, i) => ({
    video_id: `${prefix}-${i}`,
    url: `https://example.test/${prefix}/${i}`,
    published_at: '2026-01-01T00:00:00.000Z',
    vote_count: 0,
    comment_count: 0,
  }));
}

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
  if (!appendArchiveToIndex) {
    const t = (await import('../../js/views.js')).__test__;
    appendArchiveToIndex = t.appendArchiveToIndex;
    runBounded = t.runBounded;
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

describe('FE7 — appendArchiveToIndex sizes fetches to remaining headroom', () => {
  it('fetches only the archive pages that fit under the cap, not the whole archive', async () => {
    // Live index sits 600 below the ceiling: after archive page 1 (500 rows)
    // merges, only ~100 items of headroom remain — one more page at most.
    state.searchIndex = rows('live', CAP - 600);

    const seen = [];
    vi.spyOn(api, 'fetchArchive').mockImplementation(async (page) => {
      seen.push(page);
      // A huge archive total: the OLD code sized pages to min(total, cap) and
      // would have fetched pages 2..10 here.
      return { videos: rows(`arch${page}`, CHUNK), total: 100_000 };
    });

    await appendArchiveToIndex();

    // Page 1 (the probe) plus exactly one headroom page — never the long tail.
    expect(seen).toEqual([1, 2]);
    expect(Math.max(...seen)).toBeLessThan(3);
    // Without the fix this would be ~10 archive requests.
    expect(api.fetchArchive).toHaveBeenCalledTimes(2);
  });

  it('fetches nothing when the index is already at the cap', async () => {
    state.searchIndex = rows('live', CAP);
    const spy = vi.spyOn(api, 'fetchArchive').mockResolvedValue({ videos: [], total: 0 });

    await appendArchiveToIndex();

    expect(spy).not.toHaveBeenCalled();
  });

  it('stops fanning out once a mid-fetch merge reaches the cap', async () => {
    // Headroom for ~4 chunks; give the archive far more so the page list is
    // bounded by remaining, and the in-flight merge guard halts extra merges.
    state.searchIndex = rows('live', CAP - 4 * CHUNK);
    const seen = [];
    vi.spyOn(api, 'fetchArchive').mockImplementation(async (page) => {
      seen.push(page);
      return { videos: rows(`arch${page}`, CHUNK), total: 100_000 };
    });

    await appendArchiveToIndex();

    // remaining after page 1 = 3*CHUNK => 3 more pages (2,3,4); never the full
    // archive (which would be pages 2..10 against the cap).
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(state.searchIndex.length).toBeLessThanOrEqual(CAP + CHUNK); // ≤ one overshoot chunk
  });
});

describe('FE7 — runBounded caps concurrency', () => {
  it('never runs more than `limit` workers at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await runBounded(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 0));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    const done = [];
    await runBounded(items, 4, async (n) => { done.push(n); });
    expect(done.sort((a, b) => a - b)).toEqual(items);
  });

  it('resolves on an empty list without invoking the worker', async () => {
    const worker = vi.fn();
    await runBounded([], 4, worker);
    expect(worker).not.toHaveBeenCalled();
  });
});
