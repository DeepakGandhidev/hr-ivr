import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import {
  currentUsagePeriod,
  interviewLimit,
  interviewMinuteLimit,
  screeningLimit,
} from "@/lib/billing";

export const runtime = "nodejs";

/** Midnight local time — the boundary the "today" panel is measured from. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

type ActivityEvent = { at: string; kind: string; title: string; detail: string; href?: string };

/**
 * The three "what Pratibha did today" streams, merged and sorted.
 *
 * Screenings are grouped by role rather than listed one per CV: nine separate
 * "screened a CV" lines push everything else off the panel and say less than
 * one line saying nine.
 */
function buildActivity(
  screenings: Array<{ createdAt: Date; verdict: string; candidate: { name: string | null; job: { title: string } } }>,
  calls: Array<{
    startedAt: Date; endedAt: Date | null; status: string | null;
    candidate: { id: string; name: string | null; job: { title: string } };
    assessmentReport: { overallScore: number; recommendation: string } | null;
  }>,
  invites: Array<{ createdAt: Date; status: string | null; candidate: { name: string | null; job: { title: string } } }>
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const byRole = new Map<string, { at: Date; total: number; shortlisted: number }>();
  for (const s of screenings) {
    const role = s.candidate.job.title;
    const seen = byRole.get(role) ?? { at: s.createdAt, total: 0, shortlisted: 0 };
    seen.total += 1;
    if (s.verdict === "shortlist") seen.shortlisted += 1;
    if (s.createdAt > seen.at) seen.at = s.createdAt;
    byRole.set(role, seen);
  }
  for (const [role, g] of Array.from(byRole.entries())) {
    events.push({
      at: g.at.toISOString(),
      kind: "screened",
      title: `Screened ${g.total} ${g.total === 1 ? "CV" : "CVs"}`,
      detail: `${role} · ${g.shortlisted} added to shortlist`,
    });
  }

  for (const c of calls) {
    if (!c.endedAt) {
      events.push({
        at: c.startedAt.toISOString(),
        kind: "calling",
        title: `Interviewing ${c.candidate.name ?? "a candidate"}`,
        detail: `${c.candidate.job.title} · in progress`,
      });
    } else if (c.assessmentReport) {
      events.push({
        at: c.endedAt.toISOString(),
        kind: "report",
        title: `Report ready: ${c.candidate.name ?? "candidate"}`,
        detail: `${c.assessmentReport.overallScore} · ${c.assessmentReport.recommendation.replace(/_/g, " ")}`,
      });
    } else {
      events.push({
        at: c.endedAt.toISOString(),
        kind: "call",
        title: `Call ended: ${c.candidate.name ?? "candidate"}`,
        detail: `${c.candidate.job.title} · ${c.status ?? "no outcome recorded"}`,
      });
    }
  }

  const invitesByRole = new Map<string, { at: Date; n: number }>();
  for (const i of invites) {
    if (i.status !== "sent") continue;
    const role = i.candidate.job.title;
    const seen = invitesByRole.get(role) ?? { at: i.createdAt, n: 0 };
    seen.n += 1;
    if (i.createdAt > seen.at) seen.at = i.createdAt;
    invitesByRole.set(role, seen);
  }
  for (const [role, g] of Array.from(invitesByRole.entries())) {
    events.push({
      at: g.at.toISOString(),
      kind: "invited",
      title: `Invited ${g.n} ${g.n === 1 ? "candidate" : "candidates"}`,
      detail: `${role} · after your approval`,
    });
  }

  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}

