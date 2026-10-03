import { NextRequest } from "next/server";
import { z } from "zod";
import { Action, ValidationError, writeAuditLog } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export const runtime = "nodejs";

const schema = z.object({ mode: z.enum(["auto", "manual"]) });

/**
 * Auto or Manual screening, for the whole workspace. Switching records when,
 * so Auto only ever screens arrivals after the switch: the manual queue is
 * never screened retroactively without someone asking.
 */
export async function POST(request: NextRequest, { params }: { params: { tenant: string } }) {
  const { tenant } = params;
  return handleApi(async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Choose auto or manual.");
    return withTenantAuth(tenant, Action.settingsUpdate, async (ctx, tx) => {
      if (ctx.tenant.screeningMode === parsed.data.mode) return { mode: parsed.data.mode };
      await tx.tenant.update({
        where: { id: ctx.tenant.id },
        data: { screeningMode: parsed.data.mode, screeningModeChangedAt: new Date() },
      });
      await writeAuditLog(tx, {
        tenantId: ctx.tenant.id,
        actor: ctx.user.id,
        action: "pipeline.screening_mode_changed",
        entity: "tenant",
        entityId: ctx.tenant.id,
        before: { mode: ctx.tenant.screeningMode },
        after: { mode: parsed.data.mode },
      });
      return { mode: parsed.data.mode };
    });
  });
}
