/**
 * Before/after benchmark for the storage move — report only.
 *
 * Run the SAME spec against two builds and compare the numbers:
 *
 *   PERF_LIVE_STORAGE=legacy npm run test:perf-live -- compare --repeat-each=3
 *   PERF_LIVE_STORAGE=idb    npm run test:perf-live -- compare --repeat-each=3
 *   node tests/perf-live/summarize.mjs <results.json> …
 *
 * (Or compare two checkouts: PERF_LIVE_LABEL=<name> PERF_LIVE_ROOT=<dir>.)
 *
 * One repetition = one returning visitor, against production data:
 *   session 1  cold visit: first paint, full search-index build, what persisted
 *   session 2  warm reload, backend HELD: how fast the feed paints from storage
 *   session 3  warm reload, backend live: search for an archive-only title —
 *              time until it shows, backend requests spent, main-thread blocking
 *
 * Timings are taken INSIDE the page (performance.now() when a card actually
 * appears, PerformanceObserver for long tasks), never by a test-side stopwatch,
 * and none are asserted: the output is the comparison. The only assertions are
 * that each step completed.
 */

import { test, expect } from '@playwright/test';
import {
  SNAPSHOT_KEYS, snapshotInfo, isPersisted, persistedRows, holdBackend, recordIndexRequests, appState, report,
  applyStorageFlag, STORAGE_MODE,
} from './helpers.js';

// With PERF_LIVE_STORAGE set, one checkout benchmarks itself in each mode —
// the label defaults to the mode, so the summary compares idb vs legacy.
const LABEL = process.env.PERF_LIVE_LABEL || STORAGE_MODE || 'unlabeled';
const COLD_MS = 45_000;
const INDEX_BUILD_MS = 300_000;
const SEARCH_MS = 300_000;
const COLD_RETRIES = 3;

/** In-page instrumentation, re-installed on every navigation. */
async function instrument(page) {
  await page.addInitScript(() => {
    const perf = { firstCard: null, target: null, targetAt: null, longTasks: [] };
    window.__perf = perf;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) perf.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) { /* longtask is Chromium-only */ }
    const shown = (el) => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
    const check = () => {
      if (perf.firstCard === null) {
        for (const el of document.querySelectorAll('#feed-container .media-card')) {
          if (shown(el)) { perf.firstCard = performance.now(); break; }
        }
      }
      if (perf.target && perf.targetAt === null) {
        const el = document.querySelector(`#feed-container .media-card[data-video-id="${CSS.escape(perf.target)}"]`);
        if (el && shown(el)) perf.targetAt = performance.now();
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'],
    });
  });
}

const perfState = (page) => page.evaluate(() => window.__perf);

/**
 * Waits for the first visible card, pressing the app's own Retry button when a
 * cold load fails — what a user does — so a production hiccup costs a retry,
 * not the repetition. Returns how many retries it took.
 */
async function firstCardWithRetry(page) {
  const card = page.locator('#feed-container .media-card:visible').first();
  const retry = page.locator('#feed-retry-btn');
  for (let attempt = 0; ; attempt++) {
    await expect(card.or(retry)).toBeVisible({ timeout: COLD_MS });
    if (await card.isVisible()) return attempt;
    if (attempt >= COLD_RETRIES) throw new Error(`feed failed to load after ${COLD_RETRIES} retries`);
    await retry.click();
  }
}

/** Backend latency this repetition ran under: the median /exec feed-request duration so far. */
const backendLatencyMs = (page) => page.evaluate(() => {
  const d = performance.getEntriesByType('resource')
    .filter((e) => e.name.includes('/macros/s/') && e.name.includes('action=feed'))
    .map((e) => e.duration).sort((a, b) => a - b);
  return d.length ? Math.round(d[Math.floor(d.length / 2)]) : null;
});
/**
 * Builds the search index the way the app does on focus, retrying when a
 * production hiccup rejects the build — the app resets and retries on the next
 * keystroke, so a user just types again. Returns the successful attempt's
 * duration (in-page clock) and how many retries it took.
 */
async function buildIndexWithRetry(page) {
  for (let attempt = 0; ; attempt++) {
    const r = await page.evaluate(async () => {
      const t0 = performance.now();
      const { ensureSearchIndex } = await import('/js/views.js');
      try {
        await ensureSearchIndex();
        return { ms: performance.now() - t0 };
      } catch (e) {
        return { error: String(e && e.message) };
      }
    });
    if (!r.error) return { ms: Math.round(r.ms), retries: attempt };
    if (attempt >= COLD_RETRIES) throw new Error(`index build failed ${attempt + 1}x: ${r.error}`);
  }
}

/**
 * Types `query` and waits for the card `id`, retyping when the index build
 * behind the search fails (the app surfaces that as a toast and resets). The
 * elapsed time includes any retries — that is what the visitor waited.
 */
