import { NextRequest } from "next/server";
import { Action, tenantSettingsSchema, ValidationError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

export const runtime = "nodejs";

/**
 * Workspace-level settings.
 *
 * The company name is not decoration: it is what the agent says out loud when
 * it introduces itself, so a wrong one here is a wrong one on every call.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.settingsRead, async (ctx, tx) => {
      const row = await tx.tenant.findUnique({
        where: { id: ctx.tenant.id },
        select: { id: true, name: true, slug: true, planId: true, status: true, trialEndsAt: true },
      });
      return { tenant: row };
    })
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string } }
) {
  const { tenant } = params;
  return handleApi(async () => {
    const body = await request.json();
    const parsed = tenantSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid workspace settings", parsed.error.flatten());
    }

    return withTenantAuth(tenant, Action.settingsUpdate, async (ctx, tx) => {
      // The slug is deliberately not editable here: it is in every URL and in
      // the forwarding address people have already been given, so renaming it
      // silently breaks links that are out in the world.
      const updated = await tx.tenant.update({
        where: { id: ctx.tenant.id },
        data: { name: parsed.data.name.trim() },
        select: { id: true, name: true, slug: true },
      });

      return { tenant: updated };
    });
  });
}
