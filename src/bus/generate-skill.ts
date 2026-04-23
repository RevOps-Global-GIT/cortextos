/**
 * generate-skill — produce a SKILL.md from a completed task.
 *
 * Given a task ID (local cortextos task OR RGOS cortex task), reads the
 * task's title, description, and completion result, then writes a SKILL.md
 * to the agent's .claude/skills/auto-<slug>/ directory.
 *
 * If a skill with the same slug already exists, a "## Refinements" section
 * is appended rather than overwriting the file.
 *
 * Usage:
 *   cortextos bus generate-skill --from-task <id> [--agent <dir>] [--dry-run]
 *
 * --from-task   Task ID. Prefix "cortex:" to query RGOS kanban via Supabase.
 *               Otherwise reads from the local cortextos task directory.
 * --agent       Absolute path to the agent root (default: CTX_AGENT_DIR env).
 * --dry-run     Print the generated SKILL.md without writing it.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Task } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateSkillOptions {
  taskId: string;
  agentDir?: string;
  dryRun?: boolean;
  /** Supabase URL for RGOS cortex task queries. Falls back to SUPABASE_RGOS_URL env. */
  supabaseUrl?: string;
  /** Supabase service key for RGOS cortex task queries. Falls back to SUPABASE_RGOS_SERVICE_KEY env. */
  supabaseKey?: string;
}

export interface GenerateSkillResult {
  skillPath: string;
  content: string;
  action: 'created' | 'refined' | 'dry-run';
  slug: string;
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Task fetching
// ---------------------------------------------------------------------------

interface RgosTask {
  id: string;
  title: string;
  description?: string | null;
  result?: string | null;
  status?: string;
  assigned_to?: string | null;
  created_by?: string | null;
}

async function fetchRgosTask(taskId: string, url: string, key: string): Promise<RgosTask> {
  const endpoint = `${url}/rest/v1/orch_tasks?id=eq.${encodeURIComponent(taskId)}&select=id,title,description,result,status,assigned_to,created_by&limit=1`;
  const res = await fetch(endpoint, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  if (!res.ok) {
    throw new Error(`RGOS task fetch failed: HTTP ${res.status}`);
  }
  const rows = await res.json() as RgosTask[];
  if (!rows.length) {
    throw new Error(`RGOS task not found: ${taskId}`);
  }
  return rows[0];
}

function readLocalTask(taskId: string, paths: { taskDir: string }): Task {
  const file = join(paths.taskDir, `${taskId}.json`);
  if (!existsSync(file)) {
    throw new Error(`Local task not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as Task;
}

// ---------------------------------------------------------------------------
// Skill content generation
// ---------------------------------------------------------------------------

function buildSkillContent(
  title: string,
  description: string,
  result: string,
  slug: string,
): string {
  const now = new Date().toISOString().split('T')[0];

  // Extract bullet-like lines from description (often step-by-step in task specs)
  const descLines = description
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Pull numbered/bulleted lines for the Steps section; fall back to full description
  const stepLines = descLines.filter((l) => /^[\d]+\.|^[-*•]/.test(l));
  const stepsBlock =
    stepLines.length > 0
      ? stepLines.map((l) => `- ${l.replace(/^[\d]+\.\s*|^[-*•]\s*/, '')}`).join('\n')
      : descLines.map((l) => `- ${l}`).join('\n');

  const resultTrimmed = result.trim();

  return `---
name: auto-${slug}
description: "Auto-generated from task: ${title.replace(/"/g, "'")}"
tags: [auto-generated]
generated_at: ${now}
---

# ${title}

> Auto-generated skill. Review and refine before relying on it in production workflows.

## When to use

When you need to accomplish: ${title.toLowerCase()}.

## Context

${description.trim() || '(no task description available)'}

## Steps

${stepsBlock}

## Outcome / Result

${resultTrimmed || '(no result recorded)'}
`;
}

function buildRefinementSection(result: string): string {
  const now = new Date().toISOString().split('T')[0];
  return `
## Refinements (${now})

${result.trim() || '(no result recorded)'}
`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateSkill(
  opts: GenerateSkillOptions,
  paths: { taskDir: string; frameworkRoot: string },
): Promise<GenerateSkillResult> {
  const { taskId, agentDir, dryRun = false, supabaseUrl, supabaseKey } = opts;

  // ---- Fetch task ----
  let title: string;
  let description: string;
  let result: string;

  const isRgos = taskId.startsWith('cortex:');
  const resolvedId = isRgos ? taskId.slice('cortex:'.length) : taskId;

  if (isRgos) {
    const url = supabaseUrl ?? process.env.SUPABASE_RGOS_URL ?? '';
    const key = supabaseKey ?? process.env.SUPABASE_RGOS_SERVICE_KEY ?? '';
    if (!url || !key) {
      throw new Error('SUPABASE_RGOS_URL and SUPABASE_RGOS_SERVICE_KEY are required for RGOS task lookup');
    }
    const task = await fetchRgosTask(resolvedId, url, key);
    title = task.title;
    description = task.description ?? '';
    result = task.result ?? '';
  } else {
    const task = readLocalTask(resolvedId, paths);
    title = task.title;
    description = task.description ?? '';
    result = task.result ?? '';
  }

  const slug = slugify(title);

  // ---- Resolve skill output path ----
  const resolvedAgentDir =
    agentDir ?? process.env.CTX_AGENT_DIR ?? '';
  if (!resolvedAgentDir) {
    throw new Error('--agent or CTX_AGENT_DIR is required to write a skill file');
  }

  const skillDir = join(resolvedAgentDir, '.claude', 'skills', `auto-${slug}`);
  const skillPath = join(skillDir, 'SKILL.md');

  // ---- Decide: create or refine ----
  const exists = existsSync(skillPath);

  let content: string;
  let action: GenerateSkillResult['action'];

  if (dryRun) {
    content = exists
      ? `--- WOULD APPEND TO ${skillPath} ---\n\n${buildRefinementSection(result)}`
      : buildSkillContent(title, description, result, slug);
    action = 'dry-run';
  } else if (exists) {
    content = buildRefinementSection(result);
    appendFileSync(skillPath, content, 'utf-8');
    action = 'refined';
  } else {
    content = buildSkillContent(title, description, result, slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, content, 'utf-8');
    action = 'created';
  }

  return { skillPath, content, action, slug };
}
