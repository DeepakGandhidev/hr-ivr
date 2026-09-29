import { NextRequest, NextResponse } from "next/server";
import { Action, createJobSchema, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { assertCanCreateJob } from "@/lib/billing";
import { uniqueJobSlug } from "@/lib/slug";
import { attentionFor, countsForJobs, publishInputsForJobs } from "@/lib/job-insights";

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  const { searchParams } = new URL(request.url);
  // ?archived=1 lists the Archived tab. Everywhere else — pickers, settings —
  // archived roles are not part of the hiring surface.
  const archived = searchParams.get("archived") === "1";
  // ?insights=1 adds what a Jobs card shows. Opt-in, because the pickers that
  // also call this only need ids and titles.
  const insights = searchParams.get("insights") === "1";

  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const jobs = await tx.job.findMany({
        // Archived roles stay in the database for their candidates' sake.
        where: { deletedAt: archived ? { not: null } : null },
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

      if (!insights) return { jobs };

      const ids = jobs.map((j) => j.id);
      const [counts, publish, openCount, archivedCount] = await Promise.all([
        countsForJobs(tx, ids),
        publishInputsForJobs(tx, jobs),
        tx.job.count({ where: { deletedAt: null } }),
        tx.job.count({ where: { deletedAt: { not: null } } }),
      ]);

      return {
        jobs: jobs.map((job) => {
          const c = counts.get(job.id)!;
          const p = publish.get(job.id)!;
          return {
            ...job,
            counts: c,
            publish: p,
            attention: attentionFor(c, p),
          };
        }),
        tabs: { open: openCount, archived: archivedCount },
      };
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
