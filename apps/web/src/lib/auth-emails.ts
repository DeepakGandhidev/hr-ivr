import { adminPrisma } from "@pratibha/prisma";
import { settingText } from "@pratibha/shared/settings-runtime";
import { appUrl } from "@/lib/app-url";
import { copyText } from "@/lib/copy";
import { emailChangeRequestedEmail, type BuiltEmail } from "@/lib/copy-emails";
import { sendEmail, type SendEmailResult } from "@/lib/email";
import { confirmUrl, generateLink, GoTrueError, isEmailTaken } from "@/lib/gotrue-admin";

/**
 * The sign-in emails: confirm your email, reset your password, confirm your
 * new address. GoTrue used to write and send these from its own SMTP
 * settings; now it only issues the token (lib/gotrue-admin.ts) and the email
 * goes out from Pratibha's mailbox like every other one, worded from the
 * admin panel (Text and emails) and logged in email_log.
 */

function greeting(name: string | null | undefined): string {
  return name ? copyText("copy.email.account.greeting", { name }) : copyText("copy.email.account.greeting_anonymous");
}

function product(): string {
  return settingText("brand.product_name", "Pratibha");
}

export function signupConfirmEmail(args: { name?: string | null; workspace: string; link: string }): BuiltEmail {
  const p = product();
  return {
    subject: copyText("copy.email.signup_confirm.subject", { product: p }),
    body:
      `${greeting(args.name)}\n\n` +
      `${copyText("copy.email.signup_confirm.body", { product: p, workspace: args.workspace, link: args.link })}\n`,
  };
}

export function passwordResetEmail(args: { name?: string | null; email: string; link: string }): BuiltEmail {
  const p = product();
  return {
    subject: copyText("copy.email.password_reset.subject", { product: p }),
    body:
      `${greeting(args.name)}\n\n` +
      `${copyText("copy.email.password_reset.body", { product: p, email: args.email, link: args.link })}\n`,
  };
}

export function emailChangeConfirmEmail(args: { name?: string | null; oldEmail: string; newEmail: string; link: string }): BuiltEmail {
  const p = product();
  return {
    subject: copyText("copy.email.email_change_confirm.subject", { product: p }),
    body:
      `${greeting(args.name)}\n\n` +
      `${copyText("copy.email.email_change_confirm.body", { product: p, old_email: args.oldEmail, new_email: args.newEmail, link: args.link })}\n`,
  };
}

/** The notice to the old address, with its own approval link when GoTrue wants both addresses to confirm. */
export function emailChangeApprovalEmail(args: { name?: string | null; oldEmail: string; newEmail: string; link: string }): BuiltEmail {
  const notice = emailChangeRequestedEmail(args);
  return { subject: notice.subject, body: `${notice.body}\n${copyText("copy.email.email_change.approve", { link: args.link })}\n` };
}

/**
 * A once-per-window key for an email anyone can ask for, so the form cannot be
 * used to flood an inbox. The mailer refuses a key already in email_log.
 */
export function rateKey(kind: string, email: string, minutes: number, now = Date.now()): string {
  return `${kind}:${email.toLowerCase()}:${Math.floor(now / (minutes * 60_000))}`;
}

/**
 * Checked before asking GoTrue for a new token, not only by the mailer: a new
 * token replaces the one already sent, so a request we are not going to send
 * must not be allowed to break the link someone already has.
 */
async function alreadySent(dedupeKey: string): Promise<boolean> {
  return Boolean(await adminPrisma.emailLog.findUnique({ where: { dedupeKey }, select: { id: true } }));
}

/** The portal user with this sign-in address, and their workspace. */
async function portalUser(email: string) {
  return adminPrisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, email: true, name: true, tenantId: true, tenant: { select: { name: true, slug: true } } },
  });
}

/** Window for "Forgot password?" and "Send the link again", per address. */
export const RESET_WINDOW_MINUTES = 10;
export const RESEND_WINDOW_MINUTES = 2;

/**
 * Sign-up: send the confirmation for a token the signup route already
 * generated (it needs the user id before it creates the workspace). The link
 * signs them in and lands on the workspace, as sign-up itself used to.
 */
export async function sendSignupConfirmation(args: {
  to: string;
  name?: string | null;
  workspace: string;
  tenantId: string;
  tenantSlug: string;
  token: string;
  origin?: string;
  dedupeKey?: string;
}): Promise<SendEmailResult> {
  const link = confirmUrl(appUrl(args.origin), args.token, "signup", `/${args.tenantSlug}`);
  const email = signupConfirmEmail({ name: args.name, workspace: args.workspace, link });
  return sendEmail({
    kind: "auth_signup_confirm",
    tenantId: args.tenantId,
    to: args.to,
    subject: email.subject,
    body: email.body,
    ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}),
  });
}

