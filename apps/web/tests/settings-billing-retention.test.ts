import { afterEach, describe, expect, it } from "vitest";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { DATA_CONSEQUENCES } from "@/lib/subscription";

/**
 * The cancellation dialog's "deleted N days later" comes from the panel, and
 * every response that serialises DATA_CONSEQUENCES states the current figure.
 */
afterEach(() => __resetSettingsRuntime());

describe("data retention after cancelling", () => {
  it("is 30 days with nothing saved", () => {
    expect(JSON.parse(JSON.stringify(DATA_CONSEQUENCES))).toEqual({ readOnlyAfterExpiry: true, deletedAfterDays: 30 });
  });

  it("follows billing.data_retention_days", async () => {
    await startSettings({
      app: "web",
      load: async () => [{ key: "billing.data_retention_days", value: 60 }],
      intervalMs: 60_000,
    });
    expect(DATA_CONSEQUENCES.deletedAfterDays).toBe(60);
    expect(JSON.parse(JSON.stringify(DATA_CONSEQUENCES)).deletedAfterDays).toBe(60);
  });
});
