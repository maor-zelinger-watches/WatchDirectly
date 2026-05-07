import { test, expect } from '@playwright/test';

/**
 * Infinite Scroll — Mocked test
 *
 * Verifies the 3-phase loading strategy:
 *   Phase 1: Load N+1 items (above the fold)
 *   Phase 2: Load remainder of page 1 (up to PAGE_SIZE)
 *   Phase 3: Load page 2 on scroll
 */

function mockItem(id, minutesAgo = 10) {
  return {
    video_id: id,
    media_type: 'video',
    channel_name: 'Scroll Test Channel',
    title: `Video ${id}`,
    url: `https://youtube.com/watch?v=${id}`,
    published_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    tier: 'T1',
    category: 'Review',
    comment_count: 0,
  };
}

test.describe('Infinite Scroll', () => {
  test('loads initial batch, then remainder of first page, then second page on scroll', async ({ page }) => {
    // Clear local storage to ensure fresh load
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    // 30 items total, enough for 3 pages at PAGE_SIZE=10
    const allItems = Array.from({ length: 30 }, (_, i) =>
      mockItem(`scroll_${String(i).padStart(2, '0')}`, i + 1)
    );

    // Mock init
    await page.route('https://script.google.com/macros/s/*/exec?action=init', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', api_secret: 'test-secret' }),
      })
    );

    // Mock comments
    await page.route('https://script.google.com/macros/s/*/exec?action=comments*', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', comments: [] }),
      })
    );

    // Mock paginated feed
    await page.route('https://script.google.com/macros/s/*/exec?action=feed*', route => {
      const url = new URL(route.request().url());
      const pg = parseInt(url.searchParams.get('page')) || 1;
      const limit = parseInt(url.searchParams.get('limit')) || 10;
      const start = (pg - 1) * limit;
      const paged = allItems.slice(start, start + limit);

      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', total: allItems.length, page: pg, videos: paged }),
      });
    });

    await page.goto('/');

    // Wait for initial cards to appear
    await page.waitForSelector('.media-card', { timeout: 10000 });

    // Phase 1+2: Should have loaded page 1 (up to 10 items)
    await page.waitForTimeout(1500);
    let currentCards = await page.locator('.media-card').count();
    console.log(`After initial load: ${currentCards} cards`);
    expect(currentCards).toBeGreaterThanOrEqual(1);
    expect(currentCards).toBeLessThanOrEqual(10);

    // Phase 3: Scroll to trigger page 2
    const expectedCards = 20;
    let attempts = 0;

    while (currentCards < expectedCards && attempts < 15) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      currentCards = await page.locator('.media-card').count();
      console.log(`Cards loaded: ${currentCards}`);
      attempts++;
    }

    expect(currentCards).toBeGreaterThanOrEqual(expectedCards);

    // Verify all card IDs are unique (no duplication from pagination)
    const ids = await page.locator('.media-card[data-video-id]').evaluateAll(
      cards => cards.map(c => c.dataset.videoId)
    );
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });
});
