import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Billing emails against a fake database: who receives each one (the billing
 * contact unless they switched it off, else the owner), its dedupe key, and
 * that the settlement paths send them after their transaction.
 */

const prisma = vi.hoisted(() => ({
  subscription: { findUnique: vi.fn() },
  user: { findFirst: vi.fn() },
  invoice: { findUnique: vi.fn() },
  payment: { findUnique: vi.fn() },
  checkoutOrder: { findUnique: vi.fn() },
  tenant: { findUnique: vi.fn() },
  plan: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@pratibha/prisma", () => ({ adminPrisma: prisma }));

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ sendEmail }));

import {
  billingRecipient,
  notifyCheckoutFailed,
  notifyInvoiceIssued,
  notifyPaymentFailed,
  notifyPlanChanged,
} from "@/lib/billing-emails";
import { settleCharge } from "@/lib/autopay";

const tenant = { id: "t1", name: "Acme", slug: "acme", status: "active", planId: "plan_starter" };
const invoice = {
  id: "inv1",
  number: "PMT/2026-27/0007",
  status: "paid",
  totalPaise: 589_882,
  periodStart: new Date("2026-10-01T00:00:00Z"),
  periodEnd: new Date("2026-11-01T00:00:00Z"),
  lines: [{ description: "Growth plan, monthly" }],
  subscription: { tenantId: "t1", tenant },
};

function contact(email: string | null, prefs: Record<string, boolean> | null = null) {
  prisma.subscription.findUnique.mockResolvedValue({ billingContactEmail: email, billingContactPrefs: prefs });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findFirst.mockResolvedValue({ email: "owner@acme.test" });
  sendEmail.mockResolvedValue({ ok: true });
  contact("finance@acme.test");
});

describe("billingRecipient", () => {
  it("is the billing contact when there is one", async () => {
    expect(await billingRecipient("t1", "invoice_issued")).toBe("finance@acme.test");
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the owner when there is no contact", async () => {
    contact(null);
    expect(await billingRecipient("t1", "invoice_issued")).toBe("owner@acme.test");
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", role: "owner", removedAt: null } })
    );
  });

  it("falls back to the owner for an email the contact switched off, and only that one", async () => {
    contact("finance@acme.test", { invoice_issued: false });
    expect(await billingRecipient("t1", "invoice_issued")).toBe("owner@acme.test");
    expect(await billingRecipient("t1", "payment_failed")).toBe("finance@acme.test");
  });

  it("is nobody when there is neither", async () => {
    contact(null);
    prisma.user.findFirst.mockResolvedValue(null);
    expect(await billingRecipient("t1", "plan_changed")).toBeNull();
  });
});

describe("invoice_issued", () => {
  it("sends the number, amount with GST, period and link, once per invoice", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice);
    expect(await notifyInvoiceIssued("inv1")).toBe(true);

    const mail = sendEmail.mock.calls[0][0];
    expect(mail).toMatchObject({
      kind: "invoice_issued",
      tenantId: "t1",
      to: "finance@acme.test",
      dedupeKey: "invoice_issued:inv1",
    });
    expect(mail.subject).toContain("PMT/2026-27/0007");
    expect(mail.body).toContain("₹5,898.82");
    expect(mail.body).toContain("1 Oct 2026 – 1 Nov 2026");
    expect(mail.body).toMatch(/\/acme\/settings\/subscription\/invoices\/inv1$/m);
  });

  it("is not sent for an invoice that is not paid", async () => {
    prisma.invoice.findUnique.mockResolvedValue({ ...invoice, status: "issued" });
    expect(await notifyInvoiceIssued("inv1")).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when the mail does", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice);
    sendEmail.mockRejectedValue(new Error("smtp down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyInvoiceIssued("inv1")).resolves.toBe(false);
  });
});

