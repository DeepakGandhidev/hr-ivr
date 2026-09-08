import { NextRequest } from "next/server";
import { Action, jobDescriptionSchema, NotFoundError, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const descriptions = await tx.jobDescription.findMany({
        where: { jobId: id },
        orderBy: { version: "desc" },
        include: { approver: { select: { id: true, name: true, email: true } } },
      });
      return { descriptions };
    })
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = jobDescriptionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid job description payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.jobUpdate, async (_ctx, tx) => {
      const job = await tx.job.findUnique({ where: { id } });
      if (!job) {
        throw new NotFoundError("Job not found");
      }

      const latest = await tx.jobDescription.findFirst({
        where: { jobId: id },
        orderBy: { version: "desc" },
      });

      const description = await tx.jobDescription.create({
        data: {
          jobId: id,
          version: (latest?.version ?? 0) + 1,
          bodyMd: parsed.data.bodyMd,
          generatedBy: parsed.data.generatedBy,
        },
      });

      return { description };
    });
  });
}
