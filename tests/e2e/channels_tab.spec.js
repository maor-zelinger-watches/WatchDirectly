/**
 * E2E tests for the Channels tab (mocked API, real creators.json)
 *
 * Covers: the 3-up channel grid rendering from creators.json, the signed-out
 * favorite gate, and the integration contract that starring a creator on the
 * Channels tab surfaces their videos on the Favorites tab.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

// Teddy and Nico both exist in the real creators.json, so a star toggled on a
// channel card can be checked against the Favorites feed built from this mock.
const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'ch_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Teddy Video', url: 'https://www.youtube.com/watch?v=ch_vid_a1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'ch_vid_b2', channel_name: 'Nico Leonard', title: 'Nico Video', url: 'https://www.youtube.com/watch?v=ch_vid_b2', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 2,
  page: 1,
};

async function setup(page, { signedIn = false, myStars = [] } = {}) {
  const stars = new Set(myStars);

  // Avatars are external (yt3.googleusercontent.com); abort them so the suite is
  // hermetic — the card's error handler drops the <img> and shows the monogram.
  await page.route('**/*.googleusercontent.com/**', (route) => route.abort());

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
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [], channels: [...stars] }) });
      }
      if (body.action === 'star') {
        const on = !stars.has(body.channel);
        if (on) stars.add(body.channel); else stars.delete(body.channel);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', starred: on }) });
      }
      if (body.action === 'myStars') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', channels: [...stars] }) });
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
  await expect(page.locator('.media-card')).toHaveCount(2);
}

/** Opens the Channels tab and waits for the grid to render. */
async function openChannels(page) {
  await page.locator('.feed-tab', { hasText: 'Channels' }).click();
  await expect(page.locator('.channel-card').first()).toBeVisible();
}

test.describe('Channels tab', () => {
  test('renders a card per creator, in the grid layout', async ({ page }) => {
    await setup(page);
    await openChannels(page);

    // One card per creator in creators.json (19 curated creators)
    const count = await page.locator('.channel-card').count();
    expect(count).toBeGreaterThanOrEqual(15);

    // The container is switched into the channels grid, and video controls hide
    await expect(page.locator('#feed-container')).toHaveClass(/feed--channels/);
    await expect(page.locator('#feed-controls')).toBeHidden();

    // Each card has a name and a favorite star
    const first = page.locator('.channel-card').first();
    await expect(first.locator('.channel-card__name')).toBeVisible();
    await expect(first.locator('.channel-card__star')).toBeVisible();
  });

  test('clicking a favorite star while signed out prompts to sign in', async ({ page }) => {
    await setup(page);
    await openChannels(page);

    await page.locator('.channel-card__star').first().click();

    await expect(page.locator('.toast')).toContainText(/sign in to favorite/i);
    await expect(page.locator('.channel-card__star--active')).toHaveCount(0);
  });

  test('favoriting a creator here surfaces their videos on the Favorites tab', async ({ page }) => {
    await setup(page, { signedIn: true, myStars: [] });
    await openChannels(page);

    // Favorite Nico Leonard from his channel card
    const nicoStar = page.locator('.channel-card', { hasText: 'Nico Leonard' }).locator('.channel-card__star');
    await nicoStar.click();
    await expect(nicoStar).toHaveText('★');

    // The Favorites feed now shows only Nico's video
    await page.locator('.feed-tab', { hasText: 'Favorites' }).click();
    await expect(page.locator('.media-card')).toHaveCount(1);
    await expect(page.locator('.media-card__channel')).toContainText('Nico Leonard');
  });

  test('signed-in favorites are pre-marked on the channel card', async ({ page }) => {
    await setup(page, { signedIn: true, myStars: ['Teddy Baldassarre'] });
    await openChannels(page);

    const teddyStar = page.locator('.channel-card', { hasText: 'Teddy Baldassarre' }).locator('.channel-card__star');
    await expect(teddyStar).toHaveClass(/media-card__star--active/);
    await expect(teddyStar).toHaveText('★');
  });

  test('switching back to Latest restores the video feed', async ({ page }) => {
    await setup(page);
    await openChannels(page);
    await expect(page.locator('#feed-container')).toHaveClass(/feed--channels/);

    await page.locator('.feed-tab', { hasText: 'Latest' }).click();
    await expect(page.locator('#feed-container')).not.toHaveClass(/feed--channels/);
    await expect(page.locator('.media-card')).toHaveCount(2);
    await expect(page.locator('#feed-controls')).toBeVisible();
  });
});
