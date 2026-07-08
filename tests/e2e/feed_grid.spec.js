/**
 * E2E tests for the Nebula-style feed grid (mocked API)
 *
 * Covers: the feed container is a responsive CSS grid (3-up desktop, 2-up
 * tablet, 1-up mobile — asserted against the running project's viewport) and
 * each card is a vertical tile (thumbnail stacked above its content).
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'grid_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Top 10 Watches Under $500 You Can Actually Buy', url: 'https://www.youtube.com/watch?v=grid_vid_a1', published_at: new Date(now - 1 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, view_count: 52300 },
    { video_id: 'grid_vid_b2', channel_name: 'Nico Leonard', title: 'Reacting to a $1M Collection', url: 'https://www.youtube.com/watch?v=grid_vid_b2', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, view_count: 318000 },
    { video_id: 'grid_vid_c3', channel_name: 'Hodinkee', title: 'The Rise of Microbrands', url: 'https://www.youtube.com/watch?v=grid_vid_c3', published_at: new Date(now - 3 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, view_count: 12000 },
  ],
  total: 3,
  page: 1,
};

async function setup(page) {
  await page.route('**/macros/**', async (route) => {
    const url = route.request().url();
    if (url.includes('action=feed')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FEED) });
    }
    if (url.includes('action=commentsBatch')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', byVideo: {} }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });
  await page.goto('/');
  await expect(page.locator('.media-card')).toHaveCount(3);
}

test.describe('Nebula feed grid', () => {
  test('the feed is a CSS grid whose column count matches the viewport', async ({ page }) => {
    await setup(page);

    const { display, cols } = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('feed-container'));
      return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length };
    });

    expect(display).toBe('grid');

    const w = page.viewportSize().width;
    const expected = w >= 960 ? 3 : w >= 640 ? 2 : 1;
    expect(cols).toBe(expected);
  });

  test('each card is a vertical tile — thumbnail stacked above its content', async ({ page }) => {
    await setup(page);

    const stacked = await page.evaluate(() => {
      const card = document.querySelector('.media-card');
      const embed = card.querySelector('.media-card__embed').getBoundingClientRect();
      const content = card.querySelector('.media-card__content').getBoundingClientRect();
      // Stacked (not side-by-side): the embed ends at or above where content starts.
      return Math.round(embed.bottom) <= Math.round(content.top);
    });

    expect(stacked).toBe(true);
  });

  test('tiles in a row share a height so their bottoms align', async ({ page }) => {
    await setup(page);
    const w = page.viewportSize().width;
    test.skip(w < 960, 'row-alignment check is for the 3-up desktop grid');

    const heights = await page.$$eval('.media-card', els =>
      els.slice(0, 3).map(e => Math.round(e.getBoundingClientRect().height)));
    // All three first-row tiles are equal height (titles reserve two lines).
    expect(new Set(heights).size).toBe(1);
  });
});