/**
 * Everything the dashboard and pipeline need, in one request.
 *
 * These views are the first thing a recruiter opens, so they are built from a
 * single round trip rather than the six the individual resources would take —
 * a dashboard that loads in pieces reads as a broken dashboard.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (ctx, tx) => {
      const tenantId = ctx.tenant.id;

      const [
        jobs,
        candidateCount,
        unscreenedCount,
        shortlistedCount,
        shortlists,
        interviewsCompleted,
        mailboxes,
        recentCandidates,
        liveCall,
        recentReports,
        blockedCandidates,
        approvedCount,
        recommendedCount,
        meter,
        todayScreenings,
        todayCalls,
        todayInvites,
      ] = await Promise.all([
        tx.job.findMany({
          where: { tenantId, deletedAt: null },
          select: {
            id: true,
            title: true,
            slug: true,
            status: true,
            createdAt: true,
            _count: { select: { candidates: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        tx.candidate.count({ where: { tenantId } }),
        // A candidate nobody has screened is the actionable number: it is work
        // waiting, not work done.
        tx.candidate.count({ where: { tenantId, screenings: { none: {} } } }),
        // Screenings, shortlists and interview calls carry no tenant column of
        // their own; they inherit it through the candidate or job they belong
        // to, so the filter goes through the relation.
        tx.screening.count({ where: { candidate: { tenantId }, verdict: "shortlist" } }),
        tx.shortlist.findMany({
          where: { job: { tenantId } },
          select: {
            id: true,
            jobId: true,
            createdAt: true,
            _count: { select: { items: true, approvals: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        tx.interviewCall.count({ where: { candidate: { tenantId }, status: "completed" } }),
        tx.emailConnection.findMany({
          where: { tenantId },
          select: {
            id: true,
            address: true,
            status: true,
            autoRoute: true,
            lastPollAt: true,
            errorDetail: true,
          },
        }),
        tx.candidate.findMany({
          where: { tenantId },
          select: {
            id: true,
            name: true,
            email: true,
            phoneE164: true,
            jobId: true,
            routedBy: true,
            routingConfidence: true,
            parseFailed: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 25,
        }),

        // A call with no endedAt is one still on the line. Ordered newest-first
        // and taken singly: the number is shared, so only one call is ever live.
        tx.interviewCall.findFirst({
          where: { candidate: { tenantId }, endedAt: null },
          orderBy: { startedAt: "desc" },
          include: {
            candidate: { select: { id: true, name: true, job: { select: { title: true } } } },
          },
        }),

        // "Reports to read" has no read flag to filter on, so this is the
        // recent ones. Labelled as recent in the UI rather than as unread —
        // claiming to know what someone has read when we do not is worse than
        // not offering the count.
        tx.assessmentReport.findMany({
          where: { interviewCall: { candidate: { tenantId } } },
          orderBy: { generatedAt: "desc" },
          take: 5,
          include: {
            interviewCall: {
              select: { candidate: { select: { id: true, name: true, job: { select: { title: true } } } } },
            },
          },
        }),

        // Pratibha cannot invite someone she has no number for, so these are
        // stuck until a human adds one.
        tx.candidate.findMany({
          where: { tenantId, OR: [{ noPhone: true }, { phoneE164: null }] },
          select: { id: true, name: true, jobId: true, job: { select: { title: true } } },
          take: 10,
        }),

        tx.shortlistItem.count({
          where: { shortlist: { job: { tenantId }, status: "approved" } },
        }),
        tx.assessmentReport.count({
          where: {
            interviewCall: { candidate: { tenantId } },
            recommendation: { in: ["strong_yes", "yes"] },
          },
        }),

        tx.usageMeter.findUnique({
          where: { tenantId_period: { tenantId, period: currentUsagePeriod() } },
        }),

        // The activity feed. Three separate reads rather than an audit-log
        // scan, because the audit log records what a *user* did and this panel
        // is about what Pratibha did while nobody was watching.
        tx.screening.findMany({
          where: { candidate: { tenantId }, createdAt: { gte: startOfToday() } },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true, createdAt: true, verdict: true, score: true,
            candidate: { select: { name: true, job: { select: { title: true } } } },
          },
        }),
        tx.interviewCall.findMany({
          where: { candidate: { tenantId }, startedAt: { gte: startOfToday() } },
          orderBy: { startedAt: "desc" },
          take: 20,
          select: {
            id: true, startedAt: true, endedAt: true, status: true, language: true,
            candidate: { select: { id: true, name: true, job: { select: { title: true } } } },
            assessmentReport: { select: { overallScore: true, recommendation: true } },
          },
        }),
        tx.outreachEmail.findMany({
          where: { candidate: { tenantId }, createdAt: { gte: startOfToday() } },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true, createdAt: true, status: true,
            candidate: { select: { name: true, job: { select: { title: true } } } },
          },
        }),
      ]);

      return {
        jobs,
        mailboxes,
        recentCandidates,
        liveCall,
        recentReports,
        blockedCandidates,
        // Six stages, applications through to recommended. Each is a real
        // count; none is derived from another, so a stage cannot silently
        // inherit a wrong number from the one before it.
        funnel: {
          applications: candidateCount,
          screened: candidateCount - unscreenedCount,
          shortlisted: shortlistedCount,
          approved: approvedCount,
          interviewed: interviewsCompleted,
          recommended: recommendedCount,
        },
        usage: {
          period: currentUsagePeriod(),
          // Minutes are the billed unit; the interview figures are descriptive.
          interviewMinutesUsed: meter?.interviewMinutesUsed ?? 0,
          interviewMinuteLimit: interviewMinuteLimit(ctx.tenant),
          interviewsUsed: meter?.interviewsUsed ?? 0,
          interviewLimit: interviewLimit(ctx.tenant),
          screeningsUsed: meter?.screeningsUsed ?? 0,
          screeningLimit: screeningLimit(ctx.tenant),
        },
        activity: buildActivity(todayScreenings, todayCalls, todayInvites),
        stats: {
          openJobs: jobs.filter((j) => j.status === "open").length,
          totalJobs: jobs.length,
          candidates: candidateCount,
          unscreened: unscreenedCount,
          shortlisted: shortlistedCount,
          // A shortlist with no approval row is a recruiter's to-do: nobody can
          // be interviewed until someone approves it.
          awaitingApproval: shortlists.filter((s) => s._count.approvals === 0 && s._count.items > 0).length,
          interviewsCompleted,
        },
      };
    })
  );
}
