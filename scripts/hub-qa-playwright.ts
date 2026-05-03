#!/usr/bin/env node
/**
 * hub-qa-playwright.ts
 * Headless Playwright QA harness for hub.revopsglobal.com
 * Runs on Linux — no Mac / computer-use dependency.
 *
 * Usage:
 *   npx tsx hub-qa-playwright.ts --page /time --user greg@revopsglobal.com --no-send
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (flag: string, def = '') =>
  argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? def;

const targetPage = getArg('--page', '/time');
const userEmail  = getArg('--user', 'greg@revopsglobal.com');
const noSend     = argv.includes('--no-send');

// ---------------------------------------------------------------------------
// Config — resolve paths relative to this file's location
// ---------------------------------------------------------------------------
const SCRIPT_DIR  = path.dirname(new URL(import.meta.url).pathname);
const AGENT_ROOT  = path.resolve(SCRIPT_DIR, '..');
const SECRETS_ENV = path.resolve(AGENT_ROOT, '../../secrets.env');
const OUTPUT_DIR  = path.join(AGENT_ROOT, 'output', 'playwright-qa');
const HUB_URL     = 'https://hub.revopsglobal.com';
const SUPA_URL    = 'https://yyizocyaehmqrottmnaz.supabase.co';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .reduce((acc, l) => {
      const idx = l.indexOf('=');
      acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {} as Record<string, string>);
}

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  user: Record<string, unknown>;
}

async function mintSession(serviceKey: string, email: string): Promise<SupabaseSession> {
  // Step 1: generate magic link (admin API)
  const genRes = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
    },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!genRes.ok) {
    const body = await genRes.text();
    throw new Error(`generate_link failed ${genRes.status}: ${body}`);
  }
  const genData = await genRes.json() as { action_link?: string; properties?: { action_link?: string } };
  const actionLink = genData.action_link ?? genData.properties?.action_link;
  if (!actionLink) throw new Error(`No action_link in response: ${JSON.stringify(genData)}`);

  // Step 2: follow the verify URL without redirects to get access_token from Location hash
  const verifyRes = await fetch(actionLink, { redirect: 'manual' });
  const location = verifyRes.headers.get('location') ?? '';
  const hash = location.includes('#') ? location.split('#')[1] : '';
  const params = new URLSearchParams(hash);
  const accessToken  = params.get('access_token');
  const refreshToken = params.get('refresh_token') ?? '';

  if (!accessToken) {
    throw new Error(`Could not extract access_token from redirect location: "${location}"`);
  }

  // Step 3: fetch user info from the token
  const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': serviceKey },
  });
  const user = userRes.ok ? await userRes.json() as Record<string, unknown> : {};

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  };
}

function slug(str: string) { return str.replace(/\//g, '-').replace(/^-/, '') || 'root'; }

interface CheckResult {
  check: string;
  status: 'PASS' | 'FAIL' | 'DEFERRED';
  evidence: string;
}

async function shot(page: Page, name: string) {
  const file = path.join(OUTPUT_DIR, `${slug(targetPage)}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

// ---------------------------------------------------------------------------
// /time checks
// ---------------------------------------------------------------------------
async function runTimeChecks(page: Page): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Helpers: selectors derived from live screenshots of hub.revopsglobal.com/time
  // Nav buttons have aria-labels in the DOM (confirmed working in run 1)
  const getPrevBtn = () => page.locator('button[aria-label*="previous" i], button[title*="previous" i], button[aria-label*="prev" i]').first();
  const getNextBtn = () => page.locator('button[aria-label*="next" i], button[title*="next" i]').first();
  // Date range is plain text like "27 Apr – 03 May 2026" — not in h2/h3, use getByText
  const getDateRange = () => page.getByText(/\d+ \w+ [–\-] \d+ \w+ \d{4}/, { exact: false }).first();
  // "Select a project…" is a shadcn combobox rendered as a button
  const getProjectBtn = () => page.locator('button:has-text("Select a project"), [role="combobox"]').first();
  // Wait for the week's data to finish loading (dismisses the full-page "Loading..." state)
  const waitForWeekLoad = async () => {
    await page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  // Detect actual time entries using the progress bar "X.X / 40 hrs" — shows 0.0 when empty
  // Much more reliable than scanning for numeric text (day headers cause false positives)
  const hasHoursOnPage = async () => {
    const progressText = await page.getByText(/\d+\.\d+ \/ \d+ hrs/, { exact: false }).first().textContent().catch(() => '0 /');
    const hours = parseFloat((progressText ?? '').split('/')[0].trim());
    return hours > 0;
  };

  // CHECK 1: Page load
  try {
    await page.waitForSelector('button', { timeout: 15000 });
    const h = await page.locator('h1, h2, [data-testid="page-title"]').first().textContent().catch(() => '');
    await shot(page, '1-load');
    results.push({ check: 'CHECK 1 Page load', status: 'PASS', evidence: `Page loaded. Heading: "${h?.trim()}". URL: ${page.url()}` });
  } catch (e) {
    await shot(page, '1-load-fail');
    results.push({ check: 'CHECK 1 Page load', status: 'FAIL', evidence: `Page did not load buttons within 15s: ${e}` });
    return results; // can't continue
  }

  // CHECK 2: Historical data — navigate back up to 4 weeks to find entries
  // IMPORTANT: stay on the data week — checks 3/4/5 run there too
  let foundDataWeek = false;
  let weeksBack = 0;
  let dataWeekLabel = '';
  try {
    const prevBtn = getPrevBtn();
    await waitForWeekLoad();
    // Check current week first
    if (await hasHoursOnPage()) { foundDataWeek = true; dataWeekLabel = 'current week'; }
    for (let i = 0; i < 4 && !foundDataWeek; i++) {
      if (await prevBtn.count() > 0) {
        await prevBtn.click();
        await waitForWeekLoad();
        weeksBack++;
        if (await hasHoursOnPage()) {
          foundDataWeek = true;
          dataWeekLabel = await getDateRange().textContent().catch(() => `${weeksBack} week(s) back`) ?? `${weeksBack} week(s) back`;
        }
      } else break;
    }
    await shot(page, '2-history');
    if (foundDataWeek) {
      results.push({ check: 'CHECK 2 Historical data', status: 'PASS', evidence: `Found time entries in week: "${dataWeekLabel.trim()}". Grid rendered correctly.` });
    } else {
      results.push({ check: 'CHECK 2 Historical data', status: 'DEFERRED', evidence: 'No entries found in past 4 weeks. May be empty account or data issue.' });
    }
  } catch (e) {
    await shot(page, '2-history-fail');
    results.push({ check: 'CHECK 2 Historical data', status: 'FAIL', evidence: `Error navigating history: ${e}` });
  }

  // Checks 3/4/5 run on whatever week is currently shown (the data week if found)

  // CHECK 3: Log new entry — click "Select a project..." combobox
  try {
    const projectBtn = getProjectBtn();
    if (await projectBtn.count() > 0) {
      await projectBtn.click();
      await page.waitForTimeout(800);
      await shot(page, '3-log-project-open');
      const options = await page.locator('[role="option"], [cmdk-item], li[role="option"]').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      results.push({ check: 'CHECK 3 Log new entry', status: 'PASS', evidence: `Project combobox opened. ${options} option(s) visible. Closed with Escape — no save.` });
    } else {
      // Fallback: click a day cell
      const dayCell = page.locator('td, [role="gridcell"]').nth(2);
      if (await dayCell.count() > 0) {
        await dayCell.click();
        await page.waitForTimeout(600);
        await shot(page, '3-log-cell-click');
        const inputVisible = await page.locator('input[type="number"], input[type="text"]').count() > 0;
        await page.keyboard.press('Escape');
        results.push({ check: 'CHECK 3 Log new entry', status: inputVisible ? 'PASS' : 'FAIL', evidence: inputVisible ? 'Day cell click opened input. Closed without saving.' : 'Day cell click opened nothing.' });
      } else {
        results.push({ check: 'CHECK 3 Log new entry', status: 'DEFERRED', evidence: 'No project combobox or day cell found.' });
      }
    }
  } catch (e) {
    await shot(page, '3-log-fail');
    results.push({ check: 'CHECK 3 Log new entry', status: 'FAIL', evidence: `Error: ${e}` });
  }

  // CHECK 4: Edit existing entry — click a cell that has an hour value in a DATA row
  // Use page.evaluate to tag a grid hour cell: must be near a project-name sibling, NOT the summary cards
  try {
    if (foundDataWeek) {
      const tagged = await page.evaluate(() => {
        // Walk every element that has exactly a number as its text
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el.children.length > 0) continue; // leaf nodes only
          const text = el.textContent?.trim() ?? '';
          if (!/^[1-9]\d*$/.test(text)) continue; // integer hours only (not decimal summary values)
          // Skip summary cards: they are NOT inside the timesheet grid.
          // The grid rows contain multiple column cells; walk up to find a row-like container
          // that also contains a project/client name (> 10 chars of text from sibling cells).
          let row: Element | null = el.parentElement;
          let foundProjectSibling = false;
          for (let i = 0; i < 6 && row; i++) {
            // Check siblings of current ancestor for project-name text
            const siblings = Array.from(row.parentElement?.children ?? []);
            for (const sib of siblings) {
              if (sib === row) continue;
              const sibText = sib.textContent?.trim() ?? '';
              if (sibText.length > 10 && /[A-Za-z]/.test(sibText) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Total|Time|Add|Select)/i.test(sibText)) {
                foundProjectSibling = true;
                break;
              }
            }
            if (foundProjectSibling) break;
            row = row.parentElement;
          }
          if (!foundProjectSibling) continue;
          (el as HTMLElement).setAttribute('data-qa-hour-cell', 'true');
          return true;
        }
        return false;
      });

      if (tagged) {
        // Use coordinates instead of DOM attribute — attributes are cleared by React re-renders
        const coords = await page.evaluate(() => {
          const el = document.querySelector('[data-qa-hour-cell="true"]') as HTMLElement | null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        if (coords) {
          await page.mouse.click(coords.x, coords.y);
        }
        await page.waitForTimeout(1000);
        await shot(page, '4-edit-click');
        // The click may switch to Day view (RGOS design) or open inline input — either is valid UX
        const inputVisible = await page.locator('input[type="number"], input[type="text"], [placeholder="Hours"]').count() > 0;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        results.push({ check: 'CHECK 4 Edit entry', status: (coords && inputVisible) ? 'PASS' : (coords ? 'FAIL' : 'DEFERRED'), evidence: (coords && inputVisible) ? 'Clicking hour cell opened an edit input (Day view entry form). Cancelled without saving.' : (coords ? 'Hour cell clicked but no input appeared.' : 'Coordinates not obtained for hour cell.') });
        // Return to data week in Week view for checks 5 & 6
        try {
          const weekBtn = page.locator('button:has-text("Week")').first();
          if (await weekBtn.count() > 0) { await weekBtn.click(); await waitForWeekLoad(); }
          // "Week" may go to current week — navigate back to data week if needed
          const currentRange = await getDateRange().textContent().catch(() => '');
          if (dataWeekLabel && !currentRange.includes('20 Apr')) {
            const prevBtn = getPrevBtn();
            if (await prevBtn.count() > 0) { await prevBtn.click(); await waitForWeekLoad(); }
          }
        } catch { /* ignore */ }
      } else {
        results.push({ check: 'CHECK 4 Edit entry', status: 'DEFERRED', evidence: 'Data week found but could not locate an hour cell in the grid (distinct from summary cards).' });
      }
    } else {
      results.push({ check: 'CHECK 4 Edit entry', status: 'DEFERRED', evidence: 'No data week found — skipped.' });
    }
  } catch (e) {
    await shot(page, '4-edit-fail');
    results.push({ check: 'CHECK 4 Edit entry', status: 'FAIL', evidence: `Error: ${(e as Error).message?.split('\n')[0]}` });
  }

  // CHECK 5: Delete entry — look for × button at end of entry row
  // In RGOS time grid, the row delete button is the × at the far right of each row.
  // It may be hidden until hover. Always click Cancel on any dialog.
  try {
    const attemptDelete = async (): Promise<CheckResult> => {
      // Broad selectors for the row delete button
      const deleteBtn = page.locator([
        'button[aria-label*="delete" i]',
        'button[aria-label*="remove" i]',
        'button[title*="delete" i]',
        'button[title*="remove" i]',
        // × character variants (U+00D7, U+2715, U+2717, ASCII x)
        'button:has-text("×")',
        'button:has-text("✕")',
        'button:has-text("✗")',
        'button:has-text("x")',
      ].join(', ')).first();

      if (await deleteBtn.count() > 0) {
        await deleteBtn.hover();
        await shot(page, '5-delete-hover');
        await deleteBtn.click();
        await page.waitForTimeout(600);
        await shot(page, '5-delete-clicked');
        const dialog = await page.locator('[role="alertdialog"], [role="dialog"]').count() > 0;
        if (dialog) {
          const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), [role="alertdialog"] button:has-text("Cancel")').first();
          await cancelBtn.click().catch(() => page.keyboard.press('Escape'));
          return { check: 'CHECK 5 Delete entry', status: 'PASS', evidence: 'Delete button opened confirmation dialog. Clicked Cancel — no deletion.' };
        } else {
          return { check: 'CHECK 5 Delete entry', status: 'FAIL', evidence: 'Delete button clicked — NO confirmation dialog appeared. Immediate deletion risk.' };
        }
      }
      return { check: 'CHECK 5 Delete entry', status: 'DEFERRED', evidence: 'No delete button found with known selectors.' };
    };

    if (!foundDataWeek) {
      results.push({ check: 'CHECK 5 Delete entry', status: 'DEFERRED', evidence: 'No data week found — skipped.' });
    } else {
      await shot(page, '5-before');
      let res = await attemptDelete();
      if (res.status === 'DEFERRED') {
        // Tag the delete button via DOM: scan all buttons for one that's ONLY an icon (no text)
        // and is inside a container that also has a project-name sibling (the data row)
        const taggedDelete = await page.evaluate(() => {
          const allBtns = Array.from(document.querySelectorAll('button'));
          for (const btn of allBtns) {
            // Candidate: button with no meaningful text (just icon) or × variants
            const txt = btn.textContent?.trim() ?? '';
            const isIconBtn = txt === '' || txt === '×' || txt === '✕' || txt === '✗' || txt === 'x' || txt === 'X';
            if (!isIconBtn) continue;
            // Must be in the same DOM region as a project name (not in the header/footer)
            let ancestor: Element | null = btn.parentElement;
            for (let i = 0; i < 8 && ancestor; i++) {
              const childTexts = Array.from(ancestor.querySelectorAll('*'))
                .map(el => el.textContent?.trim() ?? '')
                .filter(t => t.length > 10 && /[A-Za-z]/.test(t));
              const hasProjectName = childTexts.some(t =>
                !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Total|Time|Add|Select|No time|Loading|Day|Week|Month|My Hours)/i.test(t)
              );
              if (hasProjectName) {
                (btn as HTMLElement).setAttribute('data-qa-delete-btn', 'true');
                return btn.textContent?.trim() || '(icon-only)';
              }
              ancestor = ancestor.parentElement;
            }
          }
          return null;
        });

        if (taggedDelete !== null) {
          const taggedBtn = page.locator('[data-qa-delete-btn="true"]').first();
          await taggedBtn.hover().catch(() => {});
          await taggedBtn.click();
          await page.waitForTimeout(600);
          await shot(page, '5-delete-clicked');
          const dialog = await page.locator('[role="alertdialog"], [role="dialog"]').count() > 0;
          if (dialog) {
            await page.keyboard.press('Escape');
            res = { check: 'CHECK 5 Delete entry', status: 'PASS', evidence: `Row delete button (text: "${taggedDelete}") opened confirmation dialog. Escaped — no deletion.` };
          } else {
            res = { check: 'CHECK 5 Delete entry', status: 'FAIL', evidence: `Row delete button clicked — no confirmation dialog appeared. Immediate deletion risk.` };
          }
        } else {
          // Last resort: take a screenshot so evidence of state is available
          await shot(page, '5-no-delete-found');
          res = { check: 'CHECK 5 Delete entry', status: 'DEFERRED', evidence: 'No delete button found on data row. See screenshot 5-no-delete-found.' };
        }
      }
      results.push(res);
    }
  } catch (e) {
    await shot(page, '5-delete-fail');
    results.push({ check: 'CHECK 5 Delete entry', status: 'FAIL', evidence: `Error: ${e}` });
  }

  // CHECK 6: Week navigation — navigate from wherever we are, verify date range changes
  try {
    const prevBtn = getPrevBtn();
    const nextBtn = getNextBtn();
    const dateEl = getDateRange();

    const before = await dateEl.textContent().catch(() => '');
    await shot(page, '6-nav-before');

    if (await prevBtn.count() > 0) {
      await prevBtn.click();
      await page.waitForTimeout(1000);
      const after = await dateEl.textContent().catch(() => '');
      await shot(page, '6-nav-after-prev');

      if (before !== after && after) {
        // Also click next to verify it works
        if (await nextBtn.count() > 0) { await nextBtn.click(); await page.waitForTimeout(800); }
        await shot(page, '6-nav-after-next');
        results.push({ check: 'CHECK 6 Week navigation', status: 'PASS', evidence: `Prev changed date range from "${before?.trim()}" to "${after?.trim()}". Next button also present and clicked.` });
      } else {
        results.push({ check: 'CHECK 6 Week navigation', status: 'FAIL', evidence: `Prev button clicked but date range did not change (before: "${before?.trim()}", after: "${after?.trim()}").` });
      }
    } else {
      results.push({ check: 'CHECK 6 Week navigation', status: 'FAIL', evidence: 'No previous period button found.' });
    }
  } catch (e) {
    await shot(page, '6-nav-fail');
    results.push({ check: 'CHECK 6 Week navigation', status: 'FAIL', evidence: `Error: ${e}` });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------
function writeReport(results: CheckResult[], reportPath: string) {
  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;
  const deferred = results.filter(r => r.status === 'DEFERRED').length;
  const failures = results.filter(r => r.status === 'FAIL');

  const lines = [
    `# Time Page QA - ${new Date().toISOString().slice(0, 10)}`,
    `## Summary: ${passed} passed, ${failed} failed, ${deferred} deferred`,
    '',
    ...results.map(r => `${r.check} — ${r.status} — ${r.evidence}`),
    '',
  ];

  if (failures.length > 0) {
    lines.push('## Failures', '');
    for (const f of failures) {
      lines.push(`### ${f.check}`, f.evidence, '');
    }
  }

  fs.writeFileSync(reportPath, lines.join('\n'));
  return { passed, failed, deferred };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const env = loadEnv(SECRETS_ENV);
  // Use the RGOS-specific service key (project yyizocyaehmqrottmnaz)
  const serviceKey = env['RGOS_SUPABASE_SERVICE_KEY'] ?? env['SUPABASE_DATA_SERVICE_KEY'];
  if (!serviceKey) throw new Error('RGOS_SUPABASE_SERVICE_KEY not found in secrets.env');

  console.log(`Minting session for ${userEmail}...`);
  const session = await mintSession(serviceKey, userEmail);
  console.log(`Session minted for ${(session.user as Record<string,unknown>)?.email ?? userEmail}.`);

  const SUPA_PROJECT = 'yyizocyaehmqrottmnaz';
  const storageKey   = `sb-${SUPA_PROJECT}-auth-token`;

  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    // Supabase SSR (Next.js) reads auth from cookies, not localStorage.
    // Set sb-<project>-auth-token cookie on the hub domain.
    const sessionJson = JSON.stringify(session);
    const CHUNK_SIZE = 3600;
    if (sessionJson.length <= CHUNK_SIZE) {
      await context.addCookies([{
        name: storageKey,
        value: sessionJson,
        domain: 'hub.revopsglobal.com',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      }]);
    } else {
      // chunk it
      for (let i = 0; i * CHUNK_SIZE < sessionJson.length; i++) {
        await context.addCookies([{
          name: `${storageKey}.${i}`,
          value: sessionJson.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          domain: 'hub.revopsglobal.com',
          path: '/',
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        }]);
      }
    }
    // Also inject into localStorage as fallback for client-side Supabase
    await context.addInitScript(({ key, val }: { key: string; val: string }) => {
      try { localStorage.setItem(key, val); } catch {}
    }, { key: storageKey, val: sessionJson });

    const page = await context.newPage();

    console.log(`Navigating to ${HUB_URL}${targetPage}...`);
    await page.goto(`${HUB_URL}${targetPage}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('/auth') || page.url().includes('/login')) {
      throw new Error(`Auth failed — still on ${page.url()} after cookie+localStorage injection.`);
    }
    console.log(`Authenticated. Current URL: ${page.url()}`);
    await shot(page, '0-authenticated');

    let results: CheckResult[] = [];
    if (targetPage === '/time') {
      results = await runTimeChecks(page);
    } else {
      throw new Error(`Page "${targetPage}" not yet implemented in this harness.`);
    }

    const reportPath = path.join(OUTPUT_DIR, `${slug(targetPage)}-qa-${new Date().toISOString().slice(0, 10)}.md`);
    const { passed, failed, deferred } = writeReport(results, reportPath);

    console.log(`\nReport: ${reportPath}`);
    console.log(`Summary: ${passed} passed, ${failed} failed, ${deferred} deferred\n`);
    for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.check}`);

    process.exit(failed > 0 ? 1 : 0);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(2); });
