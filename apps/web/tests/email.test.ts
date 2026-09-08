import { describe, it, expect, afterEach } from "vitest";
import { outreachFromAddress, sendEmail } from "@/lib/email";

const original = process.env.RESEND_FROM_DOMAIN;
const originalFrom = process.env.RESEND_FROM_EMAIL;
const originalKey = process.env.RESEND_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.RESEND_FROM_DOMAIN;
  else process.env.RESEND_FROM_DOMAIN = original;
  if (originalFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = originalFrom;
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
});

describe("outreachFromAddress — §5 Stage 2", () => {
  it("sends as {tenant-slug}@<configured domain>", () => {
    process.env.RESEND_FROM_DOMAIN = "mail.pratibha.tech";
    expect(outreachFromAddress("acme", "Acme Corp"))
      .toBe("Acme Corp via Pratibha <acme@mail.pratibha.tech>");
  });

  it("keeps tenants on separate sender addresses", () => {
    process.env.RESEND_FROM_DOMAIN = "mail.pratibha.tech";
    expect(outreachFromAddress("globex", "Globex Industries"))
      .toBe("Globex Industries via Pratibha <globex@mail.pratibha.tech>");
  });

  it("falls back to the spec default when unset", () => {
    delete process.env.RESEND_FROM_DOMAIN;
    expect(outreachFromAddress("acme", "Acme Corp")).toContain("@mail.pratibha.tech");
  });
});

describe("RESEND_FROM_EMAIL override", () => {
  it("overrides the per-tenant sender, so mail still goes out on an unverified domain", () => {
    // Resend 403s any From on an unverified domain, which takes down every
    // outbound email at once. The override is the escape hatch to a sender that
    // does work while DNS is being set up.
    process.env.RESEND_FROM_DOMAIN = "mail.pratibha.tech";
    process.env.RESEND_FROM_EMAIL = "onboarding@resend.dev";

    expect(outreachFromAddress("acme", "Acme Corp"))
      .toBe("Acme Corp via Pratibha <onboarding@resend.dev>");
  });

  it("passes through an override that already carries a display name", () => {
    process.env.RESEND_FROM_EMAIL = "Acme Hiring <hiring@acme.test>";
    expect(outreachFromAddress("acme", "Acme Corp")).toBe("Acme Hiring <hiring@acme.test>");
  });

  it("falls back to the per-tenant address when no override is set", () => {
    delete process.env.RESEND_FROM_EMAIL;
    process.env.RESEND_FROM_DOMAIN = "mail.pratibha.tech";
    expect(outreachFromAddress("acme", "Acme Corp"))
      .toBe("Acme Corp via Pratibha <acme@mail.pratibha.tech>");
  });
});

describe("sendEmail without a provider key", () => {
  it("reports that it only logged, rather than claiming a real send", async () => {
    delete process.env.RESEND_API_KEY;

    const result = await sendEmail({ to: "c@example.test", subject: "s", body: "b" });

    // ok stays true so a local run is not treated as a failure, but logOnly is
    // what lets a caller tell "delivered" from "printed to the console".
    expect(result.ok).toBe(true);
    expect(result.logOnly).toBe(true);
  });
});
