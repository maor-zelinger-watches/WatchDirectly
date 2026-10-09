/**
 * Unit tests for the feed reserve (prefetch.js) — cached Latest cards that the
 * revalidate replaced, kept and served as pages once pagination reaches them.
 *
 * The bug this fixes: returning after ~6 hours, fresh page 1 shares nothing
 * with the cached front (the feed gains ~10 items per 6h), so revalidateFeed
 * replaced the whole cached list with fresh page 1 and re-fetched every card
 * the visitor already had, one cursor page at a time ("it doesn't load until
 * I reach the articles I already had"). Now those cards are held in feed
 * order and served from memory the moment a server page ends at or past the
 * cached list's newest item (the anchor) — the point from which the server's
 * continuation is, by construction, exactly the cached tail.
 *
 * The api client is mocked at the module boundary, as in prefetch.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/api-client.js', () => ({
  api: { fetchFeed: vi.fn() },
}));

import { api } from '../../js/api-client.js';
import { state } from '../../js/state.js';
import { CONFIG } from '../../js/config.js';
import {
  cursorAfter,
  stashFeedReserve,
  absorbServerPage,
  fetchFeedPage,
  clearFeedReserve,
  refillPrefetchBuffer,
} from '../../js/prefetch.js';

const T0 = Date.parse('2026-10-06T12:00:00Z');
const HOUR = 60 * 60 * 1000;
/** A video published `hoursAgo` hours before T0. */
const vid = (id, hoursAgo) => ({ video_id: id, published_at: new Date(T0 - hoursAgo * HOUR).toISOString(), comment_count: 0 });
/** The cached list: c0 (newest, 10h old) … c29 (39h old). */
const cachedList = () => Array.from({ length: 30 }, (_, i) => vid(`c${i}`, 10 + i));
/** `n` brand-new items newer than everything cached, newest first. */
const fresh = (n, from = 0) => Array.from({ length: n }, (_, i) => vid(`n${from + i}`, (from + i) * 0.1)); // all newer than c0 (10h)
const ids = (vs) => vs.map((v) => v.video_id);
const serverPage = (videos, total = 2000) => Promise.resolve({ status: 'ok', videos, total, next_cursor: cursorAfter(videos) });

beforeEach(() => {
  api.fetchFeed.mockReset();
  clearFeedReserve();
  Object.assign(state, {
    videos: [], currentPage: 1, totalVideos: 2000, nextCursor: undefined, hasMore: true,
    initialLoadComplete: true, view: 'latest', filter: { query: '', types: [] },
    prefetchBuffer: [], prefetching: false, prefetchToken: 0, pendingFetchPage: 0,
  });
  document.body.innerHTML = '<div id="load-more-container"></div>';
});

describe('stashFeedReserve', () => {
  it('keeps the cached cards fresh page 1 does not show, in feed order, unreached when nothing overlaps', () => {
    const page1 = fresh(10);
    stashFeedReserve(cachedList().reverse(), page1); // any input order
    expect(state.feedReserve).not.toBeNull();
    expect(ids(state.feedReserve.videos)).toEqual(ids(cachedList()));
    expect(state.feedReserve.reached).toBe(false); // 10 new items, none inside the cached range yet
    expect(state.feedReserve.anchor.id).toBe('c0');
  });

  it('is reached immediately when fresh page 1 already overlaps the cached front (partial overlap)', () => {
    const cached = cachedList().slice(0, 10);                 // c0..c9, a single cached page
    const page1 = [...fresh(2), ...cached.slice(0, 8)];       // n0 n1 c0..c7
    stashFeedReserve(cached, page1);
    expect(ids(state.feedReserve.videos)).toEqual(['c8', 'c9']);
    expect(state.feedReserve.reached).toBe(true);             // page 1 ends inside the cached range
  });

  it('is null when there is nothing to keep', () => {
    stashFeedReserve([], fresh(10));
    expect(state.feedReserve).toBeNull();
    const cached = cachedList().slice(0, 3);
    stashFeedReserve(cached, [...fresh(1), ...cached]);       // everything cached is on page 1
    expect(state.feedReserve).toBeNull();
  });
});

