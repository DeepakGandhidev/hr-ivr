import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { restore } from "@/lib/workspace-actions";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional() });

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("workspace.delete");
    const body = await parseBody(request, schema);
    return restore(admin, params.id, requireReason(body.reason, "restoring a workspace"));
  });
}
