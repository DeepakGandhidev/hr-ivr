import {
  QuotaExceededError,
  quotaState,
  approximateInterviews,
} from "@pratibha/shared";
import type { TenantTransactionClient, TenantWithPlan } from "@/lib/authz";
import { planAllowance, trialAllowance } from "@/lib/pricing";

/**
 * Limits come from the workspace's own plan version (a published price change
 * grandfathers it) or, on trial, from the live trial. Both are rows the admin
 * panel publishes; nothing here is a constant any more.
 */
type PricedTenant = Pick<TenantWithPlan, "status" | "planId"> & {
  plan?: TenantWithPlan["plan"] | null;
  trial?: TenantWithPlan["trial"];
};

export function currentUsagePeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function allowance(tenant: PricedTenant) {
  if (tenant.status === "trial") {
    const t = trialAllowance(tenant.trial ?? null);
    return { jobs: t.jobs, screenings: t.screenings, minutes: t.minutes };
  }
  return planAllowance(tenant.plan, tenant.planId);
}

export function activeJobLimit(tenant: PricedTenant): number | null {
  return allowance(tenant)?.jobs ?? null;
}

export function screeningLimit(tenant: PricedTenant): number | null {
  return allowance(tenant)?.screenings ?? null;
}

/**
 * Retained only to describe a plan in the terms customers think in. Pricing is
 * per minute — this is not a quota and nothing is enforced against it.
 */
export function interviewLimit(tenant: PricedTenant): number | null {
  const minutes = allowance(tenant)?.minutes;
  return minutes == null ? null : approximateInterviews(minutes);
}

/** The plan's minute allowance, before anything bought or granted on top. */
export function interviewMinuteLimit(tenant: PricedTenant): number | null {
  return allowance(tenant)?.minutes ?? null;
}

/**
 * Minutes and screenings bought or granted on top of the plan this period.
 * Granted by the admin panel or bought from the Subscription page, they extend
 * the ceiling rather than being a second balance, so "left" means what it says.
 */
export async function topUps(tx: TenantTransactionClient, tenantId: string) {
  const sub = await tx.subscription.findUnique({
    where: { tenantId },
    select: { topUpMinutes: true, topUpScreenings: true },
  });
  return { minutes: sub?.topUpMinutes ?? 0, screenings: sub?.topUpScreenings ?? 0 };
}

export function plusTopUp(limit: number | null, extra: number): number | null {
  return limit === null ? null : limit + extra;
}

/**
 * Where this tenant stands on minutes this period, ready for the meter and the
 * warnings. One place, so the sidebar and the warnings cannot disagree about
 * what "nearly out" means.
 */
export async function interviewMinuteQuota(
  tenant: PricedTenant & { id: string },
  tx: TenantTransactionClient
) {
  const meter = await tx.usageMeter.findUnique({
    where: { tenantId_period: { tenantId: tenant.id, period: currentUsagePeriod() } },
  });

  const used = meter?.interviewMinutesUsed ?? 0;
  const extra = await topUps(tx, tenant.id);
  const state = quotaState(used, plusTopUp(interviewMinuteLimit(tenant), extra.minutes));

  return {
    ...state,
    // Customers think in interviews and are billed in minutes, so both are
    // reported — the interview figure always as an approximation.
    approximateInterviewsRemaining:
      state.remaining === null ? null : approximateInterviews(state.remaining),
  };
}

export async function assertCanCreateJob(
  tenant: PricedTenant & { id: string },
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
  tenant: PricedTenant & { id: string },
  tx: TenantTransactionClient
): Promise<void> {
  const planLimit = screeningLimit(tenant);
  if (planLimit === null) return;
  const limit = planLimit + (await topUps(tx, tenant.id)).screenings;

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