describe("payment_failed", () => {
  it("for AutoPay: amount, reason and the retry window, keyed on the ledger row", async () => {
    contact(null);
    prisma.payment.findUnique.mockResolvedValue({
      id: "pay1",
      status: "failed",
      reason: "Insufficient funds",
      retryAt: new Date("2026-10-02T00:00:00Z"),
      invoice: { ...invoice, status: "issued" },
    });
    expect(await notifyPaymentFailed("inv1")).toBe(true);

    const mail = sendEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ kind: "payment_failed", to: "owner@acme.test", dedupeKey: "payment_failed:pay1" });
    expect(mail.body).toContain("₹5,898.82");
    expect(mail.body).toContain("Insufficient funds");
    // Seven days (billing.renewal_retry_days) after the period began.
    expect(mail.body).toContain("until 8 Oct 2026");
    expect(mail.body).toMatch(/\/acme\/settings\/subscription$/m);
  });

  it("says no more attempts once the retries are over", async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: "pay1",
      status: "failed",
      reason: null,
      retryAt: null,
      invoice: { ...invoice, status: "issued" },
    });
    await notifyPaymentFailed("inv1");
    expect(sendEmail.mock.calls[0][0].body).toContain("No further automatic attempts");
  });

  it("for a checkout: once per order, and not at all if the order was paid after all", async () => {
    prisma.checkoutOrder.findUnique.mockResolvedValue({ orderId: "pra_order1", tenantId: "t1", invoiceId: "inv1", status: "pending" });
    prisma.invoice.findUnique.mockResolvedValue({ ...invoice, status: "issued" });
    expect(await notifyCheckoutFailed("pra_order1", "Card declined")).toBe(true);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ kind: "payment_failed", to: "finance@acme.test", dedupeKey: "payment_failed:pra_order1" });
    expect(mail.body).toContain("Card declined");
    expect(mail.body).toContain("Nothing was charged");

    sendEmail.mockClear();
    prisma.checkoutOrder.findUnique.mockResolvedValue({ orderId: "pra_order1", tenantId: "t1", invoiceId: "inv1", status: "paid" });
    expect(await notifyCheckoutFailed("pra_order1")).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("plan_changed", () => {
  it("names both plans and the date, keyed on the workspace, plan and minute", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ name: "Acme", slug: "acme" });
    prisma.plan.findMany.mockResolvedValue([
      { id: "plan_starter", name: "Starter" },
      { id: "plan_growth", name: "Growth" },
    ]);
    const at = new Date("2026-10-17T06:42:31Z");
    expect(await notifyPlanChanged({ tenantId: "t1", fromPlanId: "plan_starter", toPlanId: "plan_growth", at })).toBe(true);

    const mail = sendEmail.mock.calls[0][0];
    expect(mail).toMatchObject({
      kind: "plan_changed",
      to: "finance@acme.test",
      dedupeKey: "plan_changed:t1:plan_growth:2026-10-17T06:42",
    });
    expect(mail.subject).toContain("Growth");
    expect(mail.body).toContain("from Starter to Growth, effective 17 Oct 2026");
  });

  it("calls the old plan Trial when the workspace was on its trial", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ name: "Acme", slug: "acme" });
    prisma.plan.findMany.mockResolvedValue([{ id: "plan_growth", name: "Growth" }]);
    await notifyPlanChanged({ tenantId: "t1", fromPlanId: null, toPlanId: "plan_growth" });
    expect(sendEmail.mock.calls[0][0].body).toContain("from Trial to Growth");
  });
});

describe("AutoPay settlement sends after its transaction", () => {
  function fakeDb(order: string[]) {
    return {
      invoice: {
        findUnique: vi.fn().mockResolvedValue({ ...invoice, status: "issued", subscription: { ...invoice.subscription, id: "s1", renewalInvoiceId: null } }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...invoice, status: "issued", subscription: { id: "s1", renewalInvoiceId: null, periodEnd: new Date("2026-11-01T00:00:00Z") } }),
        update: vi.fn(),
      },
      payment: { upsert: vi.fn() },
      subscription: { update: vi.fn() },
      tenant: { update: vi.fn() },
      auditLog: { create: vi.fn(async () => void order.push("audit")) },
    };
  }

  it("a captured charge mails the invoice", async () => {
    const order: string[] = [];
    prisma.$transaction.mockImplementation(async (cb: (db: unknown) => unknown) => {
      const r = await cb(fakeDb(order));
      order.push("commit");
      return r;
    });
    prisma.invoice.findUnique.mockResolvedValue(invoice);
    sendEmail.mockImplementation(async () => (order.push("mail"), { ok: true }));

    await settleCharge({ invoiceId: "inv1", outcome: "success", reference: "cf_1" });

    expect(order).toEqual(["audit", "commit", "mail"]);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ kind: "invoice_issued", dedupeKey: "invoice_issued:inv1" });
  });

  it("a refused charge mails the failure", async () => {
    const order: string[] = [];
    prisma.$transaction.mockImplementation(async (cb: (db: unknown) => unknown) => {
      const r = await cb(fakeDb(order));
      order.push("commit");
      return r;
    });
    prisma.payment.findUnique.mockResolvedValue({
      id: "pay9",
      status: "failed",
      reason: "Mandate revoked",
      retryAt: null,
      invoice: { ...invoice, status: "issued" },
    });
    sendEmail.mockImplementation(async () => (order.push("mail"), { ok: true }));

    await settleCharge({ invoiceId: "inv1", outcome: "failed", reference: "cf_1", failureReason: "Mandate revoked" });

    expect(order).toEqual(["audit", "commit", "mail"]);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ kind: "payment_failed", dedupeKey: "payment_failed:pay9" });
  });

  it("a settlement that changed nothing sends nothing", async () => {
    prisma.$transaction.mockImplementation(async (cb: (db: unknown) => unknown) =>
      cb({ invoice: { findUnique: vi.fn().mockResolvedValue({ ...invoice, status: "paid" }) } })
    );
    await settleCharge({ invoiceId: "inv1", outcome: "success", reference: "cf_1" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
