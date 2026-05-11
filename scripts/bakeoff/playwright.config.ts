import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    // Wide viewport so all kanban columns are visible without horizontal scroll
    // 240px sidebar + 9 cols × (260px + 12px gap) ≈ 2688px needed
    viewport: { width: 2800, height: 1080 },
  },
});
