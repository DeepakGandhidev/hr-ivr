import {
  ForbiddenError,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  QuotaExceededError,
  planFeatureDef,
  planFeatureFromRow,
  planJsonLimitFromRow,
  planLimitDef,
  type PlanFeatureKey,
  type PlanJsonLimitKey,
  type PlanLimitKey,
} from "@pratibha/shared";
import type { Plan, TrialConfig } from "@pratibha/prisma";
import { activeJobLimit, interviewMinuteLimit, screeningLimit } from "@/lib/billing";
import { legacyGateAllows } from "@/lib/platform-settings";

/**
 * What the workspace's plan includes, as the admin panel publishes it.
 *
 * Read from the exact plan version the workspace is on (a change publishes a
 * new version, and existing workspaces stay on theirs) and, while on trial,
 * from the live trial for the three allowances the trial row has (open jobs,
 * minutes, screenings). Everything else on trial comes from the plan row the
 * workspace signed up on, as the gates always did: the trial row has no
 * features of its own.
 *
 * A plan saved before features were editable has none of the catalogue keys,
 * and behaves exactly as before: portal posts and interview tuning follow the
 * gate.* platform settings, everything else is on and unlimited.
 */
export type PlanTenant = {
  status: string;
  planId: string;
  plan?: (Pick<Plan, "key" | "features" | "limits"> & Partial<Pick<Plan, "minutes" | "screenings" | "jobLimit">>) | null;
  trial?: TrialConfig | null;
};

export function planAllows(tenant: PlanTenant, feature: PlanFeatureKey): boolean {
  const fromRow = planFeatureFromRow(tenant.plan ? { key: tenant.plan.key, features: tenant.plan.features } : null, feature);
  if (fromRow !== undefined) return fromRow;
  const gate = planFeatureDef(feature).legacyGate!;
  return legacyGateAllows(gate, tenant.plan, tenant.planId);
}

/** The plan's limit; null means unlimited. Top ups are not included. */
export function planLimit(tenant: PlanTenant, limit: PlanLimitKey): number | null {
  // The column-backed limits keep their existing readers, which already know
  // about the trial.
  const priced = tenant as unknown as Parameters<typeof activeJobLimit>[0];
  if (limit === "jobs") return activeJobLimit(priced);
  if (limit === "interview_minutes") return interviewMinuteLimit(priced);
  if (limit === "screenings") return screeningLimit(priced);
  return planJsonLimitFromRow(
    tenant.plan ? { key: tenant.plan.key, limits: tenant.plan.limits } : null,
    limit as PlanJsonLimitKey
  );
}

/** Everything at once, for an API response the UI can show. */
export function planEntitlements(tenant: PlanTenant) {
  return {
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, planAllows(tenant, k)])) as Record<PlanFeatureKey, boolean>,
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, planLimit(tenant, k)])) as Record<PlanLimitKey, number | null>,
  };
}

/** Refuse (403) when the plan does not include a feature. */
export function assertPlanAllows(tenant: PlanTenant, feature: PlanFeatureKey, message?: string): void {
  if (planAllows(tenant, feature)) return;
  throw new ForbiddenError(message ?? `${planFeatureDef(feature).label} is not included in your plan. Upgrade your plan to use it.`);
}

/**
 * Refuse (402) when adding `adding` more would take `used` past the plan's
 * limit. An unlimited plan never refuses.
 */
export function assertWithinPlanLimit(
  tenant: PlanTenant,
  limit: PlanLimitKey,
  used: number,
  adding = 1,
  message?: (limit: number, used: number) => string
): void {
  const max = planLimit(tenant, limit);
  if (max === null || used + adding <= max) return;
  const def = planLimitDef(limit);
  throw new QuotaExceededError(
    message
      ? message(max, used)
      : `Your plan allows ${max} ${def.unit} (${used} in use). Upgrade your plan to add more.`
  );
}

/** Start of the calendar month, the period cv_uploads_per_month counts in. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
