/**
 * run-workflow — Execute a declarative workflow YAML file.
 *
 * Usage:
 *   cortextos bus run-workflow <workflow.yaml> [--dry-run] [--timeout <seconds>]
 *
 * Reads a workflow YAML, sends messages to agents in sequence, optionally waits
 * for each to reply before advancing to the next step. Passes shared context
 * between steps via a temp JSON file (injected when inject_context: true).
 *
 * Logs workflow_step_started and workflow_step_completed events to the activity
 * feed. Timeouts and per-step failures are handled gracefully — the runner logs
 * the failure and continues to the next step (fail-forward by default).
 *
 * YAML format:
 *   name: my-workflow
 *   type: sequential
 *   description: Optional description
 *   steps:
 *     - agent: analyst
 *       prompt: "Do the thing"
 *       wait_for_reply: true
 *       timeout: 300
 *     - agent: orchestrator
 *       prompt: "Synthesize and send"
 *       wait_for_reply: false
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { spawnSync } from 'child_process';
import type { Workflow, WorkflowStep } from '../types/workflow.js';

// ---------------------------------------------------------------------------
// Minimal YAML parser for the workflow schema
// ---------------------------------------------------------------------------

/**
 * Parse a workflow YAML file. Handles the specific schema used by cortextOS
 * workflows — no external dependency needed.
 *
 * Supports:
 *   - Top-level scalar values (string, boolean, number)
 *   - A `steps:` sequence of step objects
 *   - Multi-line prompt values via block scalar (|) or flow string ("...")
 */
export function parseWorkflowYaml(content: string): Workflow {
  const lines = content.split('\n');
  const result: Partial<Workflow> & { steps: WorkflowStep[] } = { steps: [] };

  let inSteps = false;
  let currentStep: Partial<WorkflowStep> | null = null;
  let multilineKey: string | null = null;
  let multilineLines: string[] = [];
  let multilineIndent = 0;

  function finalizeMultiline() {
    if (!multilineKey || !currentStep) return;
    (currentStep as Record<string, unknown>)[multilineKey] = multilineLines.join('\n').trimEnd();
    multilineKey = null;
    multilineLines = [];
  }

  function finalizeStep() {
    finalizeMultiline();
    if (currentStep && currentStep.agent && currentStep.prompt) {
      result.steps.push({
        agent: currentStep.agent,
        prompt: currentStep.prompt,
        wait_for_reply: currentStep.wait_for_reply ?? true,
        timeout: currentStep.timeout ?? 300,
        inject_context: currentStep.inject_context ?? false,
        label: currentStep.label,
      });
    }
    currentStep = null;
  }

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - trimmed.length;

    // Collecting block scalar lines
    if (multilineKey !== null) {
      if (indent > multilineIndent || trimmed.startsWith('|') || trimmed.startsWith('>')) {
        multilineLines.push(trimmed);
        continue;
      } else {
        // Block scalar ended
        finalizeMultiline();
      }
    }

    // Top-level: steps: key
    if (trimmed === 'steps:') {
      inSteps = true;
      continue;
    }

    // Top-level scalar values (not inside steps)
    if (!inSteps) {
      const topMatch = trimmed.match(/^(\w+):\s*(.*?)\s*$/);
      if (topMatch) {
        const [, key, val] = topMatch;
        (result as Record<string, unknown>)[key] = parseScalar(val);
      }
      continue;
    }

    // Inside steps section
    if (trimmed.startsWith('- ') || trimmed === '-') {
      // New step
      finalizeStep();
      currentStep = {};
      const afterDash = trimmed.slice(2).trim();
      if (afterDash) {
        // Inline: - agent: foo
        const m = afterDash.match(/^(\w+):\s*(.*?)\s*$/);
        if (m) {
          setStepField(currentStep, m[1], m[2]);
        }
      }
      continue;
    }

    if (currentStep !== null && indent > 0) {
      const fieldMatch = trimmed.match(/^(\w+):\s*(.*?)\s*$/);
      if (fieldMatch) {
        const [, key, val] = fieldMatch;
        if (val === '|' || val === '>') {
          // Block scalar — collect subsequent lines
          multilineKey = key;
          multilineLines = [];
          multilineIndent = indent;
        } else {
          setStepField(currentStep, key, val);
        }
      }
    }
  }

  // Finalize last step
  finalizeStep();

  if (!result.name) throw new Error('Workflow YAML missing required field: name');
  if (!result.type) throw new Error('Workflow YAML missing required field: type');
  if (result.type !== 'sequential') throw new Error(`Unsupported workflow type: ${result.type}. Only "sequential" is supported.`);
  if (!result.steps.length) throw new Error('Workflow has no steps');

  return result as Workflow;
}

