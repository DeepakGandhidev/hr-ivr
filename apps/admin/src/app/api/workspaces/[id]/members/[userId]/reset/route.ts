import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { sendMemberReset } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional() });

export async function POST(request: NextRequest, { params }: { params: { id: string; userId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.members");
    const body = await parseBody(request, schema);
    return sendMemberReset(admin, params.id, params.userId, requireReason(body.reason, "sending a reset link"));
  });
}
