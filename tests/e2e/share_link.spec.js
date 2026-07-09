/**
 * E2E tests for sharing a specific video (mocked API)
 *
 * The share button copies (or natively shares) `?v=<video_id>`; opening such
 * a link lands in the fullscreen watch-and-discuss overlay for that video.
 * A video missing from the feed (aged into the archive) is fetched via the
 * `video` action and mounted as a temporary card in #deeplink-container,
 * which exiting fullscreen removes again.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: Array.from({ length: 4 }, (_, i) => ({
    video_id: `sh_vid_${i}000`,
    channel_name: 'Teddy Baldassarre',
    title: `Share Test Video ${i}`,
    url: `https://www.youtube.com/watch?v=sh_vid_${i}000`,
    published_at: new Date(now - (i + 1) * 3600 * 1000).toISOString(),
    category: 'Reviews',
    comment_count: 0,
  })),
  total: 4,
  page: 1,
};

// Lives only in the archive — never appears in the feed response.
const ARCHIVED_VIDEO = {
  video_id: 'sh_arch_000',
  channel_name: 'Hodinkee',
  title: 'An Archived Classic',
  url: 'https://www.youtube.com/watch?v=sh_arch_000',
  published_at: new Date(now - 300 * 24 * 3600 * 1000).toISOString(),
  category: 'Reviews',
  comment_count: 0,
};

function mockApi(page) {
  return page.route('**/macros/**', async (route) => {
    const url = route.request().url();
    const json = (body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('action=feed')) return json(MOCK_FEED);
    if (url.includes('action=video')) {
      const videoId = new URL(url).searchParams.get('videoId');
      const inFeed = MOCK_FEED.videos.find((v) => v.video_id === videoId);
      if (inFeed) return json({ status: 'ok', video: inFeed });
      if (videoId === ARCHIVED_VIDEO.video_id) return json({ status: 'ok', video: ARCHIVED_VIDEO });
      return json({ status: 'ok', video: null });
    }
    if (url.includes('action=commentsBatch')) return json({ status: 'ok', byVideo: {} });
    if (url.includes('action=comments')) return json({ status: 'ok', comments: [] });
    return json({ status: 'ok' });
  });
}

test.describe('Share links', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test('every card has a share button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#feed-container .media-card')).toHaveCount(4);
    await expect(page.locator('#feed-container .media-card__share')).toHaveCount(4);
  });

  test('the share button copies a ?v= link and toasts', async ({ page }) => {
    // Force the clipboard fallback and capture the copy — navigator.share
    // exists on the mobile-chrome project and would open a real sheet.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (text) => { window.__copied = text; return Promise.resolve(); } },
        configurable: true,
      });
    });
    await page.goto('/');
    await expect(page.locator('#feed-container .media-card')).toHaveCount(4);

    await page.locator('.media-card[data-video-id="sh_vid_2000"] .media-card__share').click();

    await expect(page.locator('.toast--success')).toHaveText('Link copied');
    const copied = await page.evaluate(() => window.__copied);
    expect(new URL(copied).searchParams.get('v')).toBe('sh_vid_2000');
  });

  test('opening a shared link lands in fullscreen on that video', async ({ page }) => {
    await page.goto('/?v=sh_vid_1000');

    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);
    const overlay = page.locator('.media-card--fullscreen');
    await expect(overlay).toHaveAttribute('data-video-id', 'sh_vid_1000');
    // Watch-and-discuss: comments open automatically.
    await expect(overlay.locator('.media-card__comments-body')).toBeVisible();
    // The link survives a refresh while the overlay is open.
    expect(new URL(page.url()).searchParams.get('v')).toBe('sh_vid_1000');
  });

  test('a link to an archived video mounts a temporary card and cleans it up on exit', async ({ page }) => {
    await page.goto(`/?v=${ARCHIVED_VIDEO.video_id}`);

    const overlay = page.locator('.media-card--fullscreen');
    await expect(overlay).toHaveAttribute('data-video-id', ARCHIVED_VIDEO.video_id);
    await expect(overlay).toHaveText(/An Archived Classic/);
    // Mounted outside the feed so revalidation/dedupe never see it.
    await expect(page.locator('#deeplink-container .media-card')).toHaveCount(1);

    await page.keyboard.press('Escape');

    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    // Temp card removed, ?v= stripped, the normal feed is what remains.
    await expect(page.locator('#deeplink-container .media-card')).toHaveCount(0);
    await expect(page.locator('#feed-container .media-card')).toHaveCount(4);
    expect(new URL(page.url()).searchParams.get('v')).toBeNull();
  });

  test('exiting a deep link into a feed video leaves exactly one card for it', async ({ page }) => {
    await page.goto('/?v=sh_vid_1000');
    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);
    await expect(page.locator('#feed-container .media-card')).toHaveCount(4);

    await page.keyboard.press('Escape');

    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    await expect(page.locator('.media-card[data-video-id="sh_vid_1000"]')).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get('v')).toBeNull();
  });

  test('a deep link to a cached video reuses the painted card, and exit still strips ?v=', async ({ page }) => {
    // Seed the page-1 feed cache so the card is painted before handleDeepLink
    // runs — the fast path, no `video` action fetch, no temp card.
    await page.addInitScript((feed) => {
      localStorage.setItem('wd_feed_cache', JSON.stringify({ videos: feed.videos, total: feed.total }));
    }, MOCK_FEED);

    await page.goto('/?v=sh_vid_1000');

    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);
    const overlay = page.locator('.media-card--fullscreen');
    await expect(overlay).toHaveAttribute('data-video-id', 'sh_vid_1000');
    // The painted feed card was reused — nothing mounted outside the feed.
    await expect(page.locator('#deeplink-container .media-card')).toHaveCount(0);

    await page.keyboard.press('Escape');

    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    expect(new URL(page.url()).searchParams.get('v')).toBeNull();
  });

  test('a link to a deleted video toasts and falls back to the feed', async ({ page }) => {
    await page.goto('/?v=gone_vid_00');

    await expect(page.locator('.toast--error')).toHaveText('That video is no longer available');
    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    await expect(page.locator('#feed-container .media-card')).toHaveCount(4);
    expect(new URL(page.url()).searchParams.get('v')).toBeNull();
  });
});
