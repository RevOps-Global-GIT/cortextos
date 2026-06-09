import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guards that specific revops-global agents have the PostToolUse skill-telemetry hook.
 *
 * These agents power the orch_skill_invocations table (Skills card on /app/skills).
 * Without the hook, skill usage by these agents is invisible to the trend charts.
 *
 * Agents: agentops-orch, hermes, orca-orch, monitor, cortextos
 * Added: 2026-06-09 — PR that rolled out hook-skill-telemetry to the gap agents.
 */

const ORG_AGENTS_DIR = join(__dirname, '..', '..', 'orgs', 'revops-global', 'agents');

const HOOK_COMMAND = 'cortextos bus hook-skill-telemetry';
const HOOK_MATCHER = '(Skill|Read)';

function hasSkillTelemetryHook(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const postToolUse: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> =
    settings?.hooks?.PostToolUse ?? [];
  return postToolUse.some(
    (entry) =>
      entry.matcher === HOOK_MATCHER &&
      entry.hooks?.some((h) => h.command === HOOK_COMMAND),
  );
}

const TARGET_AGENTS = ['agentops-orch', 'hermes', 'orca-orch', 'monitor', 'cortextos'];

describe('org-agent skill-telemetry hook completeness', () => {
  for (const agent of TARGET_AGENTS) {
    it(`${agent} has PostToolUse hook-skill-telemetry`, () => {
      const settingsPath = join(ORG_AGENTS_DIR, agent, '.claude', 'settings.json');
      expect(
        hasSkillTelemetryHook(settingsPath),
        `${agent}/.claude/settings.json is missing the PostToolUse hook-skill-telemetry entry`,
      ).toBe(true);
    });
  }
});
