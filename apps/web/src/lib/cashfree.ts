import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cashfree Subscriptions, the small part of it Pratibha uses: an ON_DEMAND
 * mandate the customer authorises once (UPI AutoPay, eNACH or card), and
 * charges raised against it when a period renews or a pack is bought.
 *
 * ON_DEMAND rather than PERIODIC because the amount moves: plan changes, coupons
 * and top-ups all change what is owed, and a periodic plan would charge a fixed
 * figure on its own schedule regardless of what the invoice says.
 *
 * Raw fetch rather than the SDK: four calls do not justify a dependency that
 * has to be installed on the server by hand.
 */

export type CashfreeMode = "sandbox" | "production";

export interface CashfreeConfig {
  mode: CashfreeMode;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

/** Null when the keys are not set, so a missing key degrades to manual billing. */
export function cashfreeConfig(): CashfreeConfig | null {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    mode: process.env.CASHFREE_ENV === "production" ? "production" : "sandbox",
    clientId,
    clientSecret,
    apiVersion: process.env.CASHFREE_API_VERSION ?? "2025-01-01",
  };
}

export class CashfreeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "CashfreeError";
  }
}

export async function cashfreeRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {}
): Promise<T> {
  const config = cashfreeConfig();
  if (!config) throw new Error("Cashfree is not configured");

  const base = config.mode === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-version": config.apiVersion,
      "x-client-id": config.clientId,
      "x-client-secret": config.clientSecret,
      ...(opts.idempotencyKey ? { "x-idempotency-key": opts.idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json as { message?: string } | null)?.message ?? `Cashfree returned ${res.status}`;
    throw new CashfreeError(message, res.status, json);
  }
  return json as T;
}

export interface CashfreeSubscription {
  subscription_id: string;
  cf_subscription_id: string;
  subscription_status: string;
  subscription_session_id?: string;
  authorisation_details?: {
    authorization_status?: string | null;
    payment_group?: string | null;
  } | null;
}

export interface CashfreePayment {
  cf_payment_id: string;
  payment_id: string;
  payment_status: string;
  failure_details?: { failure_reason?: string } | null;
}

/** Cashfree takes rupees as a decimal; Pratibha keeps paise as integers. */
export function rupees(paise: number): number {
  return Math.round(paise) / 100;
}

/**
 * A charge's Cashfree payment id is `<invoiceId>-<attempt stamp>`: unique per
 * attempt, as Cashfree requires, while the invoice it settles stays readable
 * from it. Invoice ids are cuids, which never contain a hyphen.
 */
export function chargePaymentId(invoiceId: string, at: Date = new Date()): string {
  return `${invoiceId}-${at.getTime()}`;
}

export function invoiceIdFromPaymentId(paymentId: string): string {
  return paymentId.split("-")[0];
}

/**
 * Webhook signature: base64 HMAC-SHA256 of timestamp + raw body, keyed with the
 * client secret. Checked against the raw body as received; re-serialised JSON
 * would not match. Timestamps older than five minutes are refused as replays.
 */
export function verifyCashfreeWebhook(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  now: number = Date.now()
): boolean {
  const config = cashfreeConfig();
  if (!config || !signature || !timestamp) return false;

  // Sent in milliseconds; seconds are accepted too rather than refused as stale.
  const raw = Number(timestamp);
  const ts = raw < 1e12 ? raw * 1000 : raw;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60_000) return false;

  const expected = createHmac("sha256", config.clientSecret).update(timestamp + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What the payment_group of an authorised mandate is called in the ledger. */
export function ledgerMethod(paymentGroup: string | null | undefined): string {
  const g = (paymentGroup ?? "").toLowerCase();
  if (g.includes("upi")) return "upi";
  if (g.includes("card")) return "card";
  if (g.includes("nach") || g.includes("bank")) return "bank_transfer";
  return "upi";
}
