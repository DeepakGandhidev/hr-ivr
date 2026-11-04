import { NextRequest, NextResponse } from "next/server";
import { invoiceIdFromPaymentId, verifyCashfreeWebhook } from "@/lib/cashfree";
import { settleCharge, updateMandate } from "@/lib/autopay";
import { applyPaidOrder } from "@/lib/checkout";
import { notifyCheckoutFailed } from "@/lib/billing-emails";

export const runtime = "nodejs";

interface WebhookBody {
  type?: string;
  data?: {
    payment_id?: string;
    cf_payment_id?: string | number;
    subscription_id?: string;
    payment_type?: string;
    payment_status?: string;
    failure_details?: { failure_reason?: string } | null;
    authorization_details?: { authorization_status?: string | null; payment_group?: string | null } | null;
    subscription_details?: { subscription_id?: string; subscription_status?: string } | null;
    /** One-time checkout (PG) events carry the order and payment here. */
    order?: { order_id?: string } | null;
    payment?: {
      cf_payment_id?: string | number;
      payment_status?: string;
      payment_group?: string | null;
      payment_message?: string | null;
    } | null;
  };
}

/**
 * Cashfree Subscriptions webhooks.
 *
 * Public (no session), so the signature is the only thing that makes a body
 * believable: it is checked against the raw bytes before anything is parsed.
 * Every handler is idempotent, because Cashfree retries until it sees a 200.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (
    !verifyCashfreeWebhook(raw, request.headers.get("x-webhook-signature"), request.headers.get("x-webhook-timestamp"))
  ) {
    console.warn("[cashfree] webhook with a bad or missing signature refused");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const data = body.data ?? {};

  try {
    switch (body.type) {
      case "SUBSCRIPTION_STATUS_CHANGED": {
        const ref = data.subscription_details?.subscription_id ?? data.subscription_id;
        const status = data.subscription_details?.subscription_status;
        if (ref && status) {
          await updateMandate(
            ref,
            status,
            data.authorization_details?.authorization_status,
            data.authorization_details?.payment_group
          );
        }
        break;
      }

      case "SUBSCRIPTION_AUTH_STATUS": {
        const ref = data.subscription_id;
        const auth = data.authorization_details?.authorization_status ?? data.payment_status;
        if (ref && auth) {
          // An authorised mandate reads ACTIVE; anything else maps through the auth status.
          const status = auth.toUpperCase() === "ACTIVE" || data.payment_status === "SUCCESS" ? "ACTIVE" : "PENDING";
          await updateMandate(ref, status, auth, data.authorization_details?.payment_group);
        }
        break;
      }

      case "SUBSCRIPTION_PAYMENT_SUCCESS":
      case "SUBSCRIPTION_PAYMENT_FAILED":
      case "SUBSCRIPTION_PAYMENT_CANCELLED": {
        // The authorisation's own rupee also arrives here; only charges settle invoices.
        if (data.payment_type && data.payment_type !== "CHARGE") break;
        if (!data.payment_id) break;
        await settleCharge({
          invoiceId: invoiceIdFromPaymentId(data.payment_id),
          outcome: body.type === "SUBSCRIPTION_PAYMENT_SUCCESS" ? "success" : "failed",
          reference: String(data.cf_payment_id ?? data.payment_id),
          paymentGroup: data.authorization_details?.payment_group,
          failureReason:
            body.type === "SUBSCRIPTION_PAYMENT_CANCELLED"
              ? "The debit was cancelled."
              : data.failure_details?.failure_reason,
        });
        break;
      }

      // One-time checkouts: top-ups and plan upgrades (lib/checkout.ts).
      case "PAYMENT_SUCCESS_WEBHOOK": {
        const orderId = data.order?.order_id;
        if (orderId && data.payment?.payment_status === "SUCCESS") {
          await applyPaidOrder(orderId, {
            reference: String(data.payment.cf_payment_id ?? orderId),
            paymentGroup: data.payment.payment_group,
          });
        }
        break;
      }

      // A checkout payment the bank or card refused. The order stays open (the
      // customer may retry on the same page; only its expiry fails it), but
      // they are told, once per order. Never throws.
      case "PAYMENT_FAILED_WEBHOOK": {
        const orderId = data.order?.order_id;
        if (orderId) await notifyCheckoutFailed(orderId, data.payment?.payment_message);
        break;
      }
      default:
        // Pre-debit notices, refunds, card expiry reminders, and dropped
        // checkout attempts: acknowledged.
        break;
    }
  } catch (err) {
    // A 500 makes Cashfree retry, which is what an unprocessed event needs.
    console.error(`[cashfree] webhook ${body.type} failed`, err);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
