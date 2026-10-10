/**
 * Installable app (PWA): the one spec that lets the service worker run.
 *
 * playwright.config.js blocks service workers for every other spec (a worker
 * answering same-origin requests would bypass their page.route() mocks). Here
 * the worker is allowed so the real sw.js installs, precaches the shell, and
 * then serves it with the network switched off.
 *
 * The backend is still mocked at the context level: sw.js never touches
 * cross-origin requests, so the /macros/ stub keeps seeing every API call and
 * nothing reaches the live Apps Script deployment.
 */
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

const EMPTY_FEED = { status: 'ok', videos: [], has_more: false };

test.describe('installable app', () => {
  test.beforeEach(async ({ context }) => {
    await context.route('**/macros/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(route.request().url().includes('action=feed')
        ? EMPTY_FEED
        : { status: 'ok', api_secret: 'test_secret' }),
    }));
  });

  test('index.html links a valid manifest whose icons are served', async ({ page }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');

    const res = await page.request.get(href);
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.name).toBe('How You Watch');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const img = await page.request.get(icon.src);
      expect(img.ok(), icon.src).toBe(true);
      expect(img.headers()['content-type'], icon.src).toContain('image/png');
    }
  });

  test('the service worker installs, precaches the shell under the app version, and controls the page after reload', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    const version = await page.locator('#app-version').textContent();
    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames).toContain(`hyw-shell-${version.replace(/^v/, '')}`);

    const cached = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    }, cacheNames.find((n) => n.startsWith('hyw-shell-')));
    expect(cached).toEqual(expect.arrayContaining(['/', '/css/style.css', '/js/app.js', '/js/config.js', '/js/pwa.js']));

    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  });

  test('the shell loads with the network off once the worker is in control', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    await context.setOffline(true);
    try {
      await page.reload();
      // The shell rendered from the precache: header, footer, version badge.
      await expect(page.locator('#header')).toBeVisible();
      await expect(page.locator('#app-version')).toHaveText(/^v\d+\.\d+\.\d+$/);
      // A deep link offline still resolves to the shell (ignoreSearch).
      await page.goto('/?v=offline_test');
      await expect(page.locator('#header')).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('the "Install app" footer link exists and stays hidden until the browser offers install', async ({ page }) => {
    await page.goto('/');
    const link = page.locator('#install-app');
    await expect(link).toHaveCount(1);
    await expect(link).toBeHidden();
  });
});
