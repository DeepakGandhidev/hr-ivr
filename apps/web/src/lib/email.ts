import { Resend } from "resend";
import { sendViaMailbox } from "@/lib/smtp";
import type { EmailConnection } from "@pratibha/prisma";

export interface SendEmailPayload {
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
 * §5 Stage 2: outreach goes out as {tenant-slug}@mail.pratibha.tech with
 * reply-to pointing at the tenant's own hiring inbox, unless the tenant granted
 * a send scope on their own mailbox. The domain is configurable because it has
 * to be a domain verified with the mail provider — an unverified one is
 * rejected outright.
 */
export function outreachFromAddress(tenantSlug: string, tenantName: string): string {
  // An explicit sender wins over the per-tenant address. Resend refuses any
  // From on a domain that is not verified in the account (403
  // validation_error), which makes every outbound email fail until DNS is set
  // up — and there is no way to tell that apart from a code fault from the UI.
  // This override lets a deployment send from a working sender (Resend's
  // onboarding@resend.dev, or any verified domain) while its own domain is
  // still pending, instead of having no outbound mail at all.
  const override = process.env.RESEND_FROM_EMAIL;
  if (override) {
    return override.includes("<") ? override : `${tenantName} via Pratibha <${override}>`;
  }

  const domain = process.env.RESEND_FROM_DOMAIN ?? "mail.pratibha.tech";
  return `${tenantName} via Pratibha <${tenantSlug}@${domain}>`;
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
  /** True when no API key is configured and the email was only logged. */
  logOnly?: boolean;
}

export async function sendEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = payload.from ?? process.env.RESEND_FROM_EMAIL ?? "Pratibha <noreply@mail.pratibha.tech>";

  if (!apiKey) {
    console.log("[email log-only] Would send email:", JSON.stringify({ ...payload, from: fromAddress }));
    return { ok: true, logOnly: true };
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: fromAddress,
      to: payload.to,
      subject: payload.subject,
      text: payload.body,
      // Both parts when there is a logo: the client picks, and a text-only
      // reader still gets the whole message.
      ...(payload.logoUrl
        ? { html: renderBrandedEmail(payload.body, payload.logoUrl, payload.from ?? "") }
        : {}),
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    });

    if (error) {
      // Resend reports an unverified sending domain as a 403 whose message names
      // the domain and what to do about it. That message is the difference
      // between a recruiter retrying forever and someone adding a DNS record, so
      // it is passed through rather than flattened to "failed".
      console.error("[email] Resend rejected the send:", error.message, { from: fromAddress });
      return { ok: false, error: error.message };
    }

    return { ok: true, providerMessageId: data?.id };
  } catch (err) {
    // A throw here is a network or SDK fault, not a rejected email. Without this
    // the whole send-invites request 500s and the candidates already mailed in
    // this run are reported as neither sent nor failed.
    const message = err instanceof Error ? err.message : "Email provider unreachable";
    console.error("[email] Send threw:", message, { from: fromAddress });
    return { ok: false, error: message };
  }
}

/**
 * Send as the tenant, preferring their own mailbox over the shared provider.
 *
 * Order matters and is not arbitrary:
 *   1. the mailbox they connected — proven credentials, their real address, and
 *      replies land in the inbox they already read;
 *   2. Resend — for tenants on OAuth or a forward alias, where we hold no
 *      password to send with;
 *   3. log-only, when neither is configured.
 *
 * Falling back on a mailbox failure is deliberate but narrow: if their SMTP is
 * down, a message from the shared sender still beats no message. The result
 * says which route was taken so the UI can tell the recruiter where their mail
 * actually went out from.
 */
export async function sendAsTenant(
  connection: EmailConnection | null,
  tenant: { slug: string; name: string },
  payload: SendEmailPayload
): Promise<
  SendEmailResult & {
    via: "mailbox" | "resend" | "log";
    /** The SMTP server's reply, when the tenant's own mailbox was used. */
    smtpResponse?: string;
    /** Whether a copy was filed in their Sent folder. */
    savedToSent?: boolean;
  }
> {
  // EMAIL_TRANSPORT forces a route when the default order is wrong for a
  // deployment. It exists because a mailbox can accept mail and then silently
  // fail to deliver it: a shared host that answers "250 OK" to every recipient,
  // including domains that cannot exist, has told us nothing, and there is no
  // signal in-band to detect that. Setting "resend" skips the mailbox entirely.
  const forced = process.env.EMAIL_TRANSPORT;
  const mailboxUsable = Boolean(connection && connection.provider === "imap" && connection.imapSecret);

  if (forced !== "resend" && mailboxUsable) {
    const result = await sendViaMailbox(connection!, {
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      fromName: tenant.name,
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
      via: fallback.logOnly ? "log" : "resend",
      // Keep the mailbox reason when the fallback also fails, because that is
      // the one the recruiter can actually fix.
      ...(fallback.ok ? {} : { error: `mailbox: ${result.error}; provider: ${fallback.error}` }),
    };
  }

  const result = await sendEmail(payload);
  return { ...result, via: result.logOnly ? "log" : "resend" };
}
