import { NextRequest } from "next/server";
import { Action, NotFoundError, advanceCandidateStatus } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { assertScreeningQuota, currentUsagePeriod } from "@/lib/billing";
import { runCvScreening } from "@/lib/screening";
import { notifyCandidateShortlisted } from "@/lib/notifications";

/**
 * §5 Stage 5 — score one candidate against the job and place them on the draft
 * shortlist or in the archive.
 *
 * The model call sits deliberately between two short transactions rather than
 * inside one: an interactive transaction times out at 5s, which a screening
 * call regularly exceeds, and holding a connection open across a provider round
 * trip would exhaust the pool under load.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateScreen);

    // 1. Read inputs and check quota.
    const { candidate, promptBody, threshold } = await tx(async (db) => {
      await assertScreeningQuota(ctx.tenant, db);

      const candidate = await db.candidate.findUnique({
        where: { id },
        include: { job: true },
      });
      if (!candidate) {
        throw new NotFoundError("Candidate not found");
      }

      const promptTemplate = await db.promptTemplate.findFirst({
        where: { key: "cv_screening" as any, active: true },
        orderBy: { version: "desc" },
      });
      if (!promptTemplate) {
        throw new Error("cv_screening prompt template not found");
      }

      return {
        candidate,
        promptBody: promptTemplate.body,
        threshold: candidate.job.screeningThreshold ?? undefined,
      };
    });

    // 2. Call the model outside any transaction.
    const result = await runCvScreening({
      promptBody,
      jobTitle: candidate.job.title,
      mustHaves: (candidate.job.mustHaves as string[]) ?? [],
      goodToHaves: (candidate.job.goodToHaves as string[]) ?? [],
      cvParsed: candidate.cvParsed as Record<string, unknown> | null,
      threshold,
    });

    // 3. Persist the verdict, shortlist placement and meter in one transaction.
    const { screening, newlyShortlisted } = await tx(async (db) => {
      let isNew = false;

      const screening = await db.screening.create({
        data: {
          candidateId: id,
          score: result.score,
          matchedMustHaves: result.matchedMustHaves,
          gaps: result.gaps,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd: result.costUsd,
          verdict: result.verdict,
          reasonSummary: result.reasonSummary,
        },
      });

      if (result.verdict === "shortlist") {
        let shortlist = await db.shortlist.findFirst({
          where: { jobId: candidate.jobId, status: "draft" },
        });

        if (!shortlist) {
          shortlist = await db.shortlist.create({
            data: { jobId: candidate.jobId, status: "draft" },
          });
        }

        // Whether this is the first time they land on the shortlist decides if
        // the team is notified — a re-screen of someone already there is not
        // news, and mailing on every re-run would train people to ignore it.
        const existingItem = await db.shortlistItem.findUnique({
          where: {
            shortlistId_candidateId: {
              shortlistId: shortlist.id,
              candidateId: id,
            },
          },
        });
        isNew = !existingItem;

        await db.shortlistItem.upsert({
          where: {
            shortlistId_candidateId: {
              shortlistId: shortlist.id,
              candidateId: id,
            },
          },
          update: { removedBy: null, finalState: null },
          create: {
            shortlistId: shortlist.id,
            candidateId: id,
            addedBy: ctx.user.id,
          },
        });
      }

      // The candidate's pipeline position follows the events that just
      // happened, in the order they happened: screened first, then shortlisted
      // if the verdict put them there. advanceCandidateStatus only ever moves
      // forward and refuses to overwrite a manual judgement, so re-screening
      // somebody already marked Hired leaves them Hired.
      //
      // Note this sets a label and nothing else. No approval row is created
      // here, so nothing about it reaches the candidate.
      await advanceCandidateStatus(db, {
        tenantId: ctx.tenant.id,
        candidateId: id,
        to: "screened",
        reason: "CV screening completed",
      });

      if (result.verdict === "shortlist") {
        await advanceCandidateStatus(db, {
          tenantId: ctx.tenant.id,
          candidateId: id,
          to: "shortlisted",
          reason: "Screening verdict placed them on the draft shortlist",
        });
      }

      const period = currentUsagePeriod();
      await db.usageMeter.upsert({
        where: { tenantId_period: { tenantId: ctx.tenant.id, period } },
        update: { screeningsUsed: { increment: 1 } },
        create: { tenantId: ctx.tenant.id, period, screeningsUsed: 1 },
      });

      return { screening, newlyShortlisted: isNew };
    });

    // 4. Notify the team, outside the transaction and after the commit. The
    //    score is the valuable artifact and is already saved; a mail provider
    //    outage must not roll it back or fail the request.
    if (newlyShortlisted) {
      await notifyCandidateShortlisted(
        {
          tenantId: ctx.tenant.id,
          tenantName: ctx.tenant.name,
          tenantSlug: ctx.tenant.slug,
          jobId: candidate.jobId,
          jobTitle: candidate.job.title,
          candidateName: candidate.name ?? candidate.email ?? "A candidate",
          score: result.score,
          reasonSummary: result.reasonSummary,
        },
        tx
      );
    }

    return { screening };
  });
}
