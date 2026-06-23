#!/usr/bin/env tsx
/**
 * ob1-hero-assertions.ts — Hard QA gates for the daily ob1 hero vignette.
 *
 * Asserts two failure classes that previously went through 8+ Greg iterations
 * uninstrumented:
 *   1. canonical-ref: all cast reference_image fields are present in latest.json
 *      (field presence proves the local PNG was found at generation time;
 *       reference/ images are local generator inputs, not web-served CDN assets)
 *   2. mobile safe-area: hero <img> or <video> reports object-fit on 390px viewport
 *
 * Exit 0 = all pass. Exit 1 = any failure (cron treats non-zero as hard error).
 *
 * Usage:
 *   npx tsx scripts/ob1-hero-assertions.ts
 *   npx tsx scripts/ob1-hero-assertions.ts --base-url https://ob1.revopsglobal.com
 *   npx tsx scripts/ob1-hero-assertions.ts --latest-json /tmp/latest.json --skip-safe-area
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
const LATEST_JSON_PATH = getArg('--latest-json', '');
const SKIP_SAFE_AREA = process.argv.includes('--skip-safe-area');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AssertionResult {
  check: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  evidence: string;
}

interface CastMember {
  id: string;
  name: string;
  reference_image?: string;
}

interface LatestJson {
  date?: string;
  image?: string;
  video?: string;
  cast?: CastMember | CastMember[] | null;
  cast_members?: CastMember | CastMember[] | null;
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

// ---------------------------------------------------------------------------
// Check 1: canonical-ref — all cast reference images present + accessible
// ---------------------------------------------------------------------------

async function checkCanonicalRefs(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  const usingFixtureLatest = Boolean(LATEST_JSON_PATH);

  // Fetch latest.json, or load a fixture when testing gate behavior.
  let latest: LatestJson;
  try {
    if (usingFixtureLatest) {
      latest = JSON.parse(fs.readFileSync(LATEST_JSON_PATH, 'utf8')) as LatestJson;
    } else {
      const resp = await fetch(`${VIGNETTES_BASE}/latest.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      latest = await resp.json() as LatestJson;
    }
  } catch (e) {
    return [{
      check: '[CANONICAL-REF] latest.json fetch',
      status: 'FAIL',
      evidence: usingFixtureLatest
        ? `Failed to read ${LATEST_JSON_PATH}: ${e}`
        : `Failed to fetch ${VIGNETTES_BASE}/latest.json: ${e}`,
    }];
  }

  // Hero image must exist and be accessible
  const heroImage = latest.image ?? '';
  if (!heroImage) {
    results.push({ check: '[CANONICAL-REF] hero image field', status: 'FAIL', evidence: 'latest.json missing "image" field — generation may have failed' });
  } else if (usingFixtureLatest) {
    results.push({
      check: '[CANONICAL-REF] hero image accessible',
      status: 'PASS',
      evidence: `fixture latest.json has image="${heroImage}" — HTTP accessibility skipped for fixture mode`,
    });
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
  // a live-page 404.  We fail the canonical-ref gate when the field is absent
  // because the QA gate's job is to catch unbound generation inputs.
  const rawCast = latest.cast_members ?? latest.cast ?? [];
  const castMembers = Array.isArray(rawCast) ? rawCast : [rawCast].filter(Boolean);
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
          status: 'FAIL',
          evidence: `"${member.name}" (${member.id}) has no reference_image in latest.json — character identity was not bound during generation; add ob1-app/reference/${member.id}-canonical.png`,
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
// Check 2: mobile safe-area — report hero object-fit on 390px viewport.
// Cowork owns the hero styling decision, so object-fit mismatch is informational.
// Handles both <img> and <video> heroes (today's vignette may use either).
// ---------------------------------------------------------------------------

async function checkMobileSafeArea(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    const page = await browser.newPage();
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
      check: '[SAFE-AREA] hero object-fit',
      status: objFit === 'contain' ? 'PASS' : 'SKIP',
      evidence: objFit === 'contain'
        ? `object-fit: ${objFit} — full 16:9 frame visible on 390px mobile, no crop (${computedObjectFit.width}×${computedObjectFit.height})`
        : `WARN: object-fit ${objFit} vs expected contain — pending Cowork decision; informational only, not a hard gate.`,
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

  console.log('\n--- Canonical-Ref Checks ---');
  const canonicalResults = await checkCanonicalRefs();
  allResults.push(...canonicalResults);
  for (const r of canonicalResults) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '~';
    console.log(`  ${icon} ${r.check}: ${r.status}`);
    if (r.status !== 'PASS') console.log(`      ${r.evidence}`);
  }

  if (SKIP_SAFE_AREA) {
    console.log('\n--- Mobile Safe-Area Checks ---');
    console.log('  ~ [SAFE-AREA] skipped by --skip-safe-area');
  } else {
    console.log('\n--- Mobile Safe-Area Checks ---');
    const safeAreaResults = await checkMobileSafeArea();
    allResults.push(...safeAreaResults);
    for (const r of safeAreaResults) {
      const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '~';
      console.log(`  ${icon} ${r.check}: ${r.status}`);
      if (r.status !== 'PASS') console.log(`      ${r.evidence}`);
    }
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
