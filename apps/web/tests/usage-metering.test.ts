import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOrCreateUsageMeter, incrementScreeningUsage, incrementInterviewUsage } from "@/lib/billing";

/**
 * These helpers take the tenant-scoped transaction client rather than a
 * module-level one: under RLS an unscoped write affects no rows and throws
 * nothing, so metering would silently stop counting.
 */
const tx = {
  usageMeter: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
} as any;

function meter(overrides = {}) {
  return {
    id: "um-1",
    tenantId: "tenant-1",
    period: "2026-09",
    interviewsUsed: 0,
    screeningsUsed: 0,
    overageInterviews: 0,
    overageScreenings: 0,
    ...overrides,
  };
}

describe("Usage metering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a usage meter if none exists", async () => {
    tx.usageMeter.findUnique.mockResolvedValue(null);
    tx.usageMeter.create.mockResolvedValue(meter());
    await getOrCreateUsageMeter(tx, "tenant-1", "2026-09");
    expect(tx.usageMeter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { tenantId: "tenant-1", period: "2026-09" },
      })
    );
  });

  it("increments screening usage within quota", async () => {
    tx.usageMeter.findUnique.mockResolvedValue(meter({ screeningsUsed: 5 }));
    tx.usageMeter.update.mockResolvedValue(meter({ screeningsUsed: 6 }));

    const result = await incrementScreeningUsage(tx, "tenant-1", 100);
    expect(result.ok).toBe(true);
    expect(result.overage).toBe(false);
    expect(tx.usageMeter.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { screeningsUsed: { increment: 1 } } })
    );
  });

  it("records overage when screening quota is exhausted", async () => {
    tx.usageMeter.findUnique.mockResolvedValue(meter({ screeningsUsed: 100 }));
    tx.usageMeter.update.mockResolvedValue(meter({ screeningsUsed: 100, overageScreenings: 1 }));

    const result = await incrementScreeningUsage(tx, "tenant-1", 100);
    expect(result.ok).toBe(true);
    expect(result.overage).toBe(true);
  });

  it("increments interview usage", async () => {
    tx.usageMeter.findUnique.mockResolvedValue(meter({ interviewsUsed: 2 }));
    tx.usageMeter.update.mockResolvedValue(meter({ interviewsUsed: 3 }));

    const result = await incrementInterviewUsage(tx, "tenant-1", 15);
    expect(result.ok).toBe(true);
    expect(result.overage).toBe(false);
  });

  it("treats an unlimited plan as never in overage", async () => {
    tx.usageMeter.findUnique.mockResolvedValue(meter({ interviewsUsed: 9999 }));
    tx.usageMeter.update.mockResolvedValue(meter({ interviewsUsed: 10000 }));

    const result = await incrementInterviewUsage(tx, "tenant-1", null);
    expect(result.overage).toBe(false);
  });
});
