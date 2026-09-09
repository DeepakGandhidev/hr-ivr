import { NextRequest } from "next/server";
import { Action, NotFoundError, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobPublish, async (_ctx, tx) => {
      const job = await tx.job.findFirst({
        where: { id, deletedAt: null },
        include: {
          descriptions: {
            where: { approvedAt: { not: null } },
            orderBy: { version: "desc" },
            take: 1,
          },
        },
      });

      if (!job) {
        throw new NotFoundError("Job not found");
      }

      if (job.descriptions.length === 0) {
        // Not a 404: the job exists, it simply is not ready. Reporting this as
        // "not found" made a normal, expected step look like a broken page.
        throw new ValidationError(
          "This job has no approved description yet. Open JD Studio, save a version, then approve it before publishing."
        );
      }

      await tx.job.update({ where: { id }, data: { status: "open" } });

      // Publishing twice must not stack up posts for the same channel: the
      // publish screen reads posts.find(channel) and would keep showing the
      // first, while the list below it filled with duplicates.
      const existing = await tx.jobPost.findFirst({
        where: { jobId: id, channel: "careers_page" },
      });

      if (existing) {
        await tx.jobPost.update({
          where: { id: existing.id },
          data: { status: "posted", postedAt: new Date(), includesPratibhaNumber: true },
        });
      } else {
        await tx.jobPost.create({
          data: {
            jobId: id,
            channel: "careers_page",
            status: "posted",
            postedAt: new Date(),
            includesPratibhaNumber: true,
          },
        });
      }

      // The client replaces its job state with this response and immediately
      // reads job.posts. Returning the bare update() result left posts
      // undefined, so the page threw straight after a successful publish and
      // the whole thing looked like a failure.
      const updated = await tx.job.findFirst({
        where: { id, deletedAt: null },
        include: { posts: { orderBy: { createdAt: "desc" } } },
      });

      return { job: updated };
    })
  );
}
