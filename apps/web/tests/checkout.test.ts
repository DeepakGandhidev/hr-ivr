import { describe, expect, it } from "vitest";
import { normalisePhone, proratedUpgradePaise } from "@/lib/checkout";

describe("upgrade proration", () => {
  const period = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-31T00:00:00Z") };

  it("charges the price difference for the part of the period left", () => {
    // Halfway through a 30 day period, Starter (4,999) to Growth (12,999).
    expect(proratedUpgradePaise(4999, 12999, period, new Date("2026-10-16T00:00:00Z"))).toBe(400_000);
  });

  it("charges the whole difference at the start of the period", () => {
    expect(proratedUpgradePaise(4999, 12999, period, period.start)).toBe(800_000);
  });

  it("charges nothing for a downgrade or after the period ended", () => {
    expect(proratedUpgradePaise(12999, 4999, period, period.start)).toBe(0);
    expect(proratedUpgradePaise(4999, 12999, period, new Date("2026-11-05T00:00:00Z"))).toBe(0);
  });
});

describe("phone numbers", () => {
  it("accepts Indian mobiles in the usual shapes", () => {
    expect(normalisePhone("98765 43210")).toBe("9876543210");
    expect(normalisePhone("+91 98765-43210")).toBe("9876543210");
    expect(normalisePhone("919876543210")).toBe("9876543210");
  });

  it("refuses anything else", () => {
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("5876543210")).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });
});
