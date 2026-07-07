/**
 * Regression tests for the revalidateFeed / loadNextPage concurrency model.
 *
 * Design (stale-while-revalidate must feel instant):
 *   - The background page-1 freshness fetch does NOT block pagination.
 *     revalidateFeed claims state.revalidating only when it commits to the
 *     DOM diff, so the guard pauses pagination for the reconciliation, not
 *     for the network round-trip.
 *   - A loadNextPage fetch already in flight is protected by the prefetch
 *     token: when the diff resets pagination it bumps the token, and the
 *     stale response is discarded instead of clobbering the fresh feed.
 *
 * (The guard genuinely pausing pagination DURING the diff is covered
 * end-to-end by tests/e2e/prefetch_races.spec.js bugs 3 and 4, which need a
 * real DOM + animation window to exercise.)
 *
 * app.js exports nothing in production; it exposes __test__ solely for these
 * tests. Every global mutation (IntersectionObserver, fetch, localStorage,
 * the DOM) is undone in afterEach, which vitest runs even when an assertion
 * throws, so a failing test leaves no residue behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// app.js constructs an IntersectionObserver at module load — stub it first.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

const flush = () => new Promise((r) => setTimeout(r, 0));

let appTest;

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  // Benign default so nothing can hit the real network; tests override it.
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
  document.body.innerHTML = `
    <div id="feed-container"></div>
    <div id="load-more-container"></div>
    <div id="feed-skeleton"></div>
    <div id="feed-empty"><p></p></div>
    <div id="toast-container"></div>`;
  if (!appTest) {
    appTest = (await import('../../js/app.js')).__test__;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Reset the shared module state to a "cache just painted" baseline. */
function seedCachedFeed(state, videos, total) {
  Object.assign(state, {
    videos: [...videos], totalVideos: total, currentPage: 1, hasMore: true,
    loading: false, revalidating: false, initialLoadComplete: true, view: 'latest',
    filter: { query: '', types: [] }, prefetchBuffer: [], prefetching: false,
    prefetchToken: 0, pendingFetchPage: 0, expandedComments: new Set(),
    commentsCache: {}, renderToken: 0, nextCursor: undefined,
  });
}

const cached = [
  { video_id: 'a', published_at: '2026-01-02T00:00:00Z', comment_count: 0 },
  { video_id: 'b', published_at: '2026-01-01T00:00:00Z', comment_count: 0 },
];

describe('revalidateFeed does not block pagination during the freshness fetch', () => {
  it('leaves the revalidation guard down while the background page-1 fetch is in flight', async () => {
    const { state, revalidateFeed } = appTest;
    seedCachedFeed(state, cached, 50);

    let resolvePage1;
    fetch.mockImplementation((url) =>
      url.includes('page=1')
        ? new Promise((r) => { resolvePage1 = r; })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    const pending = revalidateFeed(); // deliberately not awaited — suspended at page-1

    // The whole point: the guard is NOT raised for the network wait, so a
    // scroll firing right now would be free to paginate the cached window.
    expect(state.revalidating).toBe(false);

    resolvePage1({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: cached, total: 50 }) });
    await pending;
    await flush();

    // Identical content settled via the fast path — guard still down.
    expect(state.revalidating).toBe(false);
  });

  it('lets a concurrent loadNextPage paginate while the freshness fetch is in flight', async () => {
    const { state, revalidateFeed, loadNextPage } = appTest;
    seedCachedFeed(state, cached, 50);

    let resolvePage1;
    fetch.mockImplementation((url) =>
      url.includes('page=1')
        ? new Promise((r) => { resolvePage1 = r; })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    const revalidating = revalidateFeed(); // suspended at the page-1 await

    const page2Before = fetch.mock.calls.filter(([u]) => u.includes('page=2')).length;
    await loadNextPage(); // a scroll firing mid-revalidation must NOT be blocked

    // Pre-fix the coarse revalidating guard swallowed this entirely.
    expect(fetch.mock.calls.filter(([u]) => u.includes('page=2')).length).toBe(page2Before + 1);

    resolvePage1({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: cached, total: 50 }) });
    await revalidating;
    await flush();
  });

  it('adopts the server cursor on the identical-content path when pagination did not advance', async () => {
    const { state, revalidateFeed } = appTest;
    seedCachedFeed(state, cached, 50);

    fetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: cached, total: 50, next_cursor: 'server|cursor' }) }));

    await revalidateFeed();
    await flush();

    expect(state.nextCursor).toBe('server|cursor');
    expect(state.revalidating).toBe(false);
  });
});

describe('an in-flight paginated response cannot clobber a pagination reset', () => {
  it('discards loadNextPage\'s response when the prefetch token was bumped mid-flight', async () => {
    const { state, loadNextPage } = appTest;
    seedCachedFeed(state, cached, 50);

    let resolvePage2;
    fetch.mockImplementation((url) =>
      url.includes('page=2')
        ? new Promise((r) => { resolvePage2 = r; })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    const pending = loadNextPage(); // suspended at the page-2 fetch; epoch captured

    // A revalidation diff resets pagination while page 2 is airborne — this
    // is exactly what invalidatePrefetchBuffer() does inside the diff.
    state.prefetchToken++;

    resolvePage2({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [{ video_id: 'c', published_at: '2026-01-03T00:00:00Z' }], total: 50 }) });
    await pending;
    await flush();

    // The stale response was dropped: pagination didn't advance, 'c' never
    // entered state — no duplicate, no regressed page count.
    expect(state.currentPage).toBe(1);
    expect(state.videos.map(v => v.video_id)).toEqual(['a', 'b']);
  });
});
