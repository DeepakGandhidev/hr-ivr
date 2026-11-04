import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sealSecret } from "@pratibha/shared/crypto";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import {
  cleanParam,
  deliverWhatsApp,
  graphErrorMessage,
  sendTemplate,
  toWhatsAppNumber,
  whatsappConfig,
  type WhatsAppDb,
} from "@pratibha/shared/whatsapp";
import { WHATSAPP_KINDS } from "@pratibha/shared/whatsapp-kinds";
import { SETTINGS_BY_KEY } from "@pratibha/shared/settings-registry";
import { candidateMayGetWhatsApp, wantsWhatsApp } from "@/lib/whatsapp";

// Never the real Meta: every test sees this fetch.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Hoisted above the imports: the portal's helpers never reach a database here.
vi.mock("@pratibha/prisma", () => ({ adminPrisma: {} }));

function metaOk(wamid = "wamid.HBgM") {
  return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: wamid }] }), { status: 200 });
}
function metaError(error: Record<string, unknown>, status = 400) {
  return new Response(JSON.stringify({ error }), { status });
}

/** An in-memory whatsapp_log and opt-out list, with the table's unique dedupe_key rule. */
function fakeDb(optedOut: string[] = []) {
  const rows: Record<string, unknown>[] = [];
  const db: WhatsAppDb = {
    whatsappLog: {
      create: async ({ data }) => {
        if (data.dedupeKey && rows.some((r) => r.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `w${rows.length + 1}`, ...data };
        rows.push(row);
        return row as { id: string };
      },
      update: async ({ where, data }) => {
        Object.assign(rows.find((r) => r.id === where.id) ?? {}, data);
        return {};
      },
    },
    whatsappOptout: {
      findUnique: async ({ where }) => (optedOut.includes(where.phoneE164) ? { phoneE164: where.phoneE164 } : null),
    },
  };
  return { db, rows };
}

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = "d".repeat(64);
});
afterEach(() => {
  __resetSettingsRuntime();
  fetchMock.mockReset();
});

async function connected(extra: Record<string, unknown> = {}) {
  const rows = {
    "whatsapp.phone_number_id": "106540352242922",
    "integrations.whatsapp_token": { sealed: sealSecret("EAAG-token"), last4: "oken" },
    ...extra,
  };
  await startSettings({ app: "web", load: async () => Object.entries(rows).map(([key, value]) => ({ key, value })), intervalMs: 1e9 });
}

const invite = ["Asha", "QA Engineer", "Acme", "+918031705255", "K7QX2P"];

describe("the catalogue", () => {
  it("never starts or ends a body with a variable, and numbers them 1..n in order", () => {
    for (const kind of WHATSAPP_KINDS.filter((k) => k.body)) {
      expect(kind.body, kind.key).not.toMatch(/^\s*\{\{/);
      expect(kind.body, kind.key).not.toMatch(/\}\}\s*$/);
      const numbers = Array.from(kind.body.matchAll(/\{\{(\d+)\}\}/g)).map((m) => Number(m[1]));
      expect(numbers, kind.key).toEqual(kind.vars.map((_, i) => i + 1));
    }
  });

  it("has a template name setting and a switch for each kind but the test", () => {
    for (const kind of WHATSAPP_KINDS) {
      expect(Boolean(SETTINGS_BY_KEY[`whatsapp.send.${kind.key}`]), kind.key).toBe(!kind.required);
      expect(SETTINGS_BY_KEY[`whatsapp.template.${kind.key}`]?.default ?? kind.template).toBe(kind.template);
    }
  });
});

