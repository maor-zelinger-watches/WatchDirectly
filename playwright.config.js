import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.js', 'smoke/**/*.spec.js', 'perf/**/*.spec.js'],
  timeout: 30000,

  // Fail the build if a `test.only` is committed by accident.
  forbidOnly: isCI,
  // Live/API-backed suites flake occasionally; retry on CI, never locally
  // (a local flake should be seen, not silently papered over). Perf overrides
  // this to 0 below — a retimed run isn't a valid latency measurement.
  retries: isCI ? 2 : 0,
  // Pin CI to a single worker for reproducible timing and to avoid hammering
  // the live Apps Script; let dev machines parallelise freely.
  workers: isCI ? 1 : undefined,
  // Files within the e2e projects run in parallel (each project caps its own
  // concurrency; smoke/perf force --workers=1 via their npm scripts).
  fullyParallel: true,

  outputDir: './test-results',
  // Report lives OUTSIDE outputDir — the HTML reporter wipes its own folder on
  // each run, so nesting it inside test-results would clobber trace/video artifacts
  // (and Playwright errors out, which blocks `--ui` from loading any tests).
  reporter: isCI
    ? [['github'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],

  use: {
    baseURL: 'http://localhost:3099',
    viewport: { width: 375, height: 812 }, // iPhone X — mobile-first
    actionTimeout: 5000,
    // Diagnostics kept cheap: full artifacts only when a test actually fails.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  webServer: {
    command: 'npx serve . -l 3099',
    port: 3099,
    reuseExistingServer: !isCI,
  },

  projects: [
    {
      // Functional e2e on the mobile viewport. Perf and smoke run in their
      // own projects: latency budgets shouldn't be measured twice, and the
      // production smoke checks are viewport-free API tests — running them
      // per-viewport doubled the concurrent load on the live Apps Script,
      // which intermittently degrades under simultaneous invocations.
      name: 'mobile-chrome',
      testIgnore: ['perf/**', 'smoke/**'],
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: 'desktop-chrome',
      testIgnore: ['perf/**', 'smoke/**'],
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      // Production smoke checks (real API, no mocks, no browser page).
      name: 'smoke',
      testMatch: ['smoke/**/*.spec.js'],
      use: { browserName: 'chromium', video: 'retain-on-failure' },
    },
    {
      // Performance suite — desktop viewport, run serially (npm run test:perf).
      // Holds to the same 30s/test and 5s/action standards as e2e: if an
      // interaction can't act within 5s, that's a finding, not a config gap.
      // No retries: a retried run is a fresh timing sample, not the same test.
      name: 'perf',
      testMatch: ['perf/**/*.spec.js'],
      retries: 0,
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
