/**
 * PERF: storage engine — what persistence buys a returning visitor, and what
 * it costs when storage misbehaves. Runs both modes of the storage-engine flag
 * (js/flags.js): 'legacy' (localStorage, the default) and 'idb' (IndexedDB).
 *
 * 16. Warm reload paints from storage alone, in both modes.
 * 17. Slow IndexedDB (a cold disk on a phone): still inside the warm budget.
 * 18. IndexedDB that never answers: cold boot still paints from the network,
 *     and a returning visit paints from the localStorage fallback — with the
 *     backend hung too.
 * 19. An index bigger than localStorage's quota (idb): a returning visitor's
 *     archive-only search is answered from storage, with the backend hung,
 *     without a single catalog re-walk, and without main-thread jank.
 * 20. The same index in legacy mode: it silently fails to persist, and the
 *     next visit re-walks every page of the catalog. (The Safari failure,
 *     reproduced deterministically — this pins the cost idb mode removes.)
 *
 * Every budget is a native assertion's `timeout` — expect.poll at a 25 ms
 * cadence (expectVisibleWithin), because toBeVisible's backoff leaves a dead
 * zone before its timeout; see storage-helpers.js. Everything else is a
 * deterministic count (requests issued, rows persisted) or the same
 * browser-measured long-task bar T5 uses.
 */

import { test, expect } from '@playwright/test';
import {
  installMocks, makeItems, installLongTaskObserver, longTaskStats, resetLongTasks,
} from './helpers.js';
import {
  setStorageMode, hangIndexedDB, slowIndexedDB, idbSnapshot, localSnapshot, collectPageErrors,
  expectVisibleWithin,
} from './storage-helpers.js';

const WARM_PAINT_MS = 1500;     // same budget as T2
const DEAD_IDB_WARM_MS = 2000;  // storage.js probe budget (1000ms) + the usual paint
const DEAD_IDB_COLD_MS = 2500;  // probe budget + a (mocked, instant) network page
const DEEP_SEARCH_MS = 2000;    // archive-only hit from the persisted index
const LONG_TASK_MAX_MS = 300;   // T5's jank bar
// localStorage's cap, measured (Sep 2026): ~5.2M characters in Chromium and
// WebKit for Latin-1 text; WebKit halves it (~2.6M) once any character is
// outside Latin-1, which production titles are.
const LOCALSTORAGE_CAP_CHARS = 5_300_000;

const FEED = 'wd_feed_cache';
const INDEX = 'wd_search_index';
const cards = (page) => page.locator('#feed-container .media-card:visible');

/**
 * 5000 items with ~1.4 KB titles — em dashes included, as in production — so
 * the persisted index is ~8M characters: over every localStorage cap. One old
 * item near the end carries a word nothing else has.
 */
function oversizedCatalog() {
  const items = makeItems(5000);
  const filler = ` — ${'a long review title that goes on and on '.repeat(33)}`;
  for (const item of items) item.title += filler;
  const target = items[4990];
  target.title = `Zanzibarquartz ${target.title}`;
  return { items, targetId: target.video_id, query: 'zanzibarquartz' };
}

const indexComplete = (page) => page.evaluate(async () => (await import('/js/state.js')).state.searchIndexComplete);

async function buildIndex(page) {
  await page.locator('#search-input').click(); // focus warms the full index
  await expect.poll(() => indexComplete(page), { timeout: 60_000 }).toBe(true);
}

