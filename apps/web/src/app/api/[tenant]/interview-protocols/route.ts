import { NextRequest } from "next/server";
import {
  Action,
  interviewProtocolSchema,
  ValidationError,
} from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.protocolRead, async (ctx, tx) => {
      const protocols = await tx.interviewProtocol.findMany({
        where: { tenantId: ctx.tenant.id },
        orderBy: [{ jobId: "asc" }, { version: "desc" }],
      });
      return { protocols };
    })
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = interviewProtocolSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid interview protocol payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.protocolUpdate, async (ctx, tx) => {
      const jobId = parsed.data.jobId ?? null;

      if (jobId) {
        const job = await tx.job.findFirst({ where: { id: jobId, deletedAt: null } });
        if (!job) {
          throw new ValidationError("Job not found", { jobId });
        }
      }

      const existing = jobId
        ? await tx.interviewProtocol.findUnique({
            where: { tenantId_jobId: { tenantId: ctx.tenant.id, jobId } },
          })
        : await tx.interviewProtocol.findFirst({
            where: { tenantId: ctx.tenant.id, jobId: null },
          });

      const protocol = existing
        ? await tx.interviewProtocol.update({
            where: { id: existing.id },
            data: {
              instructionText: parsed.data.instructionText,
          ...(parsed.data.durationMinutes !== undefined && { durationMinutes: parsed.data.durationMinutes }),
          ...(parsed.data.difficulty !== undefined && { difficulty: parsed.data.difficulty }),
          ...(parsed.data.minQuestions !== undefined && { minQuestions: parsed.data.minQuestions }),
          ...(parsed.data.maxQuestions !== undefined && { maxQuestions: parsed.data.maxQuestions }),
          ...(parsed.data.focusAreas !== undefined && { focusAreas: parsed.data.focusAreas }),
          ...(parsed.data.agentName !== undefined && { agentName: parsed.data.agentName }),
          ...(parsed.data.companyName !== undefined && { companyName: parsed.data.companyName }),
              version: existing.version + 1,
              updatedBy: ctx.user.id,
            },
          })
        : await tx.interviewProtocol.create({
            data: {
              tenantId: ctx.tenant.id,
              jobId,
              instructionText: parsed.data.instructionText,
          ...(parsed.data.durationMinutes !== undefined && { durationMinutes: parsed.data.durationMinutes }),
          ...(parsed.data.difficulty !== undefined && { difficulty: parsed.data.difficulty }),
          ...(parsed.data.minQuestions !== undefined && { minQuestions: parsed.data.minQuestions }),
          ...(parsed.data.maxQuestions !== undefined && { maxQuestions: parsed.data.maxQuestions }),
          ...(parsed.data.focusAreas !== undefined && { focusAreas: parsed.data.focusAreas }),
          ...(parsed.data.agentName !== undefined && { agentName: parsed.data.agentName }),
          ...(parsed.data.companyName !== undefined && { companyName: parsed.data.companyName }),
              version: 1,
              updatedBy: ctx.user.id,
            },
          });

      return { protocol };
    });
  });
}
