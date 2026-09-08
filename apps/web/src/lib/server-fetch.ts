import { headers } from "next/headers";

/**
 * Calls this app's own API from a server component.
 *
 * Two things make a bare `fetch("/api/...")` fail here, both silently:
 *   - Node's fetch needs an absolute URL, so a relative path throws
 *     "Failed to parse URL" and the page 500s.
 *   - Server-side fetch sends no cookies of its own, so even an absolute URL
 *     arrives unauthenticated and the API answers 401.
 *
 * This resolves the origin from the incoming request and forwards the caller's
 * cookies, so the API sees the same session the page was rendered for — and
 * therefore the same tenant scoping and role.
 */
export async function apiGet<T>(path: string, fallback: T): Promise<T> {
  const h = headers();
  const host = h.get("host");
  if (!host) return fallback;

  const protocol = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  const res = await fetch(`${protocol}://${host}${path}`, {
    cache: "no-store",
    headers: {
      cookie: h.get("cookie") ?? "",
    },
  });

  if (!res.ok) {
    // A 401/403 here means the session or role does not permit the read. The
    // page renders its empty state rather than crashing, but the reason is
    // logged so it is not mistaken for "no data".
    console.error(`apiGet ${path} -> ${res.status}`);
    return fallback;
  }

  return (await res.json().catch(() => fallback)) as T;
}
