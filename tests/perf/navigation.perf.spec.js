/**
 * PERF: navigation — the user moves around.
 *
 * 10. Tab switch — Latest -> Top -> Latest; Top loads once, returning to
 *     Latest is instant and resets scroll.
 * 11. Expand to fullscreen and back — the CSS overlay opens/closes fast and
 *     re-anchors to the same card on exit.
 * 12. Open an article and return — leaving to a new tab must not disturb the
 *     feed tab's state or trigger a refetch on refocus.
 */

import { test, expect } from '@playwright/test';
import { installMocks, makeItems, timed, sleep } from './helpers.js';

const tab = (page, label) => page.locator('.feed-tab', { hasText: label });

test.describe('PERF · navigation', () => {
  test('T10 tab switch Latest -> Top -> Latest', async ({ page }) => {
    const control = await installMocks(page, { items: makeItems(60), topWeek: makeItems(12) });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    // Scroll down so we can later prove the return to Latest resets to top.
    await page.evaluate(() => window.scrollTo(0, 1200));
    await sleep(150);

    const toTop = await timed(async () => {
      await tab(page, 'Top This Week').click();
      await expect(tab(page, 'Top This Week')).toHaveClass(/feed-tab--active/);
      await expect(page.locator('.media-card').first()).toBeVisible();
    });
    console.log(`[T10] Latest -> Top in ${toTop.ms}ms (topWeek requests: ${control.topRequests})`);
    expect(toTop.ms).toBeLessThan(2000);
    expect(control.topRequests).toBe(1); // fetched once

    const backToLatest = await timed(async () => {
      await tab(page, 'Latest').click();
      await expect(tab(page, 'Latest')).toHaveClass(/feed-tab--active/);
      await expect(page.locator('.media-card').first()).toBeVisible();
    });
    console.log(`[T10] Top -> Latest in ${backToLatest.ms}ms`);

    // Returning to Latest comes from memory — fast, and scrolled back to top.
    expect(backToLatest.ms).toBeLessThan(1000);
    expect(control.topRequests).toBe(1); // Top not refetched on return
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeLessThan(50);
  });

  test('T11 expand to fullscreen and back', async ({ page }) => {
    await installMocks(page, { items: makeItems(20) });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    const target = page.locator('.media-card').nth(3);
    await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const topBefore = await target.evaluate((el) => el.getBoundingClientRect().top);

    const enter = await timed(async () => {
      await target.locator('.media-card__expand').click();
      await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);
      await expect(target).toHaveClass(/media-card--fullscreen/);
    });
    console.log(`[T11] enter fullscreen in ${enter.ms}ms`);
    expect(enter.ms).toBeLessThan(600);

    // Fullscreen force-loads the embed so the video is ready immediately.
    // (Scoped to the embed — the fullscreen comments' auth prompt can inject
    // a Google Sign-In iframe into the same card.)
    await expect(target.locator('.media-card__embed iframe')).toHaveAttribute('src', /.+/);

    const exit = await timed(async () => {
      await page.keyboard.press('Escape');
      await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    });
    console.log(`[T11] exit fullscreen in ${exit.ms}ms`);
    expect(exit.ms).toBeLessThan(500);

    // Re-anchored to the same card (within a small tolerance).
    const topAfter = await target.evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(80);
  });

  test('T12 open an article in a new tab and return with state intact', async ({ page, context }) => {
    // Make item 0 an article so the title link opens externally.
    const items = makeItems(30, (i) => (i === 0 ? 'article' : 'video'));
    const control = await installMocks(page, { items });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    // Scroll partway and record the state we expect to survive the round-trip.
    await page.evaluate(() => window.scrollTo(0, 900));
    await sleep(150);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const cardsBefore = await page.locator('.media-card').count();
    const reqBefore = control.requests.length;

    // Click the article's title link — opens in a new tab.
    const link = page.locator('.media-card').first().locator('.media-card__title a');
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      link.click(),
    ]);
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    await newPage.close(); // user reads, then closes the tab

    await page.bringToFront();
    await sleep(300); // give any (unwanted) refocus refetch a chance to fire

    const scrollAfter = await page.evaluate(() => window.scrollY);
    const cardsAfter = await page.locator('.media-card').count();
    console.log(
      `[T12] scroll ${scrollBefore}->${scrollAfter}, cards ${cardsBefore}->${cardsAfter}, ` +
        `feed requests ${reqBefore}->${control.requests.length}`
    );

    // The perf-relevant guarantee: opening an external article in a new tab
    // is a no-op for the feed — it stays fully rendered and issues NO refetch
    // on return. (Scroll-restoration across an OS tab switch is browser
    // behavior, not something the feed drives, so it isn't asserted here.)
    expect(cardsAfter).toBe(cardsBefore); // feed still fully rendered
    expect(control.requests.length).toBe(reqBefore); // zero refetch on return
  });
});
