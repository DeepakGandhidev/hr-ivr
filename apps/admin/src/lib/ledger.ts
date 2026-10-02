import type { Prisma, Tenant, Subscription, PaymentKind, PaymentStatus } from "@pratibha/prisma";
import { calculateInvoice, financialYear, nextInvoiceNumber, gstStateCode } from "@pratibha/shared";
import type { Tx } from "@/lib/db";

/**
 * The manual-era ledger: payments, and the GST invoice behind every captured
 * one. Written so a gateway can later call the same functions with
 * `recordedBy: null` (the system) and nothing else changes.
 */

export const PAYMENT_METHODS = ["upi", "card", "bank_transfer", "cash", "cheque", "none"] as const;
export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABEL: Record<string, string> = {
  upi: "UPI",
  card: "Card",
  bank_transfer: "Bank transfer",
  cash: "Cash",
  cheque: "Cheque",
  none: "—",
};

/** Who is selling. The same environment the portal's invoices read, so both series agree. */
export function sellerIdentity() {
  return {
    legalName: process.env.INVOICE_SELLER_NAME ?? "Promonkey Technologies LLP",
    gstin: process.env.INVOICE_SELLER_GSTIN ?? null,
    address: process.env.INVOICE_SELLER_ADDRESS ?? "",
    state: process.env.INVOICE_SELLER_STATE ?? "Karnataka",
    invoicePrefix: process.env.INVOICE_NUMBER_PREFIX ?? "PMT",
  };
}

/** The subscription row, made on first need with the same rules the portal uses. */
export async function ensureSubscription(tx: Tx, tenant: Tenant): Promise<Subscription> {
  const existing = await tx.subscription.findUnique({ where: { tenantId: tenant.id } });
  if (existing) return existing;
  const now = new Date();
  const periodEnd = new Date(now);
  if (tenant.status === "trial" && tenant.trialEndsAt) periodEnd.setTime(tenant.trialEndsAt.getTime());
  else periodEnd.setMonth(periodEnd.getMonth() + 1);
  return tx.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: tenant.planId,
      status: tenant.status === "trial" ? "trialing" : "active",
      periodStart: now,
      periodEnd,
    },
  });
}

export interface InvoiceLineIn {
  description: string;
  quantity: number;
  unitPaise: number;
}

/**
 * Issue one invoice. The buyer is snapshotted from the company profile, and
 * the tax split is decided by the buyer's state against the seller's: same
 * state, CGST plus SGST; otherwise IGST.
 *
 * Numbering is gapless within the financial year. An advisory lock serialises
 * every issuer in this database for the length of the transaction, so two
 * payments recorded at once cannot take the same number.
 */
export async function issueInvoice(
  tx: Tx,
  tenant: Tenant,
  subscription: Subscription,
  lines: InvoiceLineIn[],
  opts: { discountPaise?: number; paid: boolean; issuedAt?: Date }
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pratibha.invoice_number'))`;

  const seller = sellerIdentity();
  const profile = await tx.companyProfile.findUnique({ where: { tenantId: tenant.id } });
  const totals = calculateInvoice({
    lines,
    discountPaise: opts.discountPaise ?? 0,
    sellerState: seller.state,
    buyerState: profile?.billingState,
  });

  const issuedAt = opts.issuedAt ?? new Date();
  const yearPrefix = `${seller.invoicePrefix}/${financialYear(issuedAt)}/`;
  const issuedThisYear = await tx.invoice.count({ where: { number: { startsWith: yearPrefix } } });

  return tx.invoice.create({
    data: {
      subscriptionId: subscription.id,
      number: nextInvoiceNumber(seller.invoicePrefix, issuedAt, issuedThisYear),
      status: opts.paid ? "paid" : "issued",
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      issuedAt,
      paidAt: opts.paid ? issuedAt : null,
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
        address: profile?.billingAddress ?? null,
        state: profile?.billingState ?? null,
        stateCode: gstStateCode(profile?.billingState),
        gstin: profile?.gstin ?? null,
      },
    },
  });
}

export interface PaymentIn {
  tenant: Tenant;
  kind: PaymentKind;
  status: PaymentStatus;
  /** What the customer was charged before tax, after any coupon. */
  amountPaise: number;
  method: string;
  description: string;
  recordedBy: string | null;
  planId?: string | null;
  packId?: string | null;
  minutes?: number | null;
  screenings?: number | null;
  couponId?: string | null;
  discountPaise?: number;
  reason?: string | null;
  reference?: string | null;
  retryAt?: Date | null;
  refundOfId?: string | null;
  paidAt?: Date;
  /** Line items for the invoice; a captured, chargeable row always gets one. */
  invoiceLines?: InvoiceLineIn[];
}

/**
 * Record one ledger row, and its invoice when it is a captured charge.
 * Goodwill (zero amount) and failed rows have no invoice: nothing was sold.
 */
export async function recordPayment(tx: Tx, input: PaymentIn) {
  let invoiceId: string | null = null;
  const chargeable = input.status === "captured" && (input.kind === "subscription" || input.kind === "top_up");

  if (chargeable) {
    const subscription = await ensureSubscription(tx, input.tenant);
    const lines =
      input.invoiceLines ??
      [{ description: input.description, quantity: 1, unitPaise: input.amountPaise + (input.discountPaise ?? 0) }];
    const invoice = await issueInvoice(tx, input.tenant, subscription, lines, {
      discountPaise: input.discountPaise ?? 0,
      paid: true,
      issuedAt: input.paidAt,
    });
    invoiceId = invoice.id;
  }

  return tx.payment.create({
    data: {
      tenantId: input.tenant.id,
      kind: input.kind,
      status: input.status,
      amountPaise: input.amountPaise,
      method: input.method,
      description: input.description,
      planId: input.planId ?? null,
      packId: input.packId ?? null,
      minutes: input.minutes ?? null,
      screenings: input.screenings ?? null,
      couponId: input.couponId ?? null,
      discountPaise: input.discountPaise ?? 0,
      reason: input.reason ?? null,
      reference: input.reference ?? null,
      retryAt: input.retryAt ?? null,
      refundOfId: input.refundOfId ?? null,
      recordedBy: input.recordedBy,
      paidAt: input.paidAt ?? new Date(),
      invoiceId,
    },
    include: { invoice: { select: { id: true, number: true, totalPaise: true } } },
  });
}
