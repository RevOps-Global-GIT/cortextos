import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const SECRETS_ENV = path.join(REPO_ROOT, 'orgs/revops-global/secrets.env');
const HUB_URL = 'https://hub.revopsglobal.com';
const USER_EMAIL = 'greg@revopsglobal.com';
const STORAGE_KEY = 'sb-yyizocyaehmqrottmnaz-auth-token';

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
}

interface CleanupState {
  dealTitle: string;
  originalDeal: DealRecord;
}

let session: SupabaseSession;
let supabaseUrl: string;
let serviceKey: string;
let cleanupState: CleanupState | undefined;
let dragMethodWorked = 'not-run';

interface DealRecord {
  id: string;
  name: string;
  deal_stage: string;
  deal_stage_label: string;
  deal_stage_id: string;
  is_closed: boolean;
  is_won: boolean;
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);
test.use({ viewport: { width: 3000, height: 1000 } });

function loadEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .reduce((acc, line) => {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      acc[key] = value;
      return acc;
    }, {} as Record<string, string>);
}

async function mintSession(): Promise<SupabaseSession> {
  const env = { ...process.env, ...loadEnv(SECRETS_ENV) };
  supabaseUrl = env.SUPABASE_RGOS_URL;
  serviceKey = env.SUPABASE_RGOS_SERVICE_KEY;

  if (!supabaseUrl) throw new Error('SUPABASE_RGOS_URL not found in orgs/revops-global/secrets.env or process.env');
  if (!serviceKey) throw new Error('SUPABASE_RGOS_SERVICE_KEY not found in orgs/revops-global/secrets.env or process.env');

  const genRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify({ type: 'magiclink', email: USER_EMAIL }),
  });

  if (!genRes.ok) {
    throw new Error(`generate_link failed ${genRes.status}: ${await genRes.text()}`);
  }

  const genData = await genRes.json() as { action_link?: string; properties?: { action_link?: string } };
  const actionLink = genData.action_link ?? genData.properties?.action_link;
  if (!actionLink) throw new Error(`No action_link in response: ${JSON.stringify(genData)}`);

  const verifyRes = await fetch(actionLink, { redirect: 'manual' });
  const location = verifyRes.headers.get('location') ?? '';
  const hash = location.includes('#') ? location.split('#')[1] : '';
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token') ?? '';

  if (!accessToken) {
    throw new Error(`Could not extract access_token from redirect location: "${location}"`);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function fetchDealByTitle(dealTitle: string): Promise<DealRecord> {
  const url = new URL(`${supabaseUrl}/rest/v1/deals`);
  url.searchParams.set('select', 'id,name,deal_stage,deal_stage_label,deal_stage_id,is_closed,is_won');
  url.searchParams.set('name', `eq.${dealTitle}`);
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });

  if (!res.ok) throw new Error(`Could not fetch deal for cleanup ${res.status}: ${await res.text()}`);

  const deals = await res.json() as DealRecord[];
  if (deals.length !== 1) throw new Error(`Expected exactly one deal named "${dealTitle}", found ${deals.length}`);
  return deals[0];
}

async function restoreDealStage(deal: DealRecord) {
  const url = new URL(`${supabaseUrl}/rest/v1/deals`);
  url.searchParams.set('id', `eq.${deal.id}`);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      deal_stage: deal.deal_stage,
      deal_stage_label: deal.deal_stage_label,
      deal_stage_id: deal.deal_stage_id,
      is_closed: deal.is_closed,
      is_won: deal.is_won,
    }),
  });

  if (!res.ok) throw new Error(`Could not restore deal stage ${res.status}: ${await res.text()}`);
}

async function authenticate(page: Page) {
  await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, value }) => {
    localStorage.setItem(key, value);
  }, { key: STORAGE_KEY, value: JSON.stringify(session) });
}

function kanbanColumns(page: Page) {
  return page.locator('main div[class*="flex flex-col shrink-0"]');
}

function dealCards(scope: Page | Locator) {
  return scope.locator('[role="button"][class*="cursor-grab"]');
}

