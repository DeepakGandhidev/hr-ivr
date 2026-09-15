import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Action, UserRole, can } from "@pratibha/shared";
import { daysRemaining, planComparison, TOP_UP_PACKS } from "@/lib/subscription";
import { manualProvider, paymentProvider } from "@/lib/payments";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(APP_ROOT, p), "utf8");

/**
 * "All billing actions — plan changes, payment method, cancellation — are
 * restricted to the owner role only."
 */
describe("billing is owner only", () => {
  it("lets only the owner manage billing", () => {
    expect(can(UserRole.owner, Action.billingManage)).toBe(true);
    expect(can(UserRole.admin, Action.billingManage)).toBe(false);
    expect(can(UserRole.reviewer, Action.billingManage)).toBe(false);
    expect(can(UserRole.viewer, Action.billingManage)).toBe(false);
  });

  // Seeing how many minutes are left is operational, not financial.
  it("lets an admin read the meter", () => {
    expect(can(UserRole.admin, Action.billingRead)).toBe(true);
    expect(can(UserRole.reviewer, Action.billingRead)).toBe(false);
  });

  // The frontend hiding a button is a convenience; this is the check.
  const mutating = [
    "src/app/api/[tenant]/subscription/plan/route.ts",
    "src/app/api/[tenant]/subscription/cancel/route.ts",
    "src/app/api/[tenant]/subscription/coupon/route.ts",
    "src/app/api/[tenant]/subscription/top-up/route.ts",
    "src/app/api/[tenant]/subscription/billing-contact/route.ts",
  ];

  for (const file of mutating) {
    it(`enforces billingManage server-side in ${path.basename(path.dirname(file))}`, () => {
      const source = read(file);
      const writes = source.match(/export async function (POST|PATCH|DELETE)/g) ?? [];
      expect(writes.length).toBeGreaterThan(0);
      expect(source).toContain("Action.billingManage");
    });
  }
});

describe("cycle", () => {
  it("counts whole days to the period end", () => {
    const now = new Date("2026-09-14T00:00:00Z");
    expect(daysRemaining(new Date("2026-09-24T00:00:00Z"), now)).toBe(10);
  });

  // A finished period shows nothing left, never a negative countdown.
  it("never goes negative", () => {
    const now = new Date("2026-09-14T00:00:00Z");
    expect(daysRemaining(new Date("2026-09-01T00:00:00Z"), now)).toBe(0);
  });
});

describe("plan comparison", () => {
  it("names the direction of a change", () => {
    expect(planComparison("starter", "growth", 0)?.direction).toBe("upgrade");
    expect(planComparison("scale", "starter", 0)?.direction).toBe("downgrade");
  });

  // A downgrade can put a customer below what they have already spent this
  // period. Better said before the change than discovered at a failed call.
  it("warns when the new ceiling is already behind them", () => {
    const down = planComparison("scale", "starter", 900);
    expect(down?.alreadyOverTarget).toBe(true);
    expect(planComparison("scale", "starter", 10)?.alreadyOverTarget).toBe(false);
  });

  it("refuses an unknown plan", () => {
    expect(planComparison("starter", "enterprise", 0)).toBe(null);
  });
});

/**
 * The stub must never claim to have taken money. An invoice marked paid against
 * money nobody collected is the worst possible failure for a billing system.
 */
describe("the stubbed gateway", () => {
  it("says it cannot charge", () => {
    expect(manualProvider.canCharge).toBe(false);
    expect(paymentProvider().canCharge).toBe(false);
  });

  it("refuses a charge, with a reason", async () => {
    const result = await manualProvider.charge({
      mandateReference: "x",
      amountPaise: 100,
      description: "test",
      idempotencyKey: "k",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No payment gateway");
  });

  it("falls back to manual rather than throwing on an unknown provider", () => {
    const previous = process.env.PAYMENT_PROVIDER;
    process.env.PAYMENT_PROVIDER = "not-a-real-gateway";
    expect(paymentProvider().name).toBe("manual");
    process.env.PAYMENT_PROVIDER = previous;
  });
});

describe("top-ups", () => {
  it("raises an invoice even when nothing can be charged", () => {
    const route = read("src/app/api/[tenant]/subscription/top-up/route.ts");
    expect(route).toContain("db.invoice.create");
    expect(route).toContain('status: "issued"');
  });

  // Two simultaneous top-ups must not take the same number; a gap in the
  // series is a question an auditor asks.
  it("numbers inside the transaction that inserts", () => {
    const route = read("src/app/api/[tenant]/subscription/top-up/route.ts");
    const count = route.indexOf("db.invoice.count");
    const create = route.indexOf("db.invoice.create");
    expect(count).toBeGreaterThan(-1);
    expect(count).toBeLessThan(create);
  });

  it("only sells published packs", () => {
    expect(TOP_UP_PACKS.every((p) => p.minutes > 0 && p.pricePaise > 0)).toBe(true);
  });
});

/**
 * An invoice records what was true when issued. If a customer corrects their
 * GSTIN, or we move selling entity, last quarter's invoice must not change.
 */
describe("invoices snapshot both parties", () => {
  const route = read("src/app/api/[tenant]/subscription/top-up/route.ts");

  it("stores the seller and buyer on the row", () => {
    expect(route).toContain("seller: { ...seller }");
    expect(route).toContain("buyer: {");
  });

  it("records the place of supply rather than recomputing it later", () => {
    expect(route).toContain("placeOfSupply");
  });
});

describe("cancellation", () => {
  const route = read("src/app/api/[tenant]/subscription/cancel/route.ts");

  // They paid for the period; ending access on click takes something they own.
  it("ends at period end, not immediately", () => {
    expect(route).toContain("cancelRequestedAt");
    expect(route).toContain('status: "cancelling"');
  });

  it("requires and stores a reason", () => {
    expect(route).toContain("cancelReason");
    expect(route).toContain("CANCEL_REASONS");
  });

  // Defined once in the lib and imported, so the API, the page and the
  // cancellation dialog cannot state different consequences.
  it("states the data consequences in one place", () => {
    expect(route).toContain("DATA_CONSEQUENCES");
    const lib = read("src/lib/subscription.ts");
    expect(lib).toContain("deletedAfterDays: 30");
    expect(lib).toContain("readOnlyAfterExpiry: true");
  });
});

/**
 * Coupon codes are meant to be typed off a slide, so they are guessable.
 * Different refusals for "used" and "no such code" would enumerate live codes.
 */
describe("coupon refusals do not leak", () => {
  const route = read("src/app/api/[tenant]/subscription/coupon/route.ts");

  it("returns one message for every refusal", () => {
    const refusals = route.match(/return refuse\(\)/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(4);
    expect(route.match(/COUPON_INVALID/g)?.length).toBe(1);
  });
});
