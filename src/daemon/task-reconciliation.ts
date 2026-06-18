/**
 * Pure decision logic for daemon task reconciliation (Pattern 1).
 *
 * Extracted from AgentManager.runReconciliationPass so the liveness/staleness
 * gate is unit-testable without a network or a live PTY. The reconciliation
 * tick finds orch_tasks rows stuck in_progress, and this function decides — per
 * row — whether the row is an orphaned claim that should be re-queued back to
 * `approved`.
 *
 * CRITICAL: liveness is the daemon process map, NOT heartbeat freshness. A
 * Supabase mirror outage makes a perfectly healthy agent show a stale
 * heartbeat; gating on heartbeat would falsely re-queue its in-flight work. So
 * `hasLiveProcess` (does AgentManager hold a running AgentProcess for the
 * assignee?) is the authoritative gate. updated_at staleness is only a
 * secondary grace window applied AFTER we already know no live process exists.
 */

/** A task is considered orphan-eligible only once its row has been untouched
 *  this long. Mirrors ORPHAN_STALE_MS in agent-manager.ts. */
export const DEFAULT_ORPHAN_STALE_MS = 15 * 60_000;

export interface RequeueDecisionInput {
  /** True iff AgentManager holds a registered AgentProcess for the assignee
   *  whose .isRunning() returns true. This is the ONLY liveness gate. */
  hasLiveProcess: boolean;
  /** orch_tasks.updated_at (ISO string) for the in_progress row. */
  taskUpdatedAt: string | null | undefined;
  /** Reference "now" in epoch ms. */
  now: number;
  /** Staleness grace window. Defaults to DEFAULT_ORPHAN_STALE_MS. */
  staleMs?: number;
}

/**
 * Decide whether an in_progress orch_tasks row should be re-queued to approved.
 *
 * Returns true ONLY when:
 *   1. There is NO live process for the assignee (the orphan signal), AND
 *   2. The row has been stale (updated_at older than staleMs) — a grace window
 *      so a freshly-claimed row whose owning session is mid-restart is not
 *      yanked away before the agent comes back.
 *
 * A live process ALWAYS short-circuits to false, regardless of heartbeat or
 * updated_at age — this is the mirror-outage protection.
 */
export function shouldRequeue(input: RequeueDecisionInput): boolean {
  // Liveness gate: a live owning process means the work is in flight. Never
  // re-queue, no matter how stale the row or heartbeat looks.
  if (input.hasLiveProcess) return false;

  const staleMs = input.staleMs ?? DEFAULT_ORPHAN_STALE_MS;

  // No usable updated_at — treat as not-yet-stale (conservative: do not
  // re-queue a row we cannot age, leave it for a later tick once it has a
  // timestamp, or for manual intervention).
  if (!input.taskUpdatedAt) return false;

  const updatedMs = Date.parse(input.taskUpdatedAt);
  if (Number.isNaN(updatedMs)) return false;

  const ageMs = input.now - updatedMs;
  return ageMs >= staleMs;
}
