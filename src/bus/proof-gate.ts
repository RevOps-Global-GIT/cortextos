/**
 * Proof gate — artifact-required completion validation.
 *
 * Replaces the old keyword-scoring heuristic in task-validate.ts. The keyword
 * gate passed any completion that merely *mentioned* the right words
 * ("fixed and live-verified" matched /\blive\b/ and /\bverified\b/), which is
 * exactly how a false "done" slipped through on the ob1 safe-area fix.
 *
 * This gate instead requires a real, checkable artifact and verifies it against
 * the world, not against the words:
 *   - an existing file path (stat'd on disk),
 *   - a recording/screenshot (media file on disk, or an embedded/linked image —
 *     same evidence shapes the rgos screenshot-evidence-gate.yml accepts),
 *   - a merged PR confirmed via `gh`,
 *   - or a substantial block of pasted command output (the floor).
 *
 * UI/scroll tasks additionally require visual evidence (the ob1 gap): a
 * screenshot or scroll recording, not just text.
 *
 * Rollout is warn-then-block (see ProofGateMode). The org-level
 * `require_deliverables` flag and `checkDeliverableRequirement` in cli/bus.ts
 * remain the independent hard kill switch.
 */

import { existsSync, statSync } from 'fs';
import { isAbsolute, resolve, basename, extname } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import type { Task } from '../types/index.js';

/**
 * Gate enforcement level.
 *  - `off`   — artifact checks disabled; callers fall back to legacy behavior.
 *  - `warn`  — evaluate and surface gaps, but never block (safe-rollout default).
 *  - `block` — a completion without a verifiable artifact is rejected.
 */
export type ProofGateMode = 'off' | 'warn' | 'block';

export type ProofArtifactKind = 'file' | 'recording' | 'pr' | 'command-output' | 'image-link';

export interface ProofArtifact {
  kind: ProofArtifactKind;
  /** The raw claim as it appeared in the completion (path, PR ref, URL, descriptor). */
  claim: string;
  /** True when confirmed against the world (file exists on disk, gh says merged). */
  verified: boolean;
  /** `strong` = checkable against the world; `weak` = present but spoofable (floor only). */
  strength: 'strong' | 'weak';
  /** Human detail, e.g. "exists (12.4 KB)", "merged sha 1a2b3c4", "gh could not confirm". */
  detail?: string;
}

export interface ProofEvaluation {
  /** Every candidate found, verified or not (useful for stamping + diagnostics). */
  artifacts: ProofArtifact[];
  /** The subset that counts toward satisfying the gate. */
  accepted: ProofArtifact[];
  hasRealArtifact: boolean;
  hasRecording: boolean;
  requiresRecording: boolean;
  satisfied: boolean;
  /** When not satisfied, a precise description of what is missing. */
  missing: string;
}

export interface PrVerificationInput {
  /** Full GitHub PR URL, when present in the text. */
  url?: string;
  /** owner/repo, when derivable (from a URL). */
  repo?: string;
  /** PR number. */
  number?: number;
}

/** Confirms whether a PR reference is merged. Returns null when it cannot be determined. */
export type PrVerifier = (input: PrVerificationInput) => { merged: boolean; sha?: string } | null;

export interface ProofGateOptions {
  /** Extra roots (besides cwd) to resolve relative file paths against, e.g. [ctxRoot]. */
  roots?: string[];
  /** Working directory for resolving relative paths (defaults to process.cwd()). */
  cwd?: string;
  /** PR verifier. Injected in tests; defaults to a `gh`-backed implementation. */
  verifyPr?: PrVerifier;
}

// Visual evidence (screenshot or recording). Either satisfies the UI-task requirement.
const VISUAL_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv',
]);

// Ubiquitous files that, on their own, prove nothing task-specific.
const GENERIC_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'readme.md', 'license', 'license.md', '.gitignore', '.env',
]);

// Default repos to try when a PR is referenced as a bare #number with no owner/repo.
const DEFAULT_PR_REPOS = [
  'RevOps-Global-GIT/cortextos',
  'RevOps-Global-GIT/rgos',
];

/**
 * Words that mark a task as front-end / visual, where a screenshot or scroll
 * recording is the natural proof. Kept deliberately focused: the ob1 miss was a
 * scroll / safe-area fix that "passed" with no visual evidence at all.
 */
