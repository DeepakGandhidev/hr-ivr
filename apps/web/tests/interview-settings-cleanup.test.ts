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
    expect(page).toContain("spoken name, not the legal entity");
    expect(page).toContain("Company profile");
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

  it("spaces helper text with a positive gap", () => {
    expect(page).toContain('className="subtle field-hint"');
    expect(css).toContain(".field-hint");
    // The rule that replaced the negative inline margin.
    const rule = css.slice(css.indexOf(".stack > .field-hint"));
    expect(rule).toMatch(/margin-top:\s*6px/);
  });
});
