import { Resend } from "resend";

export interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
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