export const UI_KEYWORDS = [
  'scroll', 'overscroll', 'safe area', 'safe-area', 'safearea', 'viewport',
  'notch', 'inset', 'clipped', 'cut off', 'cut-off', 'cutoff', 'overlap',
  'layout', 'css', 'responsive', 'mobile view', 'ui', 'component', 'render',
  'modal', 'animation', 'styling', 'stylesheet', 'visual', 'screenshot',
  'pixel', 'dark mode', 'theme', 'button', 'banner', 'nav bar', 'navbar',
  '.tsx', '.css',
];

const MAX_SCAN_CHARS = 100_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-bounded so short tokens like "ui" / "css" do not match inside unrelated
// words ("suite", "build", "discuss"). Dotted extension tokens (.tsx/.css)
// match as literal substrings since a leading "." has no word boundary.
const UI_KEYWORD_RE = new RegExp(
  UI_KEYWORDS.map(kw => (kw.startsWith('.') ? escapeRegExp(kw) : `\\b${escapeRegExp(kw)}\\b`)).join('|'),
  'i',
);

/**
 * True when the task's title / description / success criteria mark it as
 * UI/scroll work that requires visual evidence to be considered done.
 */
export function isUiScrollTask(task: Pick<Task, 'title' | 'description' | 'success_criteria'> & { meta?: Record<string, unknown> }): boolean {
  const brief = (task.meta?.brief ?? {}) as Record<string, unknown>;
  const fields = [
    task.title,
    task.description,
    task.success_criteria,
    typeof brief.success_criteria === 'string' ? brief.success_criteria : '',
    typeof brief.artifact_expectations === 'string' ? brief.artifact_expectations : '',
  ];
  const haystack = fields.filter(Boolean).join('\n');
  return UI_KEYWORD_RE.test(haystack);
}

/**
 * Extract path-like tokens from free text. Matches either tokens containing a
 * directory separator (`src/bus/x.ts`, `~/work/out`, `./dist/y`) or bare
 * filenames carrying an extension (`report.md`). Trailing prose punctuation is
 * trimmed. Returns de-duplicated raw candidates (resolution happens later).
 */
export function extractPaths(text: string): string[] {
  const scan = text.slice(0, MAX_SCAN_CHARS);
  const re = /(?:~\/|\.{0,2}\/)?[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@+-]+)+(?:\.[A-Za-z0-9]{1,8})?|[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}/g;
  const out = new Set<string>();
  for (const raw of scan.match(re) ?? []) {
    const cleaned = raw.replace(/[.,;:)\]}'"]+$/, '').trim();
    // Need a separator or a dotted extension to look like a real path.
    if (!cleaned || (!cleaned.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(cleaned))) continue;
    // Skip obvious non-paths: bare version numbers, URLs (handled separately).
    if (/^https?:/i.test(cleaned)) continue;
    if (/^\d+(\.\d+)+$/.test(cleaned)) continue;
    out.add(cleaned);
    if (out.size >= 100) break;
  }
  return [...out];
}

/** Resolve a raw path candidate against cwd + roots; return the first that exists as a file. */
function resolveExistingFile(raw: string, roots: string[]): string | null {
  const expanded = raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : raw;
  const candidates = isAbsolute(expanded) ? [expanded] : roots.map(r => resolve(r, expanded));
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* unreadable — treat as not found */
    }
  }
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extract embedded/linked image evidence — the shapes rgos
 * screenshot-evidence-gate.yml accepts: markdown images and remote image URLs
 * (incl. imgur / cloudinary). Local image *paths* are handled by extractPaths.
 */
export function extractImageLinks(text: string): string[] {
  const scan = text.slice(0, MAX_SCAN_CHARS);
  const out = new Set<string>();
  for (const m of scan.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []) out.add(m.slice(0, 120));
  for (const m of scan.match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp)\b/gi) ?? []) out.add(m);
  for (const m of scan.match(/https?:\/\/\S*(?:imgur\.com|cloudinary\.com)\S*/gi) ?? []) out.add(m);
  return [...out];
}

