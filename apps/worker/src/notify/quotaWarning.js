import { prisma } from '@pratibha/prisma';
import { deliverEmail } from '@pratibha/shared/mailer';
import { deliverWhatsApp } from '@pratibha/shared/whatsapp';
import { PLANS, TRIAL_LIMITS, quotaState, quotaWarningThresholds } from '@pratibha/shared';
import { teamRecipients, whatsappRecipients } from './recipients.js';
import { copyText, portalUrl, productName } from './text.js';

/**
 * The workspace's interview minutes for the month: its plan's (or, on trial,
 * the live trial's) plus anything bought or granted on top. Null when the plan
 * is unmetered.
 *
 * The same rule as the portal's lib/billing.ts and lib/pricing.ts, which the
 * worker cannot import: the plan row the workspace points at (a published
 * price change grandfathers it), the shared constant of the same key for a row
 * that predates the minutes column, and the newest published trial with the
 * shipped trial figure behind it.
 */
export async function minuteAllowance(db, tenant) {
  let base;
  if (tenant.status === 'trial') {
    const trial = await db.trialConfig.findFirst({
      where: { status: 'published' },
      orderBy: { publishedAt: 'desc' },
      select: { minutes: true },
    });
    base = trial?.minutes ?? TRIAL_LIMITS.interviewMinutes;
  } else if (typeof tenant.plan?.minutes === 'number') {
    base = tenant.plan.minutes;
  } else {
    base = PLANS[tenant.plan?.key ?? tenant.planId]?.limits.interviewMinutes ?? null;
  }
  return base === null ? null : base + (tenant.subscription?.topUpMinutes ?? 0);
}

export function quotaEmail(level, { companyName, used, limit, remaining, percent }, link) {
  const exhausted = level === 'exhausted';
  const vars = { company: companyName, used, limit, remaining, percent };
  return {
    subject: copyText(exhausted ? 'copy.email.quota.exhausted_subject' : 'copy.email.quota.warning_subject', vars),
    text: [
      copyText(exhausted ? 'copy.email.quota.exhausted_intro' : 'copy.email.quota.warning_intro', vars),
      '',
      copyText('copy.email.quota.action'),
      link,
      '',
      copyText('copy.email.quota.signoff', { product: productName() }),
    ].join('\n'),
  };
}

/**
 * After a billed call moves the month's meter: tell the owners and admins when
 * minutes pass the warning level (billing.quota_warning_percent) and again
 * when they run out.
 *
 * `meter` is the usage_meters row as it stands after the increment. Each level
 * goes once per month per person, by dedupe key, so every later call in the
 * month finds it already sent. Never throws: the call is over and billed, and
 * a mail fault must not reach it.
 */
export async function notifyQuotaIfLow(
  meter,
  { db = prisma, send = deliverEmail, sendWhatsApp = deliverWhatsApp, logger = console } = {}
) {
  try {
    if (!meter?.tenantId || !meter.period) return { notified: 0 };

    const tenant = await db.tenant.findUnique({
      where: { id: meter.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        planId: true,
        plan: { select: { key: true, minutes: true } },
        subscription: { select: { topUpMinutes: true } },
      },
    });
    if (!tenant) return { notified: 0 };

    const state = quotaState(meter.interviewMinutesUsed ?? 0, await minuteAllowance(db, tenant));
    if (!state.level) return { notified: 0 };

    const percent = state.level === 'exhausted' ? 100 : Math.round(quotaWarningThresholds()[0] * 100);
    const recipients = await teamRecipients(db, tenant.id, 'quota_warning');
    if (!recipients.length) return { notified: 0 };

    // The meter's period is the calendar month (YYYY-MM).
    const periodStart = `${meter.period}-01`;
    const link = `${portalUrl()}/${tenant.slug}/settings/subscription`;
    const { subject, text } = quotaEmail(
      state.level,
      { companyName: tenant.name, used: state.used, limit: state.limit, remaining: state.remaining, percent },
      link
    );

    let notified = 0;
    for (const user of recipients) {
      const result = await send(db, {
        kind: 'quota_warning',
        tenantId: tenant.id,
        to: user.email,
        subject,
        text,
        // Per person as well: email_log's key is unique, so a key per
        // workspace would let only the first owner or admin hear of it.
        dedupeKey: `quota_warning:${tenant.id}:${periodStart}:${percent}:${user.id}`,
      });
      if (result.ok && result.status === 'sent') notified += 1;
    }

    // On WhatsApp too, for those who asked; keyed like the email, per person.
    let whatsapp = 0;
    for (const user of whatsappRecipients(recipients)) {
      const result = await sendWhatsApp(db, {
        kind: 'quota_warning',
        tenantId: tenant.id,
        to: user.phoneE164,
        params: [tenant.name, String(Math.round(state.used * 10) / 10), String(state.limit), link],
        dedupeKey: `wa_quota_warning:${tenant.id}:${meter.period}:${state.level}:${user.id}`,
      });
      if (result.ok && result.status === 'sent') whatsapp += 1;
    }
    return { notified, level: state.level, ...(whatsapp ? { whatsapp } : {}) };
  } catch (err) {
    logger.error({ err: err.message, tenantId: meter?.tenantId }, 'Quota warning email failed');
    return { notified: 0, error: err.message };
  }
}
