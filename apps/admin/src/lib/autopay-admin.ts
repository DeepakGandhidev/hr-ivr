import { db } from "@/lib/db";

/**
 * Cashfree AutoPay, as the admin panel sees it. Read only: mandates are set up
 * and charged by the portal (apps/web/src/lib/autopay.ts), and this app holds
 * no gateway keys. Everything here comes from the shared tables.
 */

/** Which gateway the portal runs, as declared in this app's environment too. */
export function gatewayInfo() {
  const provider = process.env.PAYMENT_PROVIDER === "cashfree" ? "cashfree" : "manual";
  return {
    provider,
    mode: provider === "cashfree" ? (process.env.CASHFREE_ENV === "production" ? "production" : "sandbox") : null,
  } as const;
}

export async function autopaySummary() {
  const [byStatus, inFlight, retrying] = await Promise.all([
    db.paymentMethod.groupBy({
      by: ["mandateStatus"],
      where: { provider: "cashfree" },
      _count: { _all: true },
    }),
    // Renewal invoices raised and charged, not yet settled by Cashfree.
    db.subscription.findMany({
      where: { renewalInvoiceId: { not: null } },
      select: {
        renewalInvoiceId: true,
        periodEnd: true,
        tenant: { select: { id: true, name: true } },
      },
      orderBy: { periodEnd: "asc" },
      take: 20,
    }),
    db.payment.count({ where: { status: { in: ["failed", "scheduled_retry"] }, recordedBy: null, invoiceId: { not: null } } }),
  ]);

  const invoices = inFlight.length
    ? await db.invoice.findMany({
        where: { id: { in: inFlight.map((s) => s.renewalInvoiceId!) } },
        select: { id: true, number: true, totalPaise: true, payment: { select: { status: true, reason: true, retryAt: true } } },
      })
    : [];

  const count = (s: string) => byStatus.find((g) => g.mandateStatus === s)?._count._all ?? 0;
  return {
    mandates: { active: count("active"), pending: count("pending"), failed: count("failed"), revoked: count("revoked") },
    retrying,
    inFlight: inFlight.map((s) => {
      const inv = invoices.find((i) => i.id === s.renewalInvoiceId);
      return {
        tenant: s.tenant,
        dueOn: s.periodEnd,
        invoice: inv ? { id: inv.id, number: inv.number, totalPaise: inv.totalPaise } : null,
        payment: inv?.payment ?? null,
      };
    }),
  };
}

/** One workspace's AutoPay: its newest mandate and any renewal in flight. */
export async function workspaceAutopay(tenantId: string) {
  const sub = await db.subscription.findUnique({
    where: { tenantId },
    select: {
      renewalInvoiceId: true,
      paymentMethods: {
        where: { provider: "cashfree" },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: { brand: true, mandateStatus: true, providerRef: true, createdAt: true },
      },
    },
  });
  if (!sub) return null;
  const renewal = sub.renewalInvoiceId
    ? await db.invoice.findUnique({
        where: { id: sub.renewalInvoiceId },
        select: { id: true, number: true, totalPaise: true, payment: { select: { status: true, reason: true } } },
      })
    : null;
  return { mandate: sub.paymentMethods[0] ?? null, renewal };
}

export const MANDATE_CHIP: Record<string, { tone: string; label: string }> = {
  active: { tone: "green", label: "AutoPay on" },
  pending: { tone: "amber", label: "Awaiting approval" },
  failed: { tone: "red", label: "Mandate failed" },
  revoked: { tone: "neutral", label: "AutoPay off" },
  none: { tone: "neutral", label: "No mandate" },
};