async function searchWithRetry(page, query, id) {
  const input = page.locator('#search-input');
  const hit = page.locator(`#feed-container .media-card[data-video-id="${id}"]`);
  let retries = 0;
  await input.fill(query);
  await expect.poll(async () => {
    if (await hit.isVisible()) return true;
    const { searchIndexPromise, searchIndexComplete } = await appState(page, ['searchIndexPromise', 'searchIndexComplete']);
    // The app drops a failed build's promise; a real visitor would type again.
    if (!searchIndexPromise && !searchIndexComplete && retries < COLD_RETRIES) {
      retries++;
      await input.fill('');
      await input.fill(query);
    }
    return false;
  }, { timeout: SEARCH_MS, intervals: [250] }).toBe(true);
  return retries;
}

const blocking = (tasks, from, to) => {
  const inWindow = tasks.filter((t) => t.start >= from && t.start <= to);
  return {
    count: inWindow.length,
    totalMs: Math.round(inWindow.reduce((n, t) => n + t.dur, 0)),
    maxMs: Math.round(inWindow.reduce((m, t) => Math.max(m, t.dur), 0)),
  };
};

test('before/after: a returning visitor', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  await applyStorageFlag(page);
  await instrument(page);
  const m = { build: LABEL, browser: testInfo.project.name, repeat: testInfo.repeatEachIndex };

  // --- session 1: cold -------------------------------------------------------
  await page.goto('/');
  m.coldRetries = await firstCardWithRetry(page);
  m.coldFirstCardMs = Math.round((await perfState(page)).firstCard);

  await page.locator('#search-input').click();
  const build = await buildIndexWithRetry(page);
  m.indexBuildMs = build.ms;
  m.indexBuildRetries = build.retries;
  // Give the post-build save up to 15s to land (a build that can't persist
  // never will — that's a result, not a failure), then record where it went.
  for (let waited = 0; waited < 15_000 && !(await isPersisted(page, SNAPSHOT_KEYS.SEARCH_INDEX)); waited += 500) {
    await page.waitForTimeout(500);
  }
  m.backendFeedLatencyMs = await backendLatencyMs(page);
  const idx = await snapshotInfo(page, SNAPSHOT_KEYS.SEARCH_INDEX);
  m.indexRows = await page.evaluate(async () => ((await import('/js/state.js')).state.searchIndex || []).length);
  m.indexPersistedRows = (idx.idb || idx.cache || idx.local || {}).rows ?? 0;
  m.indexPersisted = !!(idx.local || idx.cache || idx.idb);
  m.indexStoredIn = idx.idb ? 'indexeddb' : idx.cache ? 'cache' : idx.local ? 'localStorage' : 'nowhere';
  m.localStorageChars = await page.evaluate(() => {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      n += k.length + (localStorage.getItem(k) || '').length;
    }
    return n;
  });

  const target = await page.evaluate(async () => {
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
      if (w) return { query: w, id: String(v.video_id) };
    }
    return null;
  });
  expect(target).not.toBeNull();
  m.query = target.query;

  // The feed snapshot must hold the full first page before measuring its restore.
  await expect.poll(async () => {
    const { videos } = await appState(page, ['videos']);
    return (videos || []).length > 0 && (await persistedRows(page, SNAPSHOT_KEYS.FEED)) >= 10;
  }, { timeout: 15_000 }).toBe(true);

  // --- session 2: warm reload, backend held ----------------------------------
  const backend = await holdBackend(page);
  await page.reload({ waitUntil: 'commit' });
  await expect(page.locator('#feed-container .media-card:visible').first()).toBeVisible({ timeout: 10_000 });
  const s2 = await perfState(page);
  m.warmFeedFirstCardMs = Math.round(s2.firstCard);
  m.warmFeedBlocking = blocking(s2.longTasks, 0, s2.firstCard);
  await backend.release();

  // --- session 3: returning visitor searches, backend live --------------------
  const indexRequests = recordIndexRequests(page);
  await page.reload();
  await firstCardWithRetry(page);
  const t0 = await page.evaluate((id) => { window.__perf.target = id; return performance.now(); }, target.id);
  m.searchRetries = await searchWithRetry(page, target.query, target.id);
  const s3 = await perfState(page);
  m.returningSearchMs = Math.round(s3.targetAt - t0);
  m.returningSearchBlocking = blocking(s3.longTasks, t0, s3.targetAt);
  await expect.poll(async () => (await appState(page, ['searchIndexComplete'])).searchIndexComplete,
    { timeout: INDEX_BUILD_MS }).toBe(true);
  m.returningIndexRequests = indexRequests.length;

  await report(testInfo, 'compare', m);
});
