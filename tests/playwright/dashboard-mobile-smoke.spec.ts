import { expect, test } from '@playwright/test';

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:39182';
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'ci-fallback';

const CORE_ROUTES = ['/', '/tasks', '/agents', '/activity', '/analytics'];

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto(`${DASHBOARD_URL}/login?callbackUrl=%2F`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username').fill(ADMIN_USER);
  await page.getByLabel('Password').fill(ADMIN_PASS);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(`${DASHBOARD_URL}/`, { timeout: 15_000 });
}

test.describe('dashboard mobile smoke', () => {
  test('core Hub pages render without mobile overflow', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await signIn(page);

    for (const route of CORE_ROUTES) {
      await page.goto(`${DASHBOARD_URL}${route}`, { waitUntil: 'domcontentloaded' });
      await page.locator('body').waitFor({ state: 'visible' });

      await expect(page.locator('body')).not.toContainText(/Application error|Internal Server Error/i);

      const bodyTextLength = await page.locator('body').innerText().then(text => text.trim().length);
      expect(bodyTextLength, `${route} should render visible content`).toBeGreaterThan(20);

      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      });
      expect(overflow, `${route} should not have horizontal overflow at 390px`).toBeLessThanOrEqual(4);
    }

    expect(pageErrors).toEqual([]);
  });
});
