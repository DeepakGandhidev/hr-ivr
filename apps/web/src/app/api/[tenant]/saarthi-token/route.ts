import { NextResponse } from "next/server";
import { NotFoundError } from "@pratibha/shared";
import { loadTenantContext } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { saarthiConfig, saarthiToken } from "@/lib/saarthi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A single-use Saarthi token for the signed-in member, so the chat greets
 * them by name and answers about their own workspace.
 *
 * The member always comes from the session (the browser cookie, which the
 * mobile app also sends), never from the request: the token proves to Saarthi
 * who is asking. An unpaid workspace still gets one, because "how do I pay?"
 * is exactly what it may want to ask.
 */
export async function GET(_request: Request, { params }: { params: { tenant: string } }) {
  return handleApi(async () => {
    const config = saarthiConfig();
    if (!config.portalOn || !config.canSign) throw new NotFoundError("Saarthi sign-in is not set up");

    const { user, tenant } = await loadTenantContext(params.tenant, { allowUnpaid: true });
    const token = saarthiToken({
      id: user.id,
      name: user.name,
      email: user.email,
      plan: tenant.plan?.key,
      attrs: {
        workspace: tenant.name,
        role: user.role,
        plan_name: tenant.plan?.name,
        workspace_status: tenant.status,
        trial_ends: tenant.status === "trial" && tenant.trialEndsAt ? tenant.trialEndsAt.toISOString().slice(0, 10) : undefined,
      },
    });

    return NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
  });
}
