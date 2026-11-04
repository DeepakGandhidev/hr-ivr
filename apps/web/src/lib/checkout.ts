import { appUrl as publicAppUrlFor } from "@/lib/app-url";
import { adminPrisma } from "@pratibha/prisma";
import { writeAuditLog } from "@pratibha/shared";
import { cashfreeConfig, cashfreeRequest, chargePaymentId, ledgerMethod, rupees } from "@/lib/cashfree";
import { nextPeriodEnd } from "@/lib/autopay";
import { notifyInvoiceIssued, notifyPlanChanged } from "@/lib/billing-emails";

/**
 * One-time Cashfree checkouts: top-ups and plan upgrades, paid there and then
 * on Cashfree's payment page rather than against the mandate (which needs a
 * day's pre-debit notice).
 *
 * The invoice is issued when the checkout opens; what it buys (minutes, the
 * new plan) is applied only when Cashfree reports the order paid, from the
 * webhook or from the check on return, whichever lands first. Both paths run
 * through applyPaidOrder, which is idempotent.
 */

interface CashfreeOrder {
  order_id: string;
  order_status: string;
  payment_session_id?: string;
}

interface CashfreeOrderPayment {
  cf_payment_id: string | number;
  payment_status: string;
  payment_group?: string | null;
}

export interface CheckoutStart {
  paymentSessionId: string;
  mode: "sandbox" | "production";
  orderId: string;
}

export async function startCheckout(args: {
  tenantId: string;
  tenantSlug: string;
  customer: { email: string; name?: string | null; phone: string };
  invoice: { id: string; number: string; totalPaise: number };
  purpose: "top_up" | "plan_change";
  packId?: string;
  planId?: string;
}): Promise<CheckoutStart> {
  const config = cashfreeConfig();
  if (!config) throw new Error("Cashfree is not configured");

  const orderId = chargePaymentId(args.invoice.id);
  const appUrl = publicAppUrlFor("https://pratibha.tech");
  const order = await cashfreeRequest<CashfreeOrder>("POST", "/orders", {
    order_id: orderId,
    order_amount: rupees(args.invoice.totalPaise),
    order_currency: "INR",
    customer_details: {
      customer_id: args.tenantId,
      customer_phone: args.customer.phone,
      customer_email: args.customer.email,
      ...(args.customer.name ? { customer_name: args.customer.name } : {}),
    },
    order_meta: {
      return_url: `${appUrl}/${args.tenantSlug}/settings/subscription?order_id=${encodeURIComponent(orderId)}`,
      notify_url: `${appUrl}/webhook/cashfree`,
    },
    order_note: `Pratibha invoice ${args.invoice.number}`.slice(0, 200),
  });
  if (!order.payment_session_id) throw new Error("Cashfree did not open a payment session");

  await adminPrisma.checkoutOrder.create({
    data: {
      tenantId: args.tenantId,
      invoiceId: args.invoice.id,
      orderId,
      purpose: args.purpose,
      packId: args.packId ?? null,
      planId: args.planId ?? null,
    },
  });

  return { paymentSessionId: order.payment_session_id, mode: config.mode, orderId };
}

/** Ask Cashfree how an order stands, and apply it if paid. Returns the status. */
export async function syncOrder(orderId: string): Promise<string> {
  const order = await cashfreeRequest<CashfreeOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
  if (order.order_status === "PAID") {
    const payments = await cashfreeRequest<CashfreeOrderPayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
    const paid = payments.find((p) => p.payment_status === "SUCCESS");
    await applyPaidOrder(orderId, { reference: String(paid?.cf_payment_id ?? orderId), paymentGroup: paid?.payment_group });
    return "paid";
  }
  if (order.order_status === "EXPIRED" || order.order_status === "TERMINATED") {
    await failOrder(orderId);
    return "failed";
  }
  return "pending";
}

/**
 * Settle a paid order: invoice paid, ledger row captured, and what was bought
 * applied. A second call for the same order finds it paid and does nothing.
 */
