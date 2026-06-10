/**
 * Structured staleness detection for the page-health QA harness.
 *
 * A surface is "stale" only when it renders an explicit staleness / last-synced
 * STATUS LABEL (a short badge/chip/banner element) — NOT when it merely lists
 * content carrying relative timestamps or the word "stale" inside a title.
 *
 * The previous heuristic matched the bare pattern /N days ago/ against the full
 * page body. A tasks board ALWAYS lists tasks that are 2+ days old, so every list
 * surface flagged a permanent staleness warning. That is itself a masking risk:
 * a surface that is always "warning" trains operators to ignore the signal, which
 * is exactly how a real outage stays unnoticed. Matching the bare word "stale" in
 * body text has the same flaw — task titles legitimately contain it
 * (e.g. "Auto-recover stale in_progress tasks").
 *
 * RGOS renders real staleness as short status labels: "Stale", "Stale heartbeat",
 * "Stale Deal", "Stale agents (no heartbeat …)", and "Last synced <relative>".
 * We therefore look for staleness ONLY in short status-label texts, plus the
 * unambiguous explicit "Nd/Nh/Nm stale" badge form anywhere in the body.
 */

// Explicit staleness badges — unambiguous structured markers, safe to match in body text.
export const STALE_BADGE_PATTERNS: RegExp[] = [
  /\b([2-9]|\d{2,})d\s+stale\b/i,
  /\b(\d{4,})m\s+stale\b/i,
  /\b([3-9]\d|[1-9]\d{2,})h\s+stale\b/i,
];

// Staleness expressed in a short status label (badge/chip/banner/aria-label).
export const STATUS_LABEL_STALENESS_PATTERNS: RegExp[] = [
  /\bstale\b/i,
  /\bout[- ]of[- ]date\b/i,
  /\b(?:not|never)\s+synced\b/i,
  // "Last synced 6 days ago" — a relative timestamp WITH sync-status context.
  /\blast\s+(?:synced|updated|refreshed)\b[\s\S]{0,40}\b([2-9]|\d{2,})\s+(?:days?|weeks?|months?)\s+ago\b/i,
];

// DOM selectors for short status/badge/banner elements (and aria-label/title carriers).
// Used by the harness to gather candidate status-label texts; the pure detector below
// applies a length guard so only short labels — never listed content — can flag.
export const STATUS_LABEL_SELECTORS =
  '[class*="badge" i],[class*="chip" i],[class*="pill" i],[class*="caution" i],' +
  '[class*="status" i],[class*="stale" i],[class*="banner" i],[role="status"],' +
  '[role="alert"],[aria-label*="stale" i],[title*="stale" i],[aria-label*="synced" i]';

// A genuine status label is short. Anything longer is listed content (a title,
// a sentence) and must not be treated as a staleness banner.
export const MAX_STATUS_LABEL_LEN = 48;

export interface StalenessResult {
  stale: boolean;
  detail: string | null;
}

function firstSnippet(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const idx = Math.max(0, match.index ?? 0);
      return text.slice(idx, idx + 180).replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/**
 * Decide whether a page is showing a structured staleness signal.
 *
 * @param statusLabels Texts of short status/badge/banner elements (and their
 *   aria-label/title attributes). Long entries are ignored via MAX_STATUS_LABEL_LEN
 *   so listed content (task titles, sentences) can never trip the warning.
 * @param bodyText Full page innerText — scanned ONLY for the explicit "Nd stale"
 *   badge form, which is unambiguous regardless of element.
 */
export function detectStaleness(statusLabels: string[], bodyText: string): StalenessResult {
  // 1. Explicit staleness badges anywhere on the page (unambiguous, structured form).
  const badge = firstSnippet(bodyText, STALE_BADGE_PATTERNS);
  if (badge) return { stale: true, detail: badge };

  // 2. Staleness inside a SHORT status label — never in listed content.
  for (const raw of statusLabels) {
    const label = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > MAX_STATUS_LABEL_LEN) continue;
    const hit = firstSnippet(label, STATUS_LABEL_STALENESS_PATTERNS);
    if (hit) return { stale: true, detail: hit };
  }

  return { stale: false, detail: null };
}
