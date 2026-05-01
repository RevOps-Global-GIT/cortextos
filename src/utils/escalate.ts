/**
 * escalate.ts — Structured error escalation utility.
 *
 * Replaces bare `console.error` / empty `.catch()` across the codebase with a
 * single routing path: console output + event log + optional Telegram alert.
 *
 * Routing by level:
 *   'low'      → console.warn only
 *   'medium'   → console.error + event log (severity: warn)
 *   'high'     → console.error + event log (severity: error)
 *   'critical' → console.error + event log + Telegram alert (if configured)
 *
 * Usage:
 *   1. Call `initEscalate(config)` once at daemon/bus CLI entry.
 *   2. Import and call `escalate()` / `escalateCritical()` etc. anywhere.
 *
 * Safe before init: degrades to `console.error` only — never throws.
 * Never throws from a catch block — all internal errors are suppressed.
 */

import { logEvent } from '../bus/event.js';
import type { BusPaths } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EscalateLevel = 'low' | 'medium' | 'high' | 'critical';

export interface EscalateOptions {
  /** Human-readable context — what operation failed */
  context: string;
  /** Error object or message */
  err: unknown;
  /** Escalation severity — controls routing */
  level?: EscalateLevel; // default: 'medium'
  /** Extra key/value pairs added to event log metadata */
  meta?: Record<string, unknown>;
}

export interface EscalateConfig {
  paths: BusPaths;
  agentName: string;
  org: string;
  /** Optional — null means no Telegram escalation for critical events */
  telegramApi: TelegramLike | null;
  telegramChatId?: string;
}

/** Minimal interface required from TelegramAPI — avoids a hard import cycle. */
export interface TelegramLike {
  sendMessage(chatId: string, text: string, options?: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Singleton config
// ---------------------------------------------------------------------------

let _config: EscalateConfig | null = null;

/**
 * Initialise the escalation utility. Call once at daemon/bus CLI boot.
 * Must be called before any `escalate*()` usage to get event-log and Telegram routing.
 * If not called, escalate() falls back to console.error only.
 */
export function initEscalate(config: EscalateConfig): void {
  _config = config;
}

/** Exposed for testing — reset singleton between test cases. */
export function _resetEscalate(): void {
  _config = null;
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Structured error escalation.
 * Never throws. Safe to call inside catch blocks.
 */
export function escalate(options: EscalateOptions): void {
  const { context, err, level = 'medium', meta = {} } = options;

  try {
    const message = extractMessage(err);

    if (level === 'low') {
      console.warn(`[escalate] ${context}:`, err);
      return;
    }

    // medium / high / critical → console.error always
    console.error(`[escalate/${level}] ${context}:`, err);

    if (!_config) {
      // Pre-init degraded mode — console only
      return;
    }

    const { paths, agentName, org, telegramApi, telegramChatId } = _config;
    const severity = level === 'medium' ? 'warn' : 'error';
    const eventMeta: Record<string, unknown> = { context, message, ...meta };

    // Event log (medium / high / critical)
    try {
      logEvent(paths, agentName, org, 'error', 'system_error', severity, eventMeta);
    } catch {
      // Never let logEvent failure surface from escalate
    }

    // Telegram alert (critical only)
    if (level === 'critical' && telegramApi && telegramChatId) {
      telegramApi
        .sendMessage(telegramChatId, `🔴 CRITICAL: ${context}\n${message}`, { plainText: true })
        .catch(() => {
          // Telegram being down must never produce a secondary failure
        });
    }
  } catch {
    // Absolute last resort — escalate itself must never throw
  }
}

// ---------------------------------------------------------------------------
// Convenience shorthands
// ---------------------------------------------------------------------------

export function escalateCritical(
  context: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  escalate({ context, err, level: 'critical', meta });
}

export function escalateHigh(
  context: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  escalate({ context, err, level: 'high', meta });
}

export function escalateMedium(
  context: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  escalate({ context, err, level: 'medium', meta });
}
