import { EMAIL_KINDS_BY_KEY, emailKindSettingKey } from './emailKinds.js';
import { platformSmtp, sendPlatformMail } from './platformMail.js';
import { setting } from './settingsRuntime.js';

/**
 * Send one email from Pratibha's mailbox, the only way Pratibha sends mail.
 *
 * Used by the portal, the worker and the admin panel alike:
 *   1. a kind switched off in the admin panel is not sent (and is logged as such);
 *   2. a `dedupeKey` already in the log means it was sent before: not again;
 *   3. it goes out through the mailbox connected on the admin panel's Email page;
 *   4. every attempt lands in email_log with the mail server's own answer.
 *
 * With no mailbox connected nothing is sent: the attempt is logged as failed
 * with that reason (and printed, so local development can see it).
 */

/** The part of a Prisma client this needs; every app passes its own. */
export interface MailerDb {
  emailLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface OutgoingEmail {
  /** One of EMAIL_KINDS. */
  kind: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Display name; the address is always the mailbox's own. */
  fromName?: string | null;
  tenantId?: string | null;
  /** Send at most once per key (e.g. `quota_warning:<tenant>:<period>:80`). */
  dedupeKey?: string;
}

export type DeliveryStatus = 'sent' | 'failed' | 'skipped' | 'duplicate';

export interface Delivery {
  ok: boolean;
  status: DeliveryStatus;
  error?: string;
  messageId?: string;
  response?: string;
}

/** Whether the admin panel lets this kind go out. Required kinds always do. */
export function emailKindEnabled(kind: string): boolean {
  if (EMAIL_KINDS_BY_KEY[kind]?.required) return true;
  try {
    return setting<boolean>(emailKindSettingKey(kind)) !== false;
  } catch {
    // A kind not in the catalogue has no switch.
    return true;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

export async function deliverEmail(db: MailerDb, mail: OutgoingEmail): Promise<Delivery> {
  const base = {
    kind: mail.kind,
    tenantId: mail.tenantId ?? null,
    to: mail.to,
    subject: mail.subject.slice(0, 500),
  };

  if (!emailKindEnabled(mail.kind)) {
    await db.emailLog.create({ data: { ...base, status: 'skipped', error: 'Switched off in the admin panel' } }).catch(() => {});
    return { ok: false, status: 'skipped', error: 'This email is switched off in the admin panel' };
  }

  // Claim the dedupe key before sending, so two processes racing on the same
  // event cannot both send it.
  let logId: string | null = null;
  try {
    logId = (await db.emailLog.create({ data: { ...base, status: 'sending', ...(mail.dedupeKey ? { dedupeKey: mail.dedupeKey } : {}) } })).id;
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: true, status: 'duplicate' };
    // The log is a record, not a gate: a logging fault must not stop an email.
    console.error('[mail] could not write the email log', (err as Error).message);
  }

  const finish = async (data: Record<string, unknown>) => {
    if (logId) await db.emailLog.update({ where: { id: logId }, data }).catch(() => {});
  };

  if (!platformSmtp()) {
    console.log(`[mail not sent: no mailbox connected] ${mail.kind} → ${mail.to}: ${mail.subject}`);
    await finish({ status: 'failed', error: 'No mailbox connected (admin panel → Email)' });
    return { ok: false, status: 'failed', error: 'No mailbox is connected yet. Connect one on the admin panel’s Email page.' };
  }

  const result = await sendPlatformMail({
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    fromName: mail.fromName,
  });

  if (result.ok) {
    await finish({ status: 'sent', sentAt: new Date(), response: result.response?.slice(0, 500) ?? null });
    return { ok: true, status: 'sent', messageId: result.messageId, response: result.response };
  }
  console.error(`[mail] ${mail.kind} to ${mail.to} failed:`, result.error);
  await finish({ status: 'failed', error: result.error?.slice(0, 500) ?? 'Send failed' });
  return { ok: false, status: 'failed', error: result.error };
}

/** Log a send that went another way (a workspace's own mailbox), so the log is complete. */
export async function logEmail(
  db: MailerDb,
  entry: { kind: string; to: string; subject: string; tenantId?: string | null; ok: boolean; error?: string; response?: string }
): Promise<void> {
  await db.emailLog
    .create({
      data: {
        kind: entry.kind,
        tenantId: entry.tenantId ?? null,
        to: entry.to,
        subject: entry.subject.slice(0, 500),
        status: entry.ok ? 'sent' : 'failed',
        error: entry.error?.slice(0, 500) ?? null,
        response: entry.response?.slice(0, 500) ?? 'Sent from the workspace’s own mailbox',
        sentAt: entry.ok ? new Date() : null,
      },
    })
    .catch(() => {});
}