test.describe('PERF · storage engine', () => {
  for (const mode of ['legacy', 'idb']) {
    test(`T16 warm reload paints from storage alone (${mode})`, async ({ page }) => {
      const control = await installMocks(page, { items: makeItems(60), clearStorage: false });
      await setStorageMode(page, mode);
      await page.goto('/');
      await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10_000 });
      const saved = () => (mode === 'idb' ? idbSnapshot(page, FEED) : localSnapshot(page, FEED));
      await expect.poll(async () => (await saved())?.videos?.length ?? 0).toBe(10);

      control.feedBlocked = true;
      await page.reload({ waitUntil: 'commit' });
      await expectVisibleWithin(cards(page).first(), WARM_PAINT_MS);
    });
  }

  test('T17 slow IndexedDB (500ms per open and read) still paints warm within budget', async ({ page }) => {
    const control = await installMocks(page, { items: makeItems(60), clearStorage: false });
    await setStorageMode(page, 'idb');
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10, { timeout: 10_000 });
    await expect.poll(async () => (await idbSnapshot(page, FEED))?.videos?.length ?? 0).toBe(10);

    await slowIndexedDB(page, 500); // from the next load on
    control.feedBlocked = true;
    await page.reload({ waitUntil: 'commit' });
    // open (500) + read (500) + paint, all under the unchanged warm budget.
    await expectVisibleWithin(cards(page).first(), WARM_PAINT_MS);
  });

  test('T18 IndexedDB that never answers: cold boot paints from the network, a warm one from the fallback', async ({ page }) => {
    const errors = collectPageErrors(page);
    await hangIndexedDB(page);
    const control = await installMocks(page, { items: makeItems(60), clearStorage: false });
    await setStorageMode(page, 'idb');

    await page.goto('/', { waitUntil: 'commit' });
    await expectVisibleWithin(cards(page).first(), DEAD_IDB_COLD_MS);
    await expect.poll(async () => (await localSnapshot(page, FEED))?.videos?.length ?? 0).toBe(10);

    // IndexedDB still dead, and now the backend too: only the fallback copy
    // can paint, after the probe gives up on IndexedDB.
    control.feedBlocked = true;
    await page.reload({ waitUntil: 'commit' });
    await expectVisibleWithin(cards(page).first(), DEAD_IDB_WARM_MS);
    expect(errors).toEqual([]);
  });

  test('T19 idb: an index over the localStorage cap serves a returning search from storage', async ({ page, browserName }) => {
    const { items, targetId, query } = oversizedCatalog();
    await installLongTaskObserver(page);
    const control = await installMocks(page, { items, clearStorage: false });
    await setStorageMode(page, 'idb');
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible({ timeout: 10_000 });
    await buildIndex(page);

    // Self-check: this catalog really is past what localStorage can hold.
    const chars = await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      return JSON.stringify(state.searchIndex.map(({ _searchFields, ...row }) => row)).length;
    });
    expect(chars).toBeGreaterThan(LOCALSTORAGE_CAP_CHARS);
    await expect.poll(async () => (await idbSnapshot(page, INDEX))?.videos?.length ?? 0, { timeout: 15_000 })
      .toBe(items.length);

    // The returning visit: backend hung for feed pages AND index chunks.
    control.feedBlocked = true;
    control.chunkBlocked = true;
    control.chunkPages.length = 0;
    await page.reload({ waitUntil: 'commit' });
    await expectVisibleWithin(cards(page).first(), WARM_PAINT_MS);
    await resetLongTasks(page);

    await page.locator('#search-input').fill(query);
    await expectVisibleWithin(page.locator(`#feed-container .media-card[data-video-id="${targetId}"]`), DEEP_SEARCH_MS);

    // At most the head top-up was attempted — never a catalog walk.
    expect(control.chunkPages.length).toBeLessThanOrEqual(1);
    // Long tasks are only observable in Chromium (WebKit and Firefox don't
    // implement the longtask entry type), so elsewhere this bar can't be checked
    // and isn't claimed.
    if (browserName === 'chromium') {
      const lt = await longTaskStats(page);
      console.log(`[T19] index=${chars} chars; restore+search long tasks: count=${lt.count} max=${lt.max}ms total=${lt.total}ms`);
      expect(lt.max).toBeLessThan(LONG_TASK_MAX_MS);
    } else {
      console.log(`[T19] index=${chars} chars; long tasks not measurable in ${browserName}`);
    }
  });

  test('T20 legacy: the same index silently fails to persist, and the next visit re-walks the catalog', async ({ page }) => {
    const { items, targetId, query } = oversizedCatalog();
    const errors = collectPageErrors(page);
    const control = await installMocks(page, { items, clearStorage: false });
    await setStorageMode(page, 'legacy');
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible({ timeout: 10_000 });
    await buildIndex(page);

    // The quota error is swallowed by design — nothing persisted, nothing thrown.
    expect(await localSnapshot(page, INDEX)).toBeNull();
    expect(errors).toEqual([]);

    control.chunkPages.length = 0;
    await page.reload({ waitUntil: 'commit' });
    await expectVisibleWithin(cards(page).first(), WARM_PAINT_MS);
    await page.locator('#search-input').fill(query);
    await expect(page.locator(`#feed-container .media-card[data-video-id="${targetId}"]`))
      .toBeVisible({ timeout: 30_000 });
    // Every chunk page of the catalog, fetched again.
    expect(control.chunkPages.length).toBeGreaterThanOrEqual(items.length / 100);
    console.log(`[T20] legacy re-walk: ${control.chunkPages.length} chunk requests`);
  });
});
