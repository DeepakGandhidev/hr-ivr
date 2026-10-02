import type { AdminUser, Payment, Prisma } from "@pratibha/prisma";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, notFound } from "@/lib/http";
import { ensureSubscription, recordPayment, METHOD_LABEL } from "@/lib/ledger";
import { redeemOnPayment } from "@/lib/coupons";
import { getSettings } from "@/lib/settings";
import { inrPaise } from "@/lib/format";
import { addPack } from "@/lib/workspace-actions";
import { usagePeriod } from "@/lib/workspaces";

/**
 * The manual-era ledger, as the Payments page drives it. Until a gateway
 * exists, an admin records each charge here, and each captured one gets its
 * invoice; a failed one puts the workspace past due until a charge lands.
 */

export type PaymentFilter = "all" | "captured" | "failed" | "refunded";

export function paymentWhere(opts: { q?: string; filter: PaymentFilter; workspace?: string }): Prisma.PaymentWhereInput {
  const and: Prisma.PaymentWhereInput[] = [];
  if (opts.workspace) and.push({ tenantId: opts.workspace });
  const q = opts.q?.trim();
  if (q) {
    and.push({
      OR: [
        { tenant: { name: { contains: q, mode: "insensitive" } } },
        { invoice: { number: { contains: q, mode: "insensitive" } } },
        { reference: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (opts.filter === "captured") and.push({ status: "captured" });
  if (opts.filter === "failed") and.push({ status: { in: ["failed", "scheduled_retry"] } });
  if (opts.filter === "refunded") and.push({ status: "refunded" });
  return and.length ? { AND: and } : {};
}

export async function paymentCounts(opts: { q?: string; workspace?: string }) {
  const base = paymentWhere({ ...opts, filter: "all" });
  const grouped = await db.payment.groupBy({ by: ["status"], where: base, _count: { _all: true } });
  const by = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  return {
    all: grouped.reduce((n, g) => n + g._count._all, 0),
    captured: by("captured"),
    failed: by("failed") + by("scheduled_retry"),
    refunded: by("refunded"),
  };
}

export interface RecordInput {
  workspaceId: string;
  kind: "subscription" | "top_up";
  status: "captured" | "failed";
  /** Rupees before GST and before any coupon. Defaults to the workspace's own plan price. */
  amountInr?: number | null;
  method: string;
  reference?: string | null;
  couponCode?: string | null;
  packId?: string | null;
  description?: string | null;
  paidOn?: string | null;
  retryOn?: string | null;
  reason?: string | null;
}

const istDate = (d: string | null | undefined) =>
  d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00+05:30` : d) : undefined;

/**
 * Record a charge. A subscription charge defaults to the workspace's own plan
 * version price, so a grandfathered workspace renews at its old price unless
 * an admin deliberately types something else.
 */
export async function recordManualPayment(admin: AdminUser, input: RecordInput) {
  if (input.kind === "top_up") {
    if (input.status === "failed") throw badRequest("A failed top up has nothing to record; record it when it is paid.");
    if (!input.packId) throw badRequest("Choose the pack they paid for.");
    if (input.couponCode) throw badRequest("Coupons apply to subscription charges, not packs.");
    return addPack(admin, input.workspaceId, {
      packId: input.packId,
      method: input.method,
      reference: input.reference ?? undefined,
      reason: input.reason ?? "Recorded from Payments",
    });
  }

  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: input.workspaceId }, include: { plan: true } });
    if (!tenant || tenant.status === "deleted") throw notFound("That workspace does not exist.");
    if (tenant.status === "trial") throw conflict(`${tenant.name} is on the trial. Change its plan first, then record the charge.`);
    if (tenant.status === "deleted_pending") throw conflict(`${tenant.name} is held for deletion. Restore it first.`);

    const grossPaise = Math.round((input.amountInr ?? tenant.plan.priceInr) * 100);
    if (!Number.isInteger(grossPaise) || grossPaise <= 0) throw badRequest("Enter the amount in rupees.");
    const description = input.description?.trim() || `${tenant.plan.name} monthly`;
    const paidAt = istDate(input.paidOn) ?? new Date();

    if (input.status === "failed") {
      const retryAt = istDate(input.retryOn) ?? null;
      const payment = await recordPayment(tx, {
        tenant,
        kind: "subscription",
        status: retryAt ? "scheduled_retry" : "failed",
        amountPaise: grossPaise,
        method: input.method,
        reference: input.reference,
        description,
        planId: tenant.planId,
        reason: input.reason ?? null,
        retryAt,
        recordedBy: admin.id,
        paidAt,
      });
      const wasActive = tenant.status === "active";
      if (wasActive) {
        await tx.tenant.update({
          where: { id: tenant.id },
          data: { status: "past_due", statusChangedBy: `admin:${admin.id}`, statusChangedAt: new Date() },
        });
        await tx.subscription.updateMany({ where: { tenantId: tenant.id }, data: { status: "past_due" } });
      }
      await recordActivity(
        {
          actor: admin,
          action: "payment.failed_recorded",
          summary: `${admin.name} recorded a failed ${inrPaise(grossPaise)} charge${retryAt ? `, retry ${retryAt.toDateString()}` : ""}`,
          workspace: tenant,
          reason: input.reason ?? null,
          before: { status: tenant.status },
          after: { status: wasActive ? "past_due" : tenant.status, paymentId: payment.id },
        },
        tx
      );
      return { message: `Failed charge recorded${wasActive ? `; ${tenant.name} is now past due` : ""}.` };
    }

    const subscription = await ensureSubscription(tx, tenant);
    let discountPaise = 0;
    let couponId: string | null = null;
    let redemptionId: string | null = null;
    if (input.couponCode?.trim()) {
      const r = await redeemOnPayment(tx, { code: input.couponCode, subscription, planKey: tenant.plan.key, amountPaise: grossPaise });
      discountPaise = r.discountPaise;
      couponId = r.coupon.id;
      redemptionId = r.redemptionId;
    }

    const payment = await recordPayment(tx, {
      tenant,
      kind: "subscription",
      status: "captured",
      amountPaise: grossPaise - discountPaise,
      discountPaise,
      couponId,
      method: input.method,
      reference: input.reference,
      description,
      planId: tenant.planId,
      recordedBy: admin.id,
      paidAt,
      invoiceLines: [{ description: `${description} (${tenant.plan.name}, ₹${tenant.plan.priceInr.toLocaleString("en-IN")} a month)`, quantity: 1, unitPaise: grossPaise }],
    });
    if (redemptionId) await tx.couponRedemption.update({ where: { id: redemptionId }, data: { paymentId: payment.id } });

    // A charge that lands clears past due.
    const cleared = tenant.status === "past_due";
    if (cleared) {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { status: "active", statusChangedBy: `admin:${admin.id}`, statusChangedAt: new Date() },
      });
      await tx.subscription.update({ where: { id: subscription.id }, data: { status: "active" } });
    }

    await recordActivity(
      {
        actor: admin,
        action: "payment.recorded",
        summary: `${admin.name} recorded ${inrPaise(payment.amountPaise)} by ${METHOD_LABEL[input.method] ?? input.method}${couponId ? ` with coupon ${input.couponCode!.toUpperCase()}` : ""}, invoice ${payment.invoice?.number}`,
        workspace: tenant,
        reason: input.reason ?? null,
        before: cleared ? { status: "past_due" } : null,
        after: { paymentId: payment.id, invoice: payment.invoice?.number, amountPaise: payment.amountPaise, discountPaise, ...(cleared ? { status: "active" } : {}) },
      },
      tx
    );
    return { message: `Recorded, invoice ${payment.invoice?.number}${cleared ? `; ${tenant.name} is no longer past due` : ""}.` };
  });
}

export const REFUND_GROUNDS = [
  { key: "first_payment_guarantee", label: "First payment guarantee (7 days, light use)" },
  { key: "unused_top_up", label: "Unused top up within 7 days" },
  { key: "charged_by_mistake", label: "Charged by mistake" },
  { key: "outage", label: "Pratibha unavailable for over 72 hours" },
] as const;

export type RefundGround = (typeof REFUND_GROUNDS)[number]["key"];

/**
 * Whether the published refund policy allows this refund, and why not.
 * The two time-bound grounds are checked against the records; the other two
 * are an admin's attestation, recorded with their reason.
 */
export async function refundCheck(payment: Payment, ground: RefundGround): Promise<string | null> {
  const s = await getSettings();
  const windowMs = Number(s["refund.window_days"]) * 86_400_000;
  const within = Date.now() - payment.paidAt.getTime() <= windowMs;

  if (ground === "first_payment_guarantee") {
    if (payment.kind !== "subscription") return "The first payment guarantee covers subscription payments only.";
    const earlier = await db.payment.count({
      where: { tenantId: payment.tenantId, kind: "subscription", status: { in: ["captured", "refunded"] }, paidAt: { lt: payment.paidAt } },
    });
    if (earlier > 0) return "This is not the workspace's first paid subscription payment.";
    if (!within) return `The guarantee runs for ${s["refund.window_days"]} days from the payment.`;
    const tenant = await db.tenant.findUnique({
      where: { id: payment.tenantId },
      include: { plan: true, usageMeters: { where: { period: usagePeriod(payment.paidAt) } } },
    });
    const used = tenant?.usageMeters[0]?.interviewMinutesUsed ?? 0;
    const cap = Math.floor(((tenant?.plan.minutes ?? 0) * Number(s["refund.first_payment_max_usage_percent"])) / 100);
    if (used > cap) return `They have used ${used} minutes, above the ${s["refund.first_payment_max_usage_percent"]}% the guarantee allows (${cap}).`;
    return null;
  }
  if (ground === "unused_top_up") {
    if (payment.kind !== "top_up") return "This ground covers top ups only.";
    if (!within) return `Unused top ups can be refunded within ${s["refund.window_days"]} days of buying.`;
    const tenant = await db.tenant.findUnique({
      where: { id: payment.tenantId },
      include: { plan: true, subscription: true, usageMeters: { where: { period: usagePeriod() } } },
    });
    const used = tenant?.usageMeters[0]?.interviewMinutesUsed ?? 0;
    if (payment.minutes && used > (tenant?.plan.minutes ?? 0)) return "The workspace has used minutes beyond its plan, so the top up has been used.";
    return null;
  }
  return null;
}

export async function refundPayment(admin: AdminUser, paymentId: string, ground: RefundGround, reason: string) {
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound("That payment does not exist.");
  if (payment.status !== "captured" || payment.kind === "refund" || payment.kind === "goodwill") {
    throw conflict("Only a captured subscription or top up payment can be refunded.");
  }
  const problem = await refundCheck(payment, ground);
  if (problem) throw badRequest(`Outside the published refund policy: ${problem}`);

  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: payment.tenantId } });
    await tx.payment.update({ where: { id: payment.id }, data: { status: "refunded" } });
    const refund = await tx.payment.create({
      data: {
        tenantId: payment.tenantId,
        kind: "refund",
        status: "captured",
        amountPaise: payment.amountPaise,
        method: payment.method,
        description: `Refund of ${payment.description}`,
        refundOfId: payment.id,
        reason: `${REFUND_GROUNDS.find((g) => g.key === ground)?.label}: ${reason}`,
        recordedBy: admin.id,
      },
    });
    if (payment.invoiceId) await tx.invoice.update({ where: { id: payment.invoiceId }, data: { status: "void" } });

    // A refunded pack takes its minutes or screenings back with it.
    if (payment.kind === "top_up" && (payment.minutes || payment.screenings)) {
      const sub = await tx.subscription.findUnique({ where: { tenantId: payment.tenantId } });
      if (sub) {
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            topUpMinutes: Math.max(0, sub.topUpMinutes - (payment.minutes ?? 0)),
            topUpScreenings: Math.max(0, sub.topUpScreenings - (payment.screenings ?? 0)),
          },
        });
      }
    }

    await recordActivity(
      {
        actor: admin,
        action: "payment.refunded",
        summary: `${admin.name} refunded ${inrPaise(payment.amountPaise)} for ${payment.description}`,
        workspace: tenant,
        reason: refund.reason,
        before: { status: "captured" },
        after: { status: "refunded", refundId: refund.id },
      },
      tx
    );
    return { message: `Refunded ${inrPaise(payment.amountPaise)}. The invoice is void.` };
  });
}

export async function rescheduleRetry(admin: AdminUser, paymentId: string, retryOn: string | null, reason: string) {
  const payment = await db.payment.findUnique({ where: { id: paymentId }, include: { tenant: true } });
  if (!payment || !["failed", "scheduled_retry"].includes(payment.status)) throw conflict("Only a failed charge has a retry.");
  const retryAt = istDate(retryOn) ?? null;
  await db.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { retryAt, status: retryAt ? "scheduled_retry" : "failed" } });
    await recordActivity(
      {
        actor: admin,
        action: "payment.retry_scheduled",
        summary: retryAt ? `${admin.name} set the next retry for ${retryAt.toDateString()}` : `${admin.name} cleared the retry`,
        workspace: payment.tenant,
        reason,
        before: { retryAt: payment.retryAt?.toISOString() ?? null },
        after: { retryAt: retryAt?.toISOString() ?? null },
      },
      tx
    );
  });
  return { message: retryAt ? "Retry scheduled." : "Retry cleared." };
}
