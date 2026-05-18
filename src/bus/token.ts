import { randomString } from '../utils/random.js';

export interface DispatchToken {
  token: string;
  created_at: string;
  scope: string;
}

export function createDispatchToken(scope = 'bus'): DispatchToken {
  const timestamp = new Date().toISOString();
  const compact = timestamp.replace(/[-:.TZ]/g, '');
  return {
    token: `${scope}-${compact}-${randomString(8)}`,
    created_at: timestamp,
    scope,
  };
}

