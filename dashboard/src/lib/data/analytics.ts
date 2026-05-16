// cortextOS Dashboard - Analytics data queries
// Aggregated metrics for charts on the analytics page.

import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { getAllAgents, getFrameworkRoot } from '@/lib/config';
import type { AgentStat } from '@/components/analytics/agent-effectiveness';

/**
 * Get daily completed task counts for the last N days.
 */
export function getTaskThroughput(
  days: number = 30,
  org?: string,
): Array<{ date: string; tasks: number }> {
  const conditions: string[] = [
    "completed_at >= DATE('now', ?)",
    "status = 'completed'",
  ];
  const params: (string | number)[] = [`-${days} days`];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    return db
      .prepare(
        `SELECT DATE(completed_at) as date, COUNT(*) as tasks
         FROM tasks ${where}
         GROUP BY DATE(completed_at)
         ORDER BY date ASC`,
      )
      .all(...params) as Array<{ date: string; tasks: number }>;
  } catch {
    return [];
  }
}

/** Returns true if the agent's config.json has enabled: false */
function isAgentDisabled(agentName: string, orgName: string): boolean {
  try {
    const frameworkRoot = getFrameworkRoot();
    const configPath = path.join(frameworkRoot, 'orgs', orgName, 'agents', agentName, 'config.json');
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg.enabled === false;
  } catch {
    return false;
  }
}

/**
 * Get per-agent effectiveness stats.
 * Includes ALL heartbeat-registered and filesystem-discovered enabled agents,
 * showing 0 done / 0% rate for agents with no completed tasks rather than
 * hiding them from the panel.
 */
export function getAgentEffectiveness(org?: string): AgentStat[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // Get all agents with their task stats
    const rows = db
      .prepare(
        `SELECT
           assignee as name,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
         FROM tasks
         ${where ? where + ' AND' : 'WHERE'} assignee IS NOT NULL AND assignee != ''
         GROUP BY assignee`,
      )
      .all(...params) as Array<{
      name: string;
      total: number;
      completed: number;
    }>;

    // Get error counts per agent from events
    const errorRows = db
      .prepare(
        `SELECT agent as name, COUNT(*) as errors
         FROM events
         ${where ? where + ' AND' : 'WHERE'} type = 'error'
         GROUP BY agent`,
      )
      .all(...params) as Array<{ name: string; errors: number }>;

    const errorMap = new Map(errorRows.map((r) => [r.name, r.errors]));

    // Get daily completed tasks for the last 7 days (for sparklines)
    const trendRows = db
      .prepare(
        `SELECT assignee as name, DATE(completed_at) as date, COUNT(*) as count
         FROM tasks
         WHERE completed_at >= DATE('now', '-7 days')
           AND status = 'completed'
           AND assignee IS NOT NULL AND assignee != ''
         GROUP BY assignee, DATE(completed_at)
         ORDER BY date ASC`,
      )
      .all() as Array<{ name: string; date: string; count: number }>;

    // Build trend map: agent -> [7 days of counts]
    const trendMap = new Map<string, number[]>();
    for (const row of trendRows) {
      if (!trendMap.has(row.name)) {
        trendMap.set(row.name, new Array(7).fill(0));
      }
      const dayDiff = Math.floor(
        (Date.now() - new Date(row.date).getTime()) / (86400 * 1000),
      );
      const idx = 6 - Math.min(dayDiff, 6);
      const arr = trendMap.get(row.name)!;
      arr[idx] = row.count;
    }

    const statsMap = new Map(
      rows.map((row) => [
        row.name,
        {
          name: row.name,
          completionRate: row.total > 0 ? (row.completed / row.total) * 100 : 0,
          errorCount: errorMap.get(row.name) ?? 0,
          tasksCompleted: row.completed,
          recentTrend: trendMap.get(row.name) ?? [0, 0, 0, 0, 0, 0, 0],
        } satisfies AgentStat,
      ]),
    );

    // Merge in all enabled agents that have no tasks yet — show them with 0 stats
    const EXCLUDED_NAMES = new Set(['human', 'dashboard', 'orchestrator', 'user']);
    for (const { name, org: agentOrg } of getAllAgents()) {
      if (statsMap.has(name)) continue;
      if (EXCLUDED_NAMES.has(name)) continue;
      if (org && agentOrg && agentOrg !== org) continue;
      if (isAgentDisabled(name, agentOrg || org || '')) continue;
      statsMap.set(name, {
        name,
        completionRate: 0,
        errorCount: 0,
        tasksCompleted: 0,
        recentTrend: [0, 0, 0, 0, 0, 0, 0],
      });
    }

    // Sort: most tasks completed first, then alphabetical for ties
    return Array.from(statsMap.values()).sort(
      (a, b) => b.tasksCompleted - a.tasksCompleted || a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }
}
