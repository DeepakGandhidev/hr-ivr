import { adminPrisma, type Plan, type Tenant, type TrialConfig } from "@pratibha/prisma";
import { wantsNotification } from "@pratibha/shared";
import { settingText } from "@pratibha/shared/settings-runtime";
import { appUrl } from "@/lib/app-url";
import { currentUsagePeriod, interviewMinuteLimit } from "@/lib/billing";
import { copyText } from "@/lib/copy";
import { sendEmail } from "@/lib/email";
import { formatDate, formatDayMonth } from "@/lib/format";
import { currentTrial } from "@/lib/pricing";

/**
 * The Monday digest: what happened in each workspace last week (Monday to
 * Sunday, India time), to its owners and admins.
 *
 * Checked every 15 minutes rather than scheduled for 09:00 exactly, so a
 * restart at nine does not skip a week. The dedupe key (per workspace, person
 * and ISO week) is what stops a second tick, a restart or a second instance
 * from sending it twice; the in-process marker below only saves the queries.
 */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const SEND_FROM_HOUR = 9;

export interface SummaryWeek {
  /** Monday 00:00 India time, as an instant. */
  start: Date;
  /** The following Monday 00:00 India time (exclusive). */
  end: Date;
  /** ISO week of the week reported on, e.g. "2026-W41". */
  isoWeek: string;
}

/**
 * The week a summary sent at `now` reports on, or null when it is not yet
 * time: only on Monday, from 09:00 India time. India has no daylight saving,
 * so a fixed offset is exact.
 */
export function summaryWeekAt(now: Date): SummaryWeek | null {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  if (ist.getUTCDay() !== 1 || ist.getUTCHours() < SEND_FROM_HOUR) return null;

  const end = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
  const start = new Date(end.getTime() - 7 * DAY_MS);
  return { start, end, isoWeek: isoWeekOf(new Date(start.getTime() + IST_OFFSET_MS)) };
}

/** ISO 8601 week of a calendar date (read from its UTC fields). */
export function isoWeekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // The Thursday of this week decides which year the week belongs to.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface WeeklyStats {
  applications: number;
  screened: number;
  shortlisted: number;
  interviews: number;
  openJobs: number;
  minutesUsed: number;
  /** Null on a plan without a cap. */
  minutesAllowance: number | null;
}

/**
 * One workspace's figures for the week. Counts only, each pinned to the
 * tenant explicitly: this runs on the admin connection, outside RLS.
 */
export async function weeklyStats(
  tenant: Tenant & { plan: Plan | null },
  week: SummaryWeek,
  trial: TrialConfig | null
): Promise<WeeklyStats> {
  const tenantId = tenant.id;
  const inWeek = { gte: week.start, lt: week.end };

  const [applications, screened, shortlisted, interviews, openJobs, meter, sub] = await Promise.all([
    adminPrisma.candidate.count({ where: { tenantId, createdAt: inWeek, notApplicationAt: null } }),
    adminPrisma.screening.count({ where: { createdAt: inWeek, failed: false, candidate: { tenantId } } }),
    // Put on a shortlist this week and not taken off it again.
    adminPrisma.shortlistItem.count({
      where: { createdAt: inWeek, candidate: { tenantId }, OR: [{ finalState: null }, { finalState: "approved" }] },
    }),
    adminPrisma.interviewCall.count({ where: { status: "completed", startedAt: inWeek, candidate: { tenantId } } }),
    adminPrisma.job.count({ where: { tenantId, status: "open" } }),
    adminPrisma.usageMeter.findUnique({
      where: { tenantId_period: { tenantId, period: currentUsagePeriod() } },
      select: { interviewMinutesUsed: true },
    }),
    adminPrisma.subscription.findUnique({ where: { tenantId }, select: { topUpMinutes: true } }),
  ]);

  const planMinutes = interviewMinuteLimit({ status: tenant.status, planId: tenant.planId, plan: tenant.plan, trial });
  return {
    applications,
    screened,
    shortlisted,
    interviews,
    openJobs,
    minutesUsed: meter?.interviewMinutesUsed ?? 0,
    minutesAllowance: planMinutes === null ? null : planMinutes + (sub?.topUpMinutes ?? 0),
  };
}

