import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.js', 'smoke/**/*.spec.js', 'perf/**/*.spec.js'],
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3099',
    viewport: { width: 375, height: 812 }, // iPhone X — mobile-first
    actionTimeout: 5000,
  },
  webServer: {
    command: 'npx serve . -l 3099',
    port: 3099,
    reuseExistingServer: true,
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
      use: { browserName: 'chromium' },
    },
    {
      // Performance suite — desktop viewport, run serially (npm run test:perf).
      // Holds to the same 30s/test and 5s/action standards as e2e: if an
      // interaction can't act within 5s, that's a finding, not a config gap.
      name: 'perf',
      testMatch: ['perf/**/*.spec.js'],
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
