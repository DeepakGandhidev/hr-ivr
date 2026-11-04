import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { currentScreening } from "@/lib/candidates";
import { platformSettings } from "@/lib/platform-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the screening analysis popup shows: the current screening, in its parts. */
export async function GET(request: NextRequest, { params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (_ctx, tx) => {
      const candidate = await tx.candidate.findUnique({
        where: { id },
        include: {
          job: { select: { id: true, title: true, screeningThreshold: true } },
          screenings: { orderBy: { createdAt: "desc" } },
          shortlistItems: { include: { shortlist: { select: { jobId: true, status: true } } } },
        },
      });
      if (!candidate) throw new NotFoundError("Candidate not found");
      const screening = currentScreening(candidate.screenings, candidate.jobId);
      const threshold = candidate.job.screeningThreshold ?? (await platformSettings()).suggestThreshold;
      const onShortlist = candidate.shortlistItems.some(
        (i) => i.shortlist.jobId === candidate.jobId && i.finalState !== "removed" && !i.removedBy
      );
      return {
        candidate: { id: candidate.id, name: candidate.name, nameSource: candidate.nameSource, hasCvFile: Boolean(candidate.cvFileRef) },
        job: { id: candidate.job.id, title: candidate.job.title },
        threshold,
        onShortlist,
        screening: screening && {
          id: screening.id,
          score: screening.score,
          // Structured since the start (Q1): separate lists and the written reason.
          matches: Array.isArray(screening.matchedMustHaves) ? (screening.matchedMustHaves as string[]) : [],
          gaps: Array.isArray(screening.gaps) ? (screening.gaps as string[]) : [],
          reason: screening.reasonSummary,
          createdAt: screening.createdAt,
        },
      };
    })
  );
}
