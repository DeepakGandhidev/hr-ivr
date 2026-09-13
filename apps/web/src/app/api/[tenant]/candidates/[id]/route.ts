import { NextRequest, NextResponse } from "next/server";
import {
  Action,
  CANDIDATE_STATUSES,
  CANDIDATE_STATUS_LABELS,
  NotFoundError,
  ValidationError,
  writeAuditLog,
  type CandidateStatus,
} from "@pratibha/shared";
import { adminPrisma, type PrismaClient } from "@pratibha/prisma";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const patchSchema = z.object({
  jobId: z.string().min(1).max(64),
});

/**
 * Move a candidate to a different job.
 *
 * The mailbox router files anything it cannot match into the fallback job, so a
 * role's candidate list routinely contains people who applied for something
 * else. Until now the only way to correct that was in the database.
 *
 * Moving is not just an update to job_id. A screening scores a CV against one
 * job's must-haves, and a shortlist belongs to one job — carried across, both
 * become confident statements about the wrong role, and the shortlist is what
 * clears someone to be interviewed. So the job-scoped judgements are removed
 * and the candidate arrives unscreened, which is the truth: nobody has assessed
 * them for this role yet.
 *
 * The screening rows are deleted rather than kept for history because they
 * drive live decisions. Billing is unaffected: the meter that counts screenings
 * is usage_meters, and it is not touched.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Choose a job to move this candidate to", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateUpdate);

    return tx(async (db) => {
      const candidate = await db.candidate.findUnique({
        where: { id },
        include: { job: true },
      });
      if (!candidate) throw new NotFoundError("Candidate not found");

      // RLS scopes this read to the tenant, so a job id from another workspace
      // simply is not found rather than being moved into.
      const job = await db.job.findFirst({ where: { id: parsed.data.jobId, deletedAt: null } });
      if (!job) throw new NotFoundError("Job not found");

      if (candidate.jobId === job.id) {
        return NextResponse.json({ candidate, moved: false });
      }

      // A candidate is unique per (tenant, job, phone). Landing on that
      // constraint would surface as a raw Prisma P2002, which tells a recruiter
      // nothing about the duplicate already sitting in the destination.
      if (candidate.phoneE164) {
        const clash = await db.candidate.findFirst({
          where: { jobId: job.id, phoneE164: candidate.phoneE164, id: { not: candidate.id } },
        });
        if (clash) {
          throw new ValidationError(
            `${clash.name ?? clash.email ?? "Someone"} with this phone number is already on ${job.title}. ` +
              "Delete one of the two before moving."
          );
        }
      }

      const removedScreenings = await db.screening.findMany({
        where: { candidateId: id },
        select: { id: true, score: true, verdict: true },
      });

      // Shortlists belong to a job, so placement on the old job's shortlist has
      // to go with the move — otherwise the candidate stays approved to
      // interview for a role they are no longer applying to.
      await db.shortlistItem.deleteMany({
        where: { candidateId: id, shortlist: { jobId: candidate.jobId } },
      });
      await db.screening.deleteMany({ where: { candidateId: id } });

      const updated = await db.candidate.update({
        where: { id },
        data: {
          jobId: job.id,
          // A person put them here, so the routing provenance says so rather
          // than still claiming the router matched them.
          routedBy: "manual",
          routingConfidence: null,
        },
      });

      await writeAuditLog(adminPrisma as unknown as PrismaClient, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "candidate.moved",
        entity: "candidate",
        entityId: id,
        before: { jobId: candidate.jobId, jobTitle: candidate.job.title, routedBy: candidate.routedBy },
        after: {
          jobId: job.id,
          jobTitle: job.title,
          discardedScreenings: removedScreenings.length,
          discardedScores: removedScreenings.map((s) => s.score),
        },
      }).catch((error) => console.error("Failed to audit candidate move", error));

      return NextResponse.json({
        candidate: updated,
        moved: true,
        movedTo: job.title,
        discardedScreenings: removedScreenings.length,
      });
    });
  });
}

/**
 * Everything known about one candidate, in a single read.
 *
 * The acceptance criterion for this page is that a hiring manager can answer
 * "who is this, what did we learn, what happened so far" without opening
 * another screen — so the screenings, calls, reports, notes and the events
 * behind the timeline all come back together rather than as six round trips.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const { tx } = await authorizeTenant(tenant, Action.candidateRead);

    return tx(async (db) => {
      const candidate = await db.candidate.findUnique({
        where: { id },
        include: {
          job: { select: { id: true, title: true, mustHaves: true, goodToHaves: true } },
          // Every screening, newest first: a candidate moved between roles or
          // re-screened after a JD edit has more than one, and which one was
          // current when a decision was taken is the whole point of keeping them.
          screenings: { orderBy: { createdAt: "desc" } },
          notes: {
            orderBy: { createdAt: "desc" },
            include: { author: { select: { id: true, name: true, email: true } } },
          },
          interviewCalls: {
            orderBy: { startedAt: "desc" },
            include: { assessmentReport: true },
          },
          outreachEmails: {
            orderBy: { createdAt: "desc" },
            select: { id: true, createdAt: true, sentAt: true, status: true },
          },
          shortlistItems: {
            include: {
              shortlist: {
                select: {
                  id: true,
                  status: true,
                  createdAt: true,
                  approvals: {
                    orderBy: { approvedAt: "desc" },
                    select: {
                      id: true,
                      approvedAt: true,
                      approver: { select: { name: true, email: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!candidate) {
        throw new NotFoundError("Candidate not found");
      }

      // Status changes are the one part of the history that is not derivable
      // from a row somewhere: the candidate carries only its current status, so
      // who moved it and when lives in the audit log. Actors are resolved to
      // names here rather than in the client, which has no way to look up a
      // user id.
      const statusChanges = await db.auditLog.findMany({
        where: { action: "candidate.status", entity: "candidate", entityId: id },
        orderBy: { createdAt: "desc" },
        select: { actor: true, before: true, after: true, reason: true, createdAt: true },
      });

      const actorIds = Array.from(
        new Set(statusChanges.map((c) => c.actor).filter((a) => a !== "system"))
      );
      const actors = actorIds.length
        ? await db.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const actorNames = new Map(actors.map((u) => [u.id, u.name ?? u.email]));

      return {
        candidate,
        timeline: buildTimeline(candidate, statusChanges, actorNames),
      };
    });
  });
}

type TimelineEvent = {
  at: string;
  kind:
    | "applied"
    | "screened"
    | "shortlisted"
    | "approved"
    | "invited"
    | "called"
    | "reported"
    | "status";
  title: string;
  detail: string;
};

/**
 * The candidate's history as one ordered list.
 *
 * Assembled from the rows that already exist rather than from an event log:
 * there is no such log, and writing one now would start empty, so every
 * candidate already in the system would have a blank timeline.
 */
