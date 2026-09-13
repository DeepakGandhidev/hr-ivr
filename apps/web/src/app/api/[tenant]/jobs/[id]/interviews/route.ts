import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

/**
 * Every interview report for one job.
 *
 * Named for what a recruiter comes here to read — the interviews — rather than
 * for the row type that stores them.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const reports = await tx.assessmentReport.findMany({
        where: {
          interviewCall: {
            candidate: { jobId: id },
          },
        },
        orderBy: { generatedAt: "desc" },
        // Explicit throughout. `include` on the call would pull each stored
        // transcript into this list, and the report carries its own
        // question-and-answer pairs — the whole conversation is a separate
        // request, made only when somebody opens it.
        select: {
          id: true,
          overallScore: true,
          recommendation: true,
          dimensions: true,
          strengths: true,
          concerns: true,
          generatedAt: true,
          interviewScore: true,
          interviewScoreReasoning: true,
          questionAnswers: true,
          jdFitSummary: true,
          recommendationScore: true,
          recommendationVerdict: true,
          interviewCall: {
            select: {
              id: true,
              language: true,
              status: true,
              startedAt: true,
              endedAt: true,
              candidate: {
                select: { id: true, name: true, email: true, phoneE164: true, status: true },
              },
            },
          },
        },
      });

      return { reports };
    })
  );
}