function parseScalar(val: string): string | boolean | number {
  if (val === 'true') return true;
  if (val === 'false') return false;
  const n = Number(val);
  if (!isNaN(n) && val !== '') return n;
  // Strip surrounding quotes
  return val.replace(/^["']|["']$/g, '');
}

function setStepField(step: Partial<WorkflowStep>, key: string, val: string): void {
  const parsed = parseScalar(val);
  (step as Record<string, unknown>)[key] = parsed;
}

// ---------------------------------------------------------------------------
// Workflow runner
// ---------------------------------------------------------------------------

export interface WorkflowRunOptions {
  /** Path to the workflow YAML file. */
  workflowPath: string;
  /** Print what would happen without actually sending messages. */
  dryRun?: boolean;
  /** Override global default step timeout (seconds). */
  timeout?: number;
  /** Logger function. Defaults to console.log. */
  log?: (msg: string) => void;
  /** Working directory for context file (defaults to /tmp). */
  workDir?: string;
}

export interface StepResult {
  step: number;
  label: string;
  agent: string;
  status: 'ok' | 'timeout' | 'error' | 'skipped';
  duration_ms: number;
  msg_id?: string;
  error?: string;
}

export interface WorkflowResult {
  workflow: string;
  type: string;
  total_steps: number;
  succeeded: number;
  failed: number;
  duration_ms: number;
  steps: StepResult[];
}

export async function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const workDir = opts.workDir ?? '/tmp';

  // Parse workflow
  const content = readFileSync(opts.workflowPath, 'utf-8');
  const workflow = parseWorkflowYaml(content);

  log(`[workflow] Starting "${workflow.name}" (${workflow.steps.length} steps)`);
  if (opts.dryRun) log('[workflow] DRY RUN — no messages will be sent');

  // Shared context file (passed between steps when inject_context: true)
  const contextPath = join(workDir, `workflow-ctx-${Date.now()}.json`);
  const sharedContext: Record<string, unknown> = {
    workflow: workflow.name,
    started_at: new Date().toISOString(),
  };

  const startTime = Date.now();
  const stepResults: StepResult[] = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const label = step.label ?? `step ${i + 1}`;
    const timeout = opts.timeout ?? step.timeout ?? 300;
    const stepStart = Date.now();

    log(`[workflow] [${label}] → ${step.agent}: ${step.prompt.slice(0, 80)}${step.prompt.length > 80 ? '…' : ''}`);

    // Log step started event
    if (!opts.dryRun) {
      spawnSync('cortextos', [
        'bus', 'log-event', 'workflow', 'workflow_step_started', 'info',
        '--meta', JSON.stringify({ workflow: workflow.name, step: i + 1, label, agent: step.agent }),
      ], { timeout: 3000, stdio: 'ignore' });
    }

    if (opts.dryRun) {
      stepResults.push({ step: i + 1, label, agent: step.agent, status: 'skipped', duration_ms: 0 });
      continue;
    }

    // Build prompt — optionally inject shared context
    let prompt = step.prompt;
    if (step.inject_context && Object.keys(sharedContext).length > 2) {
      prompt = `${prompt}\n\nWorkflow context from prior steps:\n\`\`\`json\n${JSON.stringify(sharedContext, null, 2)}\n\`\`\``;
    }

    // Send message to agent
    let msgId: string | undefined;
    try {
      const sendResult = spawnSync('cortextos', [
        'bus', 'send-message', step.agent, 'normal', prompt,
      ], { timeout: 10_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

      if (sendResult.status !== 0) {
        const err = (sendResult.stderr ?? '').trim() || `exit ${sendResult.status}`;
        throw new Error(`send-message failed: ${err}`);
      }

      msgId = (sendResult.stdout ?? '').trim();
      sharedContext[`step_${i + 1}_msg_id`] = msgId;
    } catch (err) {
      const duration_ms = Date.now() - stepStart;
      log(`[workflow] [${label}] ERROR: ${err}`);
      stepResults.push({ step: i + 1, label, agent: step.agent, status: 'error', duration_ms, error: String(err) });
      continue;
    }

    // Wait for reply if requested
    let status: StepResult['status'] = 'ok';
    if (step.wait_for_reply !== false) {
      log(`[workflow] [${label}] Waiting for reply from ${step.agent} (timeout: ${timeout}s)…`);
      const waited = await waitForReply(step.agent, msgId, timeout * 1000, log);
      if (waited.timedOut) {
        status = 'timeout';
        log(`[workflow] [${label}] Timed out after ${timeout}s — continuing`);
      } else if (waited.reply) {
        sharedContext[`step_${i + 1}_reply`] = waited.reply;
        log(`[workflow] [${label}] Reply received`);
      }
    }

    const duration_ms = Date.now() - stepStart;

    // Log step completed event
    spawnSync('cortextos', [
      'bus', 'log-event', 'workflow', 'workflow_step_completed', 'info',
      '--meta', JSON.stringify({ workflow: workflow.name, step: i + 1, label, agent: step.agent, status, duration_ms }),
    ], { timeout: 3000, stdio: 'ignore' });

    stepResults.push({ step: i + 1, label, agent: step.agent, status, duration_ms, msg_id: msgId });
  }

  // Clean up context file
  try { if (existsSync(contextPath)) unlinkSync(contextPath); } catch { /* ignore */ }

  const duration_ms = Date.now() - startTime;
  const succeeded = stepResults.filter((s) => s.status === 'ok' || s.status === 'skipped').length;
  const failed = stepResults.filter((s) => s.status === 'error' || s.status === 'timeout').length;

  log(`[workflow] "${workflow.name}" complete — ${succeeded}/${workflow.steps.length} steps OK (${Math.round(duration_ms / 1000)}s)`);

  // Log workflow completed event
  if (!opts.dryRun) {
    spawnSync('cortextos', [
      'bus', 'log-event', 'workflow', 'workflow_completed', 'info',
      '--meta', JSON.stringify({ workflow: workflow.name, succeeded, failed, duration_ms }),
    ], { timeout: 3000, stdio: 'ignore' });
  }

  return { workflow: workflow.name, type: workflow.type, total_steps: workflow.steps.length, succeeded, failed, duration_ms, steps: stepResults };
}

// ---------------------------------------------------------------------------
// Reply polling
// ---------------------------------------------------------------------------

interface WaitResult {
  timedOut: boolean;
  reply?: string;
}

/**
 * Poll the agent's outbox for a reply to msg_id.
 * Checks every 5s until timeout.
 */
async function waitForReply(
  agentName: string,
  msgId: string,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 5_000;

  while (Date.now() < deadline) {
    await sleep(pollMs);

    // Check the agent's processed messages for a reply_to matching msgId
    try {
      const result = spawnSync('cortextos', [
        'bus', 'check-inbox', '--from', agentName, '--reply-to', msgId, '--count-only',
      ], { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

      const count = parseInt((result.stdout ?? '').trim(), 10);
      if (count > 0) {
        return { timedOut: false, reply: `${count} reply(ies) received` };
      }
    } catch {
      // check-inbox may not support --reply-to; just continue
    }
  }

  return { timedOut: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
