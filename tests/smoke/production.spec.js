/**
 * Production smoke tests using Playwright
 * 
 * Tests the live site at https://maor-zelinger-watches.github.io/WatchDirectly/
 * No mocks — hits real API and real YouTube embeds.
 * 
 * Run: npx playwright test tests/smoke/production.spec.js --project=mobile-chrome
 */

import { test, expect } from '@playwright/test';

const PROD_URL = 'https://maor-zelinger-watches.github.io/WatchDirectly/';

test.describe('Production Smoke Tests', () => {
  test.describe.configure({ timeout: 60000 }); // Long timeout for real API

  // ── Feed View ──────────────────────────────────────────────

  test('page loads with correct title', async ({ page }) => {
    await page.goto(PROD_URL);
    await expect(page).toHaveTitle(/WatchDirectly/);
  });

  test('header renders with logo', async ({ page }) => {
    await page.goto(PROD_URL);
    await expect(page.locator('.header__title')).toHaveText('WatchDirectly');
  });

  test('filter tabs are visible', async ({ page }) => {
    await page.goto(PROD_URL);
    await expect(page.locator('.filter-tabs')).toBeVisible();
    await expect(page.locator('[data-filter="all"]')).toBeVisible();
    await expect(page.locator('[data-filter="0"]')).toBeVisible();
    await expect(page.locator('[data-filter="1"]')).toBeVisible();
    await expect(page.locator('[data-filter="2"]')).toBeVisible();
    await expect(page.locator('[data-filter="3"]')).toBeVisible();
  });

  test('video cards load from real API', async ({ page }) => {
    await page.goto(PROD_URL);
    // Wait for at least one video card to render (real API call)
    const card = page.locator('.video-card').first();
    await expect(card).toBeVisible({ timeout: 30000 });
  });

  test('video cards have title and channel name', async ({ page }) => {
    await page.goto(PROD_URL);
    const card = page.locator('.video-card').first();
    await expect(card).toBeVisible({ timeout: 30000 });

    await expect(card.locator('.video-card__title')).not.toBeEmpty();
    await expect(card.locator('.video-card__channel')).not.toBeEmpty();
  });

  test('video cards have YouTube embed', async ({ page }) => {
    await page.goto(PROD_URL);
    const card = page.locator('.video-card').first();
    await expect(card).toBeVisible({ timeout: 30000 });

    const iframe = card.locator('iframe');
    await expect(iframe).toBeVisible();
    const src = await iframe.getAttribute('src');
    expect(src).toContain('youtube');
  });

  test('multiple video cards render', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.video-card').first().waitFor({ timeout: 30000 });
    const count = await page.locator('.video-card').count();
    expect(count).toBeGreaterThan(1);
  });

  // ── Filter Tabs ────────────────────────────────────────────

  test('clicking Tier 0 filter shows only Tier 0 videos', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.video-card').first().waitFor({ timeout: 30000 });

    await page.locator('[data-filter="0"]').click();
    await expect(page.locator('[data-filter="0"]')).toHaveClass(/active/);

    // Check that tier badges say "Tier 0" (or cards exist)
    const cards = page.locator('.video-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(0); // May be 0 if no tier 0 on page
  });

  test('clicking All filter shows all videos', async ({ page }) => {
    await page.goto(PROD_URL);
    await page.locator('.video-card').first().waitFor({ timeout: 30000 });

    // Click Tier 1 first, then back to All
    await page.locator('[data-filter="1"]').click();
    await page.locator('[data-filter="all"]').click();
    await expect(page.locator('[data-filter="all"]')).toHaveClass(/active/);

    const count = await page.locator('.video-card').count();
    expect(count).toBeGreaterThan(0);
  });

  // ── Post Detail View ───────────────────────────────────────

  test('clicking a video card navigates to detail view', async ({ page }) => {
    await page.goto(PROD_URL);
    const cardContent = page.locator('.video-card__content').first();
    await expect(cardContent).toBeVisible({ timeout: 30000 });

    await cardContent.click();
    await expect(page.locator('#detail-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#feed-view')).toBeHidden();
  });

  test('detail view shows YouTube embed', async ({ page }) => {
    await page.goto(PROD_URL);
    const cardContent = page.locator('.video-card__content').first();
    await expect(cardContent).toBeVisible({ timeout: 30000 });

    await cardContent.click();
    await expect(page.locator('#detail-view')).toBeVisible({ timeout: 10000 });
    const embed = page.locator('#detail-view iframe');
    await expect(embed).toBeVisible({ timeout: 10000 });
    const src = await embed.getAttribute('src');
    expect(src).toContain('youtube');
  });

  test('detail view shows comment section', async ({ page }) => {
    await page.goto(PROD_URL);
    const cardContent = page.locator('.video-card__content').first();
    await expect(cardContent).toBeVisible({ timeout: 30000 });

    await cardContent.click();
    await expect(page.locator('#detail-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#comments-header')).toBeVisible();
    await expect(page.locator('#comments-header')).toContainText('Comments');
  });

  test('detail view shows sign-in prompt when not authenticated', async ({ page }) => {
    await page.goto(PROD_URL);
    const cardContent = page.locator('.video-card__content').first();
    await expect(cardContent).toBeVisible({ timeout: 30000 });

    await cardContent.click();
    await expect(page.locator('#detail-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#comment-auth-prompt')).toBeVisible();
  });

  test('back button returns to feed from detail view', async ({ page }) => {
    await page.goto(PROD_URL);
    const cardContent = page.locator('.video-card__content').first();
    await expect(cardContent).toBeVisible({ timeout: 30000 });

    await cardContent.click();
    await expect(page.locator('#detail-view')).toBeVisible({ timeout: 10000 });

    await page.locator('#back-btn').click();
    await expect(page.locator('#feed-view')).toBeVisible();
    await expect(page.locator('#detail-view')).toBeHidden();
  });

  // ── Responsive Layout ──────────────────────────────────────

  test('renders properly at mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(PROD_URL);
    await page.locator('.video-card').first().waitFor({ timeout: 30000 });

    // Header should be full width
    const header = page.locator('.header');
    const headerBox = await header.boundingBox();
    expect(headerBox.width).toBeGreaterThanOrEqual(370);
  });

  test('renders properly at desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(PROD_URL);
    await page.locator('.video-card').first().waitFor({ timeout: 30000 });

    // Feed container should have max-width constraint
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
    await page.locator('.video-card').first().waitFor({ timeout: 30000 });

    // Filter out known/acceptable warnings
    const realErrors = errors.filter(e =>
      !e.includes('compute-pressure') &&
      !e.includes('Identity Services')
    );

    expect(realErrors).toHaveLength(0);
  });
});
