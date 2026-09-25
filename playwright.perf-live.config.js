import { defineConfig } from '@playwright/test';

/**
 * Live-backend performance suite — `npm run test:perf-live`.
 *
 * Serves a checkout locally and drives it against the PRODUCTION Apps Script
 * backend (whatever js/config.js points at), so every payload has real size.
 * Deliberately separate from playwright.config.js: its testMatch never reaches
 * tests/perf-live/, so this suite is not part of test:e2e, test:perf, CI, or
 * the deploy skill's gate. It spends real backend quota — run it by hand.
 *
 *   PERF_LIVE_ROOT  directory to serve (default: this checkout). Point it at
 *                   another worktree to measure that build with the same specs,
 *                   e.g. a checkout of main for a before/after comparison.
 *   PERF_LIVE_PORT  port to serve on (default 3199 — clear of e2e's 3099).
 *   PERF_LIVE_STORAGE  'idb' | 'legacy': pins the storage-engine flag
 *                   (js/flags.js) for every page, so one checkout can be
 *                   measured in both modes. Unset = the build's default.
 *
 * Projects: chromium, firefox, webkit (WebKit is Safari's engine). Install the
 * last two once with `npx playwright install firefox webkit`, then pick with
 * `--project`.
 */

const PORT = Number(process.env.PERF_LIVE_PORT || 3199);
const ROOT = process.env.PERF_LIVE_ROOT || '.';

export default defineConfig({
  testDir: './tests/perf-live',
  testMatch: '**/*.perf-live.spec.js',
  // Session 1 of the search test walks the whole live + archive catalog
  // (~45 requests to production), so the per-test ceiling is generous.
  timeout: 240_000,
  // One retry: the live backend fails in short Google-side bursts (the echo
  // redirect hop answering 404 — see memory apps-script-echo-hop-404). Every
  // budget is re-measured from scratch on the retry.
  retries: 1,
  // Serial: parallel runs would contend for the backend, which serializes a
  // client's executions, and distort each other's numbers.
  workers: 1,
  fullyParallel: false,

  outputDir: './test-results/perf-live',
  reporter: [
    ['list'],
    ['json', { outputFile: './test-results/perf-live/results.json' }],
  ],

  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },

  webServer: {
    command: `npx serve "${ROOT}" -l ${PORT}`,
    port: PORT,
    // Never reuse: a stale server from another checkout would silently
    // measure the wrong build.
    reuseExistingServer: false,
  },

  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
