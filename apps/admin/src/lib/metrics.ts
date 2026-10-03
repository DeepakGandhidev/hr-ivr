import { db } from "@/lib/db";
import { istDay } from "@/lib/format";
import { LISTED, PAYING, allowanceFor, meterFigures, mrrOf, usagePeriod } from "@/lib/workspaces";
import { currentTrial } from "@/lib/pricing";

/**
 * Platform figures. Each is defined once here and read by the dashboard and by
 * the module page it summarises, so "178" cannot mean one count on the
 * dashboard and another on Workspaces or Payments.
 *
 * Usage comes from usage_daily, the per-workspace per-day rollup that the
 * meter's own triggers maintain; money comes from the payments ledger.
 */

/** Midnight IST at the start of today, and of this IST month, as UTC instants. */
export function istBounds(now = new Date()) {
  const today = istDay(now);
  const [y, m] = today.split("-").map(Number);
  const startOfToday = new Date(`${today}T00:00:00+05:30`);
  const startOfMonth = new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+05:30`);
  const weekAgo = new Date(startOfToday.getTime() - 6 * 86_400_000);
  return { today, startOfToday, startOfMonth, weekAgo, monthKey: `${y}-${String(m).padStart(2, "0")}` };
}

/** A UTC midnight Date for an IST calendar day, matching usage_daily.day. */
export function dayKey(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00Z`);
}

export async function usageThisMonth() {
  const { monthKey } = istBounds();
  const agg = await db.usageDaily.aggregate({
    where: { day: { gte: dayKey(`${monthKey}-01`) } },
    _sum: {
      minutes: true,
      screenings: true,
      interviews: true,
      callsCompleted: true,
      callsNoShow: true,
      callsDropped: true,
      callsOutOfWindow: true,
      callsDeclinedConsent: true,
    },
  });
  const s = agg._sum;
  const outcomes = {
    completed: s.callsCompleted ?? 0,
    noShow: s.callsNoShow ?? 0,
    dropped: s.callsDropped ?? 0,
    outOfWindow: s.callsOutOfWindow ?? 0,
    declinedConsent: s.callsDeclinedConsent ?? 0,
  };
  const calls = Object.values(outcomes).reduce((a, b) => a + b, 0);
  return {
    minutes: s.minutes ?? 0,
    screenings: s.screenings ?? 0,
    interviews: s.interviews ?? 0,
    outcomes,
    calls,
    completion: calls ? Math.round((outcomes.completed / calls) * 100) : null,
  };
}

/** Dropped calls this week against the week before, for "drops rising". */
export async function dropsTrend() {
  const { today } = istBounds();
  const t = dayKey(today).getTime();
  const [thisWeek, lastWeek] = await Promise.all([
    db.usageDaily.aggregate({ where: { day: { gte: new Date(t - 6 * 86_400_000) } }, _sum: { callsDropped: true } }),
    db.usageDaily.aggregate({
      where: { day: { gte: new Date(t - 13 * 86_400_000), lt: new Date(t - 6 * 86_400_000) } },
      _sum: { callsDropped: true },
    }),
  ]);
  return { thisWeek: thisWeek._sum.callsDropped ?? 0, lastWeek: lastWeek._sum.callsDropped ?? 0 };
}

/** Minutes per IST day for the last `days` days, oldest first, today last. */
export async function minutesPerDay(days = 14) {
  const { today } = istBounds();
  const end = dayKey(today).getTime();
  const start = new Date(end - (days - 1) * 86_400_000);
  const rows = await db.usageDaily.groupBy({ by: ["day"], where: { day: { gte: start } }, _sum: { minutes: true } });
  const out: { day: string; minutes: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ day: iso, minutes: rows.find((r) => r.day.toISOString().slice(0, 10) === iso)?._sum.minutes ?? 0 });
  }
  const best = await db.$queryRaw<{ m: bigint | null }[]>`SELECT max(t.m) AS m FROM (SELECT sum(minutes) AS m FROM usage_daily GROUP BY day) t`;
  return { series: out, allTimeBest: Number(best[0]?.m ?? 0) };
}

/**
 * Workspace figures: MRR, paying and trial counts, plan mix, and minutes used
 * against minutes sold. The same row logic as the Workspaces list.
 */
export async function workspaceFigures() {
  const period = usagePeriod();
  const [tenants, trial] = await Promise.all([
    db.tenant.findMany({
      where: { status: { in: LISTED } },
      include: {
        plan: true,
        subscription: { select: { topUpMinutes: true, topUpScreenings: true } },
        usageMeters: { where: { period } },
      },
    }),
    currentTrial(),
  ]);

  let mrr = 0;
  let paying = 0;
  let trials = 0;
  let minutesUsed = 0;
  let minutesSold = 0;
  const planMix = new Map<string, { name: string; count: number }>();
  const outOfMinutes: { id: string; name: string }[] = [];

  for (const t of tenants) {
    const allowance = allowanceFor(t, trial, t.subscription);
    const usage = meterFigures(t.usageMeters[0] ?? null);
    minutesUsed += usage.minutesUsed;
    minutesSold += allowance.minutes;
    mrr += mrrOf(t);
    if (PAYING.includes(t.status)) {
      paying += 1;
      const entry = planMix.get(t.plan.key) ?? { name: t.plan.name, count: 0 };
      entry.count += 1;
      planMix.set(t.plan.key, entry);
    }
    if (t.status === "trial") trials += 1;
    if (t.status !== "suspended" && t.status !== "deleted_pending" && allowance.minutes > 0 && usage.minutesUsed >= allowance.minutes) {
      outOfMinutes.push({ id: t.id, name: t.name });
    }
  }

  return { mrr, paying, trials, minutesUsed, minutesSold, planMix, outOfMinutes, tenants };
}

