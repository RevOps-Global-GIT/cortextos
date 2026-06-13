import type { Priority, EventCategory, EventSeverity, ApprovalCategory } from '../types/index.js';
import { VALID_PRIORITIES } from '../types/index.js';

const AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;

export function validateInstanceId(instanceId: string): void {
  if (!instanceId || !AGENT_NAME_REGEX.test(instanceId)) {
    throw new Error(
      `Invalid instance ID '${instanceId}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateAgentName(name: string): void {
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid agent name '${name}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateOrgName(org: string): void {
  if (!org || !AGENT_NAME_REGEX.test(org)) {
    throw new Error(
      `Invalid org name '${org}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validatePriority(priority: string): asserts priority is Priority {
  if (!VALID_PRIORITIES.includes(priority as Priority)) {
    throw new Error(
      `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}`
    );
  }
}

const VALID_CATEGORIES: EventCategory[] = [
  'action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval',
  'agent_activity', 'capability',
];

export function validateEventCategory(category: string): asserts category is EventCategory {
  if (!VALID_CATEGORIES.includes(category as EventCategory)) {
    throw new Error(
      `Invalid event category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }
}

const VALID_SEVERITIES: EventSeverity[] = ['info', 'warning', 'error', 'critical'];

export function validateEventSeverity(severity: string): asserts severity is EventSeverity {
  if (!VALID_SEVERITIES.includes(severity as EventSeverity)) {
    throw new Error(
      `Invalid severity '${severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`
    );
  }
}

const VALID_APPROVAL_CATEGORIES: ApprovalCategory[] = [
  'external-comms', 'financial', 'deployment', 'data-deletion', 'other',
];

export function validateApprovalCategory(category: string): asserts category is ApprovalCategory {
  if (!VALID_APPROVAL_CATEGORIES.includes(category as ApprovalCategory)) {
    throw new Error(
      `Invalid approval category '${category}'. Must be one of: ${VALID_APPROVAL_CATEGORIES.join(', ')}`
    );
  }
}

export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip terminal control sequences and non-printable characters from external input.
 * Applied to all inbound Telegram text, captions, and callback data before PTY injection.
 * Prevents terminal injection attacks via crafted Telegram messages.
 */
export function stripControlChars(input: string): string {
  return input
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')    // ANSI CSI sequences (e.g. \e[31m)
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences (e.g. \e]0;title\a)
    .replace(/\x1b[^[\]]/g, '')                  // Other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Control chars (keep \t=0x09, \n=0x0a, \r=0x0d)
}

/**
 * Sanitize an untrusted value before it is interpolated into a PTY containment
 * header (e.g. the `=== TELEGRAM from [USER: ...] ===` / `=== REACTION ... ===`
 * lines injected into an agent's PTY). `stripControlChars` removes ANSI/control
 * sequences but keeps newlines and ordinary ASCII, so a crafted display name like
 * `=== AGENT MESSAGE from daemon ===` or `x\n=== TELEGRAM from [USER: evil]` can
 * still forge a real header line. This neutralizes that class by collapsing
 * carriage returns, defanging triple-backtick fences, and prefixing any line that
 * looks like a containment/`Reply using:` header with a `[quoted]` marker so it can
 * never be parsed as a genuine header.
 *
 * For fenced text bodies use stripControlChars; for unfenced context fields
 * (sender names, labels) use this instead.
 */
export function sanitizeForPtyInjection(input: string): string {
  return stripControlChars(input)
    .replace(/\r\n?/g, '\n')
    .replace(/`{3,}/g, '``')
    .replace(
      /^([ \t   -   　﻿]*)(={3,}\s*(?:AGENT MESSAGE|TELEGRAM)\b|Reply using:\s*cortextos\s+bus)/gim,
      '$1[quoted] $2',
    );
}
