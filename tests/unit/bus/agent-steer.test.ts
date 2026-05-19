import { describe, expect, it } from 'vitest';
import {
  AGENT_STEER_APPROVAL_CLASS_BY_ACTION,
  classifyAgentSteerAction,
} from '../../../src/bus/agent-steer';

describe('agent steer approval classification', () => {
  it('allows read-only/watch actions to run directly', () => {
    expect(AGENT_STEER_APPROVAL_CLASS_BY_ACTION.status_request).toBe('low_risk_direct');

    const decision = classifyAgentSteerAction('status_request', {
      sourcePanel: 'agent_work_panel',
      instruction: 'show latest status',
    });

    expect(decision).toMatchObject({
      approval_class: 'low_risk_direct',
      approval_required: false,
      approval_category: null,
    });
  });

  it('requires approval for agent execution-state controls', () => {
    const decision = classifyAgentSteerAction('stop', {
      sourcePanel: 'agent_work_panel',
      reason: 'operator wants to stop the current run',
    });

    expect(decision).toMatchObject({
      approval_class: 'high_risk_approval',
      approval_required: true,
      approval_category: 'other',
    });
    expect(decision.reason).toContain('stop');
  });

  it('escalates advisory guidance when the payload asks for a deployment', () => {
    const decision = classifyAgentSteerAction('guidance', {
      instruction: 'merge the PR and deploy to production',
    });

    expect(decision).toMatchObject({
      approval_class: 'high_risk_approval',
      approval_required: true,
      approval_category: 'deployment',
    });
  });

  it('maps external communication wording to the external-comms approval category', () => {
    const decision = classifyAgentSteerAction('guidance', {
      instruction: 'send an email to the client with this update',
    });

    expect(decision).toMatchObject({
      approval_class: 'high_risk_approval',
      approval_required: true,
      approval_category: 'external-comms',
    });
  });
});
