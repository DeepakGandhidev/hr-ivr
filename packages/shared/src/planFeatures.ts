/**
 * What a plan includes: the catalogue of plan features and plan limits.
 *
 * Edited per plan in the admin panel (Plans and pricing) and published with
 * the plan's price, as part of the same versioned plan row. Feature switches
 * are saved in `plans.features` and limits in `plans.limits`, each under the
 * catalogue key below. Three limits are the plan's own columns (open jobs,
 * interview minutes, CV screenings) and are edited there, not in the JSON.
 *
 * Backward compatibility is the rule that shapes this file: a plan row saved
 * before this catalogue existed has none of these keys, and must behave
 * exactly as it did. So an unset key falls back to:
 *   - for a feature with a `legacyGate`, the platform setting that gated it
 *     before (gate.portal_posts, gate.interview_tuning);
 *   - for anything else, the default below for the plan's tier, which for
 *     every enforced entry is what the portal already did - on, or unlimited.
 *
 * `enforced: false` marks entries the product does not yet check anywhere.
 * They are switches for the pricing page and Saarthi to describe, and the
 * admin panel says so beside them rather than implying they do something.
 *
 * Dependency free (the admin panel's client component imports it).
 */

export const PLAN_TIERS = ['starter', 'growth', 'scale'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface PlanFeatureDef {
  key: string;
  label: string;
  help: string;
  /** Used when a plan row has no saved value for this key. */
  defaults: Record<PlanTier, boolean>;
  /** False when nothing in the product checks it yet: display only. */
  enforced: boolean;
  /**
   * The platform setting that gated this before plans could. While a plan has
   * no saved value, that gate still decides, so existing plans are unchanged.
   */
  legacyGate?: 'gate.portal_posts' | 'gate.interview_tuning';
}

export interface PlanLimitDef {
  key: string;
  label: string;
  /** Plural noun for the number, e.g. "members". */
  unit: string;
  help: string;
  /** Used when a plan row has no saved value. Null means unlimited. */
  defaults: Record<PlanTier, number | null>;
  enforced: boolean;
  /**
   * Stored in this plan column rather than in plans.limits. The column always
   * has a value, so `defaults` is only what a new plan would start from.
   */
  column?: 'jobLimit' | 'minutes' | 'screenings';
}

const all = (on: boolean): Record<PlanTier, boolean> => ({ starter: on, growth: on, scale: on });
const unlimited: Record<PlanTier, number | null> = { starter: null, growth: null, scale: null };

export const PLAN_FEATURES = [
  {
    key: 'portal_posts',
    label: 'Job portal posts (Naukri, LinkedIn)',
    help: 'Copy a formatted post for Naukri and LinkedIn from the Publish tab.',
    defaults: all(true),
    enforced: true,
    legacyGate: 'gate.portal_posts',
  },
  {
    key: 'interview_tuning',
    label: 'Interview style tuning',
    help: 'Screeners, salary policy, difficulty, focus areas and instructions. Length and question counts are on every plan.',
    defaults: all(true),
    enforced: true,
    legacyGate: 'gate.interview_tuning',
  },
  {
    key: 'custom_questions',
    label: 'Custom interview questions',
    help: 'Questions of the company’s own that every candidate is asked.',
    defaults: all(true),
    enforced: true,
  },
  {
    key: 'auto_route_mailboxes',
    label: 'Auto routing from mailboxes',
    help: 'A connected mailbox files each application into the job it matches, not one fixed job.',
    defaults: all(true),
    enforced: true,
  },
  {
    key: 'email_forwarding',
    label: 'Email forwarding address',
    help: 'Connect by forwarding applications to a Pratibha address instead of signing in.',
    defaults: all(true),
    enforced: true,
  },
  {
    key: 'gmail_outlook_signin',
    label: 'Gmail and Outlook sign in',
    help: 'Connect a mailbox with Sign in with Google or Microsoft.',
    defaults: all(true),
    enforced: true,
  },
  {
    key: 'dedicated_number',
    label: 'Dedicated calling number',
    help: 'Interviews ring from a number of the workspace’s own.',
    defaults: { starter: false, growth: false, scale: true },
    enforced: false,
  },
  {
    key: 'api_access',
    label: 'API access',
    help: 'Programmatic access to jobs and candidates.',
    defaults: { starter: false, growth: false, scale: true },
    enforced: false,
  },
  {
    key: 'white_label_emails',
    label: 'Emails sent in the company’s name',
    help: 'On: candidates see "<Company> via Pratibha" as the sender. Off: just the product name.',
    defaults: all(true),
    enforced: true,
  },
  {
    key: 'priority_support',
    label: 'Priority support',
    help: 'Faster replies from the support team.',
    defaults: { starter: false, growth: false, scale: true },
    enforced: false,
  },
] as const satisfies readonly PlanFeatureDef[];

export const PLAN_LIMITS = [
  {
    key: 'jobs',
    label: 'Open jobs',
    unit: 'open jobs',
    help: 'Jobs open or paused at once.',
    defaults: { starter: 2, growth: 6, scale: null },
    enforced: true,
    column: 'jobLimit',
  },
  {
    key: 'interview_minutes',
    label: 'Interview minutes',
    unit: 'minutes a month',
    help: 'Billed interview minutes each month, before top ups.',
    defaults: { starter: 150, growth: 600, scale: 2000 },
    enforced: true,
    column: 'minutes',
  },
  {
    key: 'screenings',
    label: 'CV screenings',
    unit: 'screenings a month',
    help: 'CV screenings each month, before top ups.',
    defaults: { starter: 100, growth: 400, scale: 1500 },
    enforced: true,
    column: 'screenings',
  },
  {
    key: 'members',
    label: 'Team members',
    unit: 'members',
    help: 'People in the workspace, the owner included.',
    defaults: unlimited,
    enforced: true,
  },
  {
    key: 'mailboxes',
    label: 'Connected mailboxes',
    unit: 'mailboxes',
    help: 'Mailboxes and forwarding addresses, paused ones included.',
    defaults: unlimited,
    enforced: true,
  },
  {
    key: 'custom_questions_per_job',
    label: 'Custom questions per interview',
    unit: 'questions',
    help: 'Also capped by the platform-wide maximum in Platform settings.',
    defaults: unlimited,
    enforced: true,
  },
  {
    key: 'cv_uploads_per_month',
    label: 'CV uploads a month',
    unit: 'CVs a month',
    help: 'CVs added by upload in the portal each calendar month. Mailbox arrivals are not counted.',
    defaults: unlimited,
    enforced: true,
  },
] as const satisfies readonly PlanLimitDef[];

export type PlanFeatureKey = (typeof PLAN_FEATURES)[number]['key'];
export type PlanLimitKey = (typeof PLAN_LIMITS)[number]['key'];
/** Limits saved in plans.limits, not in a column of their own. */
export type PlanJsonLimitKey = Exclude<PlanLimitKey, 'jobs' | 'interview_minutes' | 'screenings'>;

export const PLAN_FEATURE_KEYS = PLAN_FEATURES.map((f) => f.key) as PlanFeatureKey[];
export const PLAN_LIMIT_KEYS = PLAN_LIMITS.map((l) => l.key) as PlanLimitKey[];
export const PLAN_JSON_LIMIT_KEYS = PLAN_LIMITS.filter((l) => !('column' in l)).map((l) => l.key) as PlanJsonLimitKey[];

export function planFeatureDef(key: PlanFeatureKey): PlanFeatureDef {
  return PLAN_FEATURES.find((f) => f.key === key)!;
}

export function planLimitDef(key: PlanLimitKey): PlanLimitDef {
  return PLAN_LIMITS.find((l) => l.key === key)!;
}

/** A plan key as a tier; an unknown key is treated as the lowest tier. */
export function planTier(planKey: string | null | undefined): PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(planKey ?? '') ? (planKey as PlanTier) : 'starter';
}

