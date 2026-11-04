/**
 * The payment gateway, as a contract.
 *
 * The provider is not chosen yet, so this exists to make that choice cheap: the
 * screens, the data model and the billing rules are all written against this
 * interface, and wiring a real gateway means writing one implementation of it,
 * not revisiting any of them.
 *
 * Deliberately shaped around what Indian recurring billing actually needs —
 * a mandate (eNACH / UPI AutoPay / card standing instruction) that the customer
 * authorises once, distinct from the individual charges made against it. A
 * gateway-agnostic "charge a card" abstraction would have had to be rewritten
 * the moment a real mandate flow arrived.
 *
 * Every method returns a result rather than throwing on decline: a refused
 * payment is an outcome to show the customer, not an exception.
 */

import {
  cashfreeConfig,
  cashfreeRequest,
  chargePaymentId,
  rupees,
  type CashfreePayment,
  type CashfreeSubscription,
} from "@/lib/cashfree";

export interface MandateSetup {
  /** Where to send the customer to authorise. Null for the manual provider. */
  redirectUrl: string | null;
  /** For a gateway whose checkout opens from its JS SDK rather than a URL. */
  sessionId?: string | null;
  /** The gateway's handle for the mandate, stored as PaymentMethod.providerRef. */
  reference: string;
}

export interface ChargeResult {
  ok: boolean;
  reference?: string;
  error?: string;
  /** True when the gateway needs the customer to act (3DS, UPI approval). */
  requiresAction?: boolean;
  actionUrl?: string;
  /**
   * Accepted but not settled: the outcome arrives later by webhook. AutoPay
   * debits are scheduled after a pre-debit notice, so this is the normal case.
   */
  pending?: boolean;
}

export interface PaymentProvider {
  readonly name: string;

  /** Whether this provider can actually move money. */
  readonly canCharge: boolean;

  /** Begin authorising a recurring mandate. */
  createMandate(args: {
    tenantId: string;
    customerEmail: string;
    customerName?: string;
    /** Required by Indian mandate rails; the manual provider ignores it. */
    customerPhone?: string;
    /** Our id for the mandate, so a retried setup cannot create two. */
    reference: string;
    /** Where the gateway returns the customer after authorising. */
    returnUrl?: string;
    /** Upper bound the customer authorises, in paise. */
    maxAmountPaise: number;
    /**
     * Collect this much as part of authorising, and keep it: how a paid signup
     * takes its first month in the same checkout that sets up AutoPay.
     */
    firstChargePaise?: number;
  }): Promise<MandateSetup>;

  /** Cancel a mandate. Must be idempotent: a revoked mandate revokes fine. */
  revokeMandate(reference: string): Promise<void>;

  /** Charge against an authorised mandate. */
  charge(args: {
    mandateReference: string;
    amountPaise: number;
    description: string;
    /** Ours, so a retry cannot double-charge. */
    idempotencyKey: string;
    /** The invoice this charge settles; the gateway's payment is tied back to it. */
    invoiceId: string;
    /** The earliest day to debit. Mandate rails need a day's notice. */
    scheduleOn?: Date;
  }): Promise<ChargeResult>;
}

/**
 * The provider used until a real one is chosen.
 *
 * It does not pretend to succeed. `canCharge` is false and every charge returns
 * a refusal naming the reason, so the UI shows "no payment method configured"
 * rather than a fake success that would leave invoices marked paid against
 * money nobody collected — the worst possible stub for a billing system.
 *
 * Plan changes still work: until a gateway is wired, they are actioned manually
 * from the superadmin side, which is the agreed interim.
 */
export const manualProvider: PaymentProvider = {
  name: "manual",
  canCharge: false,

  async createMandate({ reference }) {
    return { redirectUrl: null, reference };
  },

  async revokeMandate() {
    // Nothing to revoke; a manual mandate is a note, not an instrument.
  },

  async charge() {
    return {
      ok: false,
      error:
        "No payment gateway is configured yet. This plan change has been recorded and will be actioned by the Pratibha team.",
    };
  },
};

/**
 * Which provider is in force.
 *
 * Selected by name from the environment so switching is configuration. An
 * unrecognised name falls back to manual rather than throwing: a typo in an env
 * var should degrade billing to manual handling, not take the app down.
 */
export function paymentProvider(): PaymentProvider {
  switch (process.env.PAYMENT_PROVIDER) {
    case "cashfree":
      // Selected but without keys is the same typo-class mistake: manual, not down.
      return cashfreeConfig() ? cashfreeProvider : manualProvider;
    default:
      return manualProvider;
  }
}

