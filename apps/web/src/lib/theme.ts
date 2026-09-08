/**
 * Theme selection, shared by the toggle and the pre-paint script.
 *
 * Both need the same storage key and the same light/dark/system rules, but they
 * run in very different places — one is a React client component, the other a
 * raw string injected into <head> before any JavaScript module exists. Keeping
 * the key in one module means the two cannot drift apart and silently stop
 * seeing each other's value, which would read as "the toggle forgets my
 * choice on reload".
 *
 * No "use client" here: this is imported by the server-rendered root layout as
 * well, and it is plain data with no component in it.
 */

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "pratibha-theme";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * The value for the data-theme attribute, or null to remove it.
 *
 * "system" removes the attribute rather than setting a value, because the
 * prefers-color-scheme media query in globals.css is what follows the OS —
 * writing data-theme="system" would match no rule and pin the app to light.
 */
export function themeAttribute(theme: Theme): string | null {
  return theme === "system" ? null : theme;
}

export function applyTheme(theme: Theme) {
  const attribute = themeAttribute(theme);
  if (attribute === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", attribute);
}

/**
 * Blocking script for <head>. It must run before the first paint: the browser
 * paints the light default as soon as it has the CSS, so applying the theme in
 * an effect gives every dark-mode user a white flash on each navigation.
 *
 * Deliberately written as ES5 with its own try/catch — it runs unbundled and
 * untranspiled, and localStorage throws outright in private mode and when a
 * browser is set to block site data.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;
