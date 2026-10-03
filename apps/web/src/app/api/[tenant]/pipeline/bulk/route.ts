import { NextRequest } from "next/server";
import { z } from "zod";
import { Action, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { applyBulk } from "@/lib/pipeline";
import { runScreeningQueue } from "@/lib/screening-runner";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["archive", "restore", "not_application", "is_application", "screen", "assign"]),
  ids: z.array(z.string().min(1)).min(1).max(200),
  jobId: z.string().optional(),
});

/**
 * Bulk (and single) Pipeline actions. Every id in the batch is checked against
 * the workspace before anything changes; one stranger and nothing happens.
 * Archive and Mark not an application also revoke pending invitations.
 */
export async function POST(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Invalid request", parsed.error.flatten());
    const { action, ids, jobId } = parsed.data;
    const permission = action === "screen" ? Action.candidateScreen : Action.candidateUpdate;

    const result = await withTenantAuth(tenant, permission, (ctx, tx) =>
      applyBulk(tx, ctx, action, ids, { jobId, screeningMode: ctx.tenant.screeningMode })
    );

    // Queued screenings start now rather than at the next tick.
    if ((result as { queued?: number }).queued) void runScreeningQueue();
    return result;
  });
}
