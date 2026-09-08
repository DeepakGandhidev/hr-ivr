import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { outreachFromAddress, sendAsTenant } from "@/lib/email";
import { defaultInterviewInviteVars, renderTemplate } from "@/lib/templates";
import { validateSendInvitesBody, verifyOutreachGate } from "@/lib/gates";

function generateReferenceCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const body = await request.json();
    const input = validateSendInvitesBody(body);

    return withTenantAuth(tenant, Action.outreachSend, async (ctx, tx) => {
      const { shortlist, approval, items } = await verifyOutreachGate(tx, id, input, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
      });

      const template = await tx.outreachTemplate.findFirst({
        where: { tenantId: ctx.tenant.id, type: "interview_invite", isDefault: true },
      });

      if (!template) {
        throw new NotFoundError("Interview invite template not found");
      }

      // The invite's whole purpose is to tell the candidate which number to
      // call. Rendering it without one produces "Please call  and use reference
      // code ABC123", which is worse than not sending: the candidate cannot act
      // on it, and the tenant has burned their one first impression. Fail before
      // anything leaves the building.
      const pratibhaNumber = process.env.PRATIBHA_NUMBER;
      if (!pratibhaNumber) {
        throw new Error(
          "PRATIBHA_NUMBER is not configured, so the interview invite would not " +
            "tell candidates which number to call. Set it in apps/web/.env.local."
        );
      }

      // Replies from candidates should land in the tenant's own inbox, not in a
      // Pratibha mailbox nobody reads (§5 Stage 2).
      // The whole row, not just the address: it now carries the credentials
      // the invite is actually sent through.
      const connection = await tx.emailConnection.findFirst({
        where: { tenantId: ctx.tenant.id, status: "connected" },
        orderBy: { createdAt: "asc" },
      });
      const fromAddress = outreachFromAddress(ctx.tenant.slug, ctx.tenant.name);
      const replyTo = connection?.address;
      const sent: Array<{ candidateId: string; outreachEmailId: string; status: string }> = [];

      // Who already has an invite under THIS approval. Scoped to the approval
      // rather than the candidate: re-approving a shortlist is a fresh decision
      // to contact these people, so it may legitimately invite them again,
      // while a second click under one approval is a mistake. The
      // (approval_id, candidate_id) index exists for exactly this lookup.
      const invitedUnderThisApproval = new Set(
        (
          await tx.outreachEmail.findMany({
            where: {
              approvalId: approval.id,
              candidateId: { in: items.map((item) => item.candidateId) },
              status: "sent",
            },
            select: { candidateId: true },
          })
        ).map((row) => row.candidateId)
      );

      for (const item of items) {
        const candidate = item.candidate;
        if (!candidate.email) {
          sent.push({ candidateId: candidate.id, outreachEmailId: "", status: "skipped_no_email" });
          continue;
        }

        if (!input.resend && invitedUnderThisApproval.has(candidate.id)) {
          sent.push({
            candidateId: candidate.id,
            outreachEmailId: "",
            status: "skipped_already_invited",
          });
          continue;
        }

        const referenceCode = generateReferenceCode();
        const vars = defaultInterviewInviteVars({
          candidateName: candidate.name ?? "Candidate",
          jobTitle: shortlist.job.title,
          companyName: ctx.tenant.name,
          pratibhaNumber,
          referenceCode,
        });

        const subject = renderTemplate(template.subject, vars);
        const body = renderTemplate(template.bodyMd, vars);

        // Prefers the tenant's own mailbox; `fromAddress` is only used if we
        // fall back to the shared provider.
        const result = await sendAsTenant(connection, ctx.tenant, {
          to: candidate.email,
          subject,
          body,
          from: fromAddress,
          ...(replyTo ? { replyTo } : {}),
        });

        const outreachEmail = await tx.outreachEmail.create({
          data: {
            candidateId: candidate.id,
            templateId: template.id,
            renderedBody: body,
            sentAt: result.ok ? new Date() : null,
            status: result.ok ? "sent" : "failed",
            approvalId: approval.id,
          },
        });

        sent.push({
          candidateId: candidate.id,
          outreachEmailId: outreachEmail.id,
          status: result.ok ? "sent" : `failed: ${result.error ?? "unknown"}`,
        });
      }

      return { sent };
    });
  });
}