describe('fetchFeedPage — the ~6h-away case (15 new items, cached front pushed off page 1)', () => {
  it('fetches from the server until a page reaches the anchor, then serves the rest from memory', async () => {
    const newItems = fresh(15);
    const page1 = newItems.slice(0, 10);
    stashFeedReserve(cachedList(), page1);
    state.totalVideos = 2000;

    // Page 2 from the server: the last 5 new items, then c0..c4.
    const page2 = [...newItems.slice(10), ...cachedList().slice(0, 5)];
    api.fetchFeed.mockReturnValueOnce(serverPage(page2));
    const got2 = await fetchFeedPage(2, cursorAfter(page1));
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
    expect(api.fetchFeed).toHaveBeenLastCalledWith(2, CONFIG.PAGE_SIZE, cursorAfter(page1));
    expect(got2.fromReserve).toBeUndefined();
    expect(ids(got2.videos)).toEqual(ids(page2));
    // The server page covered c0..c4 and ended inside the cached range: reached.
    expect(state.feedReserve.reached).toBe(true);
    expect(ids(state.feedReserve.videos)).toEqual(ids(cachedList().slice(5)));

    // Pages 3, 4, 5 come from the reserve — no network.
    const got3 = await fetchFeedPage(3, got2.next_cursor);
    expect(got3.fromReserve).toBe(true);
    expect(ids(got3.videos)).toEqual(ids(cachedList().slice(5, 15)));
    expect(got3.total).toBe(2000);
    expect(got3.next_cursor).toBe(cursorAfter(got3.videos));

    const got4 = await fetchFeedPage(4, got3.next_cursor);
    expect(ids(got4.videos)).toEqual(ids(cachedList().slice(15, 25)));

    const got5 = await fetchFeedPage(5, got4.next_cursor);
    expect(ids(got5.videos)).toEqual(ids(cachedList().slice(25)));  // the short last reserve page
    expect(got5.videos).toHaveLength(5);
    expect(state.feedReserve).toBeNull();                            // drained
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);                  // still just page 2

    // Page 6: the reserve is gone, so back to the server — continuing from
    // after the last served card, not from where the server left off.
    api.fetchFeed.mockReturnValueOnce(serverPage([vid('old1', 50)]));
    const got6 = await fetchFeedPage(6, got5.next_cursor);
    expect(api.fetchFeed).toHaveBeenLastCalledWith(6, CONFIG.PAGE_SIZE, cursorAfter(cachedList()));
    expect(ids(got6.videos)).toEqual(['old1']);
  });

  it('never serves while unreached — a long run of new items keeps paging the server', async () => {
    const newItems = fresh(40);                              // 40 new items: pages 1-4 are all new
    stashFeedReserve(cachedList(), newItems.slice(0, 10));
    let cursor = cursorAfter(newItems.slice(0, 10));
    for (let p = 2; p <= 4; p++) {
      const page = newItems.slice((p - 1) * 10, p * 10);
      api.fetchFeed.mockReturnValueOnce(serverPage(page));
      const got = await fetchFeedPage(p, cursor);
      expect(got.fromReserve).toBeUndefined();
      expect(state.feedReserve.reached).toBe(false);
      expect(state.feedReserve.videos).toHaveLength(30);     // untouched: nothing reached it
      cursor = got.next_cursor;
    }
    expect(api.fetchFeed).toHaveBeenCalledTimes(3);
    // Page 5 reaches: c0..c9 straight from the server; the reserve shrinks to c10..
    api.fetchFeed.mockReturnValueOnce(serverPage(cachedList().slice(0, 10)));
    const got5 = await fetchFeedPage(5, cursor);
    expect(state.feedReserve.reached).toBe(true);
    expect(ids(state.feedReserve.videos)).toEqual(ids(cachedList().slice(10)));
    const got6 = await fetchFeedPage(6, got5.next_cursor);
    expect(got6.fromReserve).toBe(true);
    expect(ids(got6.videos)).toEqual(ids(cachedList().slice(10, 20)));
  });

  it('drops cached cards the server has deleted since (missing from the page that passed them)', async () => {
    stashFeedReserve(cachedList(), fresh(10));
    // c0 and c2 were deleted upstream: page 2 is n10..n14 then c1, c3, c4, c5, c6.
    const page2 = [...fresh(5, 10), ...['c1', 'c3', 'c4', 'c5', 'c6'].map((id) => cachedList().find((v) => v.video_id === id))];
    api.fetchFeed.mockReturnValueOnce(serverPage(page2));
    const got2 = await fetchFeedPage(2, cursorAfter(fresh(10)));
    expect(ids(state.feedReserve.videos)).toEqual(ids(cachedList().slice(7))); // c0, c2 gone; c1..c6 served by the page
    const got3 = await fetchFeedPage(3, got2.next_cursor);
    expect(got3.fromReserve).toBe(true);
    expect(ids(got3.videos)[0]).toBe('c7');
  });

  it('serves only what lies past the cursor, so a page absorbed elsewhere is never repeated', async () => {
    stashFeedReserve(cachedList(), fresh(10));
    state.feedReserve.reached = true;                         // as if a server page had reached it
    const got = await fetchFeedPage(3, cursorAfter(cachedList().slice(0, 12))); // cursor after c11
    expect(ids(got.videos)).toEqual(ids(cachedList().slice(12, 22)));
    expect(api.fetchFeed).not.toHaveBeenCalled();
  });

  it('ignores the reserve in page-offset mode and at the end of the catalog', async () => {
    stashFeedReserve(cachedList(), fresh(10));
    state.feedReserve.reached = true;
    api.fetchFeed.mockReturnValue(serverPage([]));
    await fetchFeedPage(2, '');                                // '' = no cursor: server decides
    await fetchFeedPage(2, undefined);                         // page-offset backend
    expect(api.fetchFeed).toHaveBeenCalledTimes(2);
    expect(api.fetchFeed).toHaveBeenCalledWith(2, CONFIG.PAGE_SIZE, '');
  });

  it('passes server pages through untouched when there is no reserve', async () => {
    const page = fresh(10, 10);
    api.fetchFeed.mockReturnValueOnce(serverPage(page, 123));
    const got = await fetchFeedPage(2, cursorAfter(fresh(10)));
    expect(got.videos).toBe(page);
    expect(got.total).toBe(123);
    expect(state.feedReserve).toBeNull();
  });
});

