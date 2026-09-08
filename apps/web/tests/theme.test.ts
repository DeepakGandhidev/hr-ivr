import { describe, it, expect } from "vitest";
import { isTheme, themeAttribute, THEME_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

describe("themeAttribute", () => {
  it("pins the two explicit choices", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("removes the attribute for system rather than writing a value", () => {
    // data-theme="system" matches no rule in globals.css, so writing it would
    // pin the app to the light default and break "follow my OS" entirely.
    expect(themeAttribute("system")).toBeNull();
  });
});

describe("isTheme", () => {
  it("accepts the three real values", () => {
    for (const value of ["light", "dark", "system"]) expect(isTheme(value)).toBe(true);
  });

  it("rejects anything else, so stale storage cannot set a bogus attribute", () => {
    for (const value of [null, undefined, "", "Dark", "auto", 1, {}]) {
      expect(isTheme(value)).toBe(false);
    }
  });
});

describe("THEME_SCRIPT", () => {
  it("reads the same storage key the toggle writes", () => {
    // The script runs unbundled in <head> and cannot import the constant at
    // runtime, so this is what stops the two from drifting apart — a mismatch
    // would look like the toggle forgetting the choice on every reload.
    expect(THEME_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it("only ever applies the two explicit themes", () => {
    expect(THEME_SCRIPT).toContain('t==="light"');
    expect(THEME_SCRIPT).toContain('t==="dark"');
    expect(THEME_SCRIPT).not.toContain("system");
  });

  it("swallows storage failures, so a blocked cookie jar cannot break the page", () => {
    // A throw here runs before anything else on the page and would leave the
    // app blank rather than merely unthemed.
    expect(THEME_SCRIPT).toMatch(/try\{[\s\S]*\}catch\(e\)\{\}/);
  });

  it("is self-contained, so it can be injected as a bare inline script", () => {
    expect(THEME_SCRIPT).not.toMatch(/\b(import|require|export)\b/);
    expect(THEME_SCRIPT.trim().startsWith("(function()")).toBe(true);
  });

  it("carries no closing script tag that would end the tag early", () => {
    // dangerouslySetInnerHTML does no escaping; a "</script>" in the payload
    // would terminate the tag and dump the rest into the document as markup.
    expect(THEME_SCRIPT.toLowerCase()).not.toContain("</script");
  });
});
