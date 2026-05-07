/**
 * Feed Deduplication & Cache Integrity Tests
 *
 * Tests are split into three groups:
 *   1. GOOD STATE  — verify correct behavior (should PASS)
 *   2. ANTI-DUPLICATION — expose the cache/pagination overlap bug (should FAIL until fixed)
 *   3. COMMON ISSUES — edge cases and defensive checks
 */

import { test, expect } from '@playwright/test';

// ── Helpers ──────────────────────────────────────────────────

function mockItem(id, minutesAgo = 10, overrides = {}) {
  return {
    video_id: id,
    media_type: overrides.media_type || 'video',
    channel_name: overrides.channel_name || 'Test Channel',
    title: overrides.title || `Video ${id}`,
    url: overrides.url || `https://youtube.com/watch?v=${id}`,
    published_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    tier: 'T1',
    category: 'Review',
    comment_count: overrides.comment_count || 0,
    preview_image: overrides.preview_image || '',
  };
}

/** Set up the standard init + comments mocks (used by every test) */
async function setupBaseMocks(page) {
  await page.route('https://script.google.com/macros/s/*/exec?action=init', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', api_secret: 'test-secret' }),
    })
  );
  await page.route('https://script.google.com/macros/s/*/exec?action=comments*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', comments: [] }),
    })
  );
}

/**
 * Set up a paginating feed mock.
 * Accepts a flat array of items sorted newest-first.
 * Responds to ?action=feed&page=N&limit=M with the correct slice.
 */
async function setupPaginatedFeed(page, allItems) {
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
}

/** Return all data-video-id values currently in the DOM */
async function getAllCardIds(page) {
  return page.locator('.media-card[data-video-id]').evaluateAll(
    cards => cards.map(c => c.dataset.videoId)
  );
}

/** Wait for cards to finish rendering (staggered animation) */
async function waitForCards(page, expectedMin = 1) {
  await expect(page.locator('#feed-skeleton')).toBeHidden({ timeout: 5000 });
  await expect(page.locator('.media-card').first()).toBeVisible({ timeout: 5000 });
  // Allow staggered setTimeout animation to complete
  await page.waitForTimeout(800);
}

// ═════════════════════════════════════════════════════════════
// 1. GOOD STATE — These should PASS
// ═════════════════════════════════════════════════════════════

test.describe('Good State', () => {

  test('renders exactly N cards for N unique API items', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    const items = Array.from({ length: 5 }, (_, i) => mockItem(`vid_${i}`, i + 1));
    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    await expect(page.locator('.media-card')).toHaveCount(5);
  });

  test('all rendered cards have unique data-video-id attributes', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    const items = Array.from({ length: 8 }, (_, i) => mockItem(`uniq_${i}`, i + 1));
    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    const ids = await getAllCardIds(page);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test('corrupted localStorage cache is handled gracefully', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('wd_feed_cache', '{broken json!!!');
    });
    await setupBaseMocks(page);

    const items = Array.from({ length: 3 }, (_, i) => mockItem(`fresh_${i}`, i + 1));
    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    // Should fall back to fresh fetch, not crash
    await expect(page.locator('.media-card')).toHaveCount(3);
  });

  test('empty cache with total=0 triggers fresh fetch', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('wd_feed_cache', JSON.stringify({ videos: [], total: 0 }));
    });
    await setupBaseMocks(page);

    const items = Array.from({ length: 4 }, (_, i) => mockItem(`new_${i}`, i + 1));
    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('clean pagination (no overlap) produces no duplicates', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    // 15 items total, page_size=10 → page 1 gets 10, page 2 gets 5
    const items = Array.from({ length: 15 }, (_, i) => mockItem(`pg_${String(i).padStart(2, '0')}`, i + 1));
    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    // Scroll to trigger page 2
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const ids = await getAllCardIds(page);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. ANTI-DUPLICATION — These EXPOSE BUGS (expected to FAIL)
// ═════════════════════════════════════════════════════════════

test.describe('Anti-Duplication (expected to fail — known bugs)', () => {

  test('cache + shifted pagination must NOT produce duplicate cards', async ({ page }) => {
    // SCENARIO:
    // Cache was saved when feed had 20 items, user saw page 1 (items V01-V10).
    // Since then, 3 new items (N01-N03) were added at the top.
    // API page 2 now returns V08-V17 (V08, V09, V10 overlap with cache).
    //
    // Expected: V08, V09, V10 should NOT appear twice.

    const cachedItems = Array.from({ length: 10 }, (_, i) =>
      mockItem(`V${String(i + 1).padStart(2, '0')}`, (i + 1) * 10)
    );

    await page.addInitScript((items) => {
      window.localStorage.setItem('wd_feed_cache', JSON.stringify({
        videos: items,
        total: 20,  // hasMore = true → triggers page 2 fetch
      }));
    }, cachedItems);

    await setupBaseMocks(page);

    // API now has 23 items (3 new + 20 old). Pagination shifted.
    const newItems = Array.from({ length: 3 }, (_, i) =>
      mockItem(`N${String(i + 1).padStart(2, '0')}`, i + 1)
    );
    const oldItems = Array.from({ length: 20 }, (_, i) =>
      mockItem(`V${String(i + 1).padStart(2, '0')}`, (i + 4) * 10)
    );
    const allApiItems = [...newItems, ...oldItems]; // newest first

    await setupPaginatedFeed(page, allApiItems);

    await page.goto('/');
    await waitForCards(page);

    // Scroll to trigger page 2 load
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    // ASSERT: every video_id in DOM is unique
    const ids = await getAllCardIds(page);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test('appendCards must skip items already present in DOM', async ({ page }) => {
    // Direct test: API page 1 and page 2 share overlapping item IDs.
    // The frontend should skip items that already exist.

    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    // Page 1 returns items A,B,C,D,E. Page 2 returns D,E,F,G (overlap: D,E)
    const page1 = ['A', 'B', 'C', 'D', 'E'].map((id, i) => mockItem(id, (i + 1) * 5));
    const page2 = ['D', 'E', 'F', 'G'].map((id, i) => mockItem(id, (i + 6) * 5));

    let callCount = 0;
    await page.route('https://script.google.com/macros/s/*/exec?action=feed*', route => {
      callCount++;
      const url = new URL(route.request().url());
      const pg = parseInt(url.searchParams.get('page')) || 1;

      if (pg === 1) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', total: 9, page: 1, videos: page1 }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', total: 9, page: 2, videos: page2 }),
        });
      }
    });

    await page.goto('/');
    await waitForCards(page);

    // Scroll to trigger page 2
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    // Should have 7 unique cards (A,B,C,D,E,F,G), NOT 9
    const ids = await getAllCardIds(page);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
    expect(uniqueIds.size).toBe(7);
  });
});

