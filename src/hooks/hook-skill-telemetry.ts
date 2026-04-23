/**
 * hook-skill-telemetry.ts — PostToolUse hook (matcher: Skill).
 *
 * Fires after every Skill tool call. Extracts the skill slug from tool_input
 * and posts to the skill-telemetry edge function, which inserts a row into
 * orch_skill_invocations and increments orch_skills.total_invocations via
 * an AFTER INSERT trigger.
 *
 * The hook always exits 0 — it never blocks the agent. All errors are
 * logged to stderr and silently ignored.
 *
 * Credentials are read from the agent's .env file (SUPABASE_RGOS_URL +
 * SUPABASE_RGOS_SERVICE_KEY). If absent, the hook exits silently.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readStdin, parseHookInput } from './index.js';

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  // Only handle Skill tool calls
  if (tool_name !== 'Skill') return;

  const slug: string | undefined = tool_input?.skill;
  if (!slug || typeof slug !== 'string') {
    process.stderr.write('hook-skill-telemetry: no skill slug in tool_input — skipping\n');
    return;
  }

  // Read Supabase credentials from agent .env (CTX_AGENT_DIR env or cwd-relative)
  const agentDir = process.env.CTX_AGENT_DIR ?? process.cwd();
  const envFile = join(agentDir, '.env');
  if (!existsSync(envFile)) {
    process.stderr.write('hook-skill-telemetry: no .env found — skipping\n');
    return;
  }
  const envContent = readFileSync(envFile, 'utf-8');
  const sbUrl = envContent.match(/^SUPABASE_RGOS_URL=(.+)$/m)?.[1]?.trim();
  const sbKey = envContent.match(/^SUPABASE_RGOS_SERVICE_KEY=(.+)$/m)?.[1]?.trim();
  if (!sbUrl || !sbKey) {
    process.stderr.write('hook-skill-telemetry: SUPABASE_RGOS_URL/KEY not set — skipping\n');
    return;
  }

  const agentId = process.env.CTX_AGENT_ID ?? undefined;

  try {
    const res = await fetch(`${sbUrl}/functions/v1/skill-telemetry`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug,
        agent_id: agentId,
        source: 'agent',
        succeeded: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`hook-skill-telemetry: telemetry POST failed (${res.status}): ${body}\n`);
    } else {
      process.stderr.write(`hook-skill-telemetry: logged invocation for skill "${slug}"\n`);
    }
  } catch (err) {
    process.stderr.write(`hook-skill-telemetry: fetch error — ${err}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`hook-skill-telemetry: error — ${err}\n`);
  process.exit(0); // always exit 0 — never block tool execution
});
