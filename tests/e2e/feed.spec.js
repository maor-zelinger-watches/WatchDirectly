/**
 * E2E tests for the feed view (mocked API)
 * 
 * Tests card rendering, comment counts, and inline comment toggle.
 * No tier badges or filter tabs in the UI.
 */

import { test, expect } from '@playwright/test';

const MOCK_FEED = {
  status: 'ok',
  videos: [
    {
      video_id: 'test_vid_1',
      channel_name: 'Teddy Baldassarre',
      title: 'Top 10 Watches Under $500 in 2026',
      url: 'https://www.youtube.com/watch?v=test_vid_1',
      published_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      tier: 0,
      category: 'The Heavyweights & Entertainment',
      comment_count: 5,
    },
    {
      video_id: 'test_vid_2',
      channel_name: 'Nico Leonard',
      title: 'Reacting to $1M Watch Collections',
      url: 'https://www.youtube.com/watch?v=test_vid_2',
      published_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      tier: 0,
      category: 'The Heavyweights & Entertainment',
      comment_count: 12,
    },
    {
      video_id: 'test_vid_3',
      channel_name: 'Just One More Watch',
      title: 'Best Budget Watches 2026',
      url: 'https://www.youtube.com/watch?v=test_vid_3',
      published_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      tier: 1,
      category: 'The Affordable & "Value" Kings',
      comment_count: 0,
    },
  ],
  total: 3,
  page: 1,
};

const MOCK_COMMENTS = {
  status: 'ok',
  comments: [
    {
      comment_id: 'c_001',
      video_id: 'test_vid_1',
      parent_id: '',
      user_name: 'John D.',
      user_avatar: 'https://via.placeholder.com/28',
      body: 'Great review! I have been waiting for this.',
      depth: 0,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    },
    {
      comment_id: 'c_002',
      video_id: 'test_vid_1',
      parent_id: 'c_001',
      user_name: 'Jane S.',
      user_avatar: 'https://via.placeholder.com/28',
      body: 'Agreed, the finishing is amazing!',
      depth: 1,
      created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    },
  ],
};

test.describe('Feed View', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/macros/**', async (route) => {
      const url = route.request().url();
      if (url.includes('action=feed')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_FEED),
        });
      } else if (url.includes('action=comments')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_COMMENTS),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', api_secret: 'test_secret' }),
        });
      }
    });

    await page.goto('/');
  });

  test('renders feed cards after loading', async ({ page }) => {
    await expect(page.locator('.media-card')).toHaveCount(3);
  });

  test('each card has a YouTube iframe embed', async ({ page }) => {
    const iframes = page.locator('.media-card__embed iframe');
    await expect(iframes).toHaveCount(3);
    const src = await iframes.first().getAttribute('src');
    expect(src).toContain('youtube-nocookie.com/embed/test_vid_1');
  });

  test('cards show channel name and time ago', async ({ page }) => {
    const firstCard = page.locator('.media-card').first();
    await expect(firstCard.locator('.media-card__channel')).toContainText('Teddy Baldassarre');
    await expect(firstCard.locator('.media-card__time')).toBeVisible();
  });

  test('cards do NOT show tier badges', async ({ page }) => {
    const tierBadge = page.locator('.media-card__tier');
    await expect(tierBadge).toHaveCount(0);
  });

  test('no filter tabs in the page', async ({ page }) => {
    const filterTabs = page.locator('.filter-tabs');
    await expect(filterTabs).toHaveCount(0);
  });

  test('cards show comment count toggle button', async ({ page }) => {
    const firstCard = page.locator('.media-card').first();
    await expect(firstCard.locator('.media-card__comments-toggle')).toContainText('5 comments');
  });

  test('comments section is hidden by default', async ({ page }) => {
    const body = page.locator('.media-card__comments-body').first();
    await expect(body).toBeHidden();
  });

  test('clicking comments toggle expands inline comments', async ({ page }) => {
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const body = page.locator('.media-card__comments-body').first();
    await expect(body).toBeVisible();
  });

  test('expanded comments load from API', async ({ page }) => {
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const commentThread = page.locator('.media-card').first().locator('.comment-thread');
    await expect(commentThread).toHaveCount(1); // 1 top-level comment
  });

  test('expanded comments show comment text', async ({ page }) => {
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const comment = page.locator('.media-card').first().locator('.comment__text').first();
    await expect(comment).toContainText('Great review');
  });

  test('expanded comments show nested replies', async ({ page }) => {
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const reply = page.locator('.media-card').first().locator('.comment--depth-1');
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText('Agreed, the finishing');
  });

  test('clicking toggle again collapses comments', async ({ page }) => {
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();
    await expect(page.locator('.media-card__comments-body').first()).toBeVisible();

    await toggle.click();
    await expect(page.locator('.media-card__comments-body').first()).toBeHidden();
  });

  test('shows auth prompt for comment input when not signed in', async ({ page }) => {
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const authPrompt = page.locator('.media-card__auth-prompt').first();
    await expect(authPrompt).toBeVisible();
  });
});
