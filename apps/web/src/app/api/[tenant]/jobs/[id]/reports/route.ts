import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const reports = await tx.assessmentReport.findMany({
        where: {
          interviewCall: {
            candidate: { jobId: id },
          },
        },
        orderBy: { generatedAt: "desc" },
        include: {
          interviewCall: {
            include: {
              candidate: { select: { id: true, name: true, email: true, phoneE164: true } },
            },
          },
        },
      });
      return { reports };
    })
  );
}
