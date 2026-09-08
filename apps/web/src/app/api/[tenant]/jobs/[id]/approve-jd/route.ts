import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobApproveJD, async (ctx, tx) => {
      const job = await tx.job.findUnique({ where: { id } });
      if (!job) {
        throw new NotFoundError("Job not found");
      }

      const latestPending = await tx.jobDescription.findFirst({
        where: { jobId: id, approvedAt: null },
        orderBy: { version: "desc" },
      });

      if (!latestPending) {
        throw new NotFoundError("No pending job description to approve");
      }

      const description = await tx.jobDescription.update({
        where: { id: latestPending.id },
        data: {
          approvedBy: ctx.user.id,
          approvedAt: new Date(),
        },
      });

      return { description };
    })
  );
}
