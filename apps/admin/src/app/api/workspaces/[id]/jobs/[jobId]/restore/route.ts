import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { restoreJob } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional() });

export async function POST(request: NextRequest, { params }: { params: { id: string; jobId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const body = await parseBody(request, schema);
    return restoreJob(admin, params.id, params.jobId, requireReason(body.reason, "restoring a job"));
  });
}
