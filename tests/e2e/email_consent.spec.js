/**
 * E2E tests for the sign-in overlay and the email-consent flow (mocked API)
 *
 * Covers: the header Sign in pill opening the overlay, the first-sign-in
 * consent prompt (bootstrap says never answered), explicit yes/no recording,
 * dismiss-records-nothing, no prompt for an answered account, and the
 * Email preferences view behind the header avatar.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'ec_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Teddy Video', url: 'https://www.youtube.com/watch?v=ec_vid_a1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'ec_vid_b2', channel_name: 'Nico Leonard', title: 'Nico Video', url: 'https://www.youtube.com/watch?v=ec_vid_b2', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 2,
  page: 1,
};

/**
 * Routes every test needs. `marketingConsent` is what the bootstrap reports
 * ('yes' | 'no' | null); consent POSTs land in `consentCalls`.
 */
async function setup(page, { signedIn = false, marketingConsent = null } = {}) {
  const consentCalls = [];
  let consent = marketingConsent;

  await page.route('**/macros/**', async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.includes('action=feed')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FEED) });
    }
    if (url.includes('action=comments')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [], byVideo: {} }) });
    }

    if (req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* noop */ }

      if (body.action === 'bootstrap') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [], channels: [], bookmark_ids: [], marketing_consent: consent }) });
      }
      if (body.action === 'emailConsent') {
        consentCalls.push(body.consent);
        consent = body.consent ? 'yes' : 'no';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', marketing_consent: consent }) });
      }
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });

  if (signedIn) {
    await page.addInitScript(() => {
      const payload = btoa(JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', exp: Math.floor(Date.now() / 1000) + 3600 }));
      const fakeJwt = `h.${payload}.s`;
      localStorage.setItem('wd_user', JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', token: fakeJwt }));
    });
  }

  await page.goto('/');
  await expect(page.locator('.media-card')).toHaveCount(2);
  return consentCalls;
}

const overlay = (page) => page.locator('#auth-overlay');
const dialog = (page) => page.locator('.auth-overlay__dialog');

test.describe('Sign-in overlay', () => {
  test('signed out: the header shows our Sign in pill, which opens the overlay', async ({ page }) => {
    await setup(page);

    const pill = page.locator('#signin-btn');
    await expect(pill).toBeVisible();
    await expect(overlay(page)).toBeHidden();

    await pill.click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('#auth-overlay-title')).toHaveText(/sign in/i);
    await expect(page.locator('#auth-overlay-gsi')).toBeAttached();
  });

  test('Escape closes the overlay without any consent write', async ({ page }) => {
    const calls = await setup(page);
    await page.locator('#signin-btn').click();
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(overlay(page)).toBeHidden();
    expect(calls).toEqual([]);
  });
});

test.describe('First-sign-in consent prompt', () => {
  test('a signed-in account that never answered gets the question in the overlay', async ({ page }) => {
    await setup(page, { signedIn: true, marketingConsent: null });

    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('#auth-overlay-title')).toHaveText(/one more thing/i);
    await expect(page.locator('[data-consent="yes"]')).toBeVisible();
    await expect(page.locator('[data-consent="no"]')).toBeVisible();
  });

  test('"Yes, email me" records consent:true, closes, and confirms', async ({ page }) => {
    const calls = await setup(page, { signedIn: true, marketingConsent: null });

    await page.locator('[data-consent="yes"]').click();

    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.toast')).toContainText(/on the list/i);
    expect(calls).toEqual([true]);
  });

  test('"No thanks" records an explicit consent:false', async ({ page }) => {
    const calls = await setup(page, { signedIn: true, marketingConsent: null });

    await page.locator('[data-consent="no"]').click();

    await expect(overlay(page)).toBeHidden();
    expect(calls).toEqual([false]);
  });

  test('dismissing the prompt records nothing', async ({ page }) => {
    const calls = await setup(page, { signedIn: true, marketingConsent: null });

    await page.locator('.auth-overlay__close').click();
    await expect(overlay(page)).toBeHidden();
    expect(calls).toEqual([]);
  });

  test('an account that already answered is never prompted', async ({ page }) => {
    await setup(page, { signedIn: true, marketingConsent: 'yes' });

    // Give a would-be prompt time to (not) appear.
    await page.waitForTimeout(600);
    await expect(overlay(page)).toBeHidden();
  });
});

test.describe('Email preferences (the unsubscribe path)', () => {
  test('the header avatar opens preferences showing the current choice', async ({ page }) => {
    await setup(page, { signedIn: true, marketingConsent: 'yes' });

    await page.locator('#email-prefs-btn').click();
    await expect(page.locator('#auth-overlay-title')).toHaveText(/email preferences/i);
    await expect(page.locator('.auth-overlay__copy')).toContainText(/on the list/i);
    await expect(page.locator('[data-consent="yes"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('switching to "No emails" unsubscribes with one explicit write', async ({ page }) => {
    const calls = await setup(page, { signedIn: true, marketingConsent: 'yes' });

    await page.locator('#email-prefs-btn').click();
    await page.locator('[data-consent="no"]').click();

    await expect(overlay(page)).toBeHidden();
    expect(calls).toEqual([false]);

    // Reopening reflects the new state.
    await page.locator('#email-prefs-btn').click();
    await expect(page.locator('.auth-overlay__copy')).toContainText(/not receiving/i);
    await expect(page.locator('[data-consent="no"]')).toHaveAttribute('aria-pressed', 'true');
  });
});
