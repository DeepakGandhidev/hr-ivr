import type { AdminUser } from "@pratibha/prisma";
import { checkMailboxLogin, platformSmtp } from "@pratibha/shared/platform-mail";
import { badRequest } from "@/lib/http";
import { saveSettings } from "@/lib/settings-admin";
import { sendMail } from "@/lib/email";

/**
 * The Email page: connect Pratibha's mailbox with an address and a password.
 *
 * The login is proved with the mail server before anything is saved, so the
 * panel never stores a mailbox that cannot send. Host and port default to
 * Hostinger's (where pratibha.tech's mail lives); the advanced fields are only
 * for a different provider.
 */

const KNOWN_HOSTS: Record<string, { host: string; port: number }> = {
  "gmail.com": { host: "smtp.gmail.com", port: 465 },
  "googlemail.com": { host: "smtp.gmail.com", port: 465 },
  "outlook.com": { host: "smtp.office365.com", port: 587 },
  "hotmail.com": { host: "smtp.office365.com", port: 587 },
  "zoho.com": { host: "smtp.zoho.com", port: 465 },
  "zoho.in": { host: "smtp.zoho.in", port: 465 },
};

export function guessSmtp(address: string): { host: string; port: number } {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return KNOWN_HOSTS[domain] ?? { host: "smtp.hostinger.com", port: 465 };
}

export async function connectMailbox(
  admin: AdminUser,
  input: { address: string; password: string; host?: string; port?: number }
) {
  const address = input.address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw badRequest("Enter the full email address, e.g. info@pratibha.tech.");
  if (!input.password) throw badRequest("Enter the mailbox password.");
  const guess = guessSmtp(address);
  const host = input.host?.trim() || guess.host;
  const port = input.port || guess.port;

  const login = await checkMailboxLogin({ host, port, user: address, pass: input.password });
  if (!login.ok) {
    throw badRequest(
      `${host} did not accept that address and password: ${login.error}. Check the password, and that the mailbox exists in your email hosting.`
    );
  }

  await saveSettings(admin, {
    set: {
      "messages.smtp_user": address,
      "messages.smtp_host": host,
      "messages.smtp_port": port,
      "integrations.smtp_password": input.password,
    },
  });

  const test = await sendTestEmail(admin);
  return { message: `Connected ${address}. ${test.message}` };
}

export async function sendTestEmail(admin: AdminUser) {
  const smtp = platformSmtp();
  if (!smtp) throw badRequest("No mailbox is connected yet.");
  const result = await sendMail({
    kind: "test",
    to: admin.email,
    subject: "Pratibha test email",
    text: `Hello ${admin.name},\n\nThis is a test from the Pratibha admin panel, sent from ${smtp.user}. If you are reading it, Pratibha's email works.\n\nPratibha`,
  });
  if (!result.sent) throw badRequest(`The test email failed: ${result.error ?? "unknown error"}`);
  return { message: `A test email went to ${admin.email} from ${smtp.user}. Check that inbox (and spam, the first time).` };
}

export async function disconnectMailbox(admin: AdminUser) {
  await saveSettings(admin, { reset: ["integrations.smtp_password", "messages.smtp_user"] });
  return { message: "Disconnected. Pratibha will not send email until a mailbox is connected again." };
}
