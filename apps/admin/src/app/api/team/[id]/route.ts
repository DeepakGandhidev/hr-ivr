import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { changeRole, deactivate, reactivate, resendInvite, resetTwoStep } from "@/lib/team";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("role"), role: z.enum(["owner", "engineer", "support"]), reason: z.string().optional() }),
  z.object({ action: z.literal("deactivate"), reason: z.string().optional() }),
  z.object({ action: z.literal("reactivate"), reason: z.string().optional() }),
  z.object({ action: z.literal("reset_two_step"), reason: z.string().optional() }),
  z.object({ action: z.literal("resend_invite") }),
]);

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("team.manage");
    const body = await parseBody(request, schema);
    switch (body.action) {
      case "role":
        return changeRole(admin, params.id, body.role, requireReason(body.reason, "a role change"));
      case "deactivate":
        return deactivate(admin, params.id, requireReason(body.reason, "deactivating an admin"));
      case "reactivate":
        return reactivate(admin, params.id, requireReason(body.reason, "reactivating an admin"));
      case "reset_two_step":
        return resetTwoStep(admin, params.id, requireReason(body.reason, "resetting two step verification"));
      case "resend_invite":
        return resendInvite(admin, params.id);
    }
  });
}
