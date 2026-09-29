import { NextRequest } from "next/server";
import { Action, NotFoundError, ValidationError, writeAuditLog } from "@pratibha/shared";
import { normalizePhoneE164 } from "@pratibha/worker/src/ingestion/parser.js";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const bodySchema = z.object({ phone: z.string().trim().min(1).max(40) });

/**
 * Add the phone number a CV arrived without.
 *
 * Pratibha recognises a candidate on the call by their number, so a candidate
 * with none can be screened and shortlisted but never interviewed. This is the
 * screen the "CVs arrived without a phone number" strip sends people to.
 *
 * It contacts nobody: interviews are still gated on an approved shortlist, and
 * a number only lets an already-approved candidate be recognised when they call.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Enter a phone number", parsed.error.flatten());
    }

    // Same normaliser the CV parser and manual intake use, so the stored number
    // dedupes against one read out of a PDF.
    const phoneE164 = normalizePhoneE164(parsed.data.phone);
    if (!phoneE164) {
      throw new ValidationError(
        `"${parsed.data.phone}" is not a phone number we can call. Use a 10-digit Indian mobile or a number with its country code.`
      );
    }

    return withTenantAuth(tenant, Action.candidateUpdate, async (ctx, tx) => {
      const candidate = await tx.candidate.findUnique({
        where: { id },
        select: { id: true, jobId: true, phoneE164: true, name: true },
      });
      if (!candidate) throw new NotFoundError("Candidate not found");

      // One number per person per job is a database constraint; say who has it
      // rather than surfacing the constraint error.
      const clash = await tx.candidate.findFirst({
        where: { jobId: candidate.jobId, phoneE164, id: { not: id } },
        select: { name: true, email: true },
      });
      if (clash) {
        throw new ValidationError(
          `${phoneE164} already belongs to ${clash.name ?? clash.email ?? "another candidate"} on this job.`
        );
      }

      const updated = await tx.candidate.update({
        where: { id },
        data: { phoneE164, noPhone: false },
        select: { id: true, phoneE164: true, noPhone: true },
      });

      await writeAuditLog(tx, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "candidate.phone.updated",
        entity: "candidate",
        entityId: id,
        before: { phoneE164: candidate.phoneE164 },
        after: { phoneE164 },
      });

      return { candidate: updated };
    });
  });
}
