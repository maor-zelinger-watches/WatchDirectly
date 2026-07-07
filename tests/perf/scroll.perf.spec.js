/**
 * PERF: scrolling — the user reads down the feed.
 *
 *  4. Prefetch consumption — buffered pages render on scroll with no network
 *     on the critical path.
 *  5. Sustained scroll smoothness — flicking through many pages produces no
 *     long main-thread blocks and never duplicates a card.
 * 15. Lazy iframe budget — off-screen video embeds don't load, keeping the
 *     initial request count small.
 */

import { test, expect } from '@playwright/test';
import {
  installMocks,
  installLongTaskObserver,
  longTaskStats,
  resetLongTasks,
  makeItems,
  cardIds,
  allUnique,
  scrollToBottom,
  timed,
  sleep,
} from './helpers.js';

test.describe('PERF · scrolling', () => {
  test('T4 buffered page renders on scroll without a live fetch', async ({ page }) => {
    // 60 items / 6 pages. Let the read-ahead buffer (3 pages) fill, then cut
    // the network — the next scroll must still render from the buffer.
    const control = await installMocks(page, { items: makeItems(60) });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    await expect
      .poll(() => control.feedPages.filter((p) => p > 1).length, { timeout: 10000 })
      .toBeGreaterThanOrEqual(3);

    control.feedBlocked = true; // any further fetch would hang forever

    const { ms } = await timed(async () => {
      await scrollToBottom(page);
      await expect
        .poll(() => page.locator('.media-card').count(), { timeout: 3000 })
        .toBeGreaterThanOrEqual(20);
    });
    console.log(`[T4] buffered page rendered in ${ms}ms with the network blocked`);

    // The point: it renders at all with the network cut, so no fetch was on
    // the critical path. The elapsed time is the staggered entrance animation
    // (local work), not I/O.
    expect(ms).toBeLessThan(2200);
    expect(allUnique(await cardIds(page))).toBe(true);
  });

  test('T5 sustained scroll stays smooth (no long tasks, no dupes)', async ({ page }) => {
    await installLongTaskObserver(page);
    const control = await installMocks(page, { items: makeItems(120) }); // 12 pages
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    await resetLongTasks(page); // ignore boot cost; measure the scroll itself

    // Flick through the feed in bursts, the way a user thumbs down a list.
    let count = 0;
    for (let i = 0; i < 12 && count < 80; i++) {
      await page.mouse.wheel(0, 4000);
      await scrollToBottom(page);
      await sleep(350);
      count = await page.locator('.media-card').count();
    }
    console.log(`[T5] scrolled to ${count} cards`);

    const lt = await longTaskStats(page);
    console.log(`[T5] long tasks: count=${lt.count} max=${lt.max}ms total=${lt.total}ms`);

    expect(count).toBeGreaterThanOrEqual(40); // genuinely scrolled a long way
    expect(lt.max).toBeLessThan(300); // no single jank spike stalls a frame badly
    expect(lt.total).toBeLessThan(2500); // cumulative block stays modest over ~80 cards
    expect(allUnique(await cardIds(page))).toBe(true);
  });

  test('T15 lazy iframes: only near-viewport embeds load', async ({ page }) => {
    await installMocks(page, { items: makeItems(60) });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });
    await sleep(400); // let the IntersectionObserver settle

    const stats = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('.media-card iframe'));
      return {
        total: frames.length,
        loaded: frames.filter((f) => f.getAttribute('src')).length,
        pending: frames.filter((f) => f.getAttribute('data-src')).length,
      };
    });
    console.log(`[T15] iframes total=${stats.total} loaded=${stats.loaded} pending=${stats.pending}`);

    // Some embeds are deferred — the whole page's worth is NOT eagerly loaded.
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.loaded).toBeLessThan(stats.total);
    expect(stats.pending).toBeGreaterThan(0);
  });
});
