import { NextRequest } from "next/server";
import { Action, NotFoundError, updateShortlistSchema, ValidationError, advanceCandidateStatus } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const querySchema = z.object({
  jobId: z.string().min(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const { searchParams } = new URL(request.url);
    const query = querySchema.safeParse({ jobId: searchParams.get("jobId") });
    if (!query.success) {
      throw new ValidationError("jobId query parameter is required", query.error.flatten());
    }

    // ?detail=1 is the Shortlist tab: every item with what its rows show
    // (latest screening, invitation state, whether they were interviewed) and
    // who approved. The plain list stays light for anything else.
    const detail = searchParams.get("detail") === "1";

    return withTenantAuth(tenant, Action.shortlistRead, async (_ctx, tx) => {
      if (detail) {
        const shortlists = await tx.shortlist.findMany({
          where: { jobId: query.data.jobId },
          orderBy: { createdAt: "desc" },
          include: {
            _count: { select: { items: true } },
            approvals: {
              orderBy: { approvedAt: "desc" },
              take: 1,
              include: { approver: { select: { id: true, name: true, email: true } } },
            },
            items: {
              orderBy: { createdAt: "asc" },
              include: {
                candidate: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    phoneE164: true,
                    status: true,
                    screenings: { orderBy: { createdAt: "desc" }, take: 1 },
                    // Enough to say whether an invitation went out under an
                    // approval. The email body itself is never selected.
                    outreachEmails: {
                      orderBy: { createdAt: "desc" },
                      select: { id: true, sentAt: true, status: true, approvalId: true },
                    },
                    interviewCalls: {
                      where: { assessmentReport: { isNot: null } },
                      select: { id: true },
                    },
                  },
                },
              },
            },
          },
        });
        return { shortlists };
      }

      const shortlists = await tx.shortlist.findMany({
        where: { jobId: query.data.jobId },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { items: true } },
          approvals: { orderBy: { approvedAt: "desc" }, take: 1 },
        },
      });

      return { shortlists };
    });
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = updateShortlistSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid shortlist payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.shortlistEdit, async (ctx, tx) => {
      const candidate = await tx.candidate.findUnique({
        where: { id: parsed.data.candidateId },
      });

      if (!candidate) {
        throw new NotFoundError("Candidate not found");
      }

      let shortlist = await tx.shortlist.findFirst({
        where: { jobId: candidate.jobId, status: "draft" },
      });

      if (!shortlist) {
        shortlist = await tx.shortlist.create({
          data: { jobId: candidate.jobId, status: "draft" },
        });
      }

      if (parsed.data.action === "add") {
        await tx.shortlistItem.upsert({
          where: {
            shortlistId_candidateId: {
              shortlistId: shortlist.id,
              candidateId: candidate.id,
            },
          },
          update: { removedBy: null, finalState: null },
          create: {
            shortlistId: shortlist.id,
            candidateId: candidate.id,
            addedBy: ctx.user.id,
          },
        });

        // Being on a shortlist is the candidate's pipeline position, so the
        // status follows the row. It is a label only: the approval row that
        // gates outreach is a separate, explicit step, and nothing here
        // creates one or contacts anybody.
        await advanceCandidateStatus(tx, {
          tenantId: ctx.tenant.id,
          candidateId: candidate.id,
          to: "shortlisted",
          actor: ctx.user.id,
          reason: "Added to the draft shortlist",
        });
      } else {
        await tx.shortlistItem.updateMany({
          where: {
            shortlistId: shortlist.id,
            candidateId: candidate.id,
          },
          data: {
            removedBy: ctx.user.id,
            finalState: "removed",
          },
        });
      }

      const updated = await tx.shortlist.findUnique({
        where: { id: shortlist.id },
        include: { items: { include: { candidate: true } } },
      });

      return { shortlist: updated };
    });
  });
}
