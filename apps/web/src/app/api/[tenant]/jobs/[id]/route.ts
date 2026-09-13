import { NextRequest } from "next/server";
import {
  Action,
  createJobSchema,
  NotFoundError,
  ValidationError,
  writeAuditLog,
} from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const updateJobSchema = createJobSchema.partial().extend({
  /// Optional note explaining the edit, stored on the version it creates.
  changeNote: z.string().trim().max(500).optional(),
  /// The job description body. Sent from the same edit form as the structured
  /// fields so one save is one transaction: a JD saved while the structured
  /// write failed would leave the posting describing a role that no longer
  /// matches its own requirements.
  bodyMd: z.string().max(50_000).optional(),
});

/** The fields a JobVersion snapshots, read off a job row. */
function snapshot(job: {
  title: string;
  location: string | null;
  salaryBand: string | null;
  experienceRange: string | null;
  mustHaves: unknown;
  goodToHaves: unknown;
  screeningThreshold: number | null;
}) {
  return {
    title: job.title,
    location: job.location,
    salaryBand: job.salaryBand,
    experienceRange: job.experienceRange,
    mustHaves: job.mustHaves as never,
    goodToHaves: job.goodToHaves as never,
    screeningThreshold: job.screeningThreshold,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (_ctx, tx) => {
      const job = await tx.job.findFirst({
        // An archived job is gone as far as the portal is concerned. Its rows
        // survive because candidates, screenings and reports hang off them.
        where: { id, deletedAt: null },
        include: {
          descriptions: {
            where: { approvedAt: { not: null } },
            orderBy: { version: "desc" },
            take: 1,
          },
          versions: {
            orderBy: { version: "desc" },
            include: { author: { select: { id: true, name: true, email: true } } },
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

    return withTenantAuth(tenant, Action.jobUpdate, async (ctx, tx) => {
      const existing = await tx.job.findFirst({
        where: { id, deletedAt: null },
        include: { posts: { where: { status: "posted" } } },
      });
      if (!existing) {
        throw new NotFoundError("Job not found");
      }

      const data: z.infer<typeof updateJobSchema> = parsed.data;

      // Snapshot BEFORE the write, so the version records what the role was
      // when its existing candidates were screened against it. Taken after the
      // update it would just duplicate the new state and prove nothing.
      const latest = await tx.jobVersion.findFirst({
        where: { jobId: id },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      await tx.jobVersion.create({
        data: {
          jobId: id,
          version: (latest?.version ?? 0) + 1,
          ...snapshot(existing),
          changeNote: data.changeNote ?? null,
          createdBy: ctx.user.id,
        },
      });

      // A new JD version, in the same transaction as the structured snapshot.
      //
      // Written only when the text actually changed: the edit form always sends
      // the body, so comparing against the current version is what stops every
      // salary-band tweak from creating an identical JD version and burying the
      // real edits in the history.
      let description = null;
      if (data.bodyMd !== undefined) {
        const currentJd = await tx.jobDescription.findFirst({
          where: { jobId: id },
          orderBy: { version: "desc" },
        });

        const next = data.bodyMd.trim();
        if (next && next !== (currentJd?.bodyMd ?? "").trim()) {
          description = await tx.jobDescription.create({
            data: {
              jobId: id,
              version: (currentJd?.version ?? 0) + 1,
              bodyMd: next,
              generatedBy: "human",
            },
          });

          await writeAuditLog(tx, {
            tenantId: ctx.tenant.id,
            actor: ctx.user.id,
            action: "job.description.edited",
            entity: "job",
            entityId: id,
            before: { version: currentJd?.version ?? null },
            after: { version: description.version },
            reason: data.changeNote,
          });
        }
      }

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

      // The caller needs to know a live posting is now out of date. Reported
      // rather than acted on: re-publishing is the user's decision, and doing
      // it silently would push an unreviewed change to a public careers page.
      return {
        job,
        description,
        requiresRepublish: existing.posts.length > 0,
        livePostings: existing.posts.map((p) => ({ channel: p.channel, postedAt: p.postedAt })),
      };
    });
  });
}

/**
 * Archive a job. Never a hard delete.
 *
 * Candidates, screenings, interview calls and assessment reports all hang off a
 * job. Removing the row would cascade through every one of them and destroy the
 * evidence behind hiring decisions already made - including calls the tenant
 * was billed for. So the row stays and the portal stops showing it.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobDelete, async (ctx, tx) => {
      const job = await tx.job.findFirst({
        where: { id, deletedAt: null },
        include: { _count: { select: { candidates: true } } },
      });
      if (!job) {
        throw new NotFoundError("Job not found");
      }

      const archived = await tx.job.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: ctx.user.id, status: "closed" },
      });

      return {
        job: archived,
        archived: true,
        candidatesRetained: job._count.candidates,
      };
    })
  );
}
