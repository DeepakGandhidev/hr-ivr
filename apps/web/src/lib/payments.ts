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

export interface MandateSetup {
  /** Where to send the customer to authorise. Null for the manual provider. */
  redirectUrl: string | null;
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
}

export interface PaymentProvider {
  readonly name: string;

  /** Whether this provider can actually move money. */
  readonly canCharge: boolean;

  /** Begin authorising a recurring mandate. */
  createMandate(args: {
    tenantId: string;
    customerEmail: string;
    /** Upper bound the customer authorises, in paise. */
    maxAmountPaise: number;
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

  async createMandate() {
    return { redirectUrl: null, reference: `manual_${Date.now()}` };
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
    // case "razorpay": return razorpayProvider;
    default:
      return manualProvider;
  }
}

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
    gstin: process.env.INVOICE_SELLER_GSTIN ?? null,
    address: process.env.INVOICE_SELLER_ADDRESS ?? "",
    state: process.env.INVOICE_SELLER_STATE ?? "Karnataka",
    invoicePrefix: process.env.INVOICE_NUMBER_PREFIX ?? "PMT",
  };
}
