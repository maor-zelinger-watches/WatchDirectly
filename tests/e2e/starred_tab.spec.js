/**
 * E2E tests for creator starring and the Starred tab (mocked API)
 *
 * Covers: star button toggle, sign-in gate, Starred tab filtering
 * to the signed-in user's starred creators, and the signed-out prompt.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'star_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Teddy Video', url: 'https://www.youtube.com/watch?v=star_vid_a1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'star_vid_b2', channel_name: 'Nico Leonard', title: 'Nico Video', url: 'https://www.youtube.com/watch?v=star_vid_b2', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'star_vid_c3', channel_name: 'Teddy Baldassarre', title: 'Another Teddy Video', url: 'https://www.youtube.com/watch?v=star_vid_c3', published_at: new Date(now - 6 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 3,
  page: 1,
};

/** Routes every test needs. `signedIn` seeds a fake Google session. */
async function setup(page, { signedIn = false, myStars = ['Teddy Baldassarre'] } = {}) {
  // Stateful star store mirrors the real handleStar toggle contract:
  // star returns starred:false when toggling an existing star off.
  const stars = new Set(myStars);

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

      if (body.action === 'myStars') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', channels: [...stars] }) });
      }
      if (body.action === 'star') {
        const on = !stars.has(body.channel);
        if (on) stars.add(body.channel); else stars.delete(body.channel);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', starred: on }) });
      }
      if (body.action === 'myVotes') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [] }) });
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

test.describe('Starring creators', () => {
  test('every card has a star button next to the channel name', async ({ page }) => {
    await setup(page);
    await expect(page.locator('.media-card__star')).toHaveCount(3);
  });

  test('clicking star while signed out shows a sign-in prompt', async ({ page }) => {
    await setup(page);
    await page.locator('.media-card[data-video-id="star_vid_b2"] .media-card__star').click();

    await expect(page.locator('.toast')).toContainText(/sign in/i);
    await expect(page.locator('.media-card__star--active')).toHaveCount(0);
  });

  test('signed-in stars are marked on load, on every card of the channel', async ({ page }) => {
    await setup(page, { signedIn: true });

    // Both Teddy cards carry the starred state; Nico's does not
    await expect(page.locator('.media-card__star--active')).toHaveCount(2);
    await expect(page.locator('.media-card[data-video-id="star_vid_b2"] .media-card__star')).not.toHaveClass(/media-card__star--active/);
  });

  test('a signed-in user can star a creator', async ({ page }) => {
    await setup(page, { signedIn: true, myStars: [] });
    const star = page.locator('.media-card[data-video-id="star_vid_b2"] .media-card__star');

    await star.click();

    await expect(star).toHaveClass(/media-card__star--active/);
    await expect(star).toHaveText('★');
  });

  test('unstarring toggles the star back off (server returns starred:false)', async ({ page }) => {
    await setup(page, { signedIn: true });
    // Teddy is starred at load; both his cards show the active state
    const star = page.locator('.media-card[data-video-id="star_vid_a1"] .media-card__star');
    await expect(star).toHaveClass(/media-card__star--active/);

    await star.click();

    await expect(star).not.toHaveClass(/media-card__star--active/);
    await expect(star).toHaveText('☆');
    // The other Teddy card reflects the change too
    await expect(page.locator('.media-card[data-video-id="star_vid_c3"] .media-card__star')).not.toHaveClass(/media-card__star--active/);
  });
});

test.describe('Starred tab', () => {
  test('shows a sign-in prompt when signed out', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Starred' }).click();

    await expect(page.locator('.media-card')).toHaveCount(0);
    await expect(page.locator('#feed-empty')).toContainText(/sign in/i);
  });

  test('shows only videos from starred creators', async ({ page }) => {
    await setup(page, { signedIn: true });
    await page.locator('.feed-tab', { hasText: 'Starred' }).click();

    await expect(page.locator('.media-card')).toHaveCount(2);
    const channels = await page.$$eval('.media-card__channel', els => els.map(e => e.textContent));
    for (const c of channels) expect(c).toContain('Teddy Baldassarre');
  });

  test('prompts to star creators when none are starred yet', async ({ page }) => {
    await setup(page, { signedIn: true, myStars: [] });
    await page.locator('.feed-tab', { hasText: 'Starred' }).click();

    await expect(page.locator('.media-card')).toHaveCount(0);
    await expect(page.locator('#feed-empty')).toContainText(/no starred creators/i);
  });

  test('switching back to Latest restores the full feed', async ({ page }) => {
    await setup(page, { signedIn: true });
    await page.locator('.feed-tab', { hasText: 'Starred' }).click();
    await expect(page.locator('.media-card')).toHaveCount(2);

    await page.locator('.feed-tab', { hasText: 'Latest' }).click();
    await expect(page.locator('.media-card')).toHaveCount(3);
  });

  test('unstarring from a fullscreen card exits fullscreen instead of freezing the page', async ({ page }) => {
    await setup(page, { signedIn: true });
    await page.locator('.feed-tab', { hasText: 'Starred' }).click();
    await expect(page.locator('.media-card')).toHaveCount(2);

    // Expand a starred card, then unstar it from inside the overlay — the
    // re-render would otherwise destroy the overlay and leave body locked.
    const card = page.locator('.media-card[data-video-id="star_vid_a1"]');
    await card.locator('.media-card__expand').click();
    await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);

    await card.locator('.media-card__star').click();

    // Cleanly exited fullscreen; page is scrollable again, not frozen
    await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    await expect(page.locator('.media-card--fullscreen')).toHaveCount(0);
    // The unstar took effect: only the other starred creator's video remains
    await expect(page.locator('.media-card')).toHaveCount(0);
  });
});
