import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkImageUpload, sniffImageType, MAX_IMAGE_BYTES } from "@/lib/storage";
import { isValidGstin, stateFromGstin, gstStateCode } from "@pratibha/shared";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe("image sniffing", () => {
  it("recognises the formats we accept", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(SVG)).toBe("image/svg+xml");
  });

  // "image/png" on a file that is actually HTML is the oldest upload bug there
  // is, and the browser's declared type is the attacker's to choose.
  it("does not take the declared type on trust", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(checkImageUpload(html, "image/png").ok).toBe(false);
    expect(checkImageUpload(PNG, "image/svg+xml").ok).toBe(false);
  });

  it("only treats a file as SVG when it starts as one", () => {
    // A real PNG that happens to contain "<svg" in its pixel data.
    const sneaky = Buffer.concat([PNG, Buffer.from("<svg onload=alert(1)>")]);
    expect(sniffImageType(sneaky)).toBe("image/png");
  });

  it("rejects an empty file", () => {
    expect(checkImageUpload(Buffer.alloc(0), "image/png").ok).toBe(false);
  });

  it("rejects anything over the size cap", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(checkImageUpload(huge, "image/png").ok).toBe(false);
  });

  it("accepts a genuine image of an allowed type", () => {
    expect(checkImageUpload(PNG, "image/png").ok).toBe(true);
    expect(checkImageUpload(SVG, "image/svg+xml").ok).toBe(true);
  });
});

describe("GSTIN", () => {
  it("accepts a well-formed GSTIN", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin(" 27aapfu0939f1zv ")).toBe(true);
  });

  it("rejects the wrong length or shape", () => {
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
    expect(isValidGstin("AAPFU0939F1ZV27")).toBe(false);
    expect(isValidGstin("")).toBe(false);
  });

  // The first two digits are the state, which is what decides CGST+SGST
  // versus IGST on the invoice.
  it("reads the state out of the number", () => {
    expect(stateFromGstin("27AAPFU0939F1ZV")).toBe("Maharashtra");
    expect(stateFromGstin("29AAPFU0939F1ZV")).toBe("Karnataka");
    expect(gstStateCode("Karnataka")).toBe("29");
  });
});

/**
 * The logo is reachable without a session, because the careers page is public
 * and candidate emails are read in other people's inboxes. That exposure has to
 * stay as narrow as the requirement.
 */
describe("the public logo route", () => {
  const route = readFileSync(
    path.join(APP_ROOT, "src/app/api/public/[tenantSlug]/logo/route.ts"),
    "utf8"
  );

  it("is addressed by tenant slug, never by asset id", () => {
    expect(route).not.toContain("params.id");
    expect(route).toContain("tenantSlug");
  });

  it("serves only a pinned company logo", () => {
    expect(route).toContain('kind !== "company_logo"');
    expect(route).toContain("companyProfile.findFirst");
  });

  it("stops an uploaded SVG executing in our origin", () => {
    expect(route).toContain("X-Content-Type-Options");
    expect(route).toContain("Content-Security-Policy");
  });
});

describe("the authenticated asset route", () => {
  const route = readFileSync(
    path.join(APP_ROOT, "src/app/api/[tenant]/assets/[id]/route.ts"),
    "utf8"
  );

  it("goes through tenant authorisation", () => {
    expect(route).toContain("withTenantAuth(tenant, Action.candidateRead");
  });

  // A shared cache holding these would serve one tenant's file to another.
  it("never lets a shared cache hold a tenant file", () => {
    expect(route).toContain("private");
  });
});
