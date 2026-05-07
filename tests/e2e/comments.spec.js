/**
 * E2E tests for the comment system
 * 
 * Tests comment thread rendering, reply flow, and depth limits.
 * Uses mocked API responses.
 */

import { test, expect } from '@playwright/test';

const MOCK_FEED = {
  status: 'ok',
  videos: [{
    video_id: 'comment_test_vid',
    channel_name: 'Test Channel',
    title: 'Test Video for Comments',
    url: 'https://www.youtube.com/watch?v=comment_test_vid',
    published_at: new Date().toISOString(),
    tier: 0,
    category: 'Test',
    comment_count: 3,
  }],
  total: 1,
  page: 1,
};

const MOCK_COMMENTS = {
  status: 'ok',
  comments: [
    {
      comment_id: 'c_001',
      video_id: 'comment_test_vid',
      parent_id: '',
      user_name: 'John D.',
      user_avatar: 'https://via.placeholder.com/28',
      body: 'Great review! I have been waiting for this.',
      depth: 0,
      created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    },
    {
      comment_id: 'c_002',
      video_id: 'comment_test_vid',
      parent_id: 'c_001',
      user_name: 'Jane S.',
      user_avatar: 'https://via.placeholder.com/28',
      body: 'Agreed, the finishing is amazing!',
      depth: 1,
      created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    },
    {
      comment_id: 'c_003',
      video_id: 'comment_test_vid',
      parent_id: '',
      user_name: 'Alex K.',
      user_avatar: 'https://via.placeholder.com/28',
      body: 'Does anyone know the retail price?',
      depth: 0,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  ],
};

test.describe('Comments', () => {
  test.beforeEach(async ({ page }) => {
    // Mock API endpoints
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
          body: JSON.stringify({ status: 'ok' }),
        });
      }
    });

    // Navigate to post detail
    await page.goto('/#/post/comment_test_vid');
  });

  test('shows the video embed in detail view', async ({ page }) => {
    const embed = page.locator('.detail-view__embed iframe');
    await expect(embed).toBeVisible();
    const src = await embed.getAttribute('src');
    expect(src).toContain('youtube-nocookie.com/embed/comment_test_vid');
  });

  test('renders comment threads', async ({ page }) => {
    await expect(page.locator('.comment-thread')).toHaveCount(2); // 2 top-level comments
  });

  test('shows correct comment count in header', async ({ page }) => {
    await expect(page.locator('#comments-header')).toContainText('Comments (3)');
  });

  test('displays user names in comments', async ({ page }) => {
    await expect(page.locator('.comment__author').first()).toContainText('John D.');
  });

  test('displays comment body text', async ({ page }) => {
    await expect(page.locator('.comment__text').first()).toContainText('Great review!');
  });

  test('renders nested reply under parent comment', async ({ page }) => {
    const thread = page.locator('.comment-thread').first();
    const replies = thread.locator('.comment-thread__replies .comment');
    await expect(replies).toHaveCount(1);
    await expect(replies.first()).toContainText('Agreed, the finishing');
  });

  test('depth-0 comments have Reply button', async ({ page }) => {
    const topLevelComment = page.locator('.comment--depth-0').first();
    await expect(topLevelComment.locator('.reply-btn')).toBeVisible();
  });

  test('depth-1 comments do NOT have Reply button', async ({ page }) => {
    const reply = page.locator('.comment--depth-1').first();
    await expect(reply.locator('.reply-btn')).toHaveCount(0);
  });

  test('clicking Reply opens inline reply form', async ({ page }) => {
    await page.locator('.reply-btn').first().click();
    // Reply form should appear (but may need auth)
    // Since user isn't signed in, we should see a toast
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
  });

  test('back button returns to feed', async ({ page }) => {
    await page.locator('#back-btn').click();
    await expect(page.locator('#feed-view')).toBeVisible();
    await expect(page.locator('#detail-view')).toBeHidden();
  });

  test('shows auth prompt for comment input when not signed in', async ({ page }) => {
    await expect(page.locator('#comment-auth-prompt')).toBeVisible();
    await expect(page.locator('#comment-form')).toBeHidden();
  });
});
