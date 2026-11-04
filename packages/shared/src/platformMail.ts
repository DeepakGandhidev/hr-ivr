import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { setting, settingText } from './settingsRuntime.js';

/**
 * Pratibha's own mailbox (e.g. info@pratibha.tech on Hostinger), over SMTP.
 *
 * Every email Pratibha sends in its own name goes out here once the mailbox is
 * set up in the admin panel (Emails and notifications → Platform mailbox, and
 * its password under API keys). Shared by the portal and the admin panel so
 * both send the same way.
 *
 * Mail always leaves FROM the authenticated mailbox: hosted mail servers refuse
 * (or quietly bin) a From address the login does not own, and a From on the
 * domain's own mailbox is what SPF and DKIM vouch for. A workspace's name goes
 * in the display name instead ("Acme via Pratibha <info@pratibha.tech>").
 */

export interface PlatformSmtp {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** The mailbox, when host, address and password are all set; otherwise null. */
export function platformSmtp(): PlatformSmtp | null {
  const host = (setting<string>('messages.smtp_host') ?? '').trim();
  const user = (setting<string>('messages.smtp_user') ?? '').trim();
  const pass = setting<string | null>('integrations.smtp_password');
  const port = Number(setting<number>('messages.smtp_port')) || 465;
  return host && user && pass ? { host, port, user, pass } : null;
}

/** The display name for system email: the configured sender name, else the product. */
export function platformSenderName(): string {
  return settingText('messages.smtp_from_name', settingText('brand.product_name', 'Pratibha'));
}

/** "Acme via Pratibha <x@y>" → "Acme via Pratibha"; a bare address → null. */
export function displayNameOf(from: string | null | undefined): string | null {
  if (!from) return null;
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return match && match[1]!.trim() ? match[1]!.trim() : null;
}

let cached: { key: string; transport: Transporter } | null = null;

/**
 * One pooled connection per configuration: a handful of reused sessions, not
 * a login per email, which shared mail hosts rate-limit and may block.
 * Rebuilt when the settings change.
 */
function transportFor(smtp: PlatformSmtp): Transporter {
  const key = JSON.stringify(smtp);
  if (cached?.key === key) return cached.transport;
  cached?.transport.close();
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  // An idle pooled socket dropped by the server is an 'error' event; unhandled
  // it would take the whole process down.
  transport.on('error', () => {});
  cached = { key, transport };
  return transport;
}

export interface PlatformMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Display name; the address is always the mailbox's own. */
  fromName?: string | null;
}

export interface PlatformMailResult {
  ok: boolean;
  messageId?: string;
  /** The server's own reply, for the audit trail. */
  response?: string;
  error?: string;
}

export async function sendPlatformMail(mail: PlatformMail): Promise<PlatformMailResult> {
  const smtp = platformSmtp();
  if (!smtp) return { ok: false, error: 'The platform mailbox is not set up' };

  const name = (mail.fromName ?? platformSenderName()).replace(/["<>\r\n]/g, '').trim();
  try {
    const info = await transportFor(smtp).sendMail({
      from: name ? { name, address: smtp.user } : smtp.user,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    });
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMTP send failed' };
  }
}

/**
 * Sign in to a mailbox that is not saved yet, without sending anything, so
 * the admin panel only ever stores a login that works.
 */
export async function checkMailboxLogin(smtp: PlatformSmtp): Promise<PlatformMailResult> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  transport.on('error', () => {});
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMTP sign-in failed' };
  } finally {
    transport.close();
  }
}

/** Sign in to the mailbox without sending anything: for the admin panel's test. */
export async function verifyPlatformMailbox(): Promise<PlatformMailResult> {
  const smtp = platformSmtp();
  if (!smtp) return { ok: false, error: 'The platform mailbox is not set up' };
  try {
    await transportFor(smtp).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMTP sign-in failed' };
  }
}

/** For tests. */
export function __resetPlatformMail() {
  cached?.transport.close();
  cached = null;
}
