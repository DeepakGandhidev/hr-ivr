import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.shortlistRead, async (_ctx, tx) => {
      const shortlist = await tx.shortlist.findUnique({
        where: { id },
        include: {
          items: {
            where: { OR: [{ finalState: null }, { finalState: "approved" }] },
            include: {
              candidate: {
                include: {
                  // Enough to tell the recruiter whether this person has already
                  // been invited, and under which approval. renderedBody is
                  // deliberately not selected: it is the full email text on
                  // every row, and the page only needs to render a badge.
                  outreachEmails: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: {
                      id: true,
                      sentAt: true,
                      status: true,
                      approvalId: true,
                    },
                  },
                },
              },
            },
          },
          approvals: { orderBy: { approvedAt: "desc" }, take: 1 },
        },
      });

      if (!shortlist) {
        throw new NotFoundError("Shortlist not found");
      }

      return { shortlist };
    })
  );
}
