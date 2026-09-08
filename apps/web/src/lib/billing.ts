import { PLANS, TRIAL_LIMITS, QuotaExceededError } from "@pratibha/shared";
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

export function interviewLimit(tenant: Tenant): number | null {
  if (tenant.status === "trial") {
    return TRIAL_LIMITS.interviews;
  }
  const plan = PLANS[tenant.planId as keyof typeof PLANS];
  if (!plan) return null;
  return plan.limits.interviews;
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

export async function incrementInterviewUsage(
  tx: TenantTransactionClient,
  tenantId: string,
  limit: number | null
) {
  const period = currentUsagePeriod();
  const meter = await getOrCreateUsageMeter(tx, tenantId, period);
  const remaining = limit !== null ? Math.max(0, limit - meter.interviewsUsed) : 1;
  const overage = remaining === 0;

  const updated = await tx.usageMeter.update({
    where: { id: meter.id },
    data: overage
      ? { overageInterviews: { increment: 1 } }
      : { interviewsUsed: { increment: 1 } },
  });

  return { ok: true, overage, meter: updated };
}
