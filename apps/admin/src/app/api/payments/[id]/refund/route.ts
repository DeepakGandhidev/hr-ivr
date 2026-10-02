import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireReason } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { refundPayment, REFUND_GROUNDS } from "@/lib/payments-admin";

export const runtime = "nodejs";

const schema = z.object({
  ground: z.enum(REFUND_GROUNDS.map((g) => g.key) as [string, ...string[]]),
  reason: z.string().optional(),
});

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("payments.refund");
    const body = await parseBody(request, schema);
    return refundPayment(admin, params.id, body.ground as (typeof REFUND_GROUNDS)[number]["key"], requireReason(body.reason, "a refund"));
  });
}
