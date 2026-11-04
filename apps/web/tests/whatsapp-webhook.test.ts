import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { sealSecret } from "@pratibha/shared/crypto";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { verifyMetaSignature } from "@/lib/whatsapp-webhook";

/** The tables the webhook touches, in memory. */
const state = vi.hoisted(() => ({
  log: [] as { id: string; wamid: string; status: string; error?: string }[],
  optouts: new Map<string, string>(),
  candidates: [] as { id: string; phoneE164: string; whatsappOptIn: boolean; whatsappOptInAt?: Date }[],
  users: [] as { id: string; phoneE164: string; whatsappOptIn: boolean }[],
}));

vi.mock("@pratibha/prisma", () => ({
  adminPrisma: {
    whatsappLog: {
      findUnique: async ({ where }: { where: { wamid: string } }) => state.log.find((r) => r.wamid === where.wamid) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(state.log.find((r) => r.id === where.id)!, data),
    },
    whatsappOptout: {
      upsert: async ({ create }: { create: { phoneE164: string; source: string } }) => {
        if (!state.optouts.has(create.phoneE164)) state.optouts.set(create.phoneE164, create.source);
      },
      deleteMany: async ({ where }: { where: { phoneE164: string } }) => state.optouts.delete(where.phoneE164),
    },
    candidate: {
      updateMany: async ({ where, data }: { where: { phoneE164: string; whatsappOptIn?: boolean }; data: Record<string, unknown> }) => {
        for (const c of state.candidates) {
          if (c.phoneE164 === where.phoneE164 && (where.whatsappOptIn === undefined || c.whatsappOptIn === where.whatsappOptIn)) Object.assign(c, data);
        }
      },
    },
    user: {
      updateMany: async ({ where, data }: { where: { phoneE164: string }; data: Record<string, unknown> }) => {
        for (const u of state.users) if (u.phoneE164 === where.phoneE164) Object.assign(u, data);
      },
    },
  },
}));

import { GET, POST } from "@/app/webhook/whatsapp/route";

const SECRET = "0123456789abcdef0123456789abcdef";
const sign = (raw: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function post(body: unknown, signature?: string | null) {
  const raw = JSON.stringify(body);
  return new NextRequest("https://pratibha.test/webhook/whatsapp", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", ...(signature === null ? {} : { "x-hub-signature-256": signature ?? sign(raw) }) },
  });
}

/** Meta's envelope around one change's value. */
const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...value } }] }],
});
const reply = (from: string, body: string) => envelope({ messages: [{ from, id: "wamid.in", type: "text", text: { body } }] });

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = "d".repeat(64);
});
beforeEach(async () => {
  state.log = [{ id: "l1", wamid: "wamid.1", status: "sent" }];
  state.optouts.clear();
  state.candidates = [
    { id: "c1", phoneE164: "+919876543210", whatsappOptIn: true },
    { id: "c2", phoneE164: "+919876543210", whatsappOptIn: false },
    { id: "c3", phoneE164: "+919800000000", whatsappOptIn: true },
  ];
  state.users = [{ id: "u1", phoneE164: "+919876543210", whatsappOptIn: true }];
  await startSettings({
    app: "web",
    load: async () => [
      { key: "whatsapp.verify_token", value: "verify-me" },
      { key: "integrations.whatsapp_app_secret", value: { sealed: sealSecret(SECRET), last4: "cdef" } },
    ],
    intervalMs: 1e9,
  });
});
afterEach(() => __resetSettingsRuntime());

