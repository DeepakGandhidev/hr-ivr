import { describe, expect, it } from "vitest";
import { describeCoupon, effectiveStatus } from "@/lib/coupons";

const now = new Date("2026-10-10T00:00:00Z");
const day = 86_400_000;

describe("coupon lifecycle", () => {
  it("a scheduled code is scheduled until its start, then active", () => {
    const c = { status: "scheduled" as const, startsAt: new Date(now.getTime() + day), expiresAt: null };
    expect(effectiveStatus(c, now)).toBe("scheduled");
    expect(effectiveStatus(c, new Date(now.getTime() + 2 * day))).toBe("active");
  });

  it("an active code past its expiry is ended", () => {
    expect(effectiveStatus({ status: "active", startsAt: null, expiresAt: new Date(now.getTime() - 1) }, now)).toBe("ended");
  });

  it("paused, draft and ended are what they say, whatever the dates", () => {
    for (const status of ["paused", "draft", "ended"] as const) {
      expect(effectiveStatus({ status, startsAt: null, expiresAt: null }, now)).toBe(status);
    }
  });

  it("describes what it does", () => {
    expect(describeCoupon({ kind: "percent", value: 20 })).toBe("20% off the first invoice");
    expect(describeCoupon({ kind: "amount", value: 200000 })).toBe("₹2,000 off the first invoice");
  });
});
