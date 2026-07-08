/**
 * PERF: full user journeys — the tests closest to what a session feels like.
 *
 * 13. The whole flow in one go: load -> scroll -> filter -> switch tab ->
 *     back -> expand a card -> exit -> search. Each stage carries its own
 *     latency budget, expressed as the `timeout` on a native web-first
 *     assertion: if the UI hasn't visibly responded within the budget, the
 *     assertion fails and points at the exact slow stage.
 * 14. Optimistic vote + comments toggle mid-scroll — the count flips before
 *     the server answers; comments open quickly.
 * 16. The same journey on a throttled "slow phone" (4x CPU, slow network).
 *
 * Budgets are enforced ONLY through native assertion timeouts — no manual
 * Date.now() stopwatch. The timeout IS the budget.
 */

import { test, expect } from '@playwright/test';
import { installMocks, signIn, makeItems, scrollToBottom } from './helpers.js';

const chip = (page, label) =>
  page.locator('#category-chips .chip', { hasText: new RegExp(`^${label}$`) });
const tab = (page, label) => page.locator('.feed-tab', { hasText: label });
const mixed = (i) => (i % 4 === 0 ? 'article' : i % 4 === 1 ? 'short' : 'video');

/**
 * Runs the canonical journey. Each stage asserts the UI has responded within
 * `budgets[stage]` ms via a native assertion timeout. `budgets` is supplied by
 * the caller so the throttled variant can relax the ceilings.
 */
async function runJourney(page, budgets) {
  // Stage 1 — cold load: first card visible within budget.
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('.media-card').first()).toBeVisible({ timeout: budgets.load });

  // Stage 2 — scroll until ~30 cards have rendered, within budget. toPass
  // re-scrolls each attempt (infinite scroll needs the sentinel re-triggered)
  // and its timeout is the stage budget.
  await expect(async () => {
    await scrollToBottom(page);
    expect(await page.locator('.media-card').count()).toBeGreaterThanOrEqual(30);
  }).toPass({ timeout: budgets.scroll });

  // Stage 3 — apply a content-type filter (pure CSS): chip goes active.
  await chip(page, 'Videos').click();
  await expect(chip(page, 'Videos')).toHaveClass(/chip--active/, { timeout: budgets.filter });

  // Stage 4 — switch to Top. The Videos filter is still active, so assert on
  // the first VISIBLE card (what the user sees), not a filtered-out article.
  await tab(page, 'Top This Week').click();
  await expect(page.locator('.media-card:visible').first()).toBeVisible({ timeout: budgets.tabTop });

  // Stage 5 — back to Latest.
  await tab(page, 'Latest').click();
  await expect(page.locator('.media-card:visible').first()).toBeVisible({ timeout: budgets.tabBack });

  // Stage 6 — expand a card to fullscreen, then exit. Enter and exit each get
  // the fullscreen budget.
  const target = page.locator('.media-card:visible').first();
  await target.locator('.media-card__expand').click();
  await expect(page.locator('body')).toHaveClass(/fullscreen-mode/, { timeout: budgets.fullscreen });
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/fullscreen-mode/, { timeout: budgets.fullscreen });

  // Stage 7 — search: results render within budget.
  await page.locator('#search-input').focus();
  await page.fill('#search-input', 'Omega');
  await expect(page.locator('.media-card:visible').first()).toBeVisible({ timeout: budgets.search });
}

test.describe('PERF · journeys', () => {
  test('T13 full journey — every interaction stays snappy', async ({ page }) => {
    await installMocks(page, { items: makeItems(80, mixed), topWeek: makeItems(12, mixed) });

    await runJourney(page, {
      load: 2500,
      scroll: 3000,
      filter: 1500,
      tabTop: 1500,
      tabBack: 800,
      fullscreen: 1000,
      search: 1200,
    });
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

    // Optimistic: the count reflects the vote within 600ms — long before the
    // 2s server response. The timeout is the budget.
    await voteBtn.click();
    await expect(countEl).toHaveText(String(before + 1), { timeout: 600 });

    // Comments open quickly.
    await page.locator('.media-card__comments-toggle').first().click();
    await expect(page.locator('.media-card__comments-body').first()).toBeVisible({ timeout: 800 });
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

    // Per-stage ceilings scaled for the slower device.
    await runJourney(page, {
      load: 6000,
      scroll: 8000,
      filter: 1000,
      tabTop: 3500,
      tabBack: 1500,
      fullscreen: 2000,
      search: 2500,
    });
  });
});
