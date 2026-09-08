import { NextRequest } from "next/server";
import { Action, createJobSchema, NotFoundError, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const updateJobSchema = createJobSchema.partial();

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const job = await tx.job.findUnique({
        where: { id },
        include: {
          descriptions: {
            where: { approvedAt: { not: null } },
            orderBy: { version: "desc" },
            take: 1,
          },
          posts: { orderBy: { createdAt: "desc" }, take: 5 },
          // Counted separately from the list above, which is filtered to
          // approved versions only. Without this the publish screen cannot
          // tell "no description written" from "written but not approved" —
          // two different problems with two different fixes.
          _count: { select: { candidates: true, descriptions: true } },
        },
      });

      if (!job) {
        throw new NotFoundError("Job not found");
      }

      return { job };
    })
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = updateJobSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid job update payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.jobUpdate, async (_ctx, tx) => {
      const existing = await tx.job.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundError("Job not found");
      }

      const data: z.infer<typeof updateJobSchema> = parsed.data;
      const job = await tx.job.update({
        where: { id },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.salaryBand !== undefined && { salaryBand: data.salaryBand }),
          ...(data.experienceRange !== undefined && { experienceRange: data.experienceRange }),
          ...(data.mustHaves !== undefined && { mustHaves: data.mustHaves }),
          ...(data.goodToHaves !== undefined && { goodToHaves: data.goodToHaves }),
        },
      });

      return { job };
    });
  });
}
