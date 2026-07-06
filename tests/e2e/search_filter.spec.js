/**
 * E2E tests for search and category filter (mocked API)
 *
 * Tests the search input, category chips, filtered rendering,
 * and restoring the normal feed when the filter clears.
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

  test('renders the search input and category chips', async ({ page }) => {
    await expect(page.locator('#search-input')).toBeVisible();

    // Chips come from creators.json: "All" + one per unique category
    const chips = page.locator('#category-chips .chip');
    await expect(chips.first()).toHaveText('All');
    await expect(page.locator('.chip', { hasText: 'The Affordable & "Value" Kings' })).toBeVisible();
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

  test('clicking a category chip filters the feed', async ({ page }) => {
    await page.locator('.chip', { hasText: 'The Heavyweights & Entertainment' }).click();

    await expect(page.locator('.media-card')).toHaveCount(2);
    await expect(page.locator('.chip--active')).toHaveText('The Heavyweights & Entertainment');
  });

  test('the All chip clears the category filter', async ({ page }) => {
    await page.locator('.chip', { hasText: 'The Affordable & "Value" Kings' }).click();
    await expect(page.locator('.media-card')).toHaveCount(1);

    await page.locator('.chip', { hasText: 'All' }).click();
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('shows an empty message when nothing matches', async ({ page }) => {
    await page.fill('#search-input', 'submariner');

    await expect(page.locator('.media-card')).toHaveCount(0);
    await expect(page.locator('#feed-empty')).toBeVisible();
    await expect(page.locator('#feed-empty')).toContainText('No videos match your search');
  });

  test('search and category combine', async ({ page }) => {
    await page.locator('.chip', { hasText: 'The Heavyweights & Entertainment' }).click();
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
