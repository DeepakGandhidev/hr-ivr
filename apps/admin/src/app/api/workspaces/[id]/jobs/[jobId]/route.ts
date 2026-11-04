import { type NextRequest } from "next/server";
import { z } from "zod";
import { createJobSchema } from "@pratibha/shared";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { updateJob } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

const schema = z.object({
  title: createJobSchema.shape.title.optional(),
  status: z.enum(["draft", "open", "paused", "closed"]).optional(),
  // A match score out of 100; null falls back to the platform default.
  screeningThreshold: z.number().int().min(0, "The threshold is a score from 0 to 100.").max(100, "The threshold is a score from 0 to 100.").nullable().optional(),
  reason: z.string().optional(),
});

export async function POST(request: NextRequest, { params }: { params: { id: string; jobId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const { reason, ...input } = await parseBody(request, schema);
    return updateJob(admin, params.id, params.jobId, input, requireReason(reason, "editing a job"));
  });
}
