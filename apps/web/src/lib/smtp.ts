import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ImapFlow } from "imapflow";
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
  /** The SMTP server's own reply, e.g. "250 OK id=...". */
  response?: string;
  /** Recipients the server took responsibility for. */
  accepted?: string[];
  rejected?: string[];
  /** Whether a copy was filed in the mailbox's Sent folder. */
  savedToSent?: boolean;
}

/**
 * Put a copy in the mailbox's Sent folder.
 *
 * SMTP delivers a message; it does not file one. Every mail client you have
 * used runs a separate IMAP APPEND to put the copy in Sent, and without it the
 * recruiter opens webmail, sees nothing in Sent, and reasonably concludes the
 * app never sent anything — which is exactly the report this fixes. The message
 * really had gone, with no trace on their side.
 *
 * Never throws: the mail is already delivered by the time this runs, so a
 * failure here is a missing copy, not a failed send.
 */
async function saveToSentFolder(
  connection: EmailConnection,
  target: SmtpTarget,
  raw: Buffer
): Promise<boolean> {
  const client = new ImapFlow({
    host: connection.imapHost!,
    port: connection.imapPort ?? 993,
    secure: connection.imapSecure ?? true,
    auth: { user: target.user, pass: target.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    logger: false,
  });

  try {
    await client.connect();

    // The Sent folder has no fixed name: cPanel uses INBOX.Sent, others use
    // Sent or Sent Items. The \Sent special-use flag is the reliable answer
    // when the server publishes it, so that is tried before guessing.
    const boxes = await client.list();
    const special = boxes.find((box) => box.specialUse === "\\Sent");
    const byName = boxes.find((box) => /^(INBOX[./])?Sent( Items| Mail)?$/i.test(box.path));
    const path = special?.path ?? byName?.path;
    if (!path) return false;

    // \Seen because the sender has, by definition, read what they just wrote —
    // without it the Sent folder shows a bogus unread badge.
    await client.append(path, raw, ["\\Seen"]);
    return true;
  } catch (error) {
    console.error("[email] Could not file a copy in Sent:", error instanceof Error ? error.message : error);
    return false;
  } finally {
    await client.logout().catch(() => {});
  }
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
      // Composed once and sent as raw, so the copy filed in Sent is byte-for-byte
      // the message that was delivered — same Message-ID, same date. Composing
      // twice would put a near-miss in Sent that does not match what arrived.
      const raw = await new MailComposer({
        from: payload.fromName ? `${payload.fromName} <${target.from}>` : target.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.body,
      })
        .compile()
        .build();

      const info = await transport.sendMail({
        raw,
        envelope: { from: target.from, to: payload.to },
      });

      const savedToSent = await saveToSentFolder(connection, target, raw);

      return {
        ok: true,
        providerMessageId: info.messageId,
        port: target.port,
        response: info.response,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        savedToSent,
      };
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
