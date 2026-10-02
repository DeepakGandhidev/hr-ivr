import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { saveTrialDraft } from "@/lib/pricing-admin";

export const runtime = "nodejs";

const schema = z.object({ minutes: z.number().int(), days: z.number().int() });

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("pricing.edit");
    return saveTrialDraft(admin, await parseBody(request, schema));
  });
}
