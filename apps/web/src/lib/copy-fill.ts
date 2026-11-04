/**
 * Placeholder filling for admin-editable copy. Pure, so both the server
 * helper (lib/copy.ts) and the client hook (lib/copy-client.tsx) use it.
 *
 * `{name}` is replaced with vars.name when the caller passed one. A
 * placeholder the caller did not pass is left as written, so a typo in the
 * admin panel shows up on the page instead of silently vanishing.
 */
export type CopyVars = Record<string, string | number>;

export function fill(text: string, vars?: CopyVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/** The {placeholders} a text uses, in order of first appearance. */
export function placeholdersIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (m) => m[1])));
}
