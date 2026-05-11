#!/usr/bin/env node

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

type Args = Record<string, string | boolean>;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = path.join(SCRIPT_DIR, '.auth/google-session.json');
const DEBUG_SCREENSHOT = path.join(SCRIPT_DIR, 'debug-consent-error.png');

function parseArgs(argv: string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${current}`);
    }

    const eq = current.indexOf('=');
    if (eq !== -1) {
      args[current.slice(0, eq)] = current.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[current] = true;
    } else {
      args[current] = next;
      i += 1;
    }
  }

  return args;
}

function requiredString(args: Args, flag: string): string {
  const value = args[flag];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required CLI arg: ${flag}`);
  }
  return value.trim();
}

function optionalString(args: Args, flag: string): string | undefined {
  const value = args[flag];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function isVisible(locator: ReturnType<Page['locator']>): Promise<boolean> {
  return locator.first().isVisible({ timeout: 1_000 }).catch(() => false);
}

async function clickFirstVisible(page: Page, labels: RegExp[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const label of labels) {
      const button = page.getByRole('button', { name: label }).first();
      if (await isVisible(button)) {
        await button.click();
        return;
      }

      const textButton = page.locator('button, [role="button"]').filter({ hasText: label }).first();
      if (await isVisible(textButton)) {
        await textButton.click();
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find visible button matching: ${labels.map((label) => label.toString()).join(', ')}`);
}

async function fillField(page: Page, labels: RegExp[], value: string): Promise<void> {
  for (const label of labels) {
    const labelled = page.getByLabel(label).first();
    if (await isVisible(labelled)) {
      await labelled.fill(value);
      return;
    }

    const placeholder = page.getByPlaceholder(label).first();
    if (await isVisible(placeholder)) {
      await placeholder.fill(value);
      return;
    }

    const field = page
      .locator('mat-form-field, cfc-form-field, .mat-mdc-form-field, label, div')
      .filter({ hasText: label })
      .locator('input, textarea')
      .first();
    if (await isVisible(field)) {
      await field.fill(value);
      return;
    }
  }

  throw new Error(`Could not fill field matching: ${labels.map((label) => label.toString()).join(', ')}`);
}

async function fillOrSelectField(page: Page, labels: RegExp[], value: string): Promise<void> {
  try {
    await fillField(page, labels, value);
    return;
  } catch {
    // Some Cloud Console fields are Material selects rather than text inputs.
  }

  for (const label of labels) {
    const labelled = page.getByLabel(label).first();
    if (await isVisible(labelled)) {
      await labelled.click();
      await page.getByText(value, { exact: true }).first().click({ timeout: 10_000 });
      return;
    }

    const field = page
      .locator('mat-form-field, cfc-form-field, .mat-mdc-form-field, div')
      .filter({ hasText: label })
      .first();
    if (await isVisible(field)) {
      await field.click();
      await page.getByText(value, { exact: true }).first().click({ timeout: 10_000 });
      return;
    }
  }

  throw new Error(`Could not fill or select field matching: ${labels.map((label) => label.toString()).join(', ')}`);
}

async function maybeSelectExternal(page: Page): Promise<void> {
  const external = page.getByRole('radio', { name: /external/i }).first();
  if (await isVisible(external)) {
    await external.click();
    await clickFirstVisible(page, [/continue/i, /next/i]);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error('Run gcp-auth-setup first to capture a Google session.');
  }

  const args = parseArgs(process.argv.slice(2));
  const projectId = requiredString(args, '--project-id');
  const appName = requiredString(args, '--app-name');
  const supportEmail = requiredString(args, '--support-email');
  const developerEmail = requiredString(args, '--developer-email');
  const homepageUrl = optionalString(args, '--homepage-url');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);

  try {
    await page.goto(
      `https://console.cloud.google.com/apis/credentials/consent?project=${encodeURIComponent(projectId)}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    if (await page.getByText(appName, { exact: false }).first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      console.log(`Consent screen already configured for ${projectId}`);
      return;
    }

    await maybeSelectExternal(page);
    await fillField(page, [/app name/i, /application name/i], appName);
    await fillOrSelectField(page, [/user support email/i, /support email/i], supportEmail);
    await fillField(page, [/developer contact email/i, /developer email/i, /email addresses/i], developerEmail);

    if (homepageUrl) {
      await fillField(page, [/homepage url/i, /home page url/i, /application home page/i], homepageUrl);
    }

    await clickFirstVisible(page, [/save and continue/i, /^save$/i]);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const successVisible = await page.getByText(/oauth consent|app registration|publishing status|verification status|summary/i)
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    if (!successVisible && !page.url().includes('/apis/credentials/consent')) {
      throw new Error('Consent screen save did not reach a recognizable success or summary state');
    }

    console.log(`Consent screen configured for ${projectId}`);
  } catch (error) {
    await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
