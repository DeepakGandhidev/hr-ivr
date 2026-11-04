import { NextRequest } from "next/server";
import {
  Action,
  AppError,
  can,
  GUARDRAIL_ERROR,
  interviewDefaults,
  interviewProtocolSchema,
  maxCustomQuestions,
  QuotaExceededError,
  UserRole,
  ValidationError,
  writeAuditLog,
} from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { planConstants, platformSettings } from "@/lib/platform-settings";
import { planAllows, planLimit } from "@/lib/plan-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Interview style tuning (D1): screeners, salary policy, custom questions,
 * difficulty, focus areas and instructions. Gated by the plan's
 * interview_tuning feature, else the gate.interview_tuning platform setting.
 * Custom questions also need the plan's custom_questions feature, and their
 * number is capped by custom_questions_per_job as well as the platform maximum.
 * Length and question counts are on every plan.
 */
const TUNING_FIELDS = [
  "screenNotice", "screenSalary", "screenReasonLeaving", "screenGaps", "screenLocation",
  "screenWorkMode", "screenTravel", "screenReference", "shareBand", "mismatchAction",
  "customQuestions", "difficulty", "focusAreas", "instructionText",
] as const;

export async function GET(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.protocolRead, async (ctx, tx) => {
      const [protocols, jobs, settings] = await Promise.all([
        tx.interviewProtocol.findMany({
          where: { tenantId: ctx.tenant.id },
          orderBy: [{ jobId: "asc" }, { version: "desc" }],
        }),
        tx.job.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: "desc" },
          select: { id: true, title: true, status: true, salaryMin: true, salaryMax: true },
        }),
        platformSettings(),
      ]);
      const overriding = new Set(protocols.filter((p) => p.jobId).map((p) => p.jobId));
      return {
        protocols,
        jobs: jobs.map((j) => ({ ...j, overrides: overriding.has(j.id) })),
        constants: planConstants(settings),
        tuningAllowed: planAllows(ctx.tenant, "interview_tuning"),
        customQuestionsAllowed: planAllows(ctx.tenant, "custom_questions"),
        canEdit: can(ctx.user.role as unknown as UserRole, Action.protocolUpdate),
        tenantName: ctx.tenant.name,
        // Admin panel defaults, for a workspace that has never saved.
        defaults: interviewDefaults(),
        maxCustomQuestions: effectiveMaxCustomQuestions(planLimit(ctx.tenant, "custom_questions_per_job")),
      };
    })
  );
}

