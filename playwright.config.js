import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.js', 'smoke/**/*.spec.js'],
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
      name: 'mobile-chrome',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: 'desktop-chrome',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
