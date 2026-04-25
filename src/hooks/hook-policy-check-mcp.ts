/**
 * hook-policy-check-mcp.ts — PreToolUse hook for MCP tools: enforces P3 policy.
 *
 * P3: No email automation without explicit Greg approval.
 * This hook is registered with matcher "mcp__rgos__instantly_*" to catch
 * direct MCP tool calls that bypass the Bash hook entirely.
 *
 * This hook ALWAYS blocks — if it fires, the MCP tool is in the policy scope
 * and requires prior approval. The agent must create an approval task first.
 *
 * On crash: exits non-zero → tool call is BLOCKED (fail-closed). Intentional.
 */

import { execFileSync } from 'child_process';
import { readStdin, parseHookInput } from './index.js';

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name } = parseHookInput(raw);

  const agent = process.env.CTX_AGENT_NAME || 'unknown';
  const reason = `Email automation MCP tools require explicit Greg approval. Tool "${tool_name}" is blocked. Create an approval task first via: cortextos bus create-approval email_send "Activate campaign" --desc "<campaign details>"`;

  // Log to Activity feed (best-effort)
  try {
    execFileSync('cortextos', [
      'bus', 'log-event', 'policy', 'policy_block', 'warn',
      '--meta', JSON.stringify({ policy: 'P3-MCP', agent, tool: tool_name }),
    ], { timeout: 3000, stdio: 'ignore' });
  } catch {
    // Logging failure must not affect the block decision
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`hook-policy-check-mcp error: ${err}\n`);
  process.exit(1);
});
