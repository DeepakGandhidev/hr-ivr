import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@pratibha/prisma";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { WHATSAPP_KINDS } from "@pratibha/shared/whatsapp-kinds";

// Never the real Meta.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { saveSettings } = vi.hoisted(() => ({ saveSettings: vi.fn(async (..._args: unknown[]) => ({ message: "Saved" })) }));
vi.mock("@/lib/settings-admin", () => ({ saveSettings }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { connectWhatsApp, normaliseTestNumber, sampleValues, templateRows, type MetaTemplate } from "@/lib/whatsapp-admin";

const owner = { id: "a1", name: "Deepak", email: "d@pratibha.tech", role: "owner" } as AdminUser;
const input = { phoneNumberId: "106540352242922", wabaId: "102290129340398", token: "EAAG-bad", appSecret: "s".repeat(32) };

beforeEach(() => startSettings({ app: "admin", load: async () => [], intervalMs: 1e9 }));
afterEach(() => {
  __resetSettingsRuntime();
  fetchMock.mockReset();
  saveSettings.mockClear();
});

describe("connecting WhatsApp", () => {
  it("refuses a token Meta rejects, and saves nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token - Cannot parse access token", code: 190 } }), { status: 401 })
    );
    await expect(connectWhatsApp(owner, input)).rejects.toThrow(/Meta did not accept that token.*Invalid OAuth access token.*code 190/);
    expect(saveSettings).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v23.0/106540352242922?fields=display_phone_number,verified_name,quality_rating");
    expect(init.headers.Authorization).toBe("Bearer EAAG-bad");
  });

  it("saves the connection, with a fresh verify token, once Meta accepts it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ display_phone_number: "+91 80317 05255", verified_name: "Pratibha", quality_rating: "GREEN", id: "1" }), { status: 200 })
    );
    const result = await connectWhatsApp(owner, input);
    expect(result.message).toContain("Connected +91 80317 05255 (Pratibha)");
    const [, saved] = saveSettings.mock.calls[0] as unknown as [AdminUser, { set: Record<string, string> }];
    expect(saved.set).toMatchObject({
      "whatsapp.phone_number_id": "106540352242922",
      "whatsapp.waba_id": "102290129340398",
      "integrations.whatsapp_token": "EAAG-bad",
      "integrations.whatsapp_app_secret": "s".repeat(32),
    });
    expect(saved.set["whatsapp.verify_token"]).toMatch(/^[\w-]{32}$/);
  });

  it("keeps an existing verify token, so Meta's saved callback stays valid", async () => {
    __resetSettingsRuntime();
    await startSettings({ app: "admin", load: async () => [{ key: "whatsapp.verify_token", value: "already-in-meta" }], intervalMs: 1e9 });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ display_phone_number: "+91 80317 05255" }), { status: 200 }));
    await connectWhatsApp(owner, input);
    expect((saveSettings.mock.calls[0] as unknown as [AdminUser, { set: Record<string, string> }])[1].set["whatsapp.verify_token"]).toBe("already-in-meta");
  });

  it("checks the IDs before asking Meta", async () => {
    await expect(connectWhatsApp(owner, { ...input, phoneNumberId: "+91 80317 05255" })).rejects.toThrow(/not the phone number/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the template list", () => {
  const body = (text: string) => [{ type: "BODY", text }];

  it("maps each message to Meta's template of that name and language", () => {
    const templates: MetaTemplate[] = [
      { name: "pratibha_interview_invite", status: "APPROVED", language: "en", components: body(WHATSAPP_KINDS[0]!.body) },
      { name: "pratibha_shortlist_ready", status: "PENDING", language: "en", components: body("{{1}} {{2}} {{3}} {{4}} x {{5}}.") },
      { name: "pratibha_report_ready", status: "REJECTED", language: "en", components: body("x") },
      { name: "pratibha_minutes_low", status: "APPROVED", language: "en_US", components: body("x") },
      { name: "hello_world", status: "APPROVED", language: "en_US", components: body("Welcome") },
    ];
    const rows = Object.fromEntries(templateRows(WHATSAPP_KINDS, templates).map((r) => [r.key, r]));
    expect(rows.candidate_invite).toMatchObject({ state: "APPROVED", problem: null });
    expect(rows.shortlist_ready.state).toBe("PENDING");
    expect(rows.report_ready.state).toBe("REJECTED");
    expect(rows.quota_warning).toMatchObject({ state: "MISSING", problem: "Meta has it in en_US, not en." });
    expect(rows.test).toMatchObject({ state: "APPROVED", language: "en_US", problem: null });
  });

  it("flags an approved template that takes a different number of values", () => {
    const rows = templateRows(WHATSAPP_KINDS, [{ name: "pratibha_interview_invite", status: "APPROVED", language: "en", components: body("Hi {{1}}, call {{2}}.") }]);
    expect(rows[0]!.problem).toMatch(/takes 2 values; Pratibha sends 5/);
  });

  it("says nothing about state when Meta could not be asked", () => {
    expect(templateRows(WHATSAPP_KINDS, null).every((r) => r.state === "UNKNOWN")).toBe(true);
  });
});

describe("the test number", () => {
  it("reads an Indian mobile or a number with its country code", () => {
    expect(normaliseTestNumber("98765 43210")).toBe("+919876543210");
    expect(normaliseTestNumber("098765 43210")).toBe("+919876543210");
    expect(normaliseTestNumber("+44 7700 900123")).toBe("+447700900123");
    expect(normaliseTestNumber("12345")).toBeNull();
  });
});

describe("the test message", () => {
  it("has a sample for every value of every template, so a test never sends a placeholder", () => {
    for (const kind of WHATSAPP_KINDS) {
      const values = sampleValues(kind);
      expect(values).toHaveLength(kind.vars.length);
      expect(values).not.toContain("Sample");
    }
  });
});
