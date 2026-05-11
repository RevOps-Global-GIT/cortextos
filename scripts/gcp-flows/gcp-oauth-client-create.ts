#!/usr/bin/env node

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

type Args = Record<string, string | boolean>;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = path.join(SCRIPT_DIR, '.auth/google-session.json');
const DEBUG_SCREENSHOT = path.join(SCRIPT_DIR, 'debug-client-error.png');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

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

function commaList(args: Args, flag: string): string[] {
  return requiredString(args, flag)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function safeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'oauth-client';
}

function extractClientId(text: string): string | undefined {
  return text.match(/[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/)?.[0];
}

function extractClientSecret(text: string): string | undefined {
  return text.match(/GOCSPX-[A-Za-z0-9_-]+/)?.[0];
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

async function selectWebApplication(page: Page): Promise<void> {
  const selects = page.locator('select');
  const selectCount = await selects.count();

  for (let i = 0; i < selectCount; i += 1) {
    const select = selects.nth(i);
    if (!(await isVisible(select))) continue;
    const optionTexts = await select.locator('option').allTextContents();
    const webOption = optionTexts.find((text) => /web application/i.test(text));
    if (webOption) {
      await select.selectOption({ label: webOption });
      return;
    }
  }

  const labelled = page.getByLabel(/application type/i).first();
  if (await isVisible(labelled)) {
    await labelled.click();
  } else {
    const field = page
      .locator('mat-form-field, cfc-form-field, .mat-mdc-form-field, div')
      .filter({ hasText: /application type/i })
      .first();
    if (!(await isVisible(field))) {
      throw new Error('Could not find Application type field');
    }
    await field.click();
  }

  const webApplication = page.getByRole('option', { name: /web application/i }).first();
  if (await isVisible(webApplication)) {
    await webApplication.click();
    return;
  }

  await page.getByText(/web application/i).first().click({ timeout: 10_000 });
}

async function clickAddUri(page: Page, sectionLabel: RegExp, fallbackIndex: number): Promise<void> {
  const section = page
    .locator('section, mat-card, cfc-card, div')
    .filter({ hasText: sectionLabel })
    .filter({ hasText: /add uri/i })
    .first();
  const sectionButton = section.getByRole('button', { name: /add uri/i }).first();

  if (await isVisible(sectionButton)) {
    await sectionButton.click();
    return;
  }

  const buttons = page.getByRole('button', { name: /add uri/i });
  if (await buttons.nth(fallbackIndex).isVisible({ timeout: 2_000 }).catch(() => false)) {
    await buttons.nth(fallbackIndex).click();
    return;
  }

  throw new Error(`Could not find Add URI button for ${sectionLabel.toString()}`);
}

async function fillFocusedOrLastEmptyInput(page: Page, value: string): Promise<void> {
  const inputs = page.locator('input:visible, textarea:visible');
  const inputCount = await inputs.count();

  for (let i = inputCount - 1; i >= 0; i -= 1) {
    const input = inputs.nth(i);
    const inputValue = await input.inputValue().catch(() => undefined);
    if (inputValue === '') {
      await input.fill(value);
      return;
    }
  }

  await page.keyboard.insertText(value);
  const activeValue = await page.evaluate(() => {
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    return active && 'value' in active ? active.value : '';
  });

  if (activeValue === value || activeValue.endsWith(value)) {
    return;
  }

  throw new Error(`Could not find URI input for ${value}`);
}

async function addUris(page: Page, sectionLabel: RegExp, values: string[], fallbackIndex: number): Promise<void> {
  for (const value of values) {
    await clickAddUri(page, sectionLabel, fallbackIndex);
    await page.waitForTimeout(500);
    await fillFocusedOrLastEmptyInput(page, value);
  }
}

async function existingClientText(page: Page, clientName: string): Promise<string | undefined> {
  const row = page.locator('tr, mat-row, cfc-table-row, div[role="row"]').filter({ hasText: clientName }).first();
  if (await isVisible(row)) {
    return (await row.textContent())?.trim() || clientName;
  }

  const plainText = page.getByText(clientName, { exact: false }).first();
  if (await isVisible(plainText)) {
    return (await plainText.textContent())?.trim() || clientName;
  }

  return undefined;
}

async function dialogTextAndValues(page: Page): Promise<string> {
  const dialog = page
    .locator('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container')
    .filter({ hasText: /client id|client secret/i })
    .first();

  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  const text = (await dialog.textContent()) || '';
  const values: string[] = [];
  const inputs = dialog.locator('input, textarea');
  const inputCount = await inputs.count();

  for (let i = 0; i < inputCount; i += 1) {
    const value = await inputs.nth(i).inputValue().catch(() => '');
    if (value) values.push(value);
  }

  return `${text}\n${values.join('\n')}`;
}

async function main(): Promise<void> {
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error('Run gcp-auth-setup first to capture a Google session.');
  }

  const args = parseArgs(process.argv.slice(2));
  const projectId = requiredString(args, '--project-id');
  const clientName = requiredString(args, '--client-name');
  const origins = commaList(args, '--origins');
  const redirectUris = commaList(args, '--redirect-uris');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);

  try {
    await page.goto(
      `https://console.cloud.google.com/apis/credentials?project=${encodeURIComponent(projectId)}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const existing = await existingClientText(page, clientName);
    if (existing) {
      const clientId = extractClientId(existing) || 'client ID not visible in credentials list';
      console.log(`OAuth client ${clientName} already exists: ${clientId}`);
      return;
    }

    await clickFirstVisible(page, [/create credentials/i]);
    await page.getByRole('menuitem', { name: /oauth client id/i }).first().click({ timeout: 30_000 });
    await selectWebApplication(page);
    await fillField(page, [/^name$/i, /application name/i], clientName);
    await addUris(page, /authorized javascript origins/i, origins, 0);
    await addUris(page, /authorized redirect uris/i, redirectUris, 1);
    await clickFirstVisible(page, [/^create$/i]);

    const modalContent = await dialogTextAndValues(page);
    const clientId = extractClientId(modalContent);
    const clientSecret = extractClientSecret(modalContent);

    if (!clientId || !clientSecret) {
      throw new Error('Could not extract client ID and secret from OAuth client modal');
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(OUTPUT_DIR, `${safeFileName(clientName)}-credentials.json`);
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify({ clientId, clientSecret, projectId, createdAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );

    console.log(`OAuth client created: ${clientId}`);
    console.log(`OAuth client secret: ${clientSecret}`);
    console.log(`Credentials saved to ${outputPath}`);

    await clickFirstVisible(page, [/^ok$/i, /^done$/i, /^close$/i]);
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
