import { describe, expect, it } from "vitest";
import { can, refusalReason, PERMISSIONS } from "@/lib/auth/roles";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "@/lib/auth/totp";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";

describe("roles, enforced at the API", () => {
  it("Owner can do everything", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
  });

  it("Engineer cannot publish pricing, delete workspaces or manage admins, and can do the rest", () => {
    expect(can("engineer", "pricing.publish")).toBe(false);
    expect(can("engineer", "workspace.delete")).toBe(false);
    expect(can("engineer", "team.manage")).toBe(false);
    expect(can("engineer", "settings.edit")).toBe(true);
    expect(can("engineer", "pricing.edit")).toBe(true);
  });

  it("Support can view, sign in as and grant goodwill, nothing else", () => {
    const allowed = PERMISSIONS.filter((p) => can("support", p));
    expect(allowed.sort()).toEqual(["view", "workspace.grant_goodwill", "workspace.sign_in_as"].sort());
    expect(can("support", "pricing.publish")).toBe(false);
    expect(refusalReason("support", "pricing.publish")).toMatch(/cannot publish pricing/);
  });
});

describe("two step codes (RFC 6238)", () => {
  // The RFC's SHA-1 test secret is ASCII "12345678901234567890".
  const secret = base32Encode(Buffer.from("12345678901234567890"));

  it("round-trips base32", () => {
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });

  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("at T=%i the code is %s", (t, code) => {
    expect(totpAt(secret, Math.floor(t / 30))).toBe(code);
    expect(verifyTotp(secret, code, t * 1000)).toBe(true);
  });

  it("accepts one step of drift and no more", () => {
    const t = 1234567890 * 1000;
    expect(verifyTotp(secret, totpAt(secret, Math.floor(t / 30000) - 1), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, Math.floor(t / 30000) - 2), t)).toBe(false);
  });

  it("refuses anything that is not six digits", () => {
    expect(verifyTotp(secret, "12345", 0)).toBe(false);
    expect(verifyTotp(secret, "abcdef", 0)).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong horse battery", a)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  it("asks for length", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem("a long enough passphrase")).toBeNull();
  });
});
