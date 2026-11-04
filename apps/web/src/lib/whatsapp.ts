import { adminPrisma } from "@pratibha/prisma";
import { wantsNotification, type NotificationKey } from "@pratibha/shared";
import { setting } from "@pratibha/shared/settings-runtime";
import { deliverWhatsApp, type OutgoingWhatsApp, type WhatsAppDb, type WhatsAppDelivery } from "@pratibha/shared/whatsapp";

/**
 * WhatsApp from the portal: the candidate's interview invite and the team's
 * shortlist alert. Sent through Meta's Cloud API (connected on the admin
 * panel's WhatsApp page) by the shared `deliverWhatsApp`, which switches,
 * dedupes and logs exactly as the mailer does.
 *
 * Always called after the action it reports on has committed, and never
 * awaited by it: a slow or failing Meta must not fail an invite or a
 * screening.
 */

// whatsapp_log and whatsapp_optouts carry no RLS; the unscoped client is the
// one the mailer already writes email_log with.
const whatsappDb = adminPrisma as unknown as WhatsAppDb;

export function sendWhatsApp(message: OutgoingWhatsApp): Promise<WhatsAppDelivery> {
  return deliverWhatsApp(whatsappDb, message);
}

/**
 * Whether a candidate may be sent WhatsApp at all: a number, and their own
 * opt-in unless the admin panel has turned the opt-in rule off. A number that
 * replied STOP is refused later, by deliverWhatsApp, whatever this says.
 */
export function candidateMayGetWhatsApp(candidate: { phoneE164?: string | null; whatsappOptIn?: boolean | null }): boolean {
  if (!candidate.phoneE164) return false;
  if (candidate.whatsappOptIn) return true;
  return setting<boolean>("whatsapp.candidates_need_opt_in") === false;
}

export interface TeamMemberPhone {
  id: string;
  phoneE164: string | null;
  whatsappOptIn: boolean;
  notificationPrefs: unknown;
}

/**
 * Team members who get this alert on WhatsApp: a number, the WhatsApp opt-in
 * in My profile, and the alert itself left on there (the same preference the
 * email follows). The query decides role and removal.
 */
export function wantsWhatsApp<T extends TeamMemberPhone>(users: T[], kind: NotificationKey): (T & { phoneE164: string })[] {
  return users.filter(
    (u): u is T & { phoneE164: string } => Boolean(u.phoneE164 && u.whatsappOptIn && wantsNotification(u.notificationPrefs, kind))
  );
}

/** Send several in the background, logging anything that escapes. */
export function sendWhatsAppInBackground(messages: OutgoingWhatsApp[]): void {
  if (!messages.length) return;
  void Promise.allSettled(messages.map((m) => sendWhatsApp(m))).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") console.error("[whatsapp] background send failed:", r.reason);
    }
  });
}
