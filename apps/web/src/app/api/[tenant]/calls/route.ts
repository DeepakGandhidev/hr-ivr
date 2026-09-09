import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export const runtime = "nodejs";

/**
 * Every call Pratibha has taken for this tenant.
 *
 * Deliberately not filtered to successful interviews. A dropped call, a caller
 * who rang outside the window, someone who hung up at the consent question —
 * those are how a broken configuration shows itself, and a list that hides them
 * makes the line look healthier than it is.
 *
 * One category cannot appear here: a caller we do not recognise at all. Pratibha
 * answers on one number shared by every tenant, so an unmatched call cannot be
 * attributed to a tenant without guessing, and guessing would put one client's
 * call in another client's portal. Those are counted on the platform log
 * instead, and the page says so rather than quietly omitting them.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (ctx, tx) => {
      const { searchParams } = new URL(request.url);
      const from = searchParams.get("from");
      const to = searchParams.get("to");
      const jobId = searchParams.get("jobId");
      const status = searchParams.get("status");

      const startedAt: { gte?: Date; lte?: Date } = {};
      if (from) startedAt.gte = new Date(from);
      // An inclusive end: a date-only "to" of 2026-09-09 parses to midnight, so
      // without this the last day of the range returns nothing.
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        startedAt.lte = end;
      }

      const where = {
        candidate: {
          tenantId: ctx.tenant.id,
          ...(jobId ? { jobId } : {}),
        },
        ...(Object.keys(startedAt).length ? { startedAt } : {}),
        ...(status ? { status: status as never } : {}),
      };

      const [calls, jobs] = await Promise.all([
        tx.interviewCall.findMany({
          where,
          orderBy: { startedAt: "desc" },
          take: 500,
          include: {
            candidate: {
              select: { id: true, name: true, email: true, job: { select: { id: true, title: true } } },
            },
            assessmentReport: { select: { overallScore: true, recommendation: true } },
          },
        }),
        tx.job.findMany({
          where: { tenantId: ctx.tenant.id, deletedAt: null },
          select: { id: true, title: true },
          orderBy: { title: "asc" },
        }),
      ]);

      // Summed from endedAt - startedAt rather than from a stored duration,
      // because no duration is stored. A call still in progress contributes
      // nothing rather than counting as zero-length and skewing the average.
      let totalMs = 0;
      let completedCalls = 0;
      for (const c of calls) {
        if (!c.endedAt) continue;
        totalMs += c.endedAt.getTime() - c.startedAt.getTime();
        completedCalls += 1;
      }

      return {
        calls,
        jobs,
        totals: {
          calls: calls.length,
          minutes: Math.round(totalMs / 60000),
          endedCalls: completedCalls,
          truncated: calls.length === 500,
        },
      };
    })
  );
}