export async function applyPaidOrder(orderId: string, payment: { reference: string; paymentGroup?: string | null }) {
  const now = new Date();
  const applied = await adminPrisma.$transaction(async (db) => {
    const order = await db.checkoutOrder.findUnique({ where: { orderId } });
    if (!order || order.status === "paid") return null;
    const claimed = await db.checkoutOrder.updateMany({
      where: { id: order.id, status: { not: "paid" } },
      data: { status: "paid", paidAt: now },
    });
    if (claimed.count === 0) return null;

    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: order.invoiceId },
      include: { subscription: { include: { tenant: true } } },
    });
    const sub = invoice.subscription;
    const tenant = sub.tenant;
    await db.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt: now } });

    const lines = invoice.lines as Array<{ description?: string }> | null;
    let minutes: number | null = null;
    let screenings: number | null = null;

    if (order.purpose === "top_up" && order.packId) {
      const pack = await db.topupPack.findUnique({ where: { id: order.packId } });
      if (pack) {
        if (pack.kind === "minutes") minutes = pack.quantity;
        else screenings = pack.quantity;
        await db.subscription.update({
          where: { id: sub.id },
          data: pack.kind === "minutes" ? { topUpMinutes: { increment: pack.quantity } } : { topUpScreenings: { increment: pack.quantity } },
        });
      }
    }

    if (order.purpose === "plan_change" && order.planId) {
      // From a trial, the purchase starts the first paid period now; from a
      // paid plan, the upgrade keeps the current period (the price was prorated).
      const fromTrial = tenant.status === "trial";
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          planId: order.planId,
          status: "active",
          ...(fromTrial ? { periodStart: now, periodEnd: nextPeriodEnd(now) } : {}),
        },
      });
      await db.tenant.update({
        where: { id: tenant.id },
        data: {
          planId: order.planId,
          ...(fromTrial || tenant.status === "past_due"
            ? { status: "active", statusChangedBy: "system", statusChangedAt: now, previousStatus: tenant.status }
            : {}),
        },
      });
    }

    await db.payment.upsert({
      where: { invoiceId: invoice.id },
      create: {
        tenantId: tenant.id,
        kind: order.purpose === "top_up" ? "top_up" : "subscription",
        amountPaise: invoice.subtotalPaise - invoice.discountPaise,
        method: ledgerMethod(payment.paymentGroup),
        status: "captured",
        description: lines?.[0]?.description ?? "Pratibha invoice",
        planId: order.planId,
        packId: order.packId,
        minutes,
        screenings,
        invoiceId: invoice.id,
        reference: payment.reference,
        paidAt: now,
      },
      update: { status: "captured", reference: payment.reference, method: ledgerMethod(payment.paymentGroup), paidAt: now, retryAt: null },
    });

    await writeAuditLog(db, {
      tenantId: tenant.id,
      actor: "system",
      action: order.purpose === "top_up" ? "subscription.top_up_paid" : "subscription.plan_change_paid",
      entity: "invoice",
      entityId: invoice.id,
      after: { invoice: invoice.number, totalPaise: invoice.totalPaise, packId: order.packId, planId: order.planId, reference: payment.reference },
    });
    return {
      tenantId: tenant.id,
      invoiceId: invoice.id,
      planChange:
        order.purpose === "plan_change" && order.planId
          ? { fromPlanId: tenant.status === "trial" ? null : tenant.planId, toPlanId: order.planId }
          : null,
    };
  });

  // After the commit, and never failing the payment.
  if (!applied) return;
  await notifyInvoiceIssued(applied.invoiceId);
  if (applied.planChange) await notifyPlanChanged({ tenantId: applied.tenantId, ...applied.planChange, at: now });
}

/** A failed or abandoned checkout: nothing was bought, the invoice is voided. */
export async function failOrder(orderId: string) {
  await adminPrisma.$transaction(async (db) => {
    const order = await db.checkoutOrder.findUnique({ where: { orderId } });
    if (!order || order.status !== "pending") return;
    await db.checkoutOrder.update({ where: { id: order.id }, data: { status: "failed" } });
    await db.invoice.updateMany({ where: { id: order.invoiceId, status: "issued" }, data: { status: "void" } });
  });
}

/**
 * What an upgrade costs today: the difference between the two monthly
 * prices for the part of the period that is left, in paise before tax.
 */
export function proratedUpgradePaise(
  fromPriceInr: number,
  toPriceInr: number,
  period: { start: Date; end: Date },
  now: Date = new Date()
): number {
  const total = period.end.getTime() - period.start.getTime();
  const left = Math.max(0, period.end.getTime() - now.getTime());
  if (total <= 0 || toPriceInr <= fromPriceInr) return 0;
  return Math.round(((toPriceInr - fromPriceInr) * 100 * left) / total);
}

/** An Indian mobile number as Cashfree takes it: ten digits, no prefix. */
export function normalisePhone(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/[\s-]/g, "").replace(/^(\+91|91)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(v) ? v : null;
}

/**
 * The phone number for a payment: the one just typed (saved for next time),
 * else the one on file. Null when there is neither, and the page asks.
 */
export async function billingPhone(tenantId: string, typed?: string | null): Promise<string | null> {
  const fresh = normalisePhone(typed);
  if (fresh) {
    await adminPrisma.subscription.updateMany({ where: { tenantId }, data: { billingPhone: fresh } });
    return fresh;
  }
  const sub = await adminPrisma.subscription.findUnique({ where: { tenantId }, select: { billingPhone: true } });
  return sub?.billingPhone ?? null;
}
