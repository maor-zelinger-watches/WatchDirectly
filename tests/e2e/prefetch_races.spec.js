/**
 * E2E regression tests for read-ahead buffer race conditions (mocked API)
 *
 * Each test reproduces a specific interleaving that used to corrupt the
 * feed, using a gated network mock: requests for chosen pages are held
 * and released in a controlled order, so the race is deterministic.
 *
 * Covered bugs (all fixed in js/app.js):
 *   1. Infinite empty-fetch loop when the server total overcounts what
 *      forward pagination can reach.
 *   2. A refill response for the page loadNextPage is direct-fetching
 *      poisoning the buffer head (whole buffer discarded on next scroll).
 *   3. revalidateFeed's pagination reset landing while an on-demand page
 *      fetch is in flight (stale response must be discarded, not applied).
 *   4. A scroll during the revalidate diff's removal-animation window
 *      consuming a buffered page that the diff then clobbers (orphan
 *      out-of-order cards).
 *   5. A grown multi-page cache restored with currentPage=1, prefetching
 *      duplicate pages instead of the genuinely new one.
 */

import { test, expect } from '@playwright/test';

function mockItem(prefix, i) {
  return {
    video_id: `${prefix}_${String(i).padStart(8, '0')}`,
    media_type: 'video',
    channel_name: 'Race Test Channel',
    title: `Video ${prefix} ${i}`,
    url: `https://youtube.com/watch?v=${prefix}_${i}`,
    published_at: new Date(Date.now() - (i + 1) * 60000).toISOString(),
    tier: 'T1',
    category: 'Review',
    comment_count: 0,
  };
}

function makeItems(prefix, count) {
  return Array.from({ length: count }, (_, i) => mockItem(prefix, i));
}

/**
 * Paginated feed mock with per-page request gates.
 *
 * `hold` maps a page number to how many of its first requests to hold:
 * held requests hang until control.release(page) resolves them, FIFO.
 * Requests beyond the hold count pass through immediately.
 */
async function setupGatedFeed(page, { items, total, hold = {} } = {}) {
  const control = {
    requestedPages: [],
    pendingReleases: new Map(), // page -> FIFO of release fns
  };
  const holdsRemaining = new Map(
    Object.entries(hold).map(([p, n]) => [parseInt(p, 10), n])
  );

  control.release = (pg) => {
    const queue = control.pendingReleases.get(pg) || [];
    const fn = queue.shift();
    if (fn) fn();
  };
  control.count = (pg) => control.requestedPages.filter(p => p === pg).length;

  await page.route('**/macros/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');

    if (action === 'feed') {
      const pg = parseInt(url.searchParams.get('page'), 10) || 1;
      const limit = parseInt(url.searchParams.get('limit'), 10) || 10;
      control.requestedPages.push(pg);

      const remaining = holdsRemaining.get(pg) || 0;
      if (remaining > 0) {
        holdsRemaining.set(pg, remaining - 1);
        await new Promise(resolve => {
          const queue = control.pendingReleases.get(pg) || [];
          queue.push(resolve);
          control.pendingReleases.set(pg, queue);
        });
      }

      const start = (pg - 1) * limit;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          total,
          page: pg,
          videos: items.slice(start, start + limit),
        }),
      });
    }

    if (action === 'commentsBatch') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', byVideo: {} }) });
    }
    if (action === 'comments') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });

  return control;
}

async function cardIds(page) {
  return page.locator('.media-card[data-video-id]').evaluateAll(
    cards => cards.map(c => c.dataset.videoId)
  );
}

async function expectNoDuplicateCards(page) {
  const ids = await cardIds(page);
  expect(ids.length).toBe(new Set(ids).size);
}

