/**
 * Shared vitest mock factories for the cortextOS test suite.
 *
 * These factories produce the return values passed to vi.mock(…).
 * vi.mock() calls must remain in each test file (vitest hoists them to the
 * top of the module), but the implementations live here so they stay DRY.
 *
 * Usage in a test file:
 *
 *   import {
 *     agentProcessMockFactory,
 *     fastCheckerMockFactory,
 *     telegramAPIMockFactory,
 *     telegramPollerMockFactory,
 *   } from '../../helpers/mocks';
 *
 *   vi.mock('../../../src/daemon/agent-process.js', agentProcessMockFactory);
 *   vi.mock('../../../src/daemon/fast-checker.js', fastCheckerMockFactory);
 *   vi.mock('../../../src/telegram/api.js', telegramAPIMockFactory);
 *   vi.mock('../../../src/telegram/poller.js', telegramPollerMockFactory);
 *
 * For the postActivity spy pattern (approval tests):
 *
 *   import { makePostActivitySpy, systemMockFactory, messageMockFactory } from '../../helpers/mocks';
 *   const postActivitySpy = makePostActivitySpy();
 *   vi.mock('../../../src/bus/system', () => systemMockFactory(postActivitySpy));
 *   vi.mock('../../../src/bus/message', messageMockFactory);
 */

import { vi } from 'vitest';

// ─── Daemon process mocks ─────────────────────────────────────────────────────
// Used to prevent loading native node-pty bindings in unit tests.
// AgentManager → AgentProcess → AgentPTY → node-pty: mock at AgentProcess level.

export function agentProcessMockFactory() {
  return {
    AgentProcess: class {
      name: string;
      dir: string;
      constructor(name: string, dir: string) {
        this.name = name;
        this.dir = dir;
      }
      async start() { /* no-op */ }
      async stop() { /* no-op */ }
      getStatus() { return { name: this.name, status: 'stopped' }; }
      onExit() { /* no-op */ }
    },
  };
}

export function fastCheckerMockFactory() {
  return {
    FastChecker: class {
      start() { /* no-op */ }
      stop() { /* no-op */ }
      wake() { /* no-op */ }
    },
  };
}

export function telegramAPIMockFactory() {
  return {
    TelegramAPI: class {
      constructor() { /* no-op */ }
    },
  };
}

export function telegramPollerMockFactory() {
  return {
    TelegramPoller: class {
      start() { /* no-op */ }
      stop() { /* no-op */ }
    },
  };
}

// ─── postActivity spy ─────────────────────────────────────────────────────────
// Approval tests need to observe fire-and-forget postActivity calls without
// awaiting them.  Create the spy once at module scope, pass it into the factory.

export type PostActivitySpy = ReturnType<typeof makePostActivitySpy>;

export function makePostActivitySpy() {
  return vi.fn().mockResolvedValue(true);
}

/**
 * Factory for vi.mock('../../../src/bus/system', …).
 * Wraps the spy so vitest's module mock sees a stable function reference.
 */
export function systemMockFactory(spy: PostActivitySpy) {
  return {
    postActivity: (...args: unknown[]) => spy(...args),
  };
}

/**
 * Factory for vi.mock('../../../src/bus/message', …).
 */
export function messageMockFactory() {
  return {
    sendMessage: vi.fn(),
  };
}
