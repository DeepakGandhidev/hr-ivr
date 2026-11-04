import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { transferOwnership } from "@/lib/workspace-edit-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional() });

/** Make this member the owner; whoever owned it steps down to Admin. */
export async function POST(request: NextRequest, { params }: { params: { id: string; userId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.members");
    const body = await parseBody(request, schema);
    return transferOwnership(admin, params.id, params.userId, requireReason(body.reason, "transferring ownership"));
  });
}