test.describe('Prefetch race regressions', () => {

  test('bug 1: overcounted server total does not cause an endless empty-fetch loop', async ({ page }) => {
    // Server claims 65 items but forward pagination only reaches 60 —
    // pages 7+ return {videos: [], total: 65}. The feed must terminate.
    const control = await setupGatedFeed(page, { items: makeItems('fresh', 60), total: 65 });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    // Scroll through the whole catalog (staggered card entries need patience)
    let count = 0;
    for (let attempts = 0; count < 60 && attempts < 20; attempts++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
      count = await page.locator('.media-card').count();
    }
    await expect(page.locator('.media-card')).toHaveCount(60);

    // Keep the sentinel area in view — the old bug's rAF retrigger loop
    // fired unbounded requests from exactly this position.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const requestsAfterFullScroll = control.requestedPages.length;
    await page.waitForTimeout(2000);
    expect(control.requestedPages.length).toBe(requestsAfterFullScroll);

    // The empty page 7 was probed at most twice (refill clamp + at most
    // one on-demand miss); nothing past it was ever requested.
    expect(control.count(7)).toBeLessThanOrEqual(2);
    expect(Math.max(...control.requestedPages)).toBeLessThanOrEqual(7);

    // End of feed: sentinel hidden, no duplicates
    await expect(page.locator('#load-more-container')).toBeHidden();
    await expectNoDuplicateCards(page);
  });

  test('bug 2: refill response for the page being direct-fetched does not poison the buffer', async ({ page }) => {
    // Hold the first two page-2 requests: the refill's (fires right after
    // the initial load) and the on-demand fetch (fires when the user
    // outscrolls the still-empty buffer). Land the refill's FIRST — the
    // exact ordering that used to push {page: 2} as a stale buffer head.
    const control = await setupGatedFeed(page, {
      items: makeItems('fresh', 60), total: 60, hold: { 2: 2 },
    });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    // Refill's page-2 request is now held; buffer stays empty
    await expect.poll(() => control.count(2)).toBe(1);

    // Outscroll the empty buffer -> loadNextPage direct-fetches page 2
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => control.count(2)).toBe(2);

    // Land the REFILL's response first. Fixed code discards it (the page
    // is pending on-demand) and moves on to buffer pages 3-5.
    control.release(2);
    await expect.poll(() => control.count(3) + control.count(4) + control.count(5), {
      timeout: 10000,
    }).toBe(3);

    // Now land the on-demand response — page 2 renders
    control.release(2);
    await expect(page.locator('.media-card')).toHaveCount(20);

    // Next scroll must consume the buffered page 3 instantly. The old bug
    // discarded the whole buffer here and re-fetched pages 3-5.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(30);
    expect(control.count(3)).toBe(1);
    expect(control.count(4)).toBe(1);

    const ids = await cardIds(page);
    expect(ids).toEqual(makeItems('fresh', 30).map(v => v.video_id));
  });

  test('bug 3: revalidation pagination reset discards the in-flight on-demand response', async ({ page }) => {
    // Cached cold-start with content that changed server-side. Hold the
    // revalidate (page 1) and the on-demand page-2 fetch; land the
    // pagination reset first, then the stale page-2 response mid-diff.
    const staleItems = makeItems('stale', 10);
    const control = await setupGatedFeed(page, {
      items: makeItems('fresh', 60), total: 60, hold: { 1: 1, 2: 1 },
    });
    await page.addInitScript((cache) => {
      window.localStorage.clear();
      window.localStorage.setItem('wd_feed_cache', JSON.stringify(cache));
    }, { videos: staleItems, total: 60 });

    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    // Scroll while the revalidate is still in flight -> on-demand page 2
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => control.count(2)).toBe(1);

    // Land the revalidate: content differs, the diff starts (all stale
    // cards animate out) and the pagination resets to fresh page 1.
    // (Wait for the request first — releasing before it arrives is a no-op
    // and would leave the revalidate held forever.)
    await expect.poll(() => control.count(1)).toBe(1);
    control.release(1);
    await expect(page.locator('.media-card--leaving').first()).toBeVisible();

    // Land the stale page-2 response mid-diff. Fixed code discards it
    // (prefetch epoch changed); the old code appended it into state the
    // diff then clobbered, leaving duplicate cards on the next scroll.
    control.release(2);

    // Diff settles: every stale card leaves, and what's rendered is a
    // clean prefix of the fresh feed. (The viewport sits at the bottom, so
    // pagination may legitimately auto-continue into fresh page 2 — assert
    // the prefix, not a frozen count.)
    await expect(page.locator('.media-card--leaving')).toHaveCount(0);
    const afterDiff = await cardIds(page);
    expect(afterDiff.length).toBeGreaterThanOrEqual(10);
    expect(afterDiff).toEqual(makeItems('fresh', afterDiff.length).map(v => v.video_id));

    // The feed continues into fresh page 2 — not skipped, not duplicated
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(20);
    const ids = await cardIds(page);
    expect(ids).toEqual(makeItems('fresh', 20).map(v => v.video_id));
  });

  test('bug 4: a scroll during the revalidate diff cannot consume and orphan a buffered page', async ({ page }) => {
    // Cached start with stale content; grow the feed and fill the buffer
    // BEFORE the revalidate lands, then scroll hard during the diff's
    // removal-animation window. The old bug consumed buffered page 3
    // mid-diff and left its cards orphaned out of order.
    const staleItems = makeItems('stale', 10);
    const control = await setupGatedFeed(page, {
      items: makeItems('fresh', 60), total: 60, hold: { 1: 1 },
    });
    await page.addInitScript((cache) => {
      window.localStorage.clear();
      window.localStorage.setItem('wd_feed_cache', JSON.stringify(cache));
    }, { videos: staleItems, total: 60 });

    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    // Grow the feed (on-demand page 2) — its finally kicks off the refill,
    // so pages 3-5 land in the buffer while the revalidate is still held.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(20);
    await expect.poll(() => control.count(3) + control.count(4) + control.count(5), {
      timeout: 10000,
    }).toBe(3);

    // Land the revalidate: every rendered card is stale or beyond fresh
    // page 1, so the diff animates out most of the feed — a wide window.
    // (Wait for the request first — releasing before it arrives is a no-op
    // and would leave the revalidate held forever.)
    await expect.poll(() => control.count(1)).toBe(1);
    control.release(1);
    await expect(page.locator('.media-card--leaving').first()).toBeVisible();

    // Hammer scroll during the removal window — the observer fires, but
    // pagination must stay paused while the diff owns the container.
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(60);
    }

    // The diff settles with no orphaned page-3 cards: everything rendered
    // is a clean prefix of the fresh feed. (The viewport sits at the
    // bottom, so pagination may legitimately auto-continue into fresh
    // page 2 — assert the prefix, not a frozen count.)
    await expect(page.locator('.media-card--leaving')).toHaveCount(0, { timeout: 10000 });
    const afterDiff = await cardIds(page);
    expect(afterDiff.length).toBeGreaterThanOrEqual(10);
    expect(afterDiff).toEqual(makeItems('fresh', afterDiff.length).map(v => v.video_id));

    // Pagination resumes cleanly into fresh page 2 and beyond. How far the
    // feed auto-fills depends on the pinned-at-bottom viewport height, so this
    // asserts the invariant the test actually guards — no orphaned or
    // out-of-order buffered page — rather than a brittle fixed count: whatever
    // is rendered is always an in-order, duplicate-free prefix of the fresh
    // feed, and it did advance past fresh page 1.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(async () => (await cardIds(page)).length).toBeGreaterThanOrEqual(20);
    const ids = await cardIds(page);
    expect(ids).toEqual(makeItems('fresh', ids.length).map(v => v.video_id));
    await expectNoDuplicateCards(page);
  });

  test('bug 5: a grown multi-page cache resumes from its real page, not page 1', async ({ page }) => {
    // The cache legitimately grows past page 1 (vote/comment updates
    // persist the whole feed). Restoring 40 items must resume pagination
    // at page 5 — the old code re-fetched pages 2-4 as pure duplicates.
    const items = makeItems('fresh', 60);
    const control = await setupGatedFeed(page, {
      items, total: 60, hold: { 1: 1 }, // hold the revalidate — this tests the cached window
    });
    await page.addInitScript((cache) => {
      window.localStorage.clear();
      window.localStorage.setItem('wd_feed_cache', JSON.stringify(cache));
    }, { videos: items.slice(0, 40), total: 60 });

    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(40);

    // Scroll: the next content is page 5. Pages 2-4 must never be fetched.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(50);

    const nonRevalidatePages = control.requestedPages.filter(p => p !== 1);
    expect(nonRevalidatePages[0]).toBe(5);
    expect(nonRevalidatePages).not.toContain(2);
    expect(nonRevalidatePages).not.toContain(3);
    expect(nonRevalidatePages).not.toContain(4);

    // The refill grabs the final page 6; the next scroll drains it
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(60);
    const ids = await cardIds(page);
    expect(ids).toEqual(items.map(v => v.video_id));
    await expectNoDuplicateCards(page);
  });
});