export async function PUT(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json().catch(() => null);
    const parsed = interviewProtocolSchema.safeParse(body);
    if (!parsed.success) {
      // I14: the guardrail refusal carries its own exact copy, whichever
      // client sent the request.
      const guardrail = parsed.error.issues.find((i) => i.message === GUARDRAIL_ERROR);
      if (guardrail) throw new ValidationError(GUARDRAIL_ERROR, { field: guardrail.path.join(".") });
      const first = parsed.error.issues[0];
      throw new ValidationError(first?.message ?? "Invalid interview settings", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.protocolUpdate, async (ctx, tx) => {
      const data = parsed.data;
      const jobId = data.jobId ?? null;

      if (jobId) {
        const job = await tx.job.findFirst({ where: { id: jobId, deletedAt: null } });
        if (!job) throw new ValidationError("Job not found", { jobId });
      }

      const existing = jobId
        ? await tx.interviewProtocol.findUnique({ where: { tenantId_jobId: { tenantId: ctx.tenant.id, jobId } } })
        : await tx.interviewProtocol.findFirst({ where: { tenantId: ctx.tenant.id, jobId: null } });

      // D1: on a plan without tuning, those fields keep whatever they were.
      if (!planAllows(ctx.tenant, "interview_tuning")) {
        const base = (existing ?? {}) as Record<string, unknown>;
        const changed = TUNING_FIELDS.filter(
          (f) => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(base[f] ?? undefined)
        );
        if (changed.length && existing) {
          throw new AppError("FORBIDDEN", "Interview style tuning is not on your plan. Length and question counts can still be changed.", 403);
        }
      }

      // Custom questions on their own plan switch and per-job limit. A save
      // that leaves them as they were is never refused, so a plan change
      // cannot lock a workspace out of editing everything else.
      if (data.customQuestions !== undefined) {
        const before = Array.isArray(existing?.customQuestions) ? (existing!.customQuestions as unknown[]) : [];
        const changed = JSON.stringify(data.customQuestions) !== JSON.stringify(before);
        if (changed && !planAllows(ctx.tenant, "custom_questions")) {
          throw new AppError("FORBIDDEN", "Custom interview questions are not included in your plan.", 403);
        }
        const limit = planLimit(ctx.tenant, "custom_questions_per_job");
        const count = Array.isArray(data.customQuestions) ? data.customQuestions.length : 0;
        if (limit !== null && count > limit && count > before.length) {
          throw new QuotaExceededError(
            `Your plan allows ${limit} custom ${limit === 1 ? "question" : "questions"} per interview. Upgrade your plan to add more.`
          );
        }
      }

      const fields = {
        instructionText: data.instructionText,
        ...(data.durationMinutes !== undefined && { durationMinutes: data.durationMinutes }),
        ...(data.difficulty !== undefined && { difficulty: data.difficulty }),
        ...(data.minQuestions !== undefined && { minQuestions: data.minQuestions }),
        ...(data.maxQuestions !== undefined && { maxQuestions: data.maxQuestions }),
        ...(data.focusAreas !== undefined && { focusAreas: data.focusAreas }),
        ...(data.agentName !== undefined && { agentName: data.agentName }),
        ...(data.companyName !== undefined && { companyName: data.companyName }),
        ...(data.screenNotice !== undefined && { screenNotice: data.screenNotice }),
        ...(data.screenSalary !== undefined && { screenSalary: data.screenSalary }),
        ...(data.screenReasonLeaving !== undefined && { screenReasonLeaving: data.screenReasonLeaving }),
        ...(data.screenGaps !== undefined && { screenGaps: data.screenGaps }),
        ...(data.screenLocation !== undefined && { screenLocation: data.screenLocation }),
        ...(data.screenWorkMode !== undefined && { screenWorkMode: data.screenWorkMode }),
        ...(data.screenTravel !== undefined && { screenTravel: data.screenTravel }),
        ...(data.screenReference !== undefined && { screenReference: data.screenReference }),
        ...(data.shareBand !== undefined && { shareBand: data.shareBand }),
        ...(data.mismatchAction !== undefined && { mismatchAction: data.mismatchAction }),
        ...(data.introduceRole !== undefined && { introduceRole: data.introduceRole }),
        ...(data.candidateQuestions !== undefined && { candidateQuestions: data.candidateQuestions }),
        ...(data.hearBackDays !== undefined && { hearBackDays: data.hearBackDays }),
        ...(data.customQuestions !== undefined && { customQuestions: data.customQuestions }),
      };

      const protocol = existing
        ? await tx.interviewProtocol.update({
            where: { id: existing.id },
            data: { ...fields, version: existing.version + 1, updatedBy: ctx.user.id },
          })
        : await tx.interviewProtocol.create({
            // A first save starts from the admin panel's defaults for anything
            // the request leaves out, not the migration's column defaults.
            data: { tenantId: ctx.tenant.id, jobId, ...interviewDefaults(), ...fields, version: 1, updatedBy: ctx.user.id },
          });

      await writeAuditLog(tx, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "interview_settings.saved",
        entity: jobId ? "job" : "tenant",
        entityId: jobId ?? ctx.tenant.id,
        before: existing ? { version: existing.version } : {},
        after: { version: protocol.version },
      });

      return { protocol };
    });
  });
}

/** A job stops overriding and goes back to the workspace default. */
export async function DELETE(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.protocolUpdate, async (ctx, tx) => {
      const jobId = request.nextUrl.searchParams.get("jobId");
      if (!jobId) throw new ValidationError("Choose a job.");
      const { count } = await tx.interviewProtocol.deleteMany({ where: { tenantId: ctx.tenant.id, jobId } });
      if (count) {
        await writeAuditLog(tx, {
          tenantId: ctx.tenant.id,
          actor: ctx.user.id,
          action: "interview_settings.override_removed",
          entity: "job",
          entityId: jobId,
        });
      }
      return { removed: count };
    })
  );
}

/** The platform maximum, lowered to the plan's per-job limit when it has one. */
function effectiveMaxCustomQuestions(planMax: number | null): number {
  const platformMax = maxCustomQuestions();
  return planMax === null ? platformMax : Math.min(platformMax, planMax);
}
