import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { sealSecret } from "@pratibha/shared/crypto";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { __resetPlatformMail } from "@pratibha/shared/platform-mail";

/**
 * The sign-in emails go out from Pratibha's mailbox, not GoTrue's: GoTrue's
 * admin API only issues the token (fetch, faked here), the mail goes through
 * the mailer (nodemailer, faked here) and lands in email_log (in memory).
 */

// ------------------------------------------------------------------ fakes

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (msg: { to: string; subject: string; text: string }) => {
        sent.push(msg);
        return { messageId: "<m1@pratibha.tech>", response: "250 OK queued" };
      },
      verify: async () => true,
      close: () => {},
      on: () => {},
    }),
  },
}));

const db = vi.hoisted(() => {
  const emailLog: Record<string, unknown>[] = [];
  const users: { id: string; email: string; name: string | null; tenantId: string; tenant: { name: string; slug: string } }[] = [];
  const auditLog: unknown[] = [];
  const tx = {
    tenant: { create: async ({ data }: any) => ({ id: "t-new", ...data }) },
    user: { create: async ({ data }: any) => ({ id: "u-new", ...data }) },
    outreachTemplate: { createMany: async () => ({ count: 0 }) },
    interviewProtocol: { create: async () => ({}) },
    usageMeter: { create: async () => ({}) },
  };
  const adminPrisma = {
    emailLog: {
      create: async ({ data }: any) => {
        if (data.dedupeKey && emailLog.some((r) => r.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `log${emailLog.length + 1}`, ...data };
        emailLog.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(emailLog.find((r) => r.id === where.id) ?? {}, data),
      findUnique: async ({ where }: any) => emailLog.find((r) => r.dedupeKey === where.dedupeKey) ?? null,
    },
    user: {
      findFirst: async ({ where }: any) =>
        users.find((u) => u.email.toLowerCase() === String(where.email.equals).toLowerCase()) ?? null,
    },
    tenant: { findUnique: async () => null },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  return { emailLog, users, auditLog, adminPrisma };
});
vi.mock("@pratibha/prisma", () => ({ adminPrisma: db.adminPrisma }));

// The cookie client: sign-up must never reach GoTrue's own signUp, which mails.
const supabaseAuth = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
  updateUser: vi.fn(),
  resend: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: supabaseAuth }) }));

// Workspace creation's own collaborators, not under test here.
vi.mock("@/lib/pricing", () => ({
  currentPlan: async () => ({ id: "starter-v1" }),
  currentTrial: async () => null,
  trialAllowance: () => ({ days: 14 }),
}));
vi.mock("@/lib/payments", () => ({ paymentProvider: () => ({ canCharge: false }) }));
vi.mock("@/lib/cashfree", () => ({ cashfreeConfig: () => null }));

// The signed-in member, for the email change route.
const member = vi.hoisted(() => ({
  ctx: {
    user: { id: "u1", email: "old@acme.in", name: "Asha", authProviderId: "00000000-0000-0000-0000-000000000001" },
    tenant: { id: "t1", slug: "acme" },
  },
  pending: null as string | null,
}));
vi.mock("@/lib/authz", () => ({
  authorizeTenant: async () => ({
    ctx: member.ctx,
    tx: async (fn: (d: unknown) => unknown) => fn({ auditLog: { create: async (a: unknown) => db.auditLog.push(a) } }),
  }),
}));
vi.mock("@/lib/reauth", () => ({ passwordMatches: async (_e: string, p: string) => p === "right-password" }));
vi.mock("@/lib/auth-db", () => ({
  authDb: { $queryRaw: async () => (member.pending ? [{ email_change: member.pending }] : []) },
}));

