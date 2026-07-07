/**
 * Unit tests for js/prefetch.js — the read-ahead buffer and pagination
 * cursor math, extracted from app.js.
 *
 * The api client singleton is mocked at the module boundary so the refill
 * loop can be driven page by page, including mid-flight races (pagination
 * resets, pages consumed while a fetch is airborne) that the e2e specs
 * can only reach indirectly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../js/api-client.js', () => ({
  api: { fetchFeed: vi.fn() },
}));

import { api } from '../../js/api-client.js';
import { state } from '../../js/state.js';
import {
  bufferedVideoCount,
  serverHasMore,
  cursorAfter,
  invalidatePrefetchBuffer,
  takeBufferedPage,
  refillPrefetchBuffer,
} from '../../js/prefetch.js';

/** Ten unique videos for `page`, so dedupe never kicks in across pages. */
function mkPage(page) {
  return Array.from({ length: 10 }, (_, i) => ({
    video_id: `p${page}v${i}`,
    published_at: '2026-01-01T00:00:00Z',
  }));
}

/** Reset the shared module state to a "page 1 rendered" baseline. */
function resetState(overrides = {}) {
  Object.assign(state, {
    videos: mkPage(1),
    currentPage: 1,
    totalVideos: 100,
    nextCursor: undefined,
    loading: false,
    hasMore: true,
    initialLoadComplete: true,
    view: 'latest',
    filter: { query: '', types: [] },
    prefetchBuffer: [],
    prefetching: false,
    prefetchToken: 0,
    pendingFetchPage: 0,
  }, overrides);
}

