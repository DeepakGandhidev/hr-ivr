import { prisma } from '@pratibha/prisma';
import { deliverEmail } from '@pratibha/shared/mailer';
import { deliverWhatsApp } from '@pratibha/shared/whatsapp';
import { teamRecipients, whatsappRecipients } from './recipients.js';
import { copyText, portalUrl, productName } from './text.js';

/** The recommendation as the portal's report page names it. */
const RECOMMENDATION_LABELS = { strong_yes: 'Advance', yes: 'Advance', maybe: 'Maybe', no: 'Do not pursue' };

const oneDecimal = (n) => String(Number(Number(n).toFixed(1)));

export function reportReadyEmail({ candidateName, jobTitle, companyName, score, recommendation }, link) {
  const vars = { candidate: candidateName, job: jobTitle };
  const lines = [copyText('copy.email.report_ready.intro', vars)];
  // The 0-10 verdict on the whole picture, the number the report page leads
  // with. Without one the line goes rather than printing "null out of 10".
  if (typeof score === 'number' && Number.isFinite(score)) {
    lines.push(
      '',
      copyText('copy.email.report_ready.score', {
        score: oneDecimal(score),
        recommendation: RECOMMENDATION_LABELS[recommendation] ?? 'Not recorded',
      })
    );
  }
  lines.push(
    '',
    copyText('copy.email.report_ready.action'),
    link,
    '',
    copyText('copy.email.report_ready.signoff', { product: productName(), company: companyName })
  );
  return { subject: copyText('copy.email.report_ready.subject', vars), text: lines.join('\n') };
}

/**
 * Tell the workspace's owners and admins an interview report is ready.
 *
 * Runs after the report is saved and never throws: the report is the artifact
 * worth keeping, and a mail fault must not touch it or the call. One email per
 * recipient per call, by dedupe key, so re-running the analysis never sends
 * the same news twice.
 */
export async function notifyReportReady(
  interviewCallId,
  { db = prisma, send = deliverEmail, sendWhatsApp = deliverWhatsApp, logger = console } = {}
) {
  try {
    const call = await db.interviewCall.findUnique({
      where: { id: interviewCallId },
      select: {
        id: true,
        assessmentReport: { select: { recommendation: true, recommendationScore: true } },
        candidate: {
          select: {
            id: true,
            name: true,
            job: { select: { title: true } },
            tenant: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    const candidate = call?.candidate;
    if (!call?.assessmentReport || !candidate?.tenant) return { notified: 0 };

    const recipients = await teamRecipients(db, candidate.tenant.id, 'report_ready');
    if (!recipients.length) return { notified: 0 };

    const link = `${portalUrl()}/${candidate.tenant.slug}/candidates/${candidate.id}`;
    const facts = {
      candidateName: candidate.name?.trim() || 'A candidate',
      jobTitle: candidate.job?.title ?? 'the role',
      companyName: candidate.tenant.name,
      score: call.assessmentReport.recommendationScore,
      recommendation: call.assessmentReport.recommendation,
    };
    const { subject, text } = reportReadyEmail(facts, link);

    let notified = 0;
    for (const user of recipients) {
      const result = await send(db, {
        kind: 'report_ready',
        tenantId: candidate.tenant.id,
        to: user.email,
        subject,
        text,
        dedupeKey: `report_ready:${call.id}:${user.id}`,
      });
      if (result.ok && result.status === 'sent') notified += 1;
    }

    // The same news on WhatsApp, for those who asked for it. After the
    // emails, so a slow Meta never holds them up.
    const score = typeof facts.score === 'number' && Number.isFinite(facts.score) ? `${oneDecimal(facts.score)}/10` : 'not recorded';
    let whatsapp = 0;
    for (const user of whatsappRecipients(recipients)) {
      const result = await sendWhatsApp(db, {
        kind: 'report_ready',
        tenantId: candidate.tenant.id,
        to: user.phoneE164,
        params: [facts.candidateName, facts.jobTitle, facts.companyName, score, link],
        dedupeKey: `wa_report_ready:${call.id}:${user.id}`,
      });
      if (result.ok && result.status === 'sent') whatsapp += 1;
    }
    return { notified, ...(whatsapp ? { whatsapp } : {}) };
  } catch (err) {
    logger.error({ err: err.message, interviewCallId }, 'Report ready email failed');
    return { notified: 0, error: err.message };
  }
}