/** GoTrue, answering the admin API the way it does. */
interface GoTrueCall {
  path: string;
  body: Record<string, any> | undefined;
}
let gotrueCalls: GoTrueCall[] = [];
let autoconfirm = false;
let secureEmailChange = false;
let confirmedEmails = new Set<string>();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname.replace(/^\/auth\/v1/, "");
  gotrueCalls.push({ path, body });
  expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer service-key");
  if (path === "/settings") return json(200, { mailer_autoconfirm: autoconfirm });
  if (path === "/admin/users") return json(200, { id: "auth-confirmed-1", email: body!.email });
  if (path === "/admin/generate_link") {
    const { type, email } = body!;
    if (type === "signup" && confirmedEmails.has(email)) {
      return json(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
    }
    if (type === "email_change_current" && !secureEmailChange) {
      return json(400, { code: 400, error_code: "validation_failed", msg: "Enable secure email change to generate link for current email" });
    }
    if (type === "recovery" && !db.users.some((u) => u.email === email)) {
      return json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
    }
    return json(200, { id: "auth-user-1", email, hashed_token: `hash-${type}-${gotrueCalls.length}`, verification_type: type });
  }
  return json(404, { msg: "not found" });
});

// ------------------------------------------------------------------ setup

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = "d".repeat(64);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

async function withMailbox(connected = true) {
  const rows: Record<string, unknown> = {
    "brand.app_url": "https://app.example.test",
    ...(connected
      ? {
          "messages.smtp_user": "info@pratibha.tech",
          "integrations.smtp_password": { sealed: sealSecret("mailbox-password"), last4: "word" },
        }
      : {}),
  };
  await startSettings({ app: "web", load: async () => Object.entries(rows).map(([key, value]) => ({ key, value })), intervalMs: 1e9 });
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  gotrueCalls = [];
  autoconfirm = false;
  secureEmailChange = false;
  confirmedEmails = new Set();
  sent.length = 0;
  db.emailLog.length = 0;
  db.users.length = 0;
  db.auditLog.length = 0;
  member.pending = null;
  vi.clearAllMocks();
  await withMailbox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSettingsRuntime();
  __resetPlatformMail();
});