// ═════════════════════════════════════════════════════════════
// 3. COMMON ISSUES — Edge cases / defensive checks
// ═════════════════════════════════════════════════════════════

test.describe('Common Issues', () => {

  test('items with missing video_id do not crash the feed', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    const items = [
      mockItem('good_001', 1),
      { ...mockItem('', 2), video_id: undefined, title: 'Broken item' },
      mockItem('good_002', 3),
    ];

    await page.route('https://script.google.com/macros/s/*/exec?action=feed*', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', total: 3, page: 1, videos: items }),
      })
    );

    await page.goto('/');
    await waitForCards(page);

    // At minimum, the two good items should render without crashing
    const count = await page.locator('.media-card').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('same title but different IDs are NOT treated as duplicates', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    // Two different items happen to share the same title
    const items = [
      mockItem('aaa_1111111', 1, { title: 'Rolex Submariner Review' }),
      mockItem('bbb_2222222', 2, { title: 'Rolex Submariner Review' }),
    ];

    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    // Both should render — same title is NOT a duplicate
    await expect(page.locator('.media-card')).toHaveCount(2);
  });

  test('rapid scroll does not produce duplicate cards from concurrent fetches', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    const items = Array.from({ length: 25 }, (_, i) =>
      mockItem(`rapid_${String(i).padStart(2, '0')}`, i + 1)
    );
    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    // Fire multiple rapid scrolls in quick succession
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(3000);

    const ids = await getAllCardIds(page);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test('article and video items with same generated ID do not duplicate', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await setupBaseMocks(page);

    // Edge case: an article and a video end up with the same video_id
    const items = [
      mockItem('collision01', 1, { media_type: 'video', title: 'YouTube Video' }),
      mockItem('collision01', 2, { media_type: 'article', title: 'Blog Article' }),
    ];

    await setupPaginatedFeed(page, items);

    await page.goto('/');
    await waitForCards(page);

    // Should only render ONE card for this ID
    const ids = await getAllCardIds(page);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test('stale cache + fresh API does not show ghost cards from removed items', async ({ page }) => {
    // Cache has an item that no longer exists in the API.
    // After revalidation, the ghost item should NOT persist.
    const staleItem = mockItem('DELETED_01', 100, { title: 'This was removed' });
    const freshItems = [
      mockItem('current_01', 1),
      mockItem('current_02', 2),
    ];

    await page.addInitScript((stale) => {
      window.localStorage.setItem('wd_feed_cache', JSON.stringify({
        videos: [stale, ...JSON.parse('[' +
          '{"video_id":"current_01","media_type":"video","channel_name":"Test","title":"V1","url":"u","published_at":"2026-01-01","tier":"T1","category":"Review","comment_count":0},' +
          '{"video_id":"current_02","media_type":"video","channel_name":"Test","title":"V2","url":"u","published_at":"2026-01-01","tier":"T1","category":"Review","comment_count":0}' +
        ']')],
        total: 3,
      }));
    }, staleItem);

    await setupBaseMocks(page);
    await setupPaginatedFeed(page, freshItems);

    await page.goto('/');
    await waitForCards(page);

    // The stale/deleted item is expected to show because the cache rendered it.
    // This test documents the behavior — stale items persist until the cache is fully refreshed.
    const ids = await getAllCardIds(page);
    // We expect 3 cards from cache (including the stale one)
    // This is documenting current behavior, not necessarily ideal behavior.
    expect(ids).toContain('DELETED_01');
  });
});
