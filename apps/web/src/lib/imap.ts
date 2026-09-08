import { ImapFlow } from "imapflow";

/**
 * Shared IMAP helpers for the settings panel.
 *
 * Credentials are proved before they are stored, and proved again whenever the
 * password changes. Shared cPanel hosts run brute-force protection (cPHulk on
 * HostGator) that locks a mailbox after a handful of failed logins, so a typo
 * saved into the database would be replayed by the poller and its IDLE watcher
 * on a schedule until the real mailbox is locked out. One failed attempt at the
 * moment of saving is far cheaper than that.
 */

export interface ImapTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  folder: string;
}

export type ImapCheck =
  | { ok: true; messages: number; folders: string[] }
  | { ok: false; error: string; hint: string | null };

/**
 * Turn an IMAP error into something an HR user can act on. ImapFlow surfaces
 * authentication failures as a terse "Command failed", which tells a
 * non-technical user nothing about which of the four things they typed is wrong.
 */
function hintFor(message: string): string | null {
  const text = message.toLowerCase();

  if (text.includes("auth") || text.includes("credentials") || text.includes("login") || text === "command failed") {
    return "Check the password, and make sure the username is the full email address.";
  }
  if (text.includes("enotfound") || text.includes("getaddrinfo")) {
    return "That mail server name does not resolve. For cPanel hosting it is usually mail.yourdomain.com.";
  }
  if (text.includes("timeout") || text.includes("etimedout")) {
    return "The server did not answer. Port 993 may be blocked by a firewall on this machine.";
  }
  if (text.includes("econnrefused")) {
    return "The server refused the connection on that port. Try 993 for SSL/TLS or 143 for STARTTLS.";
  }
  if (text.includes("certificate") || text.includes("self signed")) {
    return "The server's TLS certificate could not be verified.";
  }
  return null;
}

/** Sensible defaults so the panel can ask for as little as possible. */
export function deriveImapDefaults(address: string) {
  const domain = address.includes("@") ? address.split("@")[1] : "";
  return {
    // Near-universal convention for cPanel, Plesk and most hosting providers.
    host: domain ? `mail.${domain}` : "",
    port: 993,
    secure: true,
    user: address,
    folder: "INBOX",
  };
}

/**
 * Connect, authenticate, and open the folder. Returns the mailbox list too, so
 * the panel can tell the user their folder name is wrong instead of just
 * failing.
 */
export async function checkImap(target: ImapTarget): Promise<ImapCheck> {
  const client = new ImapFlow({
    host: target.host,
    port: target.port,
    secure: target.secure,
    auth: { user: target.user, pass: target.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    logger: false,
  });

  try {
    await client.connect();

    const folders: string[] = [];
    for (const box of await client.list()) folders.push(box.path);

    const lock = await client.getMailboxLock(target.folder);
    try {
      const mailbox = client.mailbox;
      const messages = mailbox && typeof mailbox !== "boolean" ? mailbox.exists : 0;
      return { ok: true, messages, folders };
    } finally {
      lock.release();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : "IMAP connection failed";
    return { ok: false, error, hint: hintFor(error) };
  } finally {
    await client.logout().catch(() => {});
  }
}