/**
 * New paying workspaces this month, and the MRR they brought: a workspace
 * counts in the month of its first captured subscription payment.
 */
export async function newPayingThisMonth() {
  const { startOfMonth } = istBounds();
  const firsts = await db.payment.groupBy({
    by: ["tenantId"],
    where: { kind: "subscription", status: { in: ["captured", "refunded"] } },
    _min: { paidAt: true },
  });
  const ids = firsts.filter((f) => f._min.paidAt && f._min.paidAt >= startOfMonth).map((f) => f.tenantId);
  if (!ids.length) return { count: 0, mrr: 0 };
  const tenants = await db.tenant.findMany({ where: { id: { in: ids }, status: { in: PAYING } }, include: { plan: true } });
  return { count: tenants.length, mrr: tenants.reduce((s, t) => s + mrrOf(t), 0) };
}

/**
 * Trial conversion among trials that have finished. Every workspace starts on
 * the trial unless an admin created it straight onto a paid plan.
 */
export async function trialConversion() {
  const [tenants, paidAtCreation] = await Promise.all([
    db.tenant.findMany({ select: { id: true, status: true } }),
    db.activityLog.findMany({
      where: { action: "workspace.created", NOT: { after: { path: ["plan"], equals: "trial" } } },
      select: { targetWorkspaceId: true },
    }),
  ]);
  const skipped = new Set(paidAtCreation.map((r) => r.targetWorkspaceId));
  const everTrial = tenants.filter((t) => !skipped.has(t.id));
  const finished = everTrial.filter((t) => t.status !== "trial");
  const converted = finished.filter((t) => PAYING.includes(t.status) || t.status === "suspended");
  return { finished: finished.length, converted: converted.length, rate: finished.length ? Math.round((converted.length / finished.length) * 100) : null };
}

export async function topUpsThisMonth() {
  const { startOfMonth } = istBounds();
  const agg = await db.payment.aggregate({
    where: { kind: "top_up", status: "captured", paidAt: { gte: startOfMonth } },
    _sum: { amountPaise: true },
    _count: { _all: true },
  });
  return { paise: agg._sum.amountPaise ?? 0, packs: agg._count._all };
}

/** Failed charges not yet followed by a captured one for the same workspace. */
export async function openFailedPayments() {
  const failed = await db.payment.findMany({
    where: { status: { in: ["failed", "scheduled_retry"] } },
    orderBy: { paidAt: "desc" },
    include: { tenant: { select: { id: true, name: true } } },
  });
  const open: typeof failed = [];
  for (const f of failed) {
    const later = await db.payment.count({
      where: { tenantId: f.tenantId, kind: f.kind, status: "captured", paidAt: { gt: f.paidAt } },
    });
    if (!later && !open.some((o) => o.tenantId === f.tenantId)) open.push(f);
  }
  return open;
}

/** Unknown callers this week: distinct numbers, and how many tried three times or more. */
export async function unknownCallersThisWeek() {
  const { weekAgo } = istBounds();
  const rows = await db.unknownCall.groupBy({
    by: ["callerNumber"],
    where: { at: { gte: weekAgo }, tenantId: null },
    _count: { _all: true },
  });
  return { numbers: rows.length, repeated: rows.filter((r) => r._count._all >= 3).length };
}

/** Across every workspace, this month. */
export async function funnelThisMonth(usage: { screenings: number; interviews: number }) {
  const { startOfMonth } = istBounds();
  const [applications, shortlisted, recommended] = await Promise.all([
    db.candidate.count({ where: { createdAt: { gte: startOfMonth }, archivedAt: null, notApplicationAt: null } }),
    db.shortlistItem.count({ where: { createdAt: { gte: startOfMonth }, removedBy: null } }),
    db.assessmentReport.count({ where: { generatedAt: { gte: startOfMonth }, recommendation: { in: ["strong_yes", "yes"] } } }),
  ]);
  return { applications, screened: usage.screenings, shortlisted, interviewed: usage.interviews, recommended };
}

export async function platformHealth() {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [sent, bounced, failedScreenings, reports, dropped] = await Promise.all([
    db.outreachEmail.count({ where: { sentAt: { gte: since } } }),
    db.outreachEmail.count({ where: { createdAt: { gte: since }, status: { in: ["bounced", "failed"] } } }),
    db.screening.count({ where: { createdAt: { gte: since }, failed: true } }),
    db.assessmentReport.count({ where: { generatedAt: { gte: since } } }),
    db.usageDaily.aggregate({ where: { day: { gte: dayKey(istDay(since)) } }, _sum: { callsDropped: true } }),
  ]);
  return { sent, bounced, failedScreenings, reports, dropped: dropped._sum.callsDropped ?? 0 };
}
