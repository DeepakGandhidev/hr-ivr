import { type NextRequest } from "next/server";
import { z } from "zod";
import { tenantSettingsSchema } from "@pratibha/shared";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { updateDetails } from "@/lib/workspace-edit-actions";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";

export const runtime = "nodejs";

// The portal's own rule for the name; the address rule lives in workspace-edit.
const schema = z.object({
  name: tenantSettingsSchema.shape.name.optional(),
  slug: z.string().max(60).optional(),
  reason: z.string().optional(),
});

/** Rename a workspace, or move it to another address (every link to the old one stops working). */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin(EDIT_PERMISSION);
    const body = await parseBody(request, schema);
    return updateDetails(admin, params.id, { name: body.name, slug: body.slug }, requireReason(body.reason, "renaming a workspace"));
  });
}
