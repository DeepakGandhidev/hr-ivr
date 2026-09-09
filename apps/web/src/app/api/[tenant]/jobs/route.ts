import { NextRequest, NextResponse } from "next/server";
import { Action, createJobSchema, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { assertCanCreateJob } from "@/lib/billing";
import { uniqueJobSlug } from "@/lib/slug";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const jobs = await tx.job.findMany({
        // Archived roles stay in the database for their candidates' sake, but
        // they are not part of the hiring surface any more.
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          descriptions: {
            where: { approvedAt: { not: null } },
            orderBy: { version: "desc" },
            take: 1,
          },
          _count: { select: { candidates: true } },
        },
      });
      return { jobs };
    })
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid job payload", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.jobCreate, async (ctx, tx) => {
      await assertCanCreateJob(ctx.tenant, tx);

      const slug = await uniqueJobSlug(ctx.tenant.id, parsed.data.title, (where) =>
        tx.job.findUnique({ where })
      );

      const job = await tx.job.create({
        data: {
          tenantId: ctx.tenant.id,
          slug,
          title: parsed.data.title,
          location: parsed.data.location,
          salaryBand: parsed.data.salaryBand,
          experienceRange: parsed.data.experienceRange,
          mustHaves: parsed.data.mustHaves,
          goodToHaves: parsed.data.goodToHaves,
          createdBy: ctx.user.id,
        },
      });

      return NextResponse.json({ job }, { status: 201 });
    });
  });
}
