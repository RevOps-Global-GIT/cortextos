export type LinkedInRuntimeMode = 'manual' | 'browser';

export interface LinkedInRuntimePolicy {
  mode: LinkedInRuntimeMode;
  browserEnabled: boolean;
  reason: string;
  metadata: Record<string, string | boolean>;
}

const MANUAL_REASON =
  'linkedin_browser_automation_disabled_manual_mode';

export function getLinkedInRuntimePolicy(
  env: NodeJS.ProcessEnv = process.env,
): LinkedInRuntimePolicy {
  const requestedMode = String(env['POSTER_LINKEDIN_MODE'] ?? 'manual')
    .trim()
    .toLowerCase();

  if (requestedMode === 'browser') {
    return {
      mode: 'browser',
      browserEnabled: true,
      reason: 'linkedin_browser_automation_explicitly_enabled',
      metadata: {
        linkedinMode: 'browser',
        browserAutomationEnabled: true,
      },
    };
  }

  return {
    mode: 'manual',
    browserEnabled: false,
    reason: MANUAL_REASON,
    metadata: {
      linkedinMode: 'manual',
      browserAutomationEnabled: false,
      requestedMode: requestedMode || 'manual',
    },
  };
}

export function manualModeResponse(policy: LinkedInRuntimePolicy, userId: string) {
  return {
    ok: false,
    userId,
    mode: policy.mode,
    reason: policy.reason,
    message:
      'LinkedIn browser automation is disabled. Use a manual, user-controlled recovery path; do not run automated LinkedIn login or posting.',
  };
}
