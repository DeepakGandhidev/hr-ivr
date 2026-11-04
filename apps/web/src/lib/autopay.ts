import { adminPrisma, type Prisma, type Subscription, type Tenant } from "@pratibha/prisma";
import {
  calculateInvoice,
  financialYear,
  formatAddress,
  gstStateCode,
  nextInvoiceNumber,
  writeAuditLog,
} from "@pratibha/shared";
import { setting } from "@pratibha/shared/settings-runtime";
import { cashfreeRequest, ledgerMethod, type CashfreeSubscription } from "@/lib/cashfree";
import { paymentProvider, sellerIdentity } from "@/lib/payments";
import { notifyInvoiceIssued, notifyPaymentFailed } from "@/lib/billing-emails";

/**
 * AutoPay: renewing a period against the customer's mandate, and settling the
 * charges the gateway reports back.
 *
 * Everything here runs without a session (a timer, a webhook), so it uses the
 * admin connection and pins every write to the tenant it read.
 */

type Db = Prisma.TransactionClient;

const DAY_MS = 86_400_000;

/**
 * How far ahead of the period end a renewal is raised. Mandate debits need
 * notice. Three days unless changed in the admin panel (billing.renew_ahead_days,
 * never under two).
 */
const renewAheadMs = () => setting<number>("billing.renew_ahead_days") * DAY_MS;
/** Cashfree sends the pre-debit notice at least a day before the debit date. */
const NOTICE_MS = 26 * 3_600_000;
/**
 * A failed renewal is retried daily until this long after the period ended:
 * seven days unless changed in the admin panel (billing.renewal_retry_days).
 */
const retryWindowMs = () => setting<number>("billing.renewal_retry_days") * DAY_MS;

/**
 * The ceiling the customer authorises: the configured figure, or ₹15,000.
 * Configured by CASHFREE_MANDATE_MAX_INR, which the admin panel's
 * billing.mandate_max_inr overrides at runtime; read here on every call.
 * That is the most UPI AutoPay and card mandates take without additional
 * authentication; above it Cashfree offers no payment mode at all unless AFA
 * is enabled on the account. A plan dearer than this raises the ceiling to its
 * own price (createMandate takes the larger), which then needs AFA.
 */
export function mandateMaxPaise(): number {
  const inr = Number(process.env.CASHFREE_MANDATE_MAX_INR);
  return (Number.isFinite(inr) && inr > 0 ? inr : 15_000) * 100;
}

/** Activation mandates carry this prefix: their authorisation pays the first month. */
export const ACTIVATION_PREFIX = "pra_";

/**
 * Issue one invoice, numbered gaplessly inside an advisory lock: the same lock
 * the admin ledger takes, so the portal, the admin panel and this job cannot
 * hand out the same number.
 */
export async function issueInvoice(
  db: Db,
  tenant: Tenant,
  subscription: Subscription,
  line: { description: string; unitPaise: number },
  period: { start: Date; end: Date }
) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pratibha.invoice_number'))`;

  const seller = sellerIdentity();
  const profile = await db.companyProfile.findUnique({ where: { tenantId: tenant.id } });
  const totals = calculateInvoice({
    lines: [{ description: line.description, quantity: 1, unitPaise: line.unitPaise }],
    sellerState: seller.state,
    buyerState: profile?.billingState,
  });

  const issuedAt = new Date();
  const yearPrefix = `${seller.invoicePrefix}/${financialYear(issuedAt)}/`;
  const issuedThisYear = await db.invoice.count({ where: { number: { startsWith: yearPrefix } } });

  return db.invoice.create({
    data: {
      subscriptionId: subscription.id,
      number: nextInvoiceNumber(seller.invoicePrefix, issuedAt, issuedThisYear),
      status: "issued",
      periodStart: period.start,
      periodEnd: period.end,
      issuedAt,
      lines: totals.lines as unknown as Prisma.InputJsonValue,
      subtotalPaise: totals.subtotalPaise,
      discountPaise: totals.discountPaise,
      cgstPaise: totals.tax.cgstPaise,
      sgstPaise: totals.tax.sgstPaise,
      igstPaise: totals.tax.igstPaise,
      totalPaise: totals.totalPaise,
      placeOfSupply: profile?.billingState ?? "Unknown",
      seller: { ...seller, stateCode: gstStateCode(seller.state) },
      buyer: {
        legalName: profile?.legalName ?? tenant.name,
        address:
          formatAddress({ addressLine: profile?.addressLine, city: profile?.city, pinCode: profile?.pinCode }) ??
          profile?.billingAddress ??
          null,
        state: profile?.billingState ?? null,
        stateCode: gstStateCode(profile?.billingState),
        gstin: profile?.gstin ?? null,
      },
    },
  });
}

