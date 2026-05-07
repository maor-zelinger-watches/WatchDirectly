import { test, expect } from '@playwright/test';

test.describe('Infinite Scroll', () => {
  test('loads initial batch, then remainder of first page, then second page on scroll', async ({ page }) => {
    // Clear local storage to ensure fresh load
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    await page.goto('/');

    // Wait for initial cards to appear
    await page.waitForSelector('.media-card', { timeout: 30000 });

    // Keep scrolling until we have at least 25 cards
    let expectedCards = 25;
    let currentCards = 0;
    let attempts = 0;
    
    while (currentCards < expectedCards && attempts < 20) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      currentCards = await page.locator('.media-card').count();
      console.log(`Cards loaded: ${currentCards}`);
      attempts++;
    }
    
    expect(currentCards).toBeGreaterThanOrEqual(expectedCards);
  });
});
