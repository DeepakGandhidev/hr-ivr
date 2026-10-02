import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { requestDeletion } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional(), typedName: z.string() });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.delete");
    const body = await parseBody(request, schema);
    return requestDeletion(admin, params.id, body.typedName, requireReason(body.reason, "deleting a workspace"));
  });
}
