import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  testMatch: [
    'tests/playwright/**/*.spec.ts',
    'scripts/bakeoff/**/*.spec.ts',
  ],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:39182',
  },
  // Register tsx so we can import .ts source files
  globalSetup: undefined,
});
