import { Prisma } from "@pratibha/prisma";
import { NotFoundError, ValidationError, writeAuditLog } from "@pratibha/shared";
import type { RequestContext, TenantTransactionClient } from "@/lib/authz";
import { NO_JOB_ROUTING } from "@/lib/candidates";

/**
 * The Pipeline as a triage desk (Batch 7): one paged, filtered, searchable
 * list of every application in the workspace, and the actions that resolve
 * them, singly or in bulk.
 *
 * The list is SQL rather than Prisma because "awaiting screen" means "no
 * screening for the candidate's CURRENT job", a correlation the query builder
 * cannot express. It runs inside the tenant transaction, so RLS still applies.
 */

export const VIEWS = ["all", "no_job", "no_phone", "awaiting", "not_applications", "archived"] as const;
export type PipelineView = (typeof VIEWS)[number];

export interface PipelineQuery {
  view: PipelineView;
  jobId?: string;
  q?: string;
  page: number;
  pageSize: number;
}

const ACTIVE = Prisma.sql`c.archived_at IS NULL AND c.not_application_at IS NULL`;
const HAS_CURRENT_SCREENING = Prisma.sql`EXISTS (SELECT 1 FROM screenings s WHERE s.candidate_id = c.id AND s.job_id = c.job_id)`;

function viewSql(view: PipelineView): Prisma.Sql {
  switch (view) {
    case "no_job":
      return Prisma.sql`${ACTIVE} AND c.routed_by = ${NO_JOB_ROUTING}`;
    case "no_phone":
      return Prisma.sql`${ACTIVE} AND c.phone_e164 IS NULL`;
    case "awaiting":
      return Prisma.sql`${ACTIVE} AND c.routed_by IS DISTINCT FROM ${NO_JOB_ROUTING} AND c.screening_queued_at IS NULL AND NOT ${HAS_CURRENT_SCREENING}`;
    case "not_applications":
      return Prisma.sql`c.not_application_at IS NOT NULL AND c.archived_at IS NULL`;
    case "archived":
      return Prisma.sql`c.archived_at IS NOT NULL`;
    default:
      return ACTIVE;
  }
}

/** Job filter and search: what the counts respect as well as the rows. */
function scopeSql(tenantId: string, jobId: string | undefined, q: string | undefined): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`c.tenant_id = ${tenantId}`];
  if (jobId) parts.push(Prisma.sql`c.job_id = ${jobId}`);
  const term = q?.trim();
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const digits = term.replace(/\D/g, "");
    parts.push(
      digits.length >= 3
        ? Prisma.sql`(c.name ILIKE ${like} OR c.email ILIKE ${like} OR regexp_replace(coalesce(c.phone_e164, ''), '\\D', '', 'g') LIKE ${`%${digits}%`})`
        : Prisma.sql`(c.name ILIKE ${like} OR c.email ILIKE ${like})`
    );
  }
  return Prisma.join(parts, " AND ");
}

export interface PipelineRow {
  id: string;
  name: string | null;
  nameSource: "cv" | "sender" | "subject" | null;
  email: string | null;
  phone: string | null;
  jobId: string;
  jobTitle: string;
  routedBy: string | null;
  routingConfidence: number | null;
  status: string;
  parseFailed: boolean;
  hasCvFile: boolean;
  createdAt: Date;
  queued: boolean;
  archivedAt: Date | null;
  archivedByName: string | null;
  notApplicationAt: Date | null;
  screeningId: string | null;
  score: number | null;
  verdict: string | null;
  screenedAt: Date | null;
}

