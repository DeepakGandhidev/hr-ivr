import { wantsNotification } from "@pratibha/shared";
import { appUrl as publicAppUrlFor } from "@/lib/app-url";
import { settingText } from "@pratibha/shared/settings-runtime";
import { sendAsTenant } from "@/lib/email";
import { copyText } from "@/lib/copy";
import type { TenantTransactionClient } from "@/lib/authz";
import { sendWhatsAppInBackground, wantsWhatsApp } from "@/lib/whatsapp";

/**
 * Internal notifications to the hiring team.
 *
 * Deliberately not candidate-facing. §6 puts a human approval gate in front of
 * every candidate contact, and shortlisting is a decision the model makes on
 * its own — mailing the candidate at that moment would be exactly the contact
 * the gate exists to prevent. So the shortlist email tells the recruiters that
 * someone is waiting on their approval, and the candidate hears nothing until a
 * human presses Request interview.
 *
 * These are not recorded in outreach_emails: that table is the audit trail of
 * candidate contact, every row tied to an approval, and filing internal mail in
 * it would corrupt the record the gate is checked against.
 */

export interface ShortlistNotificationInput {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  jobId: string;
  jobTitle: string;
  /** For the WhatsApp alert's profile link and its once-per-person key. */
  candidateId: string;
  candidateName: string;
  score: number;
  reasonSummary: string;
}

/**
 * The subject line: the admin panel's wording when set (Messages, Team
 * notifications), else the built-in one. This mail is sent per candidate, so
 * {count} is always 1; {candidate} is filled in too, since a subject without
 * the name hides the one thing the reader needs.
 */
export function shortlistSubject(input: Pick<ShortlistNotificationInput, "candidateName" | "jobTitle">): string {
  const custom = settingText("messages.shortlist_subject", "");
  if (!custom) return `${input.candidateName} cleared screening for ${input.jobTitle}`;
  return custom
    .replaceAll("{job}", input.jobTitle)
    .replaceAll("{count}", "1")
    .replaceAll("{candidate}", input.candidateName);
}

/**
 * The body, from the admin panel's wording (Text and emails, Email: shortlist
 * ready) with the built-in lines as defaults.
 */
export function shortlistBody(
  input: Pick<ShortlistNotificationInput, "candidateName" | "jobTitle" | "score" | "reasonSummary" | "tenantName">,
  link: string
): string {
  const product = settingText("brand.product_name", "Pratibha");
  return [
    copyText("copy.email.shortlist.intro", { candidate: input.candidateName, score: input.score, job: input.jobTitle }),
    "",
    input.reasonSummary,
    "",
    copyText("copy.email.shortlist.action"),
    link,
    "",
    copyText("copy.email.shortlist.signoff", { product, company: input.tenantName }),
  ].join("\n");
}

/**
 * Tell the team a candidate cleared screening and needs their approval.
 *
 * Never throws: a notification that fails must not roll back or fail the
 * screening that triggered it — the score is the valuable artifact and it is
 * already committed by the time this runs.
 */
export async function notifyCandidateShortlisted(
  input: ShortlistNotificationInput,
  tx: <T>(cb: (db: TenantTransactionClient) => Promise<T>) => Promise<T>
): Promise<{ notified: number; error?: string }> {
  try {
    // Owners and admins only. A viewer cannot approve a shortlist, so telling
    // them one is waiting is noise they can do nothing about.
    const { recipients, phones, connection } = await tx(async (db) => ({
      // Still members, and not switched off in My profile — the same rule
      // every other team email follows.
      recipients: (
        await db.user.findMany({
          where: { tenantId: input.tenantId, role: { in: ["owner", "admin"] as never }, removedAt: null },
          select: { email: true, name: true, notificationPrefs: true },
        })
      ).filter((u) => wantsNotification(u.notificationPrefs, "shortlist_ready")),
      // WhatsApp only to people who asked for it in My profile, are still
      // members, and left this alert on.
      phones: await db.user.findMany({
        where: { tenantId: input.tenantId, role: { in: ["owner", "admin"] as never }, removedAt: null, whatsappOptIn: true, phoneE164: { not: null } },
        select: { id: true, phoneE164: true, whatsappOptIn: true, notificationPrefs: true },
      }),
      // Internal mail goes out the same way candidate mail does, so a tenant
      // whose sending domain is unverified still receives these.
      connection: await db.emailConnection.findFirst({
        where: { tenantId: input.tenantId, status: "connected" },
        orderBy: { createdAt: "asc" },
      }),
    }));

    const appUrl = publicAppUrlFor("http://localhost:3000");

    // In the background: the email below is what this function reports on.
    sendWhatsAppInBackground(
      wantsWhatsApp(phones, "shortlist_ready").map((user) => ({
        kind: "shortlist_ready",
        tenantId: input.tenantId,
        to: user.phoneE164,
        params: [
          input.jobTitle,
          input.tenantName,
          input.candidateName,
          `${input.score}/100`,
          `${appUrl}/${input.tenantSlug}/candidates/${input.candidateId}`,
        ],
        dedupeKey: `wa_shortlist_ready:${input.candidateId}:${user.id}`,
      }))
    );

    if (recipients.length === 0) return { notified: 0 };

    const link = `${appUrl}/${input.tenantSlug}/jobs/${input.jobId}/shortlist`;

    const subject = shortlistSubject(input);
    const body = shortlistBody(input, link);

    let notified = 0;
    let firstError: string | undefined;

    for (const recipient of recipients) {
      const result = await sendAsTenant(
        connection,
        { slug: input.tenantSlug, name: input.tenantName },
        { kind: "shortlist_ready", tenantId: input.tenantId, to: recipient.email, subject, body }
      );
      if (result.ok) notified += 1;
      else firstError ??= result.error;
    }

    return { notified, ...(firstError ? { error: firstError } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification failed";
    console.error("[notify] Shortlist notification failed:", message);
    return { notified: 0, error: message };
  }
}
