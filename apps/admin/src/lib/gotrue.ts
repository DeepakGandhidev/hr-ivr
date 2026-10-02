import { randomBytes } from "node:crypto";
import { AdminApiError } from "@/lib/http";

/**
 * The portal's identity service (GoTrue), reached with its service key for the
 * few things the panel does to customer accounts: open a one-time sign in for
 * Sign in as, send a member a password reset, and create a new workspace's
 * owner.
 *
 * This is the only bridge to the portal's auth, and it runs one way: the panel
 * asks GoTrue for a single-use token and hands the browser to the portal's own
 * confirm route. No portal session ever comes back this way.
 */
function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new AdminApiError(
      503,
      "AUTH_NOT_CONFIGURED",
      "The portal's auth service is not configured for the admin panel (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function gotrue<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const { url, key } = config();
  const res = await fetch(`${url}/auth/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(data.msg ?? data.message ?? data.error_description ?? data.error ?? res.statusText);
    throw new AdminApiError(res.status === 422 ? 409 : 502, "AUTH_SERVICE", `The portal's auth service refused: ${msg}`);
  }
  return data as T;
}

export type LinkType = "magiclink" | "recovery";

/** A single-use token for the portal's /auth/confirm route. */
export async function oneTimeToken(type: LinkType, email: string): Promise<string> {
  const data = await gotrue<Record<string, any>>("/admin/generate_link", { type, email });
  const hashed = data.hashed_token ?? data.properties?.hashed_token;
  if (!hashed) throw new AdminApiError(502, "AUTH_SERVICE", "The portal's auth service did not return a token.");
  return String(hashed);
}

export function portalUrl(path: string): string {
  const base = (process.env.PORTAL_BASE_URL ?? "https://pratibha.tech").replace(/\/$/, "");
  return `${base}${path}`;
}

/** The portal link that exchanges a token for a session, then goes to `next`. */
export function confirmUrl(token: string, type: LinkType, next: string): string {
  const q = new URLSearchParams({ token_hash: token, type, next });
  return portalUrl(`/auth/confirm?${q.toString()}`);
}

/** Create a confirmed portal identity with an unusable password; the owner sets theirs from a reset link. */
export async function createPortalIdentity(email: string, name: string): Promise<string> {
  const data = await gotrue<Record<string, any>>("/admin/users", {
    email,
    email_confirm: true,
    password: randomBytes(24).toString("base64url"),
    user_metadata: { name },
  });
  const id = data.id ?? data.user?.id;
  if (!id) throw new AdminApiError(502, "AUTH_SERVICE", "The portal's auth service did not return a user.");
  return String(id);
}
