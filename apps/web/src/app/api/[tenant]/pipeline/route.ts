import { NextRequest } from "next/server";
import { Action, can, UserRole } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { pipelinePage, VIEWS, type PipelineView } from "@/lib/pipeline";
import { platformSettings } from "@/lib/platform-settings";
import { currentUsagePeriod, plusTopUp, screeningLimit, topUps } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One page of the Pipeline, with the chip counts, the jobs for the filter and
 * the picker, the screening mode and the month's screening usage. Never the
 * full set: the page size is a platform setting.
 */
export async function GET(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (ctx, tx) => {
      const sp = request.nextUrl.searchParams;
      const view = (VIEWS.includes(sp.get("view") as PipelineView) ? sp.get("view") : "all") as PipelineView;
      const settings = await platformSettings();
      const pageSize = Math.max(5, Math.min(200, settings.pageSize || 25));

      const [data, jobs, meter, extra] = await Promise.all([
        pipelinePage(tx, ctx.tenant.id, {
          view,
          jobId: sp.get("jobId") || undefined,
          q: sp.get("q") || undefined,
          page: Number(sp.get("page")) || 1,
          pageSize,
        }),
        tx.job.findMany({
          where: { deletedAt: null, status: { in: ["open", "paused", "draft"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, title: true, status: true },
        }),
        tx.usageMeter.findUnique({ where: { tenantId_period: { tenantId: ctx.tenant.id, period: currentUsagePeriod() } } }),
        topUps(tx, ctx.tenant.id),
      ]);

      const role = ctx.user.role as unknown as UserRole;
      return {
        ...data,
        // The fallback bucket is where unrouted mail lands; it is not a real
        // destination to offer in the picker.
        jobs,
        mode: ctx.tenant.screeningMode,
        usage: {
          used: (meter?.screeningsUsed ?? 0) + (meter?.overageScreenings ?? 0),
          allowance: plusTopUp(screeningLimit(ctx.tenant), extra.screenings),
        },
        junk: { enabled: settings.junkHint, rule: settings.junkRule },
        permissions: {
          canEdit: can(role, Action.candidateUpdate),
          canScreen: can(role, Action.candidateScreen),
          canChangeMode: can(role, Action.settingsUpdate),
        },
      };
    })
  );
}
