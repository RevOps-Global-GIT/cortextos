#!/usr/bin/env node
/**
 * rewrite-human-task.js
 *
 * Rewrites a [HUMAN] task title from agent-jargon into plain-English next-action
 * language that Greg can understand and act on immediately.
 *
 * Usage:
 *   node rewrite-human-task.js "<title>" ["<description>"]
 *
 * Outputs rewritten title to stdout (single line, no [HUMAN] prefix — caller adds it).
 *
 * Greg's pushback 2026-05-19: titles like "Restore control path for support@ Claude Max
 * cancellation" are opaque. He needs "Go to claude.ai and cancel the Claude Max plan for
 * support@revopsglobal.ai".
 */

"use strict";

const https = require("https");

const [, , rawTitle, rawDesc] = process.argv;

if (!rawTitle) {
  console.error("Usage: rewrite-human-task.js <title> [description]");
  process.exit(1);
}

// Load secrets.env if keys not in environment
function loadSecretsEnv() {
  const secretsPath = require("path").join(__dirname, "../orgs/revops-global/secrets.env");
  try {
    const lines = require("fs").readFileSync(secretsPath, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* file missing — skip */ }
}
loadSecretsEnv();

// Prefer Anthropic, fall back to Gemini (both available in secrets)
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const apiKey = anthropicKey || geminiKey;

if (!apiKey) {
  process.stdout.write(rawTitle.replace(/^\[HUMAN\]\s*/i, "").trim() + "\n");
  process.exit(0);
}

const SYSTEM_PROMPT = `You rewrite task titles for a human (Greg, a RevOps founder) so he knows exactly what to click, open, or do next.

Rules:
- Output ONE short line — the rewritten title. No prefix like "[HUMAN]", no quotes, no explanation.
- Start with an action verb: "Go to", "Open", "Click", "Log in to", "Cancel", "Approve", "Paste", "Run".
- Be specific: name the URL, app, or account if known. Never say "the system" or "the platform".
- No agent-jargon: no "control path", "restore", "gate", "blocklist", "session", "CU", "VM", "orch", "STACK-N", "bake-in".
- Max 12 words. If the original is clear, keep it close. If it's jargon, translate it.
- If you cannot determine a specific action from the title, make it as concrete as possible with what you know.

Examples:
  input: "Restore control path for support@ Claude Max cancellation"
  output: Go to claude.ai and cancel the Claude Max plan for support@revopsglobal.ai

  input: "Clear Claude.ai Cloudflare gate on Greg Mac"
  output: Open claude.ai on your Mac and complete the Cloudflare security check

  input: "Hub-QA Chrome: re-login to hub.revopsglobal.com"
  output: Log back in to hub.revopsglobal.com in the Hub-QA browser

  input: "Codex-CU Chrome: re-login Google Workspace"
  output: Log in to Google Workspace at accounts.google.com in the Codex browser

  input: "LinkedIn Engage Review - 7 pending drafts"
  output: Review and approve 7 pending LinkedIn post drafts`;

const cleanTitle = rawTitle.replace(/^\[HUMAN\]\s*/i, "").trim();
const userMessage = rawDesc
  ? `Title: ${cleanTitle}\nContext: ${rawDesc.slice(0, 400)}`
  : `Title: ${cleanTitle}`;

// Build request for whichever API is available
let hostname, path, body, headers;

if (anthropicKey) {
  body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  hostname = "api.anthropic.com";
  path = "/v1/messages";
  headers = {
    "Content-Type": "application/json",
    "x-api-key": anthropicKey,
    "anthropic-version": "2023-06-01",
    "Content-Length": Buffer.byteLength(body),
  };
} else {
  // Gemini
  const geminiModel = "gemini-2.0-flash-lite";
  body = JSON.stringify({
    contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n${userMessage}` }] }],
    generationConfig: { maxOutputTokens: 80, temperature: 0.2 },
  });
  hostname = "generativelanguage.googleapis.com";
  path = `/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;
  headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
}

const options = {
  hostname,
  path,
  method: "POST",
  headers,
};

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    try {
      const parsed = JSON.parse(data);
      // Anthropic response shape
      let text = parsed?.content?.[0]?.text?.trim();
      // Gemini response shape
      if (!text) text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        process.stdout.write(text.replace(/^"(.+)"$/, "$1") + "\n");
        process.exit(0);
      } else {
        process.stdout.write(cleanTitle + "\n");
        process.exit(0);
      }
    } catch {
      process.stdout.write(cleanTitle + "\n");
      process.exit(0);
    }
  });
});

req.on("error", () => {
  process.stdout.write(cleanTitle + "\n");
  process.exit(0);
});

req.setTimeout(10000, () => {
  req.destroy();
  process.stdout.write(cleanTitle + "\n");
  process.exit(0);
});

req.write(body);
req.end();