describe('absorbServerPage', () => {
  it('is a no-op without a reserve or for an empty page', () => {
    absorbServerPage(fresh(3));
    expect(state.feedReserve).toBeNull();
    stashFeedReserve(cachedList(), fresh(10));
    const before = state.feedReserve.videos.length;
    absorbServerPage([]);
    expect(state.feedReserve.videos).toHaveLength(before);
  });

  it('empties out to null once every cached card has been passed', () => {
    stashFeedReserve(cachedList().slice(0, 3), fresh(10));
    absorbServerPage(cachedList().slice(0, 3));
    expect(state.feedReserve).toBeNull();
  });
});

describe('refillPrefetchBuffer reads through the reserve', () => {
  it('buffers reserve pages instantly, without network, once reached', async () => {
    const page1 = fresh(10);
    stashFeedReserve(cachedList(), page1);
    state.feedReserve.reached = true;
    Object.assign(state, { videos: page1, currentPage: 1, nextCursor: cursorAfter(page1), totalVideos: 2000 });

    await refillPrefetchBuffer();
    expect(api.fetchFeed).not.toHaveBeenCalled();
    expect(state.prefetchBuffer).toHaveLength(CONFIG.PREFETCH_PAGES_AHEAD);
    expect(state.prefetchBuffer.map((e) => e.page)).toEqual([2, 3, 4]);
    expect(ids(state.prefetchBuffer[0].videos)).toEqual(ids(cachedList().slice(0, 10)));
    expect(state.prefetchBuffer[2].nextCursor).toBe(cursorAfter(cachedList().slice(0, 30)));
    expect(state.feedReserve).toBeNull(); // all 30 cards buffered
  });
});
