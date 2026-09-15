import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const page = readFileSync(
  path.join(APP_ROOT, "src/app/[tenant]/settings/protocols/page.tsx"),
  "utf8"
);
const css = readFileSync(path.join(APP_ROOT, "src/app/globals.css"), "utf8");

/**
 * Two fields were doing one job: a standalone "Company name" that wrote
 * tenant.name, and a scoped "Hiring under" on the protocol — the same value at
 * workspace scope, with two different save behaviours and no way to tell which
 * one the agent would actually say.
 *
 * The scoped field wins, because the scope selector already does the job the
 * two fields were splitting between them. The worker resolves
 * `protocol.companyName ?? tenant.name`, so the workspace name remains the
 * fallback and is edited in Company profile instead.
 */
describe("interview settings name fields", () => {
  it("has no standalone company-name editor", () => {
    expect(page).not.toContain('htmlFor="company"');
    expect(page).not.toContain("saveCompany");
  });

  it("keeps one scoped name field", () => {
    expect(page).toContain('htmlFor="brand"');
    expect(page.match(/htmlFor="brand"/g)).toHaveLength(1);
  });

  it("says which name this is, and where the legal one lives", () => {
    // Whitespace-normalised: the copy is line-wrapped in JSX, and how it wraps
    // is not the requirement. That it says which name this is, is.
    const copy = page.replace(/\s+/g, " ");
    expect(copy).toContain("spoken name, not the legal entity");
    expect(copy).toContain("Company profile");
  });
});

/**
 * The helper text under Length, Minimum questions, Maximum questions and Agent
 * name overlapped the inputs above it: an inline `marginTop: -8` overrode the
 * stack's 14px gap and pulled the paragraph up into them.
 */
describe("interview settings layout", () => {
  it("uses no negative top margins", () => {
    expect(page).not.toMatch(/marginTop:\s*-/);
  });

  /**
   * The bug was helper text colliding with the inputs above it. What matters is
   * that the gap is positive — not which styling system provides it. The page
   * has since been restyled onto Tailwind, where `hintCls` carries the margin;
   * the `.field-hint` rule still exists for the screens that use it.
   */
  it("spaces helper text with a positive gap", () => {
    const tailwindHint = /hintCls\s*=\s*"[^"]*\bmt-[0-9.]+/.test(page);
    const legacyHint = page.includes('className="subtle field-hint"');
    expect(tailwindHint || legacyHint).toBe(true);

    // Nothing may pull text upward, in either system.
    expect(page).not.toMatch(/-mt-[0-9]/);
    expect(css).toContain(".field-hint");
  });
});
