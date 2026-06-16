const STYLE_LABELS = new Set(["no-visual-change", "visual-evidence-exempt"]);

const EVIDENCE_PATTERNS = [
  /!\[[^\]]*]\([^)]+\)/i,
  /\bhttps?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|mp4|mov|webm)(?:[?#]\S*)?/i,
  /\b(?:user-images\.githubusercontent\.com|github\.com\/[^/\s]+\/[^/\s]+\/assets\/|imgur\.com|i\.imgur\.com|cloudinary\.com)\b/i,
  /\b\.github\/pr-evidence\/\S+\.(?:png|jpe?g|gif|webp|avif|mp4|mov|webm)\b/i,
];

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".pcss"]);
const VISUAL_ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".mp4",
  ".mov",
  ".webm",
]);

const UI_PATH_PREFIXES = [
  "app/",
  "pages/",
  "components/",
  "layouts/",
  "src/app/",
  "src/pages/",
  "src/components/",
  "src/features/",
  "src/ui/",
  "src/layouts/",
  "src/screens/",
];

const STYLE_PATH_PREFIXES = [
  "styles/",
  "src/styles/",
  "src/theme/",
  "src/themes/",
  "src/tokens/",
  "src/design/",
  "src/assets/",
  "public/assets/",
  "public/images/",
  "public/screenshots/",
  "public/vignettes/",
  "assets/",
];

const STYLE_CONFIG_RE = /(^|\/)(tailwind\.config|postcss\.config|theme|themes|tokens|design-tokens|colors|typography|layout|visual)[^/]*\.(?:cjs|mjs|js|ts|json)$/i;
const UI_PATCH_RE = /^[+](?![+])(?=.*(?:<|className\s*=|style\s*=|css\s*=|tw\s*=|cn\(|clsx\(|cva\(|variant\s*=|size\s*=|data-\[|rounded-|shadow-|bg-|text-|border-|grid|flex|gap-|p[trblxy]?-|m[trblxy]?-))/m;

function extensionFor(filename) {
  const match = filename.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : "";
}

function startsWithAny(filename, prefixes) {
  const normalized = filename.replace(/^\.?\//, "");
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function hasScreenshotEvidence(textParts) {
  return textParts.some((text) => EVIDENCE_PATTERNS.some((pattern) => pattern.test(text || "")));
}

function classifyFile(file) {
  if (file.status === "removed") return null;

  const filename = file.filename || "";
  const lower = filename.toLowerCase();
  const ext = extensionFor(lower);
  const patch = file.patch || "";

  if (STYLE_EXTENSIONS.has(ext)) {
    return { filename, reason: "stylesheet change" };
  }

  if (STYLE_CONFIG_RE.test(lower) || startsWithAny(lower, STYLE_PATH_PREFIXES)) {
    return { filename, reason: "theme/style token or visual asset path" };
  }

  if (
    VISUAL_ASSET_EXTENSIONS.has(ext) &&
    (lower.startsWith("public/") || lower.includes("/public/") || lower.includes("/assets/"))
  ) {
    return { filename, reason: "visual asset change" };
  }

  if ((ext === ".tsx" || ext === ".jsx") && startsWithAny(lower, UI_PATH_PREFIXES)) {
    if (!patch || UI_PATCH_RE.test(patch)) {
      return { filename, reason: "UI component/page render or style change" };
    }
  }

  if ((ext === ".tsx" || ext === ".jsx") && UI_PATCH_RE.test(patch)) {
    return { filename, reason: "JSX/class/style hunk" };
  }

  return null;
}

function evaluatePullRequestEvidence({ files = [], body = "", comments = [], labels = [] }) {
  const normalizedLabels = labels.map((label) => String(label).toLowerCase());
  const bypassLabel = normalizedLabels.find((label) => STYLE_LABELS.has(label));
  const styleFiles = files.map(classifyFile).filter(Boolean);

  if (bypassLabel) {
    return {
      status: "pass",
      reason: `Gate bypassed by ${bypassLabel} label.`,
      styleFiles,
      hasEvidence: false,
      bypassLabel,
    };
  }

  if (styleFiles.length === 0) {
    return {
      status: "pass",
      reason: "No style/UI files changed.",
      styleFiles,
      hasEvidence: false,
    };
  }

  const hasEvidence = hasScreenshotEvidence([body, ...comments.map((comment) => comment.body || comment)]);
  if (hasEvidence) {
    return {
      status: "pass",
      reason: "Screenshot or screen-recording evidence found.",
      styleFiles,
      hasEvidence: true,
    };
  }

  return {
    status: "fail",
    reason: "Style/UI changes require embedded screenshot evidence.",
    styleFiles,
    hasEvidence: false,
  };
}

function formatChangedFiles(styleFiles) {
  const visible = styleFiles.slice(0, 12).map((file) => `  - ${file.filename} (${file.reason})`);
  const more = styleFiles.length > 12 ? [`  ...and ${styleFiles.length - 12} more`] : [];
  return [...visible, ...more].join("\n");
}

async function runGitHubGate({ github, context, core }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info("No pull_request payload; skipping screenshot evidence gate.");
    return;
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr.number,
    per_page: 100,
  });

  const labels = (pr.labels || []).map((label) => label.name);
  const result = evaluatePullRequestEvidence({
    files,
    body: pr.body || "",
    comments,
    labels,
  });

  core.info(`${result.styleFiles.length} style/UI file(s) require screenshot evidence.`);

  if (result.status === "pass") {
    core.info(result.reason);
    if (result.styleFiles.length > 0) {
      core.info(`Style/UI files:\n${formatChangedFiles(result.styleFiles)}`);
    }
    return;
  }

  core.setFailed(
    `${result.reason}\n\n` +
      `Changed style/UI files:\n${formatChangedFiles(result.styleFiles)}\n\n` +
      `To unblock, add one of these to the PR body or a PR comment:\n` +
      `  - an embedded Markdown image: ![alt](https://.../screenshot.png)\n` +
      `  - a direct .png/.jpg/.gif/.webp/.avif screenshot link\n` +
      `  - a .mp4/.mov/.webm screen-recording link\n` +
      `  - a GitHub uploaded asset URL or .github/pr-evidence image path\n\n` +
      `If the diff is truly non-visual, add the no-visual-change or visual-evidence-exempt label and explain why in the PR.`
  );
}

async function runCli() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error("Usage: node .github/scripts/screenshot-evidence-gate.cjs <fixture.json>");
    process.exit(2);
  }

  const fixture = require(require("path").resolve(fixturePath));
  const result = evaluatePullRequestEvidence(fixture);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "fail" ? 1 : 0);
}

module.exports = runGitHubGate;
module.exports.evaluatePullRequestEvidence = evaluatePullRequestEvidence;

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
