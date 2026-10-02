import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { savePackDraft } from "@/lib/pricing-admin";

export const runtime = "nodejs";

const schema = z.object({
  kind: z.enum(["minutes", "screenings"]),
  quantity: z.number().int(),
  priceInr: z.number().int(),
  validityDays: z.number().int(),
  replacesId: z.string().nullable().optional(),
});

/** A new pack, or a change to a live one, as a draft. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("pricing.edit");
    return savePackDraft(admin, await parseBody(request, schema));
  });
}
