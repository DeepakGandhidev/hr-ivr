import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { sendInvite } from "@/lib/workspace-edit-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional() });

/** Give a member who has not joined a login and a set-password email. */
export async function POST(request: NextRequest, { params }: { params: { id: string; userId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.members");
    const body = await parseBody(request, schema);
    return sendInvite(admin, params.id, params.userId, requireReason(body.reason, "sending an invite"));
  });
}