/** Nothing happened and nothing is open: a summary of zeros is noise. */
export function isIdle(stats: WeeklyStats): boolean {
  return (
    stats.openJobs === 0 &&
    stats.applications === 0 &&
    stats.screened === 0 &&
    stats.shortlisted === 0 &&
    stats.interviews === 0
  );
}

/** Subject and body, from the admin panel's wording (Text and emails, Email: weekly summary). */
export function weeklySummaryEmail(args: { company: string; slug: string; week: SummaryWeek; stats: WeeklyStats }) {
  const product = settingText("brand.product_name", "Pratibha");
  const lastDay = new Date(args.week.end.getTime() - DAY_MS);
  const week = `${formatDayMonth(args.week.start, "Asia/Kolkata")} – ${formatDate(lastDay, "Asia/Kolkata")}`;
  const s = args.stats;

  return {
    subject: copyText("copy.email.weekly_summary.subject", { product, week }),
    body: [
      copyText("copy.email.weekly_summary.intro", { company: args.company, week }),
      "",
      copyText("copy.email.weekly_summary.stats", {
        applications: s.applications,
        screened: s.screened,
        shortlisted: s.shortlisted,
        interviews: s.interviews,
        minutes_used: s.minutesUsed,
        minutes_allowance: s.minutesAllowance === null ? "unlimited" : s.minutesAllowance,
        open_jobs: s.openJobs,
      }),
      "",
      copyText("copy.email.weekly_summary.action"),
      `${appUrl()}/${args.slug}`,
      "",
      copyText("copy.email.weekly_summary.signoff", { product, company: args.company }),
    ].join("\n"),
  };
}

/** The week this process has already been through, so later ticks skip the queries. */
let doneWeek: string | null = null;
let running = false;

/**
 * Send the summary to every trial or active workspace, if it is time. Returns
 * how many emails were handed to the mailer. One workspace failing is logged
 * and the rest still go out.
 */
export async function runWeeklySummaries(now: Date = new Date()): Promise<number> {
  const week = summaryWeekAt(now);
  if (!week || doneWeek === week.isoWeek || running) return 0;
  running = true;
  let sent = 0;
  let failures = 0;

  try {
    const tenants = await adminPrisma.tenant.findMany({
      where: { status: { in: ["trial", "active"] } },
      include: { plan: true },
    });
    const trial = tenants.some((t) => t.status === "trial") ? await currentTrial() : null;

    for (const tenant of tenants) {
      try {
        const stats = await weeklyStats(tenant, week, trial);
        if (isIdle(stats)) continue;

        // Owners and admins still in the workspace who have not switched it off.
        const users = await adminPrisma.user.findMany({
          where: { tenantId: tenant.id, role: { in: ["owner", "admin"] }, removedAt: null },
          select: { id: true, email: true, notificationPrefs: true },
        });
        const recipients = users.filter((u) => wantsNotification(u.notificationPrefs, "weekly_summary"));
        if (recipients.length === 0) continue;

        const { subject, body } = weeklySummaryEmail({ company: tenant.name, slug: tenant.slug, week, stats });
        for (const user of recipients) {
          const result = await sendEmail({
            kind: "weekly_summary",
            tenantId: tenant.id,
            to: user.email,
            subject,
            body,
            dedupeKey: `weekly_summary:${tenant.id}:${user.id}:${week.isoWeek}`,
          });
          if (result.ok && !result.skipped) sent++;
        }
      } catch (err) {
        failures++;
        console.error(`[weekly-summary] workspace ${tenant.id} failed`, err);
      }
    }

    // A workspace that failed is tried again on the next tick; the dedupe key
    // keeps everyone already sent from getting it twice.
    if (failures === 0) doneWeek = week.isoWeek;
  } finally {
    running = false;
  }
  return sent;
}

/** For tests: forget which week has been sent. */
export function __resetWeeklySummary() {
  doneWeek = null;
  running = false;
}