beforeEach(() => {
  api.fetchFeed.mockReset();
  document.body.innerHTML = '<div id="load-more-container"></div>';
  resetState();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('cursorAfter', () => {
  it('returns undefined for an empty or missing list', () => {
    expect(cursorAfter([])).toBeUndefined();
    expect(cursorAfter(null)).toBeUndefined();
  });

  it('returns undefined when the last item has no video_id', () => {
    expect(cursorAfter([{ published_at: '2026-01-01T00:00:00Z' }])).toBeUndefined();
  });

  it('derives the backend cursor format from the last item', () => {
    const videos = [
      { video_id: 'a', published_at: '2026-01-03T00:00:00Z' },
      { video_id: 'b', published_at: '2026-01-02T12:30:00Z' },
    ];
    expect(cursorAfter(videos)).toBe('2026-01-02T12:30:00.000Z|b');
  });

  it('clamps an unparseable date to the epoch instead of producing an invalid cursor', () => {
    const videos = [{ video_id: 'x', published_at: 'not-a-date' }];
    expect(cursorAfter(videos)).toBe('1970-01-01T00:00:00.000Z|x');
  });
});

describe('serverHasMore', () => {
  it('trusts a non-empty cursor over the count math', () => {
    resetState({ nextCursor: '2026-01-01T00:00:00.000Z|z', totalVideos: 10 }); // counts say done
    expect(serverHasMore()).toBe(true);
  });

  it('treats the empty cursor as end-of-catalog even when counts disagree', () => {
    resetState({ nextCursor: '', totalVideos: 100 });
    expect(serverHasMore()).toBe(false);
  });

  it('falls back to count math when the backend has no cursors', () => {
    resetState({ nextCursor: undefined, totalVideos: 100 });
    expect(serverHasMore()).toBe(true);
    state.totalVideos = state.videos.length;
    expect(serverHasMore()).toBe(false);
  });
});

describe('takeBufferedPage', () => {
  it('returns null on an empty buffer', () => {
    expect(takeBufferedPage(2)).toBeNull();
  });

  it('pops the head entry when it matches the requested page', () => {
    const entry = { page: 2, videos: mkPage(2), nextCursor: 'c2' };
    state.prefetchBuffer = [entry, { page: 3, videos: mkPage(3), nextCursor: 'c3' }];

    expect(takeBufferedPage(2)).toBe(entry);
    expect(state.prefetchBuffer.map(e => e.page)).toEqual([3]);
  });

  it('discards the whole buffer and bumps the token on a head mismatch', () => {
    state.prefetchBuffer = [{ page: 3, videos: mkPage(3), nextCursor: 'c3' }];
    const tokenBefore = state.prefetchToken;

    expect(takeBufferedPage(2)).toBeNull();
    expect(state.prefetchBuffer).toEqual([]);
    expect(state.prefetchToken).toBe(tokenBefore + 1);
  });
});

describe('refillPrefetchBuffer', () => {
  it('fills the buffer with contiguous pages up to PREFETCH_PAGES_AHEAD', async () => {
    api.fetchFeed.mockImplementation((page) =>
      Promise.resolve({ videos: mkPage(page), total: 100, next_cursor: `c${page}` }));

    await refillPrefetchBuffer();

    expect(state.prefetchBuffer.map(e => e.page)).toEqual([2, 3, 4]);
    expect(bufferedVideoCount()).toBe(30);
    // Each fetch continues from the previous page's cursor
    expect(api.fetchFeed.mock.calls.map(c => c[2])).toEqual(['', 'c2', 'c3']);
  });

  it('does nothing before the initial load or while another refill runs', async () => {
    resetState({ initialLoadComplete: false });
    await refillPrefetchBuffer();

    resetState({ prefetching: true });
    await refillPrefetchBuffer();

    expect(api.fetchFeed).not.toHaveBeenCalled();
  });

  it('stops at an empty page and clamps the total to what is reachable', async () => {
    api.fetchFeed
      .mockResolvedValueOnce({ videos: mkPage(2).slice(0, 5), total: 100, next_cursor: 'c2' })
      .mockResolvedValueOnce({ videos: [], total: 100, next_cursor: '' });

    await refillPrefetchBuffer();

    // The 5 buffered videos stay drainable; the overcounted server total is clamped
    expect(state.prefetchBuffer.map(e => e.page)).toEqual([2]);
    expect(state.totalVideos).toBe(15);
    expect(state.hasMore).toBe(true);
  });

  it('marks the feed exhausted and hides the sentinel when the end is confirmed with nothing buffered', async () => {
    api.fetchFeed.mockResolvedValue({ videos: [], total: 100, next_cursor: '' });

    await refillPrefetchBuffer();

    expect(state.prefetchBuffer).toEqual([]);
    expect(state.totalVideos).toBe(state.videos.length);
    expect(state.hasMore).toBe(false);
    expect(state.nextCursor).toBe('');
    expect(document.getElementById('load-more-container').style.display).toBe('none');
  });

  it('discards an in-flight response after a pagination reset (token bump)', async () => {
    let resolveFetch;
    api.fetchFeed.mockImplementation(() => new Promise(r => { resolveFetch = r; }));

    const pending = refillPrefetchBuffer();

    // Revalidation resets pagination while the page-2 fetch is airborne;
    // leave nothing to prefetch so the finally-block re-run stays idle.
    invalidatePrefetchBuffer();
    state.totalVideos = state.videos.length;

    resolveFetch({ videos: mkPage(2), total: 100, next_cursor: 'c2' });
    await pending;

    expect(state.prefetchBuffer).toEqual([]);
    expect(api.fetchFeed).toHaveBeenCalledTimes(1);
  });

  it('drops a response that no longer extends the buffer contiguously and recomputes', async () => {
    let resolveFirst;
    api.fetchFeed
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
      .mockImplementation((page) =>
        Promise.resolve({ videos: mkPage(page), total: 100, next_cursor: undefined }));

    const pending = refillPrefetchBuffer();

    // The user outscrolled the buffer: loadNextPage direct-fetched page 2
    // and advanced currentPage while our page-2 refill was in flight.
    state.currentPage = 2;
    state.videos = state.videos.concat(mkPage(2));
    resolveFirst({ videos: mkPage(2), total: 100, next_cursor: undefined });
    await pending;

    // Page 2 was discarded, not pushed; the loop resumed after currentPage.
    expect(state.prefetchBuffer.map(e => e.page)).toEqual([3, 4, 5]);
  });

  it('will not leapfrog a page loadNextPage is direct-fetching in cursor mode', async () => {
    resetState({ nextCursor: 'c1', pendingFetchPage: 2 });

    await refillPrefetchBuffer();

    expect(api.fetchFeed).not.toHaveBeenCalled();
    expect(state.prefetching).toBe(false);
  });
});
