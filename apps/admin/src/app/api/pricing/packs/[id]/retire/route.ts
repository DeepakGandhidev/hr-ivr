import { type NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { retirePackDraft } from "@/lib/pricing-admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("pricing.edit");
    return retirePackDraft(admin, params.id);
  });
}
