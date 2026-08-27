/**
 * Regression test for FE2 — a failed cold load leaves a permanently blank page
 * with a spinning sentinel.
 *
 * On the initial-load path loadNextPage hides #feed-empty early and only ever
 * re-shows it in the SUCCESS branch. On a first-visit failure (offline, or an
 * Apps Script cold-start 500) the catch sets loadFailed, the finally hides the
 * skeleton, but state.hasMore is still its default `true` — so the old code
 * kept #load-more-container visible as a bare spinner that retried silently on
 * a 1s→30s backoff forever. No empty state, no error text, no retry button.
 *
 * The fix: when state.videos.length === 0 && loadFailed, populate #feed-empty
 * with a failure message + a Retry button and hide #load-more-container.
 * Offline (navigator.onLine === false) and server errors read differently, and
 * an offline failure auto-retries when connectivity returns.
 *
 * Harness mirrors first_load_cache.test.js: app.js builds an IntersectionObserver
 * at module load (stubbed), exposes __test__ for driving, and restores every
 * global in afterEach.
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

/** Force navigator.onLine, whose default in jsdom is true. */
function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

let appTest;

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  document.body.innerHTML = `
    <div id="feed-container"></div>
    <div id="load-more-container" style="display: none;"><div class="spinner"></div></div>
    <div id="feed-skeleton" style="display: none;"></div>
    <div id="feed-empty" style="display: none;"><p>No videos yet. Check back soon!</p></div>
    <div id="toast-container"></div>`;
  store = {};
  setOnline(true);
  // A short viewport keeps the initial fetch small; the first page-1 fetch
  // failing is all this exercises.
  Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
  if (!appTest) {
    appTest = (await import('../../js/app.js')).__test__;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setOnline(true);
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
    commentsCache: {}, nextCursor: undefined,
    feedErrorStreak: 0, filterZeroYieldStreak: 0,
  });
}

describe('FE2 — cold-load failure shows an error empty state, not a bare spinner', () => {
  it('shows #feed-empty with a Retry button and hides #load-more-container on a zero-video failure', async () => {
    const { state, loadNextPage } = appTest;
    seedFreshLoad(state);

    // Every feed fetch fails — the Apps Script cold-start 500 case.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('backend timeout'))));

    await loadNextPage();
    await flush();

    const empty = document.getElementById('feed-empty');
    const sentinel = document.getElementById('load-more-container');

    // The empty state is visible with a real message...
    expect(empty.style.display).toBe('');
    expect(empty.textContent).toContain("Couldn't load the feed");

    // ...and a working Retry control (not a bare spinner).
    const retryBtn = empty.querySelector('#feed-retry-btn');
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent.trim()).toBe('Retry');

    // The infinite-scroll sentinel is hidden, so no silent backoff-retry loop.
    expect(sentinel.style.display).toBe('none');
  });

  it('differentiates offline messaging from a server error', async () => {
    const { state, loadNextPage } = appTest;
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));

    // Offline first-load.
    setOnline(false);
    seedFreshLoad(state);
    await loadNextPage();
    await flush();
    const offlineText = document.getElementById('feed-empty').textContent;
    expect(offlineText).toContain("offline");
    expect(offlineText).not.toContain("Couldn't load the feed");

    // Rebuild the empty node and go online — a server error this time.
    document.getElementById('feed-empty').outerHTML =
      '<div id="feed-empty" style="display: none;"><p>No videos yet. Check back soon!</p></div>';
    setOnline(true);
    seedFreshLoad(state);
    await loadNextPage();
    await flush();
    const serverText = document.getElementById('feed-empty').textContent;
    expect(serverText).toContain("Couldn't load the feed");
    expect(serverText).not.toContain("offline");
  });

  it('Retry re-fetches, and a recovered backend loads the feed and clears the error', async () => {
    const { state, loadNextPage } = appTest;
    seedFreshLoad(state);

    const goodPage = [
      { video_id: 'a', published_at: '2026-01-03T00:00:00Z', comment_count: 0 },
      { video_id: 'b', published_at: '2026-01-02T00:00:00Z', comment_count: 0 },
    ];

    // Fail until the caller flips `recovered`, then serve a real page.
    let recovered = false;
    vi.stubGlobal('fetch', vi.fn(() => {
      if (!recovered) return Promise.reject(new Error('backend timeout'));
      return Promise.resolve({ ok: true, json: () =>
        Promise.resolve({ status: 'ok', videos: goodPage, total: 2, next_cursor: '' }) });
    }));

    await loadNextPage();
    await flush();

    const empty = document.getElementById('feed-empty');
    const retryBtn = empty.querySelector('#feed-retry-btn');
    expect(retryBtn).not.toBeNull();
    expect(empty.style.display).toBe('');

    // Backend recovers; user clicks Retry.
    recovered = true;
    retryBtn.click();
    await flush();

    // Feed loaded, the error empty state is gone (hidden, default markup back).
    expect(state.videos.map((v) => v.video_id)).toEqual(['a', 'b']);
    expect(empty.style.display).toBe('none');
    expect(empty.querySelector('#feed-retry-btn')).toBeNull();
  });

  it('leaves the mid-scroll (non-empty) failure path untouched — sentinel stays visible', async () => {
    const { state, loadNextPage } = appTest;
    seedFreshLoad(state);
    // Simulate a feed already showing page 1: a mid-scroll page-2 fetch fails.
    Object.assign(state, {
      videos: [{ video_id: 'x', published_at: '2026-01-01T00:00:00Z' }],
      currentPage: 1, hasMore: true, initialLoadComplete: true,
    });

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('page 2 timeout'))));

    await loadNextPage();
    await flush();

    // Non-empty failure: existing silent-retry behavior — sentinel stays up,
    // no error empty state is shown.
    expect(document.getElementById('load-more-container').style.display).toBe('');
    expect(document.getElementById('feed-empty').style.display).toBe('none');
    expect(document.getElementById('feed-empty').querySelector('#feed-retry-btn')).toBeNull();
  });
});
