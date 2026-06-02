export type AgentRecoveryState =
  | 'running'
  | 'heartbeat_only_running'
  | 'stale_heartbeat_action_required'
  | 'stopped';

export interface AgentRunningState {
  running: boolean;
  heartbeatFresh: boolean;
  recoveryState: AgentRecoveryState;
}

export function computeAgentRunningState(params: {
  daemonRunning: boolean;
  heartbeatAgeMinutes: number | null;
  heartbeatFreshThresholdMinutes: number;
}): AgentRunningState {
  const heartbeatFresh =
    params.heartbeatAgeMinutes !== null &&
    params.heartbeatAgeMinutes <= params.heartbeatFreshThresholdMinutes;

  if (params.daemonRunning && !heartbeatFresh) {
    return {
      running: false,
      heartbeatFresh,
      recoveryState: 'stale_heartbeat_action_required',
    };
  }

  if (params.daemonRunning) {
    return {
      running: true,
      heartbeatFresh,
      recoveryState: 'running',
    };
  }

  if (heartbeatFresh) {
    return {
      running: true,
      heartbeatFresh,
      recoveryState: 'heartbeat_only_running',
    };
  }

  return {
    running: false,
    heartbeatFresh,
    recoveryState: 'stopped',
  };
}
