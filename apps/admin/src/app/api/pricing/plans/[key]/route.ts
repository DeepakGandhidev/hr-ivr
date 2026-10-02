import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { savePlanDraft } from "@/lib/pricing-admin";

export const runtime = "nodejs";

const schema = z.object({
  priceInr: z.number().int(),
  slashedPriceInr: z.number().int().nullable(),
  minutes: z.number().int(),
  screenings: z.number().int(),
  jobLimit: z.number().int().nullable(),
  visibility: z.enum(["public", "hidden"]),
});

/** Save a plan edit as a draft. Nothing anyone sees changes until publish. */
export async function POST(request: NextRequest, { params }: { params: { key: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("pricing.edit");
    return savePlanDraft(admin, params.key, await parseBody(request, schema));
  });
}