function post(path: string, body: unknown, method = "POST") {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The /auth/confirm link in an email body, parsed. */
function confirmLink(text: string): URL {
  const m = text.match(/https:\/\/app\.example\.test\/auth\/confirm\?\S+/);
  expect(m, text).not.toBeNull();
  return new URL(m![0]);
}

const signupBody = { name: "Acme", slug: "acme", ownerEmail: "owner@acme.in", ownerName: "owner", password: "a-long-password" };

// ------------------------------------------------------------------ sign-up

describe("sign-up", () => {
  it("creates the user through generate_link and sends our own confirmation", async () => {
    const { POST } = await import("@/app/api/auth/signup/route");
    const res = await POST(post("/api/auth/signup", signupBody));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.confirmation).toBe("sent");
    expect(data.user.authProviderId).toBe("auth-user-1");
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();

    const gen = gotrueCalls.find((c) => c.path === "/admin/generate_link")!;
    expect(gen.body).toMatchObject({ type: "signup", email: "owner@acme.in", password: "a-long-password" });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@acme.in");
    expect(sent[0].subject).toBe("Confirm your email for Pratibha");
    const link = confirmLink(sent[0].text);
    expect(link.searchParams.get("token_hash")).toBe("hash-signup-2");
    expect(link.searchParams.get("type")).toBe("signup");
    expect(link.searchParams.get("next")).toBe("/acme");
    expect(db.emailLog[0]).toMatchObject({ kind: "auth_signup_confirm", status: "sent", tenantId: "t-new" });
  });

  it("still creates the workspace when the mailbox is not connected, and says the email was not sent", async () => {
    __resetSettingsRuntime();
    await withMailbox(false);
    const { POST } = await import("@/app/api/auth/signup/route");
    const res = await POST(post("/api/auth/signup", signupBody));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.tenant.slug).toBe("acme");
    expect(data.confirmation).toBe("failed");
    expect(sent).toHaveLength(0);
    expect(db.emailLog[0]).toMatchObject({ kind: "auth_signup_confirm", status: "failed" });
  });

  it("refuses an address that already has a confirmed account", async () => {
    confirmedEmails.add("owner@acme.in");
    const { POST } = await import("@/app/api/auth/signup/route");
    const res = await POST(post("/api/auth/signup", signupBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("DUPLICATE_EMAIL");
    expect(sent).toHaveLength(0);
  });

  it("where GoTrue confirms sign-ups itself, creates the user confirmed and signs in, sending nothing", async () => {
    autoconfirm = true;
    const { POST } = await import("@/app/api/auth/signup/route");
    const res = await POST(post("/api/auth/signup", signupBody));
    const data = await res.json();

    expect(data.confirmation).toBe("not_needed");
    expect(gotrueCalls.find((c) => c.path === "/admin/users")!.body).toMatchObject({ email: "owner@acme.in", email_confirm: true });
    expect(gotrueCalls.some((c) => c.path === "/admin/generate_link")).toBe(false);
    expect(supabaseAuth.signInWithPassword).toHaveBeenCalledWith({ email: "owner@acme.in", password: "a-long-password" });
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("resend confirmation", () => {
  beforeEach(() => {
    db.users.push({ id: "u1", email: "owner@acme.in", name: null, tenantId: "t1", tenant: { name: "Acme", slug: "acme" } });
  });

  it("issues a new link without the password and sends it, once per window", async () => {
    const { POST } = await import("@/app/api/auth/resend-confirmation/route");
    expect((await POST(post("/api/auth/resend-confirmation", { email: "Owner@Acme.in" }))).status).toBe(200);
    expect((await POST(post("/api/auth/resend-confirmation", { email: "owner@acme.in" }))).status).toBe(200);

    const gens = gotrueCalls.filter((c) => c.path === "/admin/generate_link");
    expect(gens).toHaveLength(1);
    expect(gens[0].body).toEqual({ type: "signup", email: "owner@acme.in" });
    expect(sent).toHaveLength(1);
    expect(confirmLink(sent[0].text).searchParams.get("next")).toBe("/acme");
  });

  it("sends nothing for a confirmed address, and answers the same", async () => {
    confirmedEmails.add("owner@acme.in");
    const { POST } = await import("@/app/api/auth/resend-confirmation/route");
    const res = await POST(post("/api/auth/resend-confirmation", { email: "owner@acme.in" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------ forgot password

describe("forgot password", () => {
  it("answers an unknown address exactly as a known one, and asks GoTrue nothing", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const unknown = await POST(post("/api/auth/forgot-password", { email: "nobody@example.test" }));

    db.users.push({ id: "u1", email: "member@acme.in", name: "Ravi", tenantId: "t1", tenant: { name: "Acme", slug: "acme" } });
    const known = await POST(post("/api/auth/forgot-password", { email: "member@acme.in" }));

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(gotrueCalls.filter((c) => c.path === "/admin/generate_link")).toHaveLength(1);
    expect(sent.map((m) => m.to)).toEqual(["member@acme.in"]);
  });

  it("sends a recovery link that opens the reset screen", async () => {
    db.users.push({ id: "u1", email: "member@acme.in", name: "Ravi", tenantId: "t1", tenant: { name: "Acme", slug: "acme" } });
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    await POST(post("/api/auth/forgot-password", { email: "member@acme.in" }));

    expect(gotrueCalls.find((c) => c.path === "/admin/generate_link")!.body).toEqual({ type: "recovery", email: "member@acme.in" });
    expect(sent[0].subject).toBe("Reset your Pratibha password");
    expect(sent[0].text).toContain("Hello Ravi,");
    const link = confirmLink(sent[0].text);
    expect(link.searchParams.get("type")).toBe("recovery");
    expect(link.searchParams.get("next")).toBe("/reset-password");
    expect(db.emailLog[0]).toMatchObject({ kind: "auth_password_reset", status: "sent" });
    expect(String(db.emailLog[0].dedupeKey)).toMatch(/^auth_password_reset:member@acme\.in:\d+$/);
  });

  it("sends at most one link per ten minutes, without replacing the one already sent", async () => {
    db.users.push({ id: "u1", email: "member@acme.in", name: null, tenantId: "t1", tenant: { name: "Acme", slug: "acme" } });
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const first = await POST(post("/api/auth/forgot-password", { email: "member@acme.in" }));
    const second = await POST(post("/api/auth/forgot-password", { email: "MEMBER@acme.in" }));

    expect(await second.json()).toEqual(await first.json());
    expect(sent).toHaveLength(1);
    // A second token would have broken the first link: GoTrue is not asked again.
    expect(gotrueCalls.filter((c) => c.path === "/admin/generate_link")).toHaveLength(1);
  });

  it("keeps the neutral answer when the mailbox is not connected", async () => {
    __resetSettingsRuntime();
    await withMailbox(false);
    db.users.push({ id: "u1", email: "member@acme.in", name: null, tenantId: "t1", tenant: { name: "Acme", slug: "acme" } });
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(post("/api/auth/forgot-password", { email: "member@acme.in" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.emailLog[0]).toMatchObject({ kind: "auth_password_reset", status: "failed" });
  });

  it("buckets the rate key by ten minutes", async () => {
    const { rateKey } = await import("@/lib/auth-emails");
    const t = Date.UTC(2026, 9, 17, 10, 0, 0);
    expect(rateKey("auth_password_reset", "A@B.in", 10, t)).toBe(rateKey("auth_password_reset", "a@b.in", 10, t + 9 * 60_000));
    expect(rateKey("auth_password_reset", "a@b.in", 10, t)).not.toBe(rateKey("auth_password_reset", "a@b.in", 10, t + 10 * 60_000));
  });
});

// --------------------------------------------------------------- email change

describe("email change", () => {
  const route = () => import("@/app/api/[tenant]/profile/email/route");
  const params = { params: { tenant: "acme" } };

  it("sends the confirmation to the new address and the notice to the old one, never through GoTrue's mail", async () => {
    const { POST } = await route();
    const res = await POST(post("/api/acme/profile/email", { email: "New@Acme.in", currentPassword: "right-password" }), params);
    expect(res.status).toBe(200);
    expect(supabaseAuth.updateUser).not.toHaveBeenCalled();

    const gen = gotrueCalls.find((c) => c.body?.type === "email_change_new")!;
    expect(gen.body).toEqual({ type: "email_change_new", email: "old@acme.in", new_email: "new@acme.in" });

    const toNew = sent.find((m) => m.to === "new@acme.in")!;
    expect(toNew.subject).toBe("Confirm your new email address for Pratibha");
    const link = confirmLink(toNew.text);
    expect(link.searchParams.get("type")).toBe("email_change");
    expect(link.searchParams.get("next")).toBe("/acme/settings/profile");

    // Secure email change off: the old address gets the plain warning, no link.
    const toOld = sent.find((m) => m.to === "old@acme.in")!;
    expect(toOld.text).toContain("new@acme.in");
    expect(toOld.text).not.toContain("/auth/confirm");
    expect(db.emailLog.map((r) => r.kind)).toEqual(["auth_email_change_confirm", "account_email_change_notice"]);
  });

  it("asks the old address to approve as well when GoTrue wants both confirmations", async () => {
    secureEmailChange = true;
    const { POST } = await route();
    await POST(post("/api/acme/profile/email", { email: "new@acme.in", currentPassword: "right-password" }), params);

    const toOld = sent.find((m) => m.to === "old@acme.in")!;
    const approve = confirmLink(toOld.text);
    expect(approve.searchParams.get("token_hash")).toMatch(/^hash-email_change_current-/);
    expect(approve.searchParams.get("type")).toBe("email_change");
    expect(db.emailLog.map((r) => r.kind)).toEqual(["auth_email_change_confirm", "auth_email_change_confirm"]);
  });

  it("refuses a wrong password before anything is issued or sent", async () => {
    const { POST } = await route();
    const res = await POST(post("/api/acme/profile/email", { email: "new@acme.in", currentPassword: "wrong" }), params);
    expect(res.status).toBe(400);
    expect(gotrueCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("resends a fresh link to the pending address", async () => {
    member.pending = "new@acme.in";
    const { PUT } = await route();
    const res = await PUT(post("/api/acme/profile/email", undefined, "PUT"), params);
    expect(res.status).toBe(200);
    expect(supabaseAuth.resend).not.toHaveBeenCalled();
    expect(gotrueCalls.find((c) => c.body?.type === "email_change_new")!.body!.new_email).toBe("new@acme.in");
    expect(confirmLink(sent.find((m) => m.to === "new@acme.in")!.text).searchParams.get("type")).toBe("email_change");
  });

  it("says so when the confirmation could not be sent", async () => {
    __resetSettingsRuntime();
    await withMailbox(false);
    const { POST } = await route();
    const res = await POST(post("/api/acme/profile/email", { email: "new@acme.in", currentPassword: "right-password" }), params);
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/could not be sent/);
  });
});
