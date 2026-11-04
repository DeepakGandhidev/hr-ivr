import { createHmac, randomBytes } from "node:crypto";
import { setting } from "@pratibha/shared/settings-runtime";

/**
 * Saarthi, ProMonkey's AI assistant, as a chat on Pratibha's website, sign-in
 * pages and portal.
 *
 * Everything is configured in the admin panel (API keys and Feature switches),
 * so turning it on, off, or onto another Saarthi workspace is a settings
 * change, not a deploy. With no site key, nothing is rendered or loaded.
 */

export interface SaarthiConfig {
  siteKey: string;
  widgetUrl: string;
  /** Anonymous chat on the marketing site and the portal's public pages. */
  publicOn: boolean;
  /** Chat inside the portal for signed-in members. */
  portalOn: boolean;
  /** Whether signed-in chats can carry who the member is (SDK secret set). */
  canSign: boolean;
}

export function saarthiConfig(): SaarthiConfig {
  const siteKey = (setting<string>("integrations.saarthi_site_key") ?? "").trim();
  const widgetUrl = (setting<string>("integrations.saarthi_widget_url") ?? "").trim();
  const usable = Boolean(siteKey) && /^https:\/\//.test(widgetUrl);
  return {
    siteKey,
    widgetUrl,
    publicOn: usable && setting<boolean>("features.saarthi_public"),
    portalOn: usable && setting<boolean>("features.saarthi_portal"),
    canSign: Boolean(setting<string | null>("integrations.saarthi_sdk_secret")),
  };
}

export interface SaarthiUser {
  id: string;
  name?: string | null;
  email?: string | null;
  plan?: string | null;
  /** Account details the assistant may use. At most 10; text at most 100 characters. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Saarthi refuses a token whose name, email or plan is null or empty, so those are left out. */
function present<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== "")
  ) as Partial<T>;
}

/**
 * A fresh, single-use token for one member (HS256, valid 15 minutes), as the
 * Saarthi integration guide specifies. Throws when no SDK secret is set; the
 * caller decides what an anonymous fallback looks like.
 */
export function saarthiToken(user: SaarthiUser, secret = setting<string | null>("integrations.saarthi_sdk_secret")): string {
  if (!secret) throw new Error("Saarthi SDK secret is not set");
  const now = Math.floor(Date.now() / 1000);

  const attrs = Object.fromEntries(
    Object.entries(present(user.attrs ?? {}))
      .slice(0, 10)
      .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 100) : v])
  );

  const header = part({ alg: "HS256", typ: "JWT" });
  const payload = part({
    ...present({
      user_id: String(user.id).slice(0, 128),
      name: user.name ? user.name.trim().slice(0, 100) : undefined,
      // Saarthi refuses the whole token over a malformed email, so a bad one is left out.
      email: user.email && EMAIL.test(user.email.trim()) ? user.email.trim() : undefined,
      plan: user.plan ? String(user.plan).slice(0, 50) : undefined,
    }),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    iat: now,
    exp: now + 900,
    nonce: randomBytes(24).toString("base64url"),
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * A value safe to drop into an inline <script>: JSON, with "<" escaped so no
 * setting can close the script tag early.
 */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
