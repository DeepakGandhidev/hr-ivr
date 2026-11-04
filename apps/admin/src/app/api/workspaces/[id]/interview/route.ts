import { type NextRequest } from "next/server";
import { handle, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { parseProtocol, saveInterview } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

/**
 * Interview settings for the workspace, or for one job when `jobId` is sent.
 * The body is the portal's own (interviewProtocolSchema) plus a reason.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = requireReason(typeof raw?.reason === "string" ? raw.reason : undefined, "changing interview settings");
    const data = await parseProtocol(raw);
    return saveInterview(admin, params.id, data, reason);
  });
}
