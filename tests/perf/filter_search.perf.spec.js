/**
 * PERF: filtering & search — the user narrows the feed.
 *
 *  6. Type-chip toggle — a pure CSS visibility filter: instant, no refetch,
 *     no re-render (same DOM nodes stay put).
 *  7. Filtered-feed top-up — a sparse type pulls more pages in the background
 *     without freezing the main thread.
 *  8. Search first keystroke — typing a query returns results promptly
 *     (debounce + filter), and keystrokes never block.
 *  9. Progressive search — partial results paint before the full 5000-item
 *     index finishes building, and the render is capped.
 */

import { test, expect } from '@playwright/test';
import {
  installMocks,
  installLongTaskObserver,
  longTaskStats,
  resetLongTasks,
  makeItems,
  cardIds,
  scrollToBottom,
  sleep,
  SEARCH_RENDER_LIMIT,
} from './helpers.js';

const chip = (page, label) =>
  page.locator('#category-chips .chip', { hasText: new RegExp(`^${label}$`) });
const visibleCards = (page) => page.locator('.media-card:visible');

// Video-dominant catalog: 60% video so toggling Videos stays well above the
// 20-item top-up threshold and the toggle is a pure CSS filter (no refetch).
const mostlyVideo = (i) => (i % 5 === 0 ? 'article' : i % 5 === 1 ? 'short' : 'video');

test.describe('PERF · filter & search', () => {
  test('T6 type-chip toggle is instant and re-renders nothing', async ({ page }) => {
    const control = await installMocks(page, { items: makeItems(60, mostlyVideo) });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    // Scroll so a large batch is rendered — the toggle must stay instant even
    // with lots of cards on the page.
    let count = 0;
    for (let i = 0; i < 8 && count < 40; i++) {
      await scrollToBottom(page);
      await sleep(300);
      count = await page.locator('.media-card').count();
    }

    const idsBefore = await cardIds(page);
    const reqBefore = control.requests.length;

    // Real click, real user-perceived latency: the filter must be visibly
    // applied (articles/shorts hidden) within budget. Pure CSS visibility
    // filter — must feel instant; the 1500ms timeout IS the budget.
    await chip(page, 'Videos').click();
    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/, { timeout: 1500 });
    await expect(page.locator('#feed-container')).toHaveClass(/feed--hide-article/, { timeout: 1500 });

    // Invariant: nothing re-rendered and no fetch fired by the toggle.
    const idsAfter = await cardIds(page);
    expect(idsAfter).toEqual(idsBefore); // same nodes, same order
    expect(control.requests.length).toBe(reqBefore); // zero network from the click

    // And it actually filtered: only videos visible.
    const visible = await visibleCards(page).count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(idsBefore.length);
  });

  test('T7 sparse-type top-up fills in the background without jank', async ({ page }) => {
    await installLongTaskObserver(page);
    // 30 items, ~2 articles per 10 -> 6 articles total, under the 20 threshold,
    // so selecting Articles pulls every page the backend has.
    const items = makeItems(30, (i) => (i % 10 === 2 || i % 10 === 7 ? 'article' : 'video'));
    await installMocks(page, { items });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    await resetLongTasks(page);

    await chip(page, 'Articles').click();
    // Top-up pulls pages 2 & 3; all 6 articles become visible within budget.
    await expect(visibleCards(page)).toHaveCount(6, { timeout: 4000 });

    const lt = await longTaskStats(page);
    console.log(`[T7] long tasks during top-up: max=${lt.max}ms total=${lt.total}ms`);

    expect(lt.max).toBeLessThan(250); // background pulls don't freeze the UI
  });

  test('T8 search first keystroke returns results promptly', async ({ page }) => {
    await installMocks(page, { items: makeItems(60) });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    // Focus warms the index; then type a query that matches a subset.
    await page.locator('#search-input').focus();
    await sleep(150);

    // 120ms debounce + filter work — comfortably under a second. The filtered
    // render replaces the feed with matches; the 1000ms timeout IS the budget.
    await page.fill('#search-input', 'Rolex');
    await expect(page.locator('.media-card:visible').first()).toBeVisible({ timeout: 1000 });

    // It's a real filter, not the whole feed: a nonsense query empties it.
    await page.fill('#search-input', 'zzzznomatchqq');
    await expect(page.locator('#feed-empty')).toBeVisible({ timeout: 2000 });
  });

  test('T9 progressive search paints before the index finishes; render capped', async ({ page }) => {
    // 1500 items => 3 index chunks of 500, each 200ms slow. Every title
    // contains "deep dive", so the query matches the whole catalog and the
    // render must cap at SEARCH_RENDER_LIMIT.
    const control = await installMocks(page, {
      items: makeItems(1500),
      chunkDelay: 200,
    });
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    await page.locator('#search-input').focus();

    // Partial results paint quickly — before all three chunks have landed.
    // The 2000ms timeout IS the budget.
    await page.fill('#search-input', 'deep');
    await expect(page.locator('.media-card:visible').first()).toBeVisible({ timeout: 2000 });

    // The full index eventually builds (all chunks requested).
    await expect
      .poll(() => new Set(control.chunkPages).size, { timeout: 8000 })
      .toBeGreaterThanOrEqual(3);

    // Broad match, but the render is capped so the page never freezes.
    const rendered = await page.locator('.media-card').count();
    console.log(`[T9] rendered ${rendered} cards (cap ${SEARCH_RENDER_LIMIT})`);
    expect(rendered).toBeLessThanOrEqual(SEARCH_RENDER_LIMIT);
  });
});
