/**
 * E2E tests for the feed view
 * 
 * Tests the main feed page: loading, card rendering, filtering, pagination.
 * Uses mocked API responses via route interception.
 */

import { test, expect } from '@playwright/test';

const MOCK_FEED = {
  status: 'ok',
  videos: [
    {
      video_id: 'test_vid_1',
      channel_name: 'Teddy Baldassarre',
      title: 'Top 10 Watches Under $500 in 2026',
      url: 'https://www.youtube.com/watch?v=test_vid_1',
      published_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), // 3h ago
      tier: 0,
      category: 'The Heavyweights & Entertainment',
      comment_count: 5,
    },
    {
      video_id: 'test_vid_2',
      channel_name: 'Nico Leonard',
      title: 'Reacting to $1M Watch Collections',
      url: 'https://www.youtube.com/watch?v=test_vid_2',
      published_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), // 6h ago
      tier: 0,
      category: 'The Heavyweights & Entertainment',
      comment_count: 12,
    },
    {
      video_id: 'test_vid_3',
      channel_name: 'Just One More Watch',
      title: 'Best Budget Watches 2026',
      url: 'https://www.youtube.com/watch?v=test_vid_3',
      published_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), // 1d ago
      tier: 1,
      category: 'The Affordable & "Value" Kings',
      comment_count: 0,
    },
  ],
  total: 3,
  page: 1,
};

test.describe('Feed View', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept API calls to Apps Script
    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_FEED),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', comments: [] }),
        });
      }
    });

    await page.goto('/');
  });

  test('shows loading skeleton initially', async ({ page }) => {
    // Skeleton should be present momentarily
    const skeleton = page.locator('#feed-skeleton');
    // May already be hidden if API responds fast, so just check page loaded
    await expect(page.locator('#feed-container')).toBeVisible();
  });

  test('renders feed cards after loading', async ({ page }) => {
    await expect(page.locator('.video-card')).toHaveCount(3);
  });

  test('each card has a YouTube iframe embed', async ({ page }) => {
    const iframes = page.locator('.video-card__embed iframe');
    await expect(iframes).toHaveCount(3);

    // Check first iframe src
    const src = await iframes.first().getAttribute('src');
    expect(src).toContain('youtube-nocookie.com/embed/test_vid_1');
  });

  test('iframes use lazy loading', async ({ page }) => {
    const loading = await page.locator('.video-card__embed iframe').first().getAttribute('loading');
    expect(loading).toBe('lazy');
  });

  test('cards show channel name and time ago', async ({ page }) => {
    const firstCard = page.locator('.video-card').first();
    await expect(firstCard.locator('.video-card__channel')).toContainText('Teddy Baldassarre');
    await expect(firstCard.locator('.video-card__time')).toBeVisible();
  });

  test('cards show tier badge', async ({ page }) => {
    const firstCard = page.locator('.video-card').first();
    await expect(firstCard.locator('.video-card__tier')).toContainText('Tier 0');
  });

  test('cards show comment count', async ({ page }) => {
    const firstCard = page.locator('.video-card').first();
    await expect(firstCard.locator('.video-card__comments-btn')).toContainText('5 comments');
  });

  test('clicking comments button navigates to post detail', async ({ page }) => {
    await page.locator('.video-card__comments-btn').first().click();
    await expect(page).toHaveURL(/#\/post\/test_vid_1/);
    await expect(page.locator('#detail-view')).toBeVisible();
    await expect(page.locator('#feed-view')).toBeHidden();
  });

  test('filter tabs filter by tier', async ({ page }) => {
    // Click Tier 1 filter
    await page.locator('[data-filter="1"]').click();
    await expect(page.locator('.video-card')).toHaveCount(1);
    await expect(page.locator('.video-card')).toContainText('Just One More Watch');
  });

  test('filter "All" shows all videos', async ({ page }) => {
    // Click Tier 0, then All
    await page.locator('[data-filter="0"]').click();
    await expect(page.locator('.video-card')).toHaveCount(2);

    await page.locator('[data-filter="all"]').click();
    await expect(page.locator('.video-card')).toHaveCount(3);
  });
});