/** Extract PR references: full GitHub PR URLs and bare #number forms. */
export function extractPrRefs(text: string): PrVerificationInput[] {
  const scan = text.slice(0, MAX_SCAN_CHARS);
  const out: PrVerificationInput[] = [];
  const seen = new Set<string>();
  const urlRe = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(scan))) {
    const key = `${m[1]}/${m[2]}#${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: m[0], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
  }
  // Bare "#1234" or "PR #1234" / "PR-1234" not already captured via a URL.
  const bareRe = /(?:\bPR[\s#-]*|#)(\d{1,6})\b/gi;
  while ((m = bareRe.exec(scan))) {
    const num = Number(m[1]);
    if ([...seen].some(k => k.endsWith(`#${num}`))) continue;
    const key = `#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ number: num });
  }
  return out.slice(0, 20);
}

/** Default `gh`-backed PR verifier. Returns null on any failure (gh missing, auth, not found). */
export const ghVerifyPr: PrVerifier = (input) => {
  const repos = input.repo ? [input.repo] : DEFAULT_PR_REPOS;
  if (!input.number) return null;
  for (const repo of repos) {
    try {
      const raw = execFileSync(
        'gh',
        ['pr', 'view', String(input.number), '--repo', repo, '--json', 'state,mergeCommit'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
      ).trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { state?: string; mergeCommit?: { oid?: string } | null };
      if ((parsed.state ?? '').toUpperCase() === 'MERGED') {
        return { merged: true, sha: parsed.mergeCommit?.oid };
      }
      // Found the PR but it is not merged — only conclusive when the repo was explicit.
      if (input.repo) return { merged: false };
    } catch {
      /* try next repo / treat as unverifiable */
    }
  }
  return null;
};

/**
 * Heuristic: does the text contain a substantial block of real, pasted command
 * output (test runner summary, tsc errors, stack trace, shell session)? This is
 * the floor artifact and is deliberately strict — a bare "tests passed" is the
 * very keyword-spoof this gate exists to reject, so we require multiple lines
 * and at least one structural marker that is awkward to fabricate casually.
 */
export function looksLikeCommandOutput(text: string): boolean {
  const scan = text.slice(0, MAX_SCAN_CHARS);
  const lines = scan.split(/\r?\n/);
  if (lines.length < 4) return false;

  const markers = [
    /^\s*[$>]\s+\S/m,                                   // shell prompt line
    /\b\d+\s+(?:passing|passed|failing|failed)\b/i,     // test counts
    /\bTest\s+(?:Files|Suites|Cases)\b/i,               // vitest/jest summary
    /\b(?:PASS|FAIL)\b\s+\S+\.(?:tsx?|jsx?|mjs)\b/,      // per-file test result
    /\b[\w./-]+\.(?:tsx?|jsx?|mjs):\d+:\d+\b/,           // file:line:col diagnostic
    /\bat\s+\S.*\(.*:\d+:\d+\)/,                         // stack frame
    /\bexit\s+code\s+\d+\b/i,                            // exit code
    /\berror\s+TS\d{3,5}\b/,                             // tsc error code
    /^\s*[+-]{3}\s+[ab]\//m,                             // unified diff header
  ];
  const hits = markers.filter(re => re.test(scan)).length;
  return hits >= 1 && lines.filter(l => l.trim().length > 0).length >= 4 && (hits >= 2 || /^\s*[$>]\s/m.test(scan) || /\b[\w./-]+\.(?:tsx?|jsx?|mjs):\d+:\d+\b/.test(scan));
}

function safeVerify(verifier: PrVerifier, input: PrVerificationInput): { merged: boolean; sha?: string } | null {
  try {
    return verifier(input);
  } catch {
    return null;
  }
}

/**
 * Evaluate a completion's result text for verifiable proof of work, in the
 * context of the task it completes. Pure and synchronous (the PR verifier is
 * injectable and defaults to a bounded `gh` call).
 */
export function evaluateProof(
  task: Pick<Task, 'title' | 'description' | 'success_criteria'> & { meta?: Record<string, unknown> },
  result: string | undefined,
  opts: ProofGateOptions = {},
): ProofEvaluation {
  const text = (result ?? '').slice(0, MAX_SCAN_CHARS);
  const roots = [opts.cwd ?? process.cwd(), ...(opts.roots ?? [])];
  const verifyPr = opts.verifyPr ?? ghVerifyPr;
  const artifacts: ProofArtifact[] = [];
  let claimedMissingPath = false;

  // 1. File / recording paths.
  for (const raw of extractPaths(text)) {
    const resolved = resolveExistingFile(raw, roots);
    if (!resolved) {
      // Only flag a missing-file claim when it has a code/media-ish extension,
      // to avoid treating ordinary prose tokens as broken deliverables.
      if (/\.(tsx?|jsx?|mjs|json|md|ya?ml|png|jpe?g|gif|webp|mp4|mov|webm|sql|sh|py|css|html?)$/i.test(raw)) {
        claimedMissingPath = true;
      }
      continue;
    }
    const ext = extname(resolved).toLowerCase();
    const base = basename(resolved).toLowerCase();
    let size = 0;
    try { size = statSync(resolved).size; } catch { /* ignore */ }
    if (VISUAL_EXTS.has(ext)) {
      artifacts.push({ kind: 'recording', claim: raw, verified: true, strength: 'strong', detail: `exists (${formatSize(size)})` });
    } else if (GENERIC_FILES.has(base)) {
      artifacts.push({ kind: 'file', claim: raw, verified: true, strength: 'weak', detail: 'generic file; not task-specific' });
    } else {
      artifacts.push({ kind: 'file', claim: raw, verified: true, strength: 'strong', detail: `exists (${formatSize(size)})` });
    }
  }

  // 2. Embedded / linked image evidence (markdown or remote URL).
  for (const link of extractImageLinks(text)) {
    artifacts.push({ kind: 'image-link', claim: link, verified: false, strength: 'weak', detail: 'image evidence link' });
  }

  // 3. PR references, confirmed merged via gh.
  for (const ref of extractPrRefs(text)) {
    const v = safeVerify(verifyPr, ref);
    const label = ref.url ?? (ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`);
    if (v?.merged) {
      artifacts.push({ kind: 'pr', claim: label, verified: true, strength: 'strong', detail: v.sha ? `merged sha ${v.sha.slice(0, 9)}` : 'merged' });
    } else {
      artifacts.push({ kind: 'pr', claim: label, verified: false, strength: 'weak', detail: v === null ? 'gh could not confirm merge' : 'PR not merged' });
    }
  }

  // 4. Pasted command output (the floor).
  if (looksLikeCommandOutput(text)) {
    artifacts.push({ kind: 'command-output', claim: 'pasted command output', verified: false, strength: 'weak', detail: 'multi-line output block' });
  }

  const accepted = artifacts.filter(a =>
    (a.verified && a.strength === 'strong') ||
    a.kind === 'image-link' ||
    a.kind === 'command-output',
  );
  const hasRealArtifact = accepted.length > 0;
  const hasRecording = accepted.some(a => a.kind === 'recording' || a.kind === 'image-link');
  const requiresRecording = isUiScrollTask(task);
  const satisfied = hasRealArtifact && (!requiresRecording || hasRecording);

  let missing = '';
  if (!satisfied) {
    if (!hasRealArtifact) {
      missing =
        'no verifiable artifact found. Attach one of: an existing file path (e.g. via `save-output`), ' +
        'a merged-PR link/number, a screenshot or scroll recording, or paste the command output that proves it.';
      if (claimedMissingPath) {
        missing += ' (A file path was referenced but does not exist on disk.)';
      }
    } else if (requiresRecording && !hasRecording) {
      missing =
        'this looks like a UI/scroll task but the completion has no visual evidence. ' +
        'Attach a screenshot or scroll recording showing the result.';
    }
  }

  return { artifacts, accepted, hasRealArtifact, hasRecording, requiresRecording, satisfied, missing };
}

