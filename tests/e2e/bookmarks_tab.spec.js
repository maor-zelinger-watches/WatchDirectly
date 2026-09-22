/**
 * E2E tests for item bookmarking and the Bookmarks tab (mocked API)
 *
 * Covers: the bookmark button on every card, sign-in gate, optimistic
 * toggle + server reconcile, the Bookmarks tab filtering to the signed-in
 * user's saved items (newest first), the empty state, and the signed-out
 * prompt. Mirrors starred_tab.spec.js — bookmarks are the stars pattern
 * applied to items.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'bm_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Teddy Video', url: 'https://www.youtube.com/watch?v=bm_vid_a1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'bm_vid_b2', channel_name: 'Nico Leonard', title: 'Nico Video', url: 'https://www.youtube.com/watch?v=bm_vid_b2', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'bm_vid_c3', channel_name: 'Jenni Elle', title: 'Jenni Video', url: 'https://www.youtube.com/watch?v=bm_vid_c3', published_at: new Date(now - 6 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 3,
  page: 1,
};

/** Routes every test needs. `signedIn` seeds a fake Google session. */
async function setup(page, { signedIn = false, myBookmarks = ['bm_vid_a1', 'bm_vid_c3'] } = {}) {
  // Stateful bookmark store mirrors the real handleBookmark toggle contract:
  // bookmark returns bookmarked:false when toggling an existing bookmark off.
  const bookmarks = new Set(myBookmarks);

  await page.route('**/macros/**', async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.includes('action=feed')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FEED) });
    }
    if (url.includes('action=commentsBatch')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', byVideo: {} }) });
    }
    if (url.includes('action=comments')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [] }) });
    }

    if (req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* noop */ }

      if (body.action === 'bootstrap') {
        // Sign-in reconciles votes + stars + bookmarks in one batched request.
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [], channels: [], bookmark_ids: [...bookmarks] }) });
      }
      if (body.action === 'bookmark') {
        const on = !bookmarks.has(body.videoId);
        if (on) bookmarks.add(body.videoId); else bookmarks.delete(body.videoId);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', bookmarked: on }) });
      }
      if (body.action === 'myBookmarks') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', bookmark_ids: [...bookmarks] }) });
      }
      if (body.action === 'myVotes') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [] }) });
      }
      if (body.action === 'myStars') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', channels: [] }) });
      }
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });

  if (signedIn) {
    await page.addInitScript(() => {
      const payload = btoa(JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', exp: Math.floor(Date.now() / 1000) + 3600 }));
      const fakeJwt = `h.${payload}.s`;
      localStorage.setItem('wd_user', JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', token: fakeJwt }));
    });
  }

  await page.goto('/');
  await expect(page.locator('.media-card')).toHaveCount(3);
}

test.describe('Bookmarking items', () => {
  test('every card has a bookmark button with the flat icon in its action bar', async ({ page }) => {
    await setup(page);
    await expect(page.locator('.media-card__bookmark')).toHaveCount(3);
    await expect(page.locator('.media-card__bookmark svg.icon--bookmark')).toHaveCount(3);
  });

  test('clicking bookmark while signed out shows a sign-in prompt', async ({ page }) => {
    await setup(page);
    await page.locator('.media-card[data-video-id="bm_vid_b2"] .media-card__bookmark').click();

    await expect(page.locator('.toast')).toContainText(/sign in/i);
    await expect(page.locator('.media-card__bookmark--active')).toHaveCount(0);
  });

  test('signed-in bookmarks are marked on load', async ({ page }) => {
    await setup(page, { signedIn: true });

    await expect(page.locator('.media-card__bookmark--active')).toHaveCount(2);
    await expect(page.locator('.media-card[data-video-id="bm_vid_b2"] .media-card__bookmark')).not.toHaveClass(/media-card__bookmark--active/);
  });

  test('a signed-in user can bookmark and un-bookmark an item', async ({ page }) => {
    await setup(page, { signedIn: true, myBookmarks: [] });
    const btn = page.locator('.media-card[data-video-id="bm_vid_b2"] .media-card__bookmark');

    await btn.click();
    await expect(btn).toHaveClass(/media-card__bookmark--active/);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');

    await btn.click();
    await expect(btn).not.toHaveClass(/media-card__bookmark--active/);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Bookmarks tab', () => {
  test('shows a sign-in prompt when signed out', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Bookmarks' }).click();

    await expect(page.locator('.media-card')).toHaveCount(0);
    await expect(page.locator('#feed-empty')).toContainText(/sign in/i);
  });

  test('shows only bookmarked items, newest first', async ({ page }) => {
    await setup(page, { signedIn: true });
    await page.locator('.feed-tab', { hasText: 'Bookmarks' }).click();

    await expect(page.locator('.media-card')).toHaveCount(2);
    const ids = await page.$$eval('.media-card', els => els.map(e => e.dataset.videoId));
    expect(ids).toEqual(['bm_vid_a1', 'bm_vid_c3']); // 2h ago before 6h ago
  });

  test('invites the action when nothing is bookmarked yet', async ({ page }) => {
    await setup(page, { signedIn: true, myBookmarks: [] });
    await page.locator('.feed-tab', { hasText: 'Bookmarks' }).click();

    await expect(page.locator('.media-card')).toHaveCount(0);
    await expect(page.locator('#feed-empty')).toContainText(/no bookmarks yet/i);
  });

  test('un-bookmarking inside the tab removes the card from the list', async ({ page }) => {
    await setup(page, { signedIn: true });
    await page.locator('.feed-tab', { hasText: 'Bookmarks' }).click();
    await expect(page.locator('.media-card')).toHaveCount(2);

    await page.locator('.media-card[data-video-id="bm_vid_c3"] .media-card__bookmark').click();

    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card[data-video-id="bm_vid_a1"]')).toBeVisible();
  });

  test('switching back to Latest restores the full feed', async ({ page }) => {
    await setup(page, { signedIn: true });
    await page.locator('.feed-tab', { hasText: 'Bookmarks' }).click();
    await expect(page.locator('.media-card')).toHaveCount(2);

    await page.locator('.feed-tab', { hasText: 'Latest' }).click();
    await expect(page.locator('.media-card')).toHaveCount(3);
  });
});
