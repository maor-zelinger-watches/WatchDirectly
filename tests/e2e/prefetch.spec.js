/**
 * E2E tests for the read-ahead buffer (mocked API)
 *
 * The Latest feed keeps PREFETCH_PAGES_AHEAD (3) pages fetched beyond
 * what's rendered: pages 2-4 load in the background right after the
 * initial render, scrolling consumes them with zero network wait, and
 * each consumed page triggers a refill request to stay 3 ahead.
 */

import { test, expect } from '@playwright/test';

function mockItem(id, minutesAgo) {
  return {
    video_id: id,
    media_type: 'video',
    channel_name: 'Prefetch Test Channel',
    title: `Video ${id}`,
    url: `https://youtube.com/watch?v=${id}`,
    published_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    tier: 'T1',
    category: 'Review',
    comment_count: 0,
  };
}

// 60 items = 6 pages at PAGE_SIZE=10
const ALL_ITEMS = Array.from({ length: 60 }, (_, i) =>
  mockItem(`pf_${String(i).padStart(8, '0')}`, i + 1)
);

/**
 * Paginated feed mock that records every requested feed page and can be
 * switched to "blocked" mode, where feed requests hang forever — proving
 * that renders after that point came from the buffer, not the network.
 */
async function setupPaginatedFeed(page) {
  const control = { requestedPages: [], blocked: false };

  await page.addInitScript(() => window.localStorage.clear());

  await page.route('**/macros/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');

    if (action === 'feed') {
      const pg = parseInt(url.searchParams.get('page'), 10) || 1;
      const limit = parseInt(url.searchParams.get('limit'), 10) || 10;
      control.requestedPages.push(pg);

      if (control.blocked) return; // leave the request hanging

      const start = (pg - 1) * limit;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          total: ALL_ITEMS.length,
          page: pg,
          videos: ALL_ITEMS.slice(start, start + limit),
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

test.describe('Read-ahead buffer', () => {
  test('fetches 3 pages ahead in the background, without scrolling', async ({ page }) => {
    const control = await setupPaginatedFeed(page);
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    // Pages 2-4 arrive in the background; page 5 must NOT be fetched yet
    await expect.poll(() => control.requestedPages.filter(p => p > 1).sort().join(','), {
      timeout: 10000,
    }).toBe('2,3,4');

    // ...and nothing was rendered from them
    await expect(page.locator('.media-card')).toHaveCount(10);
  });

  test('scrolling renders the buffered page instantly, with no network', async ({ page }) => {
    const control = await setupPaginatedFeed(page);
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    // Wait for the buffer to fill, then cut the network entirely
    await expect.poll(() => control.requestedPages.filter(p => p > 1).length, { timeout: 10000 }).toBe(3);
    control.blocked = true;

    // Page 2 renders from the buffer even though no request can complete
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(20);

    // The refill for page 5 was still attempted (it hangs, but it fired)
    await expect.poll(() => control.requestedPages.includes(5), { timeout: 10000 }).toBe(true);
  });

  test('keeps topping the buffer back up to 3 as pages are consumed', async ({ page }) => {
    const control = await setupPaginatedFeed(page);
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);
    await expect.poll(() => control.requestedPages.filter(p => p > 1).length, { timeout: 10000 }).toBe(3);

    // Consume page 2 -> refill fetches page 5 (buffer: 3,4,5)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(20);
    await expect.poll(() => control.requestedPages.includes(5), { timeout: 10000 }).toBe(true);

    // Consume page 3 -> refill fetches page 6 (buffer: 4,5,6)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.media-card')).toHaveCount(30);
    await expect.poll(() => control.requestedPages.includes(6), { timeout: 10000 }).toBe(true);

    // Never fetched beyond the catalog's 6 pages
    expect(Math.max(...control.requestedPages)).toBeLessThanOrEqual(6);

    // No duplicates slipped through the buffered renders
    const ids = await page.locator('.media-card[data-video-id]').evaluateAll(
      cards => cards.map(c => c.dataset.videoId)
    );
    expect(ids.length).toBe(new Set(ids).size);
  });

  test('stops prefetching at the end of the catalog', async ({ page }) => {
    const control = await setupPaginatedFeed(page);
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);
    await expect.poll(() => control.requestedPages.filter(p => p > 1).length, { timeout: 10000 }).toBe(3);

    // Scroll through everything (staggered card entries need patience)
    let count = 0;
    for (let attempts = 0; count < 60 && attempts < 20; attempts++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
      count = await page.locator('.media-card').count();
    }
    await expect(page.locator('.media-card')).toHaveCount(60);

    // Only the catalog's 6 pages were ever requested — no page 7+
    const beyond = control.requestedPages.filter(p => p > 6);
    expect(beyond).toEqual([]);
  });
});
