import { setting, settingSource } from "@pratibha/shared/settings-runtime";

/**
 * The portal's public URL, for links in emails and payment redirects.
 *
 * Read through the settings runtime rather than process.env.NEXT_PUBLIC_APP_URL:
 * Next inlines NEXT_PUBLIC_ variables at build time, so a value changed in the
 * admin panel would never reach code that reads the variable directly. With
 * neither the panel nor the server's .env saying anything, the caller's own
 * fallback (usually the request's origin) wins over the registry default.
 */
export function appUrl(fallback?: string): string {
  const url = settingSource("brand.app_url") === "default" && fallback ? fallback : setting<string>("brand.app_url");
  return url.replace(/\/+$/, "");
}
