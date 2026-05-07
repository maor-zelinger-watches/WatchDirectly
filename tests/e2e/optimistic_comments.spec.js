import { test, expect } from '@playwright/test';

const MOCK_FEED = {
  status: 'success',
  videos: [
    {
      video_id: 'test_vid_1',
      title: 'Test Video 1',
      channel_id: 'UCtest1',
      channel_name: 'Test Channel 1',
      published_at: new Date().toISOString(),
      tier: 1,
      category: 'Reviews',
      comment_count: 0
    }
  ],
  total: 1,
  page: 1,
  limit: 20
};

test.describe('Optimistic UI Comments', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));

    // Mock the feed API
    await page.route('**/exec?action=feed*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_FEED)
      });
    });

    // Mock the comments API (empty initially)
    await page.route('**/exec?action=comments*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ comments: [] })
      });
    });

    // Mock the init API (needed for HMAC signing)
    await page.route('**/exec?action=init', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', api_secret: 'test-secret' })
      });
    });

    // Mock Google Auth by injecting into localStorage
    await page.addInitScript(() => {
      localStorage.setItem('wd_user', JSON.stringify({
        name: 'Test User',
        email: 'test@example.com',
        picture: 'https://ui-avatars.com/api/?name=Test+User',
        token: 'fake_token'
      }));
    });

    await page.goto('/');
  });

  test('successful comment post (optimistic -> resolved)', async ({ page }) => {
    // Delay the POST request so we can see the optimistic state
    await page.route('**/exec', async (route, request) => {
      if (request.method() === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'ok', comment_id: 'real_id_123' })
        });
      } else {
        await route.fallback();
      }
    });

    // Open comments
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    // Type and submit comment
    const textarea = page.locator('.media-card__textarea').first();
    await textarea.fill('This is an optimistic comment!');
    
    const submitBtn = page.locator('.media-card__comment-form button[type="submit"]').first();
    await submitBtn.click();

    // Verify textarea is cleared immediately
    await expect(textarea).toHaveValue('');

    // Verify optimistic comment appears immediately
    const commentsList = page.locator('.media-card__comments-list').first();
    const newComment = commentsList.locator('.comment').first();
    
    await expect(newComment).toContainText('This is an optimistic comment!');
    await expect(newComment).toHaveClass(/comment--optimistic/);
    
    // Reply button should NOT exist while optimistic
    await expect(newComment.locator('.comment__reply-btn')).toHaveCount(0);

    // Wait for the mock API to resolve and check that it transitioned to real comment
    await expect(newComment).not.toHaveClass(/comment--optimistic/);
    await expect(newComment.locator('.comment__reply-btn')).toBeVisible();
    await expect(newComment).toHaveAttribute('data-comment-id', 'real_id_123');
  });

  test('failed comment post (optimistic -> rollback)', async ({ page }) => {
    // Fail the POST request to trigger rollback
    await page.route('**/exec', async (route, request) => {
      if (request.method() === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'error', message: 'Failed to save' }),
        });
      } else {
        await route.fallback();
      }
    });

    // Open comments
    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    // Type and submit comment
    const textarea = page.locator('.media-card__textarea').first();
    const commentText = 'This comment will fail.';
    await textarea.fill(commentText);

    const submitBtn = page.locator('.media-card__comment-form button[type="submit"]').first();
    await submitBtn.click();

    // Verify optimistic comment appears immediately
    const commentsList = page.locator('.media-card__comments-list').first();
    await expect(commentsList.locator('.comment')).toHaveCount(1, { timeout: 2000 });

    // Wait for network failure + rollback (500ms mock delay + processing)
    // The rollback removes the entire .comment-thread, so the comment count drops to 0
    await expect(commentsList.locator('.comment')).toHaveCount(0, { timeout: 5000 });

    // The text should be restored to the textarea
    await expect(textarea).toHaveValue(commentText, { timeout: 2000 });

    // Toast should appear
    const toast = page.locator('.toast--error');
    await expect(toast).toBeVisible({ timeout: 2000 });
  });
});