export async function pipelinePage(db: TenantTransactionClient, tenantId: string, query: PipelineQuery) {
  const scope = scopeSql(tenantId, query.jobId, query.q);

  const [countRow] = await db.$queryRaw<Record<string, bigint>[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE ${viewSql("all")}) AS all,
      count(*) FILTER (WHERE ${viewSql("no_job")}) AS no_job,
      count(*) FILTER (WHERE ${viewSql("no_phone")}) AS no_phone,
      count(*) FILTER (WHERE ${viewSql("awaiting")}) AS awaiting,
      count(*) FILTER (WHERE ${viewSql("not_applications")}) AS not_applications,
      count(*) FILTER (WHERE ${viewSql("archived")}) AS archived
    FROM candidates c
    WHERE ${scope}`);
  const counts = Object.fromEntries(VIEWS.map((v) => [v, Number(countRow?.[v] ?? 0)])) as Record<PipelineView, number>;

  const total = counts[query.view];
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(Math.max(1, query.page), pages);

  const rows = await db.$queryRaw<PipelineRow[]>(Prisma.sql`
    SELECT
      c.id, c.name, c.name_source::text AS "nameSource", c.email, c.phone_e164 AS phone,
      c.job_id AS "jobId", j.title AS "jobTitle", c.routed_by AS "routedBy",
      c.routing_confidence AS "routingConfidence", c.status::text AS status,
      c.parse_failed AS "parseFailed", (c.cv_file_ref IS NOT NULL) AS "hasCvFile",
      c.created_at AS "createdAt", (c.screening_queued_at IS NOT NULL) AS queued,
      c.archived_at AS "archivedAt", coalesce(ua.name, ua.email) AS "archivedByName",
      c.not_application_at AS "notApplicationAt",
      s.id AS "screeningId", s.score, s.verdict::text AS verdict, s.created_at AS "screenedAt"
    FROM candidates c
    JOIN jobs j ON j.id = c.job_id
    LEFT JOIN users ua ON ua.id = c.archived_by
    LEFT JOIN LATERAL (
      SELECT id, score, verdict, created_at FROM screenings
      WHERE candidate_id = c.id AND job_id = c.job_id
      ORDER BY created_at DESC LIMIT 1
    ) s ON true
    WHERE ${scope} AND ${viewSql(query.view)}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}`);

  return { rows, counts, total, page, pages, pageSize: query.pageSize };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type BulkAction = "archive" | "restore" | "not_application" | "is_application" | "screen" | "assign";

/**
 * Every id, not just the first. RLS scopes the read to this workspace, so an
 * id from another one is simply not found, and the whole batch is refused.
 */
async function ownedCandidates(db: TenantTransactionClient, ids: string[]) {
  const unique = Array.from(new Set(ids));
  const found = await db.candidate.findMany({ where: { id: { in: unique } }, include: { job: true } });
  if (found.length !== unique.length) {
    throw new NotFoundError("Some of those candidates are not in this workspace. Nothing was changed.");
  }
  return found;
}

/** Shortlist entries that could still lead to a call die with the candidate's visibility. */
async function killInvitations(db: TenantTransactionClient, ids: string[], userId: string) {
  const { count } = await db.shortlistItem.updateMany({
    where: { candidateId: { in: ids }, OR: [{ finalState: null }, { finalState: "approved" }] },
    data: { finalState: "removed", removedBy: userId },
  });
  return count;
}

export async function applyBulk(
  db: TenantTransactionClient,
  ctx: RequestContext,
  action: BulkAction,
  ids: string[],
  opts: { jobId?: string; screeningMode: "auto" | "manual" }
) {
  if (!ids.length) throw new ValidationError("Select at least one candidate.");
  const rows = await ownedCandidates(db, ids);
  const now = new Date();
  const userId = ctx.user.id;
  const audit = (candidateId: string, auditAction: string, before: Record<string, unknown>, after: Record<string, unknown>) =>
    writeAuditLog(db, { tenantId: ctx.tenant.id, actor: userId, action: auditAction, entity: "candidate", entityId: candidateId, before, after });

  switch (action) {
    case "archive":
    case "not_application": {
      const field = action === "archive" ? { archivedAt: now, archivedBy: userId } : { notApplicationAt: now, notApplicationBy: userId };
      await db.candidate.updateMany({ where: { id: { in: ids } }, data: { ...field, screeningQueuedAt: null } });
      const killed = await killInvitations(db, ids, userId);
      for (const c of rows) await audit(c.id, action === "archive" ? "candidate.archived" : "candidate.not_application", {}, { at: now.toISOString() });
      return { changed: rows.length, invitationsRevoked: killed };
    }
    case "restore": {
      await db.candidate.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null, archivedBy: null } });
      for (const c of rows) await audit(c.id, "candidate.restored", { archivedAt: c.archivedAt?.toISOString() ?? null }, {});
      return { changed: rows.length };
    }
    case "is_application": {
      await db.candidate.updateMany({ where: { id: { in: ids } }, data: { notApplicationAt: null, notApplicationBy: null } });
      for (const c of rows) await audit(c.id, "candidate.is_application", {}, {});
      return { changed: rows.length };
    }
    case "screen": {
      const eligible = rows.filter((c) => !c.archivedAt && !c.notApplicationAt && c.routedBy !== NO_JOB_ROUTING);
      if (!eligible.length) throw new ValidationError("None of those can be screened: each needs a job first.");
      await db.candidate.updateMany({ where: { id: { in: eligible.map((c) => c.id) } }, data: { screeningQueuedAt: now } });
      return { changed: eligible.length, queued: eligible.length };
    }
    case "assign": {
      if (!opts.jobId) throw new ValidationError("Choose a job.");
      const job = await db.job.findFirst({ where: { id: opts.jobId, deletedAt: null } });
      if (!job) throw new NotFoundError("Job not found");
      let moved = 0;
      for (const c of rows) {
        if (c.jobId === job.id && c.routedBy !== NO_JOB_ROUTING) continue;
        if (c.phoneE164) {
          const clash = await db.candidate.findFirst({
            where: { jobId: job.id, phoneE164: c.phoneE164, id: { not: c.id } },
          });
          if (clash) {
            throw new ValidationError(
              `${clash.name ?? clash.email ?? "Someone"} with the same phone number is already on ${job.title}. Nothing was changed.`
            );
          }
        }
        // Placement on the old job's shortlist goes with the move; the old
        // screening stays in the candidate's history (it carries its job id).
        await db.shortlistItem.deleteMany({ where: { candidateId: c.id, shortlist: { jobId: c.jobId } } });
        await db.candidate.update({
          where: { id: c.id },
          data: {
            jobId: job.id,
            routedBy: "manual",
            routingConfidence: null,
            // Nobody has assessed them for this role yet.
            status: "inbox",
            screeningQueuedAt: opts.screeningMode === "auto" ? now : null,
          },
        });
        await audit(c.id, "candidate.moved", { jobId: c.jobId, jobTitle: c.job.title }, { jobId: job.id, jobTitle: job.title, screening: opts.screeningMode === "auto" ? "queued" : "awaiting" });
        moved += 1;
      }
      return { changed: moved, queued: opts.screeningMode === "auto" ? moved : 0 };
    }
  }
}
