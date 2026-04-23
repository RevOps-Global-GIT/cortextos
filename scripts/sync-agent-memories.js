#!/usr/bin/env node
/**
 * sync-agent-memories.js
 *
 * Reads each agent's structured memory files (those with YAML frontmatter:
 * name, description, type) and upserts them to orch_agent_memory so the
 * RGOS dashboard reflects current agent knowledge.
 *
 * Memory file locations scanned:
 *   <org>/agents/<agent>/memory/*.md   -- structured memories with frontmatter
 *
 * Skips:
 *   - MEMORY.md (index file)
 *   - YYYY-MM-DD.md (daily journal files)
 *   - Files without valid YAML frontmatter
 *
 * Upsert key: agent_id + tags containing "memory_file:<slug>" (unique per file)
 *
 * Run: node scripts/sync-agent-memories.js
 * Triggered by: heartbeat cron + SessionEnd hook
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ────────────────────────────────────────────────────────────────────

const SECRETS_ENV = path.join(
  os.homedir(),
  "cortextos",
  "orgs",
  "revops-global",
  "secrets.env",
);

const ORG_AGENTS_DIR = path.join(
  os.homedir(),
  "cortextos",
  "orgs",
  "revops-global",
  "agents",
);

function loadSecrets() {
  const s = { ...process.env };
  if (fs.existsSync(SECRETS_ENV)) {
    for (const line of fs.readFileSync(SECRETS_ENV, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      s[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return s;
}

const secrets = loadSecrets();
const SUPABASE_URL = secrets.SUPABASE_RGOS_URL || secrets.SUPABASE_URL;
const SERVICE_KEY = secrets.SUPABASE_RGOS_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[memory-sync] Missing SUPABASE_RGOS_URL or SUPABASE_RGOS_SERVICE_KEY");
  process.exit(1);
}

// ── Frontmatter parser ────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter: {name, description, type}, body: string } or null.
 */
function parseFrontmatter(content) {
  if (!content.startsWith("---")) return null;

  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;

  const fmText = content.slice(3, end).trim();
  const body = content.slice(end + 4).trim();

  const fm = {};
  for (const line of fmText.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    fm[key] = val;
  }

  if (!fm.name || !fm.type) return null;
  return { frontmatter: fm, body };
}

// ── Discover agents and their memory files ────────────────────────────────────

function discoverMemoryFiles() {
  const results = [];

  if (!fs.existsSync(ORG_AGENTS_DIR)) return results;

  const agentDirs = fs.readdirSync(ORG_AGENTS_DIR).filter((d) => {
    const p = path.join(ORG_AGENTS_DIR, d);
    return fs.statSync(p).isDirectory();
  });

  for (const agentName of agentDirs) {
    const memDir = path.join(ORG_AGENTS_DIR, agentName, "memory");
    if (!fs.existsSync(memDir)) continue;

    const files = fs.readdirSync(memDir).filter((f) => {
      if (!f.endsWith(".md")) return false;
      if (f === "MEMORY.md") return false;
      // Skip daily journal files (YYYY-MM-DD.md)
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) return false;
      return true;
    });

    for (const file of files) {
      const filePath = path.join(memDir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = parseFrontmatter(content);
      if (!parsed) continue;

      results.push({
        agentName,
        filePath,
        slug: file.replace(/\.md$/, ""),
        ...parsed,
      });
    }
  }

  return results;
}

// ── Map memory type to importance ─────────────────────────────────────────────

const TYPE_IMPORTANCE = {
  user: 5,
  feedback: 8,
  project: 7,
  reference: 4,
};

// ── Supabase upsert ───────────────────────────────────────────────────────────

async function upsertMemories(memories) {
  if (memories.length === 0) return { upserted: 0 };

  // Supabase REST upsert: POST with Prefer: resolution=merge-duplicates
  // We use a unique tag "memory_file:<slug>" per agent to identify the row.
  // Since there's no direct unique index on agent_id+name, we:
  //   1. Fetch existing rows for each agent by tag
  //   2. PATCH (update) existing, POST (insert) new

  const upsertRows = memories.map((m) => ({
    agent_id: m.agentName,
    memory_type: m.frontmatter.type || "general",
    content: m.body,
    tags: [
      m.frontmatter.type || "general",
      `memory_file:${m.slug}`,
      `name:${m.frontmatter.name.toLowerCase().replace(/\s+/g, "-")}`,
    ],
    importance: TYPE_IMPORTANCE[m.frontmatter.type] ?? 5,
    source_goal: m.frontmatter.description || m.frontmatter.name,
    updated_at: new Date().toISOString(),
  }));

  // Fetch existing rows that match by agent_id + memory_file tag
  const agentNames = [...new Set(memories.map((m) => m.agentName))];
  const existingRows = [];

  for (const agentName of agentNames) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orch_agent_memory?agent_id=eq.${encodeURIComponent(agentName)}&select=id,agent_id,tags`,
      {
        headers: {
          Authorization: `Bearer ${SERVICE_KEY}`,
          apikey: SERVICE_KEY,
        },
      },
    );
    if (res.ok) {
      const rows = await res.json();
      existingRows.push(...rows);
    }
  }

  // Build slug → id map from existing rows
  const existingBySlug = {};
  for (const row of existingRows) {
    const tags = row.tags || [];
    const fileTag = tags.find((t) => t.startsWith("memory_file:"));
    if (fileTag) {
      existingBySlug[`${row.agent_id}::${fileTag}`] = row.id;
    }
  }

  let upserted = 0;

  for (const [i, row] of upsertRows.entries()) {
    const mem = memories[i];
    const slugKey = `${mem.agentName}::memory_file:${mem.slug}`;
    const existingId = existingBySlug[slugKey];

    if (existingId) {
      // UPDATE
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/orch_agent_memory?id=eq.${existingId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${SERVICE_KEY}`,
            apikey: SERVICE_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: row.content,
            tags: row.tags,
            importance: row.importance,
            source_goal: row.source_goal,
            updated_at: row.updated_at,
          }),
        },
      );
      if (res.ok || res.status === 204) upserted++;
      else console.warn(`[memory-sync] PATCH failed ${existingId}: ${res.status}`);
    } else {
      // INSERT
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/orch_agent_memory`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SERVICE_KEY}`,
            apikey: SERVICE_KEY,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(row),
        },
      );
      if (res.ok || res.status === 201) upserted++;
      else {
        const text = await res.text();
        console.warn(`[memory-sync] INSERT failed for ${mem.agentName}/${mem.slug}: ${res.status} ${text.slice(0, 200)}`);
      }
    }
  }

  return { upserted };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const memories = discoverMemoryFiles();
  console.log(`[memory-sync] Found ${memories.length} memory files to sync`);

  if (memories.length === 0) {
    console.log("[memory-sync] Nothing to sync");
    return;
  }

  // Log what we found
  for (const m of memories) {
    console.log(`  ${m.agentName}/${m.slug} (${m.frontmatter.type}): ${m.frontmatter.name}`);
  }

  const { upserted } = await upsertMemories(memories);
  console.log(`[memory-sync] Synced ${upserted}/${memories.length} memory records to orch_agent_memory`);
}

main().catch((err) => {
  console.error("[memory-sync] Fatal:", err);
  process.exit(1);
});
