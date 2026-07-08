/**
 * E2E for Top This Week infinite scroll (mocked, cursor-paginated API).
 *
 * The tab is vote-ranked and cursor-paginated: the backend serves the whole
 * 7-day window in pages, so items older than the first page are reachable only
 * by scrolling. The mock caps every response at the requested `limit`, so
 * reaching the last ranked item necessarily takes several cursor-linked
 * requests — proving the tab paginates rather than truncating at one response.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const LATEST_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'lat_1', channel_name: 'Teddy Baldassarre', title: 'Latest One', url: 'https://www.youtube.com/watch?v=lat_1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 0 },
  ],
  total: 1,
  page: 1,
  next_cursor: '',
};

// 25 ranked items, votes 100..76 (top_00 highest). Published oldest-as-index
// grows, so the ranking is a clean top_00 .. top_24 by both votes and id.
const TOP_ITEMS = Array.from({ length: 25 }, (_, i) => {
  const id = `top_${String(i).padStart(2, '0')}`;
  return {
    video_id: id,
    channel_name: 'Hodinkee',
    title: `Ranked #${i}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    published_at: new Date(now - (i + 1) * 3600 * 1000).toISOString(),
    category: 'Reviews',
    comment_count: 0,
    vote_count: 100 - i,
  };
});

async function setup(page) {
  await page.route('**/macros/**', async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.includes('action=feed')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LATEST_FEED) });
    }
    if (url.includes('action=topWeek')) {
      const u = new URL(url);
      const limit = parseInt(u.searchParams.get('limit'), 10) || 10;
      const cursor = u.searchParams.get('cursor') || '';
      // Cursor is the last item id we handed out — resume strictly after it.
      let start = 0;
      if (cursor) {
        const idx = TOP_ITEMS.findIndex((v) => v.video_id === cursor);
        start = idx === -1 ? 0 : idx + 1;
      }
      const slice = TOP_ITEMS.slice(start, start + limit);
      const nextStart = start + slice.length;
      const next_cursor = nextStart < TOP_ITEMS.length ? slice[slice.length - 1].video_id : '';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', videos: slice, total: TOP_ITEMS.length, next_cursor }),
      });
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
  await expect(page.locator('.media-card')).toHaveCount(1); // latest feed booted
}

test.describe('Top This Week infinite scroll', () => {
  test('scrolling pages through the full week to the oldest ranked item', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();

    // The highest-voted item leads.
    await expect(page.locator('.media-card[data-video-id="top_00"]')).toBeVisible();

    // Scroll until the last ranked item loads. The mock hands out ≤10 per
    // request, so top_24 can only appear after ≥3 cursor-linked pages.
    await expect(async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect(page.locator('.media-card[data-video-id="top_24"]')).toHaveCount(1);
    }).toPass({ timeout: 15000 });

    // Every ranked item present exactly once, in rank order — no gaps, no dupes.
    const ids = await page.locator('.media-card').evaluateAll((cards) =>
      cards.map((c) => c.dataset.videoId).filter((id) => id && id.startsWith('top_')));
    expect(ids.length).toBe(25);
    expect(new Set(ids).size).toBe(25);
    expect(ids).toEqual([...ids].sort());
  });

  test('switching back to Latest hides the top sentinel and restores the feed', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();
    await expect(page.locator('.media-card[data-video-id="top_00"]')).toBeVisible();

    await page.locator('.feed-tab', { hasText: 'Latest' }).click();
    await expect(page.locator('.media-card[data-video-id="lat_1"]')).toBeVisible();
    // The single-item latest feed is complete, so the sentinel stays hidden.
    await expect(page.locator('#load-more-container')).toBeHidden();
  });
});
