import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export const runtime = "nodejs";

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
      ] = await Promise.all([
        tx.job.findMany({
          where: { tenantId },
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
      ]);

      return {
        jobs,
        mailboxes,
        recentCandidates,
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
