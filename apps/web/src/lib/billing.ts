import {
  PLANS,
  TRIAL_LIMITS,
  QuotaExceededError,
  quotaState,
  approximateInterviews,
} from "@pratibha/shared";
import type { Tenant } from "@pratibha/prisma";
import type { TenantTransactionClient } from "@/lib/authz";


export function currentUsagePeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function activeJobLimit(tenant: Tenant): number | null {
  if (tenant.status === "trial") {
    return TRIAL_LIMITS.jobs;
  }
  const plan = PLANS[tenant.planId as keyof typeof PLANS];
  if (!plan) return null;
  return plan.limits.roles;
}

export function screeningLimit(tenant: Tenant): number | null {
  if (tenant.status === "trial") {
    return TRIAL_LIMITS.screenings;
  }
  const plan = PLANS[tenant.planId as keyof typeof PLANS];
  if (!plan) return null;
  return plan.limits.screenings;
}

/**
 * Retained only to describe a plan in the terms customers think in. Pricing is
 * per minute — this is not a quota and nothing is enforced against it.
 */
export function interviewLimit(tenant: Tenant): number | null {
  if (tenant.status === "trial") {
    return TRIAL_LIMITS.interviews;
  }
  const plan = PLANS[tenant.planId as keyof typeof PLANS];
  if (!plan) return null;
  return plan.limits.interviews;
}

/** The quota that is actually enforced and billed. */
export function interviewMinuteLimit(tenant: Tenant): number | null {
  if (tenant.status === "trial") {
    return TRIAL_LIMITS.interviewMinutes;
  }
  const plan = PLANS[tenant.planId as keyof typeof PLANS];
  if (!plan) return null;
  return plan.limits.interviewMinutes;
}

/**
 * Where this tenant stands on minutes this period, ready for the meter and the
 * warnings. One place, so the sidebar and the warnings cannot disagree about
 * what "nearly out" means.
 */
export async function interviewMinuteQuota(
  tenant: Tenant,
  tx: TenantTransactionClient
) {
  const meter = await tx.usageMeter.findUnique({
    where: { tenantId_period: { tenantId: tenant.id, period: currentUsagePeriod() } },
  });

  const used = meter?.interviewMinutesUsed ?? 0;
  const state = quotaState(used, interviewMinuteLimit(tenant));

  return {
    ...state,
    // Customers think in interviews and are billed in minutes, so both are
    // reported — the interview figure always as an approximation.
    approximateInterviewsRemaining:
      state.remaining === null ? null : approximateInterviews(state.remaining),
  };
}

export async function assertCanCreateJob(
  tenant: Tenant,
  tx: TenantTransactionClient
): Promise<void> {
  const limit = activeJobLimit(tenant);
  if (limit === null) return;

  const activeCount = await tx.job.count({
    where: {
      tenantId: tenant.id,
      status: { in: ["open", "paused"] as any },
    },
  });

  if (activeCount >= limit) {
    throw new QuotaExceededError(
      `Active role limit reached (${activeCount}/${limit}). Upgrade your plan to post more jobs.`
    );
  }
}

export async function assertScreeningQuota(
  tenant: Tenant,
  tx: TenantTransactionClient
): Promise<void> {
  const limit = screeningLimit(tenant);
  if (limit === null) return;

  const meter = await tx.usageMeter.findUnique({
    where: { tenantId_period: { tenantId: tenant.id, period: currentUsagePeriod() } },
  });

  const used = meter?.screeningsUsed ?? 0;
  if (used >= limit) {
    throw new QuotaExceededError(
      `Screening quota exceeded (${used}/${limit}). Upgrade your plan or wait for the next billing period.`
    );
  }
}

/**
 * These take the tenant-scoped client rather than reaching for a module-level
 * one. Under RLS an unscoped write here does not error — it silently affects no
 * rows, which on a metering path means usage quietly stops being counted.
 */
export async function getOrCreateUsageMeter(
  tx: TenantTransactionClient,
  tenantId: string,
  period: string
) {
  const existing = await tx.usageMeter.findUnique({
    where: { tenantId_period: { tenantId, period } },
  });
  if (existing) return existing;
  return tx.usageMeter.create({
    data: { tenantId, period },
  });
}

export async function incrementScreeningUsage(
  tx: TenantTransactionClient,
  tenantId: string,
  limit: number | null
) {
  const period = currentUsagePeriod();
  const meter = await getOrCreateUsageMeter(tx, tenantId, period);
  const remaining = limit !== null ? Math.max(0, limit - meter.screeningsUsed) : 1;
  const overage = remaining === 0;

  const updated = await tx.usageMeter.update({
    where: { id: meter.id },
    data: overage
      ? { overageScreenings: { increment: 1 } }
      : { screeningsUsed: { increment: 1 } },
  });

  return { ok: true, overage, meter: updated };
}

/**
 * Record a billed call: minutes against the quota, plus the interview count.
 *
 * Minutes past the ceiling land in `overageMinutes` rather than inflating the
 * used figure, so "412 of 650" never reads as more than the plan allows while
 * still charging for what was actually consumed.
 *
 * The interview count is incremented either way — it describes what happened,
 * not what was charged.
 */
export async function incrementInterviewUsage(
  tx: TenantTransactionClient,
  tenantId: string,
  limit: number | null,
  minutes = 1
) {
  const period = currentUsagePeriod();
  const meter = await getOrCreateUsageMeter(tx, tenantId, period);
  const billed = Math.max(0, Math.round(minutes));

  const room = limit !== null ? Math.max(0, limit - meter.interviewMinutesUsed) : billed;
  const withinQuota = Math.min(billed, room);
  const overageMinutes = billed - withinQuota;

  const updated = await tx.usageMeter.update({
    where: { id: meter.id },
    data: {
      interviewsUsed: { increment: 1 },
      ...(withinQuota > 0 && { interviewMinutesUsed: { increment: withinQuota } }),
      ...(overageMinutes > 0 && { overageMinutes: { increment: overageMinutes } }),
    },
  });

  return { ok: true, overage: overageMinutes > 0, overageMinutes, meter: updated };
}
