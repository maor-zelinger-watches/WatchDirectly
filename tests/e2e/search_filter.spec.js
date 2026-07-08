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

// Host names for the channels above, as would be served by the backend's
// getChannels action. Only Bark and Jack's host is exercised by a test below,
// but the others are included for realism.
const MOCK_CHANNELS = {
  status: 'ok',
  channels: [
    { channel_name: 'Teddy Baldassarre', host: 'Teddy Baldassarre' },
    { channel_name: 'Nico Leonard', host: 'Nico Leonard' },
    { channel_name: 'Just One More Watch', host: 'Jody Musgrove' },
    { channel_name: 'Bark and Jack', host: 'Adrian Barker' },
  ],
};

test.describe('Search & Category Filter', () => {
  test.beforeEach(async ({ page }) => {
    // Seed a saved "All" selection so these tests keep an All baseline —
    // independent of the default content-type filter (Videos + Articles),
    // which is covered in content_type_filter.spec.js.
    await page.addInitScript(() => window.localStorage.setItem('wd_filter_types', '[]'));
    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_FEED),
        });
      } else if (url.includes('action=getChannels')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_CHANNELS),
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

  test('query matches the channel host from getChannels', async ({ page }) => {
    // "Adrian" appears nowhere in titles or channel names — the channel is
    // "Bark and Jack", hosted by Adrian Barker (per MOCK_CHANNELS).
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

  test('shows a loading state while the catalog index warms, never a blank flash', async ({ page }) => {
    // Delay the index-build fetch so the build is observably in flight after
    // the first keystroke. This route is registered after the beforeEach one,
    // so it wins for feed requests; everything else falls back.
    await page.route('**/macros/**', async (route) => {
      if (route.request().url().includes('action=feed')) {
        await new Promise((r) => setTimeout(r, 800));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_FEED),
        });
      } else {
        await route.fallback();
      }
    });

    // Nothing in the in-memory seed matches, and the catalog is still
    // streaming in — the box must show "Searching…", not an empty container.
    await page.fill('#search-input', 'submariner');
    await expect(page.locator('#feed-searching')).toBeVisible();
    await expect(page.locator('#feed-empty')).toBeHidden();

    // Once the index finishes, it resolves to the real empty state.
    await expect(page.locator('#feed-empty')).toBeVisible();
    await expect(page.locator('#feed-empty')).toContainText('No videos match your search');
    await expect(page.locator('#feed-searching')).toBeHidden();
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
