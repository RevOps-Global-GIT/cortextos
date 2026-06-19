/**
 * Guards the explicit internal pseudo-identity allowlist used to route
 * send-message acks for root/system/director without hitting the externalEmail
 * policy gate.
 *
 * Constraint: unknown targets must NOT be treated as internal — only the
 * explicit allowlist passes.
 */

import { describe, it, expect } from 'vitest';
import { isInternalPseudoIdentity } from '../../../src/cli/bus.js';

describe('isInternalPseudoIdentity', () => {
  it('recognises root as internal', () => {
    expect(isInternalPseudoIdentity('root')).toBe(true);
  });

  it('recognises system as internal', () => {
    expect(isInternalPseudoIdentity('system')).toBe(true);
  });

  it('recognises director as internal', () => {
    expect(isInternalPseudoIdentity('director')).toBe(true);
  });

  it('does not treat an external user target as internal (draft_only gate must still fire)', () => {
    expect(isInternalPseudoIdentity('8567114601')).toBe(false);
  });

  it('does not treat an unknown identifier as internal', () => {
    expect(isInternalPseudoIdentity('unknown-user')).toBe(false);
  });

  it('does not treat an empty string as internal', () => {
    expect(isInternalPseudoIdentity('')).toBe(false);
  });
});
