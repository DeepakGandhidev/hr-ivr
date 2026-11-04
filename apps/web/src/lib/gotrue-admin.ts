import { AppError } from "@pratibha/shared";

/**
 * GoTrue's admin API, reached with the service key, for the sign-in emails
 * Pratibha sends itself (lib/auth-emails.ts).
 *
 * The public endpoints (signUp, resetPasswordForEmail, updateUser({ email }),
 * resend) make GoTrue write and send the email from its own SMTP settings.
 * generate_link does the same bookkeeping (creates the unconfirmed user,
 * stores the token, holds the pending email change) and hands the token back
 * instead of mailing it, so the email can go out from Pratibha's mailbox with
 * Pratibha's wording. The link still lands on /auth/confirm, where GoTrue
 * verifies its own token.
 *
 * Server only: the service key bypasses every GoTrue rule.
 */

export class GoTrueError extends Error {
  constructor(
    readonly status: number,
    /** GoTrue's error_code, e.g. "email_exists", when it sends one. */
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = "GoTrueError";
  }
}

function config() {
  // The same address the browser and server clients use; GoTrue is under /auth/v1.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new AppError(
      "AUTH_NOT_CONFIGURED",
      "Sign-in emails need the auth service's service key (SUPABASE_SERVICE_ROLE_KEY) on this server.",
      503
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

async function gotrue<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
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
    const code = typeof data.error_code === "string" ? data.error_code : null;
    throw new GoTrueError(res.status, code, msg);
  }
  return data as T;
}

/** An address that already has a confirmed account (GoTrue answers 422). */
export function isEmailTaken(err: unknown): boolean {
  if (!(err instanceof GoTrueError)) return false;
  return err.code === "email_exists" || (err.status === 422 && /already (been )?registered|already exists/i.test(err.message));
}

/**
 * Whether GoTrue confirms new accounts by itself (GOTRUE_MAILER_AUTOCONFIRM).
 * Local development runs with it on, so nobody has to fish a link out of a
 * mail catcher. Unreadable counts as off: asking to confirm is the safe side.
 */
export async function mailerAutoconfirm(): Promise<boolean> {
  try {
    const data = await gotrue<{ mailer_autoconfirm?: boolean }>("/settings");
    return data.mailer_autoconfirm === true;
  } catch {
    return false;
  }
}

export type LinkType = "signup" | "magiclink" | "recovery" | "email_change_new" | "email_change_current";

export interface GeneratedLink {
  /** What /auth/confirm hands back to GoTrue as token_hash. */
  hashedToken: string;
  /** The auth user the link is for (for "signup", the user it just created). */
  userId: string | null;
}

/**
 * A one-time link token, without GoTrue sending anything.
 *
 * "signup" creates the unconfirmed user when there is none (and then needs the
 * password); for one that exists and is still unconfirmed it only issues a new
 * token and leaves the password alone, as GoTrue's own signup does. A
 * confirmed address is refused (see isEmailTaken).
 */
export async function generateLink(params: {
  type: LinkType;
  email: string;
  password?: string;
  newEmail?: string;
  data?: Record<string, unknown>;
}): Promise<GeneratedLink> {
  const res = await gotrue<Record<string, any>>("/admin/generate_link", {
    type: params.type,
    email: params.email,
    ...(params.password ? { password: params.password } : {}),
    ...(params.newEmail ? { new_email: params.newEmail } : {}),
    ...(params.data ? { data: params.data } : {}),
  });
  const hashed = res.hashed_token ?? res.properties?.hashed_token;
  if (!hashed) throw new GoTrueError(502, null, "The auth service did not return a token.");
  const userId = res.id ?? res.user?.id ?? null;
  return { hashedToken: String(hashed), userId: userId ? String(userId) : null };
}

/** A confirmed user with this password, for when GoTrue confirms sign-ups by itself. */
export async function createConfirmedUser(email: string, password: string, data: Record<string, unknown>): Promise<string> {
  const res = await gotrue<Record<string, any>>("/admin/users", {
    email,
    password,
    email_confirm: true,
    user_metadata: data,
  });
  const id = res.id ?? res.user?.id;
  if (!id) throw new GoTrueError(502, null, "The auth service did not return a user.");
  return String(id);
}

/** The verify type /auth/confirm passes to GoTrue for each kind of link. */
export type ConfirmType = "signup" | "magiclink" | "recovery" | "email_change";

/** The portal link that exchanges a token for a session, then goes to `next` (a path on this site). */
export function confirmUrl(base: string, token: string, type: ConfirmType, next: string): string {
  const q = new URLSearchParams({ token_hash: token, type, next });
  return `${base.replace(/\/+$/, "")}/auth/confirm?${q.toString()}`;
}
