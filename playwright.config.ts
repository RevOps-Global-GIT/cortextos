import { defineConfig } from '@playwright/test';

// Suppress bus mirror to prod. Playwright forks workers inheriting this env,
// so isEnabled() in rgos-mirror.ts returns false for all test-runner tasks.
process.env.NODE_ENV = 'test';

export default defineConfig({
  testDir: './tests/playwright',
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
