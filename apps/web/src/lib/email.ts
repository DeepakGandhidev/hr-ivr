import { adminPrisma } from "@pratibha/prisma";
import { deliverEmail, logEmail, type MailerDb } from "@pratibha/shared/mailer";
import { displayNameOf } from "@pratibha/shared/platform-mail";
import { setting, settingText } from "@pratibha/shared/settings-runtime";
import { sendViaMailbox } from "@/lib/smtp";
import type { EmailConnection } from "@pratibha/prisma";

export interface SendEmailPayload {
  /** Which email this is (see EMAIL_KINDS): its on/off switch and its row in the log. */
  kind: string;
  /** The workspace it is about, for the log. */
  tenantId?: string | null;
  /** Send at most once per key. */
  dedupeKey?: string;
  to: string;
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  /**
   * Absolute URL of the tenant's logo, when they have one.
   *
   * Absolute because the message is read in somebody else's inbox, where a
   * relative path resolves to nothing. When present the mail goes out as HTML
   * with the logo above the text, and the plain text is still sent alongside -
   * a candidate whose client blocks images, or shows text only, must still be
   * able to read the whole invitation.
   */
  logoUrl?: string;
}

/**
 * Wrap a plain-text message so it can carry the company's logo.
 *
 * Deliberately minimal: inline styles, a table-free single column, no web
 * fonts. Mail clients are not browsers, and the more this tries the more ways
 * it has to arrive broken. The text is escaped - it is recruiter-authored and
 * template-substituted, and neither is a reason to let markup through.
 */
export function renderBrandedEmail(body: string, logoUrl: string, companyName: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
    'font-size:15px;line-height:1.6;color:#18181b;max-width:600px;margin:0 auto;padding:24px;">',
    `<img src="${logoUrl}" alt="${companyName.replace(/"/g, "&quot;")}" `,
    'style="max-width:160px;max-height:64px;object-fit:contain;display:block;margin-bottom:20px;" />',
    `<div style="white-space:pre-wrap;">${escaped}</div>`,
    "</div>",
  ].join("");
}

/**
 * The sender a candidate sees: "<Company> via Pratibha". The address is always
 * Pratibha's own mailbox (the mailer sets it); only the name is chosen here.
 * A plan without "Emails sent in the company's name" sends as the product.
 */
export function outreachFromAddress(_tenantSlug: string, tenantName: string, inCompanyName = true): string {
  const via = settingText("messages.sender_name", "Pratibha");
  const name = inCompanyName ? `${tenantName} via ${via}` : via;
  return `${name} <mailbox>`;
}

/**
 * Absolute URL of a tenant's logo, for use in an email.
 *
 * Absolute, because the message is read in somebody else's inbox where a
 * relative path resolves to nothing. Returns null when the deployment has no
 * public base URL configured - a broken image is worse than no image, and a
 * localhost URL in a candidate's inbox is exactly that.
 */
export function tenantLogoUrl(tenantSlug: string, hasLogo: boolean): string | undefined {
  if (!hasLogo) return undefined;

  const base = process.env.PUBLIC_BASE_URL;
  if (!base || base.includes("localhost") || base.includes("127.0.0.1")) return undefined;

  return `${base.replace(/\/$/, "")}/api/public/${tenantSlug}/logo`;
}

export interface SendEmailResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** The mail server's reply. */
  smtpResponse?: string;
  /** Not sent because the email is switched off in the admin panel. */
  skipped?: boolean;
}

const mailerDb = adminPrisma as unknown as MailerDb;

/**
 * Send from Pratibha's mailbox (connected on the admin panel's Email page).
 * There is no other provider: with no mailbox connected the email is not sent
 * and the result says so.
 */
export async function sendEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  const fromName = displayNameOf(payload.from);
  const result = await deliverEmail(mailerDb, {
    kind: payload.kind,
    tenantId: payload.tenantId,
    dedupeKey: payload.dedupeKey,
    to: payload.to,
    subject: payload.subject,
    text: payload.body,
    ...(payload.logoUrl ? { html: renderBrandedEmail(payload.body, payload.logoUrl, fromName ?? "") } : {}),
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    fromName,
  });
  return {
    ok: result.ok,
    providerMessageId: result.messageId,
    error: result.error,
    smtpResponse: result.response,
    skipped: result.status === "skipped",
  };
}

/**
 * Send as the tenant, preferring their own mailbox over Pratibha's.
 *
 *   1. the mailbox they connected with a password — their real address, and
 *      replies land in the inbox they already read;
 *   2. Pratibha's mailbox, as "<Company> via Pratibha" — for tenants on OAuth
 *      or a forward alias, where we hold no password to send with, and as the
 *      fallback when their own mailbox fails.
 *
 * The result says which route was taken so the UI can tell the recruiter
 * where their mail actually went out from.
 */
export async function sendAsTenant(
  connection: EmailConnection | null,
  tenant: { id?: string; slug: string; name: string },
  payload: SendEmailPayload
): Promise<
  SendEmailResult & {
    via: "mailbox" | "platform";
    /** Whether a copy was filed in their Sent folder. */
    savedToSent?: boolean;
  }
> {
  // messages.transport: "platform" skips the workspace mailbox entirely, for
  // a mailbox that accepts mail and then silently fails to deliver it.
  const forced = setting<string>("messages.transport");
  const mailboxUsable = Boolean(connection && connection.provider === "imap" && connection.imapSecret);

  if (forced !== "platform" && mailboxUsable) {
    const result = await sendViaMailbox(connection!, {
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      fromName: tenant.name,
    });
    await logEmail(mailerDb, {
      kind: payload.kind,
      tenantId: payload.tenantId ?? tenant.id ?? null,
      to: payload.to,
      subject: payload.subject,
      ok: result.ok,
      error: result.ok ? undefined : `Workspace mailbox: ${result.error}`,
      response: result.response,
    });

    if (result.ok) {
      return {
        ok: true,
        providerMessageId: result.providerMessageId,
        via: "mailbox",
        smtpResponse: result.response,
        savedToSent: result.savedToSent,
      };
    }

    console.error("[email] Tenant mailbox send failed, falling back:", result.error);
    const fallback = await sendEmail(payload);
    return {
      ...fallback,
      via: "platform",
      // Keep the mailbox reason when the fallback also fails, because that is
      // the one the recruiter can actually fix.
      ...(fallback.ok ? {} : { error: `mailbox: ${result.error}; Pratibha: ${fallback.error}` }),
    };
  }

  return { ...(await sendEmail(payload)), via: "platform" };
}
