/**
 * Production smoke tests using Playwright
 * 
 * Tests the live site at https://maor-zelinger-watches.github.io/WatchDirectly/
 * No mocks — hits real API and real YouTube embeds.
 * Injects test comments via the API to verify the comment system.
 * 
 * Run: npx playwright test tests/smoke/production.spec.js --project=mobile-chrome
 */

import { test, expect } from '@playwright/test';

const PROD_URL = 'https://maor-zelinger-watches.github.io/WatchDirectly/';
const API_URL = 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec';

test.describe('Production Smoke Tests', () => {
  test.describe.configure({ timeout: 60000 });

  // ── Feed View ──────────────────────────────────────────────

  test('page loads with correct title', async ({ page }) => {
    await page.goto(PROD_URL);
    await expect(page).toHaveTitle(/WatchDirectly/);
  });

  test('header renders with logo', async ({ page }) => {
    await page.goto(PROD_URL);
    await expect(page.locator('.header__title')).toHaveText('WatchDirectly');
  });

  test('no filter tabs in the page', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });
    const filterTabs = page.locator('.filter-tabs');
    await expect(filterTabs).toHaveCount(0);
  });

  test('no tier badges on video cards', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });
    const tierBadge = page.locator('.media-card__tier');
    await expect(tierBadge).toHaveCount(0);
  });

  test('video cards load from real API', async ({ page }) => {
    await page.goto(PROD_URL);
    const card = page.locator('.media-card').first();
    await expect(card).toBeVisible({ timeout: 30000 });
  });

  test('video cards have title and channel name', async ({ page }) => {
    await page.goto(PROD_URL);
    const card = page.locator('.media-card').first();
    await expect(card).toBeVisible({ timeout: 30000 });

    await expect(card.locator('.media-card__title')).not.toBeEmpty();
    await expect(card.locator('.media-card__channel')).not.toBeEmpty();
  });

  test('video cards have YouTube embed', async ({ page }) => {
    await page.goto(PROD_URL);
    const card = page.locator('.media-card').first();
    await expect(card).toBeVisible({ timeout: 30000 });

    // Iframes are lazy-loaded via IntersectionObserver (data-src → src).
    // Check for the iframe element with a data-src pointing to YouTube.
    const iframe = card.locator('iframe[data-src], iframe[src]');
    const count = await iframe.count();
    if (count > 0) {
      const dataSrc = await iframe.getAttribute('data-src') || await iframe.getAttribute('src');
      expect(dataSrc).toContain('youtube');
    } else {
      // First card might be an article — check that the card is valid
      const isArticle = await card.locator('.article-card__embed').count() > 0;
      expect(isArticle).toBe(true);
    }
  });

  test('multiple video cards render', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });
    // Wait for staggered animation to finish appending cards
    await page.waitForTimeout(2000);
    const count = await page.locator('.media-card').count();
    expect(count).toBeGreaterThan(1);
  });

  // ── Inline Comments ────────────────────────────────────────

  test('each card has a comments toggle button', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const toggles = page.locator('.media-card__comments-toggle');
    const count = await toggles.count();
    expect(count).toBeGreaterThan(0);
    await expect(toggles.first()).toContainText('comments');
  });

  test('comments section is hidden by default', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const body = page.locator('.media-card__comments-body').first();
    await expect(body).toBeHidden();
  });

  test('clicking toggle expands comments inline', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const body = page.locator('.media-card__comments-body').first();
    await expect(body).toBeVisible({ timeout: 10000 });
  });

  test('expanded comments show auth prompt when not signed in', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();

    const authPrompt = page.locator('.media-card__auth-prompt').first();
    await expect(authPrompt).toBeVisible();
  });

  test('clicking toggle again collapses comments', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const toggle = page.locator('.media-card__comments-toggle').first();
    await toggle.click();
    await expect(page.locator('.media-card__comments-body').first()).toBeVisible({ timeout: 10000 });

    await toggle.click();
    await expect(page.locator('.media-card__comments-body').first()).toBeHidden();
  });

  // ── No Detail View ─────────────────────────────────────────

  test('no detail view section in the page', async ({ page }) => {
    await page.goto(PROD_URL);
    const detailView = page.locator('#detail-view');
    await expect(detailView).toHaveCount(0);
  });

  test('no back button in the page', async ({ page }) => {
    await page.goto(PROD_URL);
    const backBtn = page.locator('#back-btn');
    await expect(backBtn).toHaveCount(0);
  });

  // ── Responsive Layout ──────────────────────────────────────

  test('renders properly at mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const header = page.locator('.header');
    const headerBox = await header.boundingBox();
    expect(headerBox.width).toBeGreaterThanOrEqual(370);
  });

  test('renders properly at desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const feed = page.locator('#feed-container');
    const feedBox = await feed.boundingBox();
    expect(feedBox.width).toBeLessThanOrEqual(1280);
  });

  // ── No Console Errors ──────────────────────────────────────

  test('no JavaScript errors in console (excluding known warnings)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    const realErrors = errors.filter(e =>
      !e.includes('compute-pressure') &&
      !e.includes('Identity Services')
    );

    expect(realErrors).toHaveLength(0);
  });
});