function buildTimeline(c: {
  createdAt: Date;
  routedBy: string | null;
  screenings: Array<{ createdAt: Date; score: number; verdict: string }>;
  shortlistItems: Array<{
    createdAt: Date;
    addedBy: string;
    shortlist: {
      approvals: Array<{ approvedAt: Date; approver: { name: string | null; email: string } }>;
    };
  }>;
  outreachEmails: Array<{ createdAt: Date; sentAt: Date | null; status: string | null }>;
  interviewCalls: Array<{
    startedAt: Date;
    endedAt: Date | null;
    status: string | null;
    assessmentReport: { overallScore: number; recommendation: string; generatedAt: Date } | null;
  }>;
},
  statusChanges: Array<{
    actor: string;
    before: unknown;
    after: unknown;
    reason: string | null;
    createdAt: Date;
  }> = [],
  actorNames: Map<string, string> = new Map()
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  events.push({
    at: c.createdAt.toISOString(),
    kind: "applied",
    title: "Applied",
    detail: c.routedBy ? `Filed by ${c.routedBy}` : "Application received",
  });

  for (const s of c.screenings) {
    events.push({
      at: s.createdAt.toISOString(),
      kind: "screened",
      title: `Screened — ${s.score}`,
      detail: s.verdict === "shortlist" ? "Met the threshold" : "Below the threshold",
    });
  }

  for (const item of c.shortlistItems) {
    events.push({
      at: item.createdAt.toISOString(),
      kind: "shortlisted",
      title: "Added to shortlist",
      detail: item.addedBy === "ai" ? "By Pratibha" : "By a reviewer",
    });
    for (const a of item.shortlist.approvals) {
      events.push({
        at: a.approvedAt.toISOString(),
        kind: "approved",
        title: "Shortlist approved",
        detail: `By ${a.approver.name ?? a.approver.email}`,
      });
    }
  }

  for (const e of c.outreachEmails) {
    if (!e.sentAt) continue;
    events.push({
      at: e.sentAt.toISOString(),
      kind: "invited",
      title: "Interview invite sent",
      detail: e.status ?? "sent",
    });
  }

  for (const call of c.interviewCalls) {
    events.push({
      at: call.startedAt.toISOString(),
      kind: "called",
      title: "Called Pratibha",
      detail: call.status ? call.status.replace(/_/g, " ") : "in progress",
    });
    if (call.assessmentReport) {
      events.push({
        at: call.assessmentReport.generatedAt.toISOString(),
        kind: "reported",
        title: `Assessment ready — ${call.assessmentReport.overallScore}`,
        detail: call.assessmentReport.recommendation.replace(/_/g, " "),
      });
    }
  }

  for (const change of statusChanges) {
    const from = statusOf(change.before);
    const to = statusOf(change.after);
    if (!to) continue;

    const who =
      change.actor === "system" ? "Automatically" : `By ${actorNames.get(change.actor) ?? "a teammate"}`;

    events.push({
      at: change.createdAt.toISOString(),
      kind: "status",
      title: from
        ? `Status: ${labelFor(from)} → ${labelFor(to)}`
        : `Status set to ${labelFor(to)}`,
      detail: change.reason ? `${who} — ${change.reason}` : who,
    });
  }

  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** Audit `before`/`after` are free-form JSON; only a known status is read out. */
function statusOf(payload: unknown): CandidateStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { status?: unknown }).status;
  return typeof value === "string" && (CANDIDATE_STATUSES as readonly string[]).includes(value)
    ? (value as CandidateStatus)
    : null;
}

function labelFor(status: CandidateStatus): string {
  return CANDIDATE_STATUS_LABELS[status];
}
