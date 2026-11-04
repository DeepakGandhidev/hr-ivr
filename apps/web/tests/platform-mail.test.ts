import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sealSecret } from "@pratibha/shared/crypto";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { __resetPlatformMail, displayNameOf, sendPlatformMail } from "@pratibha/shared/platform-mail";
import { deliverEmail, emailKindEnabled, type MailerDb } from "@pratibha/shared/mailer";
import { EMAIL_KINDS } from "@pratibha/shared/email-kinds";

// vi.mock is hoisted above these imports, so the mail helper gets the fake transport.
const sent: Record<string, unknown>[] = [];
let failNext: string | null = null;
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (msg: Record<string, unknown>) => {
        if (failNext) {
          const err = new Error(failNext);
          failNext = null;
          throw err;
        }
        sent.push(msg);
        return { messageId: "<m1@pratibha.tech>", response: "250 OK queued" };
      },
      verify: async () => true,
      close: () => {},
      on: () => {},
    }),
  },
}));

/** An in-memory email_log with the same unique dedupe_key rule as the table. */
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  const db: MailerDb = {
    emailLog: {
      create: async ({ data }) => {
        if (data.dedupeKey && rows.some((r) => r.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `r${rows.length + 1}`, ...data };
        rows.push(row);
        return row as { id: string };
      },
      update: async ({ where, data }) => {
        Object.assign(rows.find((r) => r.id === where.id) ?? {}, data);
        return {};
      },
    },
  };
  return { db, rows };
}

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = "d".repeat(64);
});
afterEach(() => {
  __resetSettingsRuntime();
  __resetPlatformMail();
  sent.length = 0;
  failNext = null;
});

async function withMailbox(extra: Record<string, unknown> = {}) {
  const rows = {
    "messages.smtp_user": "info@pratibha.tech",
    "integrations.smtp_password": { sealed: sealSecret("mailbox-password"), last4: "word" },
    ...extra,
  };
  await startSettings({ app: "web", load: async () => Object.entries(rows).map(([key, value]) => ({ key, value })), intervalMs: 1e9 });
}

const mail = { kind: "shortlist_ready", to: "hr@acme.in", subject: "A candidate is ready", text: "Hello" };

describe("deliverEmail", () => {
  it("sends from the connected mailbox and logs the server's answer", async () => {
    await withMailbox();
    const { db, rows } = fakeDb();
    const result = await deliverEmail(db, { ...mail, fromName: "Acme via Pratibha", tenantId: "t1" });
    expect(result).toMatchObject({ ok: true, status: "sent", response: "250 OK queued" });
    expect(sent[0]).toMatchObject({ from: { name: "Acme via Pratibha", address: "info@pratibha.tech" }, to: "hr@acme.in" });
    expect(rows[0]).toMatchObject({ kind: "shortlist_ready", tenantId: "t1", status: "sent", response: "250 OK queued" });
  });

  it("sends nothing, and logs why, while no mailbox is connected", async () => {
    const { db, rows } = fakeDb();
    const result = await deliverEmail(db, mail);
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ status: "failed" });
  });

  it("records the mail server's refusal", async () => {
    await withMailbox();
    const { db, rows } = fakeDb();
    failNext = "535 Authentication failed";
    const result = await deliverEmail(db, mail);
    expect(result).toMatchObject({ ok: false, status: "failed", error: "535 Authentication failed" });
    expect(rows[0]).toMatchObject({ status: "failed", error: "535 Authentication failed" });
  });

  it("sends a deduplicated email once, however often it is triggered", async () => {
    await withMailbox();
    const { db } = fakeDb();
    const first = await deliverEmail(db, { ...mail, kind: "quota_warning", dedupeKey: "quota:t1:2026-10:80" });
    const second = await deliverEmail(db, { ...mail, kind: "quota_warning", dedupeKey: "quota:t1:2026-10:80" });
    expect(first.status).toBe("sent");
    expect(second.status).toBe("duplicate");
    expect(sent).toHaveLength(1);
  });

  it("respects an email switched off in the admin panel", async () => {
    await withMailbox({ "emails.weekly_summary": false });
    const { db, rows } = fakeDb();
    const result = await deliverEmail(db, { ...mail, kind: "weekly_summary" });
    expect(result.status).toBe("skipped");
    expect(sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ status: "skipped" });
  });

  it("never lets sign-in emails be switched off", async () => {
    await withMailbox({ "emails.auth_password_reset": false });
    for (const kind of EMAIL_KINDS.filter((k) => k.required)) expect(emailKindEnabled(kind.key)).toBe(true);
  });

  it("still sends when the log cannot be written", async () => {
    await withMailbox();
    const broken: MailerDb = {
      emailLog: { create: async () => Promise.reject(new Error("db down")), update: async () => ({}) },
    };
    expect((await deliverEmail(broken, mail)).status).toBe("sent");
  });
});

describe("sender names", () => {
  it("system email carries the product name", async () => {
    await withMailbox();
    await sendPlatformMail({ to: "a@b.com", subject: "s", text: "t" });
    expect(sent[0]!.from).toEqual({ name: "Pratibha", address: "info@pratibha.tech" });
  });

  it("a display name cannot inject header characters", async () => {
    await withMailbox();
    await sendPlatformMail({ to: "a@b.com", subject: "s", text: "t", fromName: 'Evil"\r\nBcc: x@y.com <' });
    expect(String((sent[0]!.from as { name: string }).name)).not.toMatch(/[\r\n"<>]/);
  });

  it("reads display names the way mail headers write them", () => {
    expect(displayNameOf("Acme via Pratibha <a@b.c>")).toBe("Acme via Pratibha");
    expect(displayNameOf('"Quoted, Name" <a@b.c>')).toBe("Quoted, Name");
    expect(displayNameOf("a@b.c")).toBeNull();
    expect(displayNameOf(undefined)).toBeNull();
  });
});
