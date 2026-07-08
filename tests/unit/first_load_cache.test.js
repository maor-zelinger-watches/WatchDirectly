/**
 * Regression test for the first-load feed cache write.
 *
 * The initial load fetches page 1 in two steps: a fast N+1 fetch to paint
 * immediately, then a second full-page (PAGE_SIZE) fetch for the rest. The
 * bug: saveFeedCache ran ONLY after the second fetch, so when that request
 * was slow or failed (Apps Script cold-starts routinely time out), the cache
 * was never written. A refresh then found no cache, fell through to the
 * network path, and showed the skeleton — the "it reloads everything from the
 * backend" report.
 *
 * The fix persists the page-1 snapshot from the FIRST fetch, before the
 * second. This test proves the cache survives a failing second fetch — it
 * goes red on the old code (localStorage empty) and green on the fix.
 *
 * Harness mirrors revalidate_race.test.js: app.js builds an IntersectionObserver
 * at module load (stubbed), exposes __test__ for driving, and every global is
 * restored in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

const flush = () => new Promise((r) => setTimeout(r, 0));

// Node's experimental localStorage global shadows jsdom's and lacks clear();
// install a functional mock (same pattern as tests/unit/cache.test.js).
let store = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
  },
  writable: true,
});

let appTest;

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
  document.body.innerHTML = `
    <div id="feed-container"></div>
    <div id="load-more-container"></div>
    <div id="feed-skeleton"></div>
    <div id="feed-empty"><p></p></div>
    <div id="toast-container"></div>`;
  store = {};
  // A short viewport forces the two-fetch path: initialLimit (N+1) < PAGE_SIZE,
  // so loadNextPage issues the small first fetch AND the full-page second one.
  Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
  if (!appTest) {
    appTest = (await import('../../js/app.js')).__test__;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  store = {};
  document.body.innerHTML = '';
});

/** Reset shared module state to a pristine "nothing loaded yet" baseline. */
function seedFreshLoad(state) {
  Object.assign(state, {
    videos: [], totalVideos: 0, currentPage: 0, hasMore: true,
    loading: false, revalidating: false, initialLoadComplete: false, view: 'latest',
    filter: { query: '', types: [] }, prefetchBuffer: [], prefetching: false,
    prefetchToken: 0, pendingFetchPage: 0, expandedComments: new Set(),
    commentsCache: {}, renderToken: 0, nextCursor: undefined,
  });
}

const firstBatch = [
  { video_id: 'a', published_at: '2026-01-03T00:00:00Z', comment_count: 0 },
  { video_id: 'b', published_at: '2026-01-02T00:00:00Z', comment_count: 0 },
  { video_id: 'c', published_at: '2026-01-01T00:00:00Z', comment_count: 0 },
];

describe('first-load feed cache is written from the first fetch', () => {
  it('persists the page-1 snapshot even when the second full-page fetch fails', async () => {
    const { state, loadNextPage } = appTest;
    seedFreshLoad(state);

    // First page=1 fetch succeeds and paints; the second (full-page) one fails,
    // simulating an Apps Script cold-start timeout on the follow-up request.
    let page1Calls = 0;
    fetch.mockImplementation((url) => {
      if (url.includes('action=feed') && url.includes('page=1')) {
        page1Calls++;
        if (page1Calls === 1) {
          return Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: firstBatch, total: 50, next_cursor: 'c1' }) });
        }
        return Promise.reject(new Error('backend timeout'));
      }
      return Promise.resolve({ ok: true, json: () =>
        Promise.resolve({ status: 'ok', videos: [], total: 50 }) });
    });

    await loadNextPage();
    await flush();

    // Two page-1 fetches were issued (the second is the one that failed) — this
    // guarantees we exercised the two-fetch path the bug lived in.
    expect(page1Calls).toBe(2);

    // The fix: a valid cache exists despite the failed second fetch.
    const raw = localStorage.getItem('wd_feed_cache');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.videos.map((v) => v.video_id)).toEqual(['a', 'b', 'c']);
    expect(parsed.total).toBe(50);
  });

  it('upgrades the cache to the full page when the second fetch succeeds', async () => {
    const { state, loadNextPage } = appTest;
    seedFreshLoad(state);

    const fullPage = [
      ...firstBatch,
      { video_id: 'd', published_at: '2025-12-31T00:00:00Z', comment_count: 0 },
      { video_id: 'e', published_at: '2025-12-30T00:00:00Z', comment_count: 0 },
    ];

    let page1Calls = 0;
    fetch.mockImplementation((url) => {
      if (url.includes('action=feed') && url.includes('page=1')) {
        page1Calls++;
        const videos = page1Calls === 1 ? firstBatch : fullPage;
        return Promise.resolve({ ok: true, json: () =>
          Promise.resolve({ status: 'ok', videos, total: 50, next_cursor: 'c1' }) });
      }
      return Promise.resolve({ ok: true, json: () =>
        Promise.resolve({ status: 'ok', videos: [], total: 50 }) });
    });

    await loadNextPage();
    await flush();

    const parsed = JSON.parse(localStorage.getItem('wd_feed_cache'));
    expect(parsed.videos.map((v) => v.video_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
