#!/usr/bin/env node
import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  findDuplicateListeningPills,
  type ListeningPillCandidate,
} from '../src/dogfood/listening-pill-detector';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');

const BASE_URL = process.env.ESTATE_URL ?? 'https://ob1-parents.vercel.app';
const AUTH_COOKIE = process.env.ESTATE_AUTH_COOKIE ?? 'ob1-parents-auth';
const ROUTES = [
  { name: 'Cottage', path: '/cottage' },
  { name: 'Maintenance', path: '/maintenance' },
  { name: 'Settings', path: '/settings' },
];

function loadEnv(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#') && line.includes('='))
    .reduce((acc, line) => {
      const idx = line.indexOf('=');
      acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {} as Record<string, string>);
}

async function collectListeningPillCandidates(page: Page, pageKey: string): Promise<ListeningPillCandidate[]> {
  return page.evaluate((key) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('.listening-pill, [aria-label*="Listening" i], [class]'));
    return all
      .map((el) => {
        const className = typeof el.className === 'string' ? el.className : String(el.className ?? '');
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const hasListeningClass = className.split(/\s+/).includes('listening-pill');
        const hasListeningLabel = /\blistening\b/i.test(`${ariaLabel} ${text}`);
        const hasPillClass = className.split(/\s+/).some(token => token === 'pill' || token.endsWith('pill') || token.includes('listening-pill'));
        if (!hasListeningClass && !(hasListeningLabel && hasPillClass)) return null;
        return {
          pageKey: key,
          tagName: el.tagName.toLowerCase(),
          text,
          ariaLabel,
          className,
          id: el.id,
          testId: el.getAttribute('data-testid') ?? '',
          selectorHint: `${el.tagName.toLowerCase()}#${el.id || 'no-id'}.${className.replace(/\s+/g, '.')}`,
        };
      })
      .filter(Boolean);
  }, pageKey) as Promise<ListeningPillCandidate[]>;
}

async function main() {
  const env = loadEnv(SECRETS_ENV);
  const authToken = process.env.OB1_PARENTS_AUTH_TOKEN ?? env.OB1_PARENTS_AUTH_TOKEN;
  const sessionToken = process.env.OB1_SESSION_TOKEN ?? env.OB1_SESSION_TOKEN ?? authToken;
  const pin = process.env.OB1_PIN ?? env.OB1_PIN;
  if (!sessionToken && !pin) throw new Error('Set OB1_SESSION_TOKEN, OB1_PIN, or OB1_PARENTS_AUTH_TOKEN');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

  const domain = new URL(BASE_URL).hostname;
  const page = await context.newPage();
  if (sessionToken) {
    await context.addCookies([{
      name: AUTH_COOKIE,
      value: sessionToken,
      domain,
      path: '/',
      httpOnly: AUTH_COOKIE === 'ob1-auth',
      secure: true,
      sameSite: 'Lax',
    }]);
  } else {
    const response = await page.request.post(`${BASE_URL}/api/unlock`, {
      data: { pin },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok()) throw new Error(`PIN auth failed (${response.status()}): ${await response.text()}`);
  }

  const summary = [];
  let failed = false;

  try {
    for (const route of ROUTES) {
      await page.goto(`${BASE_URL}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const candidates = await collectListeningPillCandidates(page, route.name);
      const duplicates = findDuplicateListeningPills(candidates);
      summary.push({
        route: route.path,
        name: route.name,
        url: page.url(),
        candidates: candidates.length,
        duplicates: duplicates.map(group => ({ key: group.key, count: group.count })),
      });
      if (duplicates.length > 0) failed = true;
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({ baseUrl: BASE_URL, failed, summary }, null, 2));
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
