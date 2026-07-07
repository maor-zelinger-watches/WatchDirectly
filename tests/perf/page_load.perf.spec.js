/**
 * PERF: page load — the first thing a user does.
 *
 *  1. Cold first paint   — brand-new visitor, empty cache, real network wait.
 *  2. Warm reload        — returning visitor paints from cache before network.
 *  3. Revalidation is non-blocking — a slow background page-1 refresh must
 *     never stall scrolling/pagination (the core stale-while-revalidate
 *     contract; see memory: feed-revalidation-model).
 */

import { test, expect } from '@playwright/test';
import {
  installMocks,
  installLongTaskObserver,
  paintMetrics,
  timed,
  makeItems,
  cardIds,
  allUnique,
  scrollToBottom,
  sleep,
} from './helpers.js';

test.describe('PERF · page load', () => {
  test('T1 cold first paint — first card visible under budget', async ({ page }) => {
    // Realistic ~300ms backend latency, empty cache.
    await installLongTaskObserver(page);
    await installMocks(page, { items: makeItems(60), feedDelay: 300 });

    const { ms } = await timed(async () => {
      await page.goto('/', { waitUntil: 'commit' });
      await page.locator('.media-card').first().waitFor({ state: 'visible' });
    });
    console.log(`[T1] first card visible: ${ms}ms`);

    const paint = await paintMetrics(page);
    console.log(`[T1] FCP=${paint.fcp}ms LCP=${paint.lcp}ms`);

    // The in-page paint timeline is the trustworthy "first card painted"
    // signal (wall-clock also carries goto/polling overhead). With a 300ms
    // API round-trip the largest card must still paint fast.
    expect(paint.fcp).toBeLessThan(1500);
    expect(paint.lcp).toBeLessThan(2500);
    // Loose wall-clock backstop: two 300ms page-1 fetches + render.
    expect(ms).toBeLessThan(3500);
  });

  test('T2 warm reload — cache paints before the network responds', async ({ page }) => {
    // First visit warms wd_feed_cache; don't clear storage between loads.
    const control = await installMocks(page, { items: makeItems(60), clearStorage: false });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(PAGE_SIZE_HINT, { timeout: 10000 });

    // Now hang EVERY feed fetch. A reload that still shows cards proves the
    // paint came from cache, not the network.
    control.feedBlocked = true;
    control.feedPages.length = 0;

    const { ms } = await timed(async () => {
      await page.reload({ waitUntil: 'commit' });
      await page.locator('.media-card').first().waitFor({ state: 'visible' });
    });
    console.log(`[T2] cached first card: ${ms}ms, feed requests completed after reload: 0 (all blocked)`);

    // Cache paint is local work — must be fast and must not need the network.
    expect(ms).toBeLessThan(1500);
    await expect(page.locator('.media-card').first()).toBeVisible();
  });

  test('T3 revalidation never blocks pagination', async ({ page }) => {
    // Warm cache first, then reload with a 3s-slow page-1 revalidation while
    // pages 2+ stay instant. Scrolling must append fresh pages long before
    // the revalidation completes.
    const control = await installMocks(page, {
      items: makeItems(60),
      clearStorage: false,
      feedDelay: (pg) => (pg === 1 ? 3000 : 0), // only the revalidate page is slow
    });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(PAGE_SIZE_HINT, { timeout: 10000 });

    await page.reload();
    await expect(page.locator('.media-card')).toHaveCount(PAGE_SIZE_HINT, { timeout: 10000 });

    // Kick pagination while the 3s page-1 refresh is still in flight. A
    // bottom-pinned scroll auto-fills a *variable* number of pages, so assert
    // the invariant (>= 20, duplicate-free) not an exact count.
    const { ms } = await timed(async () => {
      await scrollToBottom(page);
      await expect
        .poll(() => page.locator('.media-card').count(), { timeout: 2500 })
        .toBeGreaterThanOrEqual(20);
    });
    console.log(`[T3] page-2 appended in ${ms}ms while a 3s revalidation was in flight`);

    // Well under the 3s revalidation — pagination did not wait for it.
    expect(ms).toBeLessThan(2000);

    const ids = await cardIds(page);
    expect(allUnique(ids)).toBe(true); // no duplicates slipped in during the race
  });
});

// Initial render is adaptive (N+1 then remainder). On both viewports the
// mocked page-1 settles at PAGE_SIZE cards.
const PAGE_SIZE_HINT = 10;
