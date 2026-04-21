/**
 * Stub: Hermes PTY support (from b94aa8f) was not cherry-picked.
 * This stub preserves backward compat with agent-process.ts import.
 */
export class HermesPTY {
  constructor() {
    throw new Error('Hermes PTY not available: b94aa8f was not cherry-picked');
  }
}

export function hermesDbExists(): boolean {
  return false;
}
