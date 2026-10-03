import { AppError, advanceCandidateStatus, NotFoundError } from "@pratibha/shared";
import type { TenantTransactionClient, TenantWithPlan } from "@/lib/authz";
import { assertScreeningQuota, currentUsagePeriod } from "@/lib/billing";
import { runCvScreening } from "@/lib/screening";
import { notifyCandidateShortlisted } from "@/lib/notifications";
import { platformSettings } from "@/lib/platform-settings";
import { NO_JOB_ROUTING } from "@/lib/candidates";

type RunTx = <T>(cb: (db: TenantTransactionClient) => Promise<T>) => Promise<T>;

/**
 * §5 Stage 5 — score one candidate against their current job and place them on
 * the draft shortlist when the verdict says so. One implementation behind the
 * Screen button, bulk Screen now, and the Auto mode runner, so all three cost
 * the same, record the same and land the candidate in the same place.
 *
 * The model call sits between two short transactions rather than inside one:
 * an interactive transaction times out long before a screening call returns,
 * and holding a connection across a provider round trip would starve the pool.
 */
export async function screenCandidate(args: {
  tenant: TenantWithPlan;
  candidateId: string;
  /** The person who asked, or the Auto runner. */
  actorId: string | "ai";
  tx: RunTx;
}) {
  const { tenant, candidateId, actorId, tx } = args;

  // 1. Read inputs and check quota.
  const { candidate, promptBody, threshold } = await tx(async (db) => {
    await assertScreeningQuota(tenant, db);

    const candidate = await db.candidate.findUnique({ where: { id: candidateId }, include: { job: true } });
    if (!candidate) throw new NotFoundError("Candidate not found");
    if (candidate.archivedAt || candidate.notApplicationAt) {
      throw new AppError("CONFLICT", "Restore this candidate before screening them.", 409);
    }
    if (candidate.routedBy === NO_JOB_ROUTING) {
      throw new AppError("CONFLICT", "Assign this candidate to a job before screening them.", 409);
    }

    const promptTemplate = await db.promptTemplate.findFirst({
      where: { key: "cv_screening" as any, active: true },
      orderBy: { version: "desc" },
    });
    if (!promptTemplate) throw new Error("cv_screening prompt template not found");

    return {
      candidate,
      promptBody: promptTemplate.body,
      threshold: candidate.job.screeningThreshold ?? (await platformSettings()).suggestThreshold,
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
        candidateId,
        // The job it was run against (PL60): a later move keeps this row in
        // the candidate's history without it counting as current.
        jobId: candidate.jobId,
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

    // PL90: a (re)screen re-reads the name, so a name that came from the
    // sender or the subject gives way to one the CV itself carries.
    const parsed = (candidate.cvParsed ?? {}) as { name?: string; extraction?: { ok?: boolean } };
    const cvName = parsed.extraction?.ok && typeof parsed.name === "string" ? parsed.name.trim() : "";
    await db.candidate.update({
      where: { id: candidateId },
      data: {
        screeningQueuedAt: null,
        ...(cvName && candidate.nameSource !== "cv" ? { name: cvName, nameSource: "cv" as const } : {}),
      },
    });

    if (result.verdict === "shortlist") {
      let shortlist = await db.shortlist.findFirst({ where: { jobId: candidate.jobId, status: "draft" } });
      if (!shortlist) shortlist = await db.shortlist.create({ data: { jobId: candidate.jobId, status: "draft" } });

      // Whether this is the first time they land on the shortlist decides if
      // the team is notified — a re-screen of someone already there is not
      // news, and mailing on every re-run would train people to ignore it.
      const existingItem = await db.shortlistItem.findUnique({
        where: { shortlistId_candidateId: { shortlistId: shortlist.id, candidateId } },
      });
      isNew = !existingItem;

      await db.shortlistItem.upsert({
        where: { shortlistId_candidateId: { shortlistId: shortlist.id, candidateId } },
        update: { removedBy: null, finalState: null },
        create: { shortlistId: shortlist.id, candidateId, addedBy: actorId },
      });
    }

    // Pipeline position follows the events, in order. advanceCandidateStatus
    // only moves forward and never overwrites a manual judgement. No approval
    // row is created here, so nothing about it reaches the candidate.
    await advanceCandidateStatus(db, {
      tenantId: tenant.id,
      candidateId,
      to: "screened",
      reason: "CV screening completed",
    });
    if (result.verdict === "shortlist") {
      await advanceCandidateStatus(db, {
        tenantId: tenant.id,
        candidateId,
        to: "shortlisted",
        reason: "Screening verdict placed them on the draft shortlist",
      });
    }

    const period = currentUsagePeriod();
    await db.usageMeter.upsert({
      where: { tenantId_period: { tenantId: tenant.id, period } },
      update: { screeningsUsed: { increment: 1 } },
      create: { tenantId: tenant.id, period, screeningsUsed: 1 },
    });

    return { screening, newlyShortlisted: isNew };
  });

  // 4. Notify the team after the commit. The score is already saved; a mail
  //    provider outage must not roll it back or fail the request.
  if (newlyShortlisted) {
    await notifyCandidateShortlisted(
      {
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
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
}