/** One month on, the way the rest of billing counts a period. */
export function nextPeriodEnd(from: Date): Date {
  const end = new Date(from);
  end.setMonth(end.getMonth() + 1);
  return end;
}

/** The earliest debit date a mandate allows from now, and never before `notBefore`. */
export function debitDate(notBefore: Date, now: Date = new Date()): Date {
  const earliest = new Date(now.getTime() + NOTICE_MS);
  return notBefore > earliest ? notBefore : earliest;
}

async function activeMandate(db: Db | typeof adminPrisma, subscriptionId: string) {
  return db.paymentMethod.findFirst({
    where: { subscriptionId, provider: "cashfree", mandateStatus: "active" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Charge an issued invoice against the subscription's mandate. Returns false
 * when there is no mandate to charge, leaving the invoice to manual settlement.
 *
 * Called outside any transaction: it waits on the gateway, and a slow gateway
 * must not hold a transaction open past its timeout.
 */
export async function chargeInvoice(
  db: Db | typeof adminPrisma,
  subscriptionId: string,
  invoice: { id: string; number: string; totalPaise: number },
  scheduleOn: Date
): Promise<{ charged: boolean; error?: string }> {
  const provider = paymentProvider();
  if (!provider.canCharge) return { charged: false };
  const mandate = await activeMandate(db, subscriptionId);
  if (!mandate) return { charged: false };

  const result = await provider.charge({
    mandateReference: mandate.providerRef,
    amountPaise: invoice.totalPaise,
    description: `Pratibha invoice ${invoice.number}`,
    idempotencyKey: invoice.id,
    invoiceId: invoice.id,
    scheduleOn,
  });
  return result.ok ? { charged: true } : { charged: false, error: result.error };
}

/**
 * Raise the next period's invoice and its charge for every subscription with
 * an active mandate whose period ends within three days (the renew-ahead
 * setting), and retry yesterday's
 * failures. Runs hourly in the portal process. One run at a time per process.
 */
let running = false;

export async function runRenewals(now: Date = new Date()): Promise<number> {
  if (running || !paymentProvider().canCharge) return 0;
  running = true;
  let raised = 0;
  try {
    const due = await adminPrisma.subscription.findMany({
      where: {
        status: { in: ["trialing", "active", "past_due"] },
        cancelRequestedAt: null,
        renewalInvoiceId: null,
        periodEnd: { lte: new Date(now.getTime() + renewAheadMs()) },
        paymentMethods: { some: { provider: "cashfree", mandateStatus: "active" } },
      },
      include: { tenant: { include: { plan: true } } },
      take: 50,
    });

    for (const sub of due) {
      try {
        // The invoice and the marker that it exists commit together, before
        // the gateway is called, so a crash mid-charge cannot invoice twice.
        const invoice = await adminPrisma.$transaction(async (db) => {
          // Re-read under the transaction: another process may have raised it.
          const fresh = await db.subscription.findUnique({ where: { id: sub.id } });
          if (!fresh || fresh.renewalInvoiceId) return null;

          const plan = sub.tenant.plan;
          const start = fresh.periodEnd;
          const created = await issueInvoice(
            db,
            sub.tenant,
            fresh,
            { description: `${plan.name} plan, monthly`, unitPaise: plan.priceInr * 100 },
            { start, end: nextPeriodEnd(start) }
          );
          await db.subscription.update({ where: { id: fresh.id }, data: { renewalInvoiceId: created.id } });
          return created;
        });
        if (!invoice) continue;

        const charge = await chargeInvoice(adminPrisma, sub.id, invoice, debitDate(invoice.periodStart, now));
        await adminPrisma.$transaction(async (db) => {
          await writeAuditLog(db, {
            tenantId: sub.tenantId,
            actor: "system",
            action: "subscription.renewal_raised",
            entity: "subscription",
            entityId: sub.id,
            after: { invoice: invoice.number, totalPaise: invoice.totalPaise, charged: charge.charged, error: charge.error },
          });
          if (!charge.charged) {
            await recordFailure(db, sub.tenant, invoice.id, charge.error ?? "No active mandate", now);
          }
        });
        if (!charge.charged) await notifyPaymentFailed(invoice.id);
        raised++;
      } catch (err) {
        console.error(`[autopay] renewal for subscription ${sub.id} failed`, err);
      }
    }

    // Retries: a renewal whose charge failed, once its retry time has come.
    const retries = await adminPrisma.payment.findMany({
      where: { status: "failed", retryAt: { lte: now }, kind: "subscription", invoiceId: { not: null } },
      include: { invoice: { include: { subscription: true } } },
      take: 50,
    });
    for (const p of retries) {
      const invoice = p.invoice;
      if (!invoice || invoice.status !== "issued" || invoice.subscription.renewalInvoiceId !== invoice.id) continue;
      try {
        // Claimed first, so a second process sees it taken and moves on.
        const claimed = await adminPrisma.payment.updateMany({
          where: { id: p.id, status: "failed" },
          data: { status: "scheduled_retry", retryAt: null },
        });
        if (claimed.count === 0) continue;
        const charge = await chargeInvoice(adminPrisma, invoice.subscriptionId, invoice, debitDate(now, now));
        if (!charge.charged) {
          await adminPrisma.$transaction(async (db) => {
            const tenant = await db.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
            await recordFailure(db, tenant, invoice.id, charge.error ?? "No active mandate", now);
          });
          // Keyed on the ledger row, so a retry that fails again does not mail again.
          await notifyPaymentFailed(invoice.id);
        }
      } catch (err) {
        console.error(`[autopay] retry for invoice ${invoice.id} failed`, err);
      }
    }
  } finally {
    running = false;
  }
  return raised;
}

/**
 * A failed renewal: the ledger shows it, the subscription goes past due, and a
 * retry is booked for tomorrow unless the period ended more than a week ago
 * (the retry-window setting), after which it is left for the team to chase.
 */
async function recordFailure(db: Db, tenant: Tenant, invoiceId: string, reason: string, now: Date) {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { subscription: true } });
  const isRenewal = invoice.subscription.renewalInvoiceId === invoice.id;
  const retryAt = new Date(now.getTime() + DAY_MS);
  const giveUp = !isRenewal || retryAt.getTime() > invoice.periodStart.getTime() + retryWindowMs();

  await db.payment.upsert({
    where: { invoiceId },
    create: {
      tenantId: tenant.id,
      kind: isRenewal ? "subscription" : "top_up",
      amountPaise: invoice.subtotalPaise - invoice.discountPaise,
      method: "none",
      status: "failed",
      description: invoiceDescription(invoice.lines),
      invoiceId,
      reason: reason.slice(0, 500),
      retryAt: giveUp ? null : retryAt,
      paidAt: now,
    },
    update: { status: "failed", reason: reason.slice(0, 500), retryAt: giveUp ? null : retryAt },
  });

  if (isRenewal && invoice.subscription.periodEnd <= now) {
    await db.subscription.update({ where: { id: invoice.subscriptionId }, data: { status: "past_due" } });
  }
}

function invoiceDescription(lines: Prisma.JsonValue): string {
  const first = Array.isArray(lines) ? (lines[0] as { description?: string } | undefined) : undefined;
  return first?.description ?? "Pratibha invoice";
}

/**
 * The gateway's verdict on a charge. Idempotent: Cashfree retries webhooks, and
 * a second SUCCESS for a paid invoice changes nothing.
 */
export async function settleCharge(args: {
  invoiceId: string;
  outcome: "success" | "failed";
  reference: string;
  paymentGroup?: string | null;
  failureReason?: string | null;
}) {
  const now = new Date();
  const settled = await adminPrisma.$transaction(async (db) => {
    const invoice = await db.invoice.findUnique({
      where: { id: args.invoiceId },
      include: { subscription: { include: { tenant: true } } },
    });
    if (!invoice || invoice.status === "paid" || invoice.status === "void") return null;
    const sub = invoice.subscription;
    const tenant = sub.tenant;
    const isRenewal = sub.renewalInvoiceId === invoice.id;

    if (args.outcome === "failed") {
      await recordFailure(db, tenant, invoice.id, args.failureReason ?? "The bank refused the debit.", now);
      await writeAuditLog(db, {
        tenantId: tenant.id,
        actor: "system",
        action: "payment.autopay_failed",
        entity: "invoice",
        entityId: invoice.id,
        after: { invoice: invoice.number, reason: args.failureReason, reference: args.reference },
      });
      return "failed" as const;
    }

    await db.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt: now } });
    const payment = {
      status: "captured" as const,
      method: ledgerMethod(args.paymentGroup),
      reference: args.reference,
      retryAt: null,
      reason: null,
      paidAt: now,
    };
    await db.payment.upsert({
      where: { invoiceId: invoice.id },
      create: {
        tenantId: tenant.id,
        kind: isRenewal ? "subscription" : "top_up",
        amountPaise: invoice.subtotalPaise - invoice.discountPaise,
        description: invoiceDescription(invoice.lines),
        planId: isRenewal ? tenant.planId : null,
        invoiceId: invoice.id,
        ...payment,
      },
      update: payment,
    });

    if (isRenewal) {
      // The period the invoice was for becomes the current one.
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          status: "active",
          renewalInvoiceId: null,
        },
      });
      if (tenant.status === "trial" || tenant.status === "past_due" || tenant.status === "pending_payment") {
        await db.tenant.update({
          where: { id: tenant.id },
          data: { status: "active", statusChangedBy: "system", statusChangedAt: now, previousStatus: tenant.status },
        });
      }
    }

    await writeAuditLog(db, {
      tenantId: tenant.id,
      actor: "system",
      action: "payment.autopay_captured",
      entity: "invoice",
      entityId: invoice.id,
      after: { invoice: invoice.number, totalPaise: invoice.totalPaise, reference: args.reference, renewal: isRenewal },
    });
    return "paid" as const;
  });

  // After the commit, and never failing the settlement.
  if (settled === "paid") await notifyInvoiceIssued(args.invoiceId);
  else if (settled === "failed") await notifyPaymentFailed(args.invoiceId);
}