function cardByTitle(scope: Page | Locator, title: string) {
  return dealCards(scope).filter({ hasText: title }).first();
}

async function waitForPipeline(page: Page) {
  await page.goto(`${HUB_URL}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => await kanbanColumns(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => await dealCards(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(1);
}

async function findSourceAndTargetIndexes(columns: Locator) {
  const columnCount = await columns.count();
  expect(columnCount).toBeGreaterThanOrEqual(2);

  if (await dealCards(columns.nth(0)).count() > 0) {
    return { sourceIndex: 0, targetIndex: 1 };
  }

  for (let i = 0; i < columnCount; i++) {
    if (await dealCards(columns.nth(i)).count() > 0) {
      return { sourceIndex: i, targetIndex: i < columnCount - 1 ? i + 1 : i - 1 };
    }
  }

  throw new Error('No deal cards found in any pipeline column');
}

async function visibleBox(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} has no visible bounding box`);
  return box;
}

function dropArea(column: Locator) {
  return column.locator(':scope > div').nth(2);
}

async function mouseDrag(page: Page, card: Locator, targetColumn: Locator) {
  const target = dropArea(targetColumn);
  const sourceBox = await visibleBox(card, 'source card');
  const targetBox = await visibleBox(target, 'target column');
  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetCenter = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + Math.min(targetBox.height / 2, 80),
  };

  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();

  for (let step = 1; step <= 20; step++) {
    await page.mouse.move(
      sourceCenter.x + ((targetCenter.x - sourceCenter.x) * step) / 20,
      sourceCenter.y + ((targetCenter.y - sourceCenter.y) * step) / 20,
    );
  }

  await page.mouse.up();
}

async function pointerEventDrag(card: Locator, targetColumn: Locator) {
  const target = dropArea(targetColumn);
  const sourceBox = await visibleBox(card, 'source card');
  const targetBox = await visibleBox(target, 'target column');
  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetCenter = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + Math.min(targetBox.height / 2, 80),
  };

  await card.evaluate(async (element, points) => {
    const pointerId = 7;
    const dispatchPointer = (target: EventTarget, type: string, x: number, y: number, buttons: number) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      }));
    };
    const dispatchMouse = (target: EventTarget, type: string, x: number, y: number, buttons: number) => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      }));
    };
    const targetAt = (x: number, y: number) => document.elementFromPoint(x, y) ?? document;

    dispatchPointer(element, 'pointerover', points.source.x, points.source.y, 1);
    dispatchPointer(element, 'pointerenter', points.source.x, points.source.y, 1);
    dispatchPointer(element, 'pointermove', points.source.x, points.source.y, 1);
    dispatchPointer(element, 'pointerdown', points.source.x, points.source.y, 1);
    dispatchMouse(element, 'mousedown', points.source.x, points.source.y, 1);

    try {
      if ('setPointerCapture' in element) element.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is optional for this synthetic fallback.
    }

    for (let step = 1; step <= 20; step++) {
      const x = points.source.x + ((points.target.x - points.source.x) * step) / 20;
      const y = points.source.y + ((points.target.y - points.source.y) * step) / 20;
      const moveTarget = targetAt(x, y);

      dispatchPointer(moveTarget, 'pointermove', x, y, 1);
      dispatchMouse(moveTarget, 'mousemove', x, y, 1);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    const upTarget = targetAt(points.target.x, points.target.y);
    dispatchPointer(upTarget, 'pointerup', points.target.x, points.target.y, 0);
    dispatchMouse(upTarget, 'mouseup', points.target.x, points.target.y, 0);
  }, { source: sourceCenter, target: targetCenter });
}

async function locatorDragTo(card: Locator, targetColumn: Locator) {
  await card.dragTo(dropArea(targetColumn), {
    force: true,
    sourcePosition: { x: 100, y: 44 },
    targetPosition: { x: 130, y: 33 },
    timeout: 10000,
  });
}

