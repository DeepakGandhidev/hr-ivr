import { type NextRequest } from "next/server";
import { z } from "zod";
import { emailConnectionUpdateSchema } from "@pratibha/shared";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { updateMailbox } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

// The portal's update schema, narrowed to what the panel may touch: never a
// credential, a server or a folder, which would need the mailbox password.
const schema = emailConnectionUpdateSchema
  .pick({ status: true, defaultJobId: true, autoRoute: true })
  .extend({ reason: z.string().optional() });

/** Pause or resume a mailbox ('revoked' is paused), or change where its mail is filed. */
export async function POST(request: NextRequest, { params }: { params: { id: string; connectionId: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const { reason, ...input } = await parseBody(request, schema);
    return updateMailbox(admin, params.id, params.connectionId, input, requireReason(reason, "changing a mailbox"));
  });
}