/**
 * Cashfree Subscriptions, ON_DEMAND. The mandate reference is our own
 * subscription_id on Cashfree's side, which is what every later call takes.
 */
export const cashfreeProvider: PaymentProvider = {
  name: "cashfree",
  canCharge: true,

  async createMandate({ customerEmail, customerName, customerPhone, reference, returnUrl, maxAmountPaise, firstChargePaise }) {
    if (!customerPhone) throw new Error("A phone number is needed to set up AutoPay");
    const created = await cashfreeRequest<CashfreeSubscription>(
      "POST",
      "/subscriptions",
      {
        subscription_id: reference,
        customer_details: {
          customer_email: customerEmail,
          customer_phone: customerPhone,
          ...(customerName ? { customer_name: customerName } : {}),
        },
        plan_details: {
          plan_name: "Pratibha subscription",
          plan_type: "ON_DEMAND",
          plan_currency: "INR",
          plan_max_amount: rupees(Math.max(maxAmountPaise, firstChargePaise ?? 0)),
        },
        authorization_details: firstChargePaise
          ? {
              // The first month, collected and kept. eNACH cannot collect at
              // authorisation, so it is not offered here.
              authorization_amount: rupees(firstChargePaise),
              authorization_amount_refund: false,
              payment_methods: ["upi", "card"],
            }
          : {
              // A rupee to prove the instrument, given back.
              authorization_amount: 1,
              authorization_amount_refund: true,
              payment_methods: ["upi", "enach", "card"],
            },
        subscription_meta: {
          ...(returnUrl ? { return_url: returnUrl } : {}),
          notification_channel: ["EMAIL", "SMS"],
        },
        // Mandates are open-ended; this is the furthest Cashfree is asked to keep it.
        subscription_expiry_time: new Date(Date.now() + 10 * 365 * 86_400_000).toISOString(),
      }
    );
    return { redirectUrl: null, sessionId: created.subscription_session_id ?? null, reference };
  },

  async revokeMandate(reference) {
    try {
      await cashfreeRequest("POST", `/subscriptions/${encodeURIComponent(reference)}/manage`, {
        subscription_id: reference,
        action: "CANCEL",
      });
    } catch (err) {
      // Already cancelled, or never authorised: either way there is nothing left to revoke.
      if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 404) return;
      throw err;
    }
  },

  async charge({ mandateReference, amountPaise, description, invoiceId, scheduleOn }) {
    const paymentId = chargePaymentId(invoiceId);
    try {
      const payment = await cashfreeRequest<CashfreePayment>(
        "POST",
        "/subscriptions/pay",
        {
          subscription_id: mandateReference,
          payment_id: paymentId,
          payment_type: "CHARGE",
          payment_amount: rupees(amountPaise),
          payment_remarks: description.slice(0, 100),
          ...(scheduleOn ? { payment_schedule_date: scheduleOn.toISOString() } : {}),
        }
      );
      if (payment.payment_status === "FAILED") {
        return { ok: false, reference: paymentId, error: payment.failure_details?.failure_reason ?? "The bank refused the debit." };
      }
      return { ok: true, reference: paymentId, pending: payment.payment_status !== "SUCCESS" };
    } catch (err) {
      return { ok: false, reference: paymentId, error: (err as Error).message };
    }
  },
};

// --- Seller identity --------------------------------------------------------

export interface SellerIdentity {
  legalName: string;
  gstin: string | null;
  address: string;
  state: string;
  invoicePrefix: string;
}

/**
 * Who is selling, for the invoice.
 *
 * In configuration rather than in code because Pratibha may move to its own
 * entity later, and that should be a settings change. The defaults name
 * Promonkey Technologies LLP as agreed, and are placeholders for the parts
 * Gaurav has not confirmed — which is why an unset GSTIN stays null and prints
 * as missing, instead of a made-up number that would make an invoice worse than
 * an incomplete one.
 */
export function sellerIdentity(): SellerIdentity {
  return {
    legalName: process.env.INVOICE_SELLER_NAME ?? "Promonkey Technologies LLP",
    gstin: process.env.INVOICE_SELLER_GSTIN || null,
    address: process.env.INVOICE_SELLER_ADDRESS ?? "",
    state: process.env.INVOICE_SELLER_STATE ?? "Karnataka",
    invoicePrefix: process.env.INVOICE_NUMBER_PREFIX ?? "PMT",
  };
}
