/**
 * Attempts per key in a sliding window, in memory.
 *
 * The admin app runs as one process, so memory is the whole picture; a restart
 * forgives everyone, which is acceptable for a brake on guessing rather than a
 * lockout policy.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

export function tooManyAttempts(key: string, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) return false;
  return b.count >= MAX_ATTEMPTS;
}

export function noteFailedAttempt(key: string, now = Date.now()) {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    b.count += 1;
  }
}

export function clearAttempts(key: string) {
  buckets.delete(key);
}
