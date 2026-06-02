import { describe, expect, it } from 'vitest';
import { computeAgentRunningState } from '../../../src/bus/agent-running.js';

const threshold = 120;

describe('computeAgentRunningState', () => {
  it('treats daemon-confirmed agents with fresh heartbeats as running', () => {
    expect(computeAgentRunningState({
      daemonRunning: true,
      heartbeatAgeMinutes: 1.5,
      heartbeatFreshThresholdMinutes: threshold,
    })).toEqual({
      running: true,
      heartbeatFresh: true,
      recoveryState: 'running',
    });
  });

  it('keeps daemon-confirmed agents with stale heartbeats in recovery', () => {
    expect(computeAgentRunningState({
      daemonRunning: true,
      heartbeatAgeMinutes: 180,
      heartbeatFreshThresholdMinutes: threshold,
    })).toEqual({
      running: false,
      heartbeatFresh: false,
      recoveryState: 'stale_heartbeat_action_required',
    });
  });

  it('does not report fresh-heartbeat agents as stopped when daemon IPC misses them', () => {
    expect(computeAgentRunningState({
      daemonRunning: false,
      heartbeatAgeMinutes: 1.5,
      heartbeatFreshThresholdMinutes: threshold,
    })).toEqual({
      running: true,
      heartbeatFresh: true,
      recoveryState: 'heartbeat_only_running',
    });
  });

  it('reports stopped when neither daemon nor heartbeat freshness proves liveness', () => {
    expect(computeAgentRunningState({
      daemonRunning: false,
      heartbeatAgeMinutes: null,
      heartbeatFreshThresholdMinutes: threshold,
    })).toEqual({
      running: false,
      heartbeatFresh: false,
      recoveryState: 'stopped',
    });
  });
});
