/**
 * The emails a person can choose to receive.
 *
 * A closed list, because the preference is stored as `{ key: boolean }` and an
 * unknown key would be a preference nobody can ever turn back on.
 *
 * Absent keys mean ON. A notification type added later should reach people
 * rather than arrive silently disabled for everyone who has ever saved a
 * preference — that failure is invisible, and the first anyone learns of it is
 * a customer saying they never got told.
 */
export const NOTIFICATION_TYPES = [
  {
    key: 'shortlist_ready',
    label: 'Shortlist ready',
    description: 'When candidates have been screened and are waiting for your review.',
  },
  {
    key: 'report_ready',
    label: 'Interview report ready',
    description: 'When Pratibha has finished an interview and the assessment is written.',
  },
  {
    key: 'quota_warning',
    label: 'Quota warnings',
    description: 'When your interview minutes are running low, and when they run out.',
  },
  {
    key: 'weekly_summary',
    label: 'Weekly summary',
    description: 'A Monday digest of the week just gone.',
  },
] as const;

export type NotificationKey = (typeof NOTIFICATION_TYPES)[number]['key'];

export const NOTIFICATION_KEYS = NOTIFICATION_TYPES.map((n) => n.key) as NotificationKey[];

/**
 * Whether this person should get this email.
 *
 * Defaults to true for anything not explicitly switched off, which is what
 * makes a newly added notification type reach existing users.
 */
export function wantsNotification(prefs: unknown, key: NotificationKey): boolean {
  if (!prefs || typeof prefs !== 'object') return true;
  const value = (prefs as Record<string, unknown>)[key];
  return value === undefined ? true : value !== false;
}

/** Keep only known keys, so the stored object cannot accumulate junk. */
export function sanitiseNotificationPrefs(input: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!input || typeof input !== 'object') return out;

  for (const key of NOTIFICATION_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * Common IANA timezones, India first.
 *
 * A short list rather than all ~600 zones: this is a dropdown a recruiter uses
 * once, and the full list is harder to find your own city in, not easier.
 * "Other" is not offered because an unknown zone would break date rendering
 * everywhere it is used.
 */
export const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
] as const;

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
