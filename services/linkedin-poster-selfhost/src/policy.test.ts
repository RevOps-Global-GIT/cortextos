import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLinkedInRuntimePolicy, manualModeResponse } from './policy.js';

describe('getLinkedInRuntimePolicy', () => {
  it('defaults to manual mode when POSTER_LINKEDIN_MODE is unset', () => {
    const policy = getLinkedInRuntimePolicy({});

    assert.equal(policy.mode, 'manual');
    assert.equal(policy.browserEnabled, false);
    assert.equal(policy.reason, 'linkedin_browser_automation_disabled_manual_mode');
  });

  it('requires explicit browser mode before enabling automation', () => {
    const policy = getLinkedInRuntimePolicy({ POSTER_LINKEDIN_MODE: 'browser' });

    assert.equal(policy.mode, 'browser');
    assert.equal(policy.browserEnabled, true);
    assert.equal(policy.reason, 'linkedin_browser_automation_explicitly_enabled');
  });

  it('treats unknown modes as manual mode', () => {
    const policy = getLinkedInRuntimePolicy({ POSTER_LINKEDIN_MODE: 'true' });

    assert.equal(policy.mode, 'manual');
    assert.equal(policy.browserEnabled, false);
    assert.equal(policy.metadata['requestedMode'], 'true');
  });
});

describe('manualModeResponse', () => {
  it('returns a disabled health payload', () => {
    const policy = getLinkedInRuntimePolicy({});
    const response = manualModeResponse(policy, 'greg');

    assert.equal(response.ok, false);
    assert.equal(response.userId, 'greg');
    assert.equal(response.mode, 'manual');
    assert.match(response.message, /automation is disabled/i);
  });
});
