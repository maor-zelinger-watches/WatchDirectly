/**
 * Storage-engine flag — end to end (mocked backend).
 *
 * localStorage 'wd_storage_engine' picks where the big cache snapshots live:
 * 'legacy' (default) = localStorage, exactly as production runs today;
 * 'idb' = IndexedDB. These tests pin the contract a rollout depends on:
 *
 *   - the default is legacy, and legacy never opens IndexedDB — not at boot,
 *     not while searching, not on any tab (the kill switch);
 *   - ?storage= flips it and survives the next visit;
 *   - a flip is per page load: another tab flipping it doesn't change a
 *     running tab, and nothing errors when two tabs disagree;
 *   - a broken IndexedDB or a blocked localStorage degrades to "no cache",
 *     never to a broken page.
 */

import { test, expect } from '@playwright/test';
import { installMocks, makeItems } from '../perf/helpers.js';
import {
  FLAG_KEY, setStorageMode, countStorageOpens, storageOpens, hangIndexedDB,
  idbSnapshot, localSnapshot, collectPageErrors,
} from '../perf/storage-helpers.js';

const FEED = 'wd_feed_cache';
const INDEX = 'wd_search_index';

/** installMocks serves no channel list; give the Channels tab something to render. */
async function mockChannels(page) {
  await page.route((url) => url.searchParams.get('action') === 'getChannels', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', channels: [
      { channel_name: 'Channel 0', url: 'https://www.youtube.com/@c0', avatar: '' },
      { channel_name: 'Channel 1', url: 'https://example.com', avatar: '' },
    ] }),
  }));
}

const cards = (page) => page.locator('#feed-container .media-card:visible');

/**
 * Tracks backend requests: `pending` (not finished or failed yet) and
 * `commentBatchesDone` (commentsBatch requests that completed).
 */
function trackBackendRequests(page) {
  const t = { pending: new Set(), commentBatchesDone: 0 };
  page.on('request', (req) => { if (req.url().includes('/macros/')) t.pending.add(req); });
  page.on('requestfinished', (req) => {
    if (t.pending.delete(req) && req.url().includes('action=commentsBatch')) t.commentBatchesDone++;
  });
  page.on('requestfailed', (req) => t.pending.delete(req));
  return t;
}

/** Captures the boot line that names the engine for this load. */
function engineLine(page) {
  const lines = [];
  page.on('console', (m) => { if (m.text().startsWith('storage engine:')) lines.push(m.text()); });
  return lines;
}

