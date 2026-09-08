import { NextRequest } from "next/server";
import { Action, ForbiddenError, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.shortlistApprove, async (ctx, tx) => {
      const shortlist = await tx.shortlist.findUnique({
        where: { id },
        include: {
          items: {
            where: { OR: [{ finalState: null }, { finalState: "approved" }] },
            include: { candidate: { select: { id: true, name: true, email: true } } },
          },
        },
      });

      if (!shortlist) {
        throw new NotFoundError("Shortlist not found");
      }

      if (shortlist.status === "approved") {
        throw new ForbiddenError("Shortlist is already approved");
      }

      const snapshot = shortlist.items.map(
        (item: {
          candidateId: string;
          candidate: { id: string; name: string | null; email: string | null };
        }) => ({
          candidateId: item.candidateId,
          name: item.candidate.name,
          email: item.candidate.email,
        })
      );

      const approval = await tx.approval.create({
        data: {
          shortlistId: id,
          approvedBy: ctx.user.id,
          snapshot: snapshot as any,
        },
      });

      if (snapshot.length === 0) {
        throw new ForbiddenError(
          "This shortlist has no candidates to approve. Add candidates before approving it."
        );
      }

      // The agent's caller check requires BOTH an approval snapshot containing
      // the candidate AND finalState === 'approved' on their shortlist item.
      // Approving used to write only the snapshot, so every approved candidate
      // still failed verification and was refused on the phone — the one thing
      // approving a shortlist is meant to enable.
      await tx.shortlistItem.updateMany({
        where: { shortlistId: id, OR: [{ finalState: null }, { finalState: "approved" }] },
        data: { finalState: "approved" },
      });

      await tx.shortlist.update({
        where: { id },
        data: { status: "approved" },
      });

      return { approval };
    })
  );
}
