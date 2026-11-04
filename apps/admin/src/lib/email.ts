import { deliverEmail, type MailerDb } from "@pratibha/shared/mailer";
import { platformSenderName } from "@pratibha/shared/platform-mail";
import { db } from "@/lib/db";

/**
 * Mail from the panel: admin invites, and notices to a workspace owner when an
 * admin creates a workspace or changes its members. Never to a candidate.
 *
 * Sent from Pratibha's mailbox (the Email page). With none connected nothing
 * is sent; the attempt is logged with the reason and the caller is told.
 */
export interface Mail {
  /** One of EMAIL_KINDS. */
  kind: string;
  to: string;
  subject: string;
  text: string;
  tenantId?: string | null;
  /** Send at most once per key. */
  dedupeKey?: string;
}

export async function sendMail(mail: Mail): Promise<{ sent: boolean; error?: string }> {
  const result = await deliverEmail(db as unknown as MailerDb, {
    kind: mail.kind,
    tenantId: mail.tenantId ?? null,
    ...(mail.dedupeKey ? { dedupeKey: mail.dedupeKey } : {}),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    fromName: platformSenderName(),
  });
  return { sent: result.ok, error: result.error };
}
