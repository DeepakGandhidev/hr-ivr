/**
 * A value saved in the admin panel's Platform settings, else `fallback`.
 *
 * Reads the settings runtime's shared cache (the `__pratibhaSettings` object
 * settingsRuntime keeps on globalThis) instead of importing the runtime: this
 * module sits in the package barrel, which client components import, and the
 * runtime pulls in node:crypto to open sealed secrets. In the browser, in the
 * admin app and in tests that never start the runtime there is no cache, so the
 * constant passed as `fallback` applies - which is also the registry default.
 *
 * Only for keys with no `env` in the registry: for those, panel-or-default is
 * the whole precedence. Values in the cache were validated (type and bounds)
 * when the runtime loaded them. Call it at the moment of use, never into a
 * module-level constant, so a change in the panel is picked up.
 */
export function savedSetting<T>(key: string, fallback: T): T {
  const saved = (globalThis as { __pratibhaSettings?: { saved?: Map<string, unknown> } }).__pratibhaSettings?.saved;
  return typeof saved?.has === 'function' && saved.has(key) ? (saved.get(key) as T) : fallback;
}

/**
 * Typical interview length, in minutes.
 *
 * The default on InterviewSettings, and the divisor behind "roughly N
 * interviews left". Customers think in interviews and are billed in minutes, so
 * this converts between the two - it is an estimate shown as one, never the
 * thing charged for.
 */
export const AVERAGE_INTERVIEW_MINUTES = 10;

/** AVERAGE_INTERVIEW_MINUTES, as set in the admin panel (billing.average_interview_minutes). */
export function averageInterviewMinutes(): number {
  return savedSetting('billing.average_interview_minutes', AVERAGE_INTERVIEW_MINUTES);
}

/**
 * Plans.
 *
 * `interviewMinutes` is the quota that is actually enforced and billed;
 * `interviews` is kept only to describe the plan in roughly the terms customers
 * think in. The minute figures are each plan's interview allowance at the
 * default interview length - a derivation, not a pricing decision, and the
 * numbers are here to be replaced with the real ones.
 */
export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceInr: 4999,
    limits: { roles: 2, interviews: 15, interviewMinutes: 150, screenings: 100 },
    features: {},
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceInr: 12999,
    limits: { roles: 6, interviews: 60, interviewMinutes: 600, screenings: 400 },
    features: { portalAutoPosting: true, protocolTuning: true },
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    priceInr: 29999,
    limits: { roles: null, interviews: 200, interviewMinutes: 2000, screenings: 1500 },
    features: { portalAutoPosting: true, protocolTuning: true, dedicatedDid: true, apiAccess: true },
  },
} as const;

/** Fractions of quota at which the customer is warned. */
export const QUOTA_WARNING_THRESHOLDS = [0.8, 1] as const;

/**
 * QUOTA_WARNING_THRESHOLDS with the first one from the admin panel
 * (billing.quota_warning_percent, 10-99). Exhausted is always 100%.
 */
export function quotaWarningThresholds(): readonly [number, 1] {
  const percent = savedSetting<number | null>('billing.quota_warning_percent', null);
  return [percent === null ? QUOTA_WARNING_THRESHOLDS[0] : percent / 100, 1];
}

export const TRIAL_DAYS = 15;

export const TRIAL_LIMITS = {
  jobs: 1,
  interviews: 5,
  interviewMinutes: 50,
  screenings: 25,
} as const;

export const OVERAGE_RATES = {
  /// Retained for historical invoices; interviews are no longer the billed unit.
  interviewInr: 149,
  interviewMinuteInr: 15,
  screeningInr: 5,
} as const;

export const DEFAULT_SCREENING_THRESHOLD = 70;

export const SUPPORTED_LANGUAGES = ['en', 'hi', 'hinglish'] as const;