describe("the Cloud API client", () => {
  it("is not configured without a phone number ID and a token", async () => {
    await startSettings({ app: "web", load: async () => [{ key: "whatsapp.phone_number_id", value: "1065" }], intervalMs: 1e9 });
    expect(whatsappConfig()).toBeNull();
  });

  it("posts the template to the phone number's messages endpoint with the token", async () => {
    await connected();
    fetchMock.mockResolvedValueOnce(metaOk("wamid.ABC"));
    const result = await sendTemplate({ to: "+91 98765-43210", template: "pratibha_interview_invite", language: "en", params: invite });
    expect(result).toEqual({ ok: true, wamid: "wamid.ABC" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v23.0/106540352242922/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer EAAG-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "template",
      template: {
        name: "pratibha_interview_invite",
        language: { code: "en" },
        components: [{ type: "body", parameters: invite.map((text) => ({ type: "text", text })) }],
      },
    });
  });

  it("sends a template without variables with no components", async () => {
    await connected();
    fetchMock.mockResolvedValueOnce(metaOk());
    await sendTemplate({ to: "+919876543210", template: "hello_world", language: "en_US", params: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });

  it("turns Meta's error into a sentence with its details and code", async () => {
    await connected();
    fetchMock.mockResolvedValueOnce(
      metaError({
        message: "(#131030) Recipient phone number not in allowed list",
        code: 131030,
        error_data: { details: "Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again." },
      })
    );
    const result = await sendTemplate({ to: "+919876543210", template: "hello_world", language: "en_US", params: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "(#131030) Recipient phone number not in allowed list: Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again. (code 131030)"
    );
    expect(graphErrorMessage({ error: { message: "Invalid OAuth access token", code: 190, error_subcode: 463 } })).toBe(
      "Invalid OAuth access token (code 190/463)"
    );
    expect(graphErrorMessage(null, 502)).toBe("Meta answered HTTP 502 with no explanation");
  });

  it("reports a network fault instead of throwing", async () => {
    await connected();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await sendTemplate({ to: "+919876543210", template: "hello_world", language: "en_US", params: [] });
    expect(result).toEqual({ ok: false, error: "Could not reach Meta: fetch failed" });
  });

  it("cleans values the way Meta accepts them", () => {
    expect(cleanParam("Line one\nline two\tend")).toBe("Line one line two end");
    expect(cleanParam("a     b")).toBe("a b");
    expect(cleanParam("   ")).toBe("-");
    expect(cleanParam("x".repeat(2000))).toHaveLength(900);
    expect(toWhatsAppNumber("+91 (98765) 43210")).toBe("919876543210");
  });
});

describe("deliverWhatsApp", () => {
  const message = { kind: "candidate_invite", to: "+919876543210", params: invite, tenantId: "t1" };

  it("sends, and logs the message id Meta gave it", async () => {
    await connected();
    fetchMock.mockResolvedValueOnce(metaOk("wamid.1"));
    const { db, rows } = fakeDb();
    const result = await deliverWhatsApp(db, { ...message, dedupeKey: "wa_candidate_invite:a1:c1" });
    expect(result).toEqual({ ok: true, status: "sent", wamid: "wamid.1" });
    expect(rows[0]).toMatchObject({
      kind: "candidate_invite",
      tenantId: "t1",
      toPhone: "+919876543210",
      template: "pratibha_interview_invite",
      status: "sent",
      wamid: "wamid.1",
      dedupeKey: "wa_candidate_invite:a1:c1",
    });
  });

  it("uses the template name and language set in the admin panel", async () => {
    await connected({ "whatsapp.template.candidate_invite": "acme_invite_v2", "whatsapp.language": "en_GB" });
    fetchMock.mockResolvedValueOnce(metaOk());
    await deliverWhatsApp(fakeDb().db, message);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template).toMatchObject({ name: "acme_invite_v2", language: { code: "en_GB" } });
  });

  it("sends another kind's template as a test, logged as the test and past that kind's switch", async () => {
    await connected({ "whatsapp.template.candidate_invite": "candidate_shortlisted_phone_interview", "whatsapp.send.candidate_invite": false });
    fetchMock.mockResolvedValueOnce(metaOk("wamid.t"));
    const { db, rows } = fakeDb();
    const result = await deliverWhatsApp(db, { kind: "test", to: "+919876543210", params: invite, templateOf: "candidate_invite" });
    expect(result).toEqual({ ok: true, status: "sent", wamid: "wamid.t" });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).template;
    expect(sent).toMatchObject({ name: "candidate_shortlisted_phone_interview", language: { code: "en" } });
    expect(sent.components[0].parameters).toHaveLength(5);
    expect(rows[0]).toMatchObject({ kind: "test", template: "candidate_shortlisted_phone_interview", status: "sent" });
    // The value count is the borrowed template's, not the test's (none).
    expect((await deliverWhatsApp(db, { kind: "test", to: "+919876543210", params: [], templateOf: "candidate_invite" })).error).toMatch(/Expected 5 values/);
  });

  it("sends once per dedupe key, however often it is triggered", async () => {
    await connected();
    fetchMock.mockResolvedValue(metaOk());
    const { db } = fakeDb();
    const first = await deliverWhatsApp(db, { ...message, dedupeKey: "k1" });
    const second = await deliverWhatsApp(db, { ...message, dedupeKey: "k1" });
    expect(first.status).toBe("sent");
    expect(second).toEqual({ ok: true, status: "duplicate" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects a message switched off in the admin panel, but never the test", async () => {
    await connected({ "whatsapp.send.candidate_invite": false });
    fetchMock.mockResolvedValue(metaOk());
    const { db, rows } = fakeDb();
    expect((await deliverWhatsApp(db, message)).status).toBe("skipped");
    expect(rows[0]).toMatchObject({ status: "skipped", error: "Switched off in the admin panel" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await deliverWhatsApp(db, { kind: "test", to: "+919876543210", params: [] })).status).toBe("sent");
  });

  it("never messages a number that replied STOP", async () => {
    await connected();
    const { db, rows } = fakeDb(["+919876543210"]);
    const result = await deliverWhatsApp(db, { ...message, to: "919876543210" });
    expect(result.status).toBe("skipped");
    expect(rows[0]).toMatchObject({ status: "skipped", error: "opted out" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs Meta's refusal as failed, and does not throw", async () => {
    await connected();
    fetchMock.mockResolvedValueOnce(metaError({ message: "Template name does not exist in the translation", code: 132001 }));
    const { db, rows } = fakeDb();
    const result = await deliverWhatsApp(db, message);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(rows[0]).toMatchObject({ status: "failed", error: "Template name does not exist in the translation (code 132001)" });
  });

  it("sends nothing, and logs why, while WhatsApp is not connected", async () => {
    const { db, rows } = fakeDb();
    const result = await deliverWhatsApp(db, message);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(rows[0]).toMatchObject({ status: "failed", error: "WhatsApp not connected (admin panel → WhatsApp)" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the wrong number of values before asking Meta", async () => {
    await connected();
    const { db, rows } = fakeDb();
    const result = await deliverWhatsApp(db, { ...message, params: ["Asha"] });
    expect(result.error).toBe("Expected 5 values for pratibha_interview_invite, got 1");
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a database that throws", async () => {
    await connected();
    const db = {
      whatsappLog: { create: async () => ({ id: "x" }), update: async () => ({}) },
      whatsappOptout: {
        findUnique: async () => {
          throw new Error("connection reset");
        },
      },
    } as WhatsAppDb;
    await expect(deliverWhatsApp(db, message)).resolves.toEqual({ ok: false, status: "failed", error: "connection reset" });
  });
});

describe("who gets WhatsApp", () => {
  it("messages only candidates who opted in, unless the admin panel turns the rule off", async () => {
    await connected();
    expect(candidateMayGetWhatsApp({ phoneE164: "+919876543210", whatsappOptIn: true })).toBe(true);
    expect(candidateMayGetWhatsApp({ phoneE164: "+919876543210", whatsappOptIn: false })).toBe(false);
    expect(candidateMayGetWhatsApp({ phoneE164: null, whatsappOptIn: true })).toBe(false);

    __resetSettingsRuntime();
    await connected({ "whatsapp.candidates_need_opt_in": false });
    expect(candidateMayGetWhatsApp({ phoneE164: "+919876543210", whatsappOptIn: false })).toBe(true);
    expect(candidateMayGetWhatsApp({ phoneE164: null, whatsappOptIn: false })).toBe(false);
  });

  it("alerts team members with a number, the opt-in, and the alert left on", () => {
    const users = [
      { id: "a", phoneE164: "+919800000001", whatsappOptIn: true, notificationPrefs: null },
      { id: "b", phoneE164: "+919800000002", whatsappOptIn: false, notificationPrefs: null },
      { id: "c", phoneE164: null, whatsappOptIn: true, notificationPrefs: null },
      { id: "d", phoneE164: "+919800000004", whatsappOptIn: true, notificationPrefs: { shortlist_ready: false } },
    ];
    expect(wantsWhatsApp(users, "shortlist_ready").map((u) => u.id)).toEqual(["a"]);
    expect(wantsWhatsApp(users, "report_ready").map((u) => u.id)).toEqual(["a", "d"]);
  });
});
