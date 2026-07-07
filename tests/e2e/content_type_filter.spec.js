/**
 * E2E tests for the content-type filter chips (mocked API)
 *
 * The chips replace the old Shorts toggle: All / Videos / Articles / Shorts.
 * Types are multi-selectable — "All" is exclusive, picking a type clears
 * "All", picking every type collapses back to "All", and deselecting the
 * last type falls back to "All".
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'vid00000001', media_type: 'video', channel_name: 'Teddy Baldassarre', title: 'Tudor Black Bay Review', url: 'https://www.youtube.com/watch?v=vid00000001', published_at: new Date(now - 1 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'vid00000002', media_type: 'video', channel_name: 'Jenni Elle', title: 'Omega Deep Dive', url: 'https://www.youtube.com/watch?v=vid00000002', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'YXJ0aWNsZTAx', media_type: 'article', channel_name: 'Hodinkee', title: 'The Rise of Microbrands', url: 'https://www.hodinkee.com/articles/microbrands', preview_image: 'https://cdn.hodinkee.com/x.jpg', published_at: new Date(now - 3 * 3600 * 1000).toISOString(), category: 'Editorial', comment_count: 0 },
    { video_id: 'shrt0000001', media_type: 'video', channel_name: 'Nico Leonard', title: 'Quick Short Take', url: 'https://www.youtube.com/shorts/shrt0000001', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 4,
  page: 1,
};

const chip = (page, label) => page.locator('#category-chips .chip', { hasText: new RegExp(`^${label}$`) });

test.describe('Content-type filter chips', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FEED) });
      }
      if (url.includes('action=commentsBatch')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', byVideo: {} }) });
      }
      if (url.includes('action=comments')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [] }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
    });

    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('renders the four content-type chips, All active by default', async ({ page }) => {
    await expect(chip(page, 'All')).toBeVisible();
    await expect(chip(page, 'Videos')).toBeVisible();
    await expect(chip(page, 'Articles')).toBeVisible();
    await expect(chip(page, 'Shorts')).toBeVisible();

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
  });

  test('the old Shorts toggle is gone', async ({ page }) => {
    await expect(page.locator('#shorts-toggle')).toHaveCount(0);
  });

  test('Videos shows only videos and deselects All', async ({ page }) => {
    await chip(page, 'Videos').click();

    await expect(page.locator('.media-card')).toHaveCount(2);
    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    await expect(chip(page, 'All')).not.toHaveClass(/chip--active/);
  });

  test('Articles shows only the article', async ({ page }) => {
    await chip(page, 'Articles').click();
    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__title')).toContainText('Microbrands');
  });

  test('Shorts shows only the short', async ({ page }) => {
    await chip(page, 'Shorts').click();
    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card--short')).toHaveCount(1);
  });

  test('multiple types union together (Articles + Shorts)', async ({ page }) => {
    await chip(page, 'Articles').click();
    await chip(page, 'Shorts').click();

    await expect(page.locator('.media-card')).toHaveCount(2);
    await expect(chip(page, 'Articles')).toHaveClass(/chip--active/);
    await expect(chip(page, 'Shorts')).toHaveClass(/chip--active/);
    await expect(chip(page, 'All')).not.toHaveClass(/chip--active/);
  });

  test('selecting all three types collapses back to All', async ({ page }) => {
    await chip(page, 'Videos').click();
    await chip(page, 'Articles').click();
    await chip(page, 'Shorts').click();

    // Every type selected === no filter: All takes over, the rest clear.
    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('deselecting the last active type falls back to All', async ({ page }) => {
    await chip(page, 'Videos').click();
    await expect(page.locator('.media-card')).toHaveCount(2);

    await chip(page, 'Videos').click(); // toggle it back off

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('clicking All clears an active type selection', async ({ page }) => {
    await chip(page, 'Videos').click();
    await expect(page.locator('.media-card')).toHaveCount(2);

    await chip(page, 'All').click();

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('a type filter combines with the search query', async ({ page }) => {
    await chip(page, 'Videos').click();
    await page.fill('#search-input', 'omega');

    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__title')).toContainText('Omega');
  });
});
