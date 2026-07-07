/**
 * E2E tests for search (mocked API)
 *
 * Tests the search input, filtered rendering, and restoring the normal feed
 * when the query clears. Content-type chip behavior lives in
 * content_type_filter.spec.js.
 */

import { test, expect } from '@playwright/test';

const MOCK_FEED = {
  status: 'ok',
  videos: [
    {
      video_id: 'test_vid_1',
      channel_name: 'Teddy Baldassarre',
      title: 'Tudor Black Bay 58 Review',
      url: 'https://www.youtube.com/watch?v=test_vid_1',
      published_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      tier: 0,
      category: 'The Heavyweights & Entertainment',
      comment_count: 0,
    },
    {
      video_id: 'test_vid_2',
      channel_name: 'Nico Leonard',
      title: 'Reacting to $1M Watch Collections',
      url: 'https://www.youtube.com/watch?v=test_vid_2',
      published_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      tier: 0,
      category: 'The Heavyweights & Entertainment',
      comment_count: 0,
    },
    {
      video_id: 'test_vid_3',
      channel_name: 'Just One More Watch',
      title: 'Best Budget Watches 2026',
      url: 'https://www.youtube.com/watch?v=test_vid_3',
      published_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      tier: 1,
      category: 'The Affordable & "Value" Kings',
      comment_count: 0,
    },
    {
      video_id: 'test_vid_4',
      channel_name: 'Bark and Jack',
      title: 'GMT Showdown',
      url: 'https://www.youtube.com/watch?v=test_vid_4',
      published_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
      tier: 1,
      category: 'The Enthusiast & Lifestyle Favorites',
      comment_count: 0,
    },
  ],
  total: 4,
  page: 1,
};

test.describe('Search & Category Filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_FEED),
        });
      } else if (url.includes('action=commentsBatch')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', byVideo: {} }),
        });
      } else if (url.includes('action=comments')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', comments: [] }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok' }),
        });
      }
    });

    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('renders the search input and content-type chips', async ({ page }) => {
    await expect(page.locator('#search-input')).toBeVisible();

    // Fixed content-type chips: "All" + Videos / Articles / Shorts
    const chips = page.locator('#category-chips .chip');
    await expect(chips.first()).toHaveText('All');
    await expect(page.locator('.chip', { hasText: 'Videos' })).toBeVisible();
  });

  test('typing a query filters cards by title', async ({ page }) => {
    await page.fill('#search-input', 'tudor');

    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__title')).toContainText('Tudor Black Bay 58');
  });

  test('query matches channel names too', async ({ page }) => {
    await page.fill('#search-input', 'nico');

    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__channel')).toContainText('Nico Leonard');
  });

  test('clearing the query restores the full feed', async ({ page }) => {
    await page.fill('#search-input', 'tudor');
    await expect(page.locator('.media-card')).toHaveCount(1);

    await page.fill('#search-input', '');
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('query matches the channel host from creators.json', async ({ page }) => {
    // "Adrian" appears nowhere in titles or channel names — the channel is
    // "Bark and Jack", hosted by Adrian Barker (per creators.json).
    await page.fill('#search-input', 'adrian');

    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__channel')).toContainText('Bark and Jack');
  });

  test('shows an empty message when nothing matches', async ({ page }) => {
    await page.fill('#search-input', 'submariner');

    await expect(page.locator('.media-card')).toHaveCount(0);
    await expect(page.locator('#feed-empty')).toBeVisible();
    await expect(page.locator('#feed-empty')).toContainText('No videos match your search');
  });

  test('search and a content-type chip combine', async ({ page }) => {
    // All four mock items are videos, so the Videos chip keeps them all;
    // the query then narrows to Nico's collections video.
    await page.locator('.chip', { hasText: 'Videos' }).click();
    await page.fill('#search-input', 'collections');

    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__channel')).toContainText('Nico Leonard');
  });

  test('infinite scroll sentinel is hidden while filtering', async ({ page }) => {
    await page.fill('#search-input', 'tudor');
    await expect(page.locator('.media-card')).toHaveCount(1);

    await expect(page.locator('#load-more-container')).toBeHidden();
  });
});
