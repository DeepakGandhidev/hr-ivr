import { NextRequest, NextResponse } from "next/server";
import { Action, NotFoundError, ValidationError, writeAuditLog } from "@pratibha/shared";
import { adminPrisma, type PrismaClient } from "@pratibha/prisma";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const patchSchema = z.object({
  jobId: z.string().min(1).max(64),
});

/**
 * Move a candidate to a different job.
 *
 * The mailbox router files anything it cannot match into the fallback job, so a
 * role's candidate list routinely contains people who applied for something
 * else. Until now the only way to correct that was in the database.
 *
 * Moving is not just an update to job_id. A screening scores a CV against one
 * job's must-haves, and a shortlist belongs to one job — carried across, both
 * become confident statements about the wrong role, and the shortlist is what
 * clears someone to be interviewed. So the job-scoped judgements are removed
 * and the candidate arrives unscreened, which is the truth: nobody has assessed
 * them for this role yet.
 *
 * The screening rows are deleted rather than kept for history because they
 * drive live decisions. Billing is unaffected: the meter that counts screenings
 * is usage_meters, and it is not touched.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Choose a job to move this candidate to", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateUpdate);

    return tx(async (db) => {
      const candidate = await db.candidate.findUnique({
        where: { id },
        include: { job: true },
      });
      if (!candidate) throw new NotFoundError("Candidate not found");

      // RLS scopes this read to the tenant, so a job id from another workspace
      // simply is not found rather than being moved into.
      const job = await db.job.findUnique({ where: { id: parsed.data.jobId } });
      if (!job) throw new NotFoundError("Job not found");

      if (candidate.jobId === job.id) {
        return NextResponse.json({ candidate, moved: false });
      }

      // A candidate is unique per (tenant, job, phone). Landing on that
      // constraint would surface as a raw Prisma P2002, which tells a recruiter
      // nothing about the duplicate already sitting in the destination.
      if (candidate.phoneE164) {
        const clash = await db.candidate.findFirst({
          where: { jobId: job.id, phoneE164: candidate.phoneE164, id: { not: candidate.id } },
        });
        if (clash) {
          throw new ValidationError(
            `${clash.name ?? clash.email ?? "Someone"} with this phone number is already on ${job.title}. ` +
              "Delete one of the two before moving."
          );
        }
      }

      const removedScreenings = await db.screening.findMany({
        where: { candidateId: id },
        select: { id: true, score: true, verdict: true },
      });

      // Shortlists belong to a job, so placement on the old job's shortlist has
      // to go with the move — otherwise the candidate stays approved to
      // interview for a role they are no longer applying to.
      await db.shortlistItem.deleteMany({
        where: { candidateId: id, shortlist: { jobId: candidate.jobId } },
      });
      await db.screening.deleteMany({ where: { candidateId: id } });

      const updated = await db.candidate.update({
        where: { id },
        data: {
          jobId: job.id,
          // A person put them here, so the routing provenance says so rather
          // than still claiming the router matched them.
          routedBy: "manual",
          routingConfidence: null,
        },
      });

      await writeAuditLog(adminPrisma as unknown as PrismaClient, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "candidate.moved",
        entity: "candidate",
        entityId: id,
        before: { jobId: candidate.jobId, jobTitle: candidate.job.title, routedBy: candidate.routedBy },
        after: {
          jobId: job.id,
          jobTitle: job.title,
          discardedScreenings: removedScreenings.length,
          discardedScores: removedScreenings.map((s) => s.score),
        },
      }).catch((error) => console.error("Failed to audit candidate move", error));

      return NextResponse.json({
        candidate: updated,
        moved: true,
        movedTo: job.title,
        discardedScreenings: removedScreenings.length,
      });
    });
  });
}
