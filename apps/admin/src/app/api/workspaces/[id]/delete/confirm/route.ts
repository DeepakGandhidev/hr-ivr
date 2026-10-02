import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { confirmDeletion } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional(), typedName: z.string() });

/**
 * The second admin's approval. Owners and Engineers may approve (not Support),
 * and never the admin who asked; confirmDeletion enforces both.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("view");
    const body = await parseBody(request, schema);
    return confirmDeletion(admin, params.id, body.typedName, requireReason(body.reason, "approving a deletion"));
  });
}
