/**
 * E2E: lazy iframe promotion (mocked API)
 *
 * Cards render their embed into data-src; the IntersectionObserver
 * promotes it to a real src only when the card nears the viewport. This
 * pins down that a below-the-fold player stays deferred, then loads once
 * scrolled into view — the behavior single-play relies on to register
 * players, and the one that looked flaky against the live feed.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

// Many long-form videos so plenty sit below the fold on either viewport.
const MOCK_FEED = {
  status: 'ok',
  videos: Array.from({ length: 16 }, (_, i) => ({
    video_id: `lz_vid_${String(i).padStart(2, '0')}0`.slice(0, 11),
    media_type: 'video',
    channel_name: 'Lazy Test Channel',
    title: `Lazy Video ${i}`,
    url: `https://www.youtube.com/watch?v=lz_vid_${i}`,
    published_at: new Date(now - (i + 1) * 3600 * 1000).toISOString(),
    category: 'Reviews',
    comment_count: 0,
  })),
  total: 16,
  page: 1,
};

test.describe('Lazy iframe promotion', () => {
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

    // Don't let real YouTube network load; the src attribute still flips.
    await page.route('https://www.youtube-nocookie.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' })
    );

    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(16);
  });

  test('the first card promotes on load, a below-the-fold card stays deferred', async ({ page }) => {
    // First card is on screen → its iframe gets a real src.
    await expect(page.locator('.media-card').first().locator('iframe')).toHaveAttribute(
      'src', /youtube-nocookie\.com\/embed\//
    );

    // The last card is far below the fold → still data-src, no src yet.
    const lastFrame = page.locator('.media-card').last().locator('iframe');
    await expect(lastFrame).toHaveAttribute('data-src', /youtube-nocookie\.com\/embed\//);
    expect(await lastFrame.getAttribute('src')).toBeNull();
  });

  test('a below-the-fold card promotes once scrolled into view', async ({ page }) => {
    const lastCard = page.locator('.media-card').last();
    const lastFrame = lastCard.locator('iframe');

    // Precondition: deferred.
    expect(await lastFrame.getAttribute('src')).toBeNull();

    await lastCard.scrollIntoViewIfNeeded();

    // Now promoted: src set, data-src cleared.
    await expect(lastFrame).toHaveAttribute('src', /youtube-nocookie\.com\/embed\//);
    expect(await lastFrame.getAttribute('data-src')).toBeNull();
  });
});

test.describe('Lazy iframe promotion after revalidation', () => {
  // Seeds the feed cache, then serves a fresh page 1 that DIFFERS (a
  // changed comment count) so revalidateFeed runs its DOM diff — the live
  // path where promotion looked flaky. Survivor cards keep their nodes and
  // observers; this asserts a below-the-fold survivor still promotes after
  // the diff.
  // A fresh feed with one brand-new video prepended — a structural change
  // that forces the diff to insert a card, so we can assert unambiguously
  // that revalidation ran before checking promotion.
  const NEW_VIDEO = {
    video_id: 'lz_new_0001',
    media_type: 'video',
    channel_name: 'Lazy Test Channel',
    title: 'Freshly revalidated',
    url: 'https://www.youtube.com/watch?v=lz_new_0001',
    published_at: new Date(now).toISOString(),
    category: 'Reviews',
    comment_count: 0,
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((feed) => {
      window.localStorage.clear();
      window.localStorage.setItem('wd_feed_cache', JSON.stringify({ videos: feed.videos, total: feed.total }));
    }, MOCK_FEED);

    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        const fresh = { status: 'ok', videos: [NEW_VIDEO, ...MOCK_FEED.videos], total: 17, page: 1 };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fresh) });
      }
      if (url.includes('action=commentsBatch')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', byVideo: {} }) });
      }
      if (url.includes('action=comments')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [] }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
    });

    await page.route('https://www.youtube-nocookie.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' })
    );

    await page.goto('/');
    // Cache renders 16; revalidation diff then inserts the new card → 17.
    await expect(page.locator('.media-card')).toHaveCount(17);
  });

  test('a below-the-fold card still promotes on scroll after a revalidation diff', async ({ page }) => {
    const lastCard = page.locator('.media-card').last();
    const lastFrame = lastCard.locator('iframe');

    expect(await lastFrame.getAttribute('src')).toBeNull();

    await lastCard.scrollIntoViewIfNeeded();

    await expect(lastFrame).toHaveAttribute('src', /youtube-nocookie\.com\/embed\//);
    expect(await lastFrame.getAttribute('data-src')).toBeNull();
  });
});
