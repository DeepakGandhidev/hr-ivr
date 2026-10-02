import { type NextRequest } from "next/server";
import { z } from "zod";
import { handle, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { recordManualPayment } from "@/lib/payments-admin";
import { PAYMENT_METHODS } from "@/lib/ledger";

export const runtime = "nodejs";

const schema = z.object({
  workspaceId: z.string().min(1, "Choose a workspace."),
  kind: z.enum(["subscription", "top_up"]),
  status: z.enum(["captured", "failed"]),
  amountInr: z.number().nullable().optional(),
  method: z.enum(PAYMENT_METHODS).refine((m) => m !== "none", "Choose how they paid."),
  reference: z.string().trim().max(120).nullable().optional(),
  couponCode: z.string().trim().max(32).nullable().optional(),
  packId: z.string().nullable().optional(),
  description: z.string().trim().max(160).nullable().optional(),
  paidOn: z.string().nullable().optional(),
  retryOn: z.string().nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

/** Record payment: the manual era's way in to the ledger. */
export async function POST(request: NextRequest) {
  return handle(request, async () => {
    const { admin } = await requireAdmin("payments.record");
    return recordManualPayment(admin, await parseBody(request, schema));
  });
}
