import { NextRequest, NextResponse } from "next/server";
import {
  Action,
  CANDIDATE_STATUSES,
  NotFoundError,
  ValidationError,
  setCandidateStatusManually,
} from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const statusSchema = z.object({
  status: z.enum(CANDIDATE_STATUSES),
  /** Optional note for the timeline, e.g. why someone was moved backwards. */
  reason: z.string().trim().max(500).optional(),
});

/**
 * Set a candidate's pipeline status by hand.
 *
 * Any status may be set from any other, backwards included: the recruiter is
 * the authority on where a candidate stands, and a field that refuses
 * corrections stops matching reality. The audit entry records who decided it.
 *
 * This endpoint writes `status` and nothing else. Setting someone to
 * `shortlisted` here does not create a shortlist row, an approval, or any
 * outreach — the approval gate is a separate explicit step and is untouched by
 * anything here. That separation is the point: status is what a recruiter sees,
 * approval is what lets a message leave the building.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = statusSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid status", parsed.error.flatten());
    }

    // Authorisation is resolved here from the session, never from the request
    // body — the frontend hiding a control is a convenience, not a check.
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateStatus);

    return tx(async (db) => {
      const candidate = await db.candidate.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!candidate) throw new NotFoundError("Candidate not found");

      const change = await setCandidateStatusManually(db, {
        tenantId: ctx.tenant.id,
        candidateId: id,
        to: parsed.data.status,
        actor: ctx.user.id,
        reason: parsed.data.reason,
      });

      if (!change) throw new NotFoundError("Candidate not found");

      return NextResponse.json({ status: change.to, previousStatus: change.from });
    });
  });
}