test.describe('storage engine flag', () => {
  test('default is legacy: snapshots in localStorage, IndexedDB never opened all session', async ({ page }) => {
    const errors = collectPageErrors(page);
    const line = engineLine(page);
    await countStorageOpens(page);
    await installMocks(page, { items: makeItems(60), clearStorage: false });
    await mockChannels(page);
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible();
    expect(line[0]).toBe('storage engine: legacy (default)');

    // Exercise every snapshot: feed (boot), channels (boot), search index, Top.
    await page.locator('#search-input').fill('Rolex');
    await expect(cards(page).first()).toBeVisible();
    await page.locator('#search-input').fill('');
    await page.locator('#tab-top').click();
    await expect(cards(page).first()).toBeVisible();
    await page.locator('#tab-channels').click();
    await expect(page.locator('.channel-card').first()).toBeVisible();
    await page.reload();
    await expect(cards(page).first()).toBeVisible();

    expect(await localSnapshot(page, FEED)).toMatchObject({ total: 60 });
    expect(await storageOpens(page)).toEqual({ idb: 0 });
    expect(errors).toEqual([]);
  });

  test('idb flag: the feed persists to IndexedDB and a reload paints from it with the backend hung', async ({ page }) => {
    const line = engineLine(page);
    const control = await installMocks(page, { items: makeItems(60), clearStorage: false });
    await setStorageMode(page, 'idb');
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible();
    expect(line[0]).toBe('storage engine: idb (flag)');
    await expect.poll(async () => (await idbSnapshot(page, FEED))?.videos?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(await localSnapshot(page, FEED)).toBeNull();

    control.feedBlocked = true;
    await page.reload();
    await expect(cards(page).first()).toBeVisible();
  });

  test('?storage=idb persists across visits; ?storage=default clears it', async ({ page }) => {
    const line = engineLine(page);
    await installMocks(page, { items: makeItems(30), clearStorage: false });
    await page.goto('/?storage=idb');
    await expect(cards(page).first()).toBeVisible();
    await expect(page).toHaveURL(/\/$/); // applied, then removed from the address bar
    await page.goto('/'); // no param this time
    await expect(cards(page).first()).toBeVisible();
    expect(line).toEqual(['storage engine: idb (flag)', 'storage engine: idb (flag)']);

    await page.goto('/?storage=default');
    await expect(cards(page).first()).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), FLAG_KEY)).toBeNull();
    expect(line.at(-1)).toBe('storage engine: legacy (default)');
  });

  test('?storage= rides along with a shared deep link', async ({ page }) => {
    await installMocks(page, { items: makeItems(30), clearStorage: false });
    await page.goto('/?v=vid00000003&storage=idb');
    await expect(cards(page).first()).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), FLAG_KEY)).toBe('idb');
    expect(await page.evaluate(() => location.search)).not.toContain('storage=');
  });

  test('flip idb → legacy → idb across loads: never errors, always shows a feed', async ({ page }) => {
    const errors = collectPageErrors(page);
    const control = await installMocks(page, { items: makeItems(40), clearStorage: false });
    for (const mode of ['idb', 'legacy', 'idb', 'legacy']) {
      await page.goto(`/?storage=${mode}`);
      await expect(cards(page).first()).toBeVisible();
    }
    // The last idb session's snapshot outlives the legacy load that ignored it;
    // with the backend hung, the next idb load still paints.
    control.feedBlocked = true;
    await page.goto('/?storage=idb');
    await expect(cards(page).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a flip in another tab does not change a running tab until it reloads', async ({ context, page }) => {
    const errors = collectPageErrors(page);
    const line = engineLine(page);
    const requests = trackBackendRequests(page);
    await installMocks(page, { items: makeItems(60), clearStorage: false });
    await page.goto('/?storage=idb');
    await expect(cards(page).first()).toBeVisible();

    const other = await context.newPage();
    await installMocks(other, { items: makeItems(60), clearStorage: false });
    await other.goto('/?storage=legacy');                // flips the shared flag
    await expect(cards(other).first()).toBeVisible();

    // The first tab keeps writing where it started: IndexedDB.
    await expect.poll(() => requests.pending.size).toBe(0); // boot's own traffic done
    const batchesBefore = requests.commentBatchesDone;
    await page.locator('#search-input').fill('Rolex');   // builds + saves the index
    await expect.poll(async () => (await idbSnapshot(page, INDEX))?.videos?.length ?? 0).toBeGreaterThan(0);
    expect(await localSnapshot(page, INDEX)).toBeNull();

    // Reload only once the search's final render has prefetched its comments
    // and nothing is in flight: WebKit reports a fetch cancelled by navigation
    // as a page error ("…due to access control checks"), which would pin a
    // timing race in the comments code on this storage test.
    await expect.poll(() => requests.commentBatchesDone > batchesBefore && requests.pending.size === 0).toBe(true);
    await page.reload();
    await expect(cards(page).first()).toBeVisible();
    expect(line.at(-1)).toBe('storage engine: legacy (flag)');
    expect(errors).toEqual([]);
  });

  test('IndexedDB that never answers: the page still boots from the network and caches to localStorage', async ({ page }) => {
    const errors = collectPageErrors(page);
    await hangIndexedDB(page);
    await installMocks(page, { items: makeItems(40), clearStorage: false });
    await setStorageMode(page, 'idb');
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible();
    await expect.poll(() => localSnapshot(page, FEED).then((s) => s?.videos?.length ?? 0)).toBeGreaterThanOrEqual(10);
    await expect(page.locator('.toast--error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('localStorage blocked outright: no flag, no cache, still a working feed', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.addInitScript(() => {
      const denied = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', { configurable: true, get: denied });
    });
    await installMocks(page, { items: makeItems(40), clearStorage: false });
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible();
    await page.locator('#tab-top').click();
    await expect(cards(page).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