/**
 * "Send the link again" for an address still waiting to be confirmed. Says
 * nothing about whether it was: an unknown or already confirmed address just
 * gets no email.
 */
export async function resendSignupConfirmation(email: string, origin?: string): Promise<void> {
  const user = await portalUser(email);
  if (!user) return;
  const dedupeKey = rateKey("auth_signup_confirm", user.email, RESEND_WINDOW_MINUTES);
  if (await alreadySent(dedupeKey)) return;

  let token: string;
  try {
    // An existing unconfirmed user needs no password: GoTrue only issues a new token.
    token = (await generateLink({ type: "signup", email: user.email })).hashedToken;
  } catch (err) {
    if (isEmailTaken(err)) return; // already confirmed: nothing to resend
    throw err;
  }
  const result = await sendSignupConfirmation({
    to: user.email,
    name: user.name,
    workspace: user.tenant.name,
    tenantId: user.tenantId,
    tenantSlug: user.tenant.slug,
    token,
    origin,
    dedupeKey,
  });
  if (!result.ok) console.error(`[auth-emails] signup confirmation to ${user.email} not sent:`, result.error);
}

/**
 * "Forgot password?": a reset link to an address with a portal account, at
 * most once per window. The caller answers the same either way.
 */
export async function requestPasswordReset(email: string, origin?: string): Promise<void> {
  const user = await portalUser(email);
  if (!user) return;
  const dedupeKey = rateKey("auth_password_reset", user.email, RESET_WINDOW_MINUTES);
  if (await alreadySent(dedupeKey)) return;

  let token: string;
  try {
    token = (await generateLink({ type: "recovery", email: user.email })).hashedToken;
  } catch (err) {
    // A portal row whose auth identity is gone or renamed: nothing to reset.
    if (err instanceof GoTrueError && err.status === 404) return;
    throw err;
  }
  const link = confirmUrl(appUrl(origin), token, "recovery", "/reset-password");
  const built = passwordResetEmail({ name: user.name, email: user.email, link });
  const result = await sendEmail({
    kind: "auth_password_reset",
    tenantId: user.tenantId,
    to: user.email,
    subject: built.subject,
    body: built.body,
    dedupeKey,
  });
  if (!result.ok) console.error(`[auth-emails] password reset to ${user.email} not sent:`, result.error);
}

/**
 * Start (or restart) an email change and word its two emails: the new address
 * gets the link that makes the change, the old one is told. When GoTrue runs
 * with secure email change on, it also wants the old address to approve, so
 * that notice carries the second link (and becomes required mail); with it
 * off, GoTrue refuses to issue one and the notice is the plain warning it
 * always was.
 *
 * GoTrue now holds the pending change. Throws when it refuses (e.g. the
 * address is taken). The caller sends both emails.
 */
export async function prepareEmailChange(args: {
  tenantSlug: string;
  name?: string | null;
  oldEmail: string;
  newEmail: string;
  origin?: string;
}): Promise<{ toNew: BuiltEmail; toOld: BuiltEmail; toOldKind: "auth_email_change_confirm" | "account_email_change_notice" }> {
  const base = appUrl(args.origin);
  const next = `/${args.tenantSlug}/settings/profile`;
  const { hashedToken } = await generateLink({ type: "email_change_new", email: args.oldEmail, newEmail: args.newEmail });

  let approveToken: string | null = null;
  try {
    approveToken = (await generateLink({ type: "email_change_current", email: args.oldEmail, newEmail: args.newEmail })).hashedToken;
  } catch (err) {
    // 400 is GoTrue saying secure email change is off: the new address alone decides.
    if (!(err instanceof GoTrueError && err.status === 400)) console.error("[auth-emails] approval link for the old address failed:", err);
  }

  const people = { name: args.name, oldEmail: args.oldEmail, newEmail: args.newEmail };
  return {
    toNew: emailChangeConfirmEmail({ ...people, link: confirmUrl(base, hashedToken, "email_change", next) }),
    toOld: approveToken
      ? emailChangeApprovalEmail({ ...people, link: confirmUrl(base, approveToken, "email_change", next) })
      : emailChangeRequestedEmail(people),
    toOldKind: approveToken ? "auth_email_change_confirm" : "account_email_change_notice",
  };
}