describe("GET: Meta's verification", () => {
  const verify = (token: string, mode = "subscribe") =>
    GET(new NextRequest(`https://pratibha.test/webhook/whatsapp?hub.mode=${mode}&hub.verify_token=${token}&hub.challenge=1158201444`));

  it("echoes the challenge for the right verify token", async () => {
    const res = await verify("verify-me");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("refuses a wrong token or mode", async () => {
    expect((await verify("guess")).status).toBe(403);
    expect((await verify("verify-me", "unsubscribe")).status).toBe(403);
  });

  it("refuses everything while no verify token is set", async () => {
    __resetSettingsRuntime();
    await startSettings({ app: "web", load: async () => [], intervalMs: 1e9 });
    expect((await verify("")).status).toBe(403);
  });
});

describe("POST: signature", () => {
  it("checks the HMAC of the raw body in constant time", () => {
    expect(verifyMetaSignature("{}", sign("{}"), SECRET)).toBe(true);
    expect(verifyMetaSignature("{} ", sign("{}"), SECRET)).toBe(false);
    expect(verifyMetaSignature("{}", "sha256=abc", SECRET)).toBe(false);
    expect(verifyMetaSignature("{}", null, SECRET)).toBe(false);
  });

  it("refuses a bad or missing signature with 401 and changes nothing", async () => {
    const body = envelope({ statuses: [{ id: "wamid.1", status: "read" }] });
    expect((await POST(post(body, sign("other", SECRET)))).status).toBe(401);
    expect((await POST(post(body, sign(JSON.stringify(body), "wrong-secret")))).status).toBe(401);
    expect((await POST(post(body, null))).status).toBe(401);
    expect(state.log[0].status).toBe("sent");
  });
});

describe("POST: statuses", () => {
  it("records delivered and read, never moving backwards", async () => {
    expect((await POST(post(envelope({ statuses: [{ id: "wamid.1", status: "read" }] })))).status).toBe(200);
    expect(state.log[0].status).toBe("read");
    await POST(post(envelope({ statuses: [{ id: "wamid.1", status: "delivered" }] })));
    expect(state.log[0].status).toBe("read");
  });

  it("records a failure with Meta's reason", async () => {
    await POST(
      post(
        envelope({
          statuses: [
            {
              id: "wamid.1",
              status: "failed",
              errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Receiver is incapable of receiving this message" } }],
            },
          ],
        })
      )
    );
    expect(state.log[0]).toMatchObject({ status: "failed", error: "Message undeliverable: Receiver is incapable of receiving this message (code 131026)" });
  });

  it("ignores a message id it never sent", async () => {
    expect((await POST(post(envelope({ statuses: [{ id: "wamid.other", status: "read" }] })))).status).toBe(200);
    expect(state.log[0].status).toBe("sent");
  });
});

describe("POST: replies", () => {
  it("STOP opts the number out and clears every opt-in it has", async () => {
    expect((await POST(post(reply("919876543210", " Stop. ")))).status).toBe(200);
    expect(state.optouts.get("+919876543210")).toBe("reply: STOP");
    expect(state.candidates.map((c) => c.whatsappOptIn)).toEqual([false, false, true]);
    expect(state.users[0].whatsappOptIn).toBe(false);
  });

  it("UNSUBSCRIBE and STOP ALL do too, and other replies do nothing", async () => {
    await POST(post(reply("919800000000", "unsubscribe")));
    expect(state.optouts.has("+919800000000")).toBe(true);
    await POST(post(reply("919876543210", "STOP ALL")));
    expect(state.optouts.has("+919876543210")).toBe(true);
    state.optouts.clear();
    await POST(post(reply("919876543210", "Please stop calling me at night")));
    expect(state.optouts.size).toBe(0);
  });

  it("START takes the number off the list and opts its candidates in", async () => {
    await POST(post(reply("919876543210", "STOP")));
    await POST(post(reply("919876543210", "start")));
    expect(state.optouts.has("+919876543210")).toBe(false);
    expect(state.candidates.filter((c) => c.phoneE164 === "+919876543210").every((c) => c.whatsappOptIn && c.whatsappOptInAt)).toBe(true);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const raw = "not json";
    const req = new NextRequest("https://pratibha.test/webhook/whatsapp", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
    expect((await POST(req)).status).toBe(400);
  });
});
