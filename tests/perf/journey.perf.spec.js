/**
 * PERF: full user journeys — the tests closest to what a session feels like.
 *
 * 13. The whole flow in one go: load -> scroll -> filter -> switch tab ->
 *     back -> expand a card -> exit -> search. Each stage is timed
 *     independently so a regression shows up as a specific slow stage.
 * 14. Optimistic vote + comments toggle mid-scroll — the count flips before
 *     the server answers; comments open quickly.
 * 16. The same journey on a throttled "slow phone" (4x CPU, slow network).
 */

import { test, expect } from '@playwright/test';
import { installMocks, signIn, makeItems, timed, sleep, scrollToBottom } from './helpers.js';

const chip = (page, label) =>
  page.locator('#category-chips .chip', { hasText: new RegExp(`^${label}$`) });
const tab = (page, label) => page.locator('.feed-tab', { hasText: label });
const mixed = (i) => (i % 4 === 0 ? 'article' : i % 4 === 1 ? 'short' : 'video');

/**
 * Runs the canonical journey and returns per-stage timings (ms).
 * Budgets are supplied by the caller so the mobile variant can relax them.
 */
async function runJourney(page) {
  const stages = {};

  // Stage 1 — cold load.
  stages.load = (
    await timed(async () => {
      await page.goto('/', { waitUntil: 'commit' });
      await page.locator('.media-card').first().waitFor({ state: 'visible' });
    })
  ).ms;

  // Stage 2 — scroll a few pages.
  stages.scroll = (
    await timed(async () => {
      let count = 0;
      for (let i = 0; i < 5 && count < 30; i++) {
        await scrollToBottom(page);
        await sleep(300);
        count = await page.locator('.media-card').count();
      }
    })
  ).ms;

  // Stage 3 — apply a content-type filter (pure CSS).
  stages.filter = (
    await timed(async () => {
      await chip(page, 'Videos').click();
      await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    })
  ).ms;

  // Stage 4 — switch to Top. The Videos filter is still active, so assert on
  // the first VISIBLE card (what the user sees), not a filtered-out article.
  stages.tabTop = (
    await timed(async () => {
      await tab(page, 'Top This Week').click();
      await expect(page.locator('.media-card:visible').first()).toBeVisible();
    })
  ).ms;

  // Stage 5 — back to Latest.
  stages.tabBack = (
    await timed(async () => {
      await tab(page, 'Latest').click();
      await expect(page.locator('.media-card:visible').first()).toBeVisible();
    })
  ).ms;

  // Stage 6 — expand a card to fullscreen, then exit.
  stages.fullscreen = (
    await timed(async () => {
      const target = page.locator('.media-card:visible').first();
      await target.locator('.media-card__expand').click();
      await expect(page.locator('body')).toHaveClass(/fullscreen-mode/);
      await page.keyboard.press('Escape');
      await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/);
    })
  ).ms;

  // Stage 7 — search.
  stages.search = (
    await timed(async () => {
      await page.locator('#search-input').focus();
      await page.fill('#search-input', 'Omega');
      await expect
        .poll(() => page.locator('.media-card').count(), { timeout: 2500 })
        .toBeGreaterThan(0);
    })
  ).ms;

  return stages;
}

test.describe('PERF · journeys', () => {
  test('T13 full journey — every interaction stays snappy', async ({ page }) => {
    await installMocks(page, { items: makeItems(80, mixed), topWeek: makeItems(12, mixed) });

    const s = await runJourney(page);
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    console.log('[T13] stage timings (ms):', JSON.stringify(s), '=> total', total);

    // Overall budget for the whole journey…
    expect(total).toBeLessThan(9000);

    // …and every individual stage must also be reasonable on its own.
    expect(s.load).toBeLessThan(2500);
    expect(s.scroll).toBeLessThan(3000);
    expect(s.filter).toBeLessThan(400);
    expect(s.tabTop).toBeLessThan(1500);
    expect(s.tabBack).toBeLessThan(800);
    expect(s.fullscreen).toBeLessThan(1000);
    expect(s.search).toBeLessThan(1200);
  });

  test('T14 optimistic vote + comments toggle', async ({ page }) => {
    // Vote POST hangs 2s — the count must flip optimistically well before it.
    await installMocks(page, { items: makeItems(20), voteDelay: 2000, clearStorage: false });
    await signIn(page);
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10000 });

    const voteBtn = page.locator('.media-card__vote').first();
    const countEl = voteBtn.locator('.media-card__vote-count');
    const before = parseInt((await countEl.textContent())?.trim() || '0', 10);

    const vote = await timed(async () => {
      await voteBtn.click();
      await expect(countEl).toHaveText(String(before + 1), { timeout: 800 });
    });
    console.log(`[T14] optimistic vote reflected in ${vote.ms}ms (server still hanging)`);
    expect(vote.ms).toBeLessThan(600); // optimistic, before the 2s response

    const toggle = page.locator('.media-card__comments-toggle').first();
    const comments = await timed(async () => {
      await toggle.click();
      await expect(page.locator('.media-card__comments-body').first()).toBeVisible();
    });
    console.log(`[T14] comments opened in ${comments.ms}ms`);
    expect(comments.ms).toBeLessThan(800);
  });

  test('T16 journey on a throttled slow phone', async ({ page }) => {
    test.skip(page.context().browser().browserType().name() !== 'chromium', 'CDP throttling is chromium-only');

    await installMocks(page, { items: makeItems(80, mixed), topWeek: makeItems(12, mixed) });

    // Emulate a mid-tier phone: 4x CPU slowdown + Slow-4G-ish network.
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });

    const s = await runJourney(page);
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    console.log('[T16] throttled stage timings (ms):', JSON.stringify(s), '=> total', total);

    // Relaxed overall budget for a throttled device — still must not feel broken…
    expect(total).toBeLessThan(16000);

    // …with per-stage ceilings scaled for the slower device.
    expect(s.load).toBeLessThan(6000);
    expect(s.filter).toBeLessThan(1000);
    expect(s.tabTop).toBeLessThan(3500);
    expect(s.tabBack).toBeLessThan(1500);
    expect(s.fullscreen).toBeLessThan(2000);
    expect(s.search).toBeLessThan(2500);
  });
});
