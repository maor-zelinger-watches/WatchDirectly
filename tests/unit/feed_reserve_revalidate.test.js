/**
 * End-to-end through app.js (revalidateFeed → loadNextPage): a cached Latest
 * feed whose front was pushed entirely off page 1 while the visitor was away
 * is replaced by fresh page 1 — and then paginates back through the cards it
 * already had WITHOUT re-fetching them, once a server page reaches them.
 *
 * Harness mirrors revalidate_race.test.js (real DOM, fetch stubbed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../../js/config.js';

class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }
const flush = () => new Promise((r) => setTimeout(r, 0));

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
  if (!appTest) appTest = (await import('../../js/app.js')).__test__;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const T0 = Date.parse('2026-10-06T12:00:00Z');
const HOUR = 3600 * 1000;
const vid = (id, hoursAgo) => ({
  video_id: id, url: `https://www.youtube.com/watch?v=${id}`, title: id, channel_name: 'C',
  published_at: new Date(T0 - hoursAgo * HOUR).toISOString(), comment_count: 0, vote_count: 0,
});
const cached = Array.from({ length: 30 }, (_, i) => vid(`c${i}`, 10 + i)); // 3 pages scrolled yesterday evening
const fresh = Array.from({ length: 15 }, (_, i) => vid(`n${i}`, i * 0.1));   // 15 new since — the whole front moved
const ids = (vs) => vs.map((v) => v.video_id);
const cursorOf = (vs) => { const l = vs[vs.length - 1]; return `${l.published_at}|${l.video_id}`; };
const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function seedCachedFeed(state) {
  Object.assign(state, {
    videos: [...cached], totalVideos: 2000, currentPage: 3, hasMore: true,
    nextCursor: cursorOf(cached), loading: false, revalidating: false,
    initialLoadComplete: true, view: 'latest', filter: { query: '', types: [] },
    prefetchBuffer: [], prefetching: false, prefetchToken: 0, pendingFetchPage: 0,
    expandedComments: new Set(), commentsCache: {}, feedReserve: null, filterZeroYieldStreak: 0,
  });
  const container = document.getElementById('feed-container');
  container.innerHTML = cached.map((v) => `<article class="media-card" data-video-id="${v.video_id}" data-published="${v.published_at}"></article>`).join('');
}

describe('returning after hours: replaced cards come back from the reserve, not the network', () => {
  it('stashes the replaced tail, then serves it once pagination reaches it', async () => {
    const { state, revalidateFeed, loadNextPage } = appTest;
    seedCachedFeed(state);

    const page1 = fresh.slice(0, 10);
    const page2 = [...fresh.slice(10), ...cached.slice(0, 5)]; // reaches the anchor c0
    fetch.mockImplementation((url) => {
      if (url.includes('page=1')) return json({ status: 'ok', videos: page1, total: 2000, next_cursor: cursorOf(page1) });
      if (url.includes('page=2')) return json({ status: 'ok', videos: page2, total: 2000, next_cursor: cursorOf(page2) });
      return json({ status: 'ok', videos: [], total: 2000, next_cursor: '' });
    });

    await revalidateFeed();
    await flush();

    // Fresh page 1 replaced the cached list. The 30 cached cards are now held
    // in the reserve — or, where the read-ahead refill has already run, moved
    // from the reserve into the prefetch buffer. Nothing is lost, nothing is
    // duplicated, and only pages 1 and 2 went to the server.
    expect(ids(state.videos)).toEqual(ids(page1));
    expect(state.currentPage).toBe(1);
    const buffered = state.prefetchBuffer.flatMap((e) => e.videos);
    const reserved = state.feedReserve ? state.feedReserve.videos : [];
    expect(new Set([...ids(state.videos), ...ids(buffered), ...ids(reserved)]).size).toBe(45);

    await loadNextPage(); // page 2: n10..n14, c0..c4 — the page that reaches the cached range
    expect(ids(state.videos).slice(10, 20)).toEqual(ids(page2));

    await loadNextPage(); // page 3
    await loadNextPage(); // page 4
    await loadNextPage(); // page 5
    await flush();

    expect(ids(state.videos)).toEqual([...ids(fresh), ...ids(cached)]);  // everything, in order, no gaps or dupes
    expect(state.videos).toHaveLength(45);
    expect(state.feedReserve).toBeNull();                                // drained
    // (The continuation after c29 went to the server, whose stub says the
    // catalog ends there — so nextCursor is '' and hasMore is false.)
    expect(state.hasMore).toBe(false);

    // The only cursors that ever went to the server: after fresh page 1 (to
    // get page 2) and after the last cached card (the continuation). No page
    // inside the cached range was re-fetched.
    const cursorsFetched = fetch.mock.calls
      .map(([u]) => decodeURIComponent((String(u).match(/cursor=([^&]*)/) || [])[1] || ''))
      .filter(Boolean);
    expect(new Set(cursorsFetched)).toEqual(new Set([cursorOf(page1), cursorOf(cached)]));

    // The DOM shows the same thing.
    const rendered = [...document.querySelectorAll('#feed-container .media-card')].map((c) => c.dataset.videoId);
    expect(rendered).toEqual(ids(state.videos));
  });

  it('a small change (front still overlaps) keeps the tail in place and needs no reserve', async () => {
    const { state, revalidateFeed } = appTest;
    seedCachedFeed(state);
    const page1 = [...fresh.slice(0, 3), ...cached.slice(0, 7)]; // 3 new items only
    fetch.mockImplementation(() => json({ status: 'ok', videos: page1, total: 2000, next_cursor: cursorOf(page1) }));

    await revalidateFeed();
    await flush();

    expect(ids(state.videos)).toEqual([...ids(fresh.slice(0, 3)), ...ids(cached)]);
    expect(state.feedReserve).toBeNull();
    expect(state.videos).toHaveLength(33);
  });
});
