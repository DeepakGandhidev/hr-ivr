import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chargePaymentId,
  invoiceIdFromPaymentId,
  ledgerMethod,
  rupees,
  verifyCashfreeWebhook,
} from "@/lib/cashfree";
import { debitDate, mandateStatusFrom, nextPeriodEnd } from "@/lib/autopay";
import { cashfreeProvider, manualProvider, paymentProvider } from "@/lib/payments";

const SECRET = "cfsk_test_secret";
const saved = { ...process.env };

beforeEach(() => {
  process.env.CASHFREE_CLIENT_ID = "test_id";
  process.env.CASHFREE_CLIENT_SECRET = SECRET;
});
afterEach(() => {
  process.env = { ...saved };
});

function sign(ts: string, body: string) {
  return createHmac("sha256", SECRET).update(ts + body).digest("base64");
}

describe("webhook signature", () => {
  const body = '{"type":"SUBSCRIPTION_PAYMENT_SUCCESS","data":{}}';
  const now = 1_760_000_000_000;

  it("accepts a body signed with the client secret", () => {
    const ts = String(now);
    expect(verifyCashfreeWebhook(body, sign(ts, body), ts, now)).toBe(true);
  });

  it("refuses a body changed after signing", () => {
    const ts = String(now);
    expect(verifyCashfreeWebhook(body.replace("SUCCESS", "FAILED"), sign(ts, body), ts, now)).toBe(false);
  });

  it("refuses a replay older than five minutes", () => {
    const ts = String(now - 6 * 60_000);
    expect(verifyCashfreeWebhook(body, sign(ts, body), ts, now)).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    delete process.env.CASHFREE_CLIENT_SECRET;
    const ts = String(now);
    expect(verifyCashfreeWebhook(body, sign(ts, body), ts, now)).toBe(false);
  });

  it("refuses a missing signature", () => {
    expect(verifyCashfreeWebhook(body, null, String(now), now)).toBe(false);
  });
});

describe("charge ids", () => {
  it("round-trip to the invoice they settle", () => {
    const id = chargePaymentId("clx9abc123", new Date(1_760_000_000_000));
    expect(id).toBe("clx9abc123-1760000000000");
    expect(invoiceIdFromPaymentId(id)).toBe("clx9abc123");
  });

  it("send rupees, not paise", () => {
    expect(rupees(149_900)).toBe(1499);
    expect(rupees(176_882)).toBe(1768.82);
  });
});

describe("mandate states", () => {
  it("maps Cashfree's subscription states to ours", () => {
    expect(mandateStatusFrom("ACTIVE")).toBe("active");
    expect(mandateStatusFrom("BANK_APPROVAL_PENDING")).toBe("pending");
    expect(mandateStatusFrom("CUSTOMER_CANCELLED")).toBe("revoked");
    expect(mandateStatusFrom("LINK_EXPIRED")).toBe("failed");
    expect(mandateStatusFrom("PENDING", "FAILED")).toBe("failed");
    expect(mandateStatusFrom("ON_HOLD")).toBeNull();
  });

  it("names the ledger method from the payment group", () => {
    expect(ledgerMethod("upi")).toBe("upi");
    expect(ledgerMethod("credit_card")).toBe("card");
    expect(ledgerMethod("enach")).toBe("bank_transfer");
  });
});

describe("renewal dates", () => {
  it("never debits inside the pre-debit notice", () => {
    const now = new Date("2026-10-09T10:00:00Z");
    expect(debitDate(new Date("2026-10-09T12:00:00Z"), now).getTime()).toBe(now.getTime() + 26 * 3_600_000);
    const later = new Date("2026-10-12T00:00:00Z");
    expect(debitDate(later, now)).toEqual(later);
  });

  it("rolls a period by one month", () => {
    expect(nextPeriodEnd(new Date("2026-10-09T00:00:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
});

describe("provider selection", () => {
  it("uses Cashfree when selected and keyed", () => {
    process.env.PAYMENT_PROVIDER = "cashfree";
    expect(paymentProvider()).toBe(cashfreeProvider);
  });

  it("falls back to manual when Cashfree is selected without keys", () => {
    process.env.PAYMENT_PROVIDER = "cashfree";
    delete process.env.CASHFREE_CLIENT_SECRET;
    expect(paymentProvider()).toBe(manualProvider);
  });
});
