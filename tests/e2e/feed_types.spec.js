import { test, expect } from '@playwright/test';

test.describe('Mixed Media Feed (Videos & Articles)', () => {

  test.beforeEach(async ({ page }) => {
    // Clear localStorage to prevent cached data interfering
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    // Intercept Google Apps Script API calls
    await page.route('https://script.google.com/macros/s/*/exec?action=init', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', api_secret: 'mock-secret' })
      });
    });

    await page.route('https://script.google.com/macros/s/*/exec?action=feed*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          total: 2,
          page: 1,
          videos: [
            {
              video_id: 'vid123',
              media_type: 'video',
              channel_name: 'Test Tube',
              title: 'A Great Watch Video',
              url: 'https://youtube.com/watch?v=vid123',
              published_at: new Date(Date.now() - 100000).toISOString(),
              tier: 'T1',
              category: 'Review',
              comment_count: 5
            },
            {
              video_id: 'art456',
              media_type: 'article',
              channel_name: 'Worn & Wound',
              title: 'An In-Depth Article',
              url: 'https://wornandwound.com/article1',
              preview_image: 'https://wornandwound.com/images/1.jpg',
              published_at: new Date(Date.now() - 200000).toISOString(),
              tier: 'T1',
              category: 'Editorial',
              comment_count: 2
            }
          ]
        })
      });
    });

    // Mock comments route just in case
    await page.route('https://script.google.com/macros/s/*/exec?action=comments*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', comments: [] })
      });
    });
  });

  test('should render both video and article cards correctly', async ({ page }) => {
    // Start local server and navigate
    await page.goto('/');

    // Wait for feed skeleton to hide
    await expect(page.locator('#feed-skeleton')).toBeHidden({ timeout: 5000 });

    // Ensure 2 cards are rendered
    const cards = page.locator('.media-card, .video-card, .article-card');
    await expect(cards).toHaveCount(2);

    // Assert Video Card is rendered
    const videoCard = cards.nth(0);
    await expect(videoCard.locator('h3')).toContainText('A Great Watch Video');
    await expect(videoCard.locator('iframe[src*="vid123"]')).toBeVisible();
    await expect(videoCard.locator('.media-card__channel')).toContainText('Test Tube');

    // Assert Article Card is rendered
    const articleCard = cards.nth(1);
    await expect(articleCard.locator('h3')).toContainText('An In-Depth Article');
    await expect(articleCard.locator('.media-card__channel')).toContainText('Worn & Wound');
    
    // Check for article specific elements: image and "Read Article" button
    const previewImage = articleCard.locator('img[src="https://wornandwound.com/images/1.jpg"]');
    await expect(previewImage).toBeVisible();
    
    const readBtn = articleCard.locator('a:has-text("Read Article")');
    await expect(readBtn).toBeVisible();
    await expect(readBtn).toHaveAttribute('href', 'https://wornandwound.com/article1');
    await expect(readBtn).toHaveAttribute('target', '_blank');
  });

});
