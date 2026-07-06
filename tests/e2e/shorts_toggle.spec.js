/**
 * E2E tests for the Shorts toggle and deferred shorts rendering (mocked API)
 *
 * Long-form videos render first; Shorts slide in afterward at their
 * chronological position. The toggle hides/shows them with pure CSS.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'long_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Long Form One', url: 'https://www.youtube.com/watch?v=long_vid_a1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'short_vid_1', channel_name: 'Nico Leonard', title: 'Quick Short One', url: 'https://www.youtube.com/shorts/short_vid_1', published_at: new Date(now - 3 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'long_vid_b2', channel_name: 'Jenni Elle', title: 'Long Form Two', url: 'https://www.youtube.com/watch?v=long_vid_b2', published_at: new Date(now - 5 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'short_vid_2', channel_name: 'Bark and Jack', title: 'Quick Short Two', url: 'https://www.youtube.com/shorts/short_vid_2', published_at: new Date(now - 7 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 4,
  page: 1,
};

// Vote-ranked: a short outranks a newer long-form video. The list order
// must be preserved as-is — shorts are NOT re-sorted chronologically.
const TOP_WEEK = {
  status: 'ok',
  videos: [
    { video_id: 'top_long_a1', channel_name: 'Teddy Baldassarre', title: 'Top Long Form', url: 'https://www.youtube.com/watch?v=top_long_a1', published_at: new Date(now - 1 * 24 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 30 },
    { video_id: 'top_short_1', channel_name: 'Nico Leonard', title: 'Top Short', url: 'https://www.youtube.com/shorts/top_short_1', published_at: new Date(now - 4 * 24 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 20 },
    { video_id: 'top_long_b2', channel_name: 'Jenni Elle', title: 'Third Long Form', url: 'https://www.youtube.com/watch?v=top_long_b2', published_at: new Date(now - 2 * 24 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 10 },
  ],
  total: 3,
};

test.describe('Shorts toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FEED) });
      }
      if (url.includes('action=topWeek')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TOP_WEEK) });
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
  });

  test('renders the toggle in the tabs row, on by default', async ({ page }) => {
    await expect(page.locator('#shorts-toggle')).toBeVisible();
    await expect(page.locator('#shorts-toggle-input')).toBeChecked();
  });

  test('long-form renders first, shorts arrive after', async ({ page }) => {
    // Both long-form cards land before either short does
    await expect(page.locator('.media-card:not(.media-card--short)')).toHaveCount(2);

    // The deferred shorts then animate in
    await expect(page.locator('.media-card--short')).toHaveCount(2);
    await expect(page.locator('.media-card')).toHaveCount(4);
  });

  test('shorts land at their chronological position', async ({ page }) => {
    await expect(page.locator('.media-card')).toHaveCount(4);

    const order = await page.$$eval('.media-card', cards => cards.map(c => c.dataset.videoId));
    expect(order).toEqual(['long_vid_a1', 'short_vid_1', 'long_vid_b2', 'short_vid_2']);
  });

  test('toggling off hides shorts without removing long-form cards', async ({ page }) => {
    await expect(page.locator('.media-card')).toHaveCount(4);

    await page.locator('#shorts-toggle').click();

    await expect(page.locator('#shorts-toggle-input')).not.toBeChecked();
    await expect(page.locator('.media-card--short').first()).toBeHidden();
    await expect(page.locator('.media-card:not(.media-card--short)').first()).toBeVisible();

    // Toggling back on restores them
    await page.locator('#shorts-toggle').click();
    await expect(page.locator('.media-card--short').first()).toBeVisible();
  });

  test('the preference persists across reloads', async ({ page }) => {
    await expect(page.locator('.media-card')).toHaveCount(4);
    await page.locator('#shorts-toggle').click();
    await expect(page.locator('.media-card--short').first()).toBeHidden();

    await page.reload();

    await expect(page.locator('#shorts-toggle-input')).not.toBeChecked();
    await expect(page.locator('.media-card:not(.media-card--short)').first()).toBeVisible();
    await expect(page.locator('.media-card--short').first()).toBeHidden();
  });

  test('tab switches render shorts instantly — no deferred flash-in', async ({ page }) => {
    await expect(page.locator('.media-card')).toHaveCount(4);

    // First visit to Top This Week (fetches once)
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();
    await expect(page.locator('.media-card')).toHaveCount(3);

    // Back to Latest: count shorts in the SAME tick as the click — the
    // re-render is synchronous, so all 2 shorts must already be in the DOM.
    const backToLatest = await page.evaluate(() => {
      document.querySelector('.feed-tab[data-view="latest"]').click();
      return {
        shorts: document.querySelectorAll('.media-card--short').length,
        total: document.querySelectorAll('.media-card').length,
      };
    });
    expect(backToLatest.shorts).toBe(2);
    expect(backToLatest.total).toBe(4);

    // And to Top again: its short is also there immediately
    const backToTop = await page.evaluate(() => {
      document.querySelector('.feed-tab[data-view="top"]').click();
      return {
        shorts: document.querySelectorAll('.media-card--short').length,
        total: document.querySelectorAll('.media-card').length,
      };
    });
    expect(backToTop.shorts).toBe(1);
    expect(backToTop.total).toBe(3);
  });

  test('Top This Week keeps shorts in vote-ranked order, not re-sorted by date', async ({ page }) => {
    await expect(page.locator('.media-card')).toHaveCount(4);
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();
    await expect(page.locator('.media-card')).toHaveCount(3);

    const order = await page.$$eval('.media-card', cards => cards.map(c => c.dataset.videoId));
    expect(order).toEqual(['top_long_a1', 'top_short_1', 'top_long_b2']);
  });
});
