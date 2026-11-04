import { wantsNotification } from '@pratibha/shared';

/**
 * Who on a workspace gets a team notification.
 *
 * Owners and admins only, as with the portal's shortlist email: a reviewer or
 * viewer can do nothing about a report waiting or minutes running out. Removed
 * members keep their row (for what they authored) but not their mail, and
 * anyone who switched this email off in My profile is left out. Absent
 * preferences mean on.
 */
export async function teamRecipients(db, tenantId, kind) {
  const users = await db.user.findMany({
    where: { tenantId, role: { in: ['owner', 'admin'] }, removedAt: null },
    select: { id: true, email: true, name: true, notificationPrefs: true, phoneE164: true, whatsappOptIn: true },
    orderBy: { createdAt: 'asc' },
  });
  return users.filter((u) => u.email && wantsNotification(u.notificationPrefs, kind));
}

/**
 * Of those, who also gets it on WhatsApp: a number and the WhatsApp opt-in,
 * both set in My profile. The email preference above still decides the alert.
 */
export function whatsappRecipients(recipients) {
  return recipients.filter((u) => u.phoneE164 && u.whatsappOptIn === true);
}
