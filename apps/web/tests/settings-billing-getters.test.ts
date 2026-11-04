import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approximateInterviews,
  calculateInvoice,
  createJobSchema,
  gstRatePercent,
  interviewOptionsFrom,
  interviewProtocolSchema,
  maxCustomQuestions,
  maxCvFileBytes,
  MAX_CV_FILE_BYTES,
  quotaState,
  quotaWarningThresholds,
  sacCode,
} from "@pratibha/shared";
import { __resetSettingsRuntime, startSettings, type SettingRow } from "@pratibha/shared/settings-runtime";

/**
 * Billing and interview defaults follow the admin panel: with nothing saved
 * they are exactly the old constants, and a saved value takes over at the
 * moment of use, without a restart.
 */

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY ??= "b".repeat(64);
});

afterEach(() => __resetSettingsRuntime());

function panel(rows: Record<string, unknown>) {
  const load = async (): Promise<SettingRow[]> => Object.entries(rows).map(([key, value]) => ({ key, value }));
  return startSettings({ app: "web", load, intervalMs: 60_000 });
}

const lines = [{ description: "Growth plan", quantity: 1, unitPaise: 1_000_000 }];

describe("with nothing saved", () => {
  it("keeps the old figures", () => {
    expect(gstRatePercent()).toBe(18);
    expect(sacCode()).toBe("998319");
    expect(quotaWarningThresholds()).toEqual([0.8, 1]);
    expect(maxCustomQuestions()).toBe(3);
    expect(maxCvFileBytes()).toBe(MAX_CV_FILE_BYTES);
    expect(interviewOptionsFrom(null)).toMatchObject({
      minQuestions: 6,
      maxQuestions: 10,
      hearBackDays: 3,
      difficulty: "moderate",
      durationMinutes: 10,
    });
  });

  it("records the rate on every invoice line", () => {
    const inv = calculateInvoice({ lines, sellerState: "Karnataka", buyerState: "Delhi" });
    expect(inv.ratePercent).toBe(18);
    expect(inv.lines[0].gstRatePercent).toBe(18);
    expect(inv.tax.igstPaise).toBe(180_000);
  });
});

describe("with values saved in the panel", () => {
  it("taxes new invoices at the saved rate and SAC, and says so on the line", async () => {
    await panel({ "billing.gst_rate_percent": 12, "billing.sac_code": "998314" });
    const inv = calculateInvoice({ lines, sellerState: "Karnataka", buyerState: "Karnataka" });
    expect(inv.tax.cgstPaise + inv.tax.sgstPaise).toBe(120_000);
    expect(inv.totalPaise).toBe(1_120_000);
    expect(inv.lines[0]).toMatchObject({ hsnSac: "998314", gstRatePercent: 12 });
  });

  it("moves the quota warning, and the interview estimate", async () => {
    await panel({
      "billing.quota_warning_percent": 90,
      "billing.average_interview_minutes": 7,
    });
    expect(quotaState(85, 100).level).toBe(null);
    expect(quotaState(90, 100).level).toBe("warning");
    expect(approximateInterviews(70)).toBe(10);
  });

  it("applies job limits when a request is parsed, not when the schema was built", async () => {
    await panel({ "limits.must_haves_max": 2, "interview.max_custom_questions": 1, "limits.cv_max_mb": 2 });
    expect(createJobSchema.safeParse({ title: "Engineer", mustHaves: ["a", "b"] }).success).toBe(true);
    expect(createJobSchema.safeParse({ title: "Engineer", mustHaves: ["a", "b", "c"] }).success).toBe(false);
    const custom = interviewProtocolSchema.safeParse({ customQuestions: ["a?", "b?"] });
    expect(custom.success).toBe(false);
    expect(custom.success ? "" : custom.error.issues[0].message).toBe("One question at most.");
    expect(maxCvFileBytes()).toBe(2 * 1024 * 1024);
  });

  it("fills a protocol's missing fields from the panel's defaults", async () => {
    await panel({
      "interview.default_min_questions": 4,
      "interview.default_hear_back_days": 5,
      "interview.default_difficulty": "hard",
      "calls.default_duration_minutes": 15,
    });
    expect(interviewOptionsFrom(null)).toMatchObject({
      minQuestions: 4,
      maxQuestions: 10,
      hearBackDays: 5,
      difficulty: "hard",
      durationMinutes: 15,
    });
    // A saved protocol keeps what it was written with.
    expect(interviewOptionsFrom({ minQuestions: 8, durationMinutes: 20 })).toMatchObject({ minQuestions: 8, durationMinutes: 20 });
  });

  it("ignores an out-of-range saved value and goes back to the default once cleared", async () => {
    await panel({ "billing.quota_warning_percent": 5, "billing.gst_rate_percent": 5 });
    expect(quotaWarningThresholds()).toEqual([0.8, 1]);
    expect(gstRatePercent()).toBe(5);
    __resetSettingsRuntime();
    expect(gstRatePercent()).toBe(18);
  });
});