async function expectCardInColumn(column: Locator, dealTitle: string) {
  await expect.poll(async () => await column.getByText(dealTitle, { exact: true }).count(), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
}

async function dragCardToColumn(page: Page, sourceColumn: Locator, targetColumn: Locator, dealTitle: string, sourceCard?: Locator) {
  await locatorDragTo(sourceCard ?? cardByTitle(sourceColumn, dealTitle), targetColumn);
  await page.waitForTimeout(3000);

  if (await targetColumn.getByText(dealTitle, { exact: true }).count() > 0) {
    return 'locator.dragTo';
  }

  await mouseDrag(page, cardByTitle(sourceColumn, dealTitle), targetColumn);
  await page.waitForTimeout(2000);

  if (await targetColumn.getByText(dealTitle, { exact: true }).count() > 0) {
    return 'page.mouse';
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  try {
    await pointerEventDrag(cardByTitle(sourceColumn, dealTitle), targetColumn);
    await page.waitForTimeout(2000);

    if (await targetColumn.getByText(dealTitle, { exact: true }).count() > 0) {
      return 'synthetic PointerEvent';
    }
  } catch (error) {
    test.info().annotations.push({
      type: 'pointer-fallback',
      description: `Synthetic PointerEvent drag did not complete: ${String(error)}`,
    });
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible({ timeout: 20000 });
  await expectCardInColumn(sourceColumn, dealTitle);
  await page.waitForTimeout(3000);
  await locatorDragTo(cardByTitle(sourceColumn, dealTitle), targetColumn);
  await page.waitForTimeout(3000);
  await expectCardInColumn(targetColumn, dealTitle);
  return 'locator.dragTo';
}

test.beforeAll(async () => {
  session = await mintSession();
});

test.beforeEach(async ({ page }) => {
  cleanupState = undefined;
  await authenticate(page);
  await waitForPipeline(page);
});

test.afterEach(async ({ page }) => {
  if (!cleanupState) return;

  await restoreDealStage(cleanupState.originalDeal);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(cleanupState.originalDeal.deal_stage_label, { exact: true }).first()).toBeVisible({ timeout: 20000 });
  cleanupState = undefined;
});

test('pipeline deal cards can be dragged between stage columns and persist after reload', async ({ page }) => {
  const columns = kanbanColumns(page);
  const columnCount = await columns.count();
  const totalCards = await dealCards(page).count();

  expect(columnCount).toBeGreaterThanOrEqual(2);
  expect(totalCards).toBeGreaterThanOrEqual(1);

  const { sourceIndex, targetIndex } = await findSourceAndTargetIndexes(columns);
  const sourceColumn = columns.nth(sourceIndex);
  const targetColumn = columns.nth(targetIndex);
  const sourceCard = dealCards(sourceColumn).first();
  const sourceBox = await visibleBox(sourceCard, 'source card');
  const dealTitle = (await sourceCard.locator('p').first().innerText()).trim();
  const originalDeal = await fetchDealByTitle(dealTitle);

  cleanupState = { dealTitle, originalDeal };

  expect(dealTitle).toBeTruthy();
  expect(sourceBox.width).toBeGreaterThan(0);
  expect(sourceBox.height).toBeGreaterThan(0);
  await visibleBox(dropArea(targetColumn), 'target column');

  dragMethodWorked = await dragCardToColumn(page, sourceColumn, targetColumn, dealTitle, sourceCard);
  console.log(`BAKEOFF_DRAG_METHOD: ${dragMethodWorked}`);

  await expectCardInColumn(targetColumn, dealTitle);
  await expect(sourceColumn.getByText(dealTitle, { exact: true })).toHaveCount(0);

  try {
    const toast = page.locator('[role="status"], [class*="toast" i], [class*="sonner" i]')
      .or(page.getByText(/stage|updated/i))
      .first();
    await expect.soft(toast).toBeVisible({ timeout: 3000 });
  } catch (error) {
    test.info().annotations.push({
      type: 'toast',
      description: `No toast/status notification observed after stage change: ${String(error)}`,
    });
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible({ timeout: 20000 });
  await expectCardInColumn(columns.nth(targetIndex), dealTitle);

  test.info().annotations.push({
    type: 'drag-method',
    description: dragMethodWorked,
  });
});
