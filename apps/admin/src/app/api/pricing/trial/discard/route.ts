import { type NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { discardTrialDraft } from "@/lib/pricing-admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("pricing.edit");
    return discardTrialDraft(admin);
  });
}
