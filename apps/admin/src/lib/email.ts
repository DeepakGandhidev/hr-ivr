import { Resend } from "resend";

/**
 * Mail from the panel: admin invites, and notices to a workspace owner when an
 * admin resets or removes one of their members. Never to a candidate.
 *
 * Without RESEND_API_KEY nothing is sent: the message is logged and the caller
 * is told, so a local or staging panel cannot email a real customer by
 * accident (the same default the portal uses).
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(mail: Mail): Promise<{ sent: boolean }> {
  const key = process.env.RESEND_API_KEY;
  const from =
    process.env.ADMIN_EMAIL_FROM ??
    (process.env.RESEND_FROM_DOMAIN ? `Pratibha <team@${process.env.RESEND_FROM_DOMAIN}>` : null);

  if (!key || !from) {
    console.info(`[admin mail, not sent: no RESEND_API_KEY]\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    return { sent: false };
  }

  const resend = new Resend(key);
  const { error } = await resend.emails.send({ from, to: mail.to, subject: mail.subject, text: mail.text });
  if (error) {
    console.error("[admin mail] send failed", error);
    return { sent: false };
  }
  return { sent: true };
}
