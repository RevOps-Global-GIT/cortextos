import type {
  AgentSteerActionClass,
  AgentSteerApprovalClass,
  AgentSteerApprovalDecision,
  AgentSteerPayload,
  ApprovalCategory,
} from '../types/index.js';

export const AGENT_STEER_APPROVAL_CLASS_BY_ACTION: Record<AgentSteerActionClass, AgentSteerApprovalClass> = {
  guidance: 'low_risk_direct',
  status_request: 'low_risk_direct',
  artifact_request: 'low_risk_direct',
  pause: 'high_risk_approval',
  resume: 'high_risk_approval',
  escalate: 'high_risk_approval',
  stop: 'high_risk_approval',
};

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; category: ApprovalCategory; reason: string }> = [
  { pattern: /\b(delete|remove|drop|truncate|purge|destroy)\b/i, category: 'data-deletion', reason: 'destructive data operation' },
  { pattern: /\b(deploy|release|merge|push\s+to\s+main|promote\s+to\s+prod|production)\b/i, category: 'deployment', reason: 'deployment or production change' },
  { pattern: /\b(email|send|post|publish|tweet|linkedin|slack|telegram)\b/i, category: 'external-comms', reason: 'external communication' },
  { pattern: /\b(spend|charge|invoice|purchase|buy|billing|payment|refund)\b/i, category: 'financial', reason: 'financial action' },
];

function textForRiskScan(payload: AgentSteerPayload): string {
  return [
    payload.instruction,
    payload.reason,
    payload.artifactType,
    payload.liveStatePath,
    payload.metadata ? JSON.stringify(payload.metadata) : undefined,
  ].filter(Boolean).join('\n');
}

function highRiskFromPayload(payload: AgentSteerPayload): { category: ApprovalCategory; reason: string } | null {
  const text = textForRiskScan(payload);
  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.pattern.test(text)) {
      return { category: rule.category, reason: rule.reason };
    }
  }
  return null;
}

export function classifyAgentSteerAction(
  actionClass: AgentSteerActionClass,
  payload: AgentSteerPayload = {},
): AgentSteerApprovalDecision {
  const configuredClass = AGENT_STEER_APPROVAL_CLASS_BY_ACTION[actionClass];
  const payloadRisk = highRiskFromPayload(payload);

  if (configuredClass === 'high_risk_approval') {
    return {
      approval_class: 'high_risk_approval',
      approval_required: true,
      approval_category: payloadRisk?.category ?? 'other',
      reason: payloadRisk?.reason ?? `${actionClass} changes agent execution state`,
    };
  }

  if (payloadRisk) {
    return {
      approval_class: 'high_risk_approval',
      approval_required: true,
      approval_category: payloadRisk.category,
      reason: payloadRisk.reason,
    };
  }

  return {
    approval_class: 'low_risk_direct',
    approval_required: false,
    approval_category: null,
    reason: `${actionClass} is read-only or advisory`,
  };
}
