import { NextRequest } from "next/server";
import { Action, ForbiddenError, NotFoundError, ValidationError, writeAuditLog } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { dbConfigFor } from "@/lib/job-insights";
import { z } from "zod";

/** Portals a post can be copied for. The careers page has its own publish flow. */
const bodySchema = z.object({ channel: z.enum(["naukri", "linkedin"]) });

/**
 * Record that a job-portal post was copied.
 *
 * Portals are not integrated: the recruiter copies a formatted post and pastes
 * it from their own account. Copying is taken as posting, and the date and the
 * JD version it was built from are recorded so the Publish tab can say when the
 * portal copy has gone stale.
 *
 * Available per plan, from plans.features in the database (see dbConfigFor).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Choose Naukri or LinkedIn", parsed.error.flatten());
    }
    const { channel } = parsed.data;

    return withTenantAuth(tenant, Action.jobPublish, async (ctx, tx) => {
      const config = await dbConfigFor(tx, ctx.tenant.planId);
      if (!config.portalPosts) {
        throw new ForbiddenError("Job portal posts are not included in your plan.");
      }

      const job = await tx.job.findFirst({
        where: { id, deletedAt: null },
        include: {
          descriptions: {
            where: { approvedAt: { not: null } },
            orderBy: { version: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      });
      if (!job) throw new NotFoundError("Job not found");
      if (job.descriptions.length === 0) {
        throw new ValidationError("Approve a job description before posting it anywhere.");
      }

      const now = new Date();
      const existing = await tx.jobPost.findFirst({ where: { jobId: id, channel } });
      const data = {
        status: "posted" as const,
        postedAt: now,
        includesPratibhaNumber: true,
        externalRef: job.descriptions[0].id,
      };
      const post = existing
        ? await tx.jobPost.update({ where: { id: existing.id }, data })
        : await tx.jobPost.create({ data: { jobId: id, channel, ...data } });

      await writeAuditLog(tx, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "job.portal_post.copied",
        entity: "job",
        entityId: id,
        after: { channel, postedAt: now.toISOString(), jdId: job.descriptions[0].id },
      });

      return { post };
    });
  });
}