/** Cashfree's mandate states, as ours. Null means no change worth recording. */
export function mandateStatusFrom(subscriptionStatus: string, authStatus?: string | null) {
  const s = subscriptionStatus.toUpperCase();
  if (s === "ACTIVE") return "active" as const;
  if (["CUSTOMER_CANCELLED", "CANCELLED", "COMPLETED", "EXPIRED", "CARD_EXPIRED"].includes(s)) return "revoked" as const;
  if (s === "LINK_EXPIRED" || authStatus?.toUpperCase() === "FAILED") return "failed" as const;
  if (s === "BANK_APPROVAL_PENDING" || s === "INITIALIZED" || authStatus?.toUpperCase() === "PENDING") return "pending" as const;
  return null;
}

/** Apply a mandate's new state, from a webhook or a status check. */
export async function updateMandate(reference: string, subscriptionStatus: string, authStatus?: string | null, paymentGroup?: string | null) {
  const status = mandateStatusFrom(subscriptionStatus, authStatus);
  if (!status) return;
  const method = await adminPrisma.paymentMethod.findFirst({ where: { provider: "cashfree", providerRef: reference } });
  if (!method) return;

  // An authorised activation mandate has collected the first month. Settled
  // before the no-change check, and idempotently, so a webhook that arrives
  // after the return-page check still finds nothing left to do.
  if (status === "active" && reference.startsWith(ACTIVATION_PREFIX)) {
    const sub = await adminPrisma.subscription.findUnique({ where: { id: method.subscriptionId } });
    if (sub?.renewalInvoiceId) {
      await settleCharge({ invoiceId: sub.renewalInvoiceId, outcome: "success", reference, paymentGroup });
    }
  }
  if (method.mandateStatus === status) return;

  await adminPrisma.$transaction(async (db) => {
    await db.paymentMethod.update({
      where: { id: method.id },
      data: {
        mandateStatus: status,
        ...(paymentGroup ? { brand: brandFor(paymentGroup) } : {}),
        // The newest active mandate is the one charged.
        ...(status === "active" ? { isDefault: true } : {}),
      },
    });
    if (status === "active") {
      await db.paymentMethod.updateMany({
        where: { subscriptionId: method.subscriptionId, id: { not: method.id } },
        data: { isDefault: false },
      });
    }
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: method.subscriptionId } });
    await writeAuditLog(db, {
      tenantId: sub.tenantId,
      actor: "system",
      action: "payment_method.mandate_" + status,
      entity: "payment_method",
      entityId: method.id,
      before: { mandateStatus: method.mandateStatus },
      after: { mandateStatus: status },
    });
  });
}

function brandFor(paymentGroup: string): string {
  const method = ledgerMethod(paymentGroup);
  return method === "upi" ? "UPI AutoPay" : method === "card" ? "Card" : "eNACH";
}

/** Ask Cashfree directly, for when the customer returns before the webhook does. */
export async function syncMandate(reference: string) {
  const sub = await cashfreeRequest<CashfreeSubscription>("GET", `/subscriptions/${encodeURIComponent(reference)}`);
  await updateMandate(
    reference,
    sub.subscription_status,
    sub.authorisation_details?.authorization_status,
    sub.authorisation_details?.payment_group
  );
}
