import { approximateInterviews, quotaState } from "@pratibha/shared";
import type { TenantTransactionClient, TenantWithPlan } from "@/lib/authz";
import { currentUsagePeriod, interviewMinuteLimit } from "@/lib/billing";
import { livePacks, trialAllowance } from "@/lib/pricing";
import type { Plan, Tenant } from "@pratibha/prisma";

/**
 * A plan row as the Subscription page reads it. `limits` keeps the shape the
 * page has always used; `slashedPriceInr` is display only and is never what is
 * charged.
 */
export function planView(plan: Plan) {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    version: plan.version,
    priceInr: plan.priceInr,
    slashedPriceInr: plan.slashedPriceInr,
    limits: {
      roles: plan.jobLimit,
      interviews: approximateInterviews(plan.minutes),
      interviewMinutes: plan.minutes,
      screenings: plan.screenings,
    },
  };
}

/**
 * The subscription row, created on first sight.
 *
 * Tenants predate this table, so it is made on demand rather than backfilled
 * with invented dates: a period that never actually started would show a
 * "days left" figure nobody can reconcile with what they paid.
 *
 * The first period is anchored to the trial end where there is one, and to
 * today otherwise — the honest answer for a tenant whose billing began before
 * anyone was recording it.
 */
export async function getOrCreateSubscription(tx: TenantTransactionClient, tenant: Tenant) {
  const existing = await tx.subscription.findUnique({ where: { tenantId: tenant.id } });
  if (existing) return existing;

  const now = new Date();
  const periodStart = tenant.trialEndsAt && tenant.trialEndsAt > now ? now : now;
  const periodEnd = new Date(periodStart);

  if (tenant.status === "trial" && tenant.trialEndsAt) {
    periodEnd.setTime(tenant.trialEndsAt.getTime());
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  return tx.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: tenant.planId,
      status: tenant.status === "trial" ? "trialing" : "active",
      periodStart,
      periodEnd,
    },
  });
}

/** Whole days remaining in the cycle, never negative. */
export function daysRemaining(periodEnd: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000));
}

/**
 * Everything the subscriptions page leads with.
 *
 * Assembled in one place because the meter, the warnings and the enforcement
 * points must agree; the page showing one number while a call is refused on
 * another is exactly the surprise this section exists to prevent.
 *
 * Top-up minutes extend the ceiling rather than being counted separately, so
 * "left" means what it says — a customer who bought more minutes should see
 * more minutes, not a second balance to add up themselves.
 */
export async function subscriptionOverview(
  tx: TenantTransactionClient,
  tenant: TenantWithPlan
) {
  const subscription = await getOrCreateSubscription(tx, tenant);

  const meter = await tx.usageMeter.findUnique({
    where: { tenantId_period: { tenantId: tenant.id, period: currentUsagePeriod() } },
  });

  const planLimit = interviewMinuteLimit(tenant);
  const limit = planLimit === null ? null : planLimit + subscription.topUpMinutes;
  const used = meter?.interviewMinutesUsed ?? 0;
  const state = quotaState(used, limit);

  return {
    subscription,
    // The workspace's own plan version, which a later price change does not move.
    plan: tenant.plan ? planView(tenant.plan) : null,
    minutes: {
      ...state,
      planMinutes: planLimit,
      topUpMinutes: subscription.topUpMinutes,
      approximateInterviewsRemaining:
        state.remaining === null ? null : approximateInterviews(state.remaining),
    },
    screeningsUsed: meter?.screeningsUsed ?? 0,
    overageMinutes: meter?.overageMinutes ?? 0,
    daysRemaining: daysRemaining(subscription.periodEnd),
    trialDays: trialAllowance(tenant.trial).days,
  };
}

/**
 * What changes if they move to another plan.
 *
 * Shown before the change is made, because "clear upgrade and downgrade options
 * showing what changes" is the requirement, and because a downgrade can take a
 * customer below what they have already used this period. That case is called
 * out rather than discovered at the next failed interview.
 */
export function planComparison(currentPlan: Plan | null, targetPlan: Plan | null, minutesUsed: number) {
  if (!targetPlan) return null;
  const current = currentPlan ? planView(currentPlan) : null;
  const target = planView(targetPlan);

  const direction =
    !current || target.priceInr > current.priceInr
      ? "upgrade"
      : target.priceInr < current.priceInr
        ? "downgrade"
        : "same";

  return {
    direction,
    target,
    current,
    changes: {
      minutes: target.limits.interviewMinutes - (current?.limits.interviewMinutes ?? 0),
      screenings: target.limits.screenings - (current?.limits.screenings ?? 0),
      roles:
        target.limits.roles === null
          ? "unlimited"
          : target.limits.roles - (current?.limits.roles ?? 0),
    },
    // The honest warning: their new ceiling is already behind them.
    alreadyOverTarget: minutesUsed > target.limits.interviewMinutes,
    minutesUsed,
  };
}

/**
 * Top up packs on sale, as published in the admin panel. The Subscription
 * page offers exactly these, so its offers cannot drift from the packs table.
 */
export async function topUpPacks(tx: TenantTransactionClient) {
  const packs = await livePacks(tx);
  return packs.map((p) => ({
    id: p.id,
    kind: p.kind,
    quantity: p.quantity,
    // Kept for the page's minute packs, which predate screening packs.
    minutes: p.kind === "minutes" ? p.quantity : 0,
    pricePaise: p.priceInr * 100,
    validityDays: p.validityDays,
  }));
}

/**
 * The reasons offered on the way out.
 *
 * A closed list plus free text, because the point of capturing this is to count
 * it later — free text alone produces a pile nobody reads, and a list alone
 * loses the one answer that would have been worth hearing.
 */
export const CANCEL_REASONS = [
  { key: "too_expensive", label: "Too expensive" },
  { key: "not_enough_hiring", label: "Not hiring enough to justify it" },
  { key: "missing_features", label: "Missing features we need" },
  { key: "quality", label: "Interview quality did not meet our bar" },
  { key: "switched", label: "Moved to another product" },
  { key: "other", label: "Something else" },
] as const;

/** What happens to their data. One place, so every surface agrees. */
export const DATA_CONSEQUENCES = {
  readOnlyAfterExpiry: true,
  deletedAfterDays: 30,
};

/**
 * Which billing emails the finance contact receives.
 *
 * A closed list, so a preference cannot be stored under a key nothing reads.
 */
export const BILLING_EMAIL_TYPES = [
  { key: "invoice_issued", label: "New invoices", description: "Every invoice as it is raised." },
  { key: "payment_failed", label: "Failed payments", description: "When a charge does not go through." },
  { key: "quota_warning", label: "Quota warnings", description: "When interview minutes run low." },
  { key: "plan_changed", label: "Plan changes", description: "When the subscription changes." },
] as const;
