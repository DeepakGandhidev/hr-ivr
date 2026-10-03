import { NextRequest } from "next/server";
import { Action } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { screenCandidate } from "@/lib/screen-candidate";

/**
 * §5 Stage 5 — screen one candidate now. The work is in screenCandidate, shared
 * with bulk Screen now and the Auto mode runner.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateScreen);
    return screenCandidate({ tenant: ctx.tenant, candidateId: id, actorId: ctx.user.id, tx });
  });
}
