/**
 * Regression tests for persisting scrolled-through pages and reconciling them
 * on refresh without losing the tail.
 *
 * The bugs these lock in:
 *   1. loadNextPage's infinite-scroll branch never wrote the cache, so pages
 *      2+ were lost on refresh — only page 1 came back from localStorage and
 *      the rest re-fetched from the backend.
 *   2. revalidateFeed replaced state.videos with fresh page 1 and animated out
 *      every card not in it. With a multi-page feed loaded, that wiped the
 *      whole scrolled tail (items absent from page 1 are pushed-down, not
 *      deleted). The fix reconciles the front non-destructively: add new top
 *      items + update counts, keep the tail.
 *
 * Harness mirrors revalidate_race.test.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

const flush = () => new Promise((r) => setTimeout(r, 0));

// Node's experimental localStorage shadows jsdom's and lacks clear();
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

/** Build N descending-dated videos: v1 newest … vN oldest. */
function makeVideos(n, prefix = 'v') {
  return Array.from({ length: n }, (_, i) => ({
    video_id: `${prefix}${i + 1}`,
    title: `Title ${i + 1}`,
    channel_name: 'Channel',
    url: `https://www.youtube.com/watch?v=${prefix}${i + 1}`,
    published_at: `2026-01-${String(31 - i).padStart(2, '0')}T00:00:00Z`,
    comment_count: 0,
    vote_count: 0,
  }));
}

/** Render minimal DOM cards the revalidate diff can see as "already loaded". */
function renderCards(videos) {
  const container = document.getElementById('feed-container');
  container.innerHTML = videos.map(v =>
    `<article class="media-card" data-video-id="${v.video_id}" data-published-at="${v.published_at}">
       <button class="media-card__comments-toggle" data-video-id="${v.video_id}">💬 ${v.comment_count} comments</button>
     </article>`).join('');
}

function seed(state, videos, total, extra = {}) {
  Object.assign(state, {
    videos: [...videos], totalVideos: total, currentPage: 2, hasMore: true,
    loading: false, revalidating: false, initialLoadComplete: true, view: 'latest',
    filter: { query: '', types: [] }, prefetchBuffer: [], prefetching: false,
    prefetchToken: 0, pendingFetchPage: 0, expandedComments: new Set(),
    commentsCache: {}, renderToken: 0, nextCursor: 'tail-cursor',
    fullscreenVideoId: null, ...extra,
  });
}

describe('infinite scroll persists the growing feed to the cache', () => {
  it('writes every loaded page to wd_feed_cache, not just page 1', async () => {
    const { state, loadNextPage } = appTest;
    const page1 = makeVideos(10);
    seed(state, page1, 50, { currentPage: 1 });

    const page2 = makeVideos(3, 'p2v'); // 3 fresh items on page 2
    fetch.mockImplementation((url) =>
      url.includes('page=2')
        ? Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: page2, total: 50, next_cursor: 'c2' }) })
        : Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    await loadNextPage();
    await flush();

    const parsed = JSON.parse(localStorage.getItem('wd_feed_cache'));
    expect(parsed.videos).toHaveLength(13);
    expect(parsed.videos.map(v => v.video_id)).toEqual(
      expect.arrayContaining(['v1', 'v10', 'p2v1', 'p2v2', 'p2v3']));
  });
});

describe('revalidateFeed reconciles a multi-page feed without losing the tail', () => {
  it('keeps pages 2+ while adding new top items and updating counts', async () => {
    const { state, revalidateFeed } = appTest;
    const loaded = makeVideos(15); // 15 loaded (pages 1 + part of 2)
    seed(state, loaded, 50);
    renderCards(loaded);

    // Fresh page 1: one brand-new item at the very top, v1's comment count
    // bumped, and the rest of the newest items. v10..v15 (the tail) are NOT
    // in this response — the old code would have deleted them.
    const vNew = { ...makeVideos(1, 'new')[0], published_at: '2026-02-01T00:00:00Z' };
    const freshPage1 = [
      vNew,
      { ...loaded[0], comment_count: 99 }, // v1 with a new comment count
      ...loaded.slice(1, 9),               // v2..v9
    ];
    fetch.mockImplementation((url) =>
      url.includes('page=1')
        ? Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: freshPage1, total: 50, next_cursor: 'page1-cursor' }) })
        : Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: [], total: 50 }) }));

    await revalidateFeed();
    await flush();

    const ids = state.videos.map(v => v.video_id);
    // Tail survived.
    expect(ids).toEqual(expect.arrayContaining(['v10', 'v11', 'v12', 'v13', 'v14', 'v15']));
    // New top item added; nothing removed.
    expect(ids).toContain('new1');
    expect(state.videos).toHaveLength(16);
    // Count update landed on the existing item.
    expect(state.videos.find(v => v.video_id === 'v1').comment_count).toBe(99);
    // Newest item sorts to the front.
    expect(ids[0]).toBe('new1');
    // Live cursor kept (points past the tail) — not rewound to page 1's.
    expect(state.nextCursor).not.toBe('page1-cursor');
    // Whole merged feed persisted.
    expect(JSON.parse(localStorage.getItem('wd_feed_cache')).videos).toHaveLength(16);
  });

  it('still removes genuinely-gone items when only page 1 is loaded', async () => {
    const { state, revalidateFeed } = appTest;
    const page1 = makeVideos(5); // single page, no tail
    seed(state, page1, 5, { currentPage: 1, nextCursor: '' });
    renderCards(page1);

    // v3 is gone from the fresh feed; with no tail that IS a real removal.
    const fresh = page1.filter(v => v.video_id !== 'v3');
    fetch.mockImplementation((url) =>
      url.includes('page=1')
        ? Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: fresh, total: 4, next_cursor: '' }) })
        : Promise.resolve({ ok: true, json: () =>
            Promise.resolve({ status: 'ok', videos: [], total: 4 }) }));

    await revalidateFeed();
    await flush();

    expect(state.videos.map(v => v.video_id)).not.toContain('v3');
    expect(state.videos).toHaveLength(4);
  });
});
