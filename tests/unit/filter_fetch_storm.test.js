/**
 * Regression test for FE1 — a content-type chip filter must NOT trigger an
 * unbounded page-fetch storm.
 *
 * isFilterActive() deliberately excludes filter.types: the chips are a pure CSS
 * `display:none` visibility filter and must not pause pagination. But when a
 * chip hides EVERY card on a fetched page, that page adds zero height, the
 * load-more sentinel never leaves view, and loadNextPage's rAF retrigger used to
 * re-fire immediately — walking the whole catalog 10 items/page (each iteration
 * also firing a prefetch refill and a full feed-cache re-serialize).
 *
 * The guard (js/config.js FILTER_ZERO_YIELD_MAX_PAGES) tracks consecutive pages
 * that add no card the active type chip leaves visible; after the cap it parks
 * pagination (hides the sentinel, stops the nudge) until the selection changes
 * or the user scrolls with intent. These tests drive loadNextPage as a runaway
 * caller (the role the rAF nudge plays in the browser) and prove the fetch count
 * is bounded, that an unfiltered feed still auto-fills, and that a chip change
 * resumes pagination.
 *
 * Harness mirrors revalidate_race.test.js: every global is stubbed and restored
 * in afterEach so a failing assertion leaves no residue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../../js/config.js';
import { api } from '../../js/api-client.js';

// app.js constructs an IntersectionObserver at module load — stub it first.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

const flush = () => new Promise((r) => setTimeout(r, 0));

let appTest;

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  // Benign default so nothing (prefetchComments, etc.) can hit the real network.
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
  document.body.innerHTML = `
    <div id="feed-container"></div>
    <div id="load-more-container" style="display:none"></div>
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

/** A distinct long-form VIDEO item (11-char id, non-shorts url) per call. */
let idCounter = 0;
function makeVideoPage(size = CONFIG.PAGE_SIZE) {
  const videos = [];
  for (let i = 0; i < size; i++) {
    idCounter++;
    const id = String(idCounter).padStart(11, '0'); // exactly 11 chars => not an article
    videos.push({
      video_id: id,
      url: `https://www.youtube.com/watch?v=${id}`, // no '/shorts/' => not a short
      title: `Video ${id}`,
      channel_name: 'Test Channel',
      published_at: new Date(2026, 0, 1, 0, 0, 0, 1_000_000 - idCounter).toISOString(),
      comment_count: 0,
      vote_count: 0,
    });
  }
  // Non-empty cursor + a huge total so serverHasMore() stays true for many pages:
  // exactly the condition that let the storm run unbounded before the guard.
  return { status: 'ok', videos, total: 100_000, next_cursor: `cursor|${idCounter}` };
}

/** Seed the shared module state to a "page 1 already rendered" baseline. */
function seedFeed(state, types) {
  Object.assign(state, {
    videos: Array.from({ length: CONFIG.PAGE_SIZE }, (_, i) => ({
      video_id: `seed${i}`, url: `https://seed/${i}`, published_at: '2026-01-01T00:00:00Z',
      title: `Seed ${i}`, channel_name: 'Seed', comment_count: 0, vote_count: 0,
    })),
    totalVideos: 100_000, currentPage: 1, hasMore: true,
    loading: false, revalidating: false, initialLoadComplete: true, view: 'latest',
    filter: { query: '', types }, prefetchBuffer: [], prefetching: false,
    prefetchToken: 0, pendingFetchPage: 0, expandedComments: new Set(),
    commentsCache: {}, renderToken: 0, nextCursor: 'cursor|seed',
    filterZeroYieldStreak: 0, topFilterZeroYieldStreak: 0,
  });
}

describe('FE1 — a sparse content-type chip does not fetch-storm the catalog', () => {
  it('parks pagination after FILTER_ZERO_YIELD_MAX_PAGES pages of all-hidden cards', async () => {
    const { state, loadNextPage } = appTest;
    // Only "short" is selected, but every fetched page is long-form video —
    // so every page is entirely hidden by the chip (zero visible yield).
    seedFeed(state, ['short']);
    vi.spyOn(api, 'fetchFeed').mockImplementation(async () => makeVideoPage());

    // Drive loadNextPage far more times than the cap — the role the runaway rAF
    // nudge plays in the browser. The guard must stop it walking the catalog.
    const DRIVE = 40;
    for (let i = 0; i < DRIVE; i++) await loadNextPage();
    await flush();

    const cap = CONFIG.FILTER_ZERO_YIELD_MAX_PAGES;

    // Deterministic bound: currentPage advanced by exactly the cap, then parked —
    // NOT once per catalog page (which would be in the hundreds/thousands here).
    expect(state.currentPage).toBe(1 + cap);
    expect(state.filterZeroYieldStreak).toBe(cap);

    // Fetch count is bounded by the cap + the read-ahead buffer, nowhere near the
    // DRIVE count — proving later calls short-circuited without fetching.
    expect(api.fetchFeed.mock.calls.length).toBeLessThanOrEqual(cap + CONFIG.PREFETCH_PAGES_AHEAD + 2);
    expect(api.fetchFeed.mock.calls.length).toBeLessThan(DRIVE);

    // The sentinel is hidden so no spinner lingers under a parked feed.
    expect(document.getElementById('load-more-container').style.display).toBe('none');
  });

  it('keeps auto-filling an unfiltered ("All") feed — the guard never engages', async () => {
    const { state, loadNextPage } = appTest;
    seedFeed(state, []); // [] === "All": no type chip active, nothing hidden
    vi.spyOn(api, 'fetchFeed').mockImplementation(async () => makeVideoPage());

    const DRIVE = 20;
    for (let i = 0; i < DRIVE; i++) await loadNextPage();
    await flush();

    // Every call advanced a page (no premature park) and the streak stayed put.
    expect(state.currentPage).toBe(1 + DRIVE);
    expect(state.filterZeroYieldStreak).toBe(0);
    // This is the one case here with no early park: it renders + re-serializes
    // all DRIVE pages of real cards, so it does far more work than its siblings.
    // Under parallel CPU load that real work can exceed the 5s default; give it
    // headroom (the assertions above are exact, so a slower run never false-passes).
  }, 30000);

  it('resumes pagination when the chip selection changes (streak reset)', async () => {
    const { state, loadNextPage } = appTest;
    seedFeed(state, ['short']);
    vi.spyOn(api, 'fetchFeed').mockImplementation(async () => makeVideoPage());

    // Walk into the parked state.
    for (let i = 0; i < 40; i++) await loadNextPage();
    await flush();
    const parkedAt = state.currentPage;
    expect(parkedAt).toBe(1 + CONFIG.FILTER_ZERO_YIELD_MAX_PAGES);

    // A chip change is explicit intent: setOnTypeFilterChanged resets the streak.
    // Simulate that reset, then a scroll — pagination must advance again.
    state.filterZeroYieldStreak = 0;
    await loadNextPage();
    await flush();

    expect(state.currentPage).toBe(parkedAt + 1);
  });
});
