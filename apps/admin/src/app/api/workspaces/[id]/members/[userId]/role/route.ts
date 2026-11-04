import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { changeMemberRole } from "@/lib/workspace-edit-actions";

export const runtime = "nodejs";

const schema = z.object({
  role: z.enum(["owner", "admin", "reviewer", "viewer"], { message: "Choose a role." }),
  reason: z.string().optional(),
});

/** Change a member's role. Ownership moves only by transfer; changeMemberRole refuses it here. */
export async function POST(request: NextRequest, { params }: { params: { id: string; userId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.members");
    const body = await parseBody(request, schema);
    return changeMemberRole(admin, params.id, params.userId, body.role, requireReason(body.reason, "changing a member's role"));
  });
}
