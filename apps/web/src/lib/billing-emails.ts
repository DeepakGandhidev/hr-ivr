import { adminPrisma, type Prisma } from "@pratibha/prisma";
import { formatInr } from "@pratibha/shared";
import { setting, settingText } from "@pratibha/shared/settings-runtime";
import { appUrl } from "@/lib/app-url";
import { copyText } from "@/lib/copy";
import { sendEmail } from "@/lib/email";
import { formatDate } from "@/lib/format";

/**
 * Billing emails: a new invoice, a failed payment, a plan change.
 *
 * They go to the finance contact set on the Subscription page when there is
 * one and it has not switched that email off, else to the workspace owner.
 *
 * Every function here is called after the billing write has committed and
 * never throws: an email that fails is logged (and in email_log), but it must
 * not fail or roll back a payment that has already happened.
 */

type BillingEmailKind = "invoice_issued" | "payment_failed" | "plan_changed";

const IST = "Asia/Kolkata";
const DAY_MS = 86_400_000;

/**
 * Who gets a billing email: the finance contact if one is set and wants this
 * kind (absent keys mean on, as on the Subscription page), else the earliest
 * owner still in the workspace. Null when there is nobody.
 */
export async function billingRecipient(tenantId: string, kind: BillingEmailKind): Promise<string | null> {
  const sub = await adminPrisma.subscription.findUnique({
    where: { tenantId },
    select: { billingContactEmail: true, billingContactPrefs: true },
  });
  if (sub?.billingContactEmail && wantsBillingEmail(sub.billingContactPrefs, kind)) {
    return sub.billingContactEmail;
  }
  const owner = await adminPrisma.user.findFirst({
    where: { tenantId, role: "owner", removedAt: null },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return owner?.email ?? null;
}

function wantsBillingEmail(prefs: Prisma.JsonValue | null | undefined, kind: BillingEmailKind): boolean {
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return true;
  return (prefs as Record<string, unknown>)[kind] !== false;
}

function product() {
  return settingText("brand.product_name", "Pratibha");
}

function wrap(body: string[]): string {
  return [
    copyText("copy.email.billing.greeting"),
    "",
    ...body,
    "",
    copyText("copy.email.billing.signoff", { product: product() }),
  ].join("\n");
}

function lineDescription(lines: Prisma.JsonValue): string {
  const first = Array.isArray(lines) ? (lines[0] as { description?: string } | undefined) : undefined;
  return first?.description ?? "your subscription";
}

const subscriptionLink = (slug: string) => `${appUrl()}/${slug}/settings/subscription`;

async function send(args: {
  kind: BillingEmailKind;
  tenantId: string;
  dedupeKey: string;
  subject: string;
  body: string;
}): Promise<boolean> {
  const to = await billingRecipient(args.tenantId, args.kind);
  if (!to) return false;
  const result = await sendEmail({ ...args, to });
  if (!result.ok) console.error(`[billing-email] ${args.kind} not sent: ${result.error}`);
  return result.ok;
}

/** A paid invoice: number, amount with GST, period and a link to it. Once per invoice. */
export async function notifyInvoiceIssued(invoiceId: string): Promise<boolean> {
  try {
    const invoice = await adminPrisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { subscription: { include: { tenant: true } } },
    });
    if (!invoice || invoice.status !== "paid") return false;
    const tenant = invoice.subscription.tenant;

    return await send({
      kind: "invoice_issued",
      tenantId: tenant.id,
      dedupeKey: `invoice_issued:${invoice.id}`,
      subject: copyText("copy.email.invoice_issued.subject", { number: invoice.number, product: product() }),
      body: wrap([
        copyText("copy.email.invoice_issued.body", {
          number: invoice.number,
          company: tenant.name,
          amount: formatInr(invoice.totalPaise),
          period: `${formatDate(invoice.periodStart, IST)} – ${formatDate(invoice.periodEnd, IST)}`,
        }),
        "",
        copyText("copy.email.invoice_issued.action"),
        `${appUrl()}/${tenant.slug}/settings/subscription/invoices/${invoice.id}`,
      ]),
    });
  } catch (err) {
    console.error(`[billing-email] invoice_issued for ${invoiceId} failed`, err);
    return false;
  }
}

/**
 * An AutoPay charge that failed, by the invoice it was for. Keyed on the
 * ledger row, which daily retries reuse, so the customer hears once per
 * failed payment rather than once per attempt.
 */
