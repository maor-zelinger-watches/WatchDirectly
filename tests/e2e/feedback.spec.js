/**
 * E2E tests for the floating "Send feedback" button and its dialog (mocked API)
 *
 * Covers: no button while signed out, the button sitting above the footer
 * once signed in, the dialog opening with its ✕ and Submit, closing via ✕ /
 * Escape without a write, the empty-message guard, a send carrying the
 * session token, and a backend error keeping the draft.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'fb_vid_a1', channel_name: 'Teddy Baldassarre', title: 'Teddy Video', url: 'https://www.youtube.com/watch?v=fb_vid_a1', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'fb_vid_b2', channel_name: 'Nico Leonard', title: 'Nico Video', url: 'https://www.youtube.com/watch?v=fb_vid_b2', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 2,
  page: 1,
};

/** Routes every test needs; feedback POST bodies land in the returned array. */
async function setup(page, { signedIn = false, fail = false } = {}) {
  const sends = [];

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
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', video_ids: [], channels: [], bookmark_ids: [], marketing_consent: 'no' }) });
      }
      if (body.action === 'feedback') {
        sends.push(body);
        if (fail) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Too much feedback right now, please try again in a minute' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', feedback_id: 'f1' }) });
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
  return sends;
}

const fab = (page) => page.locator('#feedback-fab');
const overlay = (page) => page.locator('#feedback-overlay');
const dialog = (page) => page.locator('.feedback-overlay__dialog');
const textarea = (page) => page.locator('#feedback-message');

test.describe('Feedback button', () => {
  test('signed out: there is no feedback button', async ({ page }) => {
    await setup(page);
    await expect(page.locator('#signin-btn')).toBeVisible();
    await expect(fab(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();
  });

  test('signed in: floats bottom-right above the footer and opens the dialog', async ({ page }) => {
    await setup(page, { signedIn: true });

    await expect(fab(page)).toBeVisible();
    const box = await fab(page).boundingBox();
    const viewport = page.viewportSize();
    const footer = await page.locator('#footer').boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y); // never under the footer
    expect(box.x).toBeGreaterThan(viewport.width / 2);        // right-hand side

    await expect(overlay(page)).toBeHidden();
    await fab(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('#feedback-title')).toHaveText(/send feedback/i);
    await expect(page.locator('.feedback-overlay__close')).toBeVisible();
    await expect(page.locator('#feedback-submit')).toBeVisible();
    await expect(textarea(page)).toBeFocused();
  });

  test('✕ and Escape close it without sending anything', async ({ page }) => {
    const sends = await setup(page, { signedIn: true });

    await fab(page).click();
    await textarea(page).fill('draft');
    await page.locator('.feedback-overlay__close').click();
    await expect(overlay(page)).toBeHidden();

    await fab(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(textarea(page)).toHaveValue('draft'); // the draft survives a close
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toBeHidden();

    expect(sends).toEqual([]);
  });

  test('an empty message is not sent', async ({ page }) => {
    const sends = await setup(page, { signedIn: true });
    await fab(page).click();
    await page.locator('#feedback-submit').click();
    await expect(page.locator('.toast')).toContainText(/write something/i);
    await expect(dialog(page)).toBeVisible();
    expect(sends).toEqual([]);
  });

  test('sends the message with the session token, names the sender, closes and thanks', async ({ page }) => {
    const sends = await setup(page, { signedIn: true });

    await fab(page).click();
    await expect(page.locator('#feedback-identity')).toContainText('t@example.com');
    await textarea(page).fill('  The Shorts chip hides articles too  ');
    await page.locator('#feedback-submit').click();

    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.toast')).toContainText(/thanks/i);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ action: 'feedback', message: 'The Shorts chip hides articles too' });
    expect(typeof sends[0].token).toBe('string');
    expect(sends[0].token.length).toBeGreaterThan(0);
    expect(sends[0].page).toContain('localhost');
    expect(sends[0].appVersion).toMatch(/^\d+\.\d+\.\d+$/);

    // The box is empty for the next one.
    await fab(page).click();
    await expect(textarea(page)).toHaveValue('');
  });

  test('signing out hides the button again', async ({ page }) => {
    await setup(page, { signedIn: true });
    await expect(fab(page)).toBeVisible();
    await page.locator('#signout-btn').click();
    await expect(page.locator('#signin-btn')).toBeVisible();
    await expect(fab(page)).toBeHidden();
    await expect(overlay(page)).toBeHidden();
  });

  test('a backend error keeps the dialog and the draft, and shows the message', async ({ page }) => {
    const sends = await setup(page, { signedIn: true, fail: true });

    await fab(page).click();
    await textarea(page).fill('keep me');
    await page.locator('#feedback-submit').click();

    await expect(page.locator('.toast--error')).toContainText(/too much feedback/i);
    await expect(dialog(page)).toBeVisible();
    await expect(textarea(page)).toHaveValue('keep me');
    await expect(page.locator('#feedback-submit')).toBeEnabled();
    expect(sends).toHaveLength(1);
  });
});
