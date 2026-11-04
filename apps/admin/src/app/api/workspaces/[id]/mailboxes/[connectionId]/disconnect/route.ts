import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { disconnectMailbox } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

const schema = z.object({ reason: z.string().optional() });

/** Disconnect a mailbox for good. Candidates already filed from it stay. */
export async function POST(request: NextRequest, { params }: { params: { id: string; connectionId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const body = await parseBody(request, schema);
    return disconnectMailbox(admin, params.id, params.connectionId, requireReason(body.reason, "disconnecting a mailbox"));
  });
}