export async function notifyPaymentFailed(invoiceId: string): Promise<boolean> {
  try {
    const payment = await adminPrisma.payment.findUnique({
      where: { invoiceId },
      include: { invoice: { include: { subscription: { include: { tenant: true } } } } },
    });
    const invoice = payment?.invoice;
    if (!payment || !invoice || payment.status !== "failed") return false;
    const tenant = invoice.subscription.tenant;

    // A retry is booked: say until when, which is the retry window after the
    // period the invoice was for began (billing.renewal_retry_days).
    const retryUntil = new Date(invoice.periodStart.getTime() + setting<number>("billing.renewal_retry_days") * DAY_MS);
    const next = payment.retryAt
      ? copyText("copy.email.payment_failed.retry", { retry_until: formatDate(retryUntil, IST) })
      : copyText("copy.email.payment_failed.final");

    return await send({
      kind: "payment_failed",
      tenantId: tenant.id,
      dedupeKey: `payment_failed:${payment.id}`,
      subject: copyText("copy.email.payment_failed.subject", { company: tenant.name, product: product() }),
      body: wrap([
        copyText("copy.email.payment_failed.body", {
          amount: formatInr(invoice.totalPaise),
          what: `${lineDescription(invoice.lines)} (invoice ${invoice.number})`,
          reason: payment.reason ?? "The bank refused the debit.",
        }),
        "",
        next,
        subscriptionLink(tenant.slug),
      ]),
    });
  } catch (err) {
    console.error(`[billing-email] payment_failed for invoice ${invoiceId} failed`, err);
    return false;
  }
}

/** A one-time checkout (top-up or plan) whose payment failed. Once per order. */
export async function notifyCheckoutFailed(orderId: string, reason?: string | null): Promise<boolean> {
  try {
    const order = await adminPrisma.checkoutOrder.findUnique({ where: { orderId } });
    // Paid after all (a second attempt on the same page worked): nothing to report.
    if (!order || order.status === "paid") return false;
    const invoice = await adminPrisma.invoice.findUnique({
      where: { id: order.invoiceId },
      include: { subscription: { include: { tenant: true } } },
    });
    if (!invoice || invoice.subscription.tenantId !== order.tenantId) return false;
    const tenant = invoice.subscription.tenant;

    return await send({
      kind: "payment_failed",
      tenantId: tenant.id,
      dedupeKey: `payment_failed:${order.orderId}`,
      subject: copyText("copy.email.payment_failed.subject", { company: tenant.name, product: product() }),
      body: wrap([
        copyText("copy.email.payment_failed.body", {
          amount: formatInr(invoice.totalPaise),
          what: lineDescription(invoice.lines),
          reason: reason?.trim() || "The payment did not go through.",
        }),
        "",
        copyText("copy.email.payment_failed.checkout"),
        subscriptionLink(tenant.slug),
      ]),
    });
  } catch (err) {
    console.error(`[billing-email] payment_failed for order ${orderId} failed`, err);
    return false;
  }
}

/**
 * The plan moved: old to new, and from when. `fromPlanId` null means the
 * workspace was on its trial.
 */
export async function notifyPlanChanged(args: {
  tenantId: string;
  fromPlanId: string | null;
  toPlanId: string;
  at?: Date;
}): Promise<boolean> {
  const at = args.at ?? new Date();
  try {
    const [tenant, plans] = await Promise.all([
      adminPrisma.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true, slug: true } }),
      adminPrisma.plan.findMany({
        where: { id: { in: [args.toPlanId, ...(args.fromPlanId ? [args.fromPlanId] : [])] } },
        select: { id: true, name: true },
      }),
    ]);
    if (!tenant) return false;
    const nameOf = (id: string | null) => (id ? plans.find((p) => p.id === id)?.name ?? "your previous plan" : "Trial");
    const newPlan = nameOf(args.toPlanId);

    return await send({
      kind: "plan_changed",
      tenantId: args.tenantId,
      // To the minute: a change and an immediate change back are both news.
      dedupeKey: `plan_changed:${args.tenantId}:${args.toPlanId}:${at.toISOString().slice(0, 16)}`,
      subject: copyText("copy.email.plan_changed.subject", { product: product(), new_plan: newPlan }),
      body: wrap([
        copyText("copy.email.plan_changed.body", {
          company: tenant.name,
          old_plan: nameOf(args.fromPlanId),
          new_plan: newPlan,
          effective_date: formatDate(at, IST),
        }),
        "",
        copyText("copy.email.plan_changed.action"),
        subscriptionLink(tenant.slug),
      ]),
    });
  } catch (err) {
    console.error(`[billing-email] plan_changed for ${args.tenantId} failed`, err);
    return false;
  }
}
