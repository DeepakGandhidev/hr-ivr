import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { resetJobInterview } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

const schema = z.object({ jobId: z.string().min(1, "Choose a job."), reason: z.string().optional() });

/** A job stops overriding and goes back to the workspace's interview settings. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const body = await parseBody(request, schema);
    return resetJobInterview(admin, params.id, body.jobId, requireReason(body.reason, "removing a job's interview settings"));
  });
}
