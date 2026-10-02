import { type NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { publishPricing } from "@/lib/pricing-admin";

export const runtime = "nodejs";

/**
 * Publish every draft at once. Owner only: an Engineer or Support token gets a
 * 403 here, whatever the page showed, and the refusal is logged.
 */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("pricing.publish");
    return publishPricing(admin);
  });
}
