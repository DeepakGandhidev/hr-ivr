import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { addPack, grantGoodwill } from "@/lib/workspace-actions";
import { PAYMENT_METHODS } from "@/lib/ledger";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("goodwill"), minutes: z.number().int(), reason: z.string().optional() }),
  z.object({
    mode: z.literal("pack"),
    packId: z.string().min(1, "Choose a pack."),
    method: z.enum(PAYMENT_METHODS).refine((m) => m !== "none", "Choose how they paid."),
    reference: z.string().trim().max(120).optional(),
    reason: z.string().optional(),
  }),
]);

/** Add minutes: a goodwill grant (Support may, up to the cap) or a paid pack (Owner, Engineer). */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const body = await parseBody(request, schema);
    if (body.mode === "goodwill") {
      const { admin } = await requireAdmin("workspace.grant_goodwill");
      return grantGoodwill(admin, params.id, body.minutes, requireReason(body.reason, "a goodwill grant"));
    }
    const { admin } = await requireAdmin("workspace.add_pack");
    return addPack(admin, params.id, { ...body, reason: requireReason(body.reason, "a top up pack") });
  });
}
