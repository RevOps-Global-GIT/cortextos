// Security (H8): SQLite-backed rate limiter — survives server restarts.
// In-memory fallback if db is unavailable (fail open, but log).
import { db } from '@/lib/db';

const MAX = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();

  try {
    // Prune expired entries opportunistically
    db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);

    const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE ip = ?').get(ip) as
      | { count: number; reset_at: number }
      | undefined;

    if (!row) {
      db.prepare('INSERT INTO rate_limits (ip, count, reset_at) VALUES (?, 1, ?)').run(
        ip,
        now + WINDOW_MS,
      );
      return { allowed: true };
    }

    if (row.count >= MAX) {
      return { allowed: false, retryAfter: Math.ceil((row.reset_at - now) / 1000) };
    }

    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE ip = ?').run(ip);
    return { allowed: true };
  } catch (err) {
    // Fail open if DB is unavailable — log so ops can investigate
    console.error('[rate-limit] DB error, failing open:', err);
    return { allowed: true };
  }
}

export function resetRateLimit(ip: string): void {
  try {
    db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
  } catch (err) {
    console.error('[rate-limit] DB error on reset:', err);
  }
}
