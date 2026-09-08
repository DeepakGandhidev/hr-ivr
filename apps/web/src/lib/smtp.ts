import nodemailer from "nodemailer";
import { openSecret } from "@pratibha/shared/crypto";
import type { EmailConnection } from "@pratibha/prisma";

/**
 * Send through the tenant's own mailbox, using the credentials they gave when
 * connecting it.
 *
 * This is the difference between mail that arrives and mail that does not.
 * Resend refuses any From on a domain that is not verified in the account, so a
 * tenant who has not done DNS work gets nothing delivered. Their mailbox is
 * already proven to work — the poller logs into it — and mail sent from it
 * comes from their real address, so replies land in the inbox they already
 * read and the message is not a lookalike from a third-party domain.
 *
 * Only IMAP connections carry a password we hold. OAuth providers (gmail,
 * outlook) grant read scopes here and forward_alias has no credential at all,
 * so those fall back to the transactional provider.
 */

export interface SmtpTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * cPanel, Plesk, Zoho and the other hosts this product meets serve SMTP on the
 * same hostname as IMAP, which is why nothing extra is asked of the user when
 * they connect a mailbox. The port is the part that differs: 465 is implicit
 * TLS, 587 is STARTTLS, and hosts disagree about which they offer, so both are
 * tried rather than making the recruiter guess.
 */
export function smtpCandidates(connection: EmailConnection): SmtpTarget[] {
  if (!connection.imapHost || !connection.imapSecret) return [];

  const pass = openSecret(connection.imapSecret);
  const user = connection.imapUsername ?? connection.address;
  const host = process.env.SMTP_HOST ?? connection.imapHost;
  const from = connection.address;

  const configured = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
  if (configured) {
    return [{ host, port: configured, secure: configured === 465, user, pass, from }];
  }

  return [
    { host, port: 465, secure: true, user, pass, from },
    { host, port: 587, secure: false, user, pass, from },
  ];
}

export interface MailboxSendPayload {
  to: string;
  subject: string;
  body: string;
  /** Display name to show alongside the mailbox address. */
  fromName?: string;
}

export interface MailboxSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** Which port actually worked, so the settings panel can report it. */
  port?: number;
}

/**
 * @returns ok:false rather than throwing — one candidate's send failing must
 * not abort a batch, and the reason is what the recruiter needs to see.
 */
export async function sendViaMailbox(
  connection: EmailConnection,
  payload: MailboxSendPayload
): Promise<MailboxSendResult> {
  let targets: SmtpTarget[];
  try {
    targets = smtpCandidates(connection);
  } catch (error) {
    // openSecret throws when EMAIL_SECRET_KEY is wrong or the row was edited.
    return { ok: false, error: error instanceof Error ? error.message : "Could not read mailbox credential" };
  }

  if (targets.length === 0) {
    return { ok: false, error: "This mailbox has no stored password to send with" };
  }

  let lastError = "SMTP send failed";

  for (const target of targets) {
    const transport = nodemailer.createTransport({
      host: target.host,
      port: target.port,
      secure: target.secure,
      auth: { user: target.user, pass: target.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });

    try {
      const info = await transport.sendMail({
        from: payload.fromName ? `${payload.fromName} <${target.from}>` : target.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.body,
      });
      return { ok: true, providerMessageId: info.messageId, port: target.port };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "SMTP send failed";
      // An authentication failure is the credential being wrong, not the port
      // being wrong — retrying the other port would just lock the mailbox out
      // faster on hosts running brute-force protection.
      if (/invalid login|authentication|535|534/i.test(lastError)) break;
    } finally {
      transport.close();
    }
  }

  return { ok: false, error: lastError };
}