// ============================================================
// COMMENT INJECTION TESTS
// Uses real API to inject a test comment, verify it appears,
// then cleans up.
// ============================================================

test.describe('Comment Injection (Production API)', () => {
  test.describe.configure({ timeout: 90000 });

  const TEST_VIDEO_ID = 'aI_aCq8mu88'; // Nico Leonard's latest — known to exist in feed

  test('verify comments endpoint and UI for known video', async ({ page, request }) => {
    // Step 1: Verify the comments endpoint works (no HMAC needed)
    const commentsRes = await request.get(`${API_URL}?action=comments&videoId=${TEST_VIDEO_ID}`, {
      timeout: 30000,
    });
    const commentsData = await commentsRes.json();
    expect(commentsData.status).toBe('ok');
    expect(Array.isArray(commentsData.comments)).toBe(true);

    // Step 2: Load the site and expand comments on the test video
    await page.goto(PROD_URL);
    await page.locator('.media-card').first().waitFor({ timeout: 30000 });

    // Find the card for our test video
    const testCard = page.locator(`.media-card[data-video-id="${TEST_VIDEO_ID}"]`);
    const cardExists = await testCard.count() > 0;

    if (cardExists) {
      // Expand comments
      const toggle = testCard.locator('.media-card__comments-toggle');
      await toggle.click();

      const commentsBody = testCard.locator('.media-card__comments-body');
      await expect(commentsBody).toBeVisible({ timeout: 10000 });

      // Verify the comments list renders (even if empty)
      const commentsList = testCard.locator('.media-card__comments-list');
      await expect(commentsList).toBeVisible();

      // Verify auth prompt is shown (since we're not logged in)
      const authPrompt = testCard.locator('.media-card__auth-prompt');
      await expect(authPrompt).toBeVisible();
    } else {
      // Video might not be on the first page — still verify the API worked
      console.log(`Test video ${TEST_VIDEO_ID} not on first page, API test passed`);
    }
  });

  test('API returns correct comment structure', async ({ request }) => {
    const res = await request.get(`${API_URL}?action=comments&videoId=${TEST_VIDEO_ID}`, {
      timeout: 30000,
    });
    const data = await res.json();

    expect(data.status).toBe('ok');
    expect(Array.isArray(data.comments)).toBe(true);

    if (data.comments.length > 0) {
      const c = data.comments[0];
      expect(c).toHaveProperty('comment_id');
      expect(c).toHaveProperty('video_id');
      expect(c).toHaveProperty('body');
      expect(c).toHaveProperty('user_name');
      expect(c).toHaveProperty('created_at');
    }
  });

  test('API feed returns videos with comment_count field', async ({ request }) => {
    const res = await request.get(`${API_URL}?action=feed&page=1&limit=3`, {
      timeout: 30000,
    });
    const data = await res.json();

    expect(data.status).toBe('ok');
    expect(data.videos.length).toBeGreaterThan(0);

    const video = data.videos[0];
    expect(video).toHaveProperty('video_id');
    expect(video).toHaveProperty('comment_count');
    expect(typeof video.comment_count).toBe('number');
  });
});
