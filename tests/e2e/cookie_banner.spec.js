/**
 * Cookie banner (js/analytics.js) in a real browser: shown on first visit,
 * gtag.js only requested after Accept, the choice sticks across reloads, and
 * the footer "Cookies" link reopens it. Google's servers are stubbed — this
 * checks our consent gating and the CSP, not GA itself.
 */
import { test, expect } from '@playwright/test';

// Opt out of the config-wide pre-answered consent: these specs need a first visit.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  await page.route('https://www.googletagmanager.com/**', r =>
    r.fulfill({ contentType: 'text/javascript', body: 'window.__gtagLoaded = true;' }));
});

test('first visit shows the banner and requests nothing from Google', async ({ page }) => {
  const gtagRequests = [];
  page.on('request', r => { if (r.url().includes('googletagmanager.com')) gtagRequests.push(r.url()); });
  await page.goto('/privacy.html');
  await expect(page.locator('.cookie-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
  expect(gtagRequests).toEqual([]);
});

test('Accept loads gtag.js under the CSP and is remembered', async ({ page }) => {
  const cspErrors = [];
  page.on('console', m => { if (/Content Security Policy/.test(m.text())) cspErrors.push(m.text()); });
  await page.goto('/privacy.html');
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('.cookie-banner')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__gtagLoaded)).toBe(true);

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__gtagLoaded)).toBe(true);
  await expect(page.locator('.cookie-banner')).toHaveCount(0);
  expect(cspErrors).toEqual([]);
});

test('Reject is remembered and the footer Cookies link reopens the banner', async ({ page }) => {
  await page.goto('/privacy.html');
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.locator('.cookie-banner')).toBeHidden();

  await page.reload();
  await expect(page.locator('.cookie-banner')).toHaveCount(0);
  expect(await page.evaluate(() => window.__gtagLoaded)).toBeUndefined();

  await page.locator('footer [data-cookie-settings]').click();
  await expect(page.locator('.cookie-banner')).toBeVisible();
});