export function planFeatureDefault(key: PlanFeatureKey, planKey: string | null | undefined): boolean {
  return planFeatureDef(key).defaults[planTier(planKey)];
}

export function planLimitDefault(key: PlanLimitKey, planKey: string | null | undefined): number | null {
  return planLimitDef(key).defaults[planTier(planKey)];
}

const asRecord = (json: unknown): Record<string, unknown> =>
  json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};

/** The feature switches a plan row has saved. A key that is absent is unset. */
export function savedPlanFeatures(featuresJson: unknown): Partial<Record<PlanFeatureKey, boolean>> {
  const f = asRecord(featuresJson);
  const out: Partial<Record<PlanFeatureKey, boolean>> = {};
  for (const key of PLAN_FEATURE_KEYS) if (typeof f[key] === 'boolean') out[key] = f[key] as boolean;
  return out;
}

/**
 * The JSON-backed limits a plan row has saved: a whole number, or null for
 * unlimited. A key that is absent (or holds anything else) is unset.
 */
export function savedPlanLimits(limitsJson: unknown): Partial<Record<PlanJsonLimitKey, number | null>> {
  const l = asRecord(limitsJson);
  const out: Partial<Record<PlanJsonLimitKey, number | null>> = {};
  for (const key of PLAN_JSON_LIMIT_KEYS) {
    if (!(key in l)) continue;
    const v = l[key];
    if (v === null) out[key] = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[key] = v;
  }
  return out;
}

/**
 * Whether a plan row includes a feature, before any legacy gate is consulted.
 * Returns undefined for an unset gated feature: the caller's gate decides.
 */
export function planFeatureFromRow(
  plan: { key: string; features: unknown } | null | undefined,
  key: PlanFeatureKey
): boolean | undefined {
  const saved = savedPlanFeatures(plan?.features)[key];
  if (saved !== undefined) return saved;
  if (planFeatureDef(key).legacyGate) return undefined;
  return planFeatureDefault(key, plan?.key);
}

/** A JSON-backed limit for a plan row: saved value, else the tier default. */
export function planJsonLimitFromRow(
  plan: { key: string; limits: unknown } | null | undefined,
  key: PlanJsonLimitKey
): number | null {
  const saved = savedPlanLimits(plan?.limits);
  return key in saved ? (saved[key] as number | null) : planLimitDefault(key, plan?.key);
}

/**
 * Check what an admin submits: only catalogue keys, booleans for features,
 * whole numbers from zero (or null) for limits. Returns an error message, or
 * null when the input is valid.
 */
export function planEntitlementsError(input: {
  features?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}): string | null {
  for (const [k, v] of Object.entries(input.features ?? {})) {
    if (!(PLAN_FEATURE_KEYS as string[]).includes(k)) return `Unknown plan feature: ${k}.`;
    if (typeof v !== 'boolean') return `${planFeatureDef(k as PlanFeatureKey).label} must be on or off.`;
  }
  for (const [k, v] of Object.entries(input.limits ?? {})) {
    if (!(PLAN_JSON_LIMIT_KEYS as string[]).includes(k)) return `Unknown plan limit: ${k}.`;
    if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000)) {
      return `${planLimitDef(k as PlanLimitKey).label} must be a whole number, or Unlimited.`;
    }
  }
  return null;
}
