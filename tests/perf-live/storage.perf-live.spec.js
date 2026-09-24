/**
 * Live-backend storage performance — `npm run test:perf-live`.
 *
 * Measures what persistence buys a returning visitor, against production data.
 * Every test follows the same shape: a first session against the real backend
 * lets the app persist whatever it persists, then a second session (a reload)
 * runs with the backend HELD — so anything that paints can only have come from
 * storage, and live-backend latency drops out of the budget.
 *
 * Pass/fail is expressed only through native web-first assertions whose
 * `timeout` is the budget (and through deterministic counts). Steps marked
 * "report" measure and print numbers without asserting on them — they're how
 * two builds get compared, not a gate.
 *
 * The specs are build-agnostic: run them against main (localStorage) and this
 * branch (IndexedDB / Cache Storage) with PERF_LIVE_ROOT to compare.
 */

import { test, expect } from '@playwright/test';
import {
  SNAPSHOT_KEYS, visibleCard, snapshotInfo, persistedRows, expectPersisted, holdBackend,
  recordIndexRequests, appState, report, applyStorageFlag,
} from './helpers.js';

// Budgets. Cold numbers include production latency (Apps Script cold starts
// run to several seconds); warm numbers are storage-only, the backend held.
const COLD_FIRST_CARD_MS = 20_000;
const WARM_PAINT_MS = 1_500;        // same budget as tests/perf T2 (mocked backend)
const WARM_DEEP_SEARCH_MS = 3_000;  // an archive-only match, from the persisted index
const INDEX_BUILD_MS = 180_000;     // full live + archive walk against production
const PERSIST_MS = 15_000;
const WARM_INDEX_REQUESTS_MAX = 2;  // a warm top-up stops at the first known page

