import { sendEmail } from "@/lib/email";
import type { TenantTransactionClient } from "@/lib/authz";

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
  candidateName: string;
  score: number;
  reasonSummary: string;
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
    const recipients = await tx((db) =>
      db.user.findMany({
        where: { tenantId: input.tenantId, role: { in: ["owner", "admin"] as never } },
        select: { email: true, name: true },
      })
    );

    if (recipients.length === 0) return { notified: 0 };

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const link = `${appUrl}/${input.tenantSlug}/jobs/${input.jobId}/shortlist`;

    const subject = `${input.candidateName} cleared screening for ${input.jobTitle}`;
    const body = [
      `${input.candidateName} scored ${input.score} against ${input.jobTitle} and is now on the draft shortlist.`,
      "",
      input.reasonSummary,
      "",
      "They have not been contacted. Approve the shortlist and press Request interview to send them an invite:",
      link,
      "",
      `— Pratibha, for ${input.tenantName}`,
    ].join("\n");

    let notified = 0;
    let firstError: string | undefined;

    for (const recipient of recipients) {
      const result = await sendEmail({ to: recipient.email, subject, body });
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