/**
 * Resolve the active gate mode. Precedence: explicit env override
 * (`CTX_PROOF_GATE`) > per-org `proof_gate` setting > default `warn`.
 */
export function resolveProofGateMode(input: { env?: string; orgMode?: string }): ProofGateMode {
  const env = (input.env ?? '').trim().toLowerCase();
  if (env === 'off' || env === 'warn' || env === 'block') return env;
  const org = (input.orgMode ?? '').trim().toLowerCase();
  if (org === 'off' || org === 'warn' || org === 'block') return org;
  return 'warn';
}

/** Compact, stampable summary of what proof was found (written to task.meta.proof). */
export interface ProofStamp {
  mode: ProofGateMode;
  satisfied: boolean;
  /** Accepted artifacts, reduced to kind + claim + verified for the task record. */
  artifacts: Array<{ kind: ProofArtifactKind; claim: string; verified: boolean }>;
  checked_at: string;
  note?: string;
}

export function buildProofStamp(mode: ProofGateMode, evaln: ProofEvaluation, checkedAt: string, note?: string): ProofStamp {
  const source = evaln.accepted.length > 0 ? evaln.accepted : evaln.artifacts;
  return {
    mode,
    satisfied: evaln.satisfied,
    artifacts: source.slice(0, 10).map(a => ({ kind: a.kind, claim: a.claim.slice(0, 200), verified: a.verified })),
    checked_at: checkedAt,
    ...(note ? { note } : {}),
  };
}
