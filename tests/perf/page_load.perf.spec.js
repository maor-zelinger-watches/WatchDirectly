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
  makeItems,
  cardIds,
  allUnique,
  scrollToBottom,
} from './helpers.js';

test.describe('PERF · page load', () => {
  test('T1 cold first paint — first card visible under budget', async ({ page }) => {
    // Realistic ~300ms backend latency, empty cache.
    await installLongTaskObserver(page);
    await installMocks(page, { items: makeItems(60), feedDelay: 300 });

    await page.goto('/', { waitUntil: 'commit' });
    // Loose backstop: two 300ms page-1 fetches + render. The timeout IS the budget.
    await expect(page.locator('.media-card').first()).toBeVisible({ timeout: 3500 });

    const paint = await paintMetrics(page);
    console.log(`[T1] FCP=${paint.fcp}ms LCP=${paint.lcp}ms`);

    // The in-page paint timeline is the trustworthy "first card painted"
    // signal. With a 300ms API round-trip the largest card must still paint fast.
    expect(paint.fcp).toBeLessThan(1500);
    expect(paint.lcp).toBeLessThan(2500);
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

    // Cache paint is local work — must be fast and must not need the network.
    // A card visible within 1500ms while every fetch hangs proves the paint
    // came from cache. The timeout IS the budget.
    await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('.media-card').first()).toBeVisible({ timeout: 1500 });
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
    // Kick pagination: the 20th card must render within 2000ms — well under
    // the 3s revalidation, proving pagination did not wait for it. The timeout
    // IS the budget.
    await scrollToBottom(page);
    await expect(page.locator('.media-card').nth(19)).toBeVisible({ timeout: 2000 });

    const ids = await cardIds(page);
    expect(allUnique(ids)).toBe(true); // no duplicates slipped in during the race
  });
});

// Initial render is adaptive (N+1 then remainder). On both viewports the
// mocked page-1 settles at PAGE_SIZE cards.
const PAGE_SIZE_HINT = 10;
