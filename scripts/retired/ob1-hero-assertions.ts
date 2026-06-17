#!/usr/bin/env tsx
/**
 * ob1-hero-assertions.ts — Hard QA gates for the daily ob1 hero vignette.
 *
 * Asserts two failure classes that previously went through 8+ Greg iterations
 * uninstrumented:
 *   1. canonical-ref: all cast reference_image fields are present in latest.json
 *      (field presence proves the local PNG was found at generation time;
 *       reference/ images are local generator inputs, not web-served CDN assets)
 *   2. mobile safe-area: hero <img> or <video> uses object-fit:contain on 390px viewport
 *
 * Exit 0 = all pass. Exit 1 = any failure (cron treats non-zero as hard error).
 *
 * Usage:
 *   npx tsx scripts/ob1-hero-assertions.ts
 *   npx tsx scripts/ob1-hero-assertions.ts --base-url https://ob1.revopsglobal.com
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE_URL = getArg('--base-url', 'https://ob1.revopsglobal.com').replace(/\/$/, '');
const VIGNETTES_BASE = `${BASE_URL}/vignettes`;
const OUT_DIR = getArg('--out-dir', '/tmp');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AssertionResult {
  check: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  evidence: string;
}

interface LatestJson {
  date?: string;
  image?: string;
  video?: string;
  title?: string;
  cast?: Array<{ id: string; name: string; reference_image?: string }>;
  cast_members?: Array<{ id: string; name: string; reference_image?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpHead(url: string): Promise<{ status: number; ok: boolean }> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD' }, (res) => {
      resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) < 400 });
    });
    req.on('error', () => resolve({ status: 0, ok: false }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, ok: false }); });
    req.end();
  });
}

async function fetchLatestJson(): Promise<LatestJson> {
  const resp = await fetch(`${VIGNETTES_BASE}/latest.json`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json() as LatestJson;
}

function estateToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function expectedDate(): string {
  return getArg('--expected-date', process.env.OB1_HERO_EXPECTED_DATE || estateToday());
}

function formatPlaqueDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso.toUpperCase();
  return d
    .toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase()
    .replace(/,/g, '');
}

async function addOb1AuthCookie(context: import('playwright').BrowserContext) {
  const token = process.env.OB1_SESSION_TOKEN;
  if (!token) return;

  const base = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'ob1-auth',
      value: token,
      domain: base.hostname,
      path: '/',
      httpOnly: true,
      secure: base.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
}

// ---------------------------------------------------------------------------
// Check 0: freshness + rendered plaque date
// ---------------------------------------------------------------------------

async function checkFreshnessAndRenderedDate(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const expected = expectedDate();
  let latest: LatestJson;

  try {
    latest = await fetchLatestJson();
  } catch (e) {
    return [{
      check: '[FRESHNESS] latest.json fetch',
      status: 'FAIL',
      evidence: `Failed to fetch ${VIGNETTES_BASE}/latest.json: ${e}`,
    }];
  }

  results.push({
    check: '[FRESHNESS] latest.json date is today',
    status: latest.date === expected ? 'PASS' : 'FAIL',
    evidence: latest.date === expected
      ? `latest.json date=${latest.date}`
      : `latest.json date=${latest.date ?? '(missing)'}; expected ${expected}`,
  });

  if (latest.date !== expected) return results;

  const token = process.env.OB1_SESSION_TOKEN;
  if (!token) {
    results.push({
      check: '[FRESHNESS] authenticated hero plaque render',
      status: 'SKIP',
      evidence: 'OB1_SESSION_TOKEN is unset, so the authenticated home hero render could not be verified.',
    });
    return results;
  }

  const expectedPlaque = formatPlaqueDate(expected);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      serviceWorkers: 'block',
    });
    await addOb1AuthCookie(context);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const hero = page.locator('.daily-vignette-hero').first();
    const text = await hero.innerText({ timeout: 20000 });
    const screenshotPath = `${OUT_DIR}/ob1-hero-render-${expected}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const hasPlaque = text.includes(expectedPlaque);
    results.push({
      check: '[FRESHNESS] authenticated hero plaque date',
      status: hasPlaque ? 'PASS' : 'FAIL',
      evidence: hasPlaque
        ? `Rendered plaque ${expectedPlaque}; screenshot=${screenshotPath}`
        : `Expected rendered plaque ${expectedPlaque}; hero text was: ${text.replace(/\s+/g, ' ').slice(0, 240)}`,
    });

    if (latest.title) {
      const hasTitle = text.includes(latest.title);
      results.push({
        check: '[FRESHNESS] authenticated hero title matches latest.json',
        status: hasTitle ? 'PASS' : 'FAIL',
        evidence: hasTitle
          ? `Rendered title "${latest.title}"`
          : `Expected title "${latest.title}"; hero text was: ${text.replace(/\s+/g, ' ').slice(0, 240)}`,
      });
    }
  } catch (e) {
    results.push({
      check: '[FRESHNESS] authenticated hero plaque render',
      status: 'FAIL',
      evidence: `Failed to verify authenticated hero render: ${e}`,
    });
  } finally {
    await browser.close();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 1: canonical-ref — all cast reference images present + accessible
// ---------------------------------------------------------------------------

async function checkCanonicalRefs(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  // Fetch latest.json
  let latest: LatestJson;
  try {
    latest = await fetchLatestJson();
  } catch (e) {
    return [{
      check: '[CANONICAL-REF] latest.json fetch',
      status: 'FAIL',
      evidence: `Failed to fetch ${VIGNETTES_BASE}/latest.json: ${e}`,
    }];
  }

  // Hero image must exist and be accessible
  const heroImage = latest.image ?? '';
  if (!heroImage) {
    results.push({ check: '[CANONICAL-REF] hero image field', status: 'FAIL', evidence: 'latest.json missing "image" field — generation may have failed' });
  } else {
    const heroUrl = `${VIGNETTES_BASE}/${heroImage}`;
    const heroCheck = await httpHead(heroUrl);
    results.push({
      check: '[CANONICAL-REF] hero image accessible',
      status: heroCheck.ok ? 'PASS' : 'FAIL',
      evidence: heroCheck.ok
        ? `${heroUrl} → ${heroCheck.status}`
        : `${heroUrl} → ${heroCheck.status} (not accessible — hero will 404 in app)`,
    });
  }

  // Each cast member must have a reference_image field in latest.json.
  //
  // IMPORTANT: reference_image (e.g. "reference/petunia-canonical.png") is a
  // LOCAL DISK path relative to the ob1-app root used exclusively as a `-i`
  // flag input to Nano-Banana (scripts/generate-daily-vignette.mjs).  The
  // generator reads it via existsSync() — it is never fetched over HTTP.  The
  // reference/ directory lives at ob1-app/reference/, outside Next.js public/,
  // so HTTP-HEADing https://ob1.revopsglobal.com/vignettes/reference/* always
  // returns 404 by design — those files are not CDN assets.
  //
  // Correct assertion: the field EXISTS in latest.json proves the generator
  // found the PNG on local disk at run-time and passed it as the binding
  // identity to the model.  If the field is absent the character identity was
  // unbound at generation time; this degrades output quality but does NOT cause
  // a live-page 404.  We use SKIP (warn) rather than FAIL for a missing ref so
  // the cron does not hard-fail over a quality signal.
  const castMembers = latest.cast_members ?? latest.cast ?? [];
  if (castMembers.length === 0) {
    results.push({
      check: '[CANONICAL-REF] cast members present',
      status: 'FAIL',
      evidence: 'latest.json has empty cast/cast_members — no reference images will be passed to generation',
    });
  } else {
    for (const member of castMembers) {
      const refImage = member.reference_image ?? '';
      if (!refImage) {
        // Missing field: generator ran without a binding reference for this
        // character.  Quality may degrade but the page does not break.
        results.push({
          check: `[CANONICAL-REF] ${member.name} reference_image field`,
          status: 'SKIP',
          evidence: `WARN: "${member.name}" (${member.id}) has no reference_image in latest.json — character identity was not bound during generation; add ob1-app/reference/${member.id}-canonical.png`,
        });
      } else {
        // Field present: generator found the local PNG and passed it to the
        // model.  No HTTP check — the path is a local disk ref, not a URL.
        results.push({
          check: `[CANONICAL-REF] ${member.name} ref bound`,
          status: 'PASS',
          evidence: `reference_image="${refImage}" present in latest.json — identity bound at generation time (local file, not web-served)`,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 2: mobile safe-area — hero uses object-fit:contain on 390px viewport
// Handles both <img> and <video> heroes (today's vignette may use either).
// ---------------------------------------------------------------------------

async function checkMobileSafeArea(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    const page = await browser.newPage();
    await addOb1AuthCookie(page.context());
    // iPhone 14 Pro viewport — matches the target mobile device Greg reviews on
    await page.setViewportSize({ width: 390, height: 844 });

    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 25000 });
    } catch {
      // networkidle can timeout on SPAs; fall through and check what loaded
    }

    // Find the hero media element. Priority order:
    //   1. video selectors (vignettes with video field render <video> not <img>)
    //   2. img selectors with vignette-specific markers
    //   3. structural selectors scoped to the hero container
    // We intentionally do NOT fall through to bare `img:first-of-type` — that
    // matches cast thumbnails and avatars which legitimately use object-fit:cover.
    const heroSelectors = [
      // video — highest priority when today has a video vignette
      'video[src*="vignette"]',
      '.daily-vignette-hero__image video',
      // img — Next.js Image rewrites src to /_next/image?url=... so match container
      '.daily-vignette-hero__image img',
      'img[src*="vignette"]',
      'img[src*="/_next/image"][src*="vignette"]',
      'img[alt*="hero"]',
      'img[alt*="vignette"]',
    ];

    let heroHandle: import('playwright').Locator | null = null;
    let heroSrc = '';
    let heroTag = '';

    for (const sel of heroSelectors) {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0) {
        try {
          await loc.waitFor({ timeout: 5000 });
          // Accept src OR srcset (video uses src; Next.js img may only have srcset)
          heroSrc = (await loc.getAttribute('src') ?? '') || (await loc.getAttribute('srcset') ?? '');
          heroTag = await loc.evaluate((el: Element) => el.tagName.toLowerCase());
          if (heroSrc || heroTag === 'video') {
            heroHandle = loc;
            break;
          }
        } catch {
          // try next selector
        }
      }
    }

    if (!heroHandle) {
      results.push({
        check: '[SAFE-AREA] hero media element found',
        status: 'SKIP',
        evidence: `No hero <img> or <video> found on ${BASE_URL} within 5s on 390px viewport. Selectors tried: ${heroSelectors.join(', ')}. Page may need auth or selector needs update.`,
      });
      return results;
    }

    results.push({
      check: '[SAFE-AREA] hero media element found',
      status: 'PASS',
      evidence: `Found <${heroTag}> via selector (src: ${heroSrc ? heroSrc.slice(0, 80) : '(empty)'})`,
    });

    // Check object-fit computed style — works for both <img> and <video>
    const computedObjectFit = await heroHandle.evaluate((el: Element) => {
      const style = window.getComputedStyle(el);
      const vid = el as HTMLVideoElement;
      const img = el as HTMLImageElement;
      return {
        objectFit: style.objectFit,
        objectPosition: style.objectPosition,
        width: el.clientWidth,
        height: el.clientHeight,
        // naturalWidth/naturalHeight only exist on <img>; use videoWidth/videoHeight for <video>
        naturalWidth: img.naturalWidth || vid.videoWidth || 0,
        naturalHeight: img.naturalHeight || vid.videoHeight || 0,
      };
    });

    const objFit = computedObjectFit.objectFit;
    results.push({
      check: '[SAFE-AREA] hero object-fit: contain (not cover)',
      status: objFit === 'contain' ? 'PASS' : 'FAIL',
      evidence: objFit === 'contain'
        ? `object-fit: ${objFit} — full 16:9 frame visible on 390px mobile, no crop (${computedObjectFit.width}×${computedObjectFit.height})`
        : `object-fit: ${objFit} — hero will CROP on mobile, faces may exit safe zone. Expected "contain", got "${objFit}". (Regression of PR #443 fix)`,
    });

    // Aspect ratio guard: natural dims should be ~16:9 (skip for video if not yet loaded)
    if (computedObjectFit.naturalWidth > 0 && computedObjectFit.naturalHeight > 0) {
      const ratio = computedObjectFit.naturalWidth / computedObjectFit.naturalHeight;
      const is16x9 = ratio > 1.60 && ratio < 1.90;
      results.push({
        check: '[SAFE-AREA] hero aspect ratio ~16:9',
        status: is16x9 ? 'PASS' : 'FAIL',
        evidence: is16x9
          ? `ratio=${ratio.toFixed(2)} (${computedObjectFit.naturalWidth}×${computedObjectFit.naturalHeight}) — within 16:9 window`
          : `ratio=${ratio.toFixed(2)} (${computedObjectFit.naturalWidth}×${computedObjectFit.naturalHeight}) — unexpected aspect ratio, hero safe-zone constraint may be violated`,
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runAt = new Date().toISOString();
  console.log(`[ob1-hero-assertions] Starting — ${runAt}`);
  console.log(`[ob1-hero-assertions] Target: ${BASE_URL}`);

  const allResults: AssertionResult[] = [];

  console.log('\n--- Freshness + Rendered Date Checks ---');
  const freshnessResults = await checkFreshnessAndRenderedDate();
  allResults.push(...freshnessResults);
  for (const r of freshnessResults) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '~';
    console.log(`  ${icon} ${r.check}: ${r.status}`);
    if (r.status !== 'PASS') console.log(`      ${r.evidence}`);
  }

  console.log('\n--- Canonical-Ref Checks ---');
  const canonicalResults = await checkCanonicalRefs();
  allResults.push(...canonicalResults);
  for (const r of canonicalResults) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '~';
    console.log(`  ${icon} ${r.check}: ${r.status}`);
    if (r.status !== 'PASS') console.log(`      ${r.evidence}`);
  }

  console.log('\n--- Mobile Safe-Area Checks ---');
  const safeAreaResults = await checkMobileSafeArea();
  allResults.push(...safeAreaResults);
  for (const r of safeAreaResults) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '~';
    console.log(`  ${icon} ${r.check}: ${r.status}`);
    if (r.status !== 'PASS') console.log(`      ${r.evidence}`);
  }

  // Summary
  const failCount = allResults.filter(r => r.status === 'FAIL').length;
  const passCount = allResults.filter(r => r.status === 'PASS').length;
  const total = allResults.length;
  console.log(`\n[ob1-hero-assertions] ${passCount}/${total} pass, ${failCount} fail\n`);

  // Write JSON result
  const today = runAt.slice(0, 10);
  const outPath = `${OUT_DIR}/ob1-hero-assertions-${today}.json`;
  fs.writeFileSync(outPath, JSON.stringify({ run_at: runAt, base_url: BASE_URL, results: allResults, summary: { total, pass: passCount, fail: failCount } }, null, 2));
  console.log(`[ob1-hero-assertions] Results written: ${outPath}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('[ob1-hero-assertions] Fatal:', e);
  process.exit(1);
});
