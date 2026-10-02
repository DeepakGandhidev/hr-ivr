import { NextRequest } from "next/server";
import { Action, can, NotFoundError, UserRole } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import {
  attentionFor,
  countsForJobs,
  dbConfigFor,
  interviewSetupFor,
  publishInputsForJobs,
  scoreThresholdOf,
} from "@/lib/job-insights";
import { platformSettings } from "@/lib/platform-settings";

/**
 * Everything the job hub and its tab bar show, in one request: the header's
 * publish chip, the live tab counts, the funnel strip, role facts, the
 * effective interview setup and the latest JD.
 *
 * The permission flags are for display only — every action is still
 * authorised by its own endpoint.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.jobRead, async (ctx, tx) => {
      const job = await tx.job.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          location: true,
          salaryBand: true,
          experienceRange: true,
          mustHaves: true,
          goodToHaves: true,
          screeningThreshold: true,
          createdAt: true,
          deletedAt: true,
        },
      });
      if (!job) throw new NotFoundError("Job not found");

      const [counts, publish, interview, config, jd, versionCount, settings] = await Promise.all([
        countsForJobs(tx, [id]),
        publishInputsForJobs(tx, [job]),
        interviewSetupFor(tx, ctx.tenant.id, id),
        dbConfigFor(tx, ctx.tenant.planId),
        tx.jobDescription.findFirst({
          where: { jobId: id },
          orderBy: { version: "desc" },
          select: { id: true, version: true, bodyMd: true, generatedBy: true, approvedAt: true, createdAt: true },
        }),
        tx.jobDescription.count({ where: { jobId: id } }),
        platformSettings(),
      ]);

      const c = counts.get(id)!;
      const p = publish.get(id)!;
      const role = ctx.user.role as unknown as UserRole;

      return {
        job: { ...job, deletedAt: undefined },
        counts: c,
        publish: p,
        attention: attentionFor(c, p),
        interview,
        jd,
        jdVersionCount: versionCount,
        config: {
          scoreThreshold: scoreThresholdOf(job, settings.suggestThreshold),
          scoreGapThreshold: config.scoreGapThreshold,
          portalPosts: config.portalPosts,
        },
        permissions: {
          canEdit: can(role, Action.jobUpdate),
          canArchive: can(role, Action.jobDelete),
          canPublish: can(role, Action.jobPublish),
          canApproveJd: can(role, Action.jobApproveJD),
          canApproveShortlist: can(role, Action.shortlistApprove),
          canEditShortlist: can(role, Action.shortlistEdit),
          canSendInvites: can(role, Action.outreachSend),
          canScreen: can(role, Action.candidateScreen),
          canChangeStatus: can(role, Action.candidateStatus),
          canUpdateCandidate: can(role, Action.candidateUpdate),
          canAddCandidates: can(role, Action.candidateCreate),
          canEditInterview: can(role, Action.protocolUpdate),
        },
      };
    })
  );
}