test.describe('storage — live backend', () => {
  test.beforeEach(async ({ page }) => applyStorageFlag(page));

  test('cold first paint (baseline, nothing persisted)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' });
    await expect(visibleCard(page)).toBeVisible({ timeout: COLD_FIRST_CARD_MS });
  });

  test('warm reload paints the feed from storage alone', async ({ page }, testInfo) => {
    const cards = page.locator('#feed-container .media-card:visible');
    await page.goto('/');
    await expect(visibleCard(page)).toBeVisible({ timeout: COLD_FIRST_CARD_MS });
    // Boot saves twice — an early N+1 snapshot, then the full first page.
    // Wait for the full page to be both loaded and persisted.
    await expect.poll(async () => {
      const { videos } = await appState(page, ['videos']);
      const pageSize = await page.evaluate(async () => (await import('/js/config.js')).CONFIG.PAGE_SIZE);
      const loaded = (videos || []).length;
      return loaded >= pageSize && (await persistedRows(page, SNAPSHOT_KEYS.FEED)) === loaded;
    }, { timeout: PERSIST_MS, message: 'the full first page should be persisted' }).toBe(true);
    const shown = await cards.count(); // Shorts are hidden by the default chips

    const backend = await holdBackend(page);
    await page.reload({ waitUntil: 'commit' });
    await expect(visibleCard(page)).toBeVisible({ timeout: WARM_PAINT_MS });
    // Everything session 1 showed, not just a first card.
    await expect(cards).toHaveCount(shown, { timeout: WARM_PAINT_MS });

    await report(testInfo, 'feed snapshot', {
      location: await snapshotInfo(page, SNAPSHOT_KEYS.FEED),
      heldBackendRequests: backend.count,
    });
    await backend.release();
  });

  test('warm Top This Week paints from storage alone', async ({ page }) => {
    await page.goto('/');
    await expect(visibleCard(page)).toBeVisible({ timeout: COLD_FIRST_CARD_MS });
    await page.locator('#tab-top').click();
    await expect(page.locator('#feed-container')).toHaveAttribute('aria-labelledby', 'tab-top');
    const cards = page.locator('#feed-container .media-card:visible');
    // Wait for the ranked list itself: Latest's cards stay mounted until
    // renderTop swaps them out, so "a card is visible" alone proves nothing.
    await expect.poll(async () => {
      const ids = await cards.evaluateAll((els) => els.slice(0, 2).map((el) => el.dataset.videoId));
      const top = (await appState(page, ['topVideos'])).topVideos || [];
      return ids.length === 2 && top.length > 0 && ids[0] === String(top[0].video_id);
    }, { timeout: COLD_FIRST_CARD_MS }).toBe(true);
    const [firstId, secondId] = await cards.evaluateAll((els) => els.slice(0, 2).map((el) => el.dataset.videoId));
    await expectPersisted(page, SNAPSHOT_KEYS.TOP, PERSIST_MS);

    const backend = await holdBackend(page);
    await page.reload();
    await expect(visibleCard(page)).toBeVisible({ timeout: WARM_PAINT_MS }); // Latest, from storage
    await page.locator('#tab-top').click();
    // The ranked list, in session 1's order — not Latest's cards still mounted.
    await expect(cards.nth(0)).toHaveAttribute('data-video-id', firstId, { timeout: WARM_PAINT_MS });
    await expect(cards.nth(1)).toHaveAttribute('data-video-id', secondId, { timeout: WARM_PAINT_MS });
    await backend.release();
  });

  test('warm Channels tab paints from storage alone', async ({ page }) => {
    await page.goto('/');
    await expect(visibleCard(page)).toBeVisible({ timeout: COLD_FIRST_CARD_MS });
    await expectPersisted(page, SNAPSHOT_KEYS.CHANNELS, PERSIST_MS);

    const backend = await holdBackend(page);
    await page.reload();
    await page.locator('#tab-channels').click();
    await expect(page.locator('.channel-card').first()).toBeVisible({ timeout: WARM_PAINT_MS });
    await backend.release();
  });

  test('the search index survives the session and serves a returning visitor', async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    let target = null;

    await test.step('session 1: build the full index against production', async () => {
      await page.goto('/');
      await expect(visibleCard(page)).toBeVisible({ timeout: COLD_FIRST_CARD_MS });
      await page.locator('#search-input').click(); // focus warms the index
      await expect.poll(async () => (await appState(page, ['searchIndexComplete'])).searchIndexComplete, {
        timeout: INDEX_BUILD_MS,
        intervals: [1_000],
        message: 'the full catalog index should finish building',
      }).toBe(true);

      // The claim under test. Soft, so a build that can't persist still runs
      // session 2 and shows what that costs a returning visitor.
      await expectPersisted(page, SNAPSHOT_KEYS.SEARCH_INDEX, PERSIST_MS, { soft: true });

      // A word that appears in exactly one title, taken from the OLDEST end of
      // the catalog (archive territory) and never from the first 200 rows —
      // so the feed pages in memory can't be what finds it next session.
      target = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const idx = state.searchIndex || [];
        const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
        const freq = new Map();
        for (const v of idx) for (const w of new Set(words(v.title))) freq.set(w, (freq.get(w) || 0) + 1);
        const head = new Set(idx.slice(0, 200).map((v) => v.video_id));
        for (let i = idx.length - 1; i >= Math.max(0, idx.length - 600); i--) {
          const v = idx[i];
          if (!v || head.has(v.video_id) || String(v.url || '').includes('/shorts/')) continue;
          const w = words(v.title).find((x) => x.length >= 7 && /^[a-z]+$/.test(x) && freq.get(x) === 1);
          if (w) return { query: w, id: String(v.video_id), title: v.title, published_at: v.published_at, indexRows: idx.length };
        }
        return null;
      });
      expect(target, 'the catalog should contain a uniquely-worded archive title').not.toBeNull();

      await report(testInfo, 'search index after session 1', {
        rows: target.indexRows,
        location: await snapshotInfo(page, SNAPSHOT_KEYS.SEARCH_INDEX),
        localStorageChars: await page.evaluate(() => {
          let n = 0;
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            n += k.length + (localStorage.getItem(k) || '').length;
          }
          return n;
        }),
        storageEstimate: await page.evaluate(async () => (navigator.storage && navigator.storage.estimate
          ? navigator.storage.estimate().then(({ usage, quota }) => ({ usage, quota }))
          : null)),
        target,
      });
    });

    await test.step('report: engine write/read of the real index (no assertion)', async () => {
      const bench = await page.evaluate(async () => {
        let storage;
        try {
          storage = await import('/js/storage.js');
        } catch (e) {
          return { skipped: 'this build has no js/storage.js' };
        }
        const { state } = await import('/js/state.js');
        const videos = (state.searchIndex || []).map(({ _searchFields, ...row }) => row);
        const payload = { videos, version: 2, savedAt: Date.now() };
        const key = '__wd_bench__';
        const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
        const out = { rows: videos.length, jsonChars: JSON.stringify(payload).length, engines: {} };
        for (const name of Object.keys(storage.engines)) {
          const engine = storage.engines[name];
          const r = { writeMs: [], readMs: [], error: null };
          try {
            if (!(await engine.probe())) throw new Error('unavailable');
            for (let i = 0; i < 3; i++) {
              performance.mark('w0'); await engine.set(key, payload); performance.mark('w1');
              r.writeMs.push(performance.measure('w', 'w0', 'w1').duration);
              performance.mark('r0'); await engine.get(key); performance.mark('r1');
              r.readMs.push(performance.measure('r', 'r0', 'r1').duration);
            }
          } catch (e) {
            r.error = `${e.name}: ${e.message}`;
          }
          await engine.del(key).catch(() => {});
          out.engines[name] = {
            medianWriteMs: r.writeMs.length ? Math.round(median(r.writeMs)) : null,
            medianReadMs: r.readMs.length ? Math.round(median(r.readMs)) : null,
            error: r.error,
          };
        }
        return out;
      });
      await report(testInfo, 'engine benchmark (report only)', bench);
    });

    await test.step('session 2: an archive-only match paints from storage, backend held', async () => {
      const indexRequests = recordIndexRequests(page);
      const backend = await holdBackend(page);
      await page.reload();
      await page.locator('#search-input').fill(target.query);

      await expect.soft(
        page.locator(`#feed-container .media-card[data-video-id="${target.id}"]`),
        `"${target.query}" should find the archived item without the network`,
      ).toBeVisible({ timeout: WARM_DEEP_SEARCH_MS });

      await test.step('release the backend: the warm top-up stays cheap', async () => {
        await backend.release();
        await expect.poll(async () => (await appState(page, ['searchIndexComplete'])).searchIndexComplete, {
          timeout: INDEX_BUILD_MS,
          intervals: [1_000],
        }).toBe(true);
        await report(testInfo, 'session 2 index requests', { count: indexRequests.length, urls: indexRequests });
        expect.soft(indexRequests.length, 'a persisted index needs only a head top-up, not a catalog walk')
          .toBeLessThanOrEqual(WARM_INDEX_REQUESTS_MAX);
        // By now the match is there on any build — shows the network-bound path finished.
        await expect(page.locator(`#feed-container .media-card[data-video-id="${target.id}"]`)).toBeVisible();
      });
    });
  });
});
