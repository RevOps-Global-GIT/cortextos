/**
 * sync-skills — upsert agent SKILL.md files into the orch_skills Supabase table.
 *
 * Usage:
 *   cortextos bus sync-skills [--agent <dir>] [--dry-run]
 *
 * Reads every SKILL.md under the agent's .claude/skills/ and community/
 * directories, parses frontmatter, and upserts into orch_skills keyed on slug.
 * Community catalog entries (library: true) are left untouched — only
 * agent-authored skills (source: "agent") are synced by this command.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillSyncEntry {
  name: string;
  slug: string;
  description: string;
  body_markdown: string;
  trigger_keywords: string[];
  category: string;
  applicable_roles: string[];
  source_path: string;
  library: boolean;
  is_active: boolean;
  content_hash: string;
}

export interface SyncSkillsResult {
  upserted: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (extended — pulls triggers and tags)
// ---------------------------------------------------------------------------

interface SkillFrontmatter {
  name: string;
  description: string;
  triggers: string[];
  tags: string[];
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let name = '';
  let description = '';
  let triggers: string[] = [];
  let tags: string[] = [];

  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;

    const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
    if (nameMatch) { name = nameMatch[1]; continue; }

    const descMatch = line.match(/^description:\s*["'](.+?)["']\s*$/) ||
                      line.match(/^description:\s*(.+?)\s*$/);
    if (descMatch) { description = descMatch[1]; continue; }

    // triggers: ["foo", "bar"] or triggers: [foo, bar]
    const triggersMatch = line.match(/^triggers:\s*\[(.+)\]\s*$/);
    if (triggersMatch) {
      triggers = triggersMatch[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    const tagsMatch = line.match(/^tags:\s*\[(.+)\]\s*$/);
    if (tagsMatch) {
      tags = tagsMatch[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, ''));
    }
  }

  return { name, description, triggers, tags };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

function scanSkillsDir(dir: string, agentName: string): SkillSyncEntry[] {
  if (!existsSync(dir)) return [];

  const results: SkillSyncEntry[] = [];
  let entries: import('fs').Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import('fs').Dirent<string>[];
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name as string, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const body = readFileSync(skillFile, 'utf-8');
      const fm = parseFrontmatter(body);
      if (!fm.name) continue;

      const slug = slugify(fm.name);
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);

      results.push({
        name: fm.name,
        slug,
        description: fm.description,
        body_markdown: body,
        trigger_keywords: fm.triggers,
        category: 'agent',
        applicable_roles: [agentName],
        source_path: skillFile,
        library: false,
        is_active: true,
        content_hash: hash,
      });
    } catch {
      // skip unreadable skill
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncSkills(opts: {
  agentDir?: string;
  agentName?: string;
  dryRun?: boolean;
}): Promise<SyncSkillsResult> {
  const agentDir = opts.agentDir ?? process.env.CTX_AGENT_DIR ?? '';
  const agentName = opts.agentName ?? process.env.CTX_AGENT_NAME ?? 'agent';

  if (!agentDir) throw new Error('--agent or CTX_AGENT_DIR is required');

  const skillsDir = join(agentDir, '.claude', 'skills');
  const skills = scanSkillsDir(skillsDir, agentName);

  if (opts.dryRun) {
    console.log(JSON.stringify(skills.map((s) => ({ name: s.name, slug: s.slug, triggers: s.trigger_keywords.length })), null, 2));
    return { upserted: skills.length, skipped: 0, errors: 0 };
  }

  const url = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_RGOS_URL and SUPABASE_RGOS_SERVICE_KEY are required');

  const endpoint = `${url}/rest/v1/orch_skills?on_conflict=slug`;
  const headers: Record<string, string> = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=minimal',
  };

  let upserted = 0;
  let errors = 0;

  // Batch upsert in chunks of 20 to avoid request size limits
  const BATCH = 20;
  for (let i = 0; i < skills.length; i += BATCH) {
    const batch = skills.slice(i, i + BATCH).map((s) => ({
      name: s.name,
      slug: s.slug,
      description: s.description,
      body_markdown: s.body_markdown,
      trigger_keywords: s.trigger_keywords,
      category: s.category,
      applicable_roles: s.applicable_roles,
      source_path: s.source_path,
      library: s.library,
      is_active: s.is_active,
      content_hash: s.content_hash,
      last_synced_at: new Date().toISOString(),
    }));

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        upserted += batch.length;
      } else {
        const err = await res.text();
        console.error(`sync-skills batch error (${res.status}): ${err.slice(0, 200)}`);
        errors += batch.length;
      }
    } catch (err) {
      console.error(`sync-skills fetch error: ${err}`);
      errors += batch.length;
    }
  }

  return { upserted, skipped: 0, errors };
}
