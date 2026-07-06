/**
 * E2E tests for per-card fullscreen mode (mocked API)
 *
 * The expand button turns a card into a fixed overlay (pure CSS, no
 * navigation). Exiting restores the feed scrolled back to whichever
 * card was at the top of the viewport before expanding.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

// Enough cards that the page scrolls on the default viewport.
// IDs are 11 chars so cards render as videos, not articles.
const MOCK_FEED = {
  status: 'ok',
  videos: Array.from({ length: 8 }, (_, i) => ({
    video_id: `fs_vid_${i}000`,
    channel_name: 'Teddy Baldassarre',
    title: `Fullscreen Test Video ${i}`,
    url: `https://www.youtube.com/watch?v=fs_vid_${i}000`,
    published_at: new Date(now - (i + 1) * 3600 * 1000).toISOString(),
    category: 'Reviews',
    comment_count: 0,
  })),
  total: 8,
  page: 1,
};

test.describe('Fullscreen mode', () => {
  test.beforeEach(async ({ page }) => {
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
    await expect(page.locator('.media-card')).toHaveCount(8);
  });

  test('every card has an expand button', async ({ page }) => {
    await expect(page.locator('.media-card__expand')).toHaveCount(8);
  });

  test('expanding covers the viewport and opens the comments', async ({ page }) => {
    const first = page.locator('.media-card').first();
    await first.locator('.media-card__expand').click();

    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);
    await expect(first).toHaveClass(/media-card--fullscreen/);

    // The overlay spans the whole viewport
    const box = await first.boundingBox();
    const viewport = page.viewportSize();
    expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);

    // Fullscreen is the watch-and-discuss view
    await expect(first.locator('.media-card__comments-body')).toBeVisible();
  });

  test('the expand button exits fullscreen', async ({ page }) => {
    const first = page.locator('.media-card').first();
    await first.locator('.media-card__expand').click();
    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);

    await first.locator('.media-card__expand').click();

    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    await expect(page.locator('.media-card--fullscreen')).toHaveCount(0);
  });

  test('Escape exits fullscreen', async ({ page }) => {
    await page.locator('.media-card').first().locator('.media-card__expand').click();
    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);

    await page.keyboard.press('Escape');

    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
  });

  test('exiting returns to the card that was at the top of the feed', async ({ page }) => {
    // Scroll so a mid-feed card sits at the top of the viewport
    const target = page.locator('.media-card[data-video-id="fs_vid_4000"]');
    await target.evaluate(el => el.scrollIntoView({ block: 'start' }));

    const topBefore = await page.evaluate(() =>
      document.querySelector('.media-card[data-video-id="fs_vid_4000"]').getBoundingClientRect().top
    );

    await target.locator('.media-card__expand').click();
    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);

    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);

    // The same card is back at (or very near) the top of the viewport
    const topAfter = await page.evaluate(() =>
      document.querySelector('.media-card[data-video-id="fs_vid_4000"]').getBoundingClientRect().top
    );
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(80);
  });
});
