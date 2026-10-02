import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { createWorkspace } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(2, "Name the workspace.").max(120),
  slug: z.string().trim().min(3, "Choose an address."),
  ownerName: z.string().trim().min(1, "Name the owner.").max(120),
  ownerEmail: z.string().trim().email("Enter the owner's email address."),
  planKey: z.string().min(1),
  reason: z.string().optional(),
});

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.create");
    const body = await parseBody(request, schema);
    return createWorkspace(admin, { ...body, reason: requireReason(body.reason, "creating a workspace") });
  });
}
