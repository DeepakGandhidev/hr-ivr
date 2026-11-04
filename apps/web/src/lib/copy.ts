import { SETTINGS, SETTINGS_BY_KEY } from "@pratibha/shared/settings-registry";
import { settingText } from "@pratibha/shared/settings-runtime";
import { fill, type CopyVars } from "@/lib/copy-fill";

/**
 * Customer- and candidate-facing wording from the admin panel (Text and
 * emails). Server only: settings-runtime uses node crypto, so client
 * components get their text through <CopyProvider> / useCopy() instead.
 *
 * The default of every key is the wording the product shipped with, so with
 * nothing saved every page and email reads exactly as before.
 */

export { fill, type CopyVars };

/** Prefixes the portal (everything under /[tenant]) hands to its client components. */
export const PORTAL_COPY_PREFIXES = ["copy.portal.", "copy.status."];
/** Prefixes the login, sign-up, verify and reset screens hand down. */
export const AUTH_COPY_PREFIXES = ["copy.auth."];

function defaultOf(key: string): string {
  const def = SETTINGS_BY_KEY[key];
  if (!def || def.group !== "copy") throw new Error(`Unknown copy key ${key}`);
  return String(def.default ?? "");
}

/** One piece of text, with {placeholders} filled from `vars`. */
export function copyText(key: string, vars?: CopyVars): string {
  return fill(settingText(key, defaultOf(key)), vars);
}

/**
 * Effective text for every copy key under the given prefixes, for passing to
 * a client <CopyProvider>. Placeholders are left in; the client fills them.
 */
export function copyFor(prefixes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of SETTINGS) {
    if (def.group !== "copy" || !prefixes.some((p) => def.key.startsWith(p))) continue;
    out[def.key] = settingText(def.key, String(def.default ?? ""));
  }
  return out;
}
