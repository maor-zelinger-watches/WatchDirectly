/**
 * Regression test for finding #2 — the revalidateFeed pagination race.
 *
 * revalidateFeed() must claim state.revalidating BEFORE its first await, so a
 * loadNextPage() fired by the scroll observer during the network round-trip is
 * blocked from advancing pagination underneath the diff (pre-fix it advanced to
 * page 2, then revalidation reset to fresh page 1 and dropped those rows). It
 * must also release the flag on every return path, including the early returns
 * that now claim it at entry.
 *
 * app.js exports nothing in production; it exposes __test__ solely for this
 * file. Every global mutation (IntersectionObserver, fetch, localStorage, the
 * DOM) is undone in afterEach, which vitest runs even when an assertion throws,
 * so a failing test leaves no residue behind.
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
    filter: { query: '', category: '' }, prefetchBuffer: [], prefetching: false,
    prefetchToken: 0, pendingFetchPage: 0, expandedComments: new Set(),
    commentsCache: {}, renderToken: 0,
  });
}

const cached = [
  { video_id: 'a', published_at: '2026-01-02T00:00:00Z', comment_count: 0 },
  { video_id: 'b', published_at: '2026-01-01T00:00:00Z', comment_count: 0 },
];

describe('revalidateFeed pagination race (finding #2)', () => {
  it('claims the revalidation guard synchronously, before the first await resolves', async () => {
    const { state, revalidateFeed } = appTest;
    seedCachedFeed(state, cached, 50);

    let resolvePage1;
    fetch.mockImplementation((url) =>
      url.includes('page=1')
        ? new Promise((r) => { resolvePage1 = r; })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    const pending = revalidateFeed(); // deliberately not awaited

    // The fix: the guard is up the instant we enter — not after the network.
    expect(state.revalidating).toBe(true);

    resolvePage1({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: cached, total: 50 }) });
    await pending;
    await flush();
  });

  it('blocks a concurrent loadNextPage from advancing pagination during the window', async () => {
    const { state, revalidateFeed, loadNextPage } = appTest;
    seedCachedFeed(state, cached, 50);

    let resolvePage1;
    fetch.mockImplementation((url) =>
      url.includes('page=1')
        ? new Promise((r) => { resolvePage1 = r; })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    const pending = revalidateFeed(); // suspended at the page-1 await

    const page2Before = fetch.mock.calls.filter(([u]) => u.includes('page=2')).length;
    loadNextPage(); // a scroll firing mid-revalidation

    // Pre-fix this advanced to page 2 and concat'd rows the diff then dropped.
    expect(state.loading).toBe(false);
    expect(state.currentPage).toBe(1);
    expect(fetch.mock.calls.filter(([u]) => u.includes('page=2')).length).toBe(page2Before);

    resolvePage1({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: cached, total: 50 }) });
    await pending;
    await flush();
  });

  it('releases the guard on the identical-content early-return path', async () => {
    const { state, revalidateFeed } = appTest;
    seedCachedFeed(state, cached, 2); // total === videos.length so refill stays quiet

    fetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: cached, total: 2 }) }));

    await revalidateFeed();
    await flush();

    // The early return claimed the flag at entry; the finally must clear it.
    expect(state.revalidating).toBe(false);
  });
});
