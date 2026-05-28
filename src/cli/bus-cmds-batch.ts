import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { validateAgentName, validatePriority } from '../utils/validate.js';
import { createTask } from '../bus/task.js';
import type { Priority } from '../types/index.js';

/**
 * registerBatchCommands — `cortextos bus dispatch-batch <agent> <count> <title-template>`
 *
 * Generates a UUID v4, creates `<count>` tasks in one pass (all status=in_progress,
 * sharing the same dispatch_batch_id + parallel_count), and prints the batch id
 * to stdout. The `{n}` placeholder in the title template is replaced with the
 * task number (1-indexed).
 *
 * Task creation goes through createTask(), which mirrors to orch_tasks via
 * rgos-mirror (fire-and-forget). The dispatch_batch_id and parallel_count fields
 * are propagated in buildTaskRow().
 */
export function registerBatchCommands(busCommand: Command): void {
  busCommand
    .command('dispatch-batch')
    .description('Create N parallel tasks for an agent under a single batch id (parallel-tasks feature)')
    .argument('<agent>', 'Agent to assign the batch to')
    .argument('<count>', 'Number of parallel tasks to create')
    .argument('<title-template>', 'Title template; "{n}" is replaced by 1..count')
    .option('--desc <text>', 'Task description (shared across all tasks in the batch)')
    .option('--project <name>', 'Project name')
    .option('--priority <p>', 'Priority (urgent, high, normal, low)', 'normal')
    .action((agent: string, countRaw: string, titleTemplate: string, opts: { desc?: string; project?: string; priority: string }) => {
      try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

      const count = parseInt(countRaw, 10);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        console.error(`Error: <count> must be an integer between 1 and 100, got '${countRaw}'.`);
        process.exit(1);
      }

      const priority = opts.priority as Priority;
      try { validatePriority(priority); } catch (err) { console.error(String(err)); process.exit(1); }

      const env = resolveEnv();
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      const batchId = randomUUID();
      const desc = opts.desc ?? '';

      const ids: string[] = [];
      for (let n = 1; n <= count; n++) {
        const title = titleTemplate.includes('{n}')
          ? titleTemplate.replace(/\{n\}/g, String(n))
          : `${titleTemplate} (${n}/${count})`;
        const id = createTask(paths, env.agentName, env.org, title, {
          description: desc,
          assignee: agent,
          priority,
          project: opts.project,
          dispatchBatchId: batchId,
          parallelCount: count,
          initialStatus: 'in_progress',
          // Batch dispatch is a scripted bulk op — brief contract validation
          // is enforced at the orchestration layer that issues this command.
          skipBriefValidation: true,
          meta: { dispatch_batch_id: batchId, parallel_count: count },
        });
        ids.push(id);
      }

      console.log(batchId);
      for (const id of ids) console.error(id);
      process.exit(0);
    });
}
