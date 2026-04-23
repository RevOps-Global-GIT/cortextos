/**
 * Declarative workflow types for cortextOS.
 *
 * Workflows are defined in YAML files and executed by `cortextos bus run-workflow`.
 * Currently only SequentialWorkflow is supported (steps run in order, each waits
 * for the previous to complete).
 */

export interface WorkflowStep {
  /** Target agent name (must be a known agent in the org). */
  agent: string;
  /** Message/prompt to send to the agent. */
  prompt: string;
  /** Whether to wait for the agent to reply before proceeding. Default: true. */
  wait_for_reply?: boolean;
  /** Timeout in seconds before giving up on wait_for_reply. Default: 300. */
  timeout?: number;
  /**
   * If true, inject the shared workflow context JSON into the prompt as a
   * JSON block so the agent can use results from prior steps. Default: false.
   */
  inject_context?: boolean;
  /** Human-readable label shown in logs. Defaults to "step N". */
  label?: string;
}

export interface Workflow {
  name: string;
  type: 'sequential';
  description?: string;
  steps: WorkflowStep[];
}
