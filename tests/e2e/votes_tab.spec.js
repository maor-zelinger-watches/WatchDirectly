/**
 * E2E tests for the Top This Week tab and upvoting (mocked API)
 *
 * Covers: tab switching, top-week ranking render, vote sign-in gate,
 * and optimistic upvote toggle for a signed-in user.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const LATEST_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'lat_vid_1', channel_name: 'Teddy Baldassarre', title: 'Latest Video One', url: 'https://www.youtube.com/watch?v=lat_vid_1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 1 },
    { video_id: 'lat_vid_2', channel_name: 'Nico Leonard', title: 'Latest Video Two', url: 'https://www.youtube.com/watch?v=lat_vid_2', published_at: new Date(now - 5 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 0 },
  ],
  total: 2,
  page: 1,
};

const TOP_WEEK = {
  status: 'ok',
  videos: [
    { video_id: 'top_vid_hi', channel_name: 'Hodinkee', title: 'Most Upvoted This Week', url: 'https://www.youtube.com/watch?v=top_vid_hi', published_at: new Date(now - 3 * 24 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 42 },
    { video_id: 'top_vid_lo', channel_name: 'Jenni Elle', title: 'Second Best This Week', url: 'https://www.youtube.com/watch?v=top_vid_lo', published_at: new Date(now - 1 * 24 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0, vote_count: 8 },
  ],
  total: 2,
};

/** Routes that every test needs. `signedIn` seeds a fake Google session. */
async function setup(page, { signedIn = false } = {}) {
  await page.route('**/macros/**', async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.includes('action=feed')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LATEST_FEED) });
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

    // POST actions (vote / myVotes)
    if (req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* noop */ }

      if (body.action === 'bootstrap') {
        // Sign-in now reconciles votes + stars in one batched request.
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [], channels: [] }) });
      }
      if (body.action === 'myVotes') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [] }) });
      }
      if (body.action === 'vote') {
        // Echo a toggled-on vote, count bumped by 1 from the seed
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', voted: true, vote_count: 2 }) });
      }
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });

  if (signedIn) {
    // Seed a fake session so isSignedIn() is true without real Google auth.
    // Token payload carries a far-future exp so isTokenExpired() is false.
    await page.addInitScript(() => {
      const payload = btoa(JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', exp: Math.floor(Date.now() / 1000) + 3600 }));
      const fakeJwt = `h.${payload}.s`;
      localStorage.setItem('wd_user', JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', token: fakeJwt }));
    });
  }

  await page.goto('/');
  await expect(page.locator('.media-card')).toHaveCount(2);
}

test.describe('Top This Week tab', () => {
  test('renders both tabs with Latest active by default', async ({ page }) => {
    await setup(page);
    await expect(page.locator('.feed-tab', { hasText: 'Latest' })).toHaveClass(/feed-tab--active/);
    await expect(page.locator('.feed-tab', { hasText: 'Top This Week' })).not.toHaveClass(/feed-tab--active/);
  });

  test('switching to Top This Week loads the ranked list', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();

    await expect(page.locator('.media-card')).toHaveCount(2);
    // Highest-voted first
    await expect(page.locator('.media-card__title').first()).toContainText('Most Upvoted This Week');
    await expect(page.locator('.feed-tab', { hasText: 'Top This Week' })).toHaveClass(/feed-tab--active/);
  });

  test('top cards show their vote counts', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();

    const topVote = page.locator('.media-card[data-video-id="top_vid_hi"] .media-card__vote-count');
    await expect(topVote).toHaveText('42');
  });

  test('switching back to Latest restores the chronological feed', async ({ page }) => {
    await setup(page);
    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();
    await expect(page.locator('.media-card__title').first()).toContainText('Most Upvoted This Week');

    await page.locator('.feed-tab', { hasText: 'Latest' }).click();
    await expect(page.locator('.media-card__title').first()).toContainText('Latest Video One');
  });
});

test.describe('Upvoting', () => {
  test('every card has an upvote button', async ({ page }) => {
    await setup(page);
    await expect(page.locator('.media-card__vote')).toHaveCount(2);
  });

  test('clicking upvote while signed out shows a sign-in prompt and does not change the count', async ({ page }) => {
    await setup(page);
    const vote = page.locator('.media-card[data-video-id="lat_vid_1"] .media-card__vote');
    await vote.locator('.media-card__vote-count').first().waitFor();

    await vote.click();

    await expect(page.locator('.toast')).toContainText(/sign in/i);
    await expect(vote.locator('.media-card__vote-count')).toHaveText('1');
    await expect(vote).not.toHaveClass(/media-card__vote--active/);
  });

  test('signed-in user can upvote and the count updates from the server', async ({ page }) => {
    await setup(page, { signedIn: true });

    const vote = page.locator('.media-card[data-video-id="lat_vid_1"] .media-card__vote');
    await expect(vote.locator('.media-card__vote-count')).toHaveText('1');

    await vote.click();

    // Server echoes voted=true, vote_count=2
    await expect(vote).toHaveClass(/media-card__vote--active/);
    await expect(vote.locator('.media-card__vote-count')).toHaveText('2');
  });

  test('a vote cast after the search index is built shows in search results', async ({ page }) => {
    await setup(page, { signedIn: true });

    // Build the search index first (searching triggers it), then clear.
    // A no-match query is the completion signal: the empty message only
    // renders once the index build has finished (never on partial paints).
    await page.fill('#search-input', 'zzzznomatch');
    await expect(page.locator('#feed-empty')).toBeVisible();
    await page.fill('#search-input', '');
    await expect(page.locator('.media-card')).toHaveCount(2);

    // Vote in the normal feed — count goes 1 → 2.
    const vote = page.locator('.media-card[data-video-id="lat_vid_1"] .media-card__vote');
    await vote.click();
    await expect(vote.locator('.media-card__vote-count')).toHaveText('2');

    // Search again: the result card renders from the index copy, which must
    // carry the fresh count — not the value frozen at index-build time.
    await page.fill('#search-input', 'latest');
    const searchVote = page.locator('.media-card[data-video-id="lat_vid_1"] .media-card__vote');
    await expect(searchVote.locator('.media-card__vote-count')).toHaveText('2');
    await expect(searchVote).toHaveClass(/media-card__vote--active/);
  });
});
